require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fonepay = require('./fonepay-sdk');
const fonepayWs = require('./fonepay-websocket');
const shopify = require('./lib/shopify');
const security = require('./lib/security');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const TERMINAL_ID = process.env.FONEPAY_TERMINAL_ID;
const CHECKOUT_SECRET = process.env.CHECKOUT_HMAC_SECRET;
const WEBHOOK_SECRET = process.env.FONEPAY_WEBHOOK_SECRET;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const ALLOWED_REDIRECT_HOSTS = (process.env.ALLOWED_REDIRECT_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const DEFAULT_SHOPIFY_HOST = process.env.SHOPIFY_STORE_DOMAIN
  ? process.env.SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '').split('/')[0].toLowerCase()
  : null;

if (DEFAULT_SHOPIFY_HOST && !ALLOWED_REDIRECT_HOSTS.includes(DEFAULT_SHOPIFY_HOST)) {
  ALLOWED_REDIRECT_HOSTS.push(DEFAULT_SHOPIFY_HOST);
}

if (IS_PROD && !CHECKOUT_SECRET) {
  console.error('FATAL: CHECKOUT_HMAC_SECRET is required when NODE_ENV=production');
  process.exit(1);
}

if (process.env.TRUST_PROXY !== 'false') {
  app.set('trust proxy', 1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));

const corsOrigin = DEFAULT_SHOPIFY_HOST
  ? [`https://${DEFAULT_SHOPIFY_HOST}`, `https://${DEFAULT_SHOPIFY_HOST.replace('.myshopify.com', '')}`]
  : false;

app.use(cors({
  origin: corsOrigin || false,
  methods: ['GET', 'POST'],
}));

app.use('/webhook/fonepay', express.raw({ type: 'application/json', limit: '32kb' }));

app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: true, limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PROD ? 40 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many checkout attempts. Try again later.' },
});

const pendingTransactions = new Map();
const orderTransactions = new Map();
const websocketTransactions = new Map();
const QR_SESSION_TTL_MS = 5 * 60 * 1000;

function resolveRedirectUrl(tx) {
  if (tx.redirectUrl && security.isAllowedRedirectUrl(tx.redirectUrl, ALLOWED_REDIRECT_HOSTS)) {
    return tx.redirectUrl;
  }
  if (DEFAULT_SHOPIFY_HOST && tx.shopifyOrderId) {
    return shopify.defaultOrderStatusUrl(tx.shopifyOrderId);
  }
  return DEFAULT_SHOPIFY_HOST ? `https://${DEFAULT_SHOPIFY_HOST}` : '/';
}

async function fulfillShopifyOrder(tx) {
  if (!tx.shopifyOrderId || tx.shopifyFulfilled) return;
  if (!shopify.isConfigured()) {
    console.warn('Shopify API not configured — order not auto-marked paid:', tx.shopifyOrderId);
    return;
  }
  try {
    await shopify.markOrderAsPaid(tx.shopifyOrderId);
    tx.shopifyFulfilled = true;
    console.log('Shopify order marked paid:', tx.shopifyOrderId);
  } catch (err) {
    console.error('Shopify mark paid failed:', tx.shopifyOrderId, err.message);
  }
}

function markTransactionPaid(tx, source) {
  if (!tx || tx.status === 'paid') return;
  tx.status = 'paid';
  orderTransactions.delete(tx.safeOrderId);
  if (tx.websocketId) {
    fonepayWs.stopMonitoring(tx.referenceLabel);
    websocketTransactions.delete(tx.websocketId);
  }
  console.log(`Payment confirmed (${source}):`, tx.referenceLabel, 'order', tx.orderId);
  fulfillShopifyOrder(tx).catch(() => {});
}

async function confirmPaymentWithApi(tx) {
  try {
    const result = await fonepay.checkPaymentStatus(null, {
      terminalId: TERMINAL_ID,
      referenceLabel: tx.referenceLabel,
    });
    const paid =
      String(result.paymentStatus || result.status || '').toUpperCase() === 'SUCCESS' ||
      result.success === true;
    if (paid) {
      markTransactionPaid(tx, 'api');
    }
    return paid;
  } catch (err) {
    console.error('Status check failed:', tx.referenceLabel, err.message);
    return false;
  }
}

