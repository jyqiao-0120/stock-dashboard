// ============================================================
//  stock-proxy · Polygon + FMP data proxy + Claude analysis
//
//  Required server-side environment variables:
//    POLYGON_KEY        Polygon.io API key for quotes/snapshots
//    FMP_KEY            Financial Modeling Prep API key
//    ANTHROPIC_API_KEY  Claude API key
//    CLAUDE_MODEL       Optional, defaults to claude-3-5-sonnet-latest
//    GITHUB_TOKEN       GitHub token with contents read/write access
//    GITHUB_REPO        owner/repo, e.g. jyqiao-0120/stock-dashboard
//
//  Notes:
//    - Frontend never sees provider/API keys.
//    - Endpoints keep the old response fields where possible for compatibility.
//    - Each market-data response includes source/asOf/stale metadata.
// ============================================================
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const POLYGON_KEY = process.env.POLYGON_KEY || process.env.POLYGON_API_KEY || '';
const FMP_KEY = process.env.FMP_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.AI_KEY || '';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || process.env.AI_MODEL || 'claude-3-5-sonnet-latest';
const GH = 'https://api.github.com';
const REPO = process.env.GITHUB_REPO || '';
const GTOKEN = process.env.GITHUB_TOKEN || '';
const HFILE = 'holdings.json';
const POLYGON = 'https://api.polygon.io';
const FMP_V3 = 'https://financialmodelingprep.com/api/v3';
const FMP_V4 = 'https://financialmodelingprep.com/api/v4';
const FMP_STABLE = 'https://financialmodelingprep.com/stable';

