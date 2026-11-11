/* 自动生成自 src/masters-qa-engine.js + 面板交互 · 由 scripts/site.js 输出，勿手改 */
(function(){
/**
 * 「问问大师」问答引擎 v2（2026-11-08 用户需求：回答更智能更有针对性）
 *
 * v1 基座：data/masters-kb.json（17 位大师 · 25 个高频意图 + 流派总览 + 13F 持仓问询）
 * v2 新增知识层：data/masters-theories.json（scripts/build-mq-kb.js 从知识库深度版解析）
 *   - theories: 129 条理论卡（出处/可查证原文/核心/使用场景）→ 理论级全文检索
 *   - quotes:   131 条可查证语录 → 名言问答
 *   - aliasExtra: 补全芒格/格雷厄姆/费雪/林奇等大师别名 → 点名画像不再漏
 *
 * v2 智能模块：
 *   ① 理论级检索（中文 bigram 相似度，scene×3.2 + 理论名×2.6 + 正文×1.0 加权）
 *   ② 卡片焦点重排（意图命中后按问题相关度排序卡片）
 *   ③ 意图+理论融合（延伸理论卡补充意图未覆盖的细节）
 *   ④ 语录问答（名言/金句/语录触发，点名大师给该大师语录墙）
 *   ⑤ 对比问答（流派×流派、大师×大师并列，冲突不调和）
 *   ⑥ 新手路径（四步入门：世界观→能力圈→指数兜底→安全边际）
 *   ⑦ 追问增强（「还有吗」展开上下文；ctx 记录意图/理论命中）
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
 * 返回：{ html, ctx }，ctx={ guru, ticker, intentId, theoryHits } 供追问
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
// 追问代词（配合 ctx.ticker）
const PRON_TK_RE = /^(那|那么)?(它|这家公司|这公司|这只|这个股|该股|同一家)/;

// v2 追问「还有吗/更多」
const MORE_RE = /^(那|那么)?(还有|再说|继续|展开|更多|详细|补充|接着)(说|讲|聊|点|一点|一些|下)?(吗|呢|呗)?$/;
// v2 语录问句
const QUOTE_RE = /名言|金句|语录|说过什么|说过哪些|说过的话|讲过什么|讲过哪些|经典的话|有哪些话|留下什么话|什么名言|哪些名言/;
// v2 新手问句
const NOVICE_RE = /新手|小白|入门|刚开户|刚开始|从零|零基础|怎么开始|第一步|学投资|投资学习|从哪学|从哪里开始|该学什么/;

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

// 同义词扩展：用户口语词 → 意图关键词，匹配不到时扩展重试
const SYN = {
  接盘: '抄底', 低吸: '抄底', 补仓: '抄底', 摊低成本: '抄底', 加仓: '越跌越买',
  腰斩: '大跌', 跌成狗: '大跌', 跌惨: '大跌', 跌麻: '大跌', 绿了: '大跌', 回调: '大跌', 调整: '大跌',
  认赔: '止损', 割了: '止损', 砍仓: '止损', 清仓: '卖出', 卖掉: '卖出', 卖了: '卖出', 落袋: '落袋为安',
  套住: '被套', 深套: '被套', 解套: '被套', 死扛: '扛单', 套牢: '被套', 割肉: '止损',
  配资: '加杠杆', 借债: '借钱',
  太贵: '贵不贵', 价格合理: '合理价格', 性价比: '估值', 高估: '泡沫',
  心慌: '恐慌', 发慌: '恐慌', 害怕: '恐慌', 睡不着: '失眠', emo: '情绪', 上头: '情绪', 冲动: '情绪',
  崩了: '崩盘', 股灾: '崩盘', 过热: '泡沫', 到顶: '见顶', 天花板: '见顶', 熊市: '崩盘', 牛市: '泡沫', 顶部: '见顶', 底部: '抄底',
  菜鸟: '新手', 零基础: '新手', 刚开户: '新手', 从哪开始: '入门', 起步: '入门',
  挑股票: '选股', 好生意: '好公司', 护城河: '好公司',
  定投: '指数基金', 宽基: '指数基金', 纳指: '指数基金', 窄基: '指数基金',
  亏了: '亏钱', 赔了: '亏钱', 交学费: '复盘', 被收割: '复盘', 反省: '反思',
  滚雪球: '复利', 慢慢变富: '复利', 财务自由: '复利', 暴富: '复利',
  技术分析: '技术面', k线: '技术面', macd: '技术面',
  跟单: '消息', 抄作业: '消息', 跟风: '消息',
  不熟: '看不懂', 热门股: '好公司',
  短线: '波段', 频繁交易: '波段', 手痒: '波段',
  踏空: '错过', 眼红: '错过', 追不上: '错过', 涨没我: '错过',
};
function expandQuery(ql) {
  let ex = ' ' + ql + ' ';
  for (const [k, v] of Object.entries(SYN)) {
    if (k === k.toLowerCase() ? ex.toLowerCase().includes(k) : ex.includes(k)) ex += ' ' + v;
  }
  return ex;
}

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

// ── v3：情境引擎——识别提问者的处境，回答先接住具体处境再上理论 ──
const SITUATIONS = [
  { id: 'trapped', re: /跌了|亏了|亏掉|被套|套住|套牢|深套|腰斩|回不了本|翻不了身|绿了|割在|重挫/,
    echo: '你现在持仓浮亏', pivot: '先拆掉「成本价」这个心理锚：大师们从不按买入价做决策——只问「如果今天空仓，按现在的价格我还愿意买它吗」。愿意，浮亏就不是卖的理由；不愿意，浮盈也该走。' },
  { id: 'profit', re: /涨了|赚了|翻倍|获利|浮盈|大赚|赚不少|回本了/,
    echo: '你现在有浮盈', pivot: '卖出的理由应该是「价格超过了我估算的价值」，而不是「我已经赚够了」——后者会让你早早卖掉赢家、死守输家。' },
  { id: 'fear', re: /恐慌|害怕|慌了|睡不着|失眠|焦虑|心慌|吓到|发毛|坐不住/,
    echo: '你现在很不安', pivot: '睡不着本身就是仓位信号：减到睡得着为止。但先分清你怕的是「价格波动」还是「价值受损」——前者是噪音，后者才是风险。' },
  { id: 'crash', re: /崩了|暴跌|股灾|大盘跌|市场跌|全线|千股|连续下跌|股灾/,
    echo: '市场正在暴跌', pivot: '暴跌时只回答两个问题：①我手里的公司价值受损了吗？②价格是否已明显低于价值？两个都否——这是别人的恐慌，可能是你的机会；第一个是——那就是风险，该跑。' },
  { id: 'leverage', re: /杠杆|配资|借钱|融资|贷款|加马/,
    echo: '你在考虑用杠杆', pivot: '杠杆改变的不是收益大小，是「你能等多久」——它把「等得起」变成「等不起」。段永平三铁律第一条之一就是不做空不借钱。' },
  { id: 'miss', re: /踏空|错过|追高|来不及|别人都赚|眼红|追不追/,
    echo: '你怕错过行情', pivot: '能力圈之外的行情不属于你——你错过的只是「别人的钱」。为追热点改规则的人，多数把上一轮的盈利还了回去。' },
  { id: 'itchy', re: /手痒|频繁|天天交易|忍不住|做t|短线|波段/,
    echo: '你的交易频率有点高', pivot: '利弗莫尔的教训：真正的大钱来自「坐着不动」。先算摩擦成本：一年 100 次交易的手续费+印花税 vs 5 次——频率本身就是亏损来源之一。' },
  { id: 'hesitate', re: /纠结|拿不准|犹豫|要不要|该不该|不知道该|迷茫/,
    echo: '你在犹豫', pivot: '把大决定拆成三个小问题：①这家公司十年后还在吗？②我看得懂它赚钱的方式吗？③现在价格留足容错了吗？三个都过，再谈买。' },
];
function detectSituation(ql, raw) {
  for (const s of SITUATIONS) {
    if (s.re.test(ql)) {
      // v3 数字感知：呼应问题里的具体数字（跌了30%、赚20%…）
      const nm = (raw || '').match(/(跌|亏|涨|赚|回撤|回吐|浮亏|浮盈|跌|赚)[^0-9]{0,4}\d+(\.\d+)?\s*(%|％|个点|点|成|倍)/);
      const num = nm ? `（你提到 ${nm[0].replace(/\s+/g, '')}）` : '';
      return `<div class="mq-situ">🎯 <b>${esc(s.echo)}</b>${esc(num)}——大师级的第一反应：<br>${esc(s.pivot)}</div>`;
    }
  }
  return '';
}

// ── v3：大师原话直答（最相关引语前置）──
function directHtml(c) {
  if (!c || !c.q) return '';
  return `<div class="mq-direct">「${esc(c.q)}」<span class="mq-direct-src">—— ${esc(c.m)} · ${esc(c.t)}</span></div>`;
}

// ── v2：中文 bigram 相似度 ──
function bigrams(s) {
  const t = String(s || '').toLowerCase().replace(/[\s\p{P}]+/gu, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  if (t.length <= 3) for (const ch of t) set.add(ch);
  return set;
}
// 重叠度：|q∩doc| / min(|q|,|doc|)——对短查询友好的 containment
function overlapSim(qSet, docSet) {
  if (!qSet.size || !docSet.size) return 0;
  let inter = 0;
  for (const x of qSet) if (docSet.has(x)) inter++;
  return inter / Math.min(qSet.size, docSet.size);
}

// ── v2：理论级检索 ──
let THEORY_IDX = null;
function theoryIndex(data) {
  if (THEORY_IDX) return THEORY_IDX;
  const idx = [];
  for (const [gid, list] of Object.entries(data.theories || {})) {
    for (const th of list) {
      idx.push({
        gid, th,
        scene: bigrams((th.scene || []).join(' ')),
        t: bigrams(th.t),
        body: bigrams(`${th.c || ''} ${th.q || ''}`),
      });
    }
  }
  THEORY_IDX = idx;
  return idx;
}
function scoreTheories(data, query, limit) {
  const qs = bigrams(query);
  if (qs.size < 2) return [];
  const out = [];
  for (const e of theoryIndex(data)) {
    const sS = overlapSim(qs, e.scene);
    const sT = overlapSim(qs, e.t);
    const sB = overlapSim(qs, e.body);
    const score = sS * 3.2 + sT * 2.6 + sB * 1.0;
    if (score >= 1.8) out.push({ score, gid: e.gid, th: e.th });
  }
  out.sort((a, b) => b.score - a.score);
  // 跨大师多样性：同一位大师最多占前 2 席，避免单调
  const per = {}; const diverse = [];
  for (const it of out) {
    const n = per[it.gid] || 0;
    if (n >= 2) continue;
    per[it.gid] = n + 1;
    diverse.push(it);
    if (diverse.length >= (limit || 6)) break;
  }
  return diverse;
}
function scoreTheoriesOf(data, query, gid, limit) {
  const qs = bigrams(query);
  if (qs.size < 2) return [];
  const out = [];
  for (const e of theoryIndex(data)) {
    if (e.gid !== gid) continue;
    const sS = overlapSim(qs, e.scene);
    const sT = overlapSim(qs, e.t);
    const sB = overlapSim(qs, e.body);
    const score = sS * 3.2 + sT * 2.6 + sB * 1.0;
    if (score >= 1.2) out.push({ score, gid, th: e.th });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit || 3);
}

// v2：大师短名（卡片头用），"沃伦·巴菲特"→"巴菲特"
function shortName(data, gid) {
  const n = String(((data.masters || {})[gid] || {}).name || gid);
  if (n.includes('&')) return n;
  const parts = n.split(/[·\s]+/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : n;
}
function theoryCard(data, hit) {
  const th = hit.th;
  return cardHtml({ m: shortName(data, hit.gid), w: th.w || '理论', t: th.t, q: th.q, c: th.c });
}
function findTheoryBack(data, ref) {
  const list = (data.theories || {})[ref.gid] || [];
  const th = list.find((x) => x.t === ref.t)
    || list.find((x) => x.t && ref.t && (x.t.includes(ref.t) || ref.t.includes(x.t)));
  if (th) return { gid: ref.gid, th, score: 9 };
  return list.length ? { gid: ref.gid, th: list[0], score: 9 } : null;
}

// ── 识别器 ──
function findGurus(data, q, ctx) {
  const alias = data.guruAlias || {};
  const hits = [];
  for (const [gid, names] of Object.entries(alias)) {
    for (const n of names) {
      if (q.includes(String(n).toLowerCase())) { hits.push(gid); break; }
    }
  }
  if (!hits.length && ctx && ctx.guru && PRON_RE.test(q)) hits.push(ctx.guru);
  return hits;
}
function findGuru(data, q, ctx) {
  return findGurus(data, q, ctx)[0] || null;
}

function findTickers(data, q) {
  const found = new Set();
  const unknown = new Set(); // 识别"问了但库中无持仓"的标的
  for (const [cn, tk] of Object.entries(data.tickerAlias || {})) {
    if (q.includes(cn.toLowerCase())) found.add(tk);
  }
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

// v2：卡片焦点重排——按问题相关度排序意图卡片
function rerankCards(cards, query) {
  const qs = bigrams(query);
  if (qs.size < 2 || !cards || cards.length < 2) return cards;
  return cards
    .map((c) => ({ c, s: overlapSim(qs, bigrams(`${c.t || ''} ${c.q || ''} ${c.c || ''}`)) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
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

// v4：大师 × 标的交叉（「巴菲特怎么看英伟达」）：他的持仓事实 + 他自己的理论视角 + 其他大师对照
function answerGuruOnTicker(data, gid, tk, ql) {
  const gname = (data.masters || {})[gid]?.name || shortName(data, gid);
  const name = tickerName(data, tk);
  const gt = (data.guruTickers || {})[gid];
  const pos = gt && (gt.pos || []).find((p) => String(p.t).toUpperCase() === String(tk).toUpperCase());
  const holdFact = pos
    ? `<div class="mq-lead"><b>持仓事实</b>：${esc(gname)}最新披露持仓里有 <b>${esc(tk)}</b>${pos.n ? `（${esc(pos.n)}）` : ''}，占其美股长仓 <b>${num1(pos.w)}%</b>${gt.asOf ? `（报告期 ${esc(gt.asOf)}）` : ''}。</div>`
    : `<div class="mq-lead"><b>持仓事实</b>：${esc(gname)}最新披露持仓里<b>没有</b>${esc(tk)}（13F 滞后最长 45 天、不含期权空头——也可能确实没买，或仓位太小未披露）。</div>`;
  let th = scoreTheoriesOf(data, ql, gid, 2);
  let own = '';
  if (th.length) {
    own = `<div class="mq-lead">用${esc(gname)}自己的框架看这个标的：</div>${th.map((h) => theoryCard(data, h)).join('')}`;
  } else {
    /* 理论库没直接命中标的话题 → 退到该大师画像核心卡 */
    const prof = (data.guruProfiles || {})[gid];
    const core = prof && prof.cards && prof.cards.slice(0, 1);
    if (core && core.length) own = `<div class="mq-lead">先看${esc(gname)}的核心思想：</div>${core.map(cardHtml).join('')}`;
  }
  const intents = scoreIntents(data, ql);
  let crossCard = intents.length && intents[0].cards
    ? intents[0].cards.find((c) => c.m && c.m !== gname)
    : null;
  if (!crossCard) {
    /* 意图未命中 → 从其他大师的画像核心卡里取一张对照（确定性顺序） */
    const profs = (data.guruProfiles || {});
    for (const og of Object.keys(profs)) {
      if (og === gid) continue;
      const oc = profs[og] && profs[og].cards && profs[og].cards[0];
      if (oc && oc.m && oc.m !== gname) { crossCard = oc; break; }
    }
  }
  const cross = crossCard ? `<div class="mq-lead">其他大师的对照：</div>${cardHtml(crossCard)}` : '';
  return {
    html: `<div class="mq-lead">${esc(gname)} × ${esc(name)}（${esc(tk)}）</div>${holdFact}${own}${cross}`
      + chipsHtml([`${gname}的持仓`, `谁在买${name}？`, `${gname}的理论体系`])
      + noteHtml(),
    ctx: { guru: gid, ticker: tk },
  };
}

