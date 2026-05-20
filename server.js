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

// ============================================================================
// 1. INITIATE PAYMENT (Redirect from Shopify)
// ============================================================================
app.get('/checkout', async (req, res) => {
  try {
    // Expected parameters from Shopify custom payment redirect
    const { amount, order_id, redirect_url } = req.query;

    if (!amount || !order_id) {
      return res.status(400).send('Missing required parameters: amount, order_id');
    }

    // Generate Fonepay QR
    const qrData = await fonepay.generateQR(null, {
      amount: amount,
      billId: `ORD-${order_id}-${Date.now().toString().slice(-4)}`, // Ensure uniqueness
      referenceLabel: `Shopify-${order_id}`
    });

    // Generate the actual QR code image (Base64) to show on the page
    const qrImageBase64 = await QRCode.toDataURL(qrData.prn);

    // Save transaction info to memory
    pendingTransactions.set(qrData.websocketId, {
      orderId: order_id,
      amount: amount,
      redirectUrl: redirect_url,
      status: 'pending'
    });

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
      return res.status(409).send('Terminal is currently busy with another transaction. Please try again in 5 minutes.');
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
    
    // TODO: Call Shopify API to mark order as paid
    // await markShopifyOrderPaid(tx.orderId);
  }

  res.send('OK');
});

app.listen(PORT, () => {
  console.log(`🚀 Fonepay Payment Server running at http://localhost:${PORT}`);
});
