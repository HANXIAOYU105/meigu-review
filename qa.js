/* 自动生成自 src/qa-engine.js + 面板交互 · 由 scripts/site.js 输出，勿手改 */
(function(){
/**
 * 问答引擎（纯函数，无 DOM 依赖，可被 Node 直接测试）
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
 *   ops:  [{ d,t,n,h,c,g,s,a,hz,th,sup,res,tgt,ent,trg,url,title,ts,x }],
 *   sums: [{ d,c,g,tone,sm,t,u }]
 * }
 */

const ALIAS_BLACKLIST = new Set(['大盘', '市场', '指数', '美股', '股市']); // 归入大盘意图，不做标的匹配
const LEVEL_DEFS = [
  ['sup', '支撑'],
  ['res', '压力'],
  ['tgt', '目标'],
  ['ent', '买点'],
  ['trg', '触发'],
];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const stanceCls = (s) => (/看多|买入|增持/.test(s || '') ? 'up' : /看空|卖出|减仓|回避/.test(s || '') ? 'down' : 'flat');
const fmtD = (d) => { const p = String(d || '').split('-'); return p.length === 3 ? `${+p[1]}/${+p[2]}` : String(d || ''); };

/** ascii 词边界匹配（NVDA / QQQ 等），CJK 用 includes */
function hasWord(hay, needle) {
  const h = String(hay).toLowerCase();
  const n = String(needle).toLowerCase();
  if (!n) return false;
  if (!/[a-z0-9]/.test(n[0]) && !/[a-z0-9]/.test(n[n.length - 1])) return h.includes(n);
  let i = -1;
  while ((i = h.indexOf(n, i + 1)) !== -1) {
    const before = i === 0 ? ' ' : h[i - 1];
    const after = i + n.length >= h.length ? ' ' : h[i + n.length];
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
  }
  return false;
}

/** 解析问题：返回 { tickers, channel, date, stance, market, levels, raw } */
function parseQuery(data, raw) {
  const q = String(raw || '').trim();
  const ql = q.toLowerCase();
  const r = { tickers: [], channel: null, date: null, stance: null, market: false, levels: /点位|支撑|压力|阻力|目标|买点|建仓|止损|触发|价位|价 /.test(ql + ' '), q };

  // 1) 大盘意图（含"大盘/市场/指数/整体"，或仅问"美股怎么样"这类宽泛问法）
  r.market = /大盘|整个市场|市场情绪|指数|整体|大盘走势/.test(ql) || /^\s*美股(怎么样|如何|走势|行情)?\s*$/.test(ql);

  // 2) 日期：今天/昨天/11月3日/11.3/11/3
  const allDates = [...new Set([...data.ops.map((o) => o.d), ...data.sums.map((s) => s.d)])].filter(Boolean).sort();
  if (/今天|最新|最近/.test(ql)) r.date = data.asOf;
  else if (/昨天/.test(ql)) { const i = allDates.indexOf(data.asOf); r.date = i > 0 ? allDates[i - 1] : data.asOf; }
  else {
    const m = ql.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/) || ql.match(/(\d{1,2})[.\/](\d{1,2})/);
    if (m) {
      const mo = +m[1], da = +m[2];
      const hit = allDates.find((d) => { const p = d.split('-'); return +p[1] === mo && +p[2] === da; });
      if (hit) r.date = hit;
    }
  }

  // 3) 多空倾向
  if (/强烈看多|坚定看多|看多|做多|买入|增持|bullish|长多|看好|抄底/.test(ql)) r.stance = 'long';
  else if (/强烈看空|坚定看空|看空|做空|卖出|减仓|bearish|回避|清仓/.test(ql)) r.stance = 'short';
  else if (/中性|观望/.test(ql)) r.stance = 'flat';

  // 4) 频道（博主）
  const SHORTS = [
    ['视野环球', '视野'], ['nana', '娜娜'], ['阳光财经', '阳光'], ['老李玩钱', '老李'],
    ['美投侃新闻', '美投'], ['猫姐', 'xtrader'], ['trading apologist', 'apologist'], ['investor channel', 'investor'],
  ];
  for (const ch of data.channels || []) {
    const nm = String(ch.name || '').toLowerCase();
    if (ql.includes(nm) && nm.length >= 2) { r.channel = ch; break; }
    const hit = SHORTS.some(([full, short]) => (nm.includes(full) || nm.includes(short)) && ql.includes(full === nm ? full : (ql.includes(short) ? short : full)));
    if (hit) { r.channel = ch; break; }
  }

  // 5) 标的：ticker / 名称 / 别名，长词优先（"大盘"等黑名单词跳过）
  const keys = [];
  for (const t of data.tickers || []) {
    keys.push({ t, key: t.ticker, kind: 'ticker' });
    if (t.name) keys.push({ t, key: t.name, kind: 'name' });
    for (const a of t.aliases || []) if (!ALIAS_BLACKLIST.has(String(a).toLowerCase())) keys.push({ t, key: a, kind: 'alias' });
  }
  keys.sort((a, b) => b.key.length - a.key.length);
  const seen = new Set();
  for (const k of keys) {
    if (r.tickers.length >= 3) break;
    if (seen.has(k.t.ticker)) continue;
    const ok = k.kind === 'ticker' ? hasWord(ql, k.key) : hasWord(ql, k.key);
    if (ok) { r.tickers.push(k.t); seen.add(k.t.ticker); }
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

function opSection(data, ops, title, cap = 12) {
  const list = [...ops].sort((a, b) => String(b.d).localeCompare(a.d)).slice(0, cap);
  if (!list.length) return '';
  return `<div class="qa-h">${esc(title)}</div>` + list.map(opCard).join('') + capNote(ops.length, cap);
}

function helpHtml(data) {
  const seen = new Set();
  const holdChips = [];
  for (const t of data.tickers || []) {
    if (!t.isHolding || seen.has(t.name)) continue;
    seen.add(t.name);
    holdChips.push(`<button class="qa-chip" data-q="${esc(t.name)}怎么看">${esc(t.name)}</button>`);
    if (holdChips.length >= 8) break;
  }
  const ex = ['大盘怎么看', '谁看多特斯拉', '11月3日复盘', '猫姐最新点位', '视野环球的思路']
    .map((x) => `<button class="qa-chip" data-q="${x}">${x}</button>`).join('');
  return `<div class="qa-h">可以这样问我 👇</div>
  <div class="qa-chips">${holdChips.join('')}${ex}</div>
  <div class="qa-note">数据范围：全部历史观点（${(data.ops || []).length} 条）+ 每日大盘综述（${(data.sums || []).length} 期）。</div>`;
}

/** 问候语（首次打开面板时展示） */
function greet(data) {
  const seen = new Set();
  const chips = [];
  for (const t of data.tickers || []) {
    if (!t.isHolding || seen.has(t.name)) continue;
    seen.add(t.name);
    chips.push(`<button class="qa-chip" data-q="${esc(t.name)}怎么看">${esc(t.name)}</button>`);
    if (chips.length >= 8) break;
  }
  chips.push('<button class="qa-chip" data-q="大盘怎么看">大盘怎么看</button>');
  return `<div class="qa-h">👋 我基于每日爬取的博主观点数据库回答</div>
  <div class="qa-note">已收录 <b>${(data.ops || []).length}</b> 条观点 · <b>${(data.sums || []).length}</b> 期大盘综述 · 数据截至 <b>${fmtD(data.asOf)}</b>。支持问标的观点、点位、博主看法、某日复盘、大盘研判。</div>
  <div class="qa-chips">${chips.join('')}</div>`;
}

/** 主入口：返回 HTML 字符串 */
function answerQuery(data, raw) {
  const p = parseQuery(data, raw);
  const parts = [];

  // ── 大盘研判 ──
  if (p.market && !p.tickers.length) {
    parts.push(indicesBlock(data));
    const byCh = new Map();
    for (const s of data.sums) if (!byCh.has(s.c)) byCh.set(s.c, s); // 每位博主最新一期
    const latest = [...byCh.values()].sort((a, b) => String(b.d).localeCompare(a.d)).slice(0, 8);
    if (latest.length) {
      parts.push(`<div class="qa-h">各位博主最新大盘研判</div>`);
      parts.push(...latest.map(summaryCard));
    } else {
      parts.push('<div class="qa-note">数据库中暂无大盘综述。</div>');
    }
    return parts.filter(Boolean).join('');
  }

  // ── 命中率/准不准 → 指路追踪页 ──
  if (/命中|胜率|准不准|准确/.test(p.q)) {
    return `<div class="qa-h">🎯 博主命中率</div><div class="qa-note">命中率追踪页按「观点发布后 5 个交易日」用实际行情自动验证每位博主的方向/支撑/目标判定：</div><div class="qa-act"><a class="qa-link" href="${(data.siteBase || '/')}track-record.html" target="_blank" rel="noopener">打开 🎯 命中率追踪 →</a></div>`;
  }

  // ── 标的 ──
  if (p.tickers.length) {
    for (const t of p.tickers.slice(0, 2)) {
      let ops = data.ops.filter((o) => o.t === t.ticker);
      if (p.channel) ops = ops.filter((o) => o.c === p.channel.name);
      if (p.stance) ops = ops.filter((o) => (p.stance === 'long' ? stanceCls(o.s) === 'up' : p.stance === 'short' ? stanceCls(o.s) === 'down' : stanceCls(o.s) === 'flat'));
      if (p.date) ops = ops.filter((o) => o.d === p.date);
      const recent = ops.length ? ops : data.ops.filter((o) => o.t === t.ticker);
      const scope = [p.channel ? `博主「${p.channel.name}」` : null, p.stance ? (p.stance === 'long' ? '看多' : p.stance === 'short' ? '看空' : '中性') : null, p.date ? fmtD(p.date) : null].filter(Boolean).join(' · ');
      const head = `${t.name}（${t.ticker}）${t.isHolding ? '⭐' : ''}${scope ? ` — ${scope}` : ''}`;
      if (!ops.length && recent.length) {
        parts.push(`<div class="qa-h">${esc(head)}</div><div class="qa-note">该筛选下暂无记录，展示该标的最近观点：</div>`);
        parts.push(opSection(data, recent, '', 8));
      } else {
        parts.push(opSection(data, ops, head));
      }
    }
    return parts.filter(Boolean).join('') || helpHtml(data);
  }

  // ── 博主 ──
  if (p.channel) {
    const ch = p.channel;
    const sums = data.sums.filter((s) => s.g === ch.slug || s.c === ch.name).slice(0, 3);
    let ops = data.ops.filter((o) => o.g === ch.slug || o.c === ch.name);
    if (p.stance) ops = ops.filter((o) => (p.stance === 'long' ? stanceCls(o.s) === 'up' : p.stance === 'short' ? stanceCls(o.s) === 'down' : stanceCls(o.s) === 'flat'));
    if (p.date) ops = ops.filter((o) => o.d === p.date);
    const holdFirst = [...ops].sort((a, b) => (b.h - a.h) || String(b.d).localeCompare(a.d));
    parts.push(opSection(data, holdFirst, `${ch.name} 的观点`, 10));
    if (sums.length && !p.stance && !p.date) {
      parts.push(`<div class="qa-h">${esc(ch.name)} 的大盘研判（最近）</div>`);
      parts.push(...sums.map(summaryCard));
    }
    return parts.filter(Boolean).join('') || `<div class="qa-note">数据库中暂无 ${esc(ch.name)} 的记录。</div>`;
  }

  // ── 日期 ──
  if (p.date) {
    const sums = data.sums.filter((s) => s.d === p.date);
    const ops = data.ops.filter((o) => o.d === p.date);
    parts.push(`<div class="qa-h">${fmtD(p.date)} 复盘（${ops.length} 条观点 · ${sums.length} 期综述）</div>`);
    if (sums.length) parts.push(...sums.slice(0, 4).map(summaryCard));
    parts.push(opSection(data, ops, '', 12));
    return parts.filter(Boolean).join('') || `<div class="qa-note">数据库中没有 ${fmtD(p.date)} 的记录。</div>`;
  }

  // ── 仅多空倾向（如"谁看多"）──
  if (p.stance) {
    const ops = data.ops.filter((o) => (p.stance === 'long' ? stanceCls(o.s) === 'up' : p.stance === 'short' ? stanceCls(o.s) === 'down' : stanceCls(o.s) === 'flat'));
    const latest = [...ops].sort((a, b) => String(b.d).localeCompare(a.d)).slice(0, 12);
    if (latest.length) {
      parts.push(`<div class="qa-h">${p.stance === 'long' ? '看多' : p.stance === 'short' ? '看空' : '中性'}观点（最近 ${latest.length} 条 / 共 ${ops.length} 条）</div>`);
      parts.push(...latest.map(opCard));
      return parts.join('');
    }
  }

  // ── 兜底 ──
  return helpHtml(data);
}

window.QAEngine={answerQuery:answerQuery,greet:greet};
})();
(function(){
  var btn=document.getElementById('qaFab'),panel=document.getElementById('qaPanel'),closeB=document.getElementById('qaClose'),
      input=document.getElementById('qaInput'),sendB=document.getElementById('qaSend'),msgs=document.getElementById('qaMsgs');
  if(!btn||!panel||!window.QAEngine) return;
  var DATA=null,loading=false;
  function scroll(){msgs.scrollTop=msgs.scrollHeight;}
  function addBot(html){var w=document.createElement('div');w.className='qa-bot';var b=document.createElement('div');b.className='qa-bub';b.innerHTML=html;w.appendChild(b);msgs.appendChild(w);b.querySelectorAll('[data-q]').forEach(function(el){el.addEventListener('click',function(){ask(el.getAttribute('data-q'));});});scroll();}
  function addUser(t){var w=document.createElement('div');w.className='qa-user';var b=document.createElement('div');b.className='qa-bub';b.textContent=t;w.appendChild(b);msgs.appendChild(w);scroll();}
  function load(){if(DATA||loading)return;loading=true;addBot('<div class="qa-note">正在加载观点数据库…</div>');
    fetch('/qa-data.json').then(function(r){if(!r.ok)throw new Error('http '+r.status);return r.json();}).then(function(j){DATA=j;msgs.innerHTML='';addBot(window.QAEngine.greet(DATA));}).catch(function(){var b=msgs.querySelector('.qa-bub');if(b)b.innerHTML='数据加载失败，请刷新重试';loading=false;});}
  function ask(text){text=String(text||'').trim();if(!text)return;addUser(text);input.value='';
    setTimeout(function(){var html;try{html=window.QAEngine.answerQuery(DATA,text);}catch(e){html='解析出错，换个问法试试～';}addBot(html||'没有找到相关内容');},100);}
  btn.addEventListener('click',function(){panel.classList.add('open');btn.style.display='none';load();try{input.focus();}catch(e){}});
  closeB.addEventListener('click',function(){panel.classList.remove('open');btn.style.display='';});
  sendB.addEventListener('click',function(){ask(input.value);});
  input.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();ask(input.value);}});
})();