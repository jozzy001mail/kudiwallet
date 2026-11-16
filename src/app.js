// KudiWallet — frontend. All cryptography runs in this file's bundle, in the
// browser. The server never sees the recovery phrase or private keys; it only
// proxies public blockchain data (mempool.space testnet + CoinGecko prices).
import * as W from './wallet.js';
import qrcode from 'qrcode-generator';

const $ = (id) => document.getElementById(id);
const DEMO_MNEMONIC = 'either immune work wonder grace pilot front staff goat market turtle rice';
const DEMO_ONCHAIN_SATS = 50000;
const DEMO_LN_SATS = 50000;
const MEMPOOL = 'https://mempool.space/testnet/api';

const state = {
  mnemonic: null,
  seed: null,
  wallet: null, // { privateKey, publicKey, address, path }
  demo: false,
  price: null, // { ngn, usd }
  fees: null,
  demoSpent: 0, // sats "sent" in demo mode
  demoTxs: [], // { id, kind, amount, note, time }
  demoLnSpent: 0,
};

// ---------------------------------------------------------------- helpers
const fmtSats = (n) => n.toLocaleString('en-US');
const fmtBtc = (sats) => (sats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';
const fmtNgn = (sats) => {
  if (!state.price) return '';
  const ngn = (sats / 1e8) * state.price.ngn;
  return `≈ ₦${Math.round(ngn).toLocaleString('en-NG')} · $${((sats / 1e8) * state.price.usd).toFixed(2)}`;
};
const show = (el, on = true) => { el.hidden = !on; };
const setStatus = (el, text, kind = '') => {
  el.hidden = false;
  el.textContent = text;
  el.className = `status ${kind}`;
};
function drawQr(canvas, text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const scale = size / (n + 2);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + 1) * scale, (r + 1) * scale, scale, scale);
    }
  }
}

