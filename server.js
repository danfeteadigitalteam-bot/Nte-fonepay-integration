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
const ALLOW_PAY_AMOUNT_FROM_QUERY = process.env.ALLOW_PAY_AMOUNT_FROM_QUERY === 'true';

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
  // Shopify embeds the app in admin iframe; frameguard SAMEORIGIN would block that
  frameguard: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: [
        "'self'",
        'https://admin.shopify.com',
        'https://*.myshopify.com',
      ],
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

const payLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: IS_PROD ? 60 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment link attempts. Try again later.' },
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFonepayStatusSuccess(result) {
  return (
    String(result?.paymentStatus || result?.status || '').toUpperCase() === 'SUCCESS' ||
    result?.success === true
  );
}

function markTransactionPaid(tx, source) {
  if (!tx || tx.status === 'paid') return;
  tx.status = 'paid';
  tx.fonepayVerified = true;
  tx.fonepayVerifiedAt = new Date().toISOString();
  orderTransactions.delete(tx.safeOrderId);
  if (tx.websocketId) {
    fonepayWs.stopMonitoring(tx.referenceLabel);
    websocketTransactions.delete(tx.websocketId);
  }
  console.log(
    `[PAID] Fonepay verified (${source}) | PRN/ref: ${tx.referenceLabel} | Shopify order: ${tx.orderId} | amount NPR ${tx.amount}` +
    (shopify.isConfigured() ? '' : ' | → Mark this order PAID manually in Shopify Admin')
  );
  fulfillShopifyOrder(tx).catch(() => {});
}

/**
 * Confirm payment via Fonepay thirdPartyDynamicQrGetStatus only.
 * WebSocket/webhook are hints — status is marked paid only after API SUCCESS.
 */
async function confirmPaymentWithApi(tx, { retries = 5, delayMs = 2000 } = {}) {
  if (!tx || tx.status === 'paid') return true;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const result = await fonepay.checkPaymentStatus(null, {
        terminalId: TERMINAL_ID,
        referenceLabel: tx.referenceLabel,
      });
      if (isFonepayStatusSuccess(result)) {
        markTransactionPaid(tx, 'fonepay-api');
        return true;
      }
      if (attempt < retries) {
        await sleep(delayMs);
      }
    } catch (err) {
      console.error(`Status check failed (attempt ${attempt}/${retries}):`, tx.referenceLabel, err.message);
      if (attempt < retries) await sleep(delayMs);
    }
  }
  return false;
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
      console.log('WebSocket payment signal — verifying with Fonepay status API:', tx.referenceLabel);
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

function validatePayRequest(req) {
  const { amount } = req.query;
  const redirectRaw = req.query.redirect_url ?? req.query.redirectUrl ?? req.query.return_url ?? req.query.returnUrl;
  const orderIdRaw = req.query.order_id ?? req.query.orderId ?? req.query.order ?? req.query.id;

  let derivedOrderId = orderIdRaw;

  // Some Shopify thank-you/order-status blocks don't expose order.id but do expose an order status URL.
  // In that case, derive the numeric order id from URLs like: https://{shop}/account/orders/1234567890
  const candidateUrls = [];
  if (redirectRaw) candidateUrls.push(String(redirectRaw));
  const referer = req.get('referer');
  if (referer) candidateUrls.push(String(referer));

  if (!derivedOrderId && candidateUrls.length) {
    try {
      for (const candidate of candidateUrls) {
        const parsed = new URL(candidate);
        if (!security.isAllowedRedirectUrl(candidate, ALLOWED_REDIRECT_HOSTS)) continue;
        const match = parsed.pathname.match(/\/orders\/(\d+)(?:\/|$)/i);
        if (match?.[1]) {
          derivedOrderId = match[1];
          break;
        }
      }
    } catch {
      // ignore, handled below
    }
  }

  if (!derivedOrderId) {
    return {
      error: 'Missing required parameter: order_id (or provide a valid redirect_url so the server can derive it)',
      status: 400,
    };
  }

  const safeOrderId = security.sanitizeOrderId(derivedOrderId);
  if (!safeOrderId) {
    return { error: 'Invalid order_id', status: 400 };
  }

  // Amount is optional here; in production we should fetch it from Shopify (when configured).
  let amountNum = null;
  if (amount != null && String(amount).trim() !== '') {
    amountNum = security.parseAmount(amount);
    if (amountNum === null) {
      return { error: 'Invalid amount', status: 400 };
    }
  }

  let redirectUrl = null;
  if (redirectRaw) {
    if (!security.isAllowedRedirectUrl(redirectRaw, ALLOWED_REDIRECT_HOSTS)) {
      return { error: 'Invalid redirect_url', status: 400 };
    }
    redirectUrl = String(redirectRaw);
  }

  const shopifyOrderId = /^\d+$/.test(String(safeOrderId))
    ? String(safeOrderId)
    : null;

  return {
    safeOrderId,
    shopifyOrderId,
    redirectUrl,
    amount: amountNum,
  };
}

