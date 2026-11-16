# KudiWallet — Bitcoin & Lightning wallet for everyday Africa

**Dakar Bitcoin Hack 2026 (by BTrust) — entry by Joshua Owoade (jozzy-001, Nigeria)**

*Kudi* means "money" in Hausa. KudiWallet is a fast, simple Bitcoin and Lightning
wallet built for everyday payments in Africa — create a wallet in seconds, receive
with a QR code, send in a tap, and raise Lightning invoices for what you sell.

> **Testnet MVP.** This entry runs on Bitcoin **testnet** only. Never use it for real funds.

## Live demo

```bash
npm install
npm run dev        # builds the bundle and starts the server
# open http://localhost:3000
```

**Try it without funding anything:** switch on **Demo mode** (top right) — a
simulated 50,000-sat balance lets you try send, receive and Lightning end to end.

**Try it for real on testnet:** use the public demo wallet (testnet only, no real
funds — the phrase is published here on purpose):

- Recovery phrase: `either immune work wonder grace pilot front staff goat market turtle rice`
- Address: `tb1qnu5satta8cgpyv4wsftfmvgp7vs32hdwc6gvzj`
- Fund it free at https://mempool.space/testnet/faucet, then send from the app.

## What it does

| Feature | Status |
|---|---|
| Create wallet (real BIP39 12-word phrase, BIP32/BIP84 derivation) | ✅ Real |
| Import recovery phrase | ✅ Real |
| Passphrase-encrypted vault (PBKDF2 + AES-GCM, localStorage) | ✅ Real |
| Native-segwit testnet address (tb1q…) + QR | ✅ Real |
| Live balance + transaction history (mempool.space testnet API) | ✅ Real |
| BTC price in NGN + USD (CoinGecko) | ✅ Real |
| Send: build, sign (P2WPKH) and broadcast a real testnet transaction | ✅ Real |
| Fee-speed choice (live mempool fee rates) | ✅ Real |
| Lightning: create a real, signed BOLT11 invoice | ✅ Real |
| Lightning: inspect (decode + verify) any testnet BOLT11 invoice | ✅ Real |
| Lightning: **settle/pay an invoice** | ⚠️ **Simulated (demo)** — see below |

## What is real, what is simulated — honestly

- **Real:** the cryptography. `src/wallet.js` is dependency-light, browser-safe pure
  JavaScript (BIP39 mnemonics, BIP32/BIP84 derivation, bech32 addresses, P2WPKH
  transaction building and signing, BOLT11 invoice encode/decode). It is
  cross-validated against **bitcoinjs-lib** and the **bolt11** package:
  `npm test` runs 5 checks (known BIP39 vector, address matches bitcoinjs-lib,
  bech32 round-trip, invoice decodes in bolt11, and a built transaction whose
  signature verifies against bitcoinjs-lib's own sighash and parses cleanly).
- **Real:** on-chain sends. A send builds a real P2WPKH transaction, signs it in
  your browser, and broadcasts it to the testnet network through the server proxy.
  Verified live: the server returns the node's own response (e.g. a fake-UTXO
  transaction is rejected by the node with `bad-txns-inputs-missingorspent`).
- **Simulated:** Lightning settlement. This MVP has no live Lightning node, so
  paying an invoice is simulated and labelled **DEMO** in the UI. Invoice
  *encoding* is real (signed BOLT11, decodable by any wallet), but settlement
  needs a node. The documented path to real Lightning is LND/CLN or a
  non-custodial SDK (e.g. Breez) in the next iteration.
- **Simulated:** demo-mode balances, so judges can try every flow without faucet coins.

**Your keys never leave the browser.** The server (`server.js`) only proxies public
blockchain data (mempool.space testnet, CoinGecko). It never sees a recovery phrase
or a private key.

## Architecture

```
public/index.html   — UI shell (wallet / send / receive / lightning / activity)
public/style.css    — mobile-first dark theme, big touch targets
src/app.js          — UI logic, vault, API calls, demo mode (bundled by esbuild)
src/wallet.js       — crypto core: BIP39/BIP32/bech32/P2WPKH/BOLT11 (pure JS)
server.js           — Express: static host + /api proxy (mempool testnet, CoinGecko, broadcast)
test/vectors.test.js— 5 cross-validation checks vs bitcoinjs-lib + bolt11
```

One-command setup: `./start.sh` (installs deps, builds the bundle, starts the server).
No Docker is needed — the server is a single Node process on port 3000.

## Security notes

- Recovery phrase is generated with `crypto.getRandomValues` and validated against
  the BIP39 English wordlist.
- The vault is AES-GCM encrypted with a key derived by PBKDF2 (100,000 iterations,
  SHA-256, random salt). A wrong passphrase cannot open it.
- Testnet only: derivation path is `m/84'/1'/0'/0/0` (coin type 1 = testnet).
- The demo wallet's phrase is public by design — never send real funds to it.

## Roadmap (next iteration)

1. Real Lightning: connect LND/CLN or a non-custodial SDK so invoices actually settle.
2. Multiple addresses + change-address rotation and address reuse warnings.
3. Replace-by-fee and better fee estimation for congested periods.
4. Naira-first UX: amounts in ₦ with sats underneath, offline-friendly bundle size.
5. Mainnet — only after a security review, never before.

## The problem (why this exists)

Across Africa, Bitcoin is already how people save and get paid — but the wallets
most people meet are custodial, confusing, or built for traders, not for a market
seller who wants to be paid for 2 kg of rice. KudiWallet is the opposite: a wallet
you can explain in one minute, that works on a cheap phone, shows prices in naira,
and treats Lightning invoices like a paper receipt — simple, verifiable, yours.

## Verification (done 2026-11-16)

- `npm test` — 5/5 cross-validation checks pass.
- Live server check — `/health` OK; BTC price $64,937 / ₦87,288,630; fee rates live
  (1 sat/vB); demo address resolves on-chain (0 txs, unfunded, as expected);
  broadcast endpoint returns the node's real rejection for a fake-UTXO transaction.
- Devpost page verified live: **Dakar Bitcoin Hack by BTrust** — submissions close
  **20 Nov 2026, 15:00 EST (21:00 WAT)**; eligibility is **Africa residence**
  (not students-only); prizes **1st 500,000 sats / 2nd 250,000 sats / 3rd 100,000 sats**
  ($900 total); a submission needs a presentation, a public GitHub repo, and an MVP
  accessible online, including at least a Bitcoin/Lightning wallet implementation.

## Author

Joshua Owoade — @jozzy-001 — student, EKSU (Nigeria). Built with Muse.
License: MIT.
