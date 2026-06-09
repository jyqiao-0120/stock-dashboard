// ============================================================
//  stock-proxy  ·  数据代理 + AI 分析后端
//  环境变量（在 Render 的 Environment 里设置）：
//    FINNHUB_KEY    Finnhub 密钥（行情，已有）
//    TWELVE_KEY     Twelve Data 密钥（RSI/ATR/VIX）
//    FMP_KEY        Financial Modeling Prep 密钥（事件/财报/利率）
//    AI_PROVIDER    'anthropic' 或 'openai'（DeepSeek/GLM/Qwen 都用 openai 这档）
//    AI_KEY         所选 AI 的密钥
//    AI_MODEL       模型名，如 'claude-opus-4-8' 或 'deepseek-chat'
//    AI_BASE        仅 openai 档需要：接口地址，如 https://api.deepseek.com/v1
//    GITHUB_TOKEN   读写 holdings.json（已有）
//    GITHUB_REPO    形如 jyqiao-0120/stock-dashboard（已有）
// ============================================================
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const KEY      = process.env.FINNHUB_KEY;
const TWELVE   = process.env.TWELVE_KEY;
const FMP_KEY  = process.env.FMP_KEY;
const FH       = 'https://finnhub.io/api/v1';
const TD       = 'https://api.twelvedata.com';
const FMP      = 'https://financialmodelingprep.com/stable';

// 小工具：安全 fetch JSON
async function getJSON(url){ const r = await fetch(url); return await r.json(); }

/* ---------------- 行情（Finnhub，免费） ---------------- */
app.get('/api/quote/:sym',   async (q,s)=>{ try{ s.json(await getJSON(`${FH}/quote?symbol=${q.params.sym}&token=${KEY}`)); }catch(e){ s.status(500).json({error:e.message}); }});
app.get('/api/metrics/:sym', async (q,s)=>{ try{ s.json(await getJSON(`${FH}/stock/metric?symbol=${q.params.sym}&metric=all&token=${KEY}`)); }catch(e){ s.status(500).json({error:e.message}); }});
app.get('/api/target/:sym',  async (q,s)=>{ try{ s.json(await getJSON(`${FH}/stock/price-target?symbol=${q.params.sym}&token=${KEY}`)); }catch(e){ s.status(500).json({error:e.message}); }});
app.get('/api/profile/:sym', async (q,s)=>{ try{ s.json(await getJSON(`${FH}/stock/profile2?symbol=${q.params.sym}&token=${KEY}`)); }catch(e){ s.status(500).json({error:e.message}); }});
app.get('/api/batch', async (q,s)=>{
  const syms=(q.query.syms||'').split(',').filter(Boolean);
  try{ s.json(await Promise.all(syms.map(async x=>({sym:x, ...(await getJSON(`${FH}/quote?symbol=${x}&token=${KEY}`))})))); }
  catch(e){ s.status(500).json({error:e.message}); }
});

/* ---------------- 技术指标（Twelve Data） ---------------- */
app.get('/api/rsi/:sym', async (q,s)=>{ try{
  const j=await getJSON(`${TD}/rsi?symbol=${q.params.sym}&interval=1day&time_period=14&apikey=${TWELVE}`);
  const v=j.values?.[0]?.rsi; s.json({rsi: v?Math.round(+v):null});
}catch(e){ s.status(500).json({error:e.message}); }});
app.get('/api/atr/:sym', async (q,s)=>{ try{
  const j=await getJSON(`${TD}/atr?symbol=${q.params.sym}&interval=1day&time_period=14&apikey=${TWELVE}`);
  const v=j.values?.[0]?.atr; s.json({atr: v?+(+v).toFixed(2):null});
}catch(e){ s.status(500).json({error:e.message}); }});
app.get('/api/vix', async (q,s)=>{ try{
  const j=await getJSON(`${TD}/quote?symbol=VIX&apikey=${TWELVE}`);
  s.json({vix: j.close?+(+j.close).toFixed(1):null});
}catch(e){ s.status(500).json({error:e.message}); }});

/* ---------------- 财报日期（FMP） ---------------- */
app.get('/api/earnings/:sym', async (q,s)=>{ try{
  const today=new Date().toISOString().slice(0,10);
  const to=new Date(Date.now()+150*864e5).toISOString().slice(0,10);
  const j=await getJSON(`${FMP}/earnings-calendar?symbol=${q.params.sym}&from=${today}&to=${to}&apikey=${FMP_KEY}`);
  const d=Array.isArray(j)&&j.length?j[0].date:null;
  s.json({earnDays: d?Math.round((new Date(d)-new Date())/864e5):null, date:d});
}catch(e){ s.status(500).json({error:e.message}); }});

