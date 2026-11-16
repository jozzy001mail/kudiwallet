// KudiWallet server — static host + proxy for public blockchain data.
// The server NEVER sees a recovery phrase or private key: all signing happens
// in the browser bundle. It only forwards public testnet data from
// mempool.space and a BTC price from CoinGecko.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const MEMPOOL = 'https://mempool.space/testnet/api';

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

let priceCache = { at: 0, data: { ngn: null, usd: null } };

// GET /api/price — BTC in NGN + USD (cached 60s).
app.get('/api/price', async (req, res) => {
  try {
    if (Date.now() - priceCache.at < 60000 && priceCache.data.usd) return res.json(priceCache.data);
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=ngn,usd', { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
    const j = await r.json();
    priceCache = { at: Date.now(), data: j.bitcoin };
    res.json(priceCache.data);
  } catch (e) {
    if (priceCache.data.usd) return res.json(priceCache.data);
    res.status(502).json({ error: `price unavailable: ${e.message}` });
  }
});

// GET /api/address/:addr | /utxo | /txs ; GET /api/v1/fees/recommended
// — passthrough to mempool.space testnet.
const passthrough = async (req, res, upstream) => {
  try {
    const r = await fetch(`${MEMPOOL}${upstream}`, { signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    res.status(r.status);
    res.set('Content-Type', r.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: `upstream unavailable: ${e.message}` });
  }
};
app.get('/api/address/:addr/utxo', (req, res) => passthrough(req, res, `/address/${req.params.addr}/utxo`));
app.get('/api/address/:addr/txs', (req, res) => passthrough(req, res, `/address/${req.params.addr}/txs`));
app.get('/api/address/:addr', (req, res) => passthrough(req, res, `/address/${req.params.addr}`));
app.get('/api/v1/fees/recommended', (req, res) => passthrough(req, res, '/v1/fees/recommended'));

// POST /api/broadcast { hex } — submit a signed testnet transaction.
app.post('/api/broadcast', async (req, res) => {
  const { hex } = req.body || {};
  if (!hex || typeof hex !== 'string' || !/^[0-9a-fA-F]+$/.test(hex)) {
    return res.status(400).json({ error: 'missing or invalid tx hex' });
  }
  try {
    const r = await fetch(`${MEMPOOL}/tx`, {
      method: 'POST', body: hex, headers: { 'Content-Type': 'text/plain' },
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: text.slice(0, 300) });
    res.json({ txid: text.trim() });
  } catch (e) {
    res.status(502).json({ error: `broadcast failed: ${e.message}` });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, network: 'bitcoin-testnet' }));

export default app;

// Only listen when run directly (node server.js). On Vercel the app is
// imported by api/index.js and served as a serverless function instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    console.log(`KudiWallet running at http://localhost:${PORT} (Bitcoin testnet)`);
  });
}
