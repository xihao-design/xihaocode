#!/usr/bin/env node
/* ============================================================
   百度搜索资源平台 · 普通收录 API 推送
   ------------------------------------------------------------
   为什么不能「发完就推」：**推送的前提是页面已经能访问**。
   你们的工作流是 publish → build → 手动部署，如果把推送接在前两步里，
   百度爬虫来抓的时候页面还没上线，抓到 404 —— 比不推送更伤。
   所以这个工具**先验证线上能不能打开，再只推 200 的**：
   没上线的记成「等待部署」，部署完再跑一次自动补推。顺序错了也不会推错。

   另一个要推的理由：站内页面会更新（比如补了文案、加了技能条目）。
   所以状态里存的是**页面内容的哈希**，内容变了会重新推一次，
   而不是「推过一次就永远不推」。

   Token 从哪来：百度搜索资源平台 → 普通收录 → API 提交 → 推送接口，那一串就是 token。
   存放顺序（与 GitHub Token 一致的习惯）：
     1) 环境变量 BAIDU_PUSH_TOKEN
     2) 文件 _daily/baidu-push-token.txt（_daily/ 整个目录已在 .gitignore 里）

   用法：
     npm.cmd run baidu:push                  # 推「新页面 + 内容有变化」的（推荐日常用这个）
     npm.cmd run baidu:push -- --max=10      # 最多推 10 条，省着用配额
     npm.cmd run baidu:push -- --all         # 首次全量（>20 条要显式确认）
     npm.cmd run baidu:push -- --urls=/a,/b  # 手动指定
     npm.cmd run baidu:push -- --no-verify   # 跳过上线校验（不建议，除非你有别的确认）
     npm.cmd run baidu:push -- --dry         # 只看会推什么
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.resolve(__dirname, '..', 'dist');
const SITE_CFG = path.resolve(__dirname, '..', 'site.config.json');
const STATE = path.join(ROOT, '_daily', 'baidu-pushed.json');
const TOKEN_FILES = [
  path.join(ROOT, '_daily', 'baidu-push-token.txt'),
  path.resolve(__dirname, 'daily', 'state', 'baidu-push-token.txt'),
];

const arg = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
const has = k => process.argv.includes(`--${k}`);
const DRY = has('dry'), ALL = has('all'), NOVERIFY = has('no-verify');
const MAX = Number(arg('max')) || 0;
const BATCH = 2000;                       // 百度单次提交上限很大，真正的限制是当天配额

const cfg = JSON.parse(fs.readFileSync(SITE_CFG, 'utf8'));
const SITE = cfg.host || cfg.url.replace(/^https?:\/\//, '');
const BASE = cfg.url.replace(/\/+$/, '');
// site 参数必须与百度那边登记的站点完全一致，所以允许在配置里显式指定形态
// （带不带协议前缀是有效差异 —— 不一致会返回 not_same_site，而不是报错）
const PUSH_SITE = (cfg.seo && cfg.seo.baiduPush && cfg.seo.baiduPush.site) || SITE;

/* ---------- 推送优先级 ----------
   每日配额只有 10 条；不排序的话，高价值页会永远排在数百条积压后面（纯 FIFO）。
   规则来自 site.config.json 的 seo.baiduPush.priority：按顺序匹配 path，命中即用其 score。
   都不命中用 fallback。同分保持 sitemap 原顺序。
   没配 priority 时全部同分 → 排序是空操作，等价于原来的 FIFO（安全默认）。 */
const PRIORITY_RULES = (cfg.seo && cfg.seo.baiduPush && Array.isArray(cfg.seo.baiduPush.priority))
  ? cfg.seo.baiduPush.priority.map(r => ({ re: new RegExp(r.path), score: Number(r.score) || 0, label: r.label || '', aggregator: !!r.aggregator }))
  : [];
const PRIORITY_FALLBACK = (cfg.seo && cfg.seo.baiduPush && Number(cfg.seo.baiduPush.fallback)) || 0;
const pathOf = url => String(url).replace(/^https?:\/\/[^/]+/, '') || '/';
const baseScore = url => { const p = pathOf(url); for (const r of PRIORITY_RULES) if (r.re.test(p)) return r.score; return PRIORITY_FALLBACK; };
const pushLabel = url => { const p = pathOf(url); for (const r of PRIORITY_RULES) if (r.re.test(p)) return r.label; return ''; };

