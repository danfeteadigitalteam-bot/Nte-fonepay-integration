#!/usr/bin/env node
/**
 * Generate a signed Shopify → Fonepay checkout URL.
 *
 * Usage:
 *   node scripts/sign-checkout-url.js --order 5678901234 --amount 1500.00
 *
 * Requires CHECKOUT_HMAC_SECRET and PUBLIC_BASE_URL in .env (or env vars).
 */
require('dotenv').config();
const crypto = require('crypto');
const { signCheckoutSignature, formatAmount } = require('../lib/security');

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
}

const orderId = getArg('order');
const amountRaw = getArg('amount');
const redirect = getArg('redirect');
const secret = process.env.CHECKOUT_HMAC_SECRET;
const base = (process.env.PUBLIC_BASE_URL || 'https://nte-fonepay-integration.onrender.com').replace(/\/$/, '');

if (!secret) {
  console.error('Set CHECKOUT_HMAC_SECRET in .env');
  process.exit(1);
}
if (!orderId || !amountRaw) {
  console.error('Usage: node scripts/sign-checkout-url.js --order <shopify_order_id> --amount <npr> [--redirect <https://...>]');
  process.exit(1);
}

const amount = formatAmount(Number(amountRaw));
const timestamp = String(Date.now());
const signature = signCheckoutSignature({ timestamp, orderId, amount }, secret);

const params = new URLSearchParams({
  order_id: orderId,
  amount,
  timestamp,
  signature,
});
if (redirect) params.set('redirect_url', redirect);

console.log(`${base}/checkout?${params.toString()}`);