function cleanSym(sym) {
  return String(sym || '').trim().toUpperCase().replace(/[^A-Z0-9.:\-\^]/g, '');
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[,%()]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function pct(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') return num(v.replace('%', ''));
  return num(v);
}

function round(v, d = 2) {
  const n = num(v);
  return n === null ? null : Number(n.toFixed(d));
}

function stampFromNs(ns) {
  const n = num(ns);
  if (!n) return null;
  return new Date(n / 1e6).toISOString();
}

function stampFromSec(sec) {
  const n = num(sec);
  if (!n) return null;
  return new Date(n * 1000).toISOString();
}

function staleFrom(asOf, maxHours = 96) {
  if (!asOf) return true;
  const ageHours = (Date.now() - new Date(asOf).getTime()) / 36e5;
  return !Number.isFinite(ageHours) || ageHours > maxHours;
}

function providerError(err) {
  return err && err.message ? err.message : String(err || 'unknown error');
}

async function getJSON(url, options = {}) {
  const timeoutMs = options.timeoutMs || 12000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = options.headers || {};
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!res.ok) {
      const msg = (json && (json.error || json.message || json['Error Message'])) || text.slice(0, 180) || res.statusText;
      const e = new Error(res.status + ' ' + msg);
      e.status = res.status;
      e.payload = json;
      throw e;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function okQuote(sym, data) {
  return Object.assign({
    sym,
    c: null,
    dp: null,
    price: null,
    ok: false,
    source: 'none',
    asOf: null,
    stale: true,
    delayed: null,
    warnings: [],
  }, data || {});
}

async function polygonQuote(sym) {
  if (!POLYGON_KEY) throw new Error('missing POLYGON_KEY');
  const s = cleanSym(sym);
  const j = await getJSON(POLYGON + '/v2/snapshot/locale/us/markets/stocks/tickers/' + encodeURIComponent(s) + '?apiKey=' + encodeURIComponent(POLYGON_KEY));
  const t = j && j.ticker ? j.ticker : {};
  const price = num(t.lastTrade && t.lastTrade.p) || num(t.min && t.min.c) || num(t.day && t.day.c) || num(t.prevDay && t.prevDay.c);
  const prevClose = num(t.prevDay && t.prevDay.c);
  const dp = num(t.todaysChangePerc);
  const asOf = stampFromNs(t.updated) || stampFromNs(t.lastTrade && t.lastTrade.t) || stampFromNs(t.lastQuote && t.lastQuote.t) || stampFromNs(t.min && t.min.t) || new Date().toISOString();
  if (price === null) throw new Error('Polygon returned no usable price');
  return okQuote(s, {
    ok: true,
    c: round(price),
    dp: dp === null && prevClose ? round((price - prevClose) / prevClose * 100) : round(dp),
    price: round(price),
    prevClose: round(prevClose),
    volume: num(t.day && t.day.v),
    source: 'Polygon Snapshot',
    provider: 'polygon',
    asOf,
    stale: staleFrom(asOf, 96),
    delayed: true,
    currency: 'USD',
    marketStatus: j.status || null,
  });
}

async function fmpQuote(sym) {
  if (!FMP_KEY) throw new Error('missing FMP_KEY');
  const s = cleanSym(sym);
  const j = await getJSON(FMP_V3 + '/quote/' + encodeURIComponent(s) + '?apikey=' + encodeURIComponent(FMP_KEY));
  const q = Array.isArray(j) ? j[0] : j;
  if (!q) throw new Error('FMP quote not found');
  const price = num(q.price);
  if (price === null) throw new Error('FMP returned no usable price');
  const asOf = stampFromSec(q.timestamp) || new Date().toISOString();
  return okQuote(s, {
    ok: true,
    c: round(price),
    dp: round(pct(q.changesPercentage !== undefined ? q.changesPercentage : q.changePercentage)),
    price: round(price),
    prevClose: round(q.previousClose),
    volume: num(q.volume),
    yearHigh: round(q.yearHigh),
    yearLow: round(q.yearLow),
    pe: round(q.pe),
    source: 'FMP Quote',
    provider: 'fmp',
    asOf,
    stale: staleFrom(asOf, 96),
    delayed: true,
    currency: 'USD',
  });
}

async function quoteFor(sym) {
  const s = cleanSym(sym);
  const warnings = [];
  try { return await polygonQuote(s); }
  catch (e) { warnings.push('Polygon: ' + providerError(e)); }
  try {
    const q = await fmpQuote(s);
    q.warnings = warnings;
    return q;
  } catch (e) {
    warnings.push('FMP: ' + providerError(e));
    return okQuote(s, { error: warnings.join(' | '), warnings });
  }
}

async function fmpProfile(sym) {
  if (!FMP_KEY) throw new Error('missing FMP_KEY');
  const s = cleanSym(sym);
  const j = await getJSON(FMP_V3 + '/profile/' + encodeURIComponent(s) + '?apikey=' + encodeURIComponent(FMP_KEY));
  const p = Array.isArray(j) ? j[0] : j;
  if (!p) throw new Error('FMP profile not found');
  return {
    ok: true,
    symbol: p.symbol || s,
    name: p.companyName || p.companyNameLong || p.symbol || s,
    sector: p.sector || null,
    industry: p.industry || null,
    finnhubIndustry: p.sector || p.industry || null,
    currency: p.currency || 'USD',
    exchange: p.exchangeShortName || p.exchange || null,
    beta: num(p.beta),
    source: 'FMP Profile',
  };
}

async function fmpMetrics(sym) {
  if (!FMP_KEY) throw new Error('missing FMP_KEY');
  const s = cleanSym(sym);
  const [quote, profile] = await Promise.all([
    fmpQuote(s).catch(e => ({ error: providerError(e) })),
    fmpProfile(s).catch(e => ({ error: providerError(e) })),
  ]);
  const metric = {
    '52WeekHigh': quote.yearHigh || null,
    '52WeekLow': quote.yearLow || null,
    beta: profile.beta || null,
    peNormalizedAnnual: quote.pe || null,
  };
  return { ok: true, metric, source: 'FMP Quote/Profile', quoteError: quote.error || null, profileError: profile.error || null };
}

async function fmpTarget(sym) {
  if (!FMP_KEY) throw new Error('missing FMP_KEY');
  const s = cleanSym(sym);
  const urls = [
    FMP_STABLE + '/price-target-consensus?symbol=' + encodeURIComponent(s) + '&apikey=' + encodeURIComponent(FMP_KEY),
    FMP_V4 + '/price-target-consensus?symbol=' + encodeURIComponent(s) + '&apikey=' + encodeURIComponent(FMP_KEY),
  ];
  let lastErr = '';
  for (const url of urls) {
    try {
      const j = await getJSON(url);
      const o = Array.isArray(j) ? j[0] : j;
      if (!o) continue;
      const mean = num(o.targetConsensus) || num(o.targetMean) || num(o.priceTargetAverage) || num(o.averageTargetPrice) || num(o.targetMedian);
      const median = num(o.targetMedian) || num(o.priceTargetMedian) || mean;
      if (mean !== null) {
        return {
          ok: true,
          targetMean: round(mean),
          targetMedian: round(median),
          targetHigh: round(o.targetHigh || o.priceTargetHigh),
          targetLow: round(o.targetLow || o.priceTargetLow),
          source: 'FMP Price Target Consensus',
        };
      }
    } catch (e) {
      lastErr = providerError(e);
    }
  }
  return { ok: false, targetMean: null, targetMedian: null, source: 'FMP Price Target Consensus', error: lastErr || 'target unavailable' };
}

async function fmpIndicator(sym, type) {
  if (!FMP_KEY) throw new Error('missing FMP_KEY');
  const s = cleanSym(sym);
  const url = FMP_V3 + '/technical_indicator/daily/' + encodeURIComponent(s) + '?period=14&type=' + encodeURIComponent(type) + '&apikey=' + encodeURIComponent(FMP_KEY);
  const j = await getJSON(url);
  const row = Array.isArray(j) ? j[0] : j;
  const val = row && (row[type] !== undefined ? row[type] : row.value);
  return round(val, type === 'rsi' ? 0 : 2);
}

async function fmpEarnings(sym) {
  if (!FMP_KEY) throw new Error('missing FMP_KEY');
  const s = cleanSym(sym);
  const today = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 150 * 864e5).toISOString().slice(0, 10);
  const j = await getJSON(FMP_STABLE + '/earnings-calendar?symbol=' + encodeURIComponent(s) + '&from=' + today + '&to=' + to + '&apikey=' + encodeURIComponent(FMP_KEY));
  const d = Array.isArray(j) && j.length ? j[0].date : null;
  return { earnDays: d ? Math.round((new Date(d) - new Date()) / 864e5) : null, date: d, source: 'FMP Earnings Calendar' };
}

function eventDateKey(d) {
  return d.toISOString().slice(0, 10);
}

function parseEventDate(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isFinite(d.getTime()) ? d : null;
}

function addEventDays(d, days) {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function normalizeEventWindow(fromValue) {
  const start = parseEventDate(fromValue) || parseEventDate(new Date().toISOString().slice(0, 10));
  const end = addEventDays(start, 30);
  return { start, end, from: eventDateKey(start), to: eventDateKey(end) };
}

function eventInWindow(dateKeyValue, start, end) {
  const d = parseEventDate(dateKeyValue);
  return !!d && d >= start && d <= end;
}

function eventShortDate(dateKeyValue) {
  return String(dateKeyValue || '').slice(5, 10);
}

const MARKET_MOVING_EARNINGS = [
  ['NVDA', '英伟达', 'AI芯片和纳指权重股，业绩与指引会影响半导体、AI算力和成长股风险偏好。', 5],
  ['MSFT', '微软', '云计算和AI资本开支风向标，会影响大型科技股估值。', 5],
  ['AAPL', '苹果', '全球消费电子和指数权重股，需求变化会影响大盘风险偏好。', 4],
  ['GOOGL', '谷歌', '广告、云和AI投入会影响互联网与AI交易主线。', 4],
  ['AMZN', '亚马逊', '消费、云计算和利润率指引会影响纳指和零售链条。', 4],
  ['META', 'Meta', '广告景气、AI投入和回购节奏会影响大型科技板块。', 4],
  ['TSLA', '特斯拉', '电动车需求、毛利率和自动驾驶叙事对高贝塔成长股有外溢影响。', 4],
  ['AVGO', '博通', 'AI网络芯片和半导体订单会影响AI硬件链条。', 4],
  ['AMD', 'AMD', 'AI加速器和CPU需求会影响半导体风险偏好。', 4],
  ['JPM', '摩根大通', '银行业信贷、净息差和经济周期信号会影响金融板块。', 4],
];

const MANUAL_MARKET_EVENTS = [
  {
    date: '2026-07-08',
    name: '美联储6月议息会议纪要',
    category: '美联储',
    type: '央行纪要',
    impact: 5,
    lean: 'neutral',
    note: '纪要会影响市场对利率路径、美债收益率、美元和科技股估值的判断。',
    source: 'Federal Reserve FOMC Calendar',
  },
  {
    date: '2026-07-28',
    name: '美联储7月议息会议开始',
    category: '美联储',
    type: '央行会议',
    impact: 5,
    lean: 'neutral',
    note: 'FOMC利率决议窗口会显著影响债券收益率、美元和风险资产波动。',
    source: 'Federal Reserve FOMC Calendar',
  },
  {
    date: '2026-07-29',
    name: '美联储7月利率决议',
    category: '美联储',
    type: '央行决议',
    impact: 5,
    lean: 'neutral',
    note: '声明措辞、投票分歧和主席表态会改变降息或加息预期。',
    source: 'Federal Reserve FOMC Calendar',
  },
];

function macroEventMeta(rawName, impact) {
  const raw = String(rawName || '');
  const s = raw.toLowerCase();
  const high = impact === 'High';
  const score = high ? 5 : 4;
  const hit = (regex, name, category, note, type) => regex.test(s) ? { name, category, note, type: type || category } : null;
  const found =
    hit(/non.?farm|payroll|nfp/, '美国非农就业数据', '就业数据', '就业强弱会改变美联储政策预期，并直接影响美债收益率和成长股估值。') ||
    hit(/unemployment rate|jobless rate/, '美国失业率', '就业数据', '失业率变化会影响经济软着陆和利率路径预期。') ||
    hit(/average hourly earnings|wage/, '美国平均时薪', '就业数据', '工资增速会影响服务通胀和美联储政策预期。') ||
    hit(/cpi|consumer price/, '美国CPI通胀数据', '通胀数据', '通胀高于预期通常推高利率并压低估值，低于预期通常利好风险资产。') ||
    hit(/pce|personal consumption expenditures/, '美国PCE通胀数据', '通胀数据', 'PCE是美联储重点观察的通胀口径，会影响降息或加息预期。') ||
    hit(/ppi|producer price/, '美国PPI通胀数据', '通胀数据', '生产端通胀会影响企业利润率和未来CPI/PCE预期。') ||
    hit(/fomc.*minutes|minutes.*fomc|federal open market committee minutes/, '美联储会议纪要', '美联储', '纪要会透露政策分歧和风险评估，影响利率与美元。', '央行纪要') ||
    hit(/fomc|fed interest rate|interest rate decision|federal funds rate|rate decision/, '美联储利率决议/声明', '美联储', '利率决议和声明措辞会直接影响美债收益率、美元和股票估值。', '央行决议') ||
    hit(/powell|warsh|fed chair|chairman|testimony/, '美联储主席讲话/国会证词', '美联储', '主席表态会影响市场对政策反应函数和沟通方式的判断。', '央行讲话') ||
    hit(/gdp|gross domestic product/, '美国GDP数据', '增长数据', '增长超预期可能推高利率预期，低于预期可能加重衰退担忧。') ||
    hit(/retail sales/, '美国零售销售', '消费数据', '消费韧性会影响盈利预期、通胀预期和美联储政策路径。') ||
    hit(/ism manufacturing|ism.*manufacturing pmi/, '美国ISM制造业PMI', '景气数据', '制造业景气变化会影响周期股、美元和增长预期。') ||
    hit(/ism services|ism.*services pmi|ism.*non-manufacturing/, '美国ISM服务业PMI', '景气数据', '服务业景气和价格分项会影响通胀与增长判断。') ||
    hit(/beige book/, '美联储褐皮书', '美联储', '褐皮书汇总地区经济和通胀线索，会影响下次议息预期。', '央行报告');
  if (!found) return null;
  return {
    name: found.name,
    category: found.category,
    type: found.type,
    impact: score,
    lean: 'neutral',
    note: found.note,
    rawName: raw,
  };
}

async function fmpEconomicEvents(fromKey, toKey) {
  if (!FMP_KEY) return { events: [], error: 'missing FMP_KEY' };
  const j = await getJSON(FMP_STABLE + '/economic-calendar?from=' + encodeURIComponent(fromKey) + '&to=' + encodeURIComponent(toKey) + '&apikey=' + encodeURIComponent(FMP_KEY));
  const events = [];
  for (const e of Array.isArray(j) ? j : []) {
    if (e.country !== 'US') continue;
    if (e.impact !== 'High' && e.impact !== 'Medium') continue;
    const meta = macroEventMeta(e.event, e.impact);
    if (!meta) continue;
    const d = String(e.date || '').slice(0, 10);
    if (!d) continue;
    events.push({
      date: d,
      dateLabel: eventShortDate(d),
      source: 'FMP Economic Calendar',
      providerName: e.event || '',
      actual: e.actual,
      previous: e.previous,
      estimate: e.estimate,
      ...meta,
    });
  }
  return { events };
}

async function fmpMajorEarningsEvents(fromKey, toKey) {
  if (!FMP_KEY) return { events: [], error: 'missing FMP_KEY' };
  const events = [];
  await Promise.all(MARKET_MOVING_EARNINGS.map(async ([sym, cn, reason, impact]) => {
    try {
      const j = await getJSON(FMP_STABLE + '/earnings-calendar?symbol=' + encodeURIComponent(sym) + '&from=' + encodeURIComponent(fromKey) + '&to=' + encodeURIComponent(toKey) + '&apikey=' + encodeURIComponent(FMP_KEY));
      const row = Array.isArray(j) ? j.find(x => x && x.date) : null;
      if (!row) return;
      const d = String(row.date || '').slice(0, 10);
      if (!d) return;
      events.push({
        date: d,
        dateLabel: eventShortDate(d),
        name: cn + '（' + sym + '）财报',
        category: '重点财报',
        type: '财报',
        impact,
        lean: 'neutral',
        note: reason,
        source: 'FMP Earnings Calendar',
        symbol: sym,
      });
    } catch (e) {
      console.warn('major earnings event failed', sym, providerError(e));
    }
  }));
  return { events };
}

function manualMarketEvents(start, end) {
  return MANUAL_MARKET_EVENTS
    .filter(e => eventInWindow(e.date, start, end))
    .map(e => ({ ...e, dateLabel: eventShortDate(e.date) }));
}

function dedupeMarketEvents(events) {
  const seen = new Set();
  return events
    .filter(e => e && e.date && e.name)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (b.impact || 0) - (a.impact || 0))
    .filter(e => {
      const key = e.date + '|' + e.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 18);
}

function statusPayload() {
  const missing = [];
  if (!POLYGON_KEY) missing.push('POLYGON_KEY');
  if (!FMP_KEY) missing.push('FMP_KEY');
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!REPO) missing.push('GITHUB_REPO');
  if (!GTOKEN) missing.push('GITHUB_TOKEN');
  return {
    ok: missing.length === 0,
    missing,
    sources: {
      quotePrimary: POLYGON_KEY ? 'Polygon Snapshot' : 'missing',
      quoteFallback: FMP_KEY ? 'FMP Quote' : 'missing',
      fundamentals: FMP_KEY ? 'FMP' : 'missing',
      technicals: FMP_KEY ? 'FMP Technical Indicator' : 'missing',
      events: FMP_KEY ? 'FMP Economic/Earnings Calendar + curated Fed schedule' : 'curated Fed schedule only; missing FMP_KEY',
      ai: ANTHROPIC_API_KEY ? 'Claude API' : 'missing',
      holdings: REPO && GTOKEN ? 'GitHub Contents API' : 'missing',
    },
    now: new Date().toISOString(),
  };
}

app.get('/api/status', (req, res) => res.json(statusPayload()));

app.get('/api/quote/:sym', async (req, res) => {
  try { res.json(await quoteFor(req.params.sym)); }
  catch (e) { res.status(500).json(okQuote(cleanSym(req.params.sym), { error: providerError(e) })); }
});

app.get('/api/batch', async (req, res) => {
  const syms = String(req.query.syms || '').split(',').map(cleanSym).filter(Boolean).slice(0, 30);
  const out = await Promise.all(syms.map(quoteFor));
  res.json(out);
});

app.get('/api/profile/:sym', async (req, res) => {
  try { res.json(await fmpProfile(req.params.sym)); }
  catch (e) { res.json({ ok: false, symbol: cleanSym(req.params.sym), finnhubIndustry: null, sector: null, currency: null, source: 'FMP Profile', error: providerError(e) }); }
});

app.get('/api/metrics/:sym', async (req, res) => {
  try { res.json(await fmpMetrics(req.params.sym)); }
  catch (e) { res.json({ ok: false, metric: {}, source: 'FMP Quote/Profile', error: providerError(e) }); }
});

app.get('/api/target/:sym', async (req, res) => {
  try { res.json(await fmpTarget(req.params.sym)); }
  catch (e) { res.json({ ok: false, targetMean: null, targetMedian: null, source: 'FMP Price Target Consensus', error: providerError(e) }); }
});

app.get('/api/rsi/:sym', async (req, res) => {
  try { res.json({ rsi: await fmpIndicator(req.params.sym, 'rsi'), source: 'FMP RSI' }); }
  catch (e) { res.json({ rsi: null, source: 'FMP RSI', error: providerError(e) }); }
});

app.get('/api/atr/:sym', async (req, res) => {
  try { res.json({ atr: await fmpIndicator(req.params.sym, 'atr'), source: 'FMP ATR' }); }
  catch (e) { res.json({ atr: null, source: 'FMP ATR', error: providerError(e) }); }
});

app.get('/api/vix', async (req, res) => {
  const attempts = ['^VIX', 'VIX'];
  const errors = [];
  for (const sym of attempts) {
    try {
      const q = await fmpQuote(sym);
      if (q.c !== null) return res.json({ vix: q.c, source: 'FMP Quote ' + sym, asOf: q.asOf, stale: q.stale });
    } catch (e) { errors.push(sym + ': ' + providerError(e)); }
  }
  res.json({ vix: null, source: 'FMP Quote', error: errors.join(' | ') });
});

app.get('/api/earnings/:sym', async (req, res) => {
  try { res.json(await fmpEarnings(req.params.sym)); }
  catch (e) { res.json({ earnDays: null, date: null, source: 'FMP Earnings Calendar', error: providerError(e) }); }
});

app.get('/api/events', async (req, res) => {
  const win = normalizeEventWindow(req.query.from);
  const errors = [];
  const sources = ['Curated Fed Schedule'];
  const chunks = [manualMarketEvents(win.start, win.end)];
  try {
    const macro = await fmpEconomicEvents(win.from, win.to);
    if (macro.error) errors.push('economic: ' + macro.error);
    else sources.push('FMP Economic Calendar');
    chunks.push(macro.events || []);
  } catch (e) {
    errors.push('economic: ' + providerError(e));
  }
  try {
    const earnings = await fmpMajorEarningsEvents(win.from, win.to);
    if (earnings.error) errors.push('earnings: ' + earnings.error);
    else sources.push('FMP Earnings Calendar');
    chunks.push(earnings.events || []);
  } catch (e) {
    errors.push('earnings: ' + providerError(e));
  }
  res.json({
    events: dedupeMarketEvents(chunks.flat()),
    window: { from: win.from, to: win.to },
    source: sources.join(' + '),
    error: errors.length ? errors.join(' | ') : undefined,
  });
});

app.post('/api/analyze', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: 'missing ANTHROPIC_API_KEY' });
    const data = req.body || {};
    const sys = '你是严谨的投资组合助手。只根据用户提供的真实数据做分析；如果字段缺失、延迟、过期或来源不明，必须明确降低置信度，不要编造任何数字、新闻或价格。'
      + '输出必须是严格 JSON，不要 markdown，不要解释。结构：'
      + '{"position":整数0-100,"panic":整数0-100,"stance":"一句话总体判断","commentary":"3-4句中文综合点评，说明数据质量与仓位原因","actions":["可执行行动1"],"dataIssues":["数据问题1"]}。'
      + '语气克制，强调这是工具化参考，不构成投资建议。';
    const user = '以下是我的组合、市场数据和数据质量信息(JSON)：\n' + JSON.stringify(data, null, 2)
      + '\n请综合 VIX、事件日历、持仓现价/目标价/RSI/止损/盈亏/集中度，并优先说明缺失或过期数据对结论的影响。';
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1200,
        temperature: 0.2,
        system: sys,
        messages: [{ role: 'user', content: user }],
      }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: j.error && j.error.message ? j.error.message : JSON.stringify(j) });
    const text = (j.content || []).map(b => b.text || '').join('') || JSON.stringify(j);
    const clean = text.replace(/\x60\x60\x60json|\x60\x60\x60/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { parsed = { position: null, panic: null, stance: 'AI 返回解析失败', commentary: clean.slice(0, 300), actions: [], dataIssues: ['Claude response was not valid JSON'] }; }
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: providerError(e) });
  }
});

