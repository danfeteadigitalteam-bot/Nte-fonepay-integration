const express = require('express');
const cors = require('cors');
const path = require('path');
const fonepay = require('./fonepay-sdk');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
const TERMINAL_ID = process.env.FONEPAY_TERMINAL_ID;

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
const websocketTransactions = new Map();
const QR_SESSION_TTL_MS = 5 * 60 * 1000;

// ============================================================================
// 1. INITIATE PAYMENT (Redirect from Shopify)
// ============================================================================
app.get('/checkout', async (req, res) => {
  try {
    const { amount, order_id, redirect_url } = req.query;

    if (!amount || !order_id) {
      return res.status(400).send('Missing required parameters: amount, order_id');
    }

    if (!TERMINAL_ID) {
      return res.status(500).send('FONEPAY_TERMINAL_ID is not configured on the server.');
    }

    const safeOrderId = String(order_id).replace(/[^a-zA-Z0-9]/g, '');
    if (!safeOrderId) {
      return res.status(400).send('Invalid order_id');
    }

    const existingReferenceLabel = orderTransactions.get(safeOrderId);
    if (existingReferenceLabel) {
      const existingTx = pendingTransactions.get(existingReferenceLabel);
      const isActive = existingTx && existingTx.status === 'pending' && Date.now() < existingTx.expiresAt;

      if (isActive) {
        return res.render('payment', {
          orderId: order_id,
          amount: amount,
          qrImage: existingTx.qrImage,
          referenceLabel: existingReferenceLabel
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
      amount: Number(amount),
      billId: `ORD${safeOrderId}${unique}`.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20),
      referenceLabel,
      terminalId: TERMINAL_ID
    });

    const qrPayload = qrData.qrString || qrData.qrMessage;
    if (!qrPayload) {
      throw new Error('QR payload missing in Fonepay response');
    }
    const qrImageBase64 = await QRCode.toDataURL(qrPayload);

    pendingTransactions.set(referenceLabel, {
      orderId: order_id,
      safeOrderId,
      referenceLabel,
      websocketId: qrData.websocketId,
      amount: amount,
      redirectUrl: redirect_url,
      status: 'pending',
      qrImage: qrImageBase64,
      expiresAt: Date.now() + QR_SESSION_TTL_MS
    });
    orderTransactions.set(safeOrderId, referenceLabel);
    if (qrData.websocketId) {
      websocketTransactions.set(qrData.websocketId, referenceLabel);
    }

    res.render('payment', {
      orderId: order_id,
      amount: amount,
      qrImage: qrImageBase64,
      referenceLabel
    });

  } catch (error) {
    if (error.status === 409) {
      console.warn('Checkout: terminal busy', { terminal: TERMINAL_ID, orderId: req.query.order_id });
      const retryUrl = req.originalUrl || '/checkout';
      return res.status(200).render('terminal-busy', {
        retryUrl,
        retryAfterSeconds: 30,
        orderId: req.query.order_id || 'N/A'
      });
    }
    console.error('Checkout Error:', error);
    res.status(500).send('Error generating payment request: ' + error.message);
  }
});

// ============================================================================
// 2. CHECK PAYMENT STATUS (Polled by the frontend)
// ============================================================================
app.get('/api/status/:referenceLabel', (req, res) => {
  const tx = pendingTransactions.get(req.params.referenceLabel);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });

  if (tx.status === 'pending' && Date.now() >= tx.expiresAt) {
    tx.status = 'expired';
    orderTransactions.delete(tx.safeOrderId);
    if (tx.websocketId) {
      websocketTransactions.delete(tx.websocketId);
    }
  }

  res.json({ status: tx.status, redirectUrl: tx.redirectUrl });
});

// ============================================================================
// 3. FONEPAY WEBHOOK
// ============================================================================
app.post('/webhook/fonepay', async (req, res) => {
  console.log('🔔 Webhook received from Fonepay:', req.body);

  const { websocketId, status, referenceLabel } = req.body;
  const txRef = referenceLabel || websocketTransactions.get(websocketId);
  const tx = txRef ? pendingTransactions.get(txRef) : null;

  if (tx && status === 'SUCCESS') {
    tx.status = 'paid';
    orderTransactions.delete(tx.safeOrderId);
    if (tx.websocketId) {
      websocketTransactions.delete(tx.websocketId);
    }
  }

  res.send('OK');
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    terminalConfigured: Boolean(TERMINAL_ID),
    terminalSuffix: TERMINAL_ID ? TERMINAL_ID.slice(-4) : null
  });
});

app.listen(PORT, () => {
  const suffix = TERMINAL_ID ? TERMINAL_ID.slice(-4) : 'none';
  console.log(`🚀 Fonepay Payment Server running at http://localhost:${PORT}`);
  console.log(`📟 Terminal configured: ${TERMINAL_ID ? 'yes (…' + suffix + ')' : 'MISSING — set FONEPAY_TERMINAL_ID'}`);
});
