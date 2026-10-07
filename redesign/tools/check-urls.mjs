#!/usr/bin/env node
/* ============================================================
   URL 稳定性守卫
   ------------------------------------------------------------
   这条约束是硬的：升级可以改样式、改结构、加页面，但**已上线的 URL 一条都不能丢**——
   百度收录过的地址一旦 404，收录和权重就一起没了。

   做法：抓线上 sitemap 当基准，与本地 dist/sitemap.xml 对比。
   线上有、本地没有 = 回归（退出码 1）；本地多出来的是新增页面（正常）。
   部署前跑一次，比部署完发现掉页强。

   用法：npm run urls
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const BASE = (process.argv.find(a => a.startsWith('--base=')) || '').slice(7) || 'https://www.xihaouc.top';

const localSm = path.join(DIST, 'sitemap.xml');
if (!fs.existsSync(localSm)) {
  console.error('dist/sitemap.xml 不存在，先跑 npm run build。');
  process.exit(1);
}

const locsOf = xml => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
const norm = u => u.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, '') || '/';

const local = new Set(locsOf(fs.readFileSync(localSm, 'utf8')).map(norm));

console.log(`基准：${BASE}/sitemap.xml`);
let live;
try {
  const res = await fetch(`${BASE}/sitemap.xml`, {
    headers: { 'User-Agent': 'xihaoz-url-guard' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  live = locsOf(await res.text()).map(norm);
} catch (e) {
  console.warn(`抓不到线上 sitemap（${e.message}）—— 无法比对。`);
  console.warn('这不代表 URL 有问题，只是这次没联网；联网后重跑 npm run urls。');
  process.exit(2);
}

const missing = live.filter(u => !local.has(u));
const added = [...local].filter(u => !live.includes(u));

console.log(`  线上 ${live.length} 条 · 本地 ${local.size} 条`);
if (added.length) {
  const preview = added.slice(0, 12).join('\n    ');
  console.log(`  新增 ${added.length} 条（正常）：\n    ${preview}${added.length > 12 ? `\n    …还有 ${added.length - 12} 条` : ''}`);
}

if (missing.length) {
  console.log(`\n  回归 ${missing.length} 条 —— 线上有、本地没有，部署后会 404：`);
  for (const u of missing) console.log(`    ✗ ${u}`);
  console.log('\n  这就是「URL 不能丢」这条约束被破坏了。检查 build.mjs 的 slug 生成与排除逻辑。');
  process.exit(1);
}

console.log('\nURL 稳定性通过：线上已有的地址本地全部保留。');