// ------------------------------------------------------- encrypted vault
// Passphrase -> PBKDF2 (100k, SHA-256) -> AES-GCM key. The phrase is stored
// encrypted in localStorage; the server never sees it.
async function vaultKey(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function vaultSeal(mnemonic, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await vaultKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(mnemonic));
  localStorage.setItem('kudiwallet.vault', JSON.stringify({
    salt: [...salt], iv: [...iv], ct: [...new Uint8Array(ct)],
  }));
}
async function vaultOpen(passphrase) {
  const raw = localStorage.getItem('kudiwallet.vault');
  if (!raw) return null;
  const { salt, iv, ct } = JSON.parse(raw);
  const key = await vaultKey(passphrase, new Uint8Array(salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, new Uint8Array(ct));
  return new TextDecoder().decode(pt);
}

// ------------------------------------------------------------- API layer
async function apiGet(path) {
  // Same-origin proxy first (works when served by server.js); fall back to
  // mempool.space directly when served as plain static files.
  try {
    const r = await fetch(`/api${path}`, { signal: AbortSignal.timeout(12000) });
    if (r.ok) return r.json();
  } catch { /* fall through to direct */ }
  const r = await fetch(`${MEMPOOL}${path}`, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Network error ${r.status}`);
  return r.json();
}
async function fetchPrice() {
  try {
    const r = await fetch('/api/price', { signal: AbortSignal.timeout(10000) });
    if (r.ok) { state.price = await r.json(); return; }
  } catch { /* fall through */ }
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=ngn,usd');
  const j = await r.json();
  state.price = j.bitcoin;
}
async function fetchFees() {
  try { state.fees = await apiGet('/v1/fees/recommended'); }
  catch { state.fees = { fastestFee: 8, halfHourFee: 5, hourFee: 3, economyFee: 2 }; }
}

// ------------------------------------------------------------ wallet load
function openWallet(mnemonic) {
  state.mnemonic = mnemonic;
  state.seed = W.seedFromMnemonic(mnemonic);
  const derived = W.deriveWallet(state.seed);
  state.wallet = { ...derived, address: W.pubkeyToAddress(derived.publicKey) };
  show($('onboarding'), false);
  show($('wallet'), true);
  $('receiveAddress').textContent = state.wallet.address;
  drawQr($('qrCanvas'), state.wallet.address);
  $('walletMeta').textContent = `Derivation ${derived.path} · Native segwit (bech32) · Testnet only`;
  $('lnBalance').textContent = state.demo ? `${fmtSats(DEMO_LN_SATS - state.demoLnSpent)} sats (demo)` : '0 sats — create an invoice to receive';
  refreshAll();
}

async function refreshAll() {
  await Promise.allSettled([fetchPrice(), fetchFees()]);
  await refreshBalance();
  renderActivity();
}

async function refreshBalance() {
  const addr = state.wallet.address;
  if (state.demo) {
    const bal = DEMO_ONCHAIN_SATS - state.demoSpent;
    $('balanceSats').textContent = fmtSats(bal);
    $('balanceFiat').textContent = `${fmtBtc(bal)} BTC · ${fmtNgn(bal)} (demo)`;
    return;
  }
  try {
    const info = await apiGet(`/address/${addr}`);
    const bal = info.chain_stats.funded_txo_sum - info.chain_stats.spent_txo_sum;
    $('balanceSats').textContent = fmtSats(bal);
    $('balanceFiat').textContent = `${fmtBtc(bal)} BTC · ${fmtNgn(bal)}`;
  } catch {
    $('balanceSats').textContent = '—';
    $('balanceFiat').textContent = 'Could not reach the testnet network — check your connection and refresh.';
  }
}

async function renderActivity() {
  const list = $('txList');
  const items = [];
  for (const t of state.demoTxs) {
    items.push(`<li><span><span class="demo-tag">DEMO</span> ${t.note}</span><strong>${t.amount > 0 ? '+' : ''}${fmtSats(t.amount)} sats</strong></li>`);
  }
  if (!state.demo) {
    try {
      const txs = await apiGet(`/address/${state.wallet.address}/txs`);
      for (const tx of txs.slice(0, 10)) {
        const mine = state.wallet.address;
        let delta = 0;
        for (const vout of tx.vout) if (vout.scriptpubkey_address === mine) delta += vout.value;
        for (const vin of tx.vin) if (vin.prevout && vin.prevout.scriptpubkey_address === mine) delta -= vin.prevout.value;
        const dir = delta >= 0 ? 'Received' : 'Sent';
        items.push(`<li><span>${dir} · <a href="https://mempool.space/testnet/tx/${tx.txid}" target="_blank" rel="noopener">${tx.txid.slice(0, 12)}…</a></span><strong>${delta >= 0 ? '+' : ''}${fmtSats(delta)} sats</strong></li>`);
      }
      if (!txs.length) items.push('<li class="muted">No on-chain transactions yet — fund this wallet from the faucet to try sending.</li>');
    } catch {
      items.push('<li class="muted">Could not load on-chain history.</li>');
    }
  } else if (!state.demoTxs.length) {
    items.push('<li class="muted">Demo mode: send or receive in demo to see activity here.</li>');
  }
  list.innerHTML = items.join('') || '<li class="muted">Nothing yet.</li>';
}

// ------------------------------------------------------------------- send
async function doSend() {
  const to = $('sendAddress').value.trim();
  const amount = Number($('sendAmount').value);
  const status = $('sendStatus');
  try {
    const { program } = W.decodeAddress(to);
    if (!program) throw new Error('bad address');
  } catch {
    setStatus(status, 'That address is not a valid testnet (tb1q…) address.', 'err');
    return;
  }
  if (!amount || amount < 546) {
    setStatus(status, 'Amount must be at least 546 sats (dust limit).', 'err');
    return;
  }
  const speed = $('sendFee').value;
  const rate = state.fees
    ? { slow: state.fees.economyFee, standard: state.fees.halfHourFee, fast: state.fees.fastestFee }[speed]
    : 5;
  $('btnSend').disabled = true;
  try {
    if (state.demo) {
      if (amount > DEMO_ONCHAIN_SATS - state.demoSpent) throw new Error('Demo balance is not enough for that amount.');
      state.demoSpent += amount;
      const id = `demo-${Date.now().toString(36)}`;
      state.demoTxs.unshift({ id, kind: 'send', amount: -amount, note: `Sent to ${to.slice(0, 14)}…`, time: Date.now() });
      setStatus(status, `Demo sent ${fmtSats(amount)} sats to ${to}. (Simulated — no real transaction.)`, 'ok');
      refreshBalance();
      renderActivity();
      return;
    }
    setStatus(status, 'Finding coins to spend…');
    const utxosRaw = await apiGet(`/address/${state.wallet.address}/utxo`);
    const utxos = utxosRaw.map((u) => ({
      txid: u.txid, vout: u.vout, value: u.value,
      scriptPubKey: W.addressToScriptPubKey(state.wallet.address),
    }));
    const total = utxos.reduce((s, u) => s + u.value, 0);
    if (total < amount) throw new Error(`Balance ${fmtSats(total)} sats is less than ${fmtSats(amount)} sats.`);
    setStatus(status, 'Building and signing the transaction…');
    const tx = W.buildTransaction({
      utxos, outputs: [{ address: to, value: amount }],
      privateKey: state.wallet.privateKey, publicKey: state.wallet.publicKey,
      feeRateSatPerVb: rate,
    });
    setStatus(status, `Broadcasting… (fee ~${fmtSats(tx.fee)} sats)`);
    const res = await fetch('/api/broadcast', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hex: tx.hex }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Broadcast failed (${res.status})`);
    setStatus(status, '', 'ok');
    status.innerHTML = `Sent ${fmtSats(amount)} sats! Transaction <a href="https://mempool.space/testnet/tx/${body.txid || tx.txid}" target="_blank" rel="noopener">${(body.txid || tx.txid).slice(0, 16)}…</a> — view it on the testnet explorer.`;
    refreshBalance();
    renderActivity();
  } catch (e) {
    setStatus(status, `Send failed: ${e.message}`, 'err');
  } finally {
    $('btnSend').disabled = false;
  }
}

