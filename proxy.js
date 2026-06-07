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

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`✓ 代理已启动：http://localhost:${PORT}`));
