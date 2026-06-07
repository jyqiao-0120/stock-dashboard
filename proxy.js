const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());

const KEY = process.env.FINNHUB_KEY;
const FH = 'https://finnhub.io/api/v1';

// 单只股票实时报价
app.get('/api/quote/:sym', async (req, res) => {
  try {
    const r = await fetch(`${FH}/quote?symbol=${req.params.sym}&token=${KEY}`);
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 52周高/低、市值等基本面指标
app.get('/api/metrics/:sym', async (req, res) => {
  try {
    const r = await fetch(`${FH}/stock/metric?symbol=${req.params.sym}&metric=all&token=${KEY}`);
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 分析师目标价
app.get('/api/target/:sym', async (req, res) => {
  try {
    const r = await fetch(`${FH}/stock/price-target?symbol=${req.params.sym}&token=${KEY}`);
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 市场大盘（批量查询多个代码的报价）
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


// 股票基本信息（行业/板块）
app.get('/api/profile/:sym', async (req, res) => {
  try {
    const r = await fetch(`${FH}/stock/profile2?symbol=${req.params.sym}&token=${KEY}`);
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 持仓读取（从 GitHub）
app.use(express.json());
const GH = 'https://api.github.com';
const REPO = process.env.GITHUB_REPO || '';
const GTOKEN = process.env.GITHUB_TOKEN || '';
const HFILE = 'holdings.json';

app.get('/api/holdings', async (req, res) => {
  try {
    const r = await fetch(`${GH}/repos/${REPO}/contents/${HFILE}`, {
      headers: { Authorization: `token ${GTOKEN}`, Accept: 'application/vnd.github.v3+json' }
    });
    const data = await r.json();
    if(!data.content) return res.status(404).json({ error: 'file not found' });
    const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    res.json({ ...content, _sha: data.sha });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 持仓保存（写入 GitHub）
app.post('/api/holdings', async (req, res) => {
  try {
    const r = await fetch(`${GH}/repos/${REPO}/contents/${HFILE}`, {
      headers: { Authorization: `token ${GTOKEN}` }
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
    if(result.commit) res.json({ ok: true });
    else res.status(400).json({ error: result.message });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`✓ 代理已启动：http://localhost:${PORT}`));
