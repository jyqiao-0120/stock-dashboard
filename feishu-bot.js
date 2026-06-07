/* =====================================================================
 * JY's Stock Dashboard · 飞书推送机器人 (feishu-bot.js)
 * ---------------------------------------------------------------------
 * 作用：定时拉取实时行情 → 复用看板的计算逻辑 → 触发条件时推送到飞书
 * 运行环境：Node.js 18+（自带 fetch）
 *
 * 快速开始：
 *   1) 安装 Node.js 18 以上
 *   2) 在本文件夹执行：  npm init -y && npm install node-cron
 *   3) 填好下面 ENV 里的 3 个值（Finnhub key、飞书 webhook、可选签名密钥）
 *   4) 维护 HOLDINGS（你的持仓）与 MARKET（市场参数，后续可改为自动拉取）
 *   5) 运行：  node feishu-bot.js          （立即推一次 + 按计划定时推）
 *      或只测一次： node feishu-bot.js --once
 * ===================================================================== */

const crypto = require('crypto');
let cron;
try { cron = require('node-cron'); } catch (e) { /* 没装也能用 --once 跑一次 */ }

/* ---------- 环境配置：把下面三个值换成你自己的 ---------- */
const ENV = {
  FINNHUB_KEY: process.env.FINNHUB_KEY || 'd6s1sm9r01qpss2i259gd6s1sm9r01qpss2i25a0',     // https://finnhub.io 免费注册
  FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK || 'https://open.feishu.cn/open-apis/bot/v2/hook/83005427-11e7-42c9-b8d0-abb4c425c98b',
  FEISHU_SECRET: process.env.FEISHU_SECRET || 'WCddCIIW1mKxg0lA19aU2e',                 // 飞书机器人若开了“签名校验”才填，否则留空
  CRON: process.env.CRON || '30 21 * * 1-5',                      // 默认北京时间周一到周五 21:30（约美股开盘后）
};

/* ---------- 你手动维护的持仓（代码 + 股数 + 成本）。其余字段自动拉取 ---------- */
const HOLDINGS = [
  { sym: 'NVDA', shares: 140, cost: 96.2 },
  { sym: 'AAPL', shares: 90,  cost: 182.0 },
  { sym: 'MSFT', shares: 38,  cost: 388.5 },
  { sym: 'XOM',  shares: 80,  cost: 104.0 },
  { sym: 'PLTR', shares: 600, cost: 24.8 },
];
const CASH = 18400;

/* ---------- 计算参数（与看板 CONFIG 保持一致，可调） ---------- */
const CONFIG = {
  positionWeights: { trend: 0.30, valuation: 0.20, sentiment: 0.25, eventRisk: 0.25 },
  positionFloor: 10, positionCap: 100,
  trailStopPct: 0.15, atrStopK: 2.5,
  rsiOverbought: 70, rsiOversold: 42,
  addUpsidePct: 15, trimUpsidePct: 3, earningsWarnDays: 3,
  vixTiers: [
    { min: 30, label: '一档·轻度恐慌', deploy: 25 },
    { min: 40, label: '二档·明显恐慌', deploy: 50 },
    { min: 50, label: '三档·极端恐慌', deploy: 100 },
  ],
};

/* ---------- 市场参数：示例先写死，第 4 步说明如何改为自动拉取 ---------- */
const MARKET = { vix: 21.8, fearGreed: 38, breadthAbove200: 46, spx1mReturn: -2.1, erp: 2.9, erpHistAvg: 3.2 };

/* =====================================================================
 * 数据获取（Finnhub）
 * ===================================================================== */
const FH = 'https://finnhub.io/api/v1';
async function fhGet(path) {
  const url = `${FH}${path}${path.includes('?') ? '&' : '?'}token=${ENV.FINNHUB_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Finnhub ${r.status} on ${path}`);
  return r.json();
}

// 实时报价：返回 { price, chgPct }
async function getQuote(sym) {
  try {
    const q = await fhGet(`/quote?symbol=${sym}`);            // { c, d, dp, h, l, o, pc }
    return { price: q.c, chgPct: q.dp };
  } catch (e) { console.warn('quote 失败', sym, e.message); return { price: 0, chgPct: 0 }; }
}