// -------------------------------------------------------------- lightning
async function createInvoice() {
  const amount = Number($('lnAmount').value);
  const desc = $('lnDescription').value.trim() || 'KudiWallet payment';
  if (!amount || amount <= 0) { alert('Enter an amount in sats.'); return; }
  try {
    const paymentHash = W.randomPaymentHash();
    const invoice = W.createInvoice({
      amountSats: amount, description: desc, paymentHash,
      expirySeconds: 3600, nodePrivateKey: state.wallet.privateKey,
    });
    $('invoiceText').textContent = invoice;
    drawQr($('invoiceQr'), invoice);
    show($('invoiceOut'), true);
    state.lastInvoice = { invoice, amount, description: desc, paymentHash };
  } catch (e) {
    alert(`Could not create invoice: ${e.message}`);
  }
}

function decodePastedInvoice() {
  const raw = $('lnPaste').value.trim();
  const out = $('decodedInvoice');
  try {
    const d = W.decodeInvoice(raw);
    const expired = Date.now() / 1000 > d.timestamp + d.expirySeconds;
    out.innerHTML = `
      <p><strong>Amount:</strong> ${d.amountSats == null ? 'any' : fmtSats(d.amountSats) + ' sats'}</p>
      <p><strong>Description:</strong> ${d.description || '—'}</p>
      <p><strong>Payee node:</strong> <span class="mono">${(d.nodePubkey || '').slice(0, 20)}…</span></p>
      <p><strong>Expires:</strong> ${expired ? 'EXPIRED' : `in ${Math.max(0, Math.round(d.timestamp + d.expirySeconds - Date.now() / 1000))}s`}</p>
      <p class="muted">Signature verified against the payee node key. Paying a real invoice needs a
      Lightning node — in this MVP, use demo mode to simulate the payment.</p>`;
    show(out, true);
    state.decodedInvoice = d;
  } catch (e) {
    out.innerHTML = `<p class="error">Not a valid testnet invoice: ${e.message}</p>`;
    show(out, true);
  }
}

