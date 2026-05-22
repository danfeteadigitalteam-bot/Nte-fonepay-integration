const fetch = require('node-fetch');

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

function isConfigured() {
  return Boolean(STORE && TOKEN);
}

async function adminGraphql(query, variables = {}) {
  if (!isConfigured()) {
    throw new Error('Shopify Admin API is not configured');
  }

  const url = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Shopify API invalid JSON (${res.status})`);
  }

  if (!res.ok) {
    throw new Error(`Shopify API HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (data.errors?.length) {
    throw new Error(data.errors.map((e) => e.message).join('; '));
  }
  return data.data;
}

/**
 * Mark a Shopify order as paid (manual / external payment).
 * orderId: numeric Shopify order ID (from Liquid {{ order.id }}).
 */
async function markOrderAsPaid(orderId) {
  const numericId = String(orderId).replace(/\D/g, '');
  if (!numericId) {
    throw new Error('Invalid Shopify order id');
  }

  const mutation = `
    mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
      orderMarkAsPaid(input: $input) {
        order { id displayFinancialStatus }
        userErrors { field message }
      }
    }
  `;

  const data = await adminGraphql(mutation, {
    input: { id: `gid://shopify/Order/${numericId}` },
  });

  const result = data?.orderMarkAsPaid;
  const errors = result?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join('; '));
  }
  return result?.order;
}

function defaultOrderStatusUrl(orderId) {
  if (!STORE || !orderId) return null;
  const numericId = String(orderId).replace(/\D/g, '');
  return `https://${STORE}/account/orders/${numericId}`;
}

module.exports = {
  isConfigured,
  markOrderAsPaid,
  defaultOrderStatusUrl,
};
