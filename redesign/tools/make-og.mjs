#!/usr/bin/env node
/* ============================================================
   生成社交分享图 assets/og.png
   ------------------------------------------------------------
   读 src/og.html（1200×630 的模板），用系统里的 Chrome / Edge 无头渲染。
   改完模板运行：npm run og
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, shoot, fileUrl, pngSize, cleanupProfile } from './chrome.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'src', 'og.html');
const OUT = path.resolve(__dirname, '..', 'assets', 'og.png');
const W = 1200, H = 630;

const browser = findBrowser();
if (!browser) {
  console.error('找不到 Chrome 或 Edge，无法渲染 OG 图。');
  console.error('可设置环境变量 CHROME_PATH 指向浏览器可执行文件。');
  process.exit(1);
}
if (!fs.existsSync(SRC)) {
  console.error(`模板不存在：${SRC}`);
  process.exit(1);
}

console.log(`渲染 OG 图：${path.relative(process.cwd(), SRC)} → ${path.relative(process.cwd(), OUT)}`);
const ok = shoot(browser, fileUrl(SRC), OUT, { w: W, h: H });
const size = ok ? pngSize(OUT) : null;

if (!size) {
  console.error('渲染失败：没有产出图片。');
  process.exit(1);
}
if (size.w !== W || size.h !== H) {
  console.error(`尺寸不对：期望 ${W}×${H}，实际 ${size.w}×${size.h}。`);
  console.error('社交平台对 OG 图尺寸敏感，请检查 og.html 的 body 宽高。');
  process.exit(1);
}
cleanupProfile();
console.log(`完成：${size.w}×${size.h} · ${(size.bytes / 1024).toFixed(1)} KB`);
