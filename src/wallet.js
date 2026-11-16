// KudiWallet — crypto core (browser-safe, pure JS, no Node polyfills).
// Real cryptography: BIP39 mnemonics, BIP32 derivation, bech32 (segwit v0)
// addresses, P2WPKH transaction building + signing (BIP143), BOLT11
// invoice encode/decode. Nothing here is mocked: every byte is real.
// Network access (balances, broadcast) lives in the API layer, not here.
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

export const NETWORK = {
  name: 'Bitcoin Testnet',
  hrp: 'tb',
  bip32Coin: 1,
  purpose: 84,
};

const sha256d = (data) => sha256(sha256(data));
const hash160 = (data) => ripemd160(sha256(data));

const bytesEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const hexToBytes = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const concat = (...arrays) => {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
};

// ---------------------------------------------------------------------------
// Wallet (mnemonic / seed / keys / address)
// ---------------------------------------------------------------------------
export function createMnemonic() {
  return generateMnemonic(wordlist, 128); // 12 words
}

export function isValidMnemonic(mnemonic) {
  try { return validateMnemonic(mnemonic.trim().toLowerCase(), wordlist); } catch { return false; }
}

export function seedFromMnemonic(mnemonic, passphrase = '') {
  return mnemonicToSeedSync(mnemonic.trim().toLowerCase(), passphrase);
}

/** Derive the first receiving key: m/84'/1'/0'/0/0 (testnet native segwit). */
export function deriveWallet(seed, account = 0, index = 0) {
  const root = HDKey.fromMasterSeed(seed);
  const path = `m/${NETWORK.purpose}'/${NETWORK.bip32Coin}'/${account}'/0/${index}`;
  const child = root.derive(path);
  if (!child.privateKey || !child.publicKey) throw new Error('Derivation failed');
  return {
    path,
    privateKey: child.privateKey,
    publicKey: child.publicKey,
    wif: null, // WIF omitted on purpose: the mnemonic is the only backup.
  };
}

/** P2WPKH (native segwit) testnet address for a compressed public key. */
export function pubkeyToAddress(pubkey) {
  const program = hash160(pubkey);
  const words = [0, ...bech32.toWords(program)];
  return bech32.encode(NETWORK.hrp, words);
}

/** Decode a bech32 segwit address -> { version, program }. Throws on bad input. */
export function decodeAddress(address) {
  const { prefix, words } = bech32.decode(address);
  if (prefix !== NETWORK.hrp) throw new Error(`Expected a ${NETWORK.hrp} address`);
  if (words[0] !== 0) throw new Error('Only segwit v0 addresses are supported in this MVP');
  return { version: words[0], program: bech32.fromWords(words.slice(1)) };
}

/** scriptPubKey (hex) for a bech32 segwit v0 address. */
export function addressToScriptPubKey(address) {
  const { program } = decodeAddress(address);
  return bytesToHex(concat(new Uint8Array([0x00, 0x14]), program));
}

// ---------------------------------------------------------------------------
// P2WPKH transactions (BIP143 sighash, single signature)
// ---------------------------------------------------------------------------
function varint(n) {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  throw new Error('varint too large for this MVP');
}
function u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function u64le(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}
function serializeOutput(value, scriptHex) {
  const script = hexToBytes(scriptHex);
  return concat(u64le(value), varint(script.length), script);
}

/**
 * Build + sign a P2WPKH transaction spending testnet UTXOs.
 * utxos: [{ txid (display hex), vout, value (sats), scriptPubKey (hex) }]
 * outputs: [{ address (bech32), value (sats) }]
 * Returns { hex, txid, vsize } — real, broadcastable testnet transaction.
 */