// 未收录标的：明确告知不在披露持仓，并给通用判断框架
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

// ── v2：语录问答 ──
function answerQuotes(data, gid, gurus) {
  const Q = data.quotes || {};
  const collect = (names) => {
    const out = [];
    for (const g of names) {
      const arr = Q[g] || [];
      if (arr.length) out.push({ gid: g, arr });
    }
    return out;
  };
  let groups;
  let lead;
  if (gid) {
    groups = collect([gid]);
    lead = `<div class="mq-lead"><b>${esc(shortName(data, gid))}</b> 的可查证语录（均标注出处）：`;
    if (!groups.length) {
      groups = collect(Object.keys(Q).slice(0, 10));
      lead = `<div class="mq-lead">${esc(shortName(data, gid))} 的语录暂未收录，先看其他大师的：`;
    }
  } else if (gurus && gurus.length > 1) {
    groups = collect(gurus);
    lead = `<div class="mq-lead">几位大师的可查证语录：</div>`;
    if (!groups.length) groups = collect(Object.keys(Q).slice(0, 10));
  } else {
    groups = collect(Object.keys(Q).slice(0, 12));
    lead = `<div class="mq-lead">大师们的金句墙（每人一条，全部可查证）：</div>`;
  }
  const cards = groups.map(({ gid: g, arr }) => arr.slice(0, gid ? 8 : 1).map((x) => `<div class="mq-card"><div class="mq-src">【${esc(shortName(data, g))} · 语录集】</div><div class="mq-quote">「${esc(x.q)}」</div>${x.src ? `<div class="mq-core">出处：${esc(x.src)}</div>` : ''}</div>`).join('')).join('');
  const chips = [];
  if (gid) chips.push('他的理论体系', `谁在买英伟达？`);
  chips.push('新手应该从哪学起？', '价值投资和趋势交易的区别？');
  return {
    html: `${lead}</div>${cards}${chipsHtml(chips)}${noteHtml()}`,
    ctx: gid ? { guru: gid } : {},
  };
}

