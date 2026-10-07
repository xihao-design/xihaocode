#!/usr/bin/env node
/* ============================================================
   sitemap：提交前自检 + 对真有接口的引擎提交
   ------------------------------------------------------------
   先把事实说清楚（来自百度官方文档 + 实测）：
     · 普通收录有三种提交方式：API 提交 / 手动提交（共享配额 10 万/天）、
       sitemap 文件提交（**独立配额**，按站点质量评估）
     · **sitemap 提交没有公开 API** —— 实测 data.zz.baidu.com/sitemap 的三种形态
       （GET query / POST query / POST body）全部返回 400，只能在资源平台界面操作
     · 但 sitemap 是**自动可发现**的：robots.txt 里有 Sitemap: 行，百度就会自己来抓
     · 百度硬性要求：**索引型 sitemap（<sitemapindex>）不予处理**；
       单文件 ≤ 5 万条 URL、< 10MB

   所以这个工具做两件事：
     1) 提交前自检 —— 把上面这些硬性要求逐条验一遍，避免「提交了却根本不被处理」
     2) 对**有公开接口**的引擎真的提交一次（Bing ping）
   百度那边没有接口，自检通过后照下面提示去界面点一下即可（点一次就够，之后靠自动发现）。

   用法：
     node redesign\tools\submit-sitemap.mjs          # 自检 + Bing 提交
     node redesign\tools\submit-sitemap.mjs --no-ping  # 只自检
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_CFG = path.resolve(__dirname, '..', 'site.config.json');
const has = k => process.argv.includes(`--${k}`);
const arg = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };

const cfg = JSON.parse(fs.readFileSync(SITE_CFG, 'utf8'));
const BASE = cfg.url.replace(/\/+$/, '');
const HOST = new URL(BASE).host;
const SITEMAP_URL = arg('sitemap') || `${BASE}/sitemap.xml`;
const MAX_URLS = 50000;
const MAX_BYTES = 10 * 1024 * 1024;

let fail = 0;
const ok = m => console.log(`  ✓ ${m}`);
const bad = m => { console.log(`  ✗ ${m}`); fail++; };
const warn = m => console.log(`  ! ${m}`);

console.log(`站点    ：${BASE}`);
console.log(`sitemap ：${SITEMAP_URL}`);

/* ---------- 1. sitemap 本体自检 ---------- */
console.log('\n──── 1. sitemap 本体（百度硬性要求）────');
let sitemapText = '';
try {
  const res = await fetch(SITEMAP_URL, { redirect: 'follow', headers: { 'User-Agent': 'xihaoz-sitemap-check' }, signal: AbortSignal.timeout(25000) });
  sitemapText = await res.text();
  const bytes = Buffer.byteLength(sitemapText, 'utf8');
  res.ok ? ok(`线上可访问（HTTP ${res.status}）`) : bad(`线上打不开（HTTP ${res.status}）`);

  if (/<sitemapindex[\s>]/i.test(sitemapText)) {
    bad('这是「索引型 sitemap」（<sitemapindex>）—— 百度明确不予处理，必须换成单个 <urlset> 文件');
  } else if (/<urlset[\s>]/i.test(sitemapText)) {
    ok('是单层 <urlset>（不是百度拒收的索引型）');
  } else {
    bad('根元素既不是 <urlset> 也不是 <sitemapindex> —— 不像是 sitemap');
  }

  const locs = [...sitemapText.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  if (!locs.length) bad('里面一条 <loc> 都没有');
  else ok(`含 ${locs.length} 条 URL（上限 ${MAX_URLS}）`);
  if (locs.length > MAX_URLS) bad(`URL 数 ${locs.length} 超过单文件上限 ${MAX_URLS}，需要拆成索引型 + 多个文件`);

  if (bytes > MAX_BYTES) bad(`文件 ${(bytes / 1048576).toFixed(1)} MB 超过 10MB 上限`);
  else ok(`文件 ${(bytes / 1024).toFixed(1)} KB（上限 10MB）`);

  const foreign = locs.filter(u => { try { return new URL(u).host !== HOST; } catch (e) { return true; } });
  if (foreign.length) bad(`有 ${foreign.length} 条 URL 不属于本站域名（例如 ${foreign[0]}）`);
  else ok(`全部 URL 同域（${HOST}）`);
} catch (e) {
  bad(`抓取失败：${e.message}（站点没部署？或本机网络被拦？）`);
}

/* ---------- 2. robots.txt ---------- */
console.log('\n──── 2. robots.txt（决定百度能不能自动发现）────');
try {
  const res = await fetch(`${BASE}/robots.txt`, { redirect: 'follow', headers: { 'User-Agent': 'xihaoz-sitemap-check' }, signal: AbortSignal.timeout(20000) });
  const txt = await res.text();
  res.ok ? ok(`可访问（HTTP ${res.status}）`) : warn(`HTTP ${res.status}`);

  const smLine = txt.match(/^\s*Sitemap:\s*(\S+)/im);
  if (smLine && smLine[1].replace(/\/+$/, '') === SITEMAP_URL.replace(/\/+$/, '')) {
    ok(`已声明 Sitemap: ${smLine[1]} —— 百度会自己来抓，不必依赖手动提交`);
  } else if (smLine) {
    warn(`声明的 sitemap 与本工具不一致：${smLine[1]}（若那是你要提交的就忽略）`);
  } else {
    bad('robots.txt 里没有 Sitemap: 行 —— 百度不会自动发现，务必补上或手动提交');
  }

  const blocksAll = /User-agent:\s*\*[\s\S]*?Disallow:\s*\/\s*(\r?\n|$)/i.test(txt);
  if (blocksAll) bad('robots.txt 里有 Disallow: / —— 等于禁止抓取全站，sitemap 提交也没用');
  else ok('没有 Disallow: / 全站封禁');
} catch (e) {
  bad(`抓取失败：${e.message}`);
}

/* ---------- 3. 对真有接口的引擎提交 ---------- */
if (!has('no-ping')) {
  console.log('\n──── 3. 有公开接口的引擎（Bing ping）────');
  try {
    const u = `https://www.bing.com/ping?sitemap=${encodeURIComponent(SITEMAP_URL)}`;
    const res = await fetch(u, { headers: { 'User-Agent': 'xihaoz-sitemap-check' }, signal: AbortSignal.timeout(25000) });
    if (res.ok) ok(`Bing 已受理（HTTP ${res.status}）`);
    else warn(`Bing 返回 HTTP ${res.status}（该 ping 接口可能已停用，可改用 Bing 网站管理员工具手动提交）`);
  } catch (e) {
    warn(`Bing ping 失败：${e.message}`);
  }
  warn('Google 的 sitemap ping 接口已于 2023 年停用，只能在其 Search Console 里提交。');
}

/* ---------- 结论 ---------- */
console.log('\n──── 结论 ────');
if (fail) {
  console.log(`  ✗ 自检未通过 ${fail} 项 —— 先修好再提交，否则提交了也不会被处理。`);
  process.exit(1);
}
console.log('  ✓ 自检全部通过：sitemap 形态、条数、体积、同域、robots 声明都没问题。');
console.log('    百度已能通过 robots.txt 自动发现它；若要立即提交，走界面（一次即可）：');
console.log('      百度搜索资源平台 → 资源提交 → 普通收录 → sitemap提交 → 添加 sitemap 地址');
console.log(`      填入：${SITEMAP_URL}`);
console.log('    sitemap 走的是**独立配额**（与 API 推送的 10 条/天互不占用），');
console.log('    界面里能直接看到天级提交配额与存量文件配额。');