// 52周高 / 目标价 / RSI：见下面注释，先用兜底默认（接上对应接口即可自动）
async function getMetrics(sym) {
  let high = 0, target = 0, rsi = 50;
  try {
    const m = await fhGet(`/stock/metric?symbol=${sym}&metric=all`);
    high = m.metric?.['52WeekHigh'] || 0;
  } catch (e) {}
  try {
    const t = await fhGet(`/stock/price-target?symbol=${sym}`);
    target = t.targetMean || 0;
  } catch (e) {}
  // RSI 需技术指标接口 /indicator（付费档），先默认 50；ATR 同理可用 (high-low) 估算
  return { high, target, rsi };
}

// VIX：免费档指数行情常受限，取不到就用 MARKET.vix 兜底
async function getVix() {
  try { const q = await fhGet(`/quote?symbol=VIX`); if (q.c) return q.c; } catch (e) {}
  return MARKET.vix;
}

/* =====================================================================
 * 计算逻辑（从看板移植，纯函数）
 * ===================================================================== */
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function trendScore(m) { return 0.5 * m.breadthAbove200 + 0.5 * clamp(50 + m.spx1mReturn * 8, 0, 100); }
function valuationScore(m) { return clamp(50 + ((m.erp - m.erpHistAvg) / 1.5) * 30, 0, 100); }
function sentimentScore(m) { return 0.6 * clamp(100 - (m.vix - 12) * 4, 0, 100) + 0.4 * m.fearGreed; }
function eventRiskScore() { return 60; } // 简化：接事件日历后按未来14天高影响事件强度计算

function computePosition(m) {
  const s = { trend: trendScore(m), valuation: valuationScore(m), sentiment: sentimentScore(m), eventRisk: eventRiskScore() };
  const w = CONFIG.positionWeights;
  const raw = s.trend * w.trend + s.valuation * w.valuation + s.sentiment * w.sentiment + s.eventRisk * w.eventRisk;
  return clamp(Math.round(raw / 5) * 5, CONFIG.positionFloor, CONFIG.positionCap);
}

function vixTier(vix) {
  let t = null;
  for (const x of CONFIG.vixTiers) if (vix >= x.min) t = x;
  return t;
}

function computeStock(p) {
  const trailStop = (p.high || p.price) * (1 - CONFIG.trailStopPct);
  const atr = p.atr || p.price * 0.03;
  const atrStop = p.price - CONFIG.atrStopK * atr;
  const stop = Math.max(trailStop, atrStop);
  const distStop = (p.price - stop) / p.price * 100;
  const target = p.target || p.price;
  const upside = (target - p.price) / p.price * 100;
  let action = '持有';
  if (p.price <= stop) action = '⛔ 触发止损';
  else if (upside <= CONFIG.trimUpsidePct || (p.rsi || 50) >= CONFIG.rsiOverbought) action = '⚠️ 减仓/止盈';
  else if (upside >= CONFIG.addUpsidePct && (p.rsi || 50) <= CONFIG.rsiOversold) action = '✅ 可考虑加仓';
  return { stop, distStop, upside, action };
}

/* =====================================================================
 * 组装并推送
 * ===================================================================== */
