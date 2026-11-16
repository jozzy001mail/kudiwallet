# KudiWallet — 3-minute demo script

For the Dakar Bitcoin Hack submission. Record the screen at http://localhost:3000
(or the deployed URL). Keep it under 3 minutes: problem → solution → impact →
next steps.

## 0:00–0:30 — The problem

> "Across Africa, Bitcoin is already how people save and get paid. But the wallets
> most people meet are custodial, confusing, or built for traders — not for a market
> seller who just wants to be paid for 2 kilos of rice. KudiWallet is a wallet you
> can explain in one minute: it works on a cheap phone, shows prices in naira, and
> treats a Lightning invoice like a paper receipt."

Show: the landing page, the tagline "Bitcoin & Lightning for everyday Africa".

## 0:30–1:30 — The solution (live walkthrough)

1. **Create a wallet (10s).** Click "Create new wallet" — the 12-word recovery
   phrase appears. "Your keys never leave this browser — the phrase is encrypted
   with a passphrase you choose."
2. **Receive (15s).** The wallet shows a real testnet address `tb1q…` and a QR code.
   "Share this to get paid. The balance and history come live from the testnet
   network, and the price is shown in naira and dollars."
3. **Demo mode (15s).** Switch on demo mode (top right). "No faucet coins? Demo
   mode gives you a simulated 50,000 sats so every flow works right now."
4. **Send (20s).** Go to Send, paste an address, enter 10,000 sats, pick a fee
   speed, click Send. "The app builds a real P2WPKH transaction, signs it in your
   browser, and broadcasts it — the explorer link appears when it lands."
5. **Lightning (20s).** Go to Lightning, create an invoice for 1,000 sats,
   "2 kg of rice". The invoice and QR appear. "This is a real, signed BOLT11
   invoice — any Lightning wallet can decode it. Paying it is simulated in this
   MVP, and the app says so plainly."

## 1:30–2:15 — Impact

> "This is not a mockup. The cryptography is real — BIP39, BIP84, P2WPKH signing,
> BOLT11 — and it is cross-validated against bitcoinjs-lib: five checks, all
> passing. The next step is a real Lightning node so invoices actually settle.
> For a seller in Lagos or Dakar, this is the difference between 'Bitcoin is for
> traders' and 'Bitcoin is how I get paid today.'"

Show (optional): run `npm test` in a terminal — all 5 checks pass.

## 2:15–3:00 — Next steps

> "Next: connect a real Lightning node, add change-address rotation, and keep the
> bundle small enough for a cheap phone on a slow connection. KudiWallet — Bitcoin
> and Lightning for everyday Africa."

End card: repo URL + "Built by Joshua Owoade (jozzy-001), Nigeria."

## If the judges test it themselves

- Demo mode works with zero setup.
- Real testnet: import the public demo phrase
  `either immune work wonder grace pilot front staff goat market turtle rice`
  (address `tb1qnu5satta8cgpyv4wsftfmvgp7vs32hdwc6gvzj`), fund it at
  https://mempool.space/testnet/faucet, then send from the app.
