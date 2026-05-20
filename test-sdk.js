/**
 * Quick SDK Validation — tests the fonepay-sdk module
 */
const fonepay = require('./fonepay-sdk');

async function main() {
  console.log('🧪 Testing fonepay-sdk.js module...\n');

  // 1. Login
  console.log('1️⃣  Login...');
  const token = await fonepay.login();
  console.log(`   ✅ Token: ${token.substring(0, 40)}...`);

  // 2. Bank List
  console.log('\n2️⃣  Bank List...');
  const banks = await fonepay.getBankList(token);
  console.log(`   ✅ ${banks.bankDetails.length} banks available:`);
  banks.bankDetails.forEach(b => console.log(`      🏦 ${b.bankName}`));

  // 3. QR Generation
  console.log('\n3️⃣  Generate QR...');
  try {
    const qr = await fonepay.generateQR(token, {
      amount: 10,
      billId: 'SDK' + Date.now(),
      referenceLabel: 'SDKTEST' + Date.now().toString().slice(-6),
    });
    console.log('   ✅ QR Generated!');
    console.log('   PRN:', qr.prn);
    console.log('   WebSocket:', qr.websocketId);
  } catch (e) {
    if (e.status === 409) {
      console.log('   ⚠️  409 — Terminal has active QR (auth works, wait for expiry)');
    } else {
      throw e;
    }
  }

  console.log('\n✅ SDK module is working correctly!');
}

main().catch(e => console.error('❌', e.message));
