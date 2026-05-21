/**
 * Fonepay WebSocket client — Fixed
 *
 * ROOT CAUSE OF 1006 CLOSE:
 * Fonepay's WebSocket URL already contains auth embedded in the path:
 *   wss://ws.fonepay.com/merchantEndPoint/{uuid}/{terminalId}/Y
 * The trailing /Y is the auth indicator. Adding an Authorization header
 * on the WebSocket upgrade causes the server to reject it (1006 = abnormal close).
 *
 * FIX: Connect with the raw wsUrl as-is, NO extra headers.
 *
 * Also fixed:
 * - Reconnect uses fresh token-free URL (same URL, just reconnect)
 * - Ping interval increased to 25s (Render times out at 30s)
 * - Added pong handler to confirm server is alive
 * - Session stops after payment confirmed (no zombie connections)
 */

const WebSocket = require('ws');

const activeSessions = new Map();
const PING_INTERVAL_MS = 25000; // Keep alive — Render/Heroku kill at 30s idle
const MAX_RECONNECTS = 5;       // Reduced — if Fonepay closes it, QR may have expired

// ============================================================
// MESSAGE PARSERS
// ============================================================

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
    try { return JSON.parse(statusPayload); } catch { return null; }
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
  return txStatus?.qrVerified === true || msg?.qrVerified === true;
}

// ============================================================
// CONNECTION
// ============================================================

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

  // Clean up any existing socket
  if (session.ws) {
    try {
      session.ws.removeAllListeners();
      if (
        session.ws.readyState === WebSocket.OPEN ||
        session.ws.readyState === WebSocket.CONNECTING
      ) {
        session.ws.close();
      }
    } catch (_) {}
  }

  // FIX: NO Authorization header — Fonepay auth is embedded in the URL path (/Y suffix)
  // Adding headers causes the server to reject with 1006
  const wsOptions = {
    handshakeTimeout: 15000,
    perMessageDeflate: false,
    // Do NOT add headers here — Fonepay URL is self-authenticating
  };

  console.log('[Fonepay WS] Connecting to:', wsUrl.slice(-60));
  const ws = new WebSocket(wsUrl, wsOptions);
  session.ws = ws;

  ws.on('open', () => {
    session.reconnectAttempts = 0;
    console.log('[Fonepay WS] Connected successfully:', wsUrl.slice(-60));
    handlers.onOpen?.();

    // Start keepalive ping
    if (session.pingTimer) clearInterval(session.pingTimer);
    session.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
          console.log('[Fonepay WS] Ping sent for:', key);
        } catch (_) {}
      }
    }, PING_INTERVAL_MS);
  });

  ws.on('pong', () => {
    console.log('[Fonepay WS] Pong received — connection alive for:', key);
  });

  ws.on('message', (data) => {
    const msg = parseMessage(data);
    console.log('[Fonepay WS] Message received for', key, ':', JSON.stringify(msg));

    handlers.onMessage?.(msg);

    if (isQrVerified(msg)) {
      console.log('[Fonepay WS] QR scanned/verified for:', key);
      handlers.onQrVerified?.(msg);
    }

    if (isPaymentSuccess(msg)) {
      console.log('[Fonepay WS] Payment SUCCESS for:', key);
      handlers.onPaymentSuccess?.(msg);
      // Stop reconnecting after payment — session is done
      session.stopping = true;
    }
  });

  ws.on('error', (err) => {
    console.error('[Fonepay WS] Error for', key, ':', err.message);
    handlers.onError?.(err);
  });

  ws.on('close', (code, reason) => {
    const reasonStr = reason?.toString() || '(no reason)';
    console.log('[Fonepay WS] Closed for', key, '— code:', code, 'reason:', reasonStr);

    if (session.pingTimer) {
      clearInterval(session.pingTimer);
      session.pingTimer = null;
    }
    handlers.onClose?.(code, reasonStr);

    // Don't reconnect if:
    // - manually stopped
    // - payment already confirmed
    // - max reconnects hit
    // - code 1000 (normal close = QR expired or session ended cleanly)
    if (session.stopping) {
      console.log('[Fonepay WS] Session stopped, no reconnect for:', key);
      return;
    }
    if (code === 1000) {
      console.log('[Fonepay WS] Clean close (QR expired or session ended) for:', key);
      return;
    }
    if (session.reconnectAttempts >= MAX_RECONNECTS) {
      console.error('[Fonepay WS] Max reconnects reached for:', key);
      return;
    }

    session.reconnectAttempts += 1;
    const delay = Math.min(2000 * session.reconnectAttempts, 10000); // backoff
    console.log('[Fonepay WS] Reconnecting in', delay, 'ms (attempt', session.reconnectAttempts, ') for:', key);
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      connect(wsUrl, handlers, key, session);
    }, delay);
  });

  activeSessions.set(key, session);
  return ws;
}

// ============================================================
// PUBLIC API
// ============================================================

function startMonitoring(wsUrl, handlers = {}) {
  if (!wsUrl) {
    console.warn('[Fonepay WS] startMonitoring called with no URL');
    return null;
  }

  const key = handlers.sessionKey || wsUrl;
  const existing = activeSessions.get(key);

  if (existing?.ws?.readyState === WebSocket.OPEN) {
    console.log('[Fonepay WS] Already monitoring:', key);
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
    try { session.ws.close(1000, 'Session complete'); } catch (_) {}
  }
  activeSessions.delete(key);
  console.log('[Fonepay WS] Stopped monitoring:', key);
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