export function buildTransaction({ utxos, outputs, privateKey, publicKey, feeRateSatPerVb = 5 }) {
  if (!utxos.length) throw new Error('No UTXOs to spend');
  const totalIn = utxos.reduce((s, u) => s + u.value, 0);
  const totalOut = outputs.reduce((s, o) => s + o.value, 0);
  // Rough vsize: 10.5 overhead + 68 per P2WPKH input + 31 per output.
  const estVsize = Math.ceil(10.5 + utxos.length * 68 + outputs.length * 31);
  const fee = Math.ceil(estVsize * feeRateSatPerVb);
  if (totalIn < totalOut + fee) {
    throw new Error(`Insufficient funds: have ${totalIn} sats, need ${totalOut + fee} (incl. ~${fee} fee)`);
  }
  const change = totalIn - totalOut - fee;
  const myAddress = pubkeyToAddress(publicKey);
  const allOutputs = [...outputs];
  if (change > 546) allOutputs.push({ address: myAddress, value: change }); // dust limit

  const version = 2;
  const locktime = 0;
  const sequence = 0xffffffff;
  const sighashType = 1; // SIGHASH_ALL

  // BIP143 preimages
  const prevouts = concat(...utxos.map((u) => concat(hexToBytes(u.txid).reverse(), u32le(u.vout))));
  const sequences = concat(...utxos.map(() => u32le(sequence)));
  const outs = concat(...allOutputs.map((o) => serializeOutput(o.value, addressToScriptPubKey(o.address))));
  const hashPrevouts = sha256d(prevouts);
  const hashSequence = sha256d(sequences);
  const hashOutputs = sha256d(outs);

  const pubkeyHash = hash160(publicKey);
  const scriptCode = concat(new Uint8Array([0x19, 0x76, 0xa9, 0x14]), pubkeyHash, new Uint8Array([0x88, 0xac]));

  const witnesses = [];
  for (const utxo of utxos) {
    const preimage = concat(
      u32le(version), hashPrevouts, hashSequence,
      concat(hexToBytes(utxo.txid).reverse(), u32le(utxo.vout)),
      scriptCode, u64le(utxo.value), u32le(sequence),
      hashOutputs, u32le(locktime), u32le(sighashType),
    );
    const sighash = sha256d(preimage);
    // prehash:false — the sighash IS the digest; noble defaults to hashing again.
    const sigBytes = secp256k1.sign(sighash, privateKey, { prehash: false }); // compact (r||s), low-S
    const der = secp256k1.Signature.fromBytes(sigBytes, 'compact').toBytes('der');
    const sigWithType = concat(der, new Uint8Array([sighashType]));
    witnesses.push([sigWithType, publicKey]);
  }

  // Serialize (segwit format: version, marker, flag, inputs, outputs, witnesses, locktime)
  const parts = [u32le(version), new Uint8Array([0x00, 0x01]), varint(utxos.length)];
  for (const utxo of utxos) {
    parts.push(concat(hexToBytes(utxo.txid).reverse(), u32le(utxo.vout), new Uint8Array([0x00]), u32le(sequence)));
  }
  parts.push(varint(allOutputs.length));
  for (const o of allOutputs) parts.push(serializeOutput(o.value, addressToScriptPubKey(o.address)));
  for (const w of witnesses) {
    parts.push(varint(w.length));
    for (const item of w) parts.push(concat(varint(item.length), item));
  }
  parts.push(u32le(locktime));
  const raw = concat(...parts);

  // txid = sha256d of the non-witness serialization
  const nonWitness = concat(
    u32le(version), varint(utxos.length),
    ...utxos.map((utxo) => concat(hexToBytes(utxo.txid).reverse(), u32le(utxo.vout), new Uint8Array([0x00]), u32le(sequence))),
    varint(allOutputs.length),
    ...allOutputs.map((o) => serializeOutput(o.value, addressToScriptPubKey(o.address))),
    u32le(locktime),
  );
  const txid = bytesToHex(sha256d(nonWitness).reverse());
  const vsize = Math.ceil((raw.length * 3 + nonWitness.length) / 4);
  return { hex: bytesToHex(raw), txid, vsize, fee, change };
}

