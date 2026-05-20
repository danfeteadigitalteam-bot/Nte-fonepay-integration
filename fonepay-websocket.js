/**
 * Fonepay WebSocket client — one connection per QR session (server-side only).
 */
const WebSocket = require('ws');

const activeSessions = new Map();
const PING_INTERVAL_MS = 20000;
const MAX_RECONNECTS = 10;

function parseMessage(raw) {
  const text = raw.toString();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function parseTransactionStatus(msg) {
  if (!msg || typeof msg !== 'object') return null;

  let statusPayload = msg.transactionStatus;
  if (!statusPayload) return null;

  if (typeof statusPayload === 'string') {
    try {
      return JSON.parse(statusPayload);
    } catch {
      return null;
    }
  }
  if (typeof statusPayload === 'object') return statusPayload;
  return null;
}

function isPaymentSuccess(msg) {
  if (!msg || typeof msg !== 'object') return false;

  const txStatus = parseTransactionStatus(msg);
  if (txStatus?.paymentSuccess === true) return true;

  const status = String(
    msg.status || msg.paymentStatus || msg.transactionStatus || ''
  ).toUpperCase();

  return ['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED', 'APPROVED'].includes(status)
    || msg.success === true
    || msg.paymentSuccess === true;
}

function isQrVerified(msg) {
  const txStatus = parseTransactionStatus(msg);
  return txStatus?.qrVerified === true;
}

function connect(wsUrl, handlers, key, existingSession = null) {
  const session = existingSession || {
    wsUrl,
    handlers,
    stopping: false,
    pingTimer: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
  };
  session.stopping = false;

  if (session.ws) {
    try {
      session.ws.removeAllListeners();
      if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
        session.ws.close();
      }
    } catch (_) {}
  }

  const wsOptions = {
    handshakeTimeout: 15000,
    perMessageDeflate: false,
  };
  if (handlers.authToken) {
    wsOptions.headers = { Authorization: handlers.authToken };
  }

  const ws = new WebSocket(wsUrl, wsOptions);
  session.ws = ws;

  ws.on('open', () => {
    session.reconnectAttempts = 0;
    console.log('[Fonepay WS] Connected:', wsUrl.slice(-52));
    handlers.onOpen?.();

    if (session.pingTimer) clearInterval(session.pingTimer);
    session.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch (_) {}
      }
    }, PING_INTERVAL_MS);
  });

  ws.on('message', (data) => {
    const msg = parseMessage(data);
    console.log('[Fonepay WS] Message:', JSON.stringify(msg));
    handlers.onMessage?.(msg);
    if (isQrVerified(msg)) handlers.onQrVerified?.(msg);
    if (isPaymentSuccess(msg)) handlers.onPaymentSuccess?.(msg);
  });

  ws.on('error', (err) => {
    console.error('[Fonepay WS] Error:', err.message);
    handlers.onError?.(err);
  });

  ws.on('close', (code, reason) => {
    const reasonStr = reason?.toString() || '';
    console.log('[Fonepay WS] Closed:', code, reasonStr || '(no reason)');
    if (session.pingTimer) {
      clearInterval(session.pingTimer);
      session.pingTimer = null;
    }
    handlers.onClose?.(code, reasonStr);

    if (session.stopping) return;
    if (session.reconnectAttempts >= MAX_RECONNECTS) {
      console.error('[Fonepay WS] Max reconnects reached for', key);
      return;
    }
    session.reconnectAttempts += 1;
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      console.log('[Fonepay WS] Reconnect attempt', session.reconnectAttempts, 'for', key);
      connect(wsUrl, handlers, key, session);
    }, 2000);
  });

  activeSessions.set(key, session);
  return ws;
}

function startMonitoring(wsUrl, handlers = {}) {
  if (!wsUrl) return null;

  const key = handlers.sessionKey || wsUrl;
  const existing = activeSessions.get(key);
  if (existing?.ws?.readyState === WebSocket.OPEN) {
    return existing.ws;
  }
  if (existing) stopMonitoring(key);

  return connect(wsUrl, handlers, key);
}

function stopMonitoring(key) {
  const session = activeSessions.get(key);
  if (!session) return;

  session.stopping = true;
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  if (session.pingTimer) {
    clearInterval(session.pingTimer);
    session.pingTimer = null;
  }
  if (session.ws) {
    try {
      session.ws.close();
    } catch (_) {}
  }
  activeSessions.delete(key);
}

function getActiveCount() {
  let n = 0;
  for (const s of activeSessions.values()) {
    if (s.ws?.readyState === WebSocket.OPEN) n++;
  }
  return n;
}

module.exports = {
  startMonitoring,
  stopMonitoring,
  isPaymentSuccess,
  isQrVerified,
  parseTransactionStatus,
  getActiveCount,
};