function ghHeaders(extra = {}) {
  const h = Object.assign({
    Accept: 'application/vnd.github+json',
    'User-Agent': 'stock-dashboard',
  }, extra);
  if (GTOKEN) h.Authorization = 'Bearer ' + GTOKEN;
  return h;
}

function validateHoldings(data) {
  const out = {
    cash: num(data && data.cash) || 0,
    positions: [],
    watchlist: [],
    currency: (data && data.currency) || 'USD',
    updatedAt: new Date().toISOString(),
  };
  if (Array.isArray(data && data.positions)) {
    out.positions = data.positions.map(p => ({
      sym: cleanSym(p.sym || p.symbol),
      name: String(p.name || p.sym || '').trim(),
      shares: num(p.shares) || 0,
      cost: num(p.cost) || 0,
      currency: String(p.currency || 'USD').toUpperCase(),
    })).filter(p => p.sym && p.shares >= 0 && p.cost >= 0);
  }
  if (Array.isArray(data && data.watchlist)) {
    out.watchlist = data.watchlist.map(w => ({
      sym: cleanSym(w.sym || w.symbol),
      name: String(w.name || w.sym || '').trim(),
      note: String(w.note || '').trim(),
      buy: num(w.buy),
      currency: String(w.currency || 'USD').toUpperCase(),
    })).filter(w => w.sym);
  }
  return out;
}

