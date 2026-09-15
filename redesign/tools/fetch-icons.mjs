#!/usr/bin/env node
/* ============================================================
   图标抓取器
   ------------------------------------------------------------
   读取 data/github.json 中核实到的 iconUrl / iconFallbackUrl，
   下载到 assets/icons/<slug>.png。

   为什么落地到本地而不热链：
   - GitHub / F-Droid 在国内访问不稳定，热链会让站点在国内几乎不可用
   - 图标是极小文件，一次性抓取后随站点一起分发最稳

   注意：图标版权归各自项目所有，此处仅用于信息索引展示。
   用法：node tools/fetch-icons.mjs [--force]
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'assets', 'icons');
const FORCE = process.argv.includes('--force');

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, '..', '.kb-raw.json'), 'utf8'));
const curation = JSON.parse(fs.readFileSync(path.join(ROOT, 'curation.json'), 'utf8'));
const gh = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'github.json'), 'utf8'));

fs.mkdirSync(ICON_DIR, { recursive: true });

const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const slugOf = (meta, name) => meta.slug || (/^[\x20-\x7e]+$/.test(name) ? slugify(name) : null);

/** 从魔数判断真实图片类型，避免把 HTML 错误页当成图标存下来 */
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.slice(0, 5).toString('ascii').toLowerCase().startsWith('<svg') ||
      buf.slice(0, 200).toString('utf8').includes('<svg')) return 'svg';
  return null;
}

const results = { ok: [], fail: [], skip: [] };

for (const r of raw) {
  const meta = curation.apps[String(r.row)];
  if (!meta) continue;
  const slug = slugOf(meta, meta.name);
  if (!slug) continue;

  const existing = ['.png', '.svg', '.webp', '.jpg']
    .map(e => path.join(ICON_DIR, slug + e)).find(p => fs.existsSync(p));
  if (existing && !FORCE) { results.skip.push(`${meta.name} (已存在)`); continue; }

  const info = gh[String(r.row)] || {};
  const rawCandidates = [info.iconUrl, info.iconFallbackUrl].filter(u => u && /^https?:\/\//.test(u));

  // raw.githubusercontent.com 在国内常被限流/污染，自动补一条 jsDelivr CDN 镜像作为兜底
  const mirror = u => {
    const m = u.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    return m ? `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}` : null;
  };
  const candidates = [];
  for (const u of rawCandidates) {
    candidates.push(u);
    const alt = mirror(u);
    if (alt) candidates.push(alt);
  }
  if (!candidates.length) { results.fail.push(`${meta.name} (无图标直链)`); continue; }

  let saved = false;
  for (const url of candidates) {
    // raw.githubusercontent.com 连续请求容易被限流，每个候选重试两次并留间隔
    for (let attempt = 0; attempt < 2 && !saved; attempt++) {
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; XihaoUC-icon-fetcher)' },
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) { await sleep(800); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        const kind = sniff(buf);
        if (!kind) { await sleep(800); continue; }
        const out = path.join(ICON_DIR, `${slug}.${kind}`);
        fs.writeFileSync(out, buf);
        results.ok.push(`${meta.name} → ${slug}.${kind} (${(buf.length / 1024).toFixed(1)} KB, ${new URL(url).host})`);
        saved = true;
      } catch (e) { await sleep(1200); }
    }
    if (saved) break;
  }
  if (!saved) results.fail.push(`${meta.name} (候选下载失败)`);
  await sleep(350);
}

console.log(`图标抓取完成：成功 ${results.ok.length} / 跳过 ${results.skip.length} / 失败 ${results.fail.length}`);
for (const s of results.ok) console.log('  ✓ ' + s);
if (results.skip.length) console.log(`  · 已存在 ${results.skip.length} 个（--force 可覆盖）`);
if (results.fail.length) {
  console.log('  ✗ 未取到图标：');
  for (const f of results.fail) console.log('    - ' + f);
}
