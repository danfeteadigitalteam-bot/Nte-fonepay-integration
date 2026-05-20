const express = require('express');
const cors = require('cors');
const path = require('path');
const fonepay = require('./fonepay-sdk');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// Set EJS as the view engine for rendering the payment page
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Store pending transactions temporarily in memory (In production, use Redis or DB)
const pendingTransactions = new Map();
const orderTransactions = new Map();
const QR_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_QR_RETRY_ATTEMPTS = 6;
const QR_RETRY_DELAY_MS = 5 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateQrWithRetry(params) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_QR_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fonepay.generateQR(null, params);
    } catch (error) {
      lastError = error;
      if (error.status !== 409 || attempt === MAX_QR_RETRY_ATTEMPTS) {
        throw error;
      }
      await sleep(QR_RETRY_DELAY_MS);
    }
  }

  throw lastError || new Error('Unable to generate QR');
}

// ============================================================================
// 1. INITIATE PAYMENT (Redirect from Shopify)
// ============================================================================
app.get('/checkout', async (req, res) => {
  try {
    // Expected parameters from Shopify custom payment redirect
    const { amount, order_id, redirect_url, terminal_id } = req.query;

    if (!amount || !order_id) {
      return res.status(400).send('Missing required parameters: amount, order_id');
    }

    // Sanitize order_id to guarantee strictly alphanumeric characters (Shopify IDs can contain symbols)
    const safeOrderId = String(order_id).replace(/[^a-zA-Z0-9]/g, '');
    if (!safeOrderId) {
      return res.status(400).send('Invalid order_id');
    }

    // Reuse active QR session for the same order to avoid repeated 409 conflicts on refresh/retry.
    const existingWsId = orderTransactions.get(safeOrderId);
    if (existingWsId) {
      const existingTx = pendingTransactions.get(existingWsId);
      const isActive = existingTx && existingTx.status === 'pending' && Date.now() < existingTx.expiresAt;

      if (isActive) {
        return res.render('payment', {
          orderId: order_id,
          amount: amount,
          qrImage: existingTx.qrImage,
          websocketId: existingWsId
        });
      }

      orderTransactions.delete(safeOrderId);
      if (existingTx && existingTx.status !== 'paid') {
        pendingTransactions.delete(existingWsId);
      }
    }

    // Generate Fonepay QR
    const qrData = await generateQrWithRetry({
      amount: amount,
      billId: `ORD${safeOrderId}${Date.now().toString().slice(-4)}`.substring(0, 20),
      referenceLabel: `Shopify${safeOrderId}`.substring(0, 20),
      terminalId: terminal_id
    });

    // Generate the actual QR code image (Base64) to show on the page
    const qrImageBase64 = await QRCode.toDataURL(qrData.prn);

    // Save transaction info to memory
    pendingTransactions.set(qrData.websocketId, {
      orderId: order_id,
      safeOrderId,
      amount: amount,
      redirectUrl: redirect_url,
      status: 'pending',
      qrImage: qrImageBase64,
      expiresAt: Date.now() + QR_SESSION_TTL_MS
    });
    orderTransactions.set(safeOrderId, qrData.websocketId);

    // Render the payment page
    res.render('payment', {
      orderId: order_id,
      amount: amount,
      qrImage: qrImageBase64,
      websocketId: qrData.websocketId
    });

  } catch (error) {
    console.error('Checkout Error:', error);
    if (error.status === 409) {
      const retryUrl = req.originalUrl || '/checkout';
      return res.status(409).render('terminal-busy', {
        retryUrl,
        retryAfterSeconds: 30,
        orderId: req.query.order_id || 'N/A'
      });
    }
    res.status(500).send('Error generating payment request: ' + error.message);
  }
});

// ============================================================================
// 2. CHECK PAYMENT STATUS (Polled by the frontend)
// ============================================================================
app.get('/api/status/:wsId', (req, res) => {
  const tx = pendingTransactions.get(req.params.wsId);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });

  if (tx.status === 'pending' && Date.now() >= tx.expiresAt) {
    tx.status = 'expired';
    orderTransactions.delete(tx.safeOrderId);
  }
  
  res.json({ status: tx.status, redirectUrl: tx.redirectUrl });
});

// ============================================================================
// 3. FONEPAY WEBHOOK (Simulated - Requires exact Fonepay webhook endpoint)
// ============================================================================
// NOTE: We need Fonepay's official webhook documentation to format this perfectly.
// For now, this is a placeholder where Fonepay notifies us of success.
app.post('/webhook/fonepay', async (req, res) => {
  console.log('🔔 Webhook received from Fonepay:', req.body);
  
  // TODO: Verify webhook signature here

  const { websocketId, status } = req.body;
  const tx = pendingTransactions.get(websocketId);

  if (tx && status === 'SUCCESS') {
    tx.status = 'paid';
    orderTransactions.delete(tx.safeOrderId);
    
    // TODO: Call Shopify API to mark order as paid
    // await markShopifyOrderPaid(tx.orderId);
  }

  res.send('OK');
});

app.listen(PORT, () => {
  console.log(`🚀 Fonepay Payment Server running at http://localhost:${PORT}`);
});
