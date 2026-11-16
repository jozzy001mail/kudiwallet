// Cross-validation tests for the crypto core. Run: node test/vectors.test.js
// Exits non-zero on any failure. Uses bitcoinjs-lib + bolt11 (dev deps) as
// independent references — our code must agree with them exactly.
import assert from 'node:assert';
import * as bjs from 'bitcoinjs-lib';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import bolt11 from 'bolt11';
const bip32 = BIP32Factory(ecc);
import { mnemonicToSeedSync } from '@scure/bip39';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import * as W from '../src/wallet.js';

let pass = 0;
const jobs = [];
const ok = (name, fn) => {
  jobs.push((async () => { await fn(); pass++; console.log('  ok -', name); })());
};

// --- BIP39 known vector: entropy 0x00*16 -> 11x abandon + about ----------
ok('BIP39: known mnemonic validates', () => {
  const m = 'abandon '.repeat(11) + 'about';
  assert.strictEqual(W.isValidMnemonic(m), true);
  assert.strictEqual(W.isValidMnemonic('abandon abandon'), false);
});

// --- Address derivation must match bitcoinjs-lib exactly --------------------
ok('BIP32/BIP84: our tb1q address matches bitcoinjs-lib', () => {
  const mnemonic = 'abandon '.repeat(11) + 'about';
  const seed = mnemonicToSeedSync(mnemonic);
  const ours = W.deriveWallet(seed);
  const address = W.pubkeyToAddress(ours.publicKey);
  assert.ok(address.startsWith('tb1q'), address);

  const root = bip32.fromSeed(Buffer.from(seed), bjs.networks.testnet);
  const child = root.derivePath("m/84'/1'/0'/0/0");
  const ref = bjs.payments.p2wpkh({ pubkey: child.publicKey, network: bjs.networks.testnet }).address;
  assert.strictEqual(address, ref, `ours ${address} vs ref ${ref}`);
  assert.strictEqual(Buffer.from(ours.publicKey).toString('hex'), Buffer.from(child.publicKey).toString('hex'));
});

// --- Address decode round-trip ----------------------------------------------
ok('bech32: decode(address) recovers the same hash160', () => {
  const mnemonic = W.createMnemonic();
  const seed = W.seedFromMnemonic(mnemonic);
  const w = W.deriveWallet(seed);
  const address = W.pubkeyToAddress(w.publicKey);
  const { program } = W.decodeAddress(address);
  const expected = ripemd160(sha256(w.publicKey));
  assert.deepStrictEqual(Buffer.from(program), Buffer.from(expected));
  assert.throws(() => W.decodeAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), /Expected a tb/);
});