async function attachWebSocketMonitor(tx) {
  if (!tx.websocketId) return;

  fonepayWs.startMonitoring(tx.websocketId, {
    sessionKey: tx.referenceLabel,
    onQrVerified: (msg) => {
      if (!IS_PROD) {
        console.log('QR verified:', tx.referenceLabel, fonepayWs.parseTransactionStatus(msg));
      }
    },
    onPaymentSuccess: async () => {
      markTransactionPaid(tx, 'websocket');
      await confirmPaymentWithApi(tx);
    },
    onError: (err) => {
      console.error('WebSocket monitor error:', tx.referenceLabel, err.message);
    },
  });
}

function validateCheckoutRequest(req) {
  const { amount, order_id, timestamp, signature, redirect_url } = req.query;

  if (!amount || !order_id) {
    return { error: 'Missing required parameters: amount, order_id', status: 400 };
  }

  if (IS_PROD || CHECKOUT_SECRET) {
    const verified = security.verifyCheckoutSignature(
      { timestamp, orderId: order_id, amount, signature },
      CHECKOUT_SECRET
    );
    if (!verified.ok) {
      return { error: verified.error, status: 403 };
    }
  }

  const safeOrderId = security.sanitizeOrderId(order_id);
  if (!safeOrderId) {
    return { error: 'Invalid order_id', status: 400 };
  }

  let redirectUrl = null;
  if (redirect_url) {
    if (!security.isAllowedRedirectUrl(redirect_url, ALLOWED_REDIRECT_HOSTS)) {
      return { error: 'Invalid redirect_url', status: 400 };
    }
    redirectUrl = redirect_url;
  }

  const amountNum = security.parseAmount(amount);
  if (amountNum === null) {
    return { error: 'Invalid amount', status: 400 };
  }

  const shopifyOrderId = /^\d+$/.test(String(order_id).trim())
    ? String(order_id).trim()
    : null;

  return {
    amount: amountNum,
    orderId: order_id,
    safeOrderId,
    shopifyOrderId,
    redirectUrl,
  };
}

app.get('/checkout', checkoutLimiter, async (req, res) => {
  try {
    if (!TERMINAL_ID) {
      return res.status(500).send('Payment service is not configured.');
    }

    const validated = validateCheckoutRequest(req);
    if (validated.error) {
      return res.status(validated.status).send(validated.error);
    }

    const { amount, orderId, safeOrderId, shopifyOrderId, redirectUrl } = validated;

    const existingReferenceLabel = orderTransactions.get(safeOrderId);
    if (existingReferenceLabel) {
      const existingTx = pendingTransactions.get(existingReferenceLabel);
      const isActive = existingTx && existingTx.status === 'pending' && Date.now() < existingTx.expiresAt;

      if (isActive) {
        await attachWebSocketMonitor(existingTx);
        return res.render('payment', {
          orderId,
          amount: security.formatAmount(amount),
          qrImage: existingTx.qrImage,
          referenceLabel: existingReferenceLabel,
        });
      }

      orderTransactions.delete(safeOrderId);
      if (existingTx && existingTx.status !== 'paid') {
        pendingTransactions.delete(existingReferenceLabel);
        if (existingTx.websocketId) {
          websocketTransactions.delete(existingTx.websocketId);
        }
      }
    }

    const unique = Date.now().toString().slice(-6);
    const referenceLabel = `SHP${safeOrderId}${unique}`.replace(/[^a-zA-Z0-9]/g, '').substring(0, 30);

    const qrData = await fonepay.generateQR(null, {
      amount,
      billId: `ORD${safeOrderId}${unique}`.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20),
      referenceLabel,
      terminalId: TERMINAL_ID,
    });

    const qrPayload = qrData.qrString || qrData.qrMessage;
    if (!qrPayload) {
      throw new Error('QR payload missing in Fonepay response');
    }

    const qrImageBase64 = await QRCode.toDataURL(qrPayload, {
      errorCorrectionLevel: 'L',
      margin: 2,
      width: 280,
    });

    const defaultRedirect = shopifyOrderId && DEFAULT_SHOPIFY_HOST
      ? `https://${DEFAULT_SHOPIFY_HOST}/account/orders/${shopifyOrderId}`
      : null;

    pendingTransactions.set(referenceLabel, {
      orderId,
      safeOrderId,
      shopifyOrderId,
      referenceLabel,
      prn: qrData.prn || referenceLabel,
      websocketId: qrData.websocketId,
      amount,
      redirectUrl: redirectUrl || defaultRedirect,
      status: 'pending',
      qrImage: qrImageBase64,
      expiresAt: Date.now() + QR_SESSION_TTL_MS,
      shopifyFulfilled: false,
    });
    orderTransactions.set(safeOrderId, referenceLabel);
    if (qrData.websocketId) {
      websocketTransactions.set(qrData.websocketId, referenceLabel);
    }

    await attachWebSocketMonitor(pendingTransactions.get(referenceLabel));

    res.render('payment', {
      orderId,
      amount: security.formatAmount(amount),
      qrImage: qrImageBase64,
      referenceLabel,
    });
  } catch (error) {
    if (error.status === 409) {
      console.warn('Checkout: terminal busy', { orderId: req.query.order_id });
      return res.status(200).render('terminal-busy', {
        retryUrl: req.originalUrl || '/checkout',
        retryAfterSeconds: 30,
        orderId: req.query.order_id || 'N/A',
      });
    }
    console.error('Checkout Error:', error.message);
    res.status(500).send(IS_PROD ? 'Unable to start payment. Please try again.' : error.message);
  }
});

