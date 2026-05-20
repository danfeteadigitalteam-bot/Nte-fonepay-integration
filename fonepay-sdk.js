/**
 * FONEPAY SDK — Production-Ready Module
 * =======================================
 * Reusable module for Shopify + Fonepay Intent QR integration.
 * 
 * Usage:
 *   const fonepay = require('./fonepay-sdk');
 *   const token = await fonepay.login();
 *   const banks = await fonepay.getBankList(token);
 *   const qr = await fonepay.generateQR(token, { amount, billId, referenceLabel });
 */

require('dotenv').config();
const fetch = require('node-fetch');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
  BASE_URL: process.env.FONEPAY_BASE_URL || 'https://thirdparty-merchantapi.fonepay.com',
  USERNAME: process.env.FONEPAY_USERNAME,
  PASSWORD: process.env.FONEPAY_PASSWORD,
  TERMINAL_ID: process.env.FONEPAY_TERMINAL_ID,
  PRIVATE_KEY_PATH: process.env.FONEPAY_PRIVATE_KEY_PATH || './private.pem',
};

// Validate required config
for (const [key, value] of Object.entries(CONFIG)) {
  if (!value && key !== 'PRIVATE_KEY_PATH') {
    throw new Error(`Missing required config: ${key}. Set it in .env file.`);
  }
}

// ============================================================
// LOAD PRIVATE KEY (once at startup)
// ============================================================
const PRIVATE_KEY = (() => {
  // Option A: Base64 environment variable (Best for Railway/Render)
  if (process.env.FONEPAY_PRIVATE_KEY_B64) {
    const pem = Buffer.from(process.env.FONEPAY_PRIVATE_KEY_B64, 'base64').toString('utf8');
    return crypto.createPrivateKey(pem);
  }
  
  // Option B: Local file path
  const keyPath = path.resolve(CONFIG.PRIVATE_KEY_PATH);
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Private key not found: ${keyPath}. Set FONEPAY_PRIVATE_KEY_B64 for production.`);
  }
  return crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
})();

// ============================================================
// CRYPTO HELPERS
// ============================================================

/**
 * Sign a payload with RSA SHA256 and return base64 signature
 */
function sign(payload) {
  const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signer = crypto.createSign('SHA256');
  signer.update(str, 'utf8');
  return signer.sign(PRIVATE_KEY, 'base64');
}

/**
 * Create Basic Auth header value
 */
function basicAuth() {
  return 'Basic ' + Buffer.from(`${CONFIG.USERNAME}:${CONFIG.PASSWORD}`).toString('base64');
}

// ============================================================
// TOKEN CACHE (auto-refresh on 401)
// ============================================================
let cachedToken = null;
let tokenExpiry = 0;
const TOKEN_TTL_MS = 25 * 60 * 1000; // Refresh every 25 min (tokens typically last 30 min)

// ============================================================
// API METHODS
// ============================================================

/**
 * Login and get access token.
 * Signature: Sign the JSON body string.
 * Auth: Basic Auth header.
 */
async function login() {
  const url = `${CONFIG.BASE_URL}/api/merchant/third-party/v2/login`;
  const body = { username: CONFIG.USERNAME, password: CONFIG.PASSWORD };
  const bodyStr = JSON.stringify(body);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': basicAuth(),
      'Signature': sign(bodyStr),
    },
    body: bodyStr
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Login failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const token = data.accessToken; // "Bearer eyJ..."

  // Cache the token
  cachedToken = token;
  tokenExpiry = Date.now() + TOKEN_TTL_MS;

  return token;
}

/**
 * Get a valid token (from cache or fresh login)
 */
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }
  return login();
}

/**
 * Get list of banks that support Intent QR payment.
 * Signature: Sign empty string.
 * Auth: Bearer token.
 */
async function getBankList(token) {
  token = token || await getToken();
  const url = `${CONFIG.BASE_URL}/api/merchant/third-party/v2/banks/list`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': token,
      'Signature': sign(''),
      'paymentMode': 'INTENT',
    }
  });

  if (res.status === 401) {
    // Token expired — re-login and retry once
    cachedToken = null;
    const newToken = await login();
    return getBankList(newToken);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Bank list failed (${res.status}): ${errText}`);
  }

  return res.json();
}

/**
 * Generate Intent QR code for payment.
 * Signature: Sign the JSON body string.
 * Auth: Bearer token.
 * 
 * @param {string} token - Access token from login
 * @param {object} options
 * @param {number|string} options.amount - Payment amount
 * @param {string} options.billId - Unique bill/order ID
 * @param {string} options.referenceLabel - Reference label for the transaction
 * @param {string} [options.terminalId] - Terminal ID (defaults to CONFIG)
 * @returns {object} QR response with websocketId, prn, etc.
 */
async function generateQR(token, { amount, billId, referenceLabel, terminalId }) {
  token = token || await getToken();
  const url = `${CONFIG.BASE_URL}/api/merchant/third-party/v2/generate-intent-qr`;

  const body = {
    amount: typeof amount === 'string' ? amount : String(amount),
    billId,
    terminalId: terminalId || CONFIG.TERMINAL_ID,
    paymentMode: 'INTENT',
    referenceLabel,
    qrType: 'INTENT_QR',
  };
  const bodyStr = JSON.stringify(body);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'Signature': sign(bodyStr),
    },
    body: bodyStr
  });

  if (res.status === 401) {
    cachedToken = null;
    const newToken = await login();
    return generateQR(newToken, { amount, billId, referenceLabel, terminalId });
  }

  if (res.status === 409) {
    const errData = await res.json().catch(() => ({}));
    const err = new Error('Terminal has an active QR session. Wait for it to expire or use a different terminal.');
    err.status = 409;
    err.data = errData;
    throw err;
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`QR generation failed (${res.status}): ${errText}`);
  }

  return res.json();
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  login,
  getToken,
  getBankList,
  generateQR,
  sign,
  CONFIG,
};