// --- Transaction: build, verify signature, parse with bitcoinjs-lib ---------
ok('P2WPKH tx: signature verifies and bitcoinjs-lib parses it', async () => {
  const mnemonic = 'abandon '.repeat(11) + 'about';
  const seed = mnemonicToSeedSync(mnemonic);
  const w = W.deriveWallet(seed);
  const myAddress = W.pubkeyToAddress(w.publicKey);
  const scriptPubKey = W.addressToScriptPubKey(myAddress);
  // Fake-but-well-formed UTXO (not on chain; signature math is what we test)
  const fakeTxid = '11'.repeat(32);
  const utxos = [{ txid: fakeTxid, vout: 0, value: 100000, scriptPubKey }];
  const outputs = [{ address: myAddress, value: 50000 }];
  const tx = W.buildTransaction({ utxos, outputs, privateKey: w.privateKey, publicKey: w.publicKey, feeRateSatPerVb: 5 });
  assert.ok(tx.hex.length > 100, 'tx hex looks real');
  assert.ok(/^[0-9a-f]{64}$/.test(tx.txid), 'txid is 32-byte hex');
  assert.ok(tx.fee > 0 && tx.fee < 5000, `fee sane: ${tx.fee}`);

  // Independent parse: bitcoinjs-lib must read our raw tx and agree.
  const parsed = bjs.Transaction.fromHex(tx.hex);
  assert.strictEqual(parsed.ins.length, 1);
  assert.strictEqual(parsed.outs.length, 2); // payment + change
  assert.strictEqual(parsed.outs[0].value, 50000n); // bitcoinjs-lib v7 uses BigInt values
  assert.strictEqual(parsed.getId(), tx.txid);

  // Signature must verify against the BIP143 sighash we signed.
  // NOTE: hashForWitnessV0 takes the P2PKH *scriptCode template* for a
  // P2WPKH input, not the raw prevout script — pass the template here.
  const { ripemd160: ripemd160b } = await import('@noble/hashes/legacy.js');
  const { sha256: sha256b } = await import('@noble/hashes/sha2.js');
  const scriptCode = Buffer.concat([
    Buffer.from('76a914', 'hex'),
    Buffer.from(ripemd160b(sha256b(w.publicKey))),
    Buffer.from('88ac', 'hex'),
  ]);
  const sighash = parsed.hashForWitnessV0(0, scriptCode, 100000n, bjs.Transaction.SIGHASH_ALL);
  const witness = parsed.ins[0].witness;
  const sigDer = witness[0].slice(0, -1); // strip sighash byte
  const okSig = secp256k1.verify(Buffer.from(sigDer), sighash, w.publicKey, { format: 'der', prehash: false });
  assert.strictEqual(okSig, true, 'signature verifies under bitcoinjs-lib sighash');
  assert.ok(tx.change > 0, 'change output present');
});

// --- BOLT11: our encoder must agree with the bolt11 package ----------------
ok('BOLT11: our invoice decodes in the bolt11 package and round-trips', () => {
  const mnemonic = 'abandon '.repeat(11) + 'about';
  const seed = mnemonicToSeedSync(mnemonic);
  const w = W.deriveWallet(seed);
  const paymentHash = W.randomPaymentHash();
  const invoice = W.createInvoice({
    amountSats: 2500,
    description: 'KudiWallet test payment',
    paymentHash,
    expirySeconds: 3600,
    nodePrivateKey: w.privateKey,
  });
  assert.ok(invoice.startsWith('lntb25u'), invoice);
  const decoded = bolt11.decode(invoice);
  assert.strictEqual(decoded.satoshis, 2500);
  assert.strictEqual(decoded.tags.find((t) => t.tagName === 'payment_hash').data, Buffer.from(paymentHash).toString('hex'));
  assert.strictEqual(decoded.tags.find((t) => t.tagName === 'description').data, 'KudiWallet test payment');
  assert.strictEqual(decoded.tags.find((t) => t.tagName === 'expire_time').data, 3600);
  assert.strictEqual(decoded.payeeNodeKey, Buffer.from(w.publicKey).toString('hex'));

  // Our decoder must agree with the reference decoder.
  const ours = W.decodeInvoice(invoice);
  assert.strictEqual(ours.amountSats, 2500);
  assert.strictEqual(ours.paymentHash, Buffer.from(paymentHash).toString('hex'));
  assert.strictEqual(ours.description, 'KudiWallet test payment');
  assert.strictEqual(ours.expirySeconds, 3600);
  assert.strictEqual(ours.nodePubkey, Buffer.from(w.publicKey).toString('hex'));

  // And a reference-encoded invoice must decode in ours.
  const refUnsigned = bolt11.encode({
    satoshis: 150,
    timestamp: Math.floor(Date.now() / 1000),
    network: { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4, validWitnessVersions: [0, 1] },
    tags: [
      { tagName: 'payment_hash', data: Buffer.from(paymentHash).toString('hex') },
      { tagName: 'description', data: 'ref check' },
    ],
  });
  const refInvoice = bolt11.sign(refUnsigned, Buffer.from(w.privateKey).toString('hex')).paymentRequest;
  const refDecoded = W.decodeInvoice(refInvoice);
  assert.strictEqual(refDecoded.amountSats, 150);
  assert.strictEqual(refDecoded.description, 'ref check');
});

await Promise.all(jobs);
console.log(`\nAll ${pass} cross-validation checks passed.`);
