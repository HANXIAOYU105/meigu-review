/* 自动生成自 src/qa-engine.js + 面板交互 · 由 scripts/site.js 输出，勿手改 */
(function(){
/**
 * 问答引擎 v2（纯函数，无 DOM 依赖，可被 Node 直接测试）
 *
 * v2 升级（2026-11-04 用户反馈"更智能"）：
 *   - 意图扩展：价格行情 / 风险 / 机会(能不能买) / 对比 / 点位 / 多空 / 大盘
 *   - 模糊匹配：英文 ticker/别名编辑距离容错（如 nvad→NVDA）
 *   - 综合摘要：标的答案先给"近5日多空分布 + 整体倾向 + 最新价"结论段，再列观点
 *   - 相关度排序：近期优先 + 持仓加权 + 带点位加权
 *   - 追问上下文："那微软呢" 沿用上一轮的实体
 *
 * 浏览器端：scripts/site.js 构建时去掉 export 后内联进 site/qa.js
 * Node 端：  import { answerQuery, greet } from './src/qa-engine.js'
 *
 * data（site/qa-data.json）结构：
 * {
 *   asOf, generatedAt, asOfIndices,
 *   tickers: [{ ticker, name, aliases, sector, isHolding }],
 *   channels: [{ slug, name }],
 *   indices: [{ name, close, prevClose, pct, peak }],
 *   prices: { TICKER: { c, p, d5, hi, lo, at } },
 *   ops:  [{ d,t,n,h,c,g,s,a,hz,th,sup,res,tgt,ent,trg,url,title,ts,x }],
 *   sums: [{ d,c,g,tone,sm,t,u }]
 * }
 * 返回：{ html, ctx }，ctx={tickers:[{ticker,name}], channel} 供追问（"那微软呢"）
 */

const ALIAS_BLACKLIST = new Set(['大盘', '市场', '指数', '美股', '股市']);
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

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const stanceCls = (s) => (/看多|买入|增持/.test(s || '') ? 'up' : /看空|卖出|减仓|回避/.test(s || '') ? 'down' : 'flat');
const fmtD = (d) => { const p = String(d || '').split('-'); return p.length === 3 ? `${+p[1]}/${+p[2]}` : String(d || ''); };
const hasLevels = (o) => LEVEL_DEFS.some(([k]) => o[k]);

/** OSA 编辑距离（支持相邻换位，如 nvad→nvda），超过 max 提前返回 */
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

/** ascii 词边界匹配；len≥4 允许 OSA 距离 1 的错字（nvad→NVDA、appl→AAPL） */
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

/** 中文错字容错：≥3 字的名称，允许查询里有 1 个字打错/多打/漏打（英伟迖→英伟达） */
function fuzzyCjk(h, n) {
  if (h.includes(n)) return true;
  if (n.length < 3) return false;
  for (let L = n.length - 1; L <= n.length + 1; L++) {
    if (L < n.length - 1) continue;
    for (let i = 0; i + L <= h.length; i++) {
      if (editDist(h.slice(i, i + L), n, 1) <= 1) return true;
    }
  }
  return false;
}

/** 解析问题：{ tickers, channel, date, dateRange, stance, market, intent } */
function parseQuery(data, raw, prevCtx) {
  const q = String(raw || '').trim();
  const ql = q.toLowerCase();
  const r = { tickers: [], channel: null, date: null, dateRange: null, stance: null, market: false, intent: 'views', q, followedUp: false };

  const re = {
    compare: /对比|和.{1,10}(比|比较)|哪个更|谁更|\bvs\b|相比|两个(都|谁)/,
    price: /多少钱|什么价|现价|股价|价格|涨了多少|跌了多少|涨了|跌了|涨幅|跌幅|行情(如何|怎么样)?$/,
    risk: /风险|危险|担心|恐慌|崩|会不会跌|要跌|要崩|回调|躲|止损/,
    opportunity: /能买|可以买|该买|要不要买|入场|进场|抄底|机会|建仓|上车|加仓/,
    levels: /点位|支撑|压力|阻力|目标价?|买点|触发|价位|止损位/,
  };

  // 1) 意图（优先级：对比 > 价格 > 风险 > 机会 > 点位 > 多空 > 默认观点）
  if (re.compare.test(ql)) r.intent = 'compare';
  else if (re.price.test(ql)) r.intent = 'price';
  else if (re.risk.test(ql)) r.intent = 'risk';
  else if (re.opportunity.test(ql)) r.intent = 'opportunity';
  else if (re.levels.test(ql)) r.intent = 'levels';
  if (/看多|做多|买入|增持|bullish|长多|看好|抄底/.test(ql)) r.stance = 'long';
  else if (/看空|做空|卖出|减仓|bearish|回避|清仓/.test(ql)) r.stance = 'short';
  else if (/中性|观望/.test(ql)) r.stance = 'flat';

  // 2) 大盘意图（排除站点名类词）
  r.market = (/大盘|整个市场|市场情绪|指数|整体走势/.test(ql) || /^\s*美股.{0,6}(怎么样|如何|走势|行情|怎么看)?\s*$/.test(ql)) && !/博主|复盘|日报|档案|网站/.test(ql);

  // 3) 日期：今天/昨天/前天/上周/11月3日/11.3
  const allDates = [...new Set([...data.ops.map((o) => o.d), ...data.sums.map((s) => s.d)])].filter(Boolean).sort();
  const idxOf = (d) => allDates.indexOf(d);
  if (/今天|最新|最近/.test(ql)) r.date = data.asOf;
  else if (/昨天/.test(ql)) { const i = idxOf(data.asOf); r.date = i > 0 ? allDates[i - 1] : data.asOf; }
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

  // 6) 追问："那微软呢"/"它呢"/"换成英伟达" —— 没抓到实体但带承接词时，沿用上一轮
  if (!r.tickers.length && !r.channel && prevCtx && (/[呢吗嘛？?]\s*$/.test(q) && q.length <= 12 || /那|它|他|该股|这只|还是/.test(ql))) {
    r.followedUp = true;
    if (prevCtx.tickers?.length) r.tickers = prevCtx.tickers;
    if (prevCtx.channel) r.channel = prevCtx.channel;
  }
  return r;
}

const levelsOf = (o) => LEVEL_DEFS.map(([k, label]) => (o[k] ? { label, text: o[k] } : null)).filter(Boolean);

function opCard(o) {
  const lvs = levelsOf(o);
  const link = o.url
    ? (o.x || o.ts == null
        ? `<a class="qa-link" href="${esc(o.url)}" target="_blank" rel="noopener">🔗 查看原文 →</a>`
        : `<a class="qa-link" href="${esc(o.url)}&t=${o.ts}s" target="_blank" rel="noopener">⏱ ${Math.floor(o.ts / 60)}分${Math.round(o.ts % 60)}秒 回看 →</a>`)
    : '';
  return `<div class="qa-op">
    <div class="qa-op-h"><span class="qa-ch">${esc(o.c)}${o.x ? '<i class="qa-x">X</i>' : ''}</span><span class="qa-date">${fmtD(o.d)}</span>
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
    return `<span class="qa-idx-i"><b>${esc(i.name)}</b> <span class="${up ? 'up' : 'down'}">${i.close ?? '—'}（${up ? '+' : ''}${i.pct ?? '—'}%）</span></span>`;
  }).join('')}</div><div class="qa-note">截至 ${esc(fmtD(data.asOfIndices || data.asOf))} 美东收盘</div>`;
}

const capNote = (n, cap) => (n > cap ? `<div class="qa-note">仅显示最近 ${cap} 条 · 共 ${n} 条</div>` : '');

/** 相关度排序：新日期优先，持仓加权，带点位加权 */
function rankOps(ops) {
  const dates = [...new Set(ops.map((o) => o.d))].sort().reverse();
  const rank = new Map(dates.map((d, i) => [d, i]));
  return [...ops].sort((a, b) => (rank.get(b.d) - rank.get(a.d)) || (b.h - a.h) || ((hasLevels(b) ? 1 : 0) - (hasLevels(a) ? 1 : 0)));
}

/** 标的结论段：近5日多空分布 + 整体倾向 + 最新价 */
function stockLead(data, ticker, name) {
  const all = data.ops.filter((o) => o.t === ticker);
  const recent = all.filter((o) => o.d >= (data.cutoff5 || ''));
  const base = recent.length ? recent : all;
  const up = base.filter((o) => stanceCls(o.s) === 'up').length;
  const down = base.filter((o) => stanceCls(o.s) === 'down').length;
  const flat = base.length - up - down;
  const avg = base.length ? base.reduce((s, o) => s + (stanceCls(o.s) === 'up' ? 1 : stanceCls(o.s) === 'down' ? -1 : 0), 0) / base.length : 0;
  const lean = avg > 0.3 ? '整体偏多' : avg < -0.3 ? '整体偏空' : '分歧/中性';
  const leanCls = avg > 0.3 ? 'up' : avg < -0.3 ? 'down' : 'flat';
  const pr = (data.prices || {})[ticker];
  const prTxt = pr
    ? `<span class="qa-lvi">最新 <b>${pr.c}</b></span><span class="qa-lvi">近5日 <b class="${pr.d5 >= 0 ? 'qup' : 'qdn'}">${pr.d5 >= 0 ? '+' : ''}${pr.d5}%</b></span><span class="qa-lvi">60日区间 <b>${pr.lo}~${pr.hi}</b></span>`
    : '';
  return `<div class="qa-sum">${esc(name)}（${esc(ticker)}）近5日 <b>${base.length}</b> 条观点：看多 <b class="qup">${up}</b> · 看空 <b class="qdn">${down}</b> · 中性 ${flat}，<span class="qa-lean ${leanCls}">${lean}</span>
    ${prTxt ? `<div class="qa-lv">${prTxt}</div>` : ''}</div>`;
}

function opSection(data, ops, cap = 12, levelsFirst = false) {
  if (!ops.length) return '';
  let list = rankOps(ops);
  if (levelsFirst) list = [...list.filter(hasLevels), ...list.filter((o) => !hasLevels(o))];
  list = list.slice(0, cap);
  return list.map(opCard).join('') + capNote(ops.length, cap);
}

function helpHtml(data) {
  const seen = new Set();
  const holdChips = [];
  for (const t of data.tickers || []) {
    if (!t.isHolding || seen.has(t.name)) continue;
    seen.add(t.name);
    holdChips.push(`<button class="qa-chip" data-q="${esc(t.name)}怎么看">${esc(t.name)}</button>`);
    if (holdChips.length >= 6) break;
  }
  const ex = ['英伟达现在多少钱', '英伟达和AMD哪个更被看好', '特斯拉有风险吗', '台积电能买吗', '大盘怎么看', '11月3日复盘']
    .map((x) => `<button class="qa-chip" data-q="${x}">${x}</button>`).join('');
  return `<div class="qa-h">可以这样问我 👇</div>
  <div class="qa-chips">${holdChips.join('')}${ex}</div>
  <div class="qa-note">支持：观点/点位/价格/风险/机会/标的对比/某天复盘/博主看法，还能追问（"那微软呢"）。数据：${(data.ops || []).length} 条观点 · ${(data.sums || []).length} 期综述。</div>`;
}

/** 问候语 */
function greet(data) {
  const seen = new Set();
  const chips = [];
  for (const t of data.tickers || []) {
    if (!t.isHolding || seen.has(t.name)) continue;
    seen.add(t.name);
    chips.push(`<button class="qa-chip" data-q="${esc(t.name)}怎么看">${esc(t.name)}</button>`);
    if (chips.length >= 6) break;
  }
  chips.push('<button class="qa-chip" data-q="大盘怎么看">大盘怎么看</button>');
  return `<div class="qa-h">👋 我基于每日爬取的博主观点数据库回答</div>
  <div class="qa-note">已收录 <b>${(data.ops || []).length}</b> 条观点 · <b>${(data.sums || []).length}</b> 期大盘综述 · 数据截至 <b>${fmtD(data.asOf)}</b>。可以问观点、点位、价格、风险、机会、标的对比，也支持追问。</div>
  <div class="qa-chips">${chips.join('')}</div>`;
}

/** 主入口：返回 { html, ctx } */
function answerQuery(data, raw, prevCtx) {
  const p = parseQuery(data, raw, prevCtx);
  const ctx = { tickers: p.tickers, channel: p.channel };
  const parts = [];
  const scopeTxt = [p.channel ? `博主「${p.channel.name}」` : null, p.date ? fmtD(p.date) : (p.dateRange ? `${fmtD(p.dateRange[0])}~${fmtD(p.dateRange[1])}` : null)].filter(Boolean).join(' · ');
  const inRange = (o) => (p.date ? o.d === p.date : p.dateRange ? (o.d >= p.dateRange[0] && o.d <= p.dateRange[1]) : true);
  const stanceOk = (o) => (p.stance === 'long' ? stanceCls(o.s) === 'up' : p.stance === 'short' ? stanceCls(o.s) === 'down' : p.stance === 'flat' ? stanceCls(o.s) === 'flat' : true);

  // ── 大盘 ──
  if (p.market && !p.tickers.length) {
    parts.push(indicesBlock(data));
    const byCh = new Map();
    for (const s of data.sums) if (!byCh.has(s.c)) byCh.set(s.c, s);
    const latest = [...byCh.values()].sort((a, b) => String(b.d).localeCompare(a.d)).slice(0, 8);
    parts.push(latest.length ? `<div class="qa-h">各位博主最新大盘研判</div>` + latest.map(summaryCard).join('') : '<div class="qa-note">数据库中暂无大盘综述。</div>');
    return { html: parts.join(''), ctx };
  }

  // ── 命中率 ──
  if (/命中|胜率|准不准|准确/.test(p.q)) {
    return { html: `<div class="qa-h">🎯 博主命中率</div><div class="qa-note">命中率追踪页按「观点发布后 5 个交易日」用实际行情自动验证每位博主的方向/支撑/目标判定：</div><div class="qa-act"><a class="qa-link" href="${data.siteBase || '/'}track-record.html" target="_blank" rel="noopener">打开 🎯 命中率追踪 →</a></div>`, ctx };
  }

  // ── 标的对比 ──
  if (p.intent === 'compare' && p.tickers.length >= 2) {
    for (const t of p.tickers.slice(0, 2)) {
      const ops = data.ops.filter((o) => o.t === t.ticker);
      parts.push(stockLead(data, t.ticker, t.name));
      parts.push(opSection(data, ops, 3));
    }
    return { html: parts.filter(Boolean).join(''), ctx };
  }

  // ── 标的（views/price/risk/opportunity/levels 共用，答案侧重不同）──
  if (p.tickers.length) {
    for (const t of p.tickers.slice(0, 2)) {
      let ops = data.ops.filter((o) => o.t === t.ticker && stanceOk(o) && inRange(o));
      if (p.channel) ops = ops.filter((o) => o.c === p.channel.name);
      const head = `${t.name}（${t.ticker}）${t.isHolding ? '⭐' : ''}${scopeTxt ? ` — ${scopeTxt}` : ''}`;
      if (p.intent === 'price') {
        const pr = (data.prices || {})[t.ticker];
        const prBlock = pr
          ? `<div class="qa-sum">${esc(t.name)} 最新收盘 <b>${pr.c}</b>（${fmtD(pr.at)}），近5日 <b class="${pr.d5 >= 0 ? 'qup' : 'qdn'}">${pr.d5 >= 0 ? '+' : ''}${pr.d5}%</b>，近60日区间 <b>${pr.lo} ~ ${pr.hi}</b></div>`
          : `<div class="qa-note">暂无 ${esc(t.ticker)} 的日K行情缓存。</div>`;
        parts.push(`<div class="qa-h">${esc(head)}</div>` + prBlock + opSection(data, ops.length ? ops : data.ops.filter((o) => o.t === t.ticker), 4));
        continue;
      }
      parts.push(stockLead(data, t.ticker, t.name));
      if (!ops.length) {
        const alt = data.ops.filter((o) => o.t === t.ticker);
        if (alt.length) parts.push(`<div class="qa-note">${p.channel ? '该博主' : '近5日'}没有匹配记录，展示${p.stance ? '' : '最近的'}观点：</div>`);
        parts.push(opSection(data, alt, p.intent === 'risk' || p.intent === 'opportunity' ? 6 : 8, p.intent === 'levels'));
      } else if (p.intent === 'risk') {
        parts.push(`<div class="qa-h">${esc(head)} · 风险视角</div>`);
        parts.push(opSection(data, ops, 6));
      } else if (p.intent === 'opportunity') {
        parts.push(`<div class="qa-h">${esc(head)} · 买点视角</div>`);
        parts.push(opSection(data, ops, 6, true));
      } else {
        parts.push(opSection(data, ops, 8, p.intent === 'levels'));
      }
    }
    const html = parts.filter(Boolean).join('');
    return { html: html || helpHtml(data), ctx };
  }

  // ── 博主 ──
  if (p.channel) {
    const ch = p.channel;
    let ops = data.ops.filter((o) => (o.g === ch.slug || o.c === ch.name) && stanceOk(o) && inRange(o));
    parts.push(opSection(data, ops, 10));
    if (!p.stance && !p.date && !p.dateRange) {
      const sums = data.sums.filter((s) => s.g === ch.slug || s.c === ch.name).slice(0, 3);
      if (sums.length) parts.push(`<div class="qa-h">${esc(ch.name)} 的大盘研判（最近）</div>` + sums.map(summaryCard).join(''));
    }
    return { html: parts.filter(Boolean).join('') || `<div class="qa-note">数据库中暂无 ${esc(ch.name)} 的相关记录。</div>`, ctx };
  }

  // ── 日期 ──
  if (p.date || p.dateRange) {
    const inR = (o) => (p.date ? o.d === p.date : o.d >= p.dateRange[0] && o.d <= p.dateRange[1]);
    const sums = data.sums.filter(inR);
    const ops = data.ops.filter(inR);
    parts.push(`<div class="qa-h">${p.date ? fmtD(p.date) : `${fmtD(p.dateRange[0])} ~ ${fmtD(p.dateRange[1])}`} 复盘（${ops.length} 条观点 · ${sums.length} 期综述）</div>`);
    if (sums.length) parts.push(...sums.slice(0, 4).map(summaryCard));
    parts.push(opSection(data, ops, 12));
    return { html: parts.filter(Boolean).join('') || `<div class="qa-note">数据库中没有该日期的记录。</div>`, ctx };
  }

  // ── 仅多空倾向 ──
  if (p.stance) {
    const ops = data.ops.filter((o) => stanceOk(o));
    if (ops.length) {
      parts.push(`<div class="qa-h">${p.stance === 'long' ? '看多' : p.stance === 'short' ? '看空' : '中性'}观点（最近 12 条 / 共 ${ops.length} 条）</div>`);
      parts.push(opSection(data, ops, 12));
      return { html: parts.join(''), ctx };
    }
  }

  // ── 兜底：全文松搜索（thesis/标的名/板块里找关键词）──
  const words = p.q.replace(/[？?！!。,,.\s]+/g, ' ').split(' ').filter((w) => w.length >= 2);
  if (words.length) {
    const hits = data.ops.filter((o) => {
      const hay = `${o.n} ${o.th} ${o.title || ''}`;
      return words.some((w) => hay.toLowerCase().includes(w.toLowerCase()));
    }).sort((a, b) => String(b.d).localeCompare(a.d)).slice(0, 6);
    if (hits.length) {
      return { html: `<div class="qa-note">没有精确匹配，以下是内容最相关的 ${hits.length} 条：</div>` + hits.map(opCard).join(''), ctx: {} };
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