// ── v2：对比问答 ──
const SCHOOL_KEYS = {
  价值投资: ['价值', '基本面', '长线', '价投'],
  量化交易: ['量化', '统计', '模型', '数学'],
  趋势交易: ['趋势', '技术面', '投机', '突破', '波段'],
  宏观配置: ['宏观', '配置', '对冲', '全球', '周期'],
};
// v2：流派×流派对比检测（大师×大师对比在主流程按 gurus.length 处理）
function detectSchoolCompare(data, ql) {
  const hit = [];
  for (const [k, words] of Object.entries(SCHOOL_KEYS)) {
    if (words.some((w) => ql.includes(w))) hit.push(k);
  }
  if (hit.length >= 2 && /(和|与|还是|对比|比|哪个|谁|区别|异同|适合)/.test(ql)) return answerCompareSchools(data, hit.slice(0, 2));
  return null;
}
function answerCompareSchools(data, schools) {
  const schoolObjs = (data.schools || []).filter((s) => schools.some((k) => (s.name || '').includes(k.slice(0, 2))));
  const heads = schools.map((k) => `<b>${esc(k)}</b>`).join(' 和 ');
  const reps = schools.map((k) => {
    const ms = Object.values(data.masters || {}).filter((m) => (m.school || '').includes(k.slice(0, 2)));
    return ms.slice(0, 2).map((m) => m.name).join('、');
  });
  const lines = schoolObjs.map((s) => `<div class="mq-card"><div class="mq-src">【${esc(s.name)}】${esc(s.line || '')}</div><div class="mq-core">${esc(s.chain || '')}</div></div>`).join('');
  const repLine = schools.map((k, i) => `${esc(k)}：${reps[i] || '—'}`).join('<br>');
  return {
    html: `<div class="mq-lead">${heads}——两派底层假设不同，不存在谁对谁错，选派先选性格：</div>`
      + `<div class="mq-card"><div class="mq-src">【流派速览 · 代表人物】</div><div class="mq-core">${repLine}</div></div>`
      + `${lines}`
      + `<div class="mq-lead">一句话总结：价值派赚「价格向价值回归」的钱，比的是耐心；趋势/量化派赚「波动与纪律」的钱，比的是系统。两者可以共存于不同仓位，但策略逻辑不能混用。</div>`
      + chipsHtml(['新手应该从哪学起？', '集中还是分散？', '大跌要不要抄底？'])
      + noteHtml(),
    ctx: {},
  };
}
function answerCompareGurus(data, gids, ql) {
  const isHoldQ = HOLD_RE.test(ql);
  if (isHoldQ) {
    const blocks = gids.map((gid) => {
      const gt = (data.guruTickers || {})[gid];
      if (!gt) return `<div class="mq-lead"><b>${esc(shortName(data, gid))}</b>：暂无披露持仓数据。</div>`;
      const rows = gt.pos.map((p) => `<div class="mq-row"><span class="mq-row-tk">${esc(p.t)}</span><span class="mq-row-n">${esc(p.n || '')}</span><b>${num1(p.w)}%</b></div>`).join('');
      return `<div class="mq-lead"><b>${esc(gt.name)}</b>（报告期 ${esc(gt.asOf || '—')}）：</div><div class="mq-table">${rows}</div>`;
    }).join('');
    return {
      html: `<div class="mq-lead">两位的最新披露持仓对比：</div>${blocks}<div class="mq-note">13F 季度披露、滞后最长 45 天。</div>`,
      ctx: { guru: gids[0] },
    };
  }
  const blocks = gids.map((gid) => {
    const hits = scoreTheoriesOf(data, ql, gid, 1);
    if (hits.length) return theoryCard(data, hits[0]);
    const th = ((data.theories || {})[gid] || [])[0];
    return th ? cardHtml({ m: shortName(data, gid), w: th.w || '理论', t: th.t, q: th.q, c: th.c }) : '';
  }).join('');
  const names = gids.map((g) => esc(shortName(data, g)));
  const sameSchool = (data.masters[gids[0]] || {}).school === (data.masters[gids[1]] || {}).school;
  return {
    html: `<div class="mq-lead">${names[0]} 与 ${names[1]}${sameSchool ? '同属一个流派，方法各有侧重' : '分属不同流派——底层假设不同，不强行调和'}。各自最核心的一条：</div>`
      + `${blocks}`
      + `<div class="mq-lead">怎么选：看你的性格——能忍受长期不动就用价值派框架，需要规则和纪律就用趋势/量化框架，两者目标不同不可混用。</div>`
      + chipsHtml(['价值投资和趋势交易的区别？', '新手应该从哪学起？'])
      + noteHtml(),
    ctx: { guru: gids[0] },
  };
}