// ---------------------------------------------------------------------------
// BOLT11 Lightning invoices (real encoding; settlement is demo — see README)
// ---------------------------------------------------------------------------
// --- bech32 without the 90-char BIP-173 cap -------------------------------
// BOLT11 invoices routinely exceed 90 chars; @scure/base enforces the cap,
// so invoices use this small spec-compliant implementation instead.
const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function bech32Polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= BECH32_GEN[i];
  }
  return chk;
}
function bech32HrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}
function bech32EncodeNoLimit(hrp, data) {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = bech32Polymod(values) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...checksum].map((d) => BECH32_CHARSET[d]).join('');
}
function bech32DecodeNoLimit(str) {
  const s = str.trim().toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1) throw new Error('Bad bech32 string');
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => {
    const i = BECH32_CHARSET.indexOf(c);
    if (i === -1) throw new Error(`Unknown bech32 char ${c}`);
    return i;
  });
  if (bech32Polymod([...bech32HrpExpand(hrp), ...data]) !== 1) throw new Error('Bad bech32 checksum');
  return { prefix: hrp, words: data.slice(0, -6) };
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

// 5-bit words -> bytes, padding the final partial byte with zero bits.
// This is what the BOLT11 reference does for the signing preimage; a plain
// fromWords() drops the trailing bits instead and produces a wrong hash.
function wordsToBytesPad(words) {
  const out = [];
  let acc = 0, nbits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    nbits += 5;
    while (nbits >= 8) {
      nbits -= 8;
      out.push((acc >> nbits) & 0xff);
    }
    acc &= (1 << nbits) - 1;
  }
  if (nbits > 0) out.push((acc << (8 - nbits)) & 0xff);
  return new Uint8Array(out);
}

function wordsToValue(words) {
  let v = 0n;
  for (const w of words) v = (v << 5n) | BigInt(w);
  return v;
}
function valueToWords(value, count) {
  const words = new Array(count).fill(0);
  let v = BigInt(value);
  for (let i = count - 1; i >= 0; i--) { words[i] = Number(v & 31n); v >>= 5n; }
  return words;
}
function bytesToWords(bytes) { return bech32.toWords(bytes); }

/**
 * Encode a real BOLT11 invoice, signed by the node key (65-byte signature,
 * as the spec requires — unsigned invoices are rejected by every decoder).
 * Amount in sats; description is human text. The node key is this wallet's
 * own key, so the invoice is genuinely payable to this wallet's node.
 * Returns the invoice string (lntb...).
 */
