/**
 * Quick test: connect to Fonepay WebSocket after generating QR
 */
const WebSocket = require('ws');
const fonepay = require('./fonepay-sdk');

async function main() {
  const ref = 'WSTEST' + Date.now().toString().slice(-6);
  const bill = 'BILL' + Date.now().toString().slice(-8);

  console.log('Generating QR...');
  const qr = await fonepay.generateQR(null, {
    amount: 10,
    billId: bill,
    referenceLabel: ref,
  });

  const wsUrl = qr.websocketId;
  console.log('WebSocket URL:', wsUrl);
  console.log('PRN:', qr.prn);

  if (!wsUrl) {
    console.error('No websocketId in response');
    process.exit(1);
  }

  console.log('\nConnecting to WebSocket (30s listen)...');
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => console.log('[WS] Connected'));
  ws.on('message', (data) => console.log('[WS] Message:', data.toString()));
  ws.on('error', (err) => console.error('[WS] Error:', err.message));
  ws.on('close', (code, reason) => console.log('[WS] Closed:', code, reason?.toString()));

  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 30000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