// ── v2：新手路径 ──
function findTheoryBy(data, gid, re) {
  const list = (data.theories || {})[gid] || [];
  return list.find((th) => re.test(th.t)) || null;
}
function thGidOf(data, th) {
  for (const [gid, list] of Object.entries(data.theories || {})) if (list.includes(th)) return gid;
  return 'buffett';
}
function answerNovice(data) {
  const steps = [
    { tip: '第一步 · 建立世界观：股票不是会跳动的代码，是企业所有权', th: findTheoryBy(data, 'buffett', /买股票|所有权|企业/) },
    { tip: '第二步 · 知道自己不懂什么（能力圈比聪明重要）', th: findTheoryBy(data, 'munger', /能力圈|多元/) || findTheoryBy(data, 'buffett', /能力圈/) },
    { tip: '第三步 · 不会选股就用指数基金兜底（成本低，费率是收益的敌人）', th: findTheoryBy(data, 'bogle', /指数|成本|费率|被动/) },
    { tip: '第四步 · 安全边际：出手的每一笔都给自己留容错空间', th: findTheoryBy(data, 'graham', /安全边际|市场先生/) },
  ].filter((s) => s.th);
  const cards = steps.map((s) => `<div class="mq-lead">${esc(s.tip)}</div>${cardHtml({ m: shortName(data, thGidOf(data, s.th)), w: s.th.w || '理论', t: s.th.t, q: s.th.q, c: s.th.c })}`).join('');
  return {
    html: `<div class="mq-lead">新手四步走（每步一条大师理论，按顺序读）：</div>${cards}`
      + chipsHtml(['普通人不会选股怎么办？', '怎么判断一只股票贵不贵？', '该不该用杠杆？'])
      + noteHtml(),
    ctx: {},
  };
}

