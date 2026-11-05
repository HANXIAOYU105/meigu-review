/* 自动生成自 src/qa-engine.js + 面板交互 · 由 scripts/site.js 输出，勿手改 */
(function(){
/**
 * 问答引擎 v3（纯函数，无 DOM 依赖，可被 Node 直接测试）
 *
 * v3 升级（2026-11-06 用户反馈"更智能、更有针对性"）：
 *   1) 新意图：why 理由提炼 / change 立场变化 / ranking 博主排名 / sector 板块 / overview 数据概览
 *   2) 理由提炼：按标签库（估值/财报/AI资本开支/竞争/供应链/技术面/宏观/政治/资金/事件）聚合高频理由
 *   3) 立场翻转追踪：同一博主对同一标的最近两次立场不同 → 标「↑转多 / ↓转空」
 *   4) 共识价位：目标价/支撑/压力取中位数 + 数值个数 + 区间
 *   5) 板块问答：口语板块词（半导体/芯片/AI/光通信…）→ sector 字段匹配 → 板块情绪总览 + 分标的多空
 *   6) 概览问答："数据库里有什么" → 收录量/日期范围/近3日更新/热门标的
 *   7) 修复：中文模糊匹配误伤（"数据库"→Datadog）、博主+标的降级丢过滤、缺结论段
 *   8) 中文 bigram 检索兜底（替代整词 includes），停用字过滤
 *
 * 浏览器端：scripts/site.js 构建时去掉 export 后内联进 site/qa.js
 * Node 端：  import { answerQuery, greet } from './src/qa-engine.js'
 *
 * data（site/qa-data.json）结构：
 * { asOf, generatedAt, asOfIndices, siteBase, cutoff5,
 *   tickers: [{ ticker, name, aliases, sector, isHolding }],
 *   channels: [{ slug, name }],
 *   indices: [{ name, close, prevClose, pct, peak }],
 *   prices: { TICKER: { c, p, d5, hi, lo, at } },
 *   ops:  [{ d,t,n,h,c,g,s,a,hz,th,sup,res,tgt,ent,trg,url,title,ts,x }],
 *   sums: [{ d,c,g,tone,sm,t,u }] }
 * 返回：{ html, ctx }，ctx={tickers:[{ticker,name}], channel} 供追问（"那微软呢"）
 */

// ── 常量 ──
const ALIAS_BLACKLIST = new Set(['大盘', '市场', '指数', '美股', '股市', '板块', '行业']);

// 通用词：不参与中文模糊匹配（否则「数据库」会被「数据狗」距离1误命中）
const GENERIC_WORDS = ['数据库', '数据', '内容', '情况', '态度', '观点', '看法', '分析', '介绍', '怎么样', '什么', '哪些', '哪个', '谁', '最近', '最新', '今天', '昨天', '帮忙', '帮我', '请问', '问题', '东西', '资料', '信息', '一下', '多少', '有没有', '是什么', '怎么'];

// 口语板块词 → sector 字段包含匹配（覆盖「半导体存储」「半导体设备」等细分）
const SECTOR_MAP = [
  { re: /半导体|芯片|晶圆|晶片/, label: '半导体', kw: ['半导体'] },
  { re: /存储|内存|dram|nand/i, label: '存储', kw: ['存储'] },
  { re: /光通信|光模块|光芯片/, label: '光通信', kw: ['光通信', '光模块'] },
  { re: /人工智能|算力|大模型|ai/i, label: 'AI', kw: ['AI'] },
  { re: /软件|saas/i, label: '软件', kw: ['软件', 'SaaS'] },
  { re: /互联网|中概/, label: '互联网', kw: ['互联网'] },
  { re: /电动车|新能源车|汽车股|造车/, label: '电动车', kw: ['电动车', '出行'] },
  { re: /医药|医疗|生物|创新药/, label: '医药医疗', kw: ['医药', '医疗'] },
  { re: /能源|石油|油气|原油/, label: '能源', kw: ['能源'] },
  { re: /电力|核电|公用事业/, label: '电力核电', kw: ['电力', '核电'] },
  { re: /金融|银行|券商|投行|支付/, label: '金融', kw: ['银行', '券商', '投行', '支付', '金融'] },
  { re: /零售|消费|电商/, label: '消费零售', kw: ['零售', '消费', '电商'] },
  { re: /加密|比特币|btc|eth/i, label: '加密', kw: ['加密'] },
  { re: /量子/, label: '量子', kw: ['量子'] },
  { re: /航天|太空|卫星/, label: '航天', kw: ['航天'] },
  { re: /ETF|指数基金/i, label: 'ETF/指数', kw: ['ETF', '指数'] },
];

// 理由标签库（"为什么看空"→ 聚合高频理由；正则刻意避开「支撑/压力/跌破」等每条都有的通用词）
const REASON_TAGS = [
  ['估值/泡沫', /估值|泡沫|太贵|溢价|透支|市盈率|倍数|price.?to|valuation/i],
  ['财报/业绩', /财报|业绩|指引|营收|利润|eps|毛利率|净利|miss|beat|超预期|不及预期/i],
  ['AI 资本开支', /资本开支|capex|ai.?支出|算力|数据中心|订单|需求/i],
  ['竞争格局', /竞争|份额|对手|替代|价格战|国产|抢单/],
  ['供应链/产能', /供应链|产能|缺货|库存|交付|代工|nm|先进制程|扩产/],
  ['技术面', /均线|破位|突破|趋势线|形态|背离|超买|超卖|技术面|日线|周线|缺口|量能/],
  ['宏观/利率', /美联储|降息|加息|利率|通胀|cpi|就业|衰退|关税|宏观|国债|收益率/i],
  ['政治/政策', /川普|特朗普|选举|政策|监管|国会|民主|共和|白宫|制裁/],
  ['资金面/情绪', /资金|流入|流出|机构|散户|情绪|恐慌|贪婪|成交|缩量|放量|仓位/],
  ['公司事件', /回购|减持|增发|并购|合并|分拆|ceo|管理层|诉讼|召回|事故/i],
];

const LEVEL_DEFS = [
  ['sup', '支撑'],
  ['res', '压力'],
  ['tgt', '目标'],
  ['ent', '买点'],
  ['trg', '触发'],
];

const CHANNEL_SHORTS = [
  ['视野环球', '视野'], ['nana', '娜娜'], ['阳光财经', '阳光'], ['老李玩钱', '老李'],
  ['美投侃新闻', '美投'], ['猫姐', 'xtrader'], ['trading apologist', 'apologist'], ['investor channel', 'investor'],
];

// 中文停用字（bigram 检索用）
const STOP_CH = new Set('的了是在有和也就都而及与或这那我你他它很太更最又还再只个些么呢吧啊哦呀嘛把被给对从向于为以所之其此该每各某何谁哪啥怎怎样'.split(''));

// ── 基础工具 ──
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtD = (d) => { const p = String(d || '').split('-'); return p.length === 3 ? `${+p[1]}/${+p[2]}` : String(d || ''); };
const num1 = (v) => (v == null || !isFinite(v) ? '—' : (Math.round(v * 100) / 100).toLocaleString('en-US'));
/** 涨跌幅文本（null/undefined 显示 —，避免数据不足时误显示 +null%） */
const pctTxt = (v) => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v}%`);
const hasLevels = (o) => LEVEL_DEFS.some(([k]) => o[k]);

/** 立场 → 分值（强烈看多 2 / 看多 1 / 中性偏多 .5 / 中性 0 / 中性偏空 -.5 / 看空 -1 / 强烈看空 -2） */
function scoreOf(s) {
  const t = String(s || '');
  if (/强烈看多/.test(t)) return 2;
  if (/强烈看空/.test(t)) return -2;
  if (/中性偏多/.test(t)) return 0.5;
  if (/中性偏空/.test(t)) return -0.5;
  if (/看多|买入|增持/.test(t)) return 1;
  if (/看空|卖出|减仓|回避/.test(t)) return -1;
  return 0;
}
const stanceCls = (s) => (scoreOf(s) > 0.3 ? 'up' : scoreOf(s) < -0.3 ? 'down' : 'flat');
const leanText = (avg) => (avg > 0.3 ? '整体偏多' : avg < -0.3 ? '整体偏空' : '分歧/中性');
const leanCls = (avg) => (avg > 0.3 ? 'up' : avg < -0.3 ? 'down' : 'flat');

/** OSA 编辑距离（支持相邻换位），超过 max 提前返回 */
function editDist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  let prev2 = null, prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= n; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v; if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[n];
}

/** ascii 词边界匹配；len≥4 允许 OSA 距离 1 的错字（nvad→NVDA） */
function hasWord(hay, needle) {
  const h = String(hay).toLowerCase();
  const n = String(needle).toLowerCase();
  if (!n) return false;
  const ascii = /^[a-z0-9^.\-/]+$/i.test(n);
  if (!ascii) return fuzzyCjk(h, n);
  let i = -1;
  while ((i = h.indexOf(n, i + 1)) !== -1) {
    const before = i === 0 ? ' ' : h[i - 1];
    const after = i + n.length >= h.length ? ' ' : h[i + n.length];
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
  }
  if (n.length >= 4 && h.length <= 40) {
    const words = h.split(/[^a-z0-9]+/).filter(Boolean);
    for (const w of words) if (Math.abs(w.length - n.length) <= 1 && editDist(w, n, 1) <= 1) return true;
  }
  return false;
}

/** 中文错字容错：≥3 字的名称允许 1 个字打错；先剔除通用词，避免「数据库」误伤「数据狗」 */
function fuzzyCjk(hayRaw, n) {
  let h = String(hayRaw);
  for (const w of GENERIC_WORDS) h = h.split(w).join(' ');
  if (h.includes(n)) return true;
  if (n.length < 3) return false;
  if (GENERIC_WORDS.includes(n)) return false;
  for (let L = n.length - 1; L <= n.length + 1; L++) {
    for (let i = 0; i + L <= h.length; i++) {
      if (editDist(h.slice(i, i + L), n, 1) <= 1) return true;
    }
  }
  return false;
}

// ── 中文 bigram 检索 ──
function bigrams(raw) {
  const s = String(raw || '').toLowerCase();
  const out = new Set();
  for (const seg of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let i = 0; i < seg.length - 1; i++) {
      const a = seg[i], b = seg[i + 1];
      if (STOP_CH.has(a) && STOP_CH.has(b)) continue;
      out.add(a + b);
    }
  }
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  return out;
}
function gramScore(grams, text) {
  if (!grams.size) return 0;
  const t = String(text || '').toLowerCase();
  let hit = 0;
  for (const g of grams) if (t.includes(g)) hit++;
  return hit;
}

// ── 解析 ──
function parseQuery(data, raw, prevCtx) {
  const q = String(raw || '').trim();
  const ql = q.toLowerCase();
  const r = { tickers: [], channel: null, sector: null, date: null, dateRange: null, stance: null, market: false, intent: 'views', q, followedUp: false };

  const re = {
    why: /为什么|为何|凭什么|理由|原因|逻辑|依据|怎么会|哪来的|利空|利好/,
    change: /变化|变了|变没变|转向|转多|转空|调仓|立场.{0,4}(变|改)|态度.{0,4}(变|转)|有什么新|新动向/,
    ranking: /谁(最|更)|哪个博主(最|更|比较)|哪位(最|更)|最看好|最看空|最坚定|最准|排名|排行|榜单|榜首/,
    overview: /有什么$|收录|多少个|多少条|数据量|能问|可以问|怎么用|你是谁|介绍一下你|有什么功能|帮助|数据.{0,3}(概况|总览|全貌)|覆盖了/,
    compare: /对比|和.{1,12}(比|比较)|哪个更|谁更|\bvs\b|相比|两个(都|谁)|还是/,
    price: /多少钱|什么价|现价|股价|价格|涨了多少|跌了多少|涨了|跌了|涨幅|跌幅|行情(如何|怎么样)?$/,
    risk: /风险|危险|担心|恐慌|崩|会不会跌|要跌|要崩|回调|止损/,
    opportunity: /能买|可以买|该买|要不要买|入场|进场|抄底|机会|建仓|上车|加仓/,
    levels: /点位|支撑|压力|阻力|目标价?|触发|价位/,
  };

  // 1) 意图（优先级：理由 > 变化 > 排名 > 概览 > 对比 > 价格 > 风险 > 机会 > 点位）
  if (re.why.test(ql)) r.intent = 'why';
  else if (re.change.test(ql)) r.intent = 'change';
  else if (re.ranking.test(ql)) r.intent = 'ranking';
  else if (re.overview.test(ql) && !/怎么看|多少钱|观点|涨|跌/.test(ql)) r.intent = 'overview';
  else if (re.compare.test(ql)) r.intent = 'compare';
  else if (re.price.test(ql)) r.intent = 'price';
  else if (re.risk.test(ql)) r.intent = 'risk';
  else if (re.opportunity.test(ql)) r.intent = 'opportunity';
  else if (re.levels.test(ql)) r.intent = 'levels';
  if (/看多|做多|买入|增持|bullish|长多|看好|抄底/.test(ql)) r.stance = 'long';
  else if (/看空|做空|卖出|减仓|bearish|回避|清仓/.test(ql)) r.stance = 'short';
  else if (/中性|观望/.test(ql)) r.stance = 'flat';

  // 2) 大盘意图（排除站点名类词）
  r.market = (/大盘|整个市场|市场情绪|整体走势/.test(ql) || /^\s*美股.{0,6}(怎么样|如何|走势|行情|怎么看)?\s*$/.test(ql)) && !/博主|复盘|日报|档案|网站/.test(ql);

  // 3) 日期：昨天/前天/上周/11月3日/11.3（"最近/最新"只影响排序，不再强设日期过滤）
  const allDates = [...new Set([...data.ops.map((o) => o.d), ...data.sums.map((s) => s.d)])].filter(Boolean).sort();
  const idxOf = (d) => allDates.indexOf(d);
  if (/昨天/.test(ql)) { const i = idxOf(data.asOf); r.date = i > 0 ? allDates[i - 1] : data.asOf; }
  else if (/前天/.test(ql)) { const i = idxOf(data.asOf); r.date = i > 1 ? allDates[i - 2] : data.asOf; }
  else if (/上周/.test(ql)) {
    const i = idxOf(data.asOf);
    if (i > 5) r.dateRange = [allDates[Math.max(0, i - 9)], allDates[Math.max(0, i - 4)]];
  } else {
    const m = ql.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/) || ql.match(/(\d{1,2})[.\/](\d{1,2})/);
    if (m) {
      const mo = +m[1], da = +m[2];
      const hit = allDates.find((d) => { const p = d.split('-'); return +p[1] === mo && +p[2] === da; });
      if (hit) r.date = hit;
    }
  }

  // 4) 频道
  for (const ch of data.channels || []) {
    const nm = String(ch.name || '').toLowerCase();
    if (nm.length >= 2 && ql.includes(nm)) { r.channel = ch; break; }
    const hit = CHANNEL_SHORTS.some(([full, short]) => (nm.includes(full) || nm.includes(short)) && (ql.includes(full) || ql.includes(short)));
    if (hit) { r.channel = ch; break; }
  }

  // 5) 标的（ticker/名称/别名，长词优先；黑名单跳过）
  const keys = [];
  for (const t of data.tickers || []) {
    keys.push({ t, key: t.ticker });
    if (t.name) keys.push({ t, key: t.name });
    for (const a of t.aliases || []) if (!ALIAS_BLACKLIST.has(String(a).toLowerCase())) keys.push({ t, key: a });
  }
  keys.sort((a, b) => b.key.length - a.key.length);
  const seen = new Set();
  for (const k of keys) {
    if (r.tickers.length >= 3) break;
    if (seen.has(k.t.ticker)) continue;
    if (hasWord(ql, k.key)) { r.tickers.push(k.t); seen.add(k.t.ticker); }
  }

  // 6) 板块（无具体标的、或问的是板块整体时才启用）
  if (!r.tickers.length || /板块|行业|整体|都|们/.test(ql)) {
    for (const s of SECTOR_MAP) {
      if (!s.re.test(ql)) continue;
      const list = (data.tickers || []).filter((t) => s.kw.some((k) => String(t.sector || '').includes(k)));
      if (list.length >= 2) { r.sector = { label: s.label, tickers: list }; break; }
    }
  }

  // 7) 追问："那微软呢"/"它呢"/"换成英伟达" —— 没抓到实体但带承接词时沿用上一轮
  if (!r.tickers.length && !r.channel && !r.sector && prevCtx && (/[呢吗嘛？?]\s*$/.test(q) && q.length <= 12 || /那|它|他|该股|这只|还是/.test(ql))) {
    r.followedUp = true;
    if (prevCtx.tickers?.length) r.tickers = prevCtx.tickers;
    if (prevCtx.channel) r.channel = prevCtx.channel;
  }
  return r;
}

// ── 聚合 ──
const levelsOf = (o) => LEVEL_DEFS.map(([k, label]) => (o[k] ? { label, text: o[k] } : null)).filter(Boolean);

/** 多空统计 */
function statsOf(ops) {
  let score = 0, up = 0, down = 0, flat = 0;
  for (const o of ops) {
    const s = scoreOf(o.s);
    score += s;
    if (s > 0.3) up++; else if (s < -0.3) down++; else flat++;
  }
  return { n: ops.length, avg: ops.length ? score / ops.length : 0, up, down, flat };
}

/** 理由提炼：按标签库统计高频理由，样例取原文中命中位置附近片段（更有针对性） */
function reasonTags(ops, dir = 0) {
  const match = (o) => (dir > 0 ? scoreOf(o.s) > 0.3 : dir < 0 ? scoreOf(o.s) < -0.3 : true);
  let scope = ops.filter(match);
  if (!scope.length) scope = ops;
  const cnt = new Map(), sample = new Map();
  for (const o of scope) {
    const text = String(o.th || '');
    const hay = `${text} ${o.title || ''}`;
    const hit = new Set();
    for (const [label, re] of REASON_TAGS) {
      const m = hay.match(re);
      if (!m) continue;
      hit.add(label);
      if (!sample.has(label)) {
        const i = text.indexOf(m[0]);
        sample.set(label, i >= 0 ? `${i > 20 ? '…' : ''}${text.slice(Math.max(0, i - 20), i + 55)}` : text.slice(0, 70));
      }
    }
    for (const h of hit) cnt.set(h, (cnt.get(h) || 0) + 1);
  }
  const list = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([label, n]) => ({ label, n, sample: sample.get(label) }));
  return { list, total: scope.length };
}

/** 共识价位：目标价/支撑/压力/买点 → 中位数 + 数值个数 + 区间（先剔除离群噪音，如「15.5倍PE」「27年」） */
function consensus(ops) {
  const pick = (key) => {
    const vals = [];
    for (const o of ops) {
      if (!o[key]) continue;
      for (const n of String(o[key]).match(/\d+(?:\.\d+)?/g) || []) {
        const x = +n;
        if (x > 0 && x < 1e6) vals.push(x);
      }
    }
    if (vals.length < 2) return vals.length ? { med: vals[0], min: vals[0], max: vals[0], n: 1 } : null;
    const mid = (arr) => arr[Math.floor(arr.length / 2)];
    const sorted = [...vals].sort((a, b) => a - b);
    const m0 = mid(sorted);
    // 离群过滤：只保留中位数 0.4~2.5 倍区间内的值，再取一次中位
    const kept = sorted.filter((v) => v >= m0 * 0.4 && v <= m0 * 2.5);
    const use = kept.length ? kept : sorted;
    return { med: mid(use), min: use[0], max: use[use.length - 1], n: use.length };
  };
  return { tgt: pick('tgt'), sup: pick('sup'), res: pick('res'), ent: pick('ent') };
}

/** 立场翻转：同一博主对「同一标的」相邻两次观点比较（key=频道+标的，避免跨标的误判）
 *  kind: flip=方向改变（看多↔看空/中性）/ strengthen=同向加强 / weaken=同向减弱 */
function flipMap(ops) {
  const m = new Map();
  const byKey = new Map();
  const asc = [...ops].sort((a, b) => String(a.d).localeCompare(String(b.d)));
  for (const o of asc) {
    const key = `${o.c}|${o.t}`;
    const prev = byKey.get(key);
    if (prev) {
      const d = scoreOf(o.s) - scoreOf(prev.s);
      const s0 = scoreOf(prev.s), s1 = scoreOf(o.s);
      const dirChanged = (s0 > 0.3 && s1 < -0.3) || (s0 < -0.3 && s1 > 0.3) || (Math.abs(s0) <= 0.3 && Math.abs(s1) > 0.3) || (Math.abs(s0) > 0.3 && Math.abs(s1) <= 0.3);
      if (dirChanged && Math.abs(d) >= 0.9) m.set(o, { kind: 'flip', d, prev });
      else if (!dirChanged && Math.abs(d) >= 0.9) m.set(o, { kind: d > 0 ? 'strengthen' : 'weaken', d, prev });
    }
    byKey.set(key, o);
  }
  return m;
}

/** 翻转标签 HTML（flip 才叫转多/转空，同向变化叫增强/减弱） */
function flipTag(flip) {
  if (!flip) return '';
  const [cls, txt] = flip.kind === 'flip'
    ? [flip.d > 0 ? 'up' : 'down', flip.d > 0 ? '↑ 转多' : '↓ 转空']
    : flip.kind === 'strengthen' ? ['up', '↑ 增强'] : ['down', '↓ 减弱'];
  return `<span class="qa-flip ${cls}" title="上一次（${fmtD(flip.prev.d)}）为「${esc(flip.prev.s)}」">${txt}</span>`;
}

/** 相关度排序：新日期优先，持仓加权，带点位加权 */
function rankOps(ops) {
  const dates = [...new Set(ops.map((o) => o.d))].sort().reverse();
  const rank = new Map(dates.map((d, i) => [d, i]));
  return [...ops].sort((a, b) => (rank.get(b.d) - rank.get(a.d)) || (b.h - a.h) || ((hasLevels(b) ? 1 : 0) - (hasLevels(a) ? 1 : 0)));
}

// ── 渲染 ──
function opCard(o, flip) {
  const lvs = levelsOf(o);
  const link = o.url
    ? (o.x || o.ts == null
        ? `<a class="qa-link" href="${esc(o.url)}" target="_blank" rel="noopener">🔗 查看原文 →</a>`
        : `<a class="qa-link" href="${esc(o.url)}&t=${o.ts}s" target="_blank" rel="noopener">⏱ ${Math.floor(o.ts / 60)}分${Math.round(o.ts % 60)}秒 回看 →</a>`)
    : '';
  const flipHtml = flipTag(flip);
  return `<div class="qa-op">
    <div class="qa-op-h"><span class="qa-ch">${esc(o.c)}${o.x ? '<i class="qa-x">X</i>' : ''}</span><span class="qa-date">${fmtD(o.d)}</span>${flipHtml}
      <span class="qa-st ${stanceCls(o.s)}">${esc(o.s)}${o.a ? '/' + esc(o.a) : ''}${o.hz ? '·' + esc(o.hz) : ''}</span></div>
    ${lvs.length ? `<div class="qa-lv">${lvs.map((l) => `<span class="qa-lvi">${esc(l.label)} <b>${esc(l.text)}</b></span>`).join('')}</div>` : ''}
    ${o.th ? `<div class="qa-th">${esc(o.th)}</div>` : ''}
    ${link ? `<div class="qa-act">${link}</div>` : ''}
  </div>`;
}

function summaryCard(s) {
  return `<div class="qa-op">
    <div class="qa-op-h"><span class="qa-ch">${esc(s.c)}</span><span class="qa-date">${fmtD(s.d)}</span>
      <span class="qa-st ${s.tone === '偏多' ? 'up' : s.tone === '偏空' ? 'down' : 'flat'}">${esc(s.tone || '中性')}</span></div>
    ${s.sm ? `<div class="qa-th">${esc(s.sm)}</div>` : ''}
    ${s.u ? `<div class="qa-act"><a class="qa-link" href="${esc(s.u)}" target="_blank" rel="noopener">🔗 原视频 →</a></div>` : ''}
  </div>`;
}

function indicesBlock(data) {
  const idx = data.indices || [];
  if (!idx.length) return '';
  return `<div class="qa-idx">${idx.map((i) => {
    const up = (i.pct ?? 0) >= 0;
    return `<span class="qa-idx-i"><b>${esc(i.name)}</b> <span class="${up ? 'up' : 'down'}">${num1(i.close)}（${up ? '+' : ''}${i.pct ?? '—'}%）</span></span>`;
  }).join('')}</div><div class="qa-note">截至 ${esc(fmtD(data.asOfIndices || data.asOf))} 美东收盘</div>`;
}

const capNote = (n, cap) => (n > cap ? `<div class="qa-note">仅显示最近 ${cap} 条 · 共 ${n} 条</div>` : '');

/** 点位一览（紧凑行式：标签 + 数值 + 给出者/日期） */
function levelBoard(ops) {
  const rows = [];
  for (const o of ops) for (const l of levelsOf(o)) rows.push({ o, l });
  rows.sort((a, b) => String(b.o.d).localeCompare(String(a.o.d)));
  return `<div class="qa-h">🎯 点位一览（${rows.length} 条）</div>` +
    rows.slice(0, 14).map((r) => `<div class="qa-reason"><span class="qa-tag">${esc(r.l.label)}</span><span class="qa-reason-txt"><b>${esc(r.l.text)}</b> · ${esc(r.o.c)} ${fmtD(r.o.d)}</span></div>`).join('') +
    (rows.length > 14 ? `<div class="qa-note">仅显示最近 14 条 · 共 ${rows.length} 条点位记录</div>` : '');
}

/** 价格一行（最新价 + 当日 + 5日 + 60日位置；数据不足的项自动省略） */
function priceLine(pr) {
  if (!pr) return '';
  const out = [`<span class="qa-lvi">最新 <b>${num1(pr.c)}</b></span>`];
  if (pr.p != null) out.push(`<span class="qa-lvi">当日 <b class="${pr.p >= 0 ? 'qup' : 'qdn'}">${pctTxt(pr.p)}</b></span>`);
  if (pr.d5 != null) out.push(`<span class="qa-lvi">近5日 <b class="${pr.d5 >= 0 ? 'qup' : 'qdn'}">${pctTxt(pr.d5)}</b></span>`);
  if (pr.hi != null && pr.lo != null && pr.hi > pr.lo) {
    const pos = Math.round(((pr.c - pr.lo) / (pr.hi - pr.lo)) * 100);
    const zone = pos >= 70 ? '区间上部' : pos <= 30 ? '区间下部' : '区间中部';
    out.push(`<span class="qa-lvi">60日 ${pr.lo}~${pr.hi}（${zone} ${pos}%）</span>`);
  }
  return `<div class="qa-lv">${out.join('')}</div>`;
}

/** 标的结论段：多空分布 + 最新价 + 共识价位 + 最近翻转 */
function leadCard(data, t, ops, extra) {
  const st = statsOf(ops);
  const pr = (data.prices || {})[t.ticker];
  const cs = consensus(ops);
  const flip = flipMap(ops);
  let flipTxt = '';
  if (flip.size) {
    // 优先展示「方向改变」的最近一条，其次同向强度变化
    const arr = [...flip.entries()].sort((a, b) => {
      const ka = a[1].kind === 'flip' ? 1 : 0, kb = b[1].kind === 'flip' ? 1 : 0;
      return kb - ka || String(b[0].d).localeCompare(String(a[0].d));
    });
    const x = arr[0];
    const w = x[1].kind === 'flip' ? '转为' : x[1].d > 0 ? '加强为' : '减弱为';
    flipTxt = `<div class="qa-note">🔄 最近变化：${esc(x[0].c)} ${fmtD(x[0].d)} 由「${esc(x[1].prev.s)}」${w}「${esc(x[0].s)}」${x[0].a ? '（' + esc(x[0].a) + '）' : ''}</div>`;
  }
  const csTxt = cs.tgt
    ? `<div class="qa-note">🎯 共识目标价${cs.tgt.n === 1 ? '' : '中位'} <b>${cs.tgt.med}</b>（${cs.tgt.n === 1 ? '1 处' : `${cs.tgt.n} 个数值，范围 ${cs.tgt.min}~${cs.tgt.max}`}）</div>`
    : '';
  return `<div class="qa-sum">${esc(t.name)}（${esc(t.ticker)}）${extra || ''}共 <b>${st.n}</b> 条观点：看多 <b class="qup">${st.up}</b> · 看空 <b class="qdn">${st.down}</b> · 中性 ${st.flat} → <span class="qa-lean ${leanCls(st.avg)}">${leanText(st.avg)}</span>
    ${pr ? priceLine(pr) : ''}${csTxt}${flipTxt}</div>`;
}

/** 理由提炼段 */
function reasonBlock(ops, dir, title) {
  const { list, total } = reasonTags(ops, dir);
  if (!list.length) return '';
  return `<div class="qa-h">${title}</div>` +
    list.map((x) => `<div class="qa-reason"><span class="qa-tag">${esc(x.label)} ×${x.n}</span><span class="qa-reason-txt">${esc(String(x.sample).slice(0, 110))}${String(x.sample).length > 110 ? '…' : ''}</span></div>`).join('') +
    `<div class="qa-note">基于 ${total} 条${dir < 0 ? '看空' : dir > 0 ? '看多' : ''}观点的逻辑归纳（同一条提及多个角度会重复计数）</div>`;
}

/** 观点列表（带翻转标签） */
function opSection(ops, cap = 10, levelsFirst = false) {
  if (!ops.length) return '';
  let list = rankOps(ops);
  if (levelsFirst) list = [...list.filter(hasLevels), ...list.filter((o) => !hasLevels(o))];
  const shown = list.slice(0, cap);
  const flip = flipMap(ops);
  return shown.map((o) => opCard(o, flip.get(o))).join('') + capNote(ops.length, cap);
}

/** 博主排名榜（dir>0 看多榜 / <0 看空榜） */
function rankBoard(ops, dir) {
  const byCh = new Map();
  for (const o of ops) {
    if (!byCh.has(o.c)) byCh.set(o.c, []);
    byCh.get(o.c).push(o);
  }
  const rows = [...byCh.entries()].map(([ch, list]) => {
    const st = statsOf(list);
    const sorted = [...list].sort((a, b) => String(b.d).localeCompare(String(a.d)));
    return { ch, st, last: sorted[0] };
  }).sort((a, b) => (dir > 0 ? b.st.avg - a.st.avg || b.st.n - a.st.n : a.st.avg - b.st.avg || b.st.n - a.st.n));
  const medal = ['①', '②', '③', '④', '⑤'];
  return rows.slice(0, 5).map((x, i) => `<div class="qa-op">
      <div class="qa-op-h"><span class="qa-ch">${medal[i]} ${esc(x.ch)}</span><span class="qa-date">${x.st.n} 条</span>
        <span class="qa-st ${leanCls(x.st.avg)}">${leanText(x.st.avg)} ${x.st.avg > 0 ? '+' : ''}${x.st.avg.toFixed(2)}</span></div>
      <div class="qa-th">最新 ${fmtD(x.last.d)}：${esc(x.last.s)}${x.last.a ? '/' + esc(x.last.a) : ''}${x.last.th ? ' — ' + esc(String(x.last.th).slice(0, 90)) : ''}</div>
    </div>`).join('');
}

function helpHtml(data) {
  const seen = new Set();
  const holdChips = [];
  for (const t of data.tickers || []) {
    if (!t.isHolding || seen.has(t.name)) continue;
    seen.add(t.name);
    holdChips.push(`<button class="qa-chip" data-q="${esc(t.name)}怎么看">${esc(t.name)}</button>`);
    if (holdChips.length >= 5) break;
  }
  const ex = ['英伟达现在多少钱', '为什么看空特斯拉', '最近有什么变化', '谁最看好台积电', '半导体板块怎么看', '英伟达和AMD哪个更被看好']
    .map((x) => `<button class="qa-chip" data-q="${x}">${x}</button>`).join('');
  return `<div class="qa-h">可以这样问我 👇</div>
  <div class="qa-chips">${holdChips.join('')}${ex}</div>
  <div class="qa-note">支持：观点 / 点位 / 价格 / 风险 / 看多理由 / 立场变化 / 博主排名 / 板块汇总 / 标的对比 / 某天复盘 / 追问（"那微软呢"）。数据：${(data.ops || []).length} 条观点 · ${(data.sums || []).length} 期综述。</div>`;
}

/** 数据概览 */
function overviewAnswer(data) {
  const ops = data.ops || [];
  const dates = [...new Set(ops.map((o) => o.d))].filter(Boolean).sort();
  const byDate = new Map();
  for (const o of ops) byDate.set(o.d, (byDate.get(o.d) || 0) + 1);
  const recent = dates.slice(-3).reverse().map((d) => `<span class="qa-lvi">${fmtD(d)} · <b>${byDate.get(d)}</b> 条</span>`).join('');
  const tickCount = new Map();
  for (const o of ops) tickCount.set(o.t, (tickCount.get(o.t) || 0) + 1);
  const hot = [...tickCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const nameOf = new Map((data.tickers || []).map((t) => [t.ticker, t.name]));
  const hotChips = hot.map(([tk, n]) => `<button class="qa-chip" data-q="${esc(nameOf.get(tk) || tk)}怎么看">${esc(nameOf.get(tk) || tk)} · ${n}</button>`).join('');
  return `<div class="qa-sum">📚 数据库已收录 <b>${ops.length}</b> 条观点 + <b>${(data.sums || []).length}</b> 期大盘综述，覆盖 <b>${(data.channels || []).length}</b> 位博主 · <b>${(data.tickers || []).length}</b> 个标的${dates.length ? `，时间范围 <b>${fmtD(dates[0])} ~ ${fmtD(dates[dates.length - 1])}</b>` : ''}。</div>
  <div class="qa-h">📅 最近 3 日更新</div><div class="qa-lv">${recent}</div>
  <div class="qa-h">🔥 最受关注标的</div><div class="qa-chips">${hotChips}</div>
  ${helpHtml(data)}`;
}

/** 板块总览 */
function sectorAnswer(data, sector, p) {
  const set = new Set(sector.tickers.map((t) => t.ticker));
  const ops = (data.ops || []).filter((o) => set.has(o.t));
  if (!ops.length) return { html: `<div class="qa-note">「${esc(sector.label)}」板块在数据库中暂无观点记录。</div>` + helpHtml(data), ctx: {} };
  const st = statsOf(ops);
  const byT = new Map();
  for (const o of ops) {
    if (!byT.has(o.t)) byT.set(o.t, []);
    byT.get(o.t).push(o);
  }
  const nameOf = new Map((data.tickers || []).map((t) => [t.ticker, t.name]));
  const rows = [...byT.entries()].map(([tk, list]) => ({ tk, name: nameOf.get(tk) || tk, s: statsOf(list), list, pr: (data.prices || {})[tk] }))
    .sort((a, b) => b.s.n - a.s.n);
  const rowHtml = rows.map((x) => `<div class="qa-op">
      <div class="qa-op-h"><span class="qa-ch">${esc(x.name)}</span><span class="qa-date">${esc(x.tk)} · ${x.s.n} 条</span>
        <span class="qa-st ${leanCls(x.s.avg)}">${leanText(x.s.avg)}</span></div>
      <div class="qa-note" style="margin:2px 0 0">看多 ${x.s.up} · 看空 ${x.s.down} · 中性 ${x.s.flat}${x.pr ? ` · 最新 ${num1(x.pr.c)}${x.pr.d5 != null ? `（5日 ${pctTxt(x.pr.d5)}）` : ''}` : ''}</div>
    </div>`).join('');
  const cs = consensus(ops);
  const csTxt = cs.tgt ? `<div class="qa-note">🎯 板块内共识目标价中位 <b>${cs.tgt.med}</b>（${cs.tgt.n} 个数值）</div>` : '';
  const html = `<div class="qa-sum">「${esc(sector.label)}」板块（${rows.length} 个标的）共 <b>${st.n}</b> 条观点：看多 <b class="qup">${st.up}</b> · 看空 <b class="qdn">${st.down}</b> · 中性 ${st.flat} → <span class="qa-lean ${leanCls(st.avg)}">${leanText(st.avg)}</span>
    最受关注：<b>${esc(rows[0].name)}</b>（${rows[0].s.n} 条）${rows[1] ? '、' + esc(rows[1].name) + `（${rows[1].s.n} 条）` : ''}${csTxt}</div>
    <div class="qa-h">📊 分标的多空</div>${rowHtml}
    ${reasonBlock(ops, 0, '🧠 板块关注点')}
    <div class="qa-h">🎬 代表观点</div>${opSection(ops, 8)}`;
  return { html, ctx: {} };
}

/** 变化报告（全局）：只把「方向改变」算实质转向，分「强反转 / 普通转向」两档 */
function changeAnswer(data, p) {
  const ops = data.ops || [];
  const dates = [...new Set(ops.map((o) => o.d))].filter(Boolean).sort();
  const latest = p.date || dates[dates.length - 1];
  const recentCut = dates[Math.max(0, dates.length - 4)] || latest;
  const scope = ops.filter((o) => o.d >= recentCut && (!p.channel || o.c === p.channel.name));
  const flip = flipMap(scope);
  const all = [...flip.entries()].map(([o, f]) => ({ o, f }));
  const turns = all.filter((x) => x.f.kind === 'flip').sort((a, b) => Math.abs(b.f.d) - Math.abs(a.f.d) || String(b.o.d).localeCompare(String(a.o.d)));
  const toUp = turns.filter((x) => x.f.d > 0);
  const toDown = turns.filter((x) => x.f.d < 0);
  const strong = turns.filter((x) => Math.abs(x.f.d) >= 1.9);
  const weak = turns.filter((x) => Math.abs(x.f.d) < 1.9);
  const soft = all.length - turns.length;
  const nameOf = new Map((data.tickers || []).map((t) => [t.ticker, t.name]));
  const fmtFlip = (x) => `<div class="qa-op">
      <div class="qa-op-h"><span class="qa-ch">${esc(x.o.c)}</span>${flipTag(x.f)}
        <span class="qa-date">${esc(nameOf.get(x.o.t) || x.o.t)} · ${fmtD(x.o.d)}</span>
        <span class="qa-st ${stanceCls(x.o.s)}">${esc(x.o.s)}</span></div>
      <div class="qa-th">${esc(String(x.o.th || '').slice(0, 110))}${x.f.prev.th ? `<br><span style="color:var(--muted);font-size:11.5px">上次 ${fmtD(x.f.prev.d)}「${esc(x.f.prev.s)}」：${esc(String(x.f.prev.th).slice(0, 80))}…</span>` : ''}</div>
    </div>`;
  const prevSet = new Set(ops.filter((o) => o.d < latest).map((o) => o.t));
  const newTickers = [...new Set(ops.filter((o) => o.d === latest && !prevSet.has(o.t)).map((o) => o.t))];
  const latestOps = ops.filter((o) => o.d === latest);
  // 标的层面聚合：多人同向转向 = 板块/个股信号
  const byTick = new Map();
  for (const x of turns) {
    if (!byTick.has(x.o.t)) byTick.set(x.o.t, { up: 0, down: 0 });
    const v = byTick.get(x.o.t);
    if (x.f.d > 0) v.up++; else v.down++;
  }
  const consensusTurns = [...byTick.entries()].filter(([, v]) => Math.max(v.up, v.down) >= 2)
    .sort((a, b) => Math.max(b[1].up, b[1].down) - Math.max(a[1].up, a[1].down)).slice(0, 4)
    .map(([tk, v]) => `${esc(nameOf.get(tk) || tk)}${v.up > v.down ? ` <b class="qup">${v.up} 人转多</b>` : ` <b class="qdn">${v.down} 人转空</b>`}`);
  const html = `<div class="qa-sum">🔄 近 4 个交易日（${fmtD(recentCut)} ~ ${fmtD(latest)}）共 <b>${turns.length}</b> 处实质转向：<b>强反转 ${strong.length} 处</b>（看空↔看多）、弱转向 ${weak.length} 处（方向与中性之间切换）；其中转多 <b class="qup">${toUp.length}</b> / 转空 <b class="qdn">${toDown.length}</b>。${soft ? `<span class="qa-note" style="display:inline">另有 ${soft} 处同向增强/减弱未计入。</span>` : ''}
    ${newTickers.length ? `<div class="qa-note">🆕 新进标的：<b>${newTickers.slice(0, 5).map((x) => esc(nameOf.get(x) || x)).join('、')}</b></div>` : ''}
    ${consensusTurns.length ? `<div class="qa-note">👥 多人同向：${consensusTurns.join('、')}</div>` : ''}
    <div class="qa-note" style="margin:6px 0 0">最新交易日 ${fmtD(latest)} 共 ${latestOps.length} 条观点。</div></div>
    ${strong.length ? `<div class="qa-h">🔥 强反转（${strong.length}）</div>${strong.slice(0, 5).map(fmtFlip).join('')}` : ''}
    ${toUp.length ? `<div class="qa-h">📈 转多（${toUp.length}）</div>${toUp.slice(0, 4).map(fmtFlip).join('')}` : ''}
    ${toDown.length ? `<div class="qa-h">📉 转空（${toDown.length}）</div>${toDown.slice(0, 4).map(fmtFlip).join('')}` : ''}
    ${!turns.length ? '<div class="qa-note">近 4 个交易日没有捕捉到明确的立场转向。</div>' : ''}
    <div class="qa-h">🎬 ${fmtD(latest)} 主要观点</div>${opSection(latestOps, 8)}`;
  return { html, ctx: {} };
}

// ── 主入口 ──
function greet(data) {
  const seen = new Set();
  const chips = [];
  for (const t of data.tickers || []) {
    if (!t.isHolding || seen.has(t.name)) continue;
    seen.add(t.name);
    chips.push(`<button class="qa-chip" data-q="${esc(t.name)}怎么看">${esc(t.name)}</button>`);
    if (chips.length >= 5) break;
  }
  chips.push('<button class="qa-chip" data-q="最近有什么变化">最近有什么变化</button>');
  chips.push('<button class="qa-chip" data-q="半导体板块怎么看">半导体板块</button>');
  return `<div class="qa-h">👋 我基于每日爬取的博主观点数据库回答</div>
  <div class="qa-note">已收录 <b>${(data.ops || []).length}</b> 条观点 · <b>${(data.sums || []).length}</b> 期大盘综述 · 数据截至 <b>${fmtD(data.asOf)}</b>。<br>能问：观点 / 点位 / 价格 / 风险 / <b>看多看空理由</b> / <b>谁最看好</b> / <b>最近有什么变化</b> / <b>某个板块</b> / 标的对比，也支持追问。</div>
  <div class="qa-chips">${chips.join('')}</div>`;
}

/** 主入口：返回 { html, ctx } */
function answerQuery(data, raw, prevCtx) {
  const p = parseQuery(data, raw, prevCtx);
  const ctx = { tickers: p.tickers, channel: p.channel };

  // ── 数据概览 ──
  if (p.intent === 'overview') return { html: overviewAnswer(data), ctx: {} };

  // ── 变化（全局）──
  if (p.intent === 'change' && !p.tickers.length) return changeAnswer(data, p);

  // ── 大盘（排除具体标的/板块提问）──
  if (p.market && !p.tickers.length && !p.sector) {
    const parts = [indicesBlock(data)];
    const byCh = new Map();
    for (const s of data.sums) if (!byCh.has(s.c)) byCh.set(s.c, s);
    const latest = [...byCh.values()].sort((a, b) => String(b.d).localeCompare(a.d)).slice(0, 8);
    parts.push(latest.length ? `<div class="qa-h">各位博主最新大盘研判</div>` + latest.map(summaryCard).join('') : '<div class="qa-note">数据库中暂无大盘综述。</div>');
    const fakeOps = data.sums.map((s) => ({ th: s.sm, s: s.tone }));
    if (reasonTags(fakeOps, 0).list.length) parts.push(reasonBlock(fakeOps, 0, '🧠 大盘关注点'));
    return { html: parts.join(''), ctx };
  }

  // ── 板块 ──
  if (p.sector && !p.tickers.length) return sectorAnswer(data, p.sector, p);

  // ── 命中率 ──
  if (/命中|胜率|准不准|准确/.test(p.q)) {
    return { html: `<div class="qa-h">🎯 博主命中率</div><div class="qa-note">命中率追踪页按「观点发布后 5 个交易日」用实际行情自动验证每位博主的方向/支撑/目标判定：</div><div class="qa-act"><a class="qa-link" href="${esc(data.siteBase || '/')}track-record.html" target="_blank" rel="noopener">打开 🎯 命中率追踪 →</a></div>`, ctx };
  }

  // ── 标的对比 ──
  if (p.intent === 'compare' && p.tickers.length >= 2) {
    const [a, b] = p.tickers.slice(0, 2);
    const opsA = data.ops.filter((o) => o.t === a.ticker);
    const opsB = data.ops.filter((o) => o.t === b.ticker);
    const sA = statsOf(opsA), sB = statsOf(opsB);
    const prA = (data.prices || {})[a.ticker], prB = (data.prices || {})[b.ticker];
    const csA = consensus(opsA), csB = consensus(opsB);
    const cmp = (label, va, vb) => `<div class="qa-lvi" style="display:block">${esc(label)}：<b>${va}</b> vs <b>${vb}</b></div>`;
    const verdict = Math.abs(sA.avg - sB.avg) < 0.15
      ? `两者情绪接近（${leanText(sA.avg)} vs ${leanText(sB.avg)}），不分伯仲`
      : `${sA.avg > sB.avg ? esc(a.name) : esc(b.name)} 更被看好（多空得分 ${sA.avg.toFixed(2)} vs ${sB.avg.toFixed(2)}）`;
    return {
      html: `<div class="qa-sum">⚖️ ${esc(a.name)} vs ${esc(b.name)}：<b>${verdict}</b></div>
        <div class="qa-lv" style="flex-direction:column;align-items:flex-start;gap:3px">
          ${cmp('观点条数', `${sA.n} 条（多${sA.up}/空${sA.down}/中${sA.flat}）`, `${sB.n} 条（多${sB.up}/空${sB.down}/中${sB.flat}）`)}
          ${prA || prB ? cmp('最新价', prA ? `${num1(prA.c)}${prA.d5 != null ? `（5日 ${pctTxt(prA.d5)}）` : ''}` : '—', prB ? `${num1(prB.c)}${prB.d5 != null ? `（5日 ${pctTxt(prB.d5)}）` : ''}` : '—') : ''}
          ${csA.tgt || csB.tgt ? cmp('共识目标价中位', csA.tgt ? String(csA.tgt.med) : '—', csB.tgt ? String(csB.tgt.med) : '—') : ''}
        </div>
        <div class="qa-h">${esc(a.name)}（${esc(a.ticker)}）</div>${opSection(opsA, 3)}
        <div class="qa-h">${esc(b.name)}（${esc(b.ticker)}）</div>${opSection(opsB, 3)}`,
      ctx,
    };
  }

  // ── 标的（views/price/risk/opportunity/levels/why/change/ranking 共用）──
  if (p.tickers.length) {
    const parts = [];
    for (const t of p.tickers.slice(0, 2)) {
      let all = data.ops.filter((o) => o.t === t.ticker);
      if (p.channel) all = all.filter((o) => o.c === p.channel.name);
      const inRange = (o) => (p.date ? o.d === p.date : p.dateRange ? (o.d >= p.dateRange[0] && o.d <= p.dateRange[1]) : true);
      const stanceOk = (o) => (p.stance === 'long' ? scoreOf(o.s) > 0.3 : p.stance === 'short' ? scoreOf(o.s) < -0.3 : p.stance === 'flat' ? Math.abs(scoreOf(o.s)) <= 0.3 : true);
      const scoped = all.filter(inRange).filter(stanceOk);
      const recent5 = scoped.filter((o) => o.d >= (data.cutoff5 || ''));
      const base = recent5.length ? recent5 : scoped;
      const head = `${t.name}（${t.ticker}）${t.isHolding ? '⭐' : ''}${p.channel ? ` — 博主「${p.channel.name}」` : ''}`;
      const rangeTxt = p.channel ? `博主「${p.channel.name}」近 5 日` : '';

      // 排名
      if (p.intent === 'ranking') {
        const dir = /看空|最差|最不看好/.test(p.q) ? -1 : 1;
        parts.push(`<div class="qa-h">🏆 ${esc(head)} · ${dir > 0 ? '最看好' : '最看空'}排行榜</div>`);
        parts.push(rankBoard(base, dir));
        parts.push(`<div class="qa-h">🎬 观点明细</div>` + opSection(base, 6));
        continue;
      }

      // 变化（单标的）
      if (p.intent === 'change') {
        const flip = flipMap(base);
        const allFlips = [...flip.entries()].sort((a, b) => String(b[0].d).localeCompare(String(a[0].d)));
        const turns = allFlips.filter(([, f]) => f.kind === 'flip');
        const soft = allFlips.filter(([, f]) => f.kind !== 'flip');
        parts.push(leadCard(data, t, base, ''));
        if (turns.length) {
          parts.push(`<div class="qa-h">🔄 ${esc(t.name)}的立场转向（${turns.length} 处）</div>`);
          parts.push(turns.slice(0, 6).map(([o, f]) => `<div class="qa-op">
            <div class="qa-op-h"><span class="qa-ch">${esc(o.c)}</span>${flipTag(f)}<span class="qa-date">${fmtD(o.d)}</span></div>
            <div class="qa-th">${esc(String(o.th || '').slice(0, 120))}<br><span style="color:var(--muted);font-size:11.5px">上次 ${fmtD(f.prev.d)}「${esc(f.prev.s)}」</span></div>
          </div>`).join(''));
        }
        if (soft.length) {
          parts.push(`<div class="qa-h">↕️ 同向强度变化（${soft.length} 处）</div>`);
          parts.push(soft.slice(0, 5).map(([o, f]) => `<div class="qa-reason">${flipTag(f)}<span class="qa-reason-txt">${esc(o.c)} · ${fmtD(o.d)}「${esc(f.prev.s)}」→「${esc(o.s)}」</span></div>`).join(''));
        }
        if (!allFlips.length) parts.push(`<div class="qa-note">近 ${base.length} 条观点中没有捕捉到立场变化。</div>`);
        parts.push(opSection(base, 5));
        continue;
      }

      // 为什么
      if (p.intent === 'why') {
        const wantShort = /看空|跌|风险|利空|回调/.test(p.q) && !/看多|涨|机会/.test(p.q);
        const wantLong = /看多|涨|机会|看好|利好/.test(p.q) && !/看空|跌|风险/.test(p.q);
        const dir = wantShort ? -1 : wantLong ? 1 : 0;
        parts.push(leadCard(data, t, base, ''));
        parts.push(reasonBlock(base, dir, dir < 0 ? '🧠 为什么看空（理由归纳）' : dir > 0 ? '🧠 为什么看多（理由归纳）' : '🧠 观点逻辑归纳'));
        const keep = (o) => (dir < 0 ? scoreOf(o.s) < -0.3 : dir > 0 ? scoreOf(o.s) > 0.3 : true);
        parts.push(`<div class="qa-h">🎬 代表观点</div>` + opSection(base.filter(keep), 6));
        continue;
      }

      // 价格
      if (p.intent === 'price') {
        const pr = (data.prices || {})[t.ticker];
        parts.push(`<div class="qa-h">${esc(head)}</div>`);
        if (pr) {
          const out = [`<span class="qa-lvi">当日 <b class="${pr.p >= 0 ? 'qup' : 'qdn'}">${pctTxt(pr.p)}</b></span>`];
          if (pr.d5 != null) out.push(`<span class="qa-lvi">近5日 <b class="${pr.d5 >= 0 ? 'qup' : 'qdn'}">${pctTxt(pr.d5)}</b></span>`);
          if (pr.hi != null && pr.lo != null && pr.hi > pr.lo) {
            const pos = Math.round(((pr.c - pr.lo) / (pr.hi - pr.lo)) * 100);
            const zone = pos >= 70 ? '区间上部' : pos <= 30 ? '区间下部' : '区间中部';
            out.push(`<span class="qa-lvi">60日 ${pr.lo}~${pr.hi}（${zone} ${pos}%）</span>`);
          }
          parts.push(`<div class="qa-sum">最新收盘 <b>${num1(pr.c)}</b> 美元（${fmtD(pr.at)} 美东）
            <div class="qa-lv">${out.join('')}</div></div>`);
        } else {
          parts.push(`<div class="qa-note">暂无 ${esc(t.ticker)} 的日K行情缓存（该标的可能是新提到的公司）。</div>`);
        }
        parts.push(`<div class="qa-h">🎬 相关观点</div>` + opSection(base, 4));
        continue;
      }

      // 风险
      if (p.intent === 'risk') {
        parts.push(leadCard(data, t, base, ''));
        parts.push(reasonBlock(base, -1, '⚠️ 风险点归纳'));
        parts.push(`<div class="qa-h">🎬 看空/谨慎观点</div>` + opSection(base.filter((o) => scoreOf(o.s) < -0.3), 6) + opSection(base.filter((o) => scoreOf(o.s) >= -0.3), 2));
        continue;
      }

      // 机会
      if (p.intent === 'opportunity') {
        const cs = consensus(base);
        parts.push(leadCard(data, t, base, ''));
        if (cs.ent || cs.sup || cs.tgt) {
          parts.push(`<div class="qa-note">💡 博主给出的可操作位置：${[
            cs.ent ? `买点中位 <b>${cs.ent.med}</b>（${cs.ent.min}~${cs.ent.max}）` : '',
            cs.sup ? `支撑中位 <b>${cs.sup.med}</b>（${cs.sup.min}~${cs.sup.max}）` : '',
            cs.tgt ? `目标中位 <b>${cs.tgt.med}</b>` : '',
          ].filter(Boolean).join(' · ')}</div>`);
        }
        parts.push(reasonBlock(base, 1, '🧠 看多理由'));
        parts.push(`<div class="qa-h">🎬 含点位的看多观点</div>` + opSection(base.filter((o) => scoreOf(o.s) > 0.3), 6, true));
        continue;
      }

      // 点位（全量历史聚合，才能看到较早给出、仍在生效的目标价/支撑位）
      if (p.intent === 'levels') {
        const lvOps = all.filter(hasLevels);
        parts.push(leadCard(data, t, lvOps.length ? lvOps : all, ''));
        if (!lvOps.length) parts.push(`<div class="qa-note">数据库中没有该标的的明确点位记录。</div>`);
        else {
          parts.push(levelBoard(lvOps));
          parts.push(`<div class="qa-h">🎬 点位出处</div>` + opSection(lvOps, 6, true));
        }
        continue;
      }

      // 默认 views
      parts.push(leadCard(data, t, base, rangeTxt));
      if (!base.length) {
        const fallback = data.ops.filter((o) => o.t === t.ticker && (!p.channel || o.c === p.channel.name));
        parts.push(`<div class="qa-note">${p.channel ? `博主「${p.channel.name}」` : ''}${p.date ? fmtD(p.date) + ' ' : ''}${p.date ? '没有观点' : '近 5 日没有新观点'}${fallback.length ? '，以下是该博主的历史记录：' : '，以下是全站历史记录：'}</div>`);
        parts.push(opSection(fallback.length ? fallback : data.ops.filter((o) => o.t === t.ticker), 6));
        continue;
      }
      parts.push(`<div class="qa-h">🎬 相关观点</div>` + opSection(base, 8));
    }
    const html = parts.filter(Boolean).join('');
    return { html: html || helpHtml(data), ctx };
  }

  // ── 博主 ──
  if (p.channel) {
    const ch = p.channel;
    const inRange = (o) => (p.date ? o.d === p.date : p.dateRange ? (o.d >= p.dateRange[0] && o.d <= p.dateRange[1]) : true);
    const ops = data.ops.filter((o) => (o.g === ch.slug || o.c === ch.name) && inRange(o));
    const parts = [];
    const st = statsOf(ops);
    const byT = new Map();
    for (const o of ops) { if (!byT.has(o.t)) byT.set(o.t, []); byT.get(o.t).push(o); }
    const topT = [...byT.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 4);
    const nameOf = new Map((data.tickers || []).map((t) => [t.ticker, t.name]));
    parts.push(`<div class="qa-sum">「${esc(ch.name)}」共 <b>${st.n}</b> 条观点：看多 <b class="qup">${st.up}</b> · 看空 <b class="qdn">${st.down}</b> · 中性 ${st.flat} → <span class="qa-lean ${leanCls(st.avg)}">${leanText(st.avg)}</span>
      <div class="qa-note" style="margin:6px 0 0">最常提到：${topT.map(([tk, l]) => `${esc(nameOf.get(tk) || tk)}（${l.length}）`).join('、') || '—'}</div></div>`);
    if (!p.stance && !p.date && !p.dateRange) {
      const sums = data.sums.filter((s) => s.g === ch.slug || s.c === ch.name).slice(0, 2);
      if (sums.length) parts.push(`<div class="qa-h">${esc(ch.name)} 的大盘研判（最近）</div>` + sums.map(summaryCard).join(''));
    }
    parts.push(`<div class="qa-h">🎬 观点</div>` + opSection(ops, 10));
    return { html: parts.join('') || `<div class="qa-note">数据库中暂无 ${esc(ch.name)} 的相关记录。</div>`, ctx };
  }

  // ── 日期 ──
  if (p.date || p.dateRange) {
    const inR = (o) => (p.date ? o.d === p.date : o.d >= p.dateRange[0] && o.d <= p.dateRange[1]);
    const sums = data.sums.filter(inR);
    const ops = data.ops.filter(inR);
    const parts = [`<div class="qa-h">${p.date ? fmtD(p.date) : `${fmtD(p.dateRange[0])} ~ ${fmtD(p.dateRange[1])}`} 复盘（${ops.length} 条观点 · ${sums.length} 期综述）</div>`];
    if (sums.length) parts.push(...sums.slice(0, 3).map(summaryCard));
    parts.push(opSection(ops, 12));
    return { html: parts.join('') || `<div class="qa-note">数据库中没有该日期的记录。</div>`, ctx };
  }

  // ── 仅多空倾向 ──
  if (p.stance) {
    const ops = data.ops.filter((o) => (p.stance === 'long' ? scoreOf(o.s) > 0.3 : p.stance === 'short' ? scoreOf(o.s) < -0.3 : Math.abs(scoreOf(o.s)) <= 0.3));
    if (ops.length) {
      const byCh = new Map();
      for (const o of ops) byCh.set(o.c, (byCh.get(o.c) || 0) + 1);
      const top = [...byCh.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      return {
        html: `<div class="qa-h">${p.stance === 'long' ? '看多' : p.stance === 'short' ? '看空' : '中性'}观点（最近 12 条 / 共 ${ops.length} 条）</div>
          <div class="qa-note">按博主：${top.map(([c, n]) => `${esc(c)} ${n} 条`).join(' · ')}</div>` + opSection(ops, 12),
        ctx,
      };
    }
  }

  // ── 兜底：中文 bigram 相关度检索 ──
  const grams = bigrams(p.q);
  if (grams.size) {
    const scored = data.ops.map((o) => ({ o, s: gramScore(grams, `${o.n} ${o.th || ''} ${o.title || ''} ${o.t}`) }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s || String(b.o.d).localeCompare(String(a.o.d))).slice(0, 8);
    if (scored.length) {
      return { html: `<div class="qa-note">没有精确匹配到标的，以下是内容最相关的 ${scored.length} 条观点：</div>` + scored.map((x) => opCard(x.o)).join(''), ctx: {} };
    }
  }
  return { html: helpHtml(data), ctx: {} };
}

window.QAEngine={answerQuery:answerQuery,greet:greet};
})();
(function(){
  var btn=document.getElementById('qaFab'),panel=document.getElementById('qaPanel'),closeB=document.getElementById('qaClose'),
      input=document.getElementById('qaInput'),sendB=document.getElementById('qaSend'),msgs=document.getElementById('qaMsgs');
  if(!btn||!panel||!window.QAEngine) return;
  var DATA=null,loading=false,CTX=null;
  function scroll(){msgs.scrollTop=msgs.scrollHeight;}
  function addBot(html){var w=document.createElement('div');w.className='qa-bot';var b=document.createElement('div');b.className='qa-bub';b.innerHTML=html;w.appendChild(b);msgs.appendChild(w);b.querySelectorAll('[data-q]').forEach(function(el){el.addEventListener('click',function(){ask(el.getAttribute('data-q'));});});scroll();}
  function addUser(t){var w=document.createElement('div');w.className='qa-user';var b=document.createElement('div');b.className='qa-bub';b.textContent=t;w.appendChild(b);msgs.appendChild(w);scroll();}
  function load(){if(DATA||loading)return;loading=true;addBot('<div class="qa-note">正在加载观点数据库…</div>');
    fetch('/qa-data.json').then(function(r){if(!r.ok)throw new Error('http '+r.status);return r.json();}).then(function(j){DATA=j;msgs.innerHTML='';addBot(window.QAEngine.greet(DATA));}).catch(function(){var b=msgs.querySelector('.qa-bub');if(b)b.innerHTML='数据加载失败，请刷新重试';loading=false;});}
  function ask(text){text=String(text||'').trim();if(!text)return;addUser(text);input.value='';
    setTimeout(function(){var out;try{out=window.QAEngine.answerQuery(DATA,text,CTX);}catch(e){out={html:'解析出错，换个问法试试～'};}
      if(out&&out.ctx&&(out.ctx.tickers||out.ctx.channel))CTX=out.ctx;
      addBot((out&&out.html)||'没有找到相关内容');},100);}
  btn.addEventListener('click',function(){panel.classList.add('open');btn.style.display='none';load();try{input.focus();}catch(e){}});
  closeB.addEventListener('click',function(){panel.classList.remove('open');btn.style.display='';});
  sendB.addEventListener('click',function(){ask(input.value);});
  input.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();ask(input.value);}});
})();