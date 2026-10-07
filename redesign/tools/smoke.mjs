#!/usr/bin/env node
/* ============================================================
   运行时冒烟测试
   ------------------------------------------------------------
   为什么需要它：check-dist.js 只看得见静态 HTML，看不见「脚本跑完之后」的状态。
   而主题这块最危险的 bug 恰好只存在于运行时 —— 曾经出过一次：
   app.js 把 null 写进 <html data-theme>，结果深色主题整块 CSS 匹配不上、
   主题按钮的三个图标全被 display:none 掉。静态检查全绿，页面却是坏的。

   这个脚本用真实浏览器加载页面、执行脚本，然后把渲染后的 DOM 抓回来看。
   用法：npm run smoke
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, fileUrl, dumpDom, cleanupProfile } from './chrome.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const CASES = [
  { url: 'index.html', theme: 'light', source: 'auto', note: '首次访问：跟随系统（无头浏览器默认浅色）' },
  { url: 'index.html?theme=dark', theme: 'dark', source: 'dark', note: '深色预览覆盖' },
  { url: 'index.html?theme=light', theme: 'light', source: 'light', note: '浅色预览覆盖' },
  { url: 'index.html?theme=auto', theme: 'light', source: 'auto', note: 'auto 预览覆盖' },
  { url: 'apps/musicfree.html?theme=dark', theme: 'dark', source: 'dark', note: '详情页深色' },
  { url: 'category/media.html', theme: 'light', source: 'auto', note: '分类页默认' },
  { url: 'about.html', theme: 'light', source: 'auto', note: '关于页默认' },
  { url: 'disclaimer.html', theme: 'light', source: 'auto', note: '免责页默认' },
  { url: 'copyright.html', theme: 'light', source: 'auto', note: '版权页默认' },
];

/* 标签页与专题页是数据驱动的，页面数量会变，所以从产物目录里取实际存在的来测 */
const firstOf = dir => {
  try {
    const f = fs.readdirSync(path.join(DIST, dir)).filter(x => x.endsWith('.html')).sort()[0];
    return f ? `${dir}/${f}` : null;
  } catch (e) { return null; }
};
for (const [dir, label] of [['tag', '标签页'], ['topic', '专题页']]) {
  const page = firstOf(dir);
  if (!page) { console.log(`  提示 dist/${dir}/ 里还没有页面，跳过${label}用例`); continue; }
  CASES.push(
    { url: page, theme: 'light', source: 'auto', note: `${label}默认` },
    { url: `${page}?theme=dark`, theme: 'dark', source: 'dark', note: `${label}深色` },
  );
}

/* 技能页：技能库首页 + 一条详情（列表页与详情页的模板不同，两个都要测） */
const skillFiles = (() => {
  try { return fs.readdirSync(path.join(DIST, 'skills')).filter(f => f.endsWith('.html')).sort(); }
  catch (e) { return []; }
})();
if (skillFiles.length) {
  CASES.push(
    { url: 'skills/index.html', theme: 'light', source: 'auto', note: '技能库首页' },
    { url: 'skills/index.html?theme=dark', theme: 'dark', source: 'dark', note: '技能库首页深色' },
  );
  const detail = skillFiles.find(f => f !== 'index.html');
  if (detail) {
    CASES.push(
      { url: `skills/${detail}`, theme: 'light', source: 'auto', note: '技能详情页' },
      { url: `skills/${detail}?theme=dark`, theme: 'dark', source: 'dark', note: '技能详情页深色' },
    );
  }
}

/* 电脑软件频道页：够门槛才产出，没这一页就跳过（与 build.mjs 的门槛判定同一事实来源） */
if (fs.existsSync(path.join(DIST, 'desktop', 'index.html'))) {
  CASES.push(
    { url: 'desktop/index.html', theme: 'light', source: 'auto', note: '电脑软件频道页' },
    { url: 'desktop/index.html?theme=dark', theme: 'dark', source: 'dark', note: '电脑软件频道页深色' },
  );
}

const THEMES = ['light', 'dark'];
const SOURCES = ['auto', 'light', 'dark'];

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/index.html 不存在，先跑 npm run build。');
  process.exit(1);
}
const browser = findBrowser();
if (!browser) {
  console.error('找不到 Chrome 或 Edge。可设置环境变量 CHROME_PATH。');
  process.exit(1);
}

/** 加载页面并执行脚本，取回渲染后的 DOM */
const dom = url => dumpDom(browser, url);

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
};

let fail = 0;
console.log(`浏览器：${browser}\n`);

for (const c of CASES) {
  const file = path.join(DIST, c.url.split('?')[0]);
  const suffix = c.url.includes('?') ? c.url.slice(c.url.indexOf('?')) : '';
  // 查询串必须真的带上，否则 ?theme=dark 这些用例测的还是默认态
  const html = dom(fileUrl(file) + suffix);
  const shell = (html.match(/<html[^>]*>/) || [''])[0];

  const problems = [];
  if (!shell) problems.push('拿不到 <html>（页面没渲染出来？）');
  const gotTheme = attr(shell, 'data-theme');
  const gotSource = attr(shell, 'data-theme-source');
  const gotKey = attr(shell, 'data-theme-key');

  if (gotTheme !== c.theme) problems.push(`data-theme=${JSON.stringify(gotTheme)}，期望 ${c.theme}`);
  if (gotSource !== c.source) problems.push(`data-theme-source=${JSON.stringify(gotSource)}，期望 ${c.source}`);
  if (THEMES.indexOf(gotTheme) < 0) problems.push(`data-theme 不是合法值：${JSON.stringify(gotTheme)}`);
  if (SOURCES.indexOf(gotSource) < 0) problems.push(`data-theme-source 不是合法值：${JSON.stringify(gotSource)}`);
  if (!gotKey) problems.push('缺少 data-theme-key');
  // 主题按钮必须在，且三个图标都在 DOM 里（可见性由 CSS 按 source 决定）
  if (!html.includes('id="themeBtn"')) problems.push('缺少主题切换按钮');
  for (const ic of SOURCES) {
    if (!html.includes(`data-ic="${ic}"`)) problems.push(`缺少 ${ic} 图标`);
  }
  // 主题变量必须随 data-theme 切换，抽一句对得上的规则
  if (c.theme === 'dark' && !html.includes('data-theme="dark"')) problems.push('深色态下 html 上没有 data-theme="dark"');

  const label = `${c.url.padEnd(38)} theme=${gotTheme} source=${gotSource}`;
  if (problems.length) {
    console.log(`  FAIL ${label}`);
    for (const p of problems) console.log(`       - ${p}`);
    fail++;
  } else {
    console.log(`  ok   ${label}   ${c.note}`);
  }
}

// 深色主题的 CSS 规则必须真的在产物里，否则 data-theme="dark" 也白搭
const css = fs.readFileSync(path.join(DIST, 'assets', 'styles.css'), 'utf8');
if (!/\[data-theme="dark"\]/.test(css)) { console.log('  FAIL styles.css 里没有 [data-theme="dark"] 规则'); fail++; }

cleanupProfile();
console.log(fail ? `\n冒烟测试未通过：${fail} 项` : `\n冒烟测试全部通过（${CASES.length} 个页面）`);
process.exit(fail ? 1 : 0);