/* 「从未提交过」优先于「提交过但内容又变了」。
   ------------------------------------------------------------
   为什么必须分开算：状态里存的是页面内容哈希，而首页/分类页这类聚合页
   **每发布一次内容就变一遍**（新增任何 App、AI 工具或技能都会改它们），
   于是它们永远留在候选队列里，又因为静态优先级最高，每天 10 个名额
   全被它们循环吃掉 —— 详情页实测排在候选第 45 位，永远轮不到（App 详情
   123 条，历史上一条都没推成功过）。这不是配额不够，是队列被插队。

   取值：加成一个固定偏移，只要大于「静态分最高值」即可保证所有未提交页
   整体排在所有重推页之前，同时**不破坏未提交页内部的原排序**。
   当前配置最高静态分 1000（首页），所以 1200 能留出余量；
   改 site.config.json 的 priority 时若把分数抬到 1200 以上，记得同步调这里。
   想关掉这个行为：改成 0 即可，排序立刻退回原来的纯静态优先级。 */
const NEVER_PUSHED_BONUS = (() => {
  const v = cfg.seo && cfg.seo.baiduPush && cfg.seo.baiduPush.neverPushedBonus;
  return v === undefined || v === null ? 1200 : Number(v) || 0;
})();
const pushScore = (url, neverPushed) => baseScore(url) + (neverPushed ? NEVER_PUSHED_BONUS : 0);

/* 聚合页的「内容有变」不算数。
   ------------------------------------------------------------
   聚合页（首页、频道/分类入口、专题、AI 分类 —— 由 site.config.json 里
   aggregator:true 标出）只要站点发布一次，页内链接列表就变一遍，内容哈希必然
   变化。若照旧判定「内容有变 → 重回队列」，它们就会每次都插回最前面，
   把每天 10 个名额循环吃掉。所以：聚合页推过之后，只在超过 rePushAfterDays
   天才允许重推；在窗口内不参与候选。详情页不受影响，仍按哈希判定。 */
const AGGREGATOR_RULES = PRIORITY_RULES.filter(r => r.aggregator);
const REPUSH_AFTER_DAYS = (() => {
  const cli = Number(arg('repush-days'));      // 临时试算用：--repush-days=60
  if (Number.isFinite(cli) && cli > 0) return cli;
  const v = cfg.seo && cfg.seo.baiduPush && cfg.seo.baiduPush.rePushAfterDays;
  return v === undefined || v === null ? 30 : Number(v) || 0;
})();
const isAggregator = url => AGGREGATOR_RULES.some(r => r.re.test(pathOf(url)));
/** 距上次成功推送过了几天。状态里的 at 是本地日期字符串（YYYY-MM-DD），
    按本地零点解析，避免 UTC 偏移让「昨天」算成今天。 */
const daysSincePush = url => {
  const rec = state.pushed[url];
  if (!rec || !rec.at) return Infinity;          // 没有记录 → 视为很久以前
  const [y, m, d] = String(rec.at).split('-').map(Number);
  if (!y || !m || !d) return Infinity;
  return (Date.now() - new Date(y, m - 1, d).getTime()) / 86400000;
};
const aggregatorHeld = url => isAggregator(url) && daysSincePush(url) < REPUSH_AFTER_DAYS;

/** 本地日期 YYYY-MM-DD。**不要**用 toISOString().slice(0,10) —— 那是 UTC 日期，
    本地 00:00–08:00 之间推送会被记成前一天（daily/util.mjs 的 today() 就是为躲这个坑写的）。 */
const localDate = (d = new Date()) => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* ---------- Token ---------- */
const TOKEN = (() => {
  if (process.env.BAIDU_PUSH_TOKEN) return { token: process.env.BAIDU_PUSH_TOKEN.trim(), from: '环境变量 BAIDU_PUSH_TOKEN' };
  for (const f of TOKEN_FILES) {
    try {
      const t = fs.readFileSync(f, 'utf8').trim();
      if (t) return { token: t, from: path.relative(ROOT, f) };
    } catch (e) { /* 没配就没有 */ }
  }
  return { token: '', from: null };
})();

