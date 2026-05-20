# Fonepay Integration Test - Setup Instructions

## Step 1: Install Node.js
Download and install from: https://nodejs.org  (choose LTS version)

## Step 2: Open Terminal / Command Prompt
- Windows: Press Win+R, type "cmd", press Enter
- Mac: Press Cmd+Space, type "terminal", press Enter

## Step 3: Navigate to this folder
```
cd path/to/fonepay-test
```

## Step 4: Install dependencies
```
npm install node-fetch@2 node-forge
```

## Step 5: Run the test
```
node test.js
```

---

## What to expect:

### ✅ If everything works:
```
✅ LOGIN SUCCESS!
✅ GOT BANK LIST!
✅ QR GENERATED!
```

### ❌ If you get "cannot reach server":
→ The UAT server may be IP-restricted
→ Contact Fonepay support and ask them to whitelist your IP address
→ Ask: "Can you whitelist my IP for UAT API access?"

### ❌ If you get "signature error":
→ The private key in the PDF may be corrupted/truncated
→ Ask Fonepay for the actual private key as a .pem file (not from PDF)

---

## When tests pass, tell Claude and we will build the full Shopify integration!