/* ---------------- 宏观事件日历（FMP） ---------------- */
app.get('/api/events', async (q,s)=>{ try{
  const today=new Date().toISOString().slice(0,10);
  const to=new Date(Date.now()+35*864e5).toISOString().slice(0,10);
  const j=await getJSON(`${FMP}/economic-calendar?from=${today}&to=${to}&apikey=${FMP_KEY}`);
  const impMap={High:5,Medium:3,Low:1};
  const out=(Array.isArray(j)?j:[])
    .filter(e=>e.country==='US' && (e.impact==='High'||e.impact==='Medium'))
    .slice(0,12)
    .map(e=>({ date:(e.date||'').slice(5,10), name:e.event, impact:impMap[e.impact]||3, lean:'neutral', note:'' }));
  s.json({events: out});
}catch(e){ s.status(500).json({error:e.message, events:[]}); }});

/* ---------------- AI 综合分析 ---------------- */
app.post('/api/analyze', async (q,s)=>{
  try{
    const data=q.body||{};
    const sys='你是严谨的投资组合助手。只根据用户提供的真实数据做分析，不要编造任何数字或新闻。'
      +'输出必须是严格的 JSON（不要 markdown、不要解释），结构：'
      +'{"position": 整数0-100(建议总仓位百分比), "panic": 整数0-100(恐慌指数,0贪婪100恐慌), '
      +'"stance":"一句话总体判断", "commentary":"3-4句中文综合点评，说明为什么给这个仓位", '
      +'"actions":["可执行的行动建议1","建议2"]}。语气克制，强调这是参考而非投资建议。';
    const user='以下是我的真实组合与市场数据（JSON）：\n'+JSON.stringify(data,null,2)
      +'\n请综合 VIX、事件日历、各持仓的现价/目标价/RSI/距止损/盈亏、集中度，给出建议总仓位与点评。';

    let text='';
    const provider=process.env.AI_PROVIDER||'anthropic';
    if(provider==='anthropic'){
      const r=await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST',
        headers:{'content-type':'application/json','x-api-key':process.env.AI_KEY,'anthropic-version':'2023-06-01'},
        body:JSON.stringify({ model:process.env.AI_MODEL||'claude-opus-4-8', max_tokens:1024,
          system:sys, messages:[{role:'user',content:user}] })
      });
      const j=await r.json();
      text=(j.content||[]).map(b=>b.text||'').join('') || JSON.stringify(j);
    } else { // openai 兼容（DeepSeek/GLM/Qwen/OpenAI）
      const base=process.env.AI_BASE||'https://api.openai.com/v1';
      const r=await fetch(`${base}/chat/completions`,{
        method:'POST',
        headers:{'content-type':'application/json','authorization':`Bearer ${process.env.AI_KEY}`},
        body:JSON.stringify({ model:process.env.AI_MODEL||'gpt-4o-mini', max_tokens:1024,
          messages:[{role:'system',content:sys},{role:'user',content:user}] })
      });
      const j=await r.json();
      text=j.choices?.[0]?.message?.content || JSON.stringify(j);
    }
    // 提取 JSON（容错：去掉可能的 ```json 包裹）
    const clean=text.replace(/```json|```/g,'').trim();
    let parsed; try{ parsed=JSON.parse(clean); }catch{ parsed={position:null,panic:null,stance:'AI 返回解析失败',commentary:clean.slice(0,300),actions:[]}; }
    s.json(parsed);
  }catch(e){ s.status(500).json({error:e.message}); }
});

/* ---------------- 持仓读写（GitHub） ---------------- */
const GH='https://api.github.com', REPO=process.env.GITHUB_REPO||'', GTOKEN=process.env.GITHUB_TOKEN||'', HFILE='holdings.json';
app.get('/api/holdings', async (q,s)=>{ try{
  const data=await getJSON(`${GH}/repos/${REPO}/contents/${HFILE}`+`?t=${Date.now()}`);
  if(!data.content) return s.status(404).json({error:'file not found'});
  s.json({ ...JSON.parse(Buffer.from(data.content,'base64').toString('utf-8')), _sha:data.sha });
}catch(e){ s.status(500).json({error:e.message}); }});
app.post('/api/holdings', async (q,s)=>{ try{
  const cur=await getJSON(`${GH}/repos/${REPO}/contents/${HFILE}`);
  const {_sha,...data}=q.body;
  const r=await fetch(`${GH}/repos/${REPO}/contents/${HFILE}`,{ method:'PUT',
    headers:{Authorization:`token ${GTOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify({message:`update holdings ${new Date().toISOString()}`,content:Buffer.from(JSON.stringify(data,null,2)).toString('base64'),sha:cur.sha}) });
  const j=await r.json(); j.commit? s.json({ok:true}) : s.status(400).json({error:j.message});
}catch(e){ s.status(500).json({error:e.message}); }});

const PORT=process.env.PORT||8787;
app.listen(PORT,()=>console.log(`✓ 代理已启动：http://localhost:${PORT}`));