if (!TOKEN.token && !DRY) {
  console.error('没有百度推送 token。');
  console.error(`
  取 token：百度搜索资源平台 → 你的站点 → 普通收录 → API 提交 → 推送接口
  然后二选一：
    A) 环境变量：  [Environment]::SetEnvironmentVariable('BAIDU_PUSH_TOKEN','你的token','User')
    B) 写文件：    [IO.File]::WriteAllText('${TOKEN_FILES[0]}', '你的token', [Text.UTF8Encoding]::new($false))

  注意：这个 token 能消耗你当天的推送配额，别贴到聊天窗口里（包括贴给我）。
  配好后先用 npm.cmd run baidu:push -- --dry 看它会推什么。`);
  process.exit(1);
}

/* ---------- 1. 候选 URL ---------- */
const sm = path.join(DIST, 'sitemap.xml');
if (!fs.existsSync(sm)) { console.error('dist/sitemap.xml 不存在，先跑 npm run build。'); process.exit(1); }
const localUrl = loc => {
  const rel = loc.replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '');
  return path.join(DIST, rel === '' ? 'index.html' : rel.endsWith('/') ? rel + 'index.html' : rel + '.html');
};
const all = [...fs.readFileSync(sm, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);

/** 页面内容哈希：内容变了要重新推，所以状态里存的不是「推过就算」 */
const hashOf = url => {
  try { return crypto.createHash('sha1').update(fs.readFileSync(localUrl(url))).digest('hex').slice(0, 12); }
  catch (e) { return null; }
};

const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return { pushed: {} }; } })();
state.pushed = state.pushed || {};

let candidates;
const heldAggregators = [];      // 内容有变、但在冷却期内不推的聚合页（只用于报告）
const releasedAggregators = [];  // 冷却期满、重新回到候选的聚合页（只用于报告）
if (arg('urls')) {
  candidates = arg('urls').split(',').map(s => s.trim()).filter(Boolean)
    .map(u => (u.startsWith('http') ? u : BASE + (u.startsWith('/') ? u : '/' + u)));
} else {
  candidates = all.filter(u => {
    const h = hashOf(u);
    const prev = state.pushed[u];
    if (!prev) return true;                      // 没推过 → 一定在候选里
    if (h && prev.hash !== h) {
      if (isAggregator(u)) {
        if (aggregatorHeld(u)) { heldAggregators.push(u); return false; }
        releasedAggregators.push(u);
      }
      return true;
    }
    return false;
  });
  // 按推送优先级重排：先「从未提交过」的，再「内容有变化」的；各自内部按静态优先级。
  // 同分保持 sitemap 原顺序（稳定、可预期）。
  candidates = candidates
    .map((u, i) => ({ u, i, s: pushScore(u, !state.pushed[u]) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map(x => x.u);
}

const totalCandidates = candidates.length;
const firstRun = Object.keys(state.pushed).length === 0;
// 先截取再判断：--max=N 本来就是「省着用配额」那条路，不该反过来被配额闸门拦住
if (MAX) candidates = candidates.slice(0, MAX);

// 配额闸门。--dry 不消耗配额，所以不受它限制 —— 预演的意义就是先看清楚再决定。
if (!DRY && !arg('urls') && !ALL && candidates.length > 20) {
  console.error(firstRun
    ? `这是第一次推送，候选有 ${totalCandidates} 条 —— 直接推会一口气吃掉当天配额。`
    : `候选 ${candidates.length} 条，超过 20 条需要显式确认。`);
  console.error(`  · 想先推重点页面：npm.cmd run baidu:push -- --max=10`);
  console.error(`  · 想全量推：     npm.cmd run baidu:push -- --all`);
  process.exit(1);
}
if (MAX && totalCandidates > candidates.length) {
  console.log(`候选共 ${totalCandidates} 条，已按推送优先级排序，取前 ${candidates.length} 条。`);
}

console.log(`站点：${SITE}`);
console.log(`Token：${TOKEN.from || '（--dry，未读取）'}`);
console.log(`sitemap ${all.length} 条 · 待推候选 ${candidates.length} 条${firstRun ? '（首次推送，状态为空）' : ''}`);
if (heldAggregators.length) {
  console.log(`  聚合页 ${heldAggregators.length} 条内容有变、但推过不到 ${REPUSH_AFTER_DAYS} 天，本次不重推：`);
  for (const u of heldAggregators.slice(0, 5)) console.log(`    ${u}（${Math.floor(daysSincePush(u))} 天前推过）`);
  if (heldAggregators.length > 5) console.log(`    …还有 ${heldAggregators.length - 5} 条`);
}
if (releasedAggregators.length) {
  // 冷却期满只是「允许重推」，能不能进当天名额仍看排序 —— 说清楚，免得以为没生效
  const inList = candidates.filter(u => releasedAggregators.includes(u)).length;
  console.log(`  聚合页 ${releasedAggregators.length} 条已过 ${REPUSH_AFTER_DAYS} 天冷却期、重新进入候选`
    + `（其中 ${inList} 条排进了本次待推名单）`);
}

/* ---------- 2. 只推已经能打开的页面 ---------- */
let pushList = candidates, waiting = [];
if (!NOVERIFY) {
  const check = async url => {
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'xihaoz-baidu-push' } });
      return { url, ok: res.ok, status: res.status };
    } catch (e) { return { url, ok: false, status: e.name === 'TimeoutError' ? 'timeout' : e.message }; }
  };
  const results = [];
  for (let i = 0; i < candidates.length; i += 8) {
    results.push(...await Promise.all(candidates.slice(i, i + 8).map(check)));
  }
  pushList = results.filter(r => r.ok).map(r => r.url);
  waiting = results.filter(r => !r.ok);
  console.log(`上线校验：${pushList.length} 条可访问 · ${waiting.length} 条还打不开（记为等待部署）`);
  if (waiting.length && waiting.length <= 8) {
    for (const w of waiting) console.log(`    等待部署 ${w.url}（${w.status}）`);
  } else if (waiting.length) {
    console.log(`    （前 4 条）${waiting.slice(0, 4).map(w => `${w.url} ${w.status}`).join(' · ')}`);
  }
}

