const crypto = require('crypto');

const CHECKOUT_MAX_AGE_MS = 15 * 60 * 1000;
const MAX_AMOUNT_NPR = 10_000_000;

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function signCheckoutPayload({ timestamp, orderId, amount }, secret) {
  const payload = `${timestamp}.${orderId}.${amount}`;
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function verifyCheckoutSignature({ timestamp, orderId, amount, signature }, secret) {
  if (!secret) return { ok: false, error: 'Checkout signing is not configured' };
  if (!timestamp || !orderId || !amount || !signature) {
    return { ok: false, error: 'Missing checkout signature parameters' };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, error: 'Invalid timestamp' };
  }
  if (Date.now() - ts > CHECKOUT_MAX_AGE_MS || ts > Date.now() + 60_000) {
    return { ok: false, error: 'Checkout link expired' };
  }

  const amountNum = parseAmount(amount);
  if (amountNum === null) {
    return { ok: false, error: 'Invalid amount' };
  }

  const expected = signCheckoutPayload(
    { timestamp: String(timestamp), orderId: String(orderId), amount: formatAmount(amountNum) },
    secret
  );

  if (!timingSafeEqual(expected, String(signature).toLowerCase())) {
    return { ok: false, error: 'Invalid checkout signature' };
  }

  return { ok: true, amount: amountNum };
}

function parseAmount(raw) {
  const n = Math.round(Number(raw) * 100) / 100;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT_NPR) return null;
  return n;
}

function formatAmount(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function sanitizeOrderId(orderId) {
  return String(orderId).replace(/[^a-zA-Z0-9]/g, '');
}

function isAllowedRedirectUrl(url, allowedHosts) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret) return true;
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const provided = String(signatureHeader).replace(/^sha256=/i, '').trim().toLowerCase();
  return timingSafeEqual(expected, provided);
}

module.exports = {
  CHECKOUT_MAX_AGE_MS,
  signCheckoutSignature: signCheckoutPayload,
  verifyCheckoutSignature,
  parseAmount,
  formatAmount,
  sanitizeOrderId,
  isAllowedRedirectUrl,
  verifyWebhookSignature,
  timingSafeEqual,
};
