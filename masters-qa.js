/* 自动生成自 src/masters-qa-engine.js + 面板交互 · 由 scripts/site.js 输出，勿手改 */
(function(){
/**
 * 「问问大师」问答引擎 v1（2026-11-08 用户需求：追踪大师持仓页植入投资大师智能体）
 *
 * 知识底座：data/masters-kb.json（17 位大师蒸馏，21 个高频问题意图 + 流派总览 + 持仓问询）
 * 构建期融合：site.js 将 gurus.json（13F 持仓）注入 data.holdings / data.guruTickers，随每日核查自动更新
 *
 * 答问铁律（源自投资大师智慧知识库总索引）：
 *   1. 每条答案标注出处【大师 · 著作 · 理论】
 *   2. 引语须可查证
 *   3. 流派冲突并列呈现，不强行调和
 *   4. 只给思考框架，不构成投资建议
 *
 * 纯函数，无 DOM 依赖，可被 Node 直接测试：
 *   import { answerQuery, greet } from './src/masters-qa-engine.js'
 * 浏览器端：scripts/site.js 构建时去 export 后内联进 site/masters-qa.js
 *
 * 返回：{ html, ctx }，ctx={ guru, ticker } 供追问（"那他怎么看止损"）
 */

// ── 基础工具 ──
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num1 = (v) => (v == null || !isFinite(v) ? '—' : (Math.round(v * 100) / 100).toLocaleString('en-US'));

// 持仓问询触发词
const HOLD_RE = /持仓|持有哪些|持有什么|买了什么|买了哪些|买了啥|重仓|谁在买|谁买了|持有哪些股|第一重仓|仓位里|组合里|买了啥股/;
// "能不能买某标的"触发词
const BUY_RE = /能买|可以买|该买|要不要买|值得买|现在买|买吗|买入手|入场|上车/;
// 追问代词（配合 ctx.guru）
const PRON_RE = /^(那|那么)?(他|她|它|这位|该大师|这位大师)/;

// 通用停用词：防止中文模糊匹配误伤
const GENERIC = ['怎么样', '怎么办', '怎么看', '什么意思', '为什么', '请问', '帮忙', '帮我', '一下', '应该', '需要', '可以'];

// 查询归一化：把口语变体折叠为标准触发词（仅用于意图匹配，不影响原文 ticker 识别）
const NORM = [
  [/值不值得|值得吗|值吗|值得投资|能投资吗/, '值得买'],
  [/拿不拿得住|拿得住吗/, '拿不住'],
  [/怕不怕|慌不慌|慌了吗|慌不/, '恐慌'],
  [/梭哈|全仓押|all\s?in/i, '满仓'],
  [/买几只|持几只|几只股票/, '几只股票'],
  [/贵了吗|是不是贵|算贵吗/, '贵不贵'],
  [/够便宜吗|算便宜吗|便宜了吗/, '低估'],
  [/回本|翻身/, '解套'],
  [/过山车/, '大起大落'],
  [/翻倍了|赚了不少|获利/, '止盈'],
];
function normalize(ql) {
  let s = ql;
  for (const [re, to] of NORM) if (re.test(s)) s = s.replace(re, to);
  return s;
}

// 同义词扩展（2026-11-08 智能化①）：用户口语词 → 意图关键词，匹配不到时扩展重试
const SYN = {
  接盘: '抄底', 低吸: '抄底', 补仓: '抄底', 摊低成本: '抄底', 加仓: '越跌越买',
  腰斩: '大跌', 跌成狗: '大跌', 跌惨: '大跌', 跌麻: '大跌', 绿了: '大跌', 回调: '大跌', 调整: '大跌',
  认赔: '止损', 割了: '止损', 砍仓: '止损', 清仓: '卖出', 卖掉: '卖出', 卖了: '卖出', 落袋: '落袋为安',
  套住: '被套', 深套: '被套', 解套: '被套', 死扛: '扛单',
  配资: '加杠杆', 借债: '借钱',
  太贵: '贵不贵', 价格合理: '合理价格', 性价比: '估值', 高估: '泡沫',
  心慌: '恐慌', 发慌: '恐慌', 害怕: '恐慌', 睡不着: '失眠', emo: '情绪', 上头: '情绪', 冲动: '情绪',
  崩了: '崩盘', 股灾: '崩盘', 过热: '泡沫', 到顶: '见顶', 天花板: '见顶',
  菜鸟: '新手', 零基础: '新手', 刚开户: '新手', 从哪开始: '入门', 起步: '入门',
  挑股票: '选股', 好生意: '好公司', 护城河: '好公司',
  定投: '指数基金', 宽基: '指数基金', 纳指: '指数基金', 窄基: '指数基金',
  亏了: '亏钱', 赔了: '亏钱', 交学费: '复盘', 被收割: '复盘', 反省: '反思',
  滚雪球: '复利', 慢慢变富: '复利',
  技术分析: '技术面', k线: '技术面', macd: '技术面',
  跟单: '消息', 抄作业: '消息', 跟风: '消息',
  不熟: '看不懂', 热门股: '好公司',
};
function expandQuery(ql) {
  let ex = ' ' + ql + ' ';
  for (const [k, v] of Object.entries(SYN)) {
    if (k === k.toLowerCase() ? ex.toLowerCase().includes(k) : ex.includes(k)) ex += ' ' + v;
  }
  return ex;
}

// 追问代词（配合 ctx.guru / ctx.ticker）
const PRON_TK_RE = /^(那|那么)?(它|这家公司|这公司|这只|这个股|该股|同一家)/;

const fmtMoney = (v) => {
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)}万亿$`;
  if (v >= 1e8) return `${(v / 1e8).toFixed(v >= 1e10 ? 1 : 2)}亿$`;
  return `${(v / 1e6).toFixed(1)}百万$`;
};

// ── HTML 组装 ──
function cardHtml(c) {
  return `<div class="mq-card"><div class="mq-src">【${esc(c.m)} · ${esc(c.w)} · ${esc(c.t)}】</div>`
    + (c.q ? `<div class="mq-quote">「${esc(c.q)}」</div>` : '')
    + `<div class="mq-core">${esc(c.c)}</div></div>`;
}
function chipsHtml(list) {
  if (!list || !list.length) return '';
  return `<div class="mq-chips">${list.slice(0, 4).map((q) => `<button class="mq-chip" data-q="${esc(q)}" type="button">${esc(q)}</button>`).join('')}</div>`;
}
function noteHtml() {
  return `<div class="mq-note">以上为大师思考框架，不构成投资建议。</div>`;
}

// ── 识别器 ──
function findGuru(data, q, ctx) {
  const alias = data.guruAlias || {};
  let hit = null;
  for (const [gid, names] of Object.entries(alias)) {
    for (const n of names) {
      if (q.includes(String(n).toLowerCase())) { hit = gid; break; }
    }
    if (hit) break;
  }
  if (!hit && ctx && ctx.guru && PRON_RE.test(q)) hit = ctx.guru;
  return hit;
}

function findTickers(data, q) {
  const found = new Set();
  const unknown = new Set(); // 2026-11-08 智能化②：识别"问了但库中无持仓"的标的
  // 中文别名
  for (const [cn, tk] of Object.entries(data.tickerAlias || {})) {
    if (q.includes(cn.toLowerCase())) found.add(tk);
  }
  // 英文代码（大写词 2-6 位，含 BRK.B 形态）
  const uppers = String(q).match(/\b[A-Z]{2,6}(?:\.[A-Z]{1,2})?\b/g) || [];
  for (const u of uppers) {
    if ((data.holdings || {})[u]) { found.add(u); continue; }
    let known = false;
    for (const alias of Object.values(data.tickerAlias || {})) {
      if (alias === u) { known = true; found.add(u); break; }
    }
    if (!known) unknown.add(u);
  }
  return { known: [...found], unknown: [...unknown] };
}

function scoreIntents(data, q) {
  const scored = [];
  for (const it of data.intents || []) {
    if (!it.cards || !it.cards.length) continue; // holdings_q / schools 走专用分支
    let s = 0;
    for (const kw of it.kw || []) {
      if (q.includes(kw)) s += kw.length + 1;
    }
    if (s > 0) scored.push([s, it]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored;
}

// ── 持仓数据分支 ──
function tickerName(data, tk) {
  for (const [cn, code] of Object.entries(data.tickerAlias || {})) if (code === tk) return cn;
  const gt = data.guruTickers || {};
  for (const g of Object.values(gt)) {
    const p = (g.pos || []).find((x) => x.t === tk);
    if (p && p.n) return p.n;
  }
  return tk;
}

function answerGuruHoldings(data, gid) {
  const gt = (data.guruTickers || {})[gid];
  const prof = (data.guruProfiles || {})[gid] || {};
  if (!gt) {
    return {
      html: `<div class="mq-lead">${esc(prof.desc || '该大佬暂无披露数据。')}</div>`
        + `<div class="mq-note">13F 季度披露、滞后最长 45 天；每日自动核查 EDGAR，有新披露即更新。</div>${noteHtml()}`,
      ctx: { guru: gid },
    };
  }
  const rows = gt.pos.map((p) => `<div class="mq-row"><span class="mq-row-tk">${esc(p.t)}</span><span class="mq-row-n">${esc(p.n || '')}</span><b>${num1(p.w)}%</b></div>`).join('');
  return {
    html: `<div class="mq-lead">${esc(gt.name)} 最新美股披露持仓${gt.total ? `（披露总市值约 <b>${esc(fmtMoney(gt.total))}</b>）` : ''}${gt.asOf ? ` · 报告期 ${esc(gt.asOf)}` : ''}：</div>`
      + `<div class="mq-table">${rows}</div>`
      + `<div class="mq-note">数据来自 SEC 13F-HR 季度披露（滞后最长 45 天，不含空头/债券/期货），每日自动核查更新。</div>`,
    ctx: { guru: gid },
  };
}

function answerTickerHoldings(data, tk) {
  const list = (data.holdings || {})[tk] || [];
  const name = tickerName(data, tk);
  if (!list.length) {
    return {
      html: `<div class="mq-lead">当前 12 位跟踪大佬的披露持仓里没有 <b>${esc(tk)}</b>（13F 滞后最长 45 天，且不含空头/期权/债券）。</div>${noteHtml()}`,
      ctx: { ticker: tk },
    };
  }
  const rows = list.map((r) => `<div class="mq-row"><span class="mq-row-n">${esc(r.g)}</span><b>${num1(r.w)}%</b>${r.asOf ? `<span class="mq-row-d">${esc(r.asOf)}</span>` : ''}</div>`).join('');
  return {
    html: `<div class="mq-lead"><b>${esc(name)}（${esc(tk)}）</b>出现在以下大佬的最新披露持仓中：</div>`
      + `<div class="mq-table">${rows}</div>`
      + `<div class="mq-note">13F 为季度披露、滞后最长 45 天；占其美股长仓比例。仅供参考，不构成投资建议。</div>`,
    ctx: { ticker: tk },
  };
}

function answerTickerWithTheory(data, tk) {
  const base = answerTickerHoldings(data, tk);
  const dl = data.deps || {};
  const pick = ['valuation', 'dip', 'selection', 'quality', 'risk'].map((id) => dl[id]).filter(Boolean).slice(0, 2);
  const cards = pick.length
    ? pick.map((it) => it.cards.slice(0, 1).map(cardHtml).join('')).join('')
    : '';
  const lead = pick.length ? `<div class="mq-lead">至于「能不能买」——大师们不预测个股，只给框架：</div>` : '';
  const name = tickerName(data, tk);
  return {
    html: base.html
      + `${lead}${cards}`
      + chipsHtml([`谁在买${name}？`, `${name}贵不贵？`])
      + `<div class="mq-note">博主们的具体观点请用首页右下角「问一问」查询（基于每日观点数据库）。</div>${noteHtml()}`,
    ctx: { ticker: tk },
  };
}

// 未收录标的（2026-11-08 智能化③）：明确告知不在披露持仓，并给通用判断框架
function answerUnknownTicker(data, tk) {
  return {
    html: `<div class="mq-lead"><b>${esc(tk)}</b> 目前<b>没有</b>出现在 12 位跟踪大佬的最新披露持仓里（13F 滞后最长 45 天，不含空头/期权/债券——也可能他们确实没买）。</div>`
      + `<div class="mq-lead">如果你想自己判断它值不值得买，两条通用框架：</div>`
      + `<div class="mq-card"><div class="mq-src">【巴菲特 · 致股东的信 · 能力圈】</div><div class="mq-core">先问自己：这家公司十年后靠什么赚钱？答不上来就归入"太难"那一类，直接跳过。</div></div>`
      + `<div class="mq-card"><div class="mq-src">【格雷厄姆 · 《聪明的投资者》 · 安全边际】</div><div class="mq-core">只在价格明显低于保守估算的内在价值时出手，给自己留足容错空间。</div></div>`
      + chipsHtml(['怎么判断一只股票贵不贵？', '普通人不会选股怎么办？', '听说的一只股票能买吗？'])
      + noteHtml(),
    ctx: { ticker: tk },
  };
}

// ── 意图分支 ──
function answerIntents(data, intents, ctx) {
  const [pS, primary] = intents[0];
  const sec = intents[1];
  const cards = primary.cards.slice(0, 4).map(cardHtml).join('');
  const conflict = primary.conflict ? `<div class="mq-conflict">⚖️ ${esc(primary.conflict)}</div>` : '';
  const chips = [...(primary.chips || [])];
  // 复合视角：两个意图得分都高时并列回答
  let head = esc(primary.intro);
  if (sec && pS >= 5 && sec[0] >= 5) {
    const secCards = sec[1].cards.slice(0, 2).map(cardHtml).join('');
    head = `你的问题涉及两个层面，分开说：<br><b>①</b> ${esc(primary.intro)}<br><b>②</b> ${esc(sec[1].intro)}`;
    return {
      html: `<div class="mq-lead">${head}</div>${cards}${secCards}${conflict}${chipsHtml([...chips, ...(sec[1].chips || [])])}${noteHtml()}`,
      ctx: { ...ctx },
    };
  }
  // 弱命中补充参考
  let extraHtml = '';
  if (sec && pS < 5 && sec[0] >= 2) {
    extraHtml = `<div class="mq-card mq-weak"><div class="mq-src">可能也相关</div><div class="mq-core">【${esc(sec[1].label)}】——点击下方推荐问题查看该视角的完整回答。</div></div>`;
    chips.push(...(sec[1].chips || []).slice(0, 2));
  }
  return {
    html: `<div class="mq-lead">${head}</div>${cards}${extraHtml}${conflict}${chipsHtml(chips)}${noteHtml()}`,
    ctx: { ...ctx },
  };
}

// ── 大师画像分支 ──
function answerGuruProfile(data, gid) {
  const prof = (data.guruProfiles || {})[gid];
  if (!prof) return null;
  if (!prof.kb) {
    const near = (prof.near || []).map((n) => (data.masters || {})[n]).filter(Boolean);
    const nearHtml = near.length
      ? `<div class="mq-lead">其理论体系暂未收录，风格最接近的是：</div>${near.map((m) => `<div class="mq-card"><div class="mq-src">【${esc(m.name)} · ${esc(m.work)} · ${esc(m.school)}】</div><div class="mq-core">${esc(m.title)}——可以直接问这位大师的理论。</div></div>`).join('')}`
      : `<div class="mq-lead">${esc(prof.desc)}</div>`;
    return {
      html: `${nearHtml}${chipsHtml(prof.follow)}${noteHtml()}`,
      ctx: { guru: gid },
    };
  }
  const gt = (data.guruTickers || {})[gid];
  const holdLine = gt && gt.pos && gt.pos.length
    ? `<div class="mq-lead">📌 最新披露持仓（报告期 ${esc(gt.asOf || '')}）：<b>${gt.pos.slice(0, 3).map((p) => `${esc(p.t)} ${num1(p.w)}%`).join(' · ')}</b>${gt.total ? ` · 总市值约 ${esc(fmtMoney(gt.total))}` : ''}</div>`
    : '';
  return {
    html: `<div class="mq-lead"><b>${esc((data.masters[gid] || {}).name || gid)}</b>（${esc(prof.school)}）——${esc(prof.desc)}</div>${holdLine}${prof.cards.map(cardHtml).join('')}${chipsHtml(prof.follow)}${noteHtml()}`,
    ctx: { guru: gid },
  };
}

// ── 总览/兜底 ──
function answerSchools(data) {
  const groups = {};
  for (const m of Object.values(data.masters || {})) {
    (groups[m.school] ||= []).push(m);
  }
  const schoolLine = (data.schools || []).map((s) => `<div class="mq-card"><div class="mq-src">【${esc(s.name)}】${esc(s.line)}</div><div class="mq-core">${esc(s.chain)}</div></div>`).join('');
  const members = Object.entries(groups).map(([k, ms]) => `<div class="mq-row"><span class="mq-row-n"><b>${esc(k)}</b>：${ms.map((m) => esc(m.name)).join('、')}</span></div>`).join('');
  return {
    html: `<div class="mq-lead">17 位大师、四大流派：</div>${members}<div class="mq-lead">每派的核心逻辑：</div>${schoolLine}${chipsHtml(['普通人不会选股怎么办？', '集中还是分散？', '怎么选成长股？'])}${noteHtml()}`,
    ctx: {},
  };
}

function answerFallback(data) {
  return {
    html: `<div class="mq-lead">我可以按大师理论回答带出处的问题，也可以查 12 位大佬的最新持仓。试试这些：</div>${chipsHtml(data.hot || [])}<div class="mq-note">覆盖：抄底、止损、仓位、杠杆、估值、卖出、心态、泡沫、选股、基金、危机、趋势、量化、复盘……也可以直接点名大师或标的。</div>`,
    ctx: {},
  };
}

// ── 主入口 ──
function greet(data, gid) {
  const prof = gid ? (data.guruProfiles || {})[gid] : null;
  if (prof) {
    if (prof.kb) {
      const m = (data.masters || {})[gid] || {};
      return `<div class="mq-lead">这里是<b>${esc(m.name || '')}</b>的理论智能体——他的核心思想、最新披露持仓都能问。</div>${chipsHtml(prof.follow && prof.follow.length ? prof.follow : data.hot)}<div class="mq-note">也可以问任何通用投资问题（抄底/止损/仓位/估值……），17 位大师都会出场。</div>`;
    }
    return `<div class="mq-lead">本页跟踪 <b>${esc((data.guruNames || {})[gid] || gid)}</b> 的最新披露持仓。其理论体系暂未收录，但你可以问任何投资问题——17 位大师会按流派出场作答。</div>${chipsHtml(data.hot)}`;
  }
  return `<div class="mq-lead">你好，我是<b>投资大师智能体</b> 🧙 基于 17 位大师的蒸馏知识库（价值/量化/趋势/宏观四派）+ 本页 12 位大佬的最新 13F 持仓，带出处的解答。</div>${chipsHtml(data.hot)}<div class="mq-note">试试点上面的问题，或直接输入——比如「该不该用杠杆」「巴菲特现在重仓什么」「英伟达谁在买」。</div>`;
}

function answerQuery(data, q, ctx) {
  const raw = String(q || '').trim();
  const ql = raw.toLowerCase();
  if (!ql) return { html: '', ctx: {} };

  // 问候
  if (/^(你好|您好|hi|hello|嗨|在吗|哈喽)/.test(ql)) return { html: greet(data, ctx && ctx.guru), ctx: {} };

  const guru = findGuru(data, ql, ctx);
  const ft = findTickers(data, raw);
  const tickers = ft.known;
  const isHoldQ = HOLD_RE.test(raw);
  const isBuyQ = BUY_RE.test(raw);

  // ① 标的 + 持仓问询：谁重仓了 X / X 谁在买
  if (tickers.length && isHoldQ) return answerTickerHoldings(data, tickers[0]);
  // ② 大师 + 持仓问询：巴菲特买了什么
  if (guru && isHoldQ && !tickers.length) return answerGuruHoldings(data, guru);
  // ③ 大师点名（无持仓问询）：大师画像
  if (guru && !tickers.length && !isHoldQ) {
    const intents = scoreIntents(data, ql);
    if (intents.length) {
      // 大师 + 理论问题 → 该大师在库内的相关理论优先
      const prof = (data.guruProfiles || {})[guru];
      if (prof && prof.kb) {
        const own = prof.cards.map(cardHtml).join('');
        const extra = intents[0].cards.filter((c) => c.m && !prof.cards.some((p) => p.t === c.t)).slice(0, 1).map(cardHtml).join('');
        return {
          html: `<div class="mq-lead">${esc((data.masters[guru] || {}).name || '')}对「${esc(intents[0].label)}」的回答——先看他的核心思想：</div>${own}${extra ? `<div class="mq-lead">其他大师的对照：</div>${extra}` : ''}${chipsHtml(intents[0].chips)}${noteHtml()}`,
          ctx: { guru },
        };
      }
    }
    return answerGuruProfile(data, guru) || answerFallback(data);
  }
  // ④ 标的 + 买不买 → 持仓事实 + 大师框架
  if (tickers.length && isBuyQ) return answerTickerWithTheory(data, tickers[0]);
  // ⑤ 纯标的（无意图命中）→ 持仓事实
  if (tickers.length) {
    const intents = scoreIntents(data, ql);
    if (intents.length) return answerIntents(data, intents, { ticker: tickers[0] });
    return answerTickerHoldings(data, tickers[0]);
  }
  // ⑤′ 未收录标的（2026-11-08 智能化②）：短句直接点名某代码但库里没有 → 明说 + 给框架
  if (!tickers.length && ft.unknown.length && raw.length <= 14 && !isHoldQ) {
    return answerUnknownTicker(data, ft.unknown[0]);
  }
  // ⑥ 意图命中（先直配，弱命中时用同义词扩展重试——2026-11-08 智能化①）
  let intents = scoreIntents(data, ql);
  if (!intents.length || intents[0][0] < 4) {
    const ex = expandQuery(ql);
    const i2 = scoreIntents(data, ex);
    if (i2.length && (!intents.length || i2[0][0] > intents[0][0])) intents = i2;
  }
  if (intents.length) return answerIntents(data, intents, { guru: guru || (ctx && ctx.guru) || null });
  // ⑦ 流派总览
  const schoolsIntent = (data.intents || []).find((x) => x.id === 'schools');
  if (schoolsIntent && (schoolsIntent.kw || []).some((kw) => ql.includes(kw))) return answerSchools(data);
  // ⑧ 兜底
  return answerFallback(data);
}

window.MQEngine={answerQuery:answerQuery,greet:greet};
})();
(function(){
  var openBtns=document.querySelectorAll('.mq-open'),panel=document.getElementById('mqPanel'),closeB=document.getElementById('mqClose'),
      input=document.getElementById('mqInput'),sendB=document.getElementById('mqSend'),msgs=document.getElementById('mqMsgs');
  if(!panel||!window.MQEngine||!input) return;
  var DATA=null,loading=false,CTX=null,GURU='';
  var ob=document.querySelector('.mq-open'); if(ob) GURU=ob.getAttribute('data-guru')||'';
  try{var qm=location.search.match(/[?&]guru=([^&]+)/); if(qm) GURU=decodeURIComponent(qm[1]);}catch(e){}
  function scroll(){msgs.scrollTop=msgs.scrollHeight;}
  function addBot(html){var w=document.createElement('div');w.className='mq-bot';var b=document.createElement('div');b.className='mq-bub';b.innerHTML=html;w.appendChild(b);msgs.appendChild(w);b.querySelectorAll('[data-q]').forEach(function(el){el.addEventListener('click',function(){ask(el.getAttribute('data-q'));});});scroll();}
  function addUser(t){var w=document.createElement('div');w.className='mq-user';var b=document.createElement('div');b.className='mq-bub';b.textContent=t;w.appendChild(b);msgs.appendChild(w);scroll();}
  function load(){if(DATA||loading)return;loading=true;addBot('<div class="mq-note">正在加载大师知识库…</div>');
    fetch('/masters-qa-data.json').then(function(r){if(!r.ok)throw new Error('http '+r.status);return r.json();}).then(function(j){DATA=j;msgs.innerHTML='';addBot(window.MQEngine.greet(j,GURU));}).catch(function(){var b=msgs.querySelector('.mq-bub');if(b)b.innerHTML='知识库加载失败，请刷新重试';loading=false;});}
  function openP(){panel.classList.add('open');load();try{input.focus();}catch(e){}}
  function closeP(){panel.classList.remove('open');}
  openBtns.forEach(function(b){b.addEventListener('click',openP);});
  closeB.addEventListener('click',closeP);
  function ask(text){text=String(text||'').trim();if(!text)return;addUser(text);input.value='';
    setTimeout(function(){var out;try{out=window.MQEngine.answerQuery(DATA,text,CTX);}catch(e){out={html:'解析出错，换个问法试试～'};}
      if(out&&out.ctx&&(out.ctx.guru||out.ctx.ticker))CTX=out.ctx;
      addBot((out&&out.html)||'没有找到相关内容');},80);}
  sendB.addEventListener('click',function(){ask(input.value);});
  input.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();ask(input.value);}});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&panel.classList.contains('open'))closeP();});
})();