if (!pushList.length) {
  console.log('\n没有可推的页面。');
  if (waiting.length) console.log('原因：候选页面还没上线 —— 先把 dist 部署上去，再跑一次这个命令就会自动补推。');
  process.exit(0);
}

if (DRY) {
  const nNew = pushList.filter(u => !state.pushed[u]).length;
  console.log(`\n--dry：不推送、不写状态。真实运行会推这 ${pushList.length} 条（已按优先级排序）`);
  console.log(`      其中 从未提交 ${nNew} 条 · 内容有变重推 ${pushList.length - nNew} 条：`);
  for (const u of pushList.slice(0, 15)) {
    const lb = pushLabel(u);
    // 排序键对这两类不同，打印出来才看得出顺序为什么是这样
    const kind = state.pushed[u] ? '变更' : '新';
    console.log(`  [${kind}] ${lb ? `[${lb}] `.padEnd(12) : ''.padEnd(12)}${u}`);
  }
  if (pushList.length > 15) console.log(`  …还有 ${pushList.length - 15} 条`);
  process.exit(0);
}

/* ---------- 3. 推送 ---------- */
/** 发一批推送。对「please retry later」(HTTP 505) 退避重试 ——
    实测配额用尽或触发限流时会返回它，而且常常是瞬时的（隔一会儿重试就正常），
    所以不能一次 505 就判死。返回最后一次的 { res, text, j }。 */