// -------------------------------------------------------------- onboarding
function wireOnboarding() {
  $('btnCreate').onclick = () => {
    show($('createPanel'), true);
    show($('importPanel'), false);
    const m = W.createMnemonic();
    state.pendingMnemonic = m;
    $('mnemonicWords').innerHTML = m.split(' ').map((w, i) => `<span><b>${i + 1}.</b>${w}</span>`).join('');
  };
  $('btnImport').onclick = () => {
    show($('importPanel'), true);
    show($('createPanel'), false);
  };
  $('btnDemoWallet').onclick = () => {
    state.demo = true;
    $('demoToggle').checked = true;
    show($('demoBanner'), true);
    openWallet(DEMO_MNEMONIC);
  };
  $('btnConfirmCreate').onclick = async () => {
    const p1 = $('createPassphrase').value;
    const p2 = $('createPassphrase2').value;
    const err = $('createError');
    if (p1.length < 4) { show(err, true); err.textContent = 'Choose a passphrase of at least 4 characters.'; return; }
    if (p1 !== p2) { show(err, true); err.textContent = 'The passphrases do not match.'; return; }
    await vaultSeal(state.pendingMnemonic, p1);
    openWallet(state.pendingMnemonic);
  };
  $('btnConfirmImport').onclick = async () => {
    const m = $('importMnemonic').value.trim().toLowerCase();
    const p = $('importPassphrase').value;
    const err = $('importError');
    if (!W.isValidMnemonic(m)) { show(err, true); err.textContent = 'That does not look like a valid 12-word recovery phrase.'; return; }
    if (p.length < 4) { show(err, true); err.textContent = 'Choose a passphrase of at least 4 characters.'; return; }
    await vaultSeal(m, p);
    openWallet(m);
  };
}

// ------------------------------------------------------------------- init
function wireApp() {
  wireOnboarding();
  $('demoToggle').onchange = (e) => {
    state.demo = e.target.checked;
    show($('demoBanner'), state.demo);
    if (state.wallet) {
      $('lnBalance').textContent = state.demo ? `${fmtSats(DEMO_LN_SATS - state.demoLnSpent)} sats (demo)` : '0 sats — create an invoice to receive';
      refreshBalance();
      renderActivity();
    }
  };
  $('btnRefresh').onclick = () => refreshAll();
  $('btnLock').onclick = () => {
    state.mnemonic = null; state.seed = null; state.wallet = null;
    show($('wallet'), false);
    show($('onboarding'), true);
    if (localStorage.getItem('kudiwallet.vault')) {
      const pass = prompt('Enter your spending passphrase to unlock:');
      if (pass) vaultOpen(pass).then((m) => { if (m) openWallet(m); else alert('Wrong passphrase.'); });
    }
  };
  $('btnCopyAddress').onclick = async () => {
    await navigator.clipboard.writeText(state.wallet.address);
    $('btnCopyAddress').textContent = 'Copied ✓';
    setTimeout(() => { $('btnCopyAddress').textContent = 'Copy address'; }, 1500);
  };
  $('sendAmount').oninput = () => {
    const a = Number($('sendAmount').value);
    $('sendFiatPreview').textContent = a > 0 ? fmtNgn(a) : '';
  };
  $('btnSend').onclick = doSend;
  $('btnCreateInvoice').onclick = createInvoice;
  $('btnCopyInvoice').onclick = async () => {
    await navigator.clipboard.writeText($('invoiceText').textContent);
    $('btnCopyInvoice').textContent = 'Copied ✓';
    setTimeout(() => { $('btnCopyInvoice').textContent = 'Copy invoice'; }, 1500);
  };
  $('btnPayInvoiceDemo').onclick = () => {
    if (!state.demo) { alert('Switch on demo mode to simulate paying this invoice. Real Lightning payment needs a node (next iteration).'); return; }
    if (!state.lastInvoice) return;
    const amt = state.lastInvoice.amount;
    if (amt > DEMO_LN_SATS - state.demoLnSpent) { alert('Demo Lightning balance is not enough.'); return; }
    state.demoLnSpent += amt;
    state.demoTxs.unshift({ id: `demo-ln-${Date.now().toString(36)}`, kind: 'ln', amount: -amt, note: `Lightning paid: ${state.lastInvoice.description}`, time: Date.now() });
    $('lnBalance').textContent = `${fmtSats(DEMO_LN_SATS - state.demoLnSpent)} sats (demo)`;
    alert(`Demo Lightning payment of ${fmtSats(amt)} sats sent. (Simulated — no real node.)`);
    renderActivity();
  };
  $('btnDecodeInvoice').onclick = decodePastedInvoice;
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tabpanel').forEach((p) => show(p, false));
      show($(`tab-${tab.dataset.tab}`), true);
      if (tab.dataset.tab === 'activity') renderActivity();
    };
  });
  // If a vault exists, offer unlock on load.
  if (localStorage.getItem('kudiwallet.vault')) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = 'A wallet is saved on this device — use “Import recovery phrase” with your 12 words to reopen it, or create a new one (this replaces the saved vault).';
    $('onboarding').appendChild(note);
  }
}

document.addEventListener('DOMContentLoaded', wireApp);