app.get('/api/status/:referenceLabel', rateLimit({
  windowMs: 60 * 1000,
  max: 120,
}), (req, res) => {
  const tx = pendingTransactions.get(req.params.referenceLabel);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });

  if (tx.status === 'pending' && Date.now() >= tx.expiresAt) {
    tx.status = 'expired';
    orderTransactions.delete(tx.safeOrderId);
    if (tx.websocketId) {
      websocketTransactions.delete(tx.websocketId);
    }
  }

  const body = { status: tx.status };
  if (tx.status === 'paid') {
    body.redirectUrl = resolveRedirectUrl(tx);
  }
  res.json(body);
});

app.post('/webhook/fonepay', async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const signature = req.headers['x-fonepay-signature'] || req.headers['x-signature'];

  if (WEBHOOK_SECRET && !security.verifyWebhookSignature(rawBody, signature, WEBHOOK_SECRET)) {
    console.warn('Fonepay webhook rejected: invalid signature');
    return res.status(401).send('Unauthorized');
  }

  let payload = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  if (!IS_PROD) {
    console.log('Fonepay webhook:', payload);
  }

  const { websocketId, status, referenceLabel } = payload;
  const txRef = referenceLabel || websocketTransactions.get(websocketId);
  const tx = txRef ? pendingTransactions.get(txRef) : null;

  if (tx && status === 'SUCCESS') {
    markTransactionPaid(tx, 'webhook');
    confirmPaymentWithApi(tx).catch(() => {});
  }

  res.send('OK');
});

app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fonepay — Nepal Tea Exchange</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1f2937">
  <h1>Fonepay Shopify integration</h1>
  <p>Server is running. Payment checkout uses <code>/checkout</code> with a signed URL.</p>
  <p><a href="/health">Health check</a></p>
</body></html>`);
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    version: '2.0.0-production',
    environment: IS_PROD ? 'production' : 'development',
    terminalConfigured: Boolean(TERMINAL_ID),
    terminalSuffix: TERMINAL_ID ? TERMINAL_ID.slice(-4) : null,
    checkoutSigning: Boolean(CHECKOUT_SECRET),
    shopifyConfigured: shopify.isConfigured(),
    activeWebSockets: fonepayWs.getActiveCount(),
  });
});

app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: IS_PROD ? 'Internal server error' : err.message });
});

app.listen(PORT, () => {
  const suffix = TERMINAL_ID ? TERMINAL_ID.slice(-4) : 'none';
  console.log(`Fonepay server listening on port ${PORT} (${IS_PROD ? 'production' : 'development'})`);
  console.log(`Terminal: ${TERMINAL_ID ? 'configured …' + suffix : 'MISSING'}`);
  console.log(`Checkout HMAC: ${CHECKOUT_SECRET ? 'enabled' : IS_PROD ? 'MISSING' : 'optional (dev)'}`);
  console.log(`Shopify mark-paid: ${shopify.isConfigured() ? 'enabled' : 'not configured'}`);
  if (PUBLIC_BASE_URL) {
    console.log(`Public URL: ${PUBLIC_BASE_URL}`);
  }
});
