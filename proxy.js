const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';
const GH = 'https://api.github.com';
const REPO = process.env.GITHUB_REPO || '';
const GTOKEN = process.env.GITHUB_TOKEN || '';
const HFILE = 'holdings.json';

app.get('/api/quote/:sym', async (req, res) => {
  try { const r = await fetch(`${FH}/quote?symbol=${req.params.sym}&token=${KEY}`); res.json(await r.json()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/metrics/:sym', async (req, res) => {
  try { const r = await fetch(`${FH}/stock/metric?symbol=${req.params.sym}&metric=all&token=${KEY}`); res.json(await r.json()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/target/:sym', async (req, res) => {
  try { const r = await fetch(`${FH}/stock/price-target?symbol=${req.params.sym}&token=${KEY}`); res.json(await r.json()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/profile/:sym', async (req, res) => {
  try { const r = await fetch(`${FH}/stock/profile2?symbol=${req.params.sym}&token=${KEY}`); res.json(await r.json()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/batch', async (req, res) => {
  const syms = (req.query.syms || '').split(',').filter(Boolean);
  try {
    const results = await Promise.all(syms.map(async s => {
      const r = await fetch(`${FH}/quote?symbol=${s}&token=${KEY}`);
      return { sym: s, ...(await r.json()) };
    }));
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/holdings', async (req, res) => {
  try {
    const r = await fetch(`${GH}/repos/${REPO}/contents/${HFILE}`, {
      headers: { Authorization: `token ${GTOKEN}`, Accept: 'application/vnd.github.v3+json' }
    });
    const data = await r.json();
    if (!data.content) return res.status(404).json({ error: 'file not found' });
    const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    res.json({ ...content, _sha: data.sha });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/holdings', async (req, res) => {
  try {
    const r = await fetch(`${GH}/repos/${REPO}/contents/${HFILE}`, {
      headers: { Authorization: `token ${GTOKEN}`, Accept: 'application/vnd.github.v3+json' }
    });
    const current = await r.json();
    const { _sha, ...data } = req.body;
    const encoded = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const u = await fetch(`${GH}/repos/${REPO}/contents/${HFILE}`, {
      method: 'PUT',
      headers: { Authorization: `token ${GTOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `update holdings ${new Date().toISOString()}`, content: encoded, sha: current.sha })
    });
    const result = await u.json();
    if (result.commit) res.json({ ok: true });
    else res.status(400).json({ error: result.message });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`✓ 代理已启动：http://localhost:${PORT}`));