function buildSignedCheckoutRedirectUrl({ amount, safeOrderId, redirectUrl }) {
  const ts = Date.now().toString();
  const amountFormatted = security.formatAmount(amount);
  const signature = security.signCheckoutSignature(
    { timestamp: ts, orderId: safeOrderId, amount: amountFormatted },
    CHECKOUT_SECRET
  );

  const query = new URLSearchParams({
    amount: amountFormatted,
    order_id: safeOrderId,
    timestamp: ts,
    signature,
  });
  if (redirectUrl) query.set('redirect_url', redirectUrl);
  return `/checkout?${query.toString()}`;
}

/**
 * Shopify Thank You / Order Status page can only pass basic params (amount, order_id, redirect_url).
 * This route generates a short-lived signed URL and redirects into the existing /checkout flow.
 */
app.get('/pay', payLimiter, (req, res) => {
  if (!CHECKOUT_SECRET) {
    return res.status(500).send('Checkout signing is not configured.');
  }

  const validated = validatePayRequest(req);
  if (validated.error) {
    return res.status(validated.status).send(validated.error);
  }

  const proceedWithAmount = (amountToUse) => res.redirect(302, buildSignedCheckoutRedirectUrl({
    amount: amountToUse,
    safeOrderId: validated.safeOrderId,
    redirectUrl: validated.redirectUrl,
  }));

  // Secure mode: derive amount from Shopify Admin API (prevents underpayment by tampering with URL).
  if (shopify.isConfigured()) {
    return shopify.getOrderTotal(validated.safeOrderId)
      .then(({ amount, currencyCode }) => {
        if (currencyCode && String(currencyCode).toUpperCase() !== 'NPR') {
          return res.status(400).send(`Order currency must be NPR (got ${currencyCode}).`);
        }
        return proceedWithAmount(amount);
      })
      .catch((err) => {
        console.error('Shopify getOrderTotal failed:', validated.safeOrderId, err.message);
        return res.status(502).send('Unable to fetch order total. Please try again later.');
      });
  }

  // Fallback (MVP only): allow amount from query if explicitly permitted (or in dev).
  if (!IS_PROD || ALLOW_PAY_AMOUNT_FROM_QUERY) {
    if (validated.amount == null) {
      return res.status(400).send('Missing required parameter: amount');
    }
    return proceedWithAmount(validated.amount);
  }

  return res.status(501).send(
    'Secure /pay requires Shopify Admin API to fetch the real order total. ' +
    'Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN, or use a pre-signed /checkout link.'
  );
});

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

  const body = {
    status: tx.status,
    orderId: tx.orderId,
    referenceLabel: tx.referenceLabel,
    amount: security.formatAmount(tx.amount),
  };
  if (tx.status === 'paid') {
    body.fonepayVerified = true;
    body.prn = tx.prn;
    body.shopifyManualRequired = !shopify.isConfigured();
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
    confirmPaymentWithApi(tx).catch((err) => {
      console.error('Webhook status verification failed:', tx.referenceLabel, err.message);
    });
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
    shopifyMarkPaidMode: shopify.isConfigured() ? 'automatic' : 'manual',
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