// ── v2：「还有吗」追问展开 ──
function answerMore(data, ctx) {
  if (ctx.intentId) {
    const it = (data.intents || []).find((x) => x.id === ctx.intentId);
    if (it && it.cards) {
      return {
        html: `<div class="mq-lead">「${esc(it.label)}」的完整视角（${it.cards.length} 条，每条带出处）：</div>`
          + it.cards.slice(0, 8).map(cardHtml).join('')
          + (it.conflict ? `<div class="mq-conflict">⚖️ ${esc(it.conflict)}</div>` : '')
          + chipsHtml(it.chips) + noteHtml(),
        ctx: { intentId: it.id, guru: ctx.guru || null },
      };
    }
  }
  if (ctx.theoryHits && ctx.theoryHits.length) {
    const cards = ctx.theoryHits.map((r) => findTheoryBack(data, r)).filter(Boolean);
    if (cards.length) {
      return {
        html: `<div class="mq-lead">接着上面，完整的相关理论（按相关度排序）：</div>`
          + cards.map((h) => theoryCard(data, h)).join('') + noteHtml(),
        ctx: { theoryHits: ctx.theoryHits },
      };
    }
  }
  if (ctx.guru) {
    const list = (data.theories || {})[ctx.guru] || [];
    if (list.length) {
      return {
        html: `<div class="mq-lead"><b>${esc(shortName(data, ctx.guru))}</b> 的理论体系要点（共 ${list.length} 条，前 5 条）：</div>`
          + list.slice(0, 5).map((th) => cardHtml({ m: shortName(data, ctx.guru), w: th.w || '理论', t: th.t, q: th.q, c: th.c })).join('')
          + noteHtml(),
        ctx: { guru: ctx.guru },
      };
    }
  }
  return answerFallback(data);
}

// ── 意图分支 ──
function answerIntents(data, intents, ctx, query) {
  const [pS, primary] = intents[0];
  const sec = intents[1];
  // v2：卡片按问题相关度重排
  const ranked = rerankCards(primary.cards, query || '');
  // v3：大师原话直答前置（最相关引语）
  const situ = detectSituation(String(query || ''), String(query || ''));
  const shortQ = (query || '').length <= 6;
  const direct = situ ? '' : directHtml(ranked[0]);
  const restFrom = direct ? 1 : 0;
  const restCount = shortQ ? 1 : 3;
  const cards = direct + ranked.slice(restFrom, restFrom + restCount).map(cardHtml).join('');
  const conflict = primary.conflict ? `<div class="mq-conflict">⚖️ ${esc(primary.conflict)}</div>` : '';
  const chips = [...(primary.chips || [])];
  let head = situ ? '' : esc(primary.intro);
  // 复合视角：两个意图得分都高时并列回答
  if (sec && pS >= 5 && sec[0] >= 5) {
    const secCards = rerankCards(sec[1].cards, query || '').slice(0, 2).map(cardHtml).join('');
    head = situ ? head : `你的问题涉及两个层面，分开说：<br><b>①</b> ${esc(primary.intro)}<br><b>②</b> ${esc(sec[1].intro)}`;
    return {
      html: `${situ || ''}<div class="mq-lead">${head}</div>${cards}${secCards}${conflict}${chipsHtml([...chips, ...(sec[1].chips || [])])}${noteHtml()}`,
      ctx: { ...ctx, intentId: primary.id },
    };
  }
  // 弱命中补充参考
  let extraHtml = '';
  if (sec && pS < 5 && sec[0] >= 2) {
    extraHtml = `<div class="mq-card mq-weak"><div class="mq-src">可能也相关</div><div class="mq-core">【${esc(sec[1].label)}】——点击下方推荐问题查看该视角的完整回答。</div></div>`;
    chips.push(...(sec[1].chips || []).slice(0, 2));
  }
  // v2：理论融合——延伸理论卡（意图卡片之外的具体理论，针对长尾细节）
  const thHits = scoreTheories(data, expandQuery(query || ''), 4)
    .filter((h) => !primary.cards.some((c) => c.t === h.th.t))
    .filter((h) => h.score >= 2.6)
    .slice(0, 2);
  if (thHits.length) {
    extraHtml += `<div class="mq-lead">更具体的理论依据：</div>${thHits.map((h) => theoryCard(data, h)).join('')}`;
    chips.push(`${shortName(data, thHits[0].gid)}的${thHits[0].th.t}`);
  }
  return {
    html: `${situ || ''}<div class="mq-lead">${head}</div>${cards}${extraHtml}${conflict}${chipsHtml(chips)}${noteHtml()}`,
    ctx: { ...ctx, intentId: primary.id, theoryHits: thHits.map((h) => ({ gid: h.gid, t: h.th.t })) },
  };
}

// ── v2：理论检索答案（长尾问题兜底）──
function answerTheories(data, hits, query) {
  const shown = hits.slice(0, 4);
  // v3：直答前置 + 中置信反问引导
  const situ = detectSituation(String(query || ''), String(query || ''));
  const direct = situ ? '' : directHtml({ m: shortName(data, shown[0].gid), t: shown[0].th.t, q: shown[0].th.q });
  const unsure = shown[0].score < 2.8 && !situ
    ? `<div class="mq-lead">我不完全确定你想问哪个方向，先按最接近的理论答——不对的话点下方推荐换个问法：</div>`
    : '';
  const lead = unsure || (situ ? '' : `<div class="mq-lead">从 ${((data.theoryMeta || {}).count) || 129} 条大师理论里检索，最贴合你问题的几条（跨流派、按相关度排序）：</div>`);
  return {
    html: `${situ || ''}${lead}${direct}${shown.slice(direct ? 1 : 0).map((h) => theoryCard(data, h)).join('')}`
      + chipsHtml(hits.slice(4, 6).map((h) => `${shortName(data, h.gid)}的${h.th.t}`).concat(['新手应该从哪学起？']))
      + noteHtml(),
    ctx: { theoryHits: hits.map((h) => ({ gid: h.gid, t: h.th.t })) },
  };
}