async function buildReport() {
  const vix = await getVix();
  const market = { ...MARKET, vix };

  const rows = [];
  for (const h of HOLDINGS) {
    const [q, m] = await Promise.all([getQuote(h.sym), getMetrics(h.sym)]);
    const p = { ...h, price: q.price, chgPct: q.chgPct, high: m.high, target: m.target, rsi: m.rsi };
    rows.push({ ...p, mv: p.price * p.shares, pnl: (p.price - p.cost) * p.shares, ...computeStock(p) });
  }

  const equity = rows.reduce((s, r) => s + r.mv, 0);
  const total = equity + CASH;
  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  const dayPnl = rows.reduce((s, r) => s + r.mv * (r.chgPct / 100) / (1 + r.chgPct / 100), 0);
  const suggested = computePosition(market);
  const current = equity / total * 100;
  const tier = vixTier(vix);

  // 触发式告警
  const alerts = [];
  if (tier) alerts.push(`🟢 **VIX 抄底信号 ${tier.label}**：VIX ${vix.toFixed(1)}，分批部署约 ${tier.deploy}% 计划资金`);
  rows.forEach(r => {
    if (r.action.includes('止损')) alerts.push(`⛔ **${r.sym} 触及止损**：现价 $${r.price}（止损 $${r.stop.toFixed(1)}）`);
    else if (r.distStop < 4) alerts.push(`🔴 **${r.sym} 逼近止损**：距止损仅 ${r.distStop.toFixed(1)}%`);
    if (r.action.includes('减仓')) alerts.push(`⚠️ **${r.sym}** 上行空间收窄（${r.upside.toFixed(0)}%），考虑止盈/减仓`);
  });
  if (Math.abs(suggested - current) > 8) {
    alerts.push(current > suggested
      ? `📉 仓位偏高：当前 ${current.toFixed(0)}% > 建议 ${suggested}%，考虑减仓`
      : `📈 仓位偏低：当前 ${current.toFixed(0)}% < 建议 ${suggested}%，回调可加仓`);
  }

  // 正文（飞书 lark_md 语法）
  const fmt = n => (n >= 0 ? '+' : '') + '$' + Math.abs(Math.round(n)).toLocaleString();
  let md = `**总资产** $${Math.round(total).toLocaleString()}　|　**当日** ${fmt(dayPnl)}　|　**累计** ${fmt(totalPnl)}\n`;
  md += `**建议仓位** ${suggested}%　**当前实际** ${current.toFixed(0)}%\n`;
  md += `---\n`;
  if (alerts.length) { md += `**🔔 今日提醒**\n` + alerts.map(a => '• ' + a).join('\n') + `\n---\n`; }
  md += `**持仓概览**\n`;
  rows.forEach(r => {
    md += `• **${r.sym}** $${r.price}（${r.chgPct >= 0 ? '+' : ''}${r.chgPct.toFixed(1)}%）　盈亏 ${fmt(r.pnl)}　距止损 ${r.distStop.toFixed(0)}%　${r.action}\n`;
  });
  md += `\n_工具化量化参考，不构成投资建议。_`;

  return { md, alertCount: alerts.length };
}

// 飞书签名（仅当机器人开启“签名校验”时需要）
function feishuSign(timestamp, secret) {
  const key = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', key).update('').digest('base64');
}

async function sendFeishu(report) {
  const body = {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: "📊 JY's Stock Dashboard 提醒" }, template: report.alertCount ? 'red' : 'blue' },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: report.md } }],
    },
  };
  if (ENV.FEISHU_SECRET) {
    const ts = Math.floor(Date.now() / 1000).toString();
    body.timestamp = ts;
    body.sign = feishuSign(ts, ENV.FEISHU_SECRET);
  }
  const r = await fetch(ENV.FEISHU_WEBHOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (j.code && j.code !== 0) console.error('飞书返回错误：', j);
  else console.log('✓ 已推送飞书，提醒数：', report.alertCount);
}

async function runOnce() {
  try {
    if (ENV.FINNHUB_KEY === 'YOUR_FINNHUB_KEY' || ENV.FEISHU_WEBHOOK.includes('XXXX')) {
      console.error('⚠️ 请先在 ENV 里填好 FINNHUB_KEY 和 FEISHU_WEBHOOK'); return;
    }
    const report = await buildReport();
    await sendFeishu(report);
  } catch (e) { console.error('运行出错：', e); }
}

/* ---------- 入口 ---------- */
if (process.argv.includes('--once')) {
  runOnce();
} else {
  runOnce(); // 启动先推一次
  if (cron) {
    cron.schedule(ENV.CRON, runOnce, { timezone: 'Asia/Shanghai' });
    console.log(`已按计划运行：${ENV.CRON}（Asia/Shanghai）。进程保持运行即可。`);
  } else {
    console.log('未安装 node-cron，仅运行一次。安装后可定时：npm install node-cron');
  }
}
