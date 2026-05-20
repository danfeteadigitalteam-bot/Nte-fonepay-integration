/**
 * Fonepay WebSocket client — required after generate-intent-qr.
 * Without an active connection, customer scans often fail with "internal server error".
 */
const WebSocket = require('ws');

const activeSessions = new Map();

function parseMessage(raw) {
  const text = raw.toString();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function isPaymentSuccess(msg) {
  if (!msg || typeof msg !== 'object') return false;

  const status = String(
    msg.status || msg.paymentStatus || msg.transactionStatus || msg.qrStatus || ''
  ).toUpperCase();

  if (['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED', 'APPROVED'].includes(status)) {
    return true;
  }

  if (msg.success === true || msg.paymentSuccess === true || msg.qrVerified === true) {
    return true;
  }

  return false;
}

/**
 * @param {string} wsUrl - websocketId from generate-intent-qr response
 * @param {object} handlers
 * @param {(msg: object) => void} handlers.onMessage
 * @param {(err: Error) => void} [handlers.onError]
 */
function startMonitoring(wsUrl, handlers = {}) {
  if (!wsUrl) return null;

  const existing = activeSessions.get(wsUrl);
  if (existing && existing.readyState === WebSocket.OPEN) {
    return existing;
  }

  if (existing) {
    try {
      existing.close();
    } catch (_) {}
    activeSessions.delete(wsUrl);
  }

  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('[Fonepay WS] Connected:', wsUrl.slice(-48));
  });

  ws.on('message', (data) => {
    const msg = parseMessage(data);
    console.log('[Fonepay WS] Message:', typeof msg === 'object' ? JSON.stringify(msg) : msg);
    handlers.onMessage?.(msg);
  });

  ws.on('error', (err) => {
    console.error('[Fonepay WS] Error:', err.message);
    handlers.onError?.(err);
  });

  ws.on('close', (code, reason) => {
    console.log('[Fonepay WS] Closed:', code, reason?.toString() || '');
    activeSessions.delete(wsUrl);
  });

  activeSessions.set(wsUrl, ws);
  return ws;
}

function stopMonitoring(wsUrl) {
  const ws = activeSessions.get(wsUrl);
  if (!ws) return;
  try {
    ws.close();
  } catch (_) {}
  activeSessions.delete(wsUrl);
}

module.exports = {
  startMonitoring,
  stopMonitoring,
  isPaymentSuccess,
  activeSessions,
};