async function pushBatch(batch) {
  const RETRY_DELAYS = [3000, 8000, 20000];
  let last = null;
  for (let i = 0; i <= RETRY_DELAYS.length; i++) {
    const res = await fetch(`http://data.zz.baidu.com/urls?site=${PUSH_SITE}&token=${TOKEN.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': 'xihaoz-baidu-push' },
      body: batch.join('\n'),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* 百度出错时返回的是纯文本 */ }
    last = { res, text, j };
    const transient = res.status === 505 || (j && j.error === 505);
    if (!transient) return last;
    if (i < RETRY_DELAYS.length) {
      const wait = RETRY_DELAYS[i];
      console.log(`  接口返回 505 please retry later，${wait / 1000}s 后重试（第 ${i + 2} 次）…`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  return last;
}

/** 本次运行里、本地日期为今天、且确实被百度受理过的条数。
    用来区分「今天从头到尾 0 配额」和「今天本来有配额、已被前面的批次数吃掉」——
    这两种情况原先报同一句话，从输出上看不出区别。 */
const pushedToday = () => Object.values(state.pushed).filter(v => v && v.at === localDate()).length;

/** 配额/限流这类「非故障」退出：存状态、退出码 2，未推的候选明天自动继续。
    输出必须能回答「配额到底是没了，还是被我这一次用完了」。 */
function exitQuota(msg) {
  const todayDone = pushedToday();
  const total = Object.keys(state.pushed).length;
  console.log(`\n  ${msg}`);
  if (pushed > 0) {
    console.log(`  准确说：本次运行已受理 ${pushed} 条后额度归零，属于「今天已经推完了」，不是故障。`);
  } else if (todayDone > 0) {
    console.log(`  准确说：今天已经成功推过 ${todayDone} 条（记录见 ${path.relative(ROOT, STATE)}），额度是那几次用掉的。`);
    console.log('  再跑同一条命令也不会多推 —— 等当天额度重置。');
  } else {
    console.log('  注意：今天**一条都还没推成功**，额度就已经是 0。这种情况多半不在我们这边：');
    console.log('    · 百度账号未完成实名认证，或该站点被判定低质 → 平台下调/回收了 API 推送额度');
    console.log('      （依据：《关于回收网站提交配额的通知》 https://ziyuan.baidu.com/college/videoinfo?id=3531 ）');
    console.log('    · 站点在搜索资源平台里还没通过验证，或 site 参数与登记的站点形态不一致');
    console.log('  可去 搜索资源平台 → 普通收录 → API 提交 页面看当天额度的真实数字。');
  }
  console.log(`  已受理累计 ${total} 条 · 队列里没推完的会留着，额度恢复后跑同一条命令自动续推。`);
  state.updatedAt = new Date().toISOString();
  state.quotaExhaustedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  process.exit(2);
}

let pushed = 0, remain = null;
const rejected = { not_same_site: [], not_valid: [] };
for (let i = 0; i < pushList.length; i += BATCH) {
  const batch = pushList.slice(i, i + BATCH);
  const { res, text, j } = await pushBatch(batch);

  // 当天配额用尽：实测返回 HTTP 400 + {"error":400,"message":"over quota"}。
  // 这是**正常状态**（配额每天重置），所以单独处理：不当作故障，退出码 2。
  // 「本次已受理几条」由 exitQuota 自己打印，这里只给原因。
  if (j && /over quota/i.test(j.message || '')) {
    exitQuota('当天推送配额已用尽（百度返回 over quota）。');
  }

  // 退避重试后仍是 505：多半是当天配额已尽或限流，同样不当作故障。
  if (res.status === 505 || (j && j.error === 505)) {
    exitQuota('接口持续返回 505 please retry later（通常是当天配额已尽或触发限流）。');
  }

  if (!res.ok || !j) {
    console.error(`\n推送失败：HTTP ${res.status}\n${text.slice(0, 300)}`);
    console.error('常见原因：token 不对、站点未验证、或者 site 参数与平台登记的站点形态不一致。');
    process.exit(1);
  }
  if (j.error) {
    console.error(`\n百度返回错误：${j.error}${j.message ? ' —— ' + j.message : ''}`);
    process.exit(1);
  }
  pushed += j.success || 0;
  remain = j.remain;
  for (const k of ['not_same_site', 'not_valid']) if (Array.isArray(j[k])) rejected[k].push(...j[k]);

  // 只有成功受理的才记进状态；未受理的下次还会是候选
  for (const u of batch) {
    if (rejected.not_same_site.includes(u) || rejected.not_valid.includes(u)) continue;
    state.pushed[u] = { at: localDate(), hash: hashOf(u) };
  }
}
state.updatedAt = new Date().toISOString();
state.remain = remain;
fs.mkdirSync(path.dirname(STATE), { recursive: true });
fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');

console.log(`\n———————— 推送完成 ————————`);
console.log(`  百度受理 ${pushed} 条${remain !== null ? ` · 当天剩余配额 ${remain}` : ''}`);
if (rejected.not_same_site.length) console.log(`  域名不符 ${rejected.not_same_site.length} 条（site 参数与 URL 不是同一个域名）`);
if (rejected.not_valid.length) {
  console.log(`  格式不被接受 ${rejected.not_valid.length} 条：`);
  for (const u of rejected.not_valid.slice(0, 5)) console.log('    ' + u);
}
if (waiting.length) console.log(`  等待部署 ${waiting.length} 条 —— 部署后再跑一次本命令即可自动补推`);
console.log(`  状态：${path.relative(ROOT, STATE)}（记录每条已推 URL 与其内容哈希，内容变了会重推）`);
if (remain !== null && remain < 10) console.log(`\n  注意：当天配额只剩 ${remain} 条，省着用。`);
