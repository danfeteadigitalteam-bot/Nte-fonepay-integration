/**
 * FONEPAY SDK — Fixed for Intent QR (v1.9 docs)
 * ================================================
 * Key fixes:
 *  1. paymentMode in QR body must be "QR" not "INTENT" (docs p.15)
 *  2. amount sent as Number/Decimal, not String (docs p.16)
 *  3. Signature signs full JSON body string (docs p.12)
 *  4. getBankList signs empty string (GET request, no body)
 *  5. Login URL corrected to v2 path
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
 
for (const [key, value] of Object.entries(CONFIG)) {
  if (!value && key !== 'PRIVATE_KEY_PATH') {
    throw new Error(`Missing required config: ${key}. Set it in .env file.`);
  }
}
 
// ============================================================
// LOAD PRIVATE KEY
// ============================================================
const PRIVATE_KEY = (() => {
  if (process.env.FONEPAY_PRIVATE_KEY_B64) {
    const pem = Buffer.from(process.env.FONEPAY_PRIVATE_KEY_B64, 'base64').toString('utf8');
    return crypto.createPrivateKey(pem);
  }
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
 * Sign a string payload with RSA SHA256, return base64 signature.
 * Per docs (p.12): "Take all request JSON body as payload"
 * For GET requests with no body, sign empty string "".
 */
function sign(payload) {
  // Always sign a string — for JSON bodies pass the raw JSON string, not the object
  const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signer = crypto.createSign('SHA256');
  signer.update(str, 'utf8');
  return signer.sign(PRIVATE_KEY, 'base64');
}
 
function basicAuth() {
  return 'Basic ' + Buffer.from(`${CONFIG.USERNAME}:${CONFIG.PASSWORD}`).toString('base64');
}
 
// ============================================================
// TOKEN CACHE
// ============================================================
let cachedToken = null;
let tokenExpiry = 0;
const TOKEN_TTL_MS = 25 * 60 * 1000;
 
// ============================================================
// API METHODS
// ============================================================
 
/**
 * Login — signs the JSON body string as documented.
 * Note: The curl example in docs (p.11) shows signing {"username":...,"password":...}
 */
async function login() {
  const url = `${CONFIG.BASE_URL}/api/merchant/third-party/v2/login`;
 
  // Build body object and immediately stringify — field order is fixed here
  const body = { username: CONFIG.USERNAME, password: CONFIG.PASSWORD };
  const bodyStr = JSON.stringify(body);
 
  console.log('[Fonepay] Logging in...');
 
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': basicAuth(),
      'signature': sign(bodyStr),   // NOTE: header name is lowercase "signature" per docs p.10
    },
    body: bodyStr,
  });
 
  const rawText = await res.text();
  console.log('[Fonepay] Login response:', rawText);
 
  if (!res.ok) {
    throw new Error(`Login failed (${res.status}): ${rawText}`);
  }
 
  const data = JSON.parse(rawText);
  const token = data.accessToken; // "Bearer eyJ..."
 
  cachedToken = token;
  tokenExpiry = Date.now() + TOKEN_TTL_MS;
 
  return token;
}
 
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }
  return login();
}
 
/**
 * Get bank list — GET request, sign empty string per docs (no body).
 */
async function getBankList(token) {
  token = token || await getToken();
  const url = `${CONFIG.BASE_URL}/api/merchant/third-party/v2/banks/list`;
 
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': token,
      'signature': sign(''),      // GET has no body — sign empty string
      'paymentMode': 'INTENT',
    },
  });
 
  if (res.status === 401) {
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
 * Generate Intent QR.
 *
 * FIXES vs original:
 *  - paymentMode: "QR" (not "INTENT") — see docs p.15 curl example and p.16 request sample
 *  - amount: Number (Decimal) — docs say "amount": 100.00, not "100" string
 *  - Signs the exact JSON string that is sent as the body
 */
async function generateQR(token, { amount, billId, referenceLabel, terminalId }) {
  token = token || await getToken();
  const url = `${CONFIG.BASE_URL}/api/merchant/third-party/v2/generate-intent-qr`;
 
  // FIX 1: paymentMode must be "QR" not "INTENT" (docs p.15-16)
  // FIX 2: amount must be a Number, not a String (docs p.16: "amount": 100.00)
  const amountNum = Math.round(Number(amount) * 100) / 100;
  const body = {
    amount: amountNum,
    billId: String(billId),
    terminalId: String(terminalId || CONFIG.TERMINAL_ID),
    paymentMode: 'QR',
    referenceLabel: String(referenceLabel),
    qrType: 'INTENT_QR',
  };

  const bodyStr = JSON.stringify(body);

  console.log('[Fonepay] Generating QR with body:', bodyStr);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'signature': sign(bodyStr),
    },
    body: bodyStr,
  });
 
  // Log the raw response for debugging
  const rawText = await res.text();
  console.log('[Fonepay] QR generation raw response:', rawText);
 
  if (res.status === 401) {
    cachedToken = null;
    const newToken = await login();
    return generateQR(newToken, { amount, billId, referenceLabel, terminalId });
  }
 
  if (res.status === 409) {
    const errData = JSON.parse(rawText || '{}');
    const err = new Error('Terminal has an active QR session. Wait for it to expire or use a different terminal.');
    err.status = 409;
    err.data = errData;
    throw err;
  }
 
  if (!res.ok) {
    throw new Error(`QR generation failed (${res.status}): ${rawText}`);
  }
 
  return JSON.parse(rawText);
}
 
/**
 * Check payment status via POST API (docs p.20-21).
 * Call this after receiving a WebSocket notification.
 */
async function checkPaymentStatus(token, { terminalId, referenceLabel }) {
  token = token || await getToken();
  const url = `${CONFIG.BASE_URL}/api/merchant/third-party/v2/thirdPartyDynamicQrGetStatus`;
 
  const body = {
    terminalId: String(terminalId || CONFIG.TERMINAL_ID),
    referenceLabel: String(referenceLabel),
  };
  const bodyStr = JSON.stringify(body);
 
  console.log('[Fonepay] Checking payment status:', bodyStr);
 
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'signature': sign(bodyStr),
    },
    body: bodyStr,
  });
 
  const rawText = await res.text();
  console.log('[Fonepay] Payment status response:', rawText);
 
  if (res.status === 401) {
    cachedToken = null;
    const newToken = await login();
    return checkPaymentStatus(newToken, { terminalId, referenceLabel });
  }
 
  if (!res.ok) {
    throw new Error(`Status check failed (${res.status}): ${rawText}`);
  }
 
  return JSON.parse(rawText);
}
 
module.exports = {
  login,
  getToken,
  getBankList,
  generateQR,
  checkPaymentStatus,
  sign,
  CONFIG,
};
 