export function createInvoice({ amountSats, description, paymentHash, expirySeconds = 3600, nodePrivateKey }) {
  if (!amountSats || amountSats <= 0) throw new Error('Invoice amount must be > 0 sats');
  if (!nodePrivateKey) throw new Error('A node private key is required to sign the invoice');
  const nodePubkey = secp256k1.getPublicKey(nodePrivateKey, true);
  // Amount: use 'u' (micro-BTC) when divisible by 100 sats, else 'n' (nano-BTC).
  let amountPart;
  if (amountSats % 100 === 0) amountPart = `${amountSats / 100}u`;
  else amountPart = `${amountSats * 10}n`;
  const hrp = `ln${NETWORK.hrp}${amountPart}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const words = [...valueToWords(timestamp, 7)];

  const addField = (tagChar, dataWords) => {
    const tag = BECH32_CHARSET.indexOf(tagChar);
    words.push(tag, ...valueToWords(dataWords.length, 2), ...dataWords);
  };
  addField('p', bytesToWords(paymentHash)); // 52 words
  const descBytes = new TextEncoder().encode(description || 'KudiWallet payment');
  addField('d', bytesToWords(descBytes));
  if (expirySeconds) {
    // BOLT11 stores expiry as a base-32 integer (words directly), NOT bytes.
    const expWords = [];
    let e = Math.floor(expirySeconds);
    if (e === 0) expWords.push(0);
    while (e > 0) { expWords.unshift(e & 31); e = Math.floor(e / 32); }
    addField('x', expWords);
  }
  addField('n', bytesToWords(nodePubkey)); // 53 words

  // Sign: sha256(hrp bytes || data bytes). noble's 'recovered' format is
  // [recid, r, s]; BOLT11 wants [r, s, recid] — reorder the byte.
  const dataBytes = wordsToBytesPad(words);
  const msgHash = sha256(concat(new TextEncoder().encode(hrp), dataBytes));
  const sigRecovered = secp256k1.sign(msgHash, nodePrivateKey, { prehash: false, format: 'recovered' });
  const sigBytes = concat(sigRecovered.slice(1), new Uint8Array([sigRecovered[0]]));
  return bech32EncodeNoLimit(hrp, [...words, ...bytesToWords(sigBytes)]);
}

/** Decode a BOLT11 invoice -> { amountSats, paymentHash, description, expirySeconds, timestamp, nodePubkey }. Verifies the signature. */
export function decodeInvoice(invoice) {
  const { prefix, words } = bech32DecodeNoLimit(invoice);
  if (!prefix.startsWith('ln')) throw new Error('Not a Lightning invoice');
  const m = prefix.match(/^ln([a-z]+?)(\d+)([munp])?$/);
  if (!m) throw new Error('Bad invoice prefix');
  const network = m[1];
  if (network !== NETWORK.hrp) throw new Error(`Invoice is for network ${network}, expected ${NETWORK.hrp}`);
  let amountSats = null;
  if (m[2]) {
    const mult = { m: 1e5, u: 1e2, n: 0.1, p: 0.0001 }[m[3] || ''] ?? null;
    if (mult === null) throw new Error('Bad amount multiplier');
    amountSats = Math.round(Number(m[2]) * mult);
  }
  if (words.length < 104) throw new Error('Invoice too short for a signature');
  const dataWords = words.slice(0, -104);
  const sigWords = words.slice(-104);
  const sigBytes = bech32.fromWords(sigWords);
  if (sigBytes.length !== 65) throw new Error('Bad signature length');
  const timestamp = Number(wordsToValue(dataWords.slice(0, 7)));
  const out = { amountSats, timestamp, paymentHash: null, description: null, expirySeconds: 3600, nodePubkey: null };
  let i = 7;
  while (i + 3 <= dataWords.length) {
    const tag = BECH32_CHARSET[dataWords[i]];
    const len = Number(wordsToValue(dataWords.slice(i + 1, i + 3)));
    const data = dataWords.slice(i + 3, i + 3 + len);
    if (tag === 'p') out.paymentHash = bytesToHex(bech32.fromWords(data).slice(0, 32));
    else if (tag === 'd') out.description = new TextDecoder().decode(bech32.fromWords(data));
    else if (tag === 'x') {
      // Expiry is a base-32 integer in the words themselves (BOLT11).
      out.expirySeconds = data.reduce((n, w) => n * 32 + w, 0);
    }
    else if (tag === 'n') out.nodePubkey = bytesToHex(bech32.fromWords(data).slice(0, 33));
    i += 3 + len;
  }
  // Verify the signature and recover the signer (the node key). noble's
  // recoverPublicKey wants [recid, r, s]; BOLT11 stores [r, s, recid].
  const dataBytes = wordsToBytesPad(dataWords);
  const msgHash = sha256(concat(new TextEncoder().encode(prefix), dataBytes));
  const recovered = secp256k1.recoverPublicKey(
    concat(new Uint8Array([sigBytes[64]]), sigBytes.slice(0, 64)), msgHash, { prehash: false });
  const recoveredHex = bytesToHex(recovered);
  if (out.nodePubkey && out.nodePubkey !== recoveredHex) throw new Error('Invoice signature does not match the node key');
  out.nodePubkey = recoveredHex;
  return out;
}

export function randomPaymentHash() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

export { bytesToHex, hexToBytes, bytesEq };