// ── 大师画像分支 ──
function answerGuruProfile(data, gid, query, intent) {
  const master = (data.masters || {})[gid] || {};
  const gt = (data.guruTickers || {})[gid];
  const holdLine = gt && gt.pos && gt.pos.length
    ? `<div class="mq-lead">📌 最新披露持仓（报告期 ${esc(gt.asOf || '')}）：<b>${gt.pos.slice(0, 3).map((p) => `${esc(p.t)} ${num1(p.w)}%`).join(' · ')}</b>${gt.total ? ` · 总市值约 ${esc(fmtMoney(gt.total))}` : ''}</div>`
    : '';
  const thList = (data.theories || {})[gid] || [];
  const prof = (data.guruProfiles || {})[gid];
  if (!prof) {
    // v2：无预置画像的大师 → 用理论库动态生成（17 位大师人人可点名）
    if (!thList.length) {
      const near = ((prof || {}).near || []).map((n) => (data.masters || {})[n]).filter(Boolean);
      return {
        html: `<div class="mq-lead"><b>${esc(master.name || gid)}</b> 的理论体系暂未收录。</div>${holdLine}${near.length ? `<div class="mq-lead">风格最接近的是：${near.map((m) => esc(m.name)).join('、')}</div>` : ''}${noteHtml()}`,
        ctx: { guru: gid },
      };
    }
    const hits = query ? scoreTheoriesOf(data, query, gid, 2) : [];
    const chosen = hits.length ? hits.map((h) => h.th) : thList.slice(0, 3);
    const cards = chosen.map((th) => cardHtml({ m: shortName(data, gid), w: th.w || master.work || '理论', t: th.t, q: th.q, c: th.c })).join('');
    const other = intent && intent.cards && intent.cards.length
      ? `<div class="mq-lead">其他大师对「${esc(intent.label)}」的对照：</div>${intent.cards.slice(0, 1).map(cardHtml).join('')}`
      : '';
    const theoryChips = thList.slice(0, 3).map((th) => th.t);
    return {
      html: `<div class="mq-lead"><b>${esc(master.name || gid)}</b>（${esc(master.school || '')}）——已收录 ${thList.length} 条理论${hits.length ? '，以下与你问的点最相关' : '，以下是核心理论'}：</div>${holdLine}${cards}${other}${chipsHtml(theoryChips)}${noteHtml()}`,
      ctx: { guru: gid },
    };
  }
  if (!prof.kb) {
    const near = (prof.near || []).map((n) => (data.masters || {})[n]).filter(Boolean);
    const nearHtml = near.length
      ? `<div class="mq-lead">其理论体系暂未收录，风格最接近的是：</div>${near.map((m) => `<div class="mq-card"><div class="mq-src">【${esc(m.name)} · ${esc(m.work)} · ${esc(m.school)}】</div><div class="mq-core">${esc(m.title)}——可以直接问这位大师的理论。</div></div>`).join('')}`
      : `<div class="mq-lead">${esc(prof.desc)}</div>`;
    return {
      html: `${holdLine}${nearHtml}${chipsHtml(prof.follow)}${noteHtml()}`,
      ctx: { guru: gid },
    };
  }
  // v2：大师理论场景检索——问题里提到的具体话题优先展示该大师对应理论
  let ownCards = '';
  if (query) {
    const hits = scoreTheoriesOf(data, query, gid, 2)
      .filter((h) => !prof.cards.some((p) => p.t === h.th.t));
    if (hits.length) {
      ownCards = `<div class="mq-lead">针对你问的点，他的相关理论：</div>${hits.map((h) => theoryCard(data, h)).join('')}`;
    }
  }
  // v2：动态追问 chips——该大师的其它理论名
  const theoryChips = thList.slice(0, 3).map((th) => th.t);
  const situ = detectSituation(String(query || ''), String(query || ''));
  return {
    html: `${situ || ''}<div class="mq-lead"><b>${esc(master.name || gid)}</b>（${esc(prof.school)}）——${esc(prof.desc)}</div>${holdLine}${prof.cards.map(cardHtml).join('')}${ownCards}${chipsHtml([...(prof.follow || []), ...theoryChips])}${noteHtml()}`,
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
    html: `<div class="mq-lead">17 位大师、四大流派：</div>${members}<div class="mq-lead">每派的核心逻辑：</div>${schoolLine}${chipsHtml(['价值投资和趋势交易的区别？', '新手应该从哪学起？', '普通人不会选股怎么办？'])}${noteHtml()}`,
    ctx: {},
  };
}

function answerFallback(data) {
  return {
    html: `<div class="mq-lead">我可以按大师理论回答带出处的问题，也可以查 12 位大佬的最新持仓。试试这些：</div>${chipsHtml(data.hot || [])}<div class="mq-note">覆盖：抄底、止损、仓位、杠杆、估值、卖出、心态、泡沫、选股、基金、危机、趋势、量化、复盘……也可以直接点名大师或标的，或问「某大师说过什么名言」。</div>`,
    ctx: {},
  };
}

// ── 主入口 ──
// v4 每日一句：从可查证语录里按日期稳定抽取一条（同一天所有人看到同一条）
function dailyQuote(data) {
  const Q = data.quotes || {};
  const all = [];
  for (const [gid, arr] of Object.entries(Q)) {
    for (const it of arr || []) if (it && it.q) all.push({ gid, q: it.q, src: it.src || '' });
  }
  if (!all.length) return '';
  const seed = String(data.asOf || '').split(/[^0-9]/).reduce((a, p) => a + (+p || 0), 0) + all.length;
  const pick = all[seed % all.length];
  const nm = (data.masters || {})[pick.gid]?.name || shortName(data, pick.gid);
  return `<div class="mq-card"><div class="mq-src">💡 今日一句 · 【${esc(nm)}】</div><div class="mq-quote">「${esc(pick.q)}」</div>${pick.src ? `<div class="mq-core">${esc(pick.src)}</div>` : ''}</div>`;
}

function greet(data, gid) {
  const prof = gid ? (data.guruProfiles || {})[gid] : null;
  const thCount = ((data.theoryMeta || {}).count) || Object.values(data.theories || {}).reduce((n, l) => n + l.length, 0);
  const qCount = ((data.theoryMeta || {}).quotes) || Object.values(data.quotes || {}).reduce((n, l) => n + l.length, 0);
  if (prof) {
    if (prof.kb) {
      const m = (data.masters || {})[gid] || {};
      return `<div class="mq-lead">这里是<b>${esc(m.name || '')}</b>的理论智能体——他的核心思想、最新披露持仓、经典语录都能问。</div>${chipsHtml(prof.follow && prof.follow.length ? prof.follow : data.hot)}<div class="mq-note">也可以问任何通用投资问题（抄底/止损/仓位/估值……），17 位大师都会出场。</div>`;
    }
    return `<div class="mq-lead">本页跟踪 <b>${esc((data.guruNames || {})[gid] || gid)}</b> 的最新披露持仓。其理论体系暂未收录，但你可以问任何投资问题——17 位大师会按流派出场作答。</div>${chipsHtml(data.hot)}`;
  }
  return `<div class="mq-lead">你好，我是<b>投资大师智能体</b> 🧙 基于 17 位大师的深度知识库（${thCount} 条理论 + ${qCount} 条可查证语录，价值/量化/趋势/宏观四派）+ 本页 12 位大佬的最新 13F 持仓，带出处的解答。</div>${dailyQuote(data)}${chipsHtml(data.hot)}<div class="mq-note">试试点上面的问题，或直接输入——比如「该不该用杠杆」「巴菲特现在重仓什么」「巴菲特怎么看英伟达」「芒格说过什么名言」「止损和卖出有什么区别」。</div>`;
}

function answerQuery(data, q, ctx) {
  const raw0 = String(q || '').trim();
  if (!raw0) return { html: '', ctx: {} };
  // v3 多问句拆分：第一段主答，其余问题转为可点击的追问按钮
  const segs = raw0.split(/[？?。！\n]+/).map((s) => s.trim()).filter((s) => s.length >= 3);
  const out = answerQueryCore(data, segs.length ? segs[0] : raw0, ctx);
  if (!out || !out.html) return out;
  // v3 会话内大师记忆：记下用户问过谁，追问「还有吗」及对照时可用
  if (out.ctx && out.ctx.guru) {
    const seen = { ...((ctx && ctx.seen) || {}) };
    seen[out.ctx.guru] = (seen[out.ctx.guru] || 0) + 1;
    out.ctx.seen = seen;
  }
  const more = segs.slice(1, 3).filter((s) => s.length <= 24);
  if (more.length) {
    const chipHtml = `<div class="mq-chips">${more.map((m) => `<button class="mq-chip" data-q="${esc(m)}" type="button">追问：${esc(m)}</button>`).join('')}</div>`;
    out.html = out.html.includes('<div class="mq-note">')
      ? out.html.replace('<div class="mq-note">', chipHtml + '<div class="mq-note">')
      : out.html + chipHtml;
  }
  return out;
}

function answerQueryCore(data, raw, ctx) {
  const ql = raw.toLowerCase();
  if (!ql) return { html: '', ctx: {} };

  // 问候
  if (/^(你好|您好|hi|hello|嗨|在吗|哈喽)/.test(ql)) return { html: greet(data, ctx && ctx.guru), ctx: {} };

  // v2 追问：「还有吗/更多」展开上文
  if (MORE_RE.test(raw) && ctx && (ctx.intentId || (ctx.theoryHits && ctx.theoryHits.length) || ctx.guru)) {
    return answerMore(data, ctx);
  }

  const gurus = findGurus(data, ql, ctx);
  const guru = gurus[0] || null;
  const ft = findTickers(data, raw);
  const tickers = ft.known;
  const isHoldQ = HOLD_RE.test(raw);
  const isBuyQ = BUY_RE.test(raw);

  // v2 语录：名言/金句（无标的时）
  if (QUOTE_RE.test(ql) && !tickers.length) return answerQuotes(data, guru || (ctx && ctx.guru) || null, gurus);

  // ① 标的 + 持仓问询：谁重仓了 X / X 谁在买
  if (tickers.length && isHoldQ) return answerTickerHoldings(data, tickers[0]);
  // ①b v4 大师 × 标的交叉（非持仓问询）：巴菲特怎么看英伟达 → 持仓事实 + 他的理论 + 对照
  if (guru && tickers.length && !isHoldQ) return answerGuruOnTicker(data, guru, tickers[0], ql);
  // ② 多位大师 + 持仓问询 → 持仓对比（v2）
  if (gurus.length >= 2 && isHoldQ && !tickers.length) return answerCompareGurus(data, gurus.slice(0, 2), ql);
  // ②b 单大师 + 持仓问询：巴菲特买了什么
  if (guru && isHoldQ && !tickers.length) return answerGuruHoldings(data, guru);
  // ③ 多位大师点名（非持仓问询）→ 理论对比（v2）
  if (gurus.length >= 2 && !tickers.length) return answerCompareGurus(data, gurus.slice(0, 2), ql);
  // ③b 单大师点名（无持仓问询）：大师画像 + 该大师理论场景检索
  if (guru && !tickers.length && !isHoldQ) {
    const intents = scoreIntents(data, ql);
    const prof = (data.guruProfiles || {})[guru];
    if (intents.length && prof && prof.kb) {
      // 大师 + 理论问题 → 该大师在库内的相关理论优先
      const own = prof.cards.map(cardHtml).join('');
      const hits = scoreTheoriesOf(data, ql, guru, 2)
        .filter((h) => !prof.cards.some((p) => p.t === h.th.t));
      const extra = intents[0].cards.filter((c) => c.m && !prof.cards.some((p) => p.t === c.t)).slice(0, 1).map(cardHtml).join('');
      return {
        html: `<div class="mq-lead">${esc((data.masters[guru] || {}).name || '')}对「${esc(intents[0].label)}」的回答——先看他的核心思想：</div>${own}${hits.length ? `<div class="mq-lead">他在你问的这个点上，更具体的理论：</div>${hits.map((h) => theoryCard(data, h)).join('')}` : ''}${extra ? `<div class="mq-lead">其他大师的对照：</div>${extra}` : ''}${chipsHtml(intents[0].chips)}${noteHtml()}`,
        ctx: { guru, intentId: intents[0].id },
      };
    }
    return answerGuruProfile(data, guru, ql, intents.length ? intents[0][1] : null);
  }
  // ③c 流派×流派对比（v2）
  const schoolCmp = detectSchoolCompare(data, ql);
  if (schoolCmp && !tickers.length && !guru) return schoolCmp;
  // ④ 标的 + 买不买 → 持仓事实 + 大师框架
  if (tickers.length && isBuyQ) return answerTickerWithTheory(data, tickers[0]);
  // ⑤ 纯标的（无意图命中）→ 持仓事实
  if (tickers.length) {
    const intents = scoreIntents(data, ql);
    if (intents.length) return answerIntents(data, intents, { ticker: tickers[0] }, ql);
    return answerTickerHoldings(data, tickers[0]);
  }
  // ⑤′ 未收录标的：短句直接点名某代码但库里没有 → 明说 + 给框架
  if (!tickers.length && ft.unknown.length && raw.length <= 14 && !isHoldQ) {
    return answerUnknownTicker(data, ft.unknown[0]);
  }
  // v2 新手路径（无点名、无标的）
  if (!guru && NOVICE_RE.test(ql)) return answerNovice(data);

  // ⑥ 意图命中（先直配，弱命中时用同义词扩展重试）
  let intents = scoreIntents(data, ql);
  if (!intents.length || intents[0][0] < 4) {
    const ex = expandQuery(ql);
    const i2 = scoreIntents(data, ex);
    if (i2.length && (!intents.length || i2[0][0] > intents[0][0])) intents = i2;
  }
  // v2：意图强命中 → 意图答案（内含理论融合）；弱命中时若理论检索更强 → 走理论答案
  const thHits = scoreTheories(data, expandQuery(ql), 8);
  if (intents.length && intents[0][0] >= 4) {
    return answerIntents(data, intents, { guru: guru || (ctx && ctx.guru) || null }, ql);
  }
  if (thHits.length && thHits[0].score >= 2.2) {
    return answerTheories(data, thHits, ql);
  }
  if (intents.length) return answerIntents(data, intents, { guru: guru || (ctx && ctx.guru) || null }, ql);
  // ⑦ 流派总览
  const schoolsIntent = (data.intents || []).find((x) => x.id === 'schools');
  if (schoolsIntent && (schoolsIntent.kw || []).some((kw) => ql.includes(kw))) return answerSchools(data);
  // ⑧ v3：有明确处境但没命中知识库 → 至少接住处境，不冷冰冰兜底
  const situLast = detectSituation(raw, raw);
  if (situLast) {
    return {
      html: `${situLast}<div class="mq-lead">结合你的处境，先给你几条最通用的追问方向（换个更具体的问法会答得更准）：</div>`
        + chipsHtml(data.hot || []) + noteHtml(),
      ctx: {},
    };
  }
  // ⑨ 兜底
  return answerFallback(data);
}