app.get('/api/holdings', async (req, res) => {
  try {
    if (!REPO) return res.status(503).json({ error: 'missing GITHUB_REPO' });
    const data = await getJSON(GH + '/repos/' + REPO + '/contents/' + HFILE + '?t=' + Date.now(), { headers: ghHeaders() });
    if (!data.content) return res.status(404).json({ error: 'file not found' });
    res.json(Object.assign({}, JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8')), { _sha: data.sha, source: 'GitHub Contents API' }));
  } catch (e) {
    res.status(500).json({ error: providerError(e) });
  }
});

app.post('/api/holdings', async (req, res) => {
  try {
    if (!REPO || !GTOKEN) return res.status(503).json({ error: 'missing GITHUB_REPO or GITHUB_TOKEN' });
    const data = validateHoldings(req.body || {});
    const cur = await getJSON(GH + '/repos/' + REPO + '/contents/' + HFILE, { headers: ghHeaders() });
    const r = await fetch(GH + '/repos/' + REPO + '/contents/' + HFILE, {
      method: 'PUT',
      headers: ghHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        message: 'update holdings ' + data.updatedAt,
        content: Buffer.from(JSON.stringify(data, null, 2) + '\n').toString('base64'),
        sha: cur.sha,
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.commit) return res.status(r.status || 400).json({ error: j.message || 'GitHub update failed' });
    res.json({ ok: true, sha: j.content && j.content.sha, updatedAt: data.updatedAt });
  } catch (e) {
    res.status(500).json({ error: providerError(e) });
  }
});

const PORT = process.env.PORT || 8787;
const server = app.listen(PORT, () => console.log('stock proxy listening on http://localhost:' + PORT));
server.on('error', err => {
  console.error('stock proxy failed to start:', err.message);
  process.exitCode = 1;
});
