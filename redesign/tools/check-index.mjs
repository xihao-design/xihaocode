#!/usr/bin/env node
/* ============================================================
   百度收录自检（只读诊断：不推送、不消耗配额）
   ------------------------------------------------------------
   先说清楚一个事实：百度「普通收录 / 主动推送」的 token 只能**提交** URL，
   没有任何公开接口能拿它查「某条 URL 是否已被收录」。真查收录，只能去
   百度搜索资源平台 → 索引量 看总量，或手动 site: 查询。

   那这个脚本自检什么？—— 自检「影响收录的三件可控的事」：
     1) 提交覆盖率：sitemap 里还有多少 URL **从未提交**过百度（这些肯定没被通知到）
     2) 内容新鲜度：多少 URL 内容已经变了、但还没重推（百度抓的是旧版）
     3) 可访问性（--live）：多少 URL 线上打不开（百度想抓也抓不到）

   这三件事查清 + 补推，就是把「收录慢」里能自己动手的部分全做到位了。

   用法：
     npm run index:check                # 只看提交覆盖率（读本地，秒出）
     npm run index:check -- --live      # 再加线上可访问性审计（需站点已上线）
     npm run index:check -- --top=20    # 每类最多列 20 条（默认 12）
     npm run index:check -- --full      # 全部列出，不截断

   也给别的脚本复用：`import { computeIndexSummary } from './check-index.mjs'`
   拿结构化结果（total / current / stale / never / pending…），不打印。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.resolve(__dirname, '..', 'dist');
const SITE_CFG = path.resolve(__dirname, '..', 'site.config.json');
const STATE = path.join(ROOT, '_daily', 'baidu-pushed.json');

/* 相对 sitemap loc → 本地 dist 文件，用于算内容哈希（与 baidu-push.mjs 同一套口径） */
const localUrl = loc => {
  const rel = loc.replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '');
  return path.join(DIST, rel === '' ? 'index.html' : rel.endsWith('/') ? rel + 'index.html' : rel + '.html');
};
const hashOf = url => {
  try { return crypto.createHash('sha1').update(fs.readFileSync(localUrl(url))).digest('hex').slice(0, 12); }
  catch (e) { return null; }
};

/** 纯本地计算，不联网、不打印。返回结构化汇总，供 CLI 与其他脚本复用。 */
export function computeIndexSummary() {
  const cfg = JSON.parse(fs.readFileSync(SITE_CFG, 'utf8'));
  const SITE = cfg.host || cfg.url.replace(/^https?:\/\//, '');
  const BASE = cfg.url.replace(/\/+$/, '');

  const sm = path.join(DIST, 'sitemap.xml');
  if (!fs.existsSync(sm)) return { error: 'dist/sitemap.xml 不存在，先跑 npm run build。' };

  const all = [...fs.readFileSync(sm, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return { pushed: {} }; } })();
  state.pushed = state.pushed || {};

  const never = [], stale = [], current = [];
  for (const u of all) {
    const prev = state.pushed[u];
    const h = hashOf(u);
    if (!prev) never.push(u);                                   // 从未提交
    else if (h && prev.hash && prev.hash !== h) stale.push(u);   // 内容变了，需重推
    else current.push(u);                                        // 已提交且最新
  }

  const dates = Object.values(state.pushed).map(v => v.at).filter(Boolean).sort();
  return {
    site: SITE,
    base: BASE,
    total: all.length,
    current: current.length,
    stale: stale.length,
    never: never.length,
    pending: never.length + stale.length,
    submitted: Object.keys(state.pushed).length,
    latestPush: dates[dates.length - 1] || null,
    remain: state.remain,
    neverList: never,
    staleList: stale,
    all,
  };
}

async function main() {
  const arg = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
  const has = k => process.argv.includes(`--${k}`);
  const LIVE = has('live'), FULL = has('full');
  const TOP = Number(arg('top')) || 12;

  const s = computeIndexSummary();
  if (s.error) { console.error(s.error); return 1; }

  const show = (label, list) => {
    console.log(`\n${label}（${list.length} 条）`);
    const n = FULL ? list.length : Math.min(list.length, TOP);
    list.slice(0, n).forEach((u, i) => console.log(`  ${String(i + 1).padStart(3)}. ${u}`));
    if (!FULL && list.length > n) console.log(`  … 还有 ${list.length - n} 条（--full 看全部）`);
  };

  console.log(`站点：${s.site}`);
  console.log(`sitemap 共 ${s.total} 条 · 提交状态来自 ${path.relative(ROOT, STATE)}`);
  console.log(`\n提交覆盖率`);
  console.log(`  ✓ 已提交且最新   ${s.current} 条`);
  console.log(`  ↻ 内容已变需重推 ${s.stale} 条`);
  console.log(`  ＋ 从未提交       ${s.never} 条`);

  show('＋ 从未提交（百度还没被通知，最优先补推）', s.neverList);
  show('↻ 内容已变（百度抓的是旧版，需要重推）', s.staleList);

  if (s.submitted) {
    const daysAgo = d => Math.floor((Date.now() - new Date(d + 'T00:00:00Z').getTime()) / 86400000);
    console.log(`\n提交新鲜度`);
    console.log(`  已提交 ${s.submitted} 条 · 最近一次推送 ${s.latestPush || '—'}`);
    if (s.latestPush && daysAgo(s.latestPush) >= 0) console.log(`  （距今天 ${daysAgo(s.latestPush)} 天 —— 只代表「提交时间」，不代表「已收录」）`);
    if (s.remain !== undefined) console.log(`  最近一次记录当天剩余配额：${s.remain}（0 点重置）`);
  } else {
    console.log(`\n提交新鲜度：状态文件为空 —— 你还没用 baidu:push 推过任何页面。`);
  }

  if (LIVE) {
    console.log(`\n线上可访问性审计（${s.base}）…`);
    const check = async url => {
      try {
        const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'xihaoz-index-check' } });
        return { url, ok: res.ok, status: res.status };
      } catch (e) { return { url, ok: false, status: e.name === 'TimeoutError' ? 'timeout' : e.message }; }
    };
    const results = [];
    for (let i = 0; i < s.all.length; i += 8) results.push(...await Promise.all(s.all.slice(i, i + 8).map(check)));
    const down = results.filter(r => !r.ok);
    console.log(`  可访问 ${results.length - down.length} 条 · 打不开 ${down.length} 条`);
    if (down.length) show('✗ 打不开（百度抓不到，先排查部署/链接）', down.map(r => `${r.url}  ${r.status}`));
  } else {
    console.log(`\n（未做线上可访问性审计 —— 加 --live 可查「百度能不能抓到」，需站点已上线）`);
  }

  console.log(`\n———————————————— 结论 ————————————————`);
  if (s.pending) {
    console.log(`有 ${s.pending} 条需要补推（${s.never} 条从未提交 + ${s.stale} 条内容已变）。`);
    console.log(`下一步：npm.cmd run baidu:push   （会自动补推这些，并只推线上能打开的）`);
  } else {
    console.log(`提交侧一切就绪：${s.current} 条都已提交且是最新内容。`);
  }
  console.log(`\n注意：token 只能提交、查不了「是否已收录」。查真实收录量请到百度搜索资源平台 → 索引量，或手动 site:${s.site} 查询。`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try { process.exitCode = await main(); }
  catch (e) { console.error(e); process.exitCode = 1; }
}
