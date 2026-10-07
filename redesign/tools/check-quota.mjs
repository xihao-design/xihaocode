#!/usr/bin/env node
/* ============================================================
   百度普通收录 · 配额探针
   ------------------------------------------------------------
   要回答的问题：你站点「普通收录 / 主动推送」的**当天配额到底是多少**？

   原理：推送接口 data.zz.baidu.com/urls 的返回里带 remain = 当天剩余配额。
   在**当天还没推过任何 URL 时**跑一次，就能量出当天总额度：
      当天总配额 ≈ 本次返回的 remain + 本次成功受理的条数

   为什么值得量：publish.mjs 里写死了 --max=10（依据是注释里的「实测 10 条/天」）。
   若实际配额更高，每次只推 10 条就是在浪费配额，积压（现在 360+ 条）永远清不完。

   实测坑：配额用尽 / 触发限流时，接口返回的是 HTTP 505 {"error":505,"message":"please retry later"}，
   并不是推送脚本注释里写的 over quota。所以这里会带退避重试，重试仍失败才判定为「今天测不出来」。

   用法：
     node redesign\tools\check-quota.mjs                     # 从 sitemap 取 1 条当探针
     node redesign\tools\check-quota.mjs --url=https://...   # 手动指定探针 URL
     node redesign\tools\check-quota.mjs --dry               # 只显示会发什么，不发请求

   成本：发 1 条，消耗至多 1 条配额。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.resolve(__dirname, '..', 'dist');
const SITE_CFG = path.resolve(__dirname, '..', 'site.config.json');
const TOKEN_FILES = [
  path.join(ROOT, '_daily', 'baidu-push-token.txt'),
  path.resolve(__dirname, 'daily', 'state', 'baidu-push-token.txt'),
];

const has = k => process.argv.includes(`--${k}`);
const arg = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };

const cfg = JSON.parse(fs.readFileSync(SITE_CFG, 'utf8'));
const SITE = cfg.host || cfg.url.replace(/^https?:\/\//, '');
const BASE = cfg.url.replace(/\/+$/, '');
const PUSH_SITE = (cfg.seo && cfg.seo.baiduPush && cfg.seo.baiduPush.site) || SITE;

const TOKEN = (() => {
  if (process.env.BAIDU_PUSH_TOKEN) return { token: process.env.BAIDU_PUSH_TOKEN.trim(), from: '环境变量 BAIDU_PUSH_TOKEN' };
  for (const f of TOKEN_FILES) {
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return { token: t, from: path.relative(ROOT, f) }; } catch (e) { /* 没配就没有 */ }
  }
  return { token: '', from: null };
})();

if (!TOKEN.token) {
  console.error('没有百度推送 token，无法探测配额。');
  console.error('取 token：百度搜索资源平台 → 你的站点 → 普通收录 → API 提交 → 推送接口。');
  process.exit(1);
}

/* 探针 URL：默认取 sitemap 里最后一条（通常是长尾详情页，最该被推的那类） */
let probe = arg('url');
if (probe && !probe.startsWith('http')) probe = BASE + (probe.startsWith('/') ? probe : '/' + probe);
if (!probe) {
  const sm = path.join(DIST, 'sitemap.xml');
  if (!fs.existsSync(sm)) { console.error('dist/sitemap.xml 不存在，先跑 npm run build，或用 --url= 指定。'); process.exit(1); }
  const locs = [...fs.readFileSync(sm, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  probe = locs[locs.length - 1];
}

console.log(`站点      ：${SITE}（site 参数 ${PUSH_SITE}）`);
console.log(`Token     ：${TOKEN.from}`);
console.log(`探针 URL  ：${probe}`);

if (has('dry')) { console.log('\n--dry：不发请求。'); process.exit(0); }

const endpoint = `http://data.zz.baidu.com/urls?site=${PUSH_SITE}&token=${TOKEN.token}`;
const RETRY_DELAYS = [5000, 15000, 30000];   // 505 = please retry later，退避重试

let res = null, text = '', attempts = 0, ms = 0;
for (let i = 0; i <= RETRY_DELAYS.length; i++) {
  attempts = i + 1;
  const t0 = Date.now();
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': 'xihaoz-quota-probe' },
      body: probe,
      signal: AbortSignal.timeout(30000),
    });
    text = await res.text();
  } catch (e) {
    res = null; text = `请求异常：${e.message}`;
  }
  ms = Date.now() - t0;
  let jj = null; try { jj = JSON.parse(text); } catch (e) { /* 纯文本 */ }
  const transient = !res || res.status === 505 || (jj && jj.error === 505);
  console.log(`\n第 ${attempts} 次：HTTP ${res ? res.status : '—'}（${ms}ms）`);
  console.log(`  返回：${text.slice(0, 300)}`);
  if (!transient) break;
  if (i < RETRY_DELAYS.length) {
    console.log(`  → please retry later，等 ${RETRY_DELAYS[i] / 1000}s 后重试…`);
    await new Promise(r => setTimeout(r, RETRY_DELAYS[i]));
  }
}

console.log('\n———————————————— 解读 ————————————————');
let j = null;
try { j = JSON.parse(text); } catch (e) { /* 纯文本 */ }

if (j && /over quota/i.test(j.message || '')) {
  console.log('  当天配额已用尽（over quota）。');
  console.log('  → 明天 0 点重置后，第一件事就重跑本脚本，量出当天总配额。');
} else if (j && j.error === 505) {
  console.log(`  重试 ${attempts} 次仍是 505 please retry later —— 今天测不出配额。`);
  console.log('  两种可能：① 当天配额已用尽；② 触发限流。');
  console.log('  → 明天 0 点重置后立刻重跑本脚本（那时没有别的推送干扰，测得最准）。');
} else if (j && j.error) {
  console.log(`  接口报错：${j.error}${j.message ? ' —— ' + j.message : ''}`);
  console.log('  常见原因：token 不对、站点未验证、或 site 参数与平台登记的站点形态不一致。');
} else if (j) {
  const success = j.success || 0;
  const remain = j.remain;
  console.log(`  本次成功受理 ${success} 条 · 当天剩余配额 ${remain}`);
  if (typeof remain === 'number') {
    const quota = remain + success;
    console.log(`  → 若这是你**当天第一次**推送，当天总配额 ≈ ${quota} 条。`);
    if (quota <= 10) console.log('  → 与 publish 里写死的 --max=10 一致：配额确实是 10 条/天，不需要调大。');
    else console.log(`  → 配额明显大于 10！应把 publish.mjs 的 --max=10 调到 ≤ ${quota}，别浪费额度。`);
    if (remain === 0) console.log('  → 本次已把当天配额用尽，明天再测更准。');
  }
  if (Array.isArray(j.not_same_site) && j.not_same_site.length) console.log(`  域名不符 ${j.not_same_site.length} 条（site 参数与 URL 域名不一致）。`);
  if (Array.isArray(j.not_valid) && j.not_valid.length) console.log(`  格式不被接受 ${j.not_valid.length} 条。`);
} else {
  console.log('  返回不是 JSON —— 百度异常时返回纯文本，看上面的原始返回。');
}