window.MQEngine={answerQuery:answerQuery,greet:greet};
})();
(function(){
  var panel=document.getElementById('mqPanel'),closeB=document.getElementById('mqClose'),
      input=document.getElementById('mqInput'),sendB=document.getElementById('mqSend'),msgs=document.getElementById('mqMsgs');
  if(!panel||!window.MQEngine||!input||!msgs) return;
  var DATA=null,loading=false,CTX=null,GURU='',autoQ='';
  var ob=document.querySelector('.mq-open'); if(ob) GURU=ob.getAttribute('data-guru')||'';
  try{var qm=location.search.match(/[?&]guru=([^&]+)/); if(qm) GURU=decodeURIComponent(qm[1]);}catch(e){}
  try{var pm=location.search.match(/[?&]q=([^&]+)/); if(pm) autoQ=decodeURIComponent(pm[1]).replace(/\+/g,' ');}catch(e){}
  function scroll(){try{msgs.scrollTop=msgs.scrollHeight;}catch(e){}}
  function addBot(html){var w=document.createElement('div');w.className='mq-bot';var b=document.createElement('div');b.className='mq-bub';b.innerHTML=html;w.appendChild(b);msgs.appendChild(w);b.querySelectorAll('[data-q]').forEach(function(el){el.addEventListener('click',function(){ask(el.getAttribute('data-q'));});});scroll();}
  function addUser(t){var w=document.createElement('div');w.className='mq-user';var b=document.createElement('div');b.className='mq-bub';b.textContent=t;w.appendChild(b);msgs.appendChild(w);scroll();}
  function typing(){var w=document.createElement('div');w.className='mq-bot';var b=document.createElement('div');b.className='mq-bub mq-typing';b.innerHTML='<span></span><span></span><span></span>';w.appendChild(b);msgs.appendChild(w);scroll();return w;}
  function load(cb){if(DATA){if(cb)cb();return;}
    if(loading){if(cb)setTimeout(function(){load(cb);},120);return;}
    loading=true;addBot('<div class="mq-note">正在加载大师知识库…</div>');
    fetch('/masters-qa-data.json').then(function(r){if(!r.ok)throw new Error('http '+r.status);return r.json();}).then(function(j){DATA=j;loading=false;msgs.innerHTML='';addBot(window.MQEngine.greet(j,GURU));if(cb)cb();}).catch(function(){loading=false;var b=msgs.querySelector('.mq-bub');if(b)b.innerHTML='知识库加载失败，请刷新重试';});}
  function ask(text){text=String(text||'').trim();if(!text)return;addUser(text);input.value='';
    var t=typing();
    setTimeout(function(){load(function(){
      if(t&&t.parentNode)t.parentNode.removeChild(t);
      var out;try{out=window.MQEngine.answerQuery(DATA,text,CTX);}catch(e){out={html:'解析出错，换个问法试试～'};}
      if(out&&out.ctx)CTX=out.ctx;
      addBot((out&&out.html)||'没有找到相关内容');});},420);}
  if(sendB) sendB.addEventListener('click',function(){ask(input.value);});
  input.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();ask(input.value);}});
  if(closeB) closeB.addEventListener('click',function(){panel.classList.remove('open');});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&panel.classList.contains('open'))panel.classList.remove('open');});
  load(); if(autoQ) ask(autoQ);
})();