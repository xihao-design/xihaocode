#!/usr/bin/env node
/* ============================================================
   视觉核对截图
   ------------------------------------------------------------
   三个必须解决的现实问题，都在这里处理掉了：

   1) 锚点滚动不可靠：无头浏览器 + #fragment 的截图起点会飘。
      改成往页面里注入一段 CSS 把前面的区块藏起来，让目标区块顶到最上面。

   2) Chrome 有最小窗口宽度（约 500px），直接开 390px 的窗口会被裁掉右侧，
      看着像布局崩了，其实是截图的锅。改成用一个 390px 宽的 iframe 包一层 ——
      iframe 内部的视口就是 390px，媒体查询按真机宽度求值。

   3) 注入的复核页必须放在 dist 根目录（否则相对路径全断），用完删掉，
      不能把垃圾留在要部署的目录里。

   用法：
     node redesign/tools/shots.mjs                # 全部
     node redesign/tools/shots.mjs --only=phone   # 只跑名字含 phone 的
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, shoot, fileUrl, pngSize, cleanupProfile } from './chrome.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const OUTDIR = path.resolve(__dirname, '..', '_preview', 'v2');
const PHONE_W = 500;   // 外层窗口宽度：大于 Chrome 的最小窗口宽度，留出手机边框

/* 「云服务器推荐」现在排在 App 列表之后：原来的 HIDE_TOP 只隐藏英雄区/频道/筛选/列表，
   不隐藏它会顶到截图最上方，后面几组图（专题、Star、承诺）的取景就全偏了。 */
const HIDE_TOP = '.hero,#cats,#all,.grid-sec,#affiliate{display:none}';
const HIDE_TOP_STARS = '.hero,#cats,#all,.grid-sec,#affiliate,#stars{display:none}';
const HIDE_CHANNELS = '#cats{display:none}';
/* 只留「云服务器推荐」这一块：它换了位置，得单独出图验收（否则它永远躲在拼接截图的中段） */
const ONLY_AFFILIATE = '.hero,#cats,#official,#all,.grid-sec,#topics,#stars,#promises{display:none}';
/* 产品页只留「运营指南」模块：正文其它 .blk 全部隐藏，用 :not() 精确保留目标块 */
const ONLY_PRODUCT_GUIDES = '.page-hd,.meta,.notice,.crumb,.prose .blk:not(.blk--guides){display:none}';

const SHOTS = [
  { name: 'home-light-top', from: 'index.html', w: 1440, h: 1020 },
  { name: 'home-dark-top', from: 'index.html?theme=dark', w: 1440, h: 1020 },
  // 顶栏单独出图：窗口高度给足 —— Chrome 在 110px 高度的窗口里渲染会错位（出空白图），
  // 这是无头浏览器的怪癖，不是页面问题（900×300 就正常）
  { name: 'header-light', from: 'index.html', w: 900, h: 300 },
  { name: 'header-dark', from: 'index.html?theme=dark', w: 900, h: 300 },
  { name: 'home-light-grid', from: 'index.html', css: HIDE_CHANNELS, w: 1440, h: 1220 },
  { name: 'home-dark-grid', from: 'index.html?theme=dark', css: HIDE_CHANNELS, w: 1440, h: 1220 },
  { name: 'home-light-stars', from: 'index.html', css: HIDE_TOP, w: 1440, h: 1000 },
  { name: 'home-dark-stars', from: 'index.html?theme=dark', css: HIDE_TOP, w: 1440, h: 1000 },
  { name: 'home-light-promises', from: 'index.html', css: HIDE_TOP_STARS, w: 1440, h: 1080 },
  { name: 'home-dark-promises', from: 'index.html?theme=dark', css: HIDE_TOP_STARS, w: 1440, h: 1080 },
  { name: 'detail-light', from: 'apps/musicfree.html', w: 1440, h: 1180 },
  { name: 'detail-dark', from: 'apps/musicfree.html?theme=dark', w: 1440, h: 1180 },
  { name: 'category-dark', from: 'category/media.html?theme=dark', w: 1440, h: 1000 },
  // 首页导购位：挪到 App 列表下方之后，取景与前后间距都必须重新看一遍
  { name: 'home-light-affiliate', from: 'index.html', css: ONLY_AFFILIATE, w: 1440, h: 620 },
  { name: 'home-dark-affiliate', from: 'index.html?theme=dark', css: ONLY_AFFILIATE, w: 1440, h: 620 },
  { name: 'about-light', from: 'about.html', w: 1440, h: 1050 },
  { name: 'disclaimer-light', from: 'disclaimer.html', w: 1440, h: 1050 },
  { name: 'copyright-light', from: 'copyright.html', w: 1440, h: 1150 },
  { name: 'm404-light', from: '404.html', deprefix: true, w: 1440, h: 820 },

  { name: 'phone-light-top', from: 'index.html', phone: [390, 880] },
  { name: 'phone-dark-top', from: 'index.html?theme=dark', phone: [390, 880] },
  // 侧栏抽屉：桌面端看不到它，只在窄屏由按钮唤出 —— 所以要显式把开启态截出来，
  // 否则抽屉的排版（最长的那一组是「类目」13 项）永远没人验收
  { name: 'phone-light-drawer', from: 'index.html', drawer: true, phone: [390, 880] },
  { name: 'phone-dark-drawer', from: 'index.html?theme=dark', drawer: true, phone: [390, 880] },
  { name: 'phone-light-grid', from: 'index.html', css: HIDE_CHANNELS, phone: [390, 900] },
  { name: 'phone-dark-grid', from: 'index.html?theme=dark', css: HIDE_CHANNELS, phone: [390, 900] },
  { name: 'phone-light-detail', from: 'apps/musicfree.html', phone: [390, 1000] },
  { name: 'phone-dark-detail', from: 'apps/musicfree.html?theme=dark', phone: [390, 1000] },
];

const arg = process.argv.find(a => a.startsWith('--only='));
const only = arg ? arg.slice('--only='.length) : '';

/* 标签页与专题页是数据驱动的，从产物目录取实际存在的来出图 */
const firstOf = dir => {
  try {
    const f = fs.readdirSync(path.join(DIST, dir)).filter(x => x.endsWith('.html')).sort()[0];
    return f ? `${dir}/${f}` : null;
  } catch (e) { return null; }
};
for (const [dir, label] of [['tag', '标签页'], ['topic', '专题页']]) {
  const page = firstOf(dir);
  if (!page) continue;
  SHOTS.push(
    { name: `${dir}-light`, from: page, w: 1440, h: 1020 },
    { name: `${dir}-dark`, from: `${page}?theme=dark`, w: 1440, h: 1020 },
  );
}
SHOTS.push({ name: 'home-light-topics', from: 'index.html', css: HIDE_TOP, w: 1440, h: 1000 });

/* 技能页（数据驱动：有内容才出图） */
const skillFiles = (() => {
  try { return fs.readdirSync(path.join(DIST, 'skills')).filter(f => f.endsWith('.html')).sort(); }
  catch (e) { return []; }
})();
if (skillFiles.includes('index.html')) {
  SHOTS.push(
    { name: 'skills-index-light', from: 'skills/index.html', w: 1440, h: 1020 },
    { name: 'skills-index-dark', from: 'skills/index.html?theme=dark', w: 1440, h: 1020 },
  );
  const detail = skillFiles.find(f => f !== 'index.html');
  // 优先截「有网盘下载入口」的条目：那是技能页最完整的形态（含提取码与转存提示）
  let pick = detail;
  try {
    const cdir = path.resolve(__dirname, '..', 'content', 'skill');
    const withLink = fs.readdirSync(cdir).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(cdir, f), 'utf8')))
      .find(e => e.link && e.status === 'ok');
    if (withLink && skillFiles.includes(`${withLink.slug}.html`)) pick = `${withLink.slug}.html`;
  } catch (e) { /* 没有 content 层就当没这回事 */ }
  if (pick) {
    SHOTS.push(
      { name: 'skill-light', from: `skills/${pick}`, w: 1440, h: 1240 },
      { name: 'skill-dark', from: `skills/${pick}?theme=dark`, w: 1440, h: 1240 },
      { name: 'phone-skill', from: `skills/${pick}`, phone: [390, 1000] },
    );
  }
}

/* 电脑软件频道页（数据驱动：够门槛才有这一页，没产出就不出图） */
if (fs.existsSync(path.join(DIST, 'desktop', 'index.html'))) {
  SHOTS.push(
    { name: 'desktop-light', from: 'desktop/index.html', w: 1440, h: 1080 },
    { name: 'desktop-dark', from: 'desktop/index.html?theme=dark', w: 1440, h: 1080 },
    { name: 'phone-desktop', from: 'desktop/index.html', phone: [390, 1000] },
  );
}

/* 自营产品落地页（数据驱动：配了产品才有这一页）。
   运营指南模块从首页挪进这一页之后，这页同时承载「产品介绍」与「指南内容」两层 ——
   以前它没有出过图，等于改完没人验收；顺带把指南层的相对链接也放进图里看。 */
const productFiles = (() => {
  try { return fs.readdirSync(path.join(DIST, 'products')).filter(f => f.endsWith('.html')).sort(); }
  catch (e) { return []; }
})();
if (productFiles.length) {
  const p = `products/${productFiles[0]}`;
  SHOTS.push(
    { name: 'product-light', from: p, w: 1440, h: 1500 },
    { name: 'product-dark', from: `${p}?theme=dark`, w: 1440, h: 1500 },
    { name: 'product-light-guides', from: p, css: ONLY_PRODUCT_GUIDES, w: 1440, h: 720 },
    { name: 'product-dark-guides', from: `${p}?theme=dark`, css: ONLY_PRODUCT_GUIDES, w: 1440, h: 720 },
    { name: 'phone-product-guides', from: p, css: ONLY_PRODUCT_GUIDES, phone: [390, 900] },
  );
}

/* AI 库（数据驱动：够门槛才有目录页，分类页与详情页按实际产物取） */
if (fs.existsSync(path.join(DIST, 'ai', 'index.html'))) {
  SHOTS.push(
    { name: 'ai-index-light', from: 'ai/index.html', w: 1440, h: 1200 },
    { name: 'ai-index-dark', from: 'ai/index.html?theme=dark', w: 1440, h: 1200 },
    { name: 'phone-ai-index', from: 'ai/index.html', phone: [390, 1000] },
  );
  // 详情页优先挑「需代理 + 开源」的那条：一页里同时出现两类提示，
  // 是信息密度最高、最容易出排版问题的形态
  const aiFiles = (() => {
    try { return fs.readdirSync(path.join(DIST, 'ai')).filter(f => f.endsWith('.html') && f !== 'index.html').sort(); }
    catch (e) { return []; }
  })();
  let pick = aiFiles[0];
  try {
    const root = path.resolve(__dirname, '..', 'content', 'tool');
    const all = fs.readdirSync(root).flatMap(d => {
      try { return fs.readdirSync(path.join(root, d)).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(root, d, f), 'utf8'))); }
      catch (e) { return []; }
    });
    const rich = all.find(e => e.needsVpn && e.opensource && aiFiles.includes(`${e.slug}.html`));
    if (rich) pick = `${rich.slug}.html`;
  } catch (e) { /* 拿不到就用排序第一条 */ }
  if (pick) {
    SHOTS.push(
      { name: 'ai-detail-light', from: `ai/${pick}`, w: 1440, h: 1320 },
      { name: 'ai-detail-dark', from: `ai/${pick}?theme=dark`, w: 1440, h: 1320 },
      { name: 'phone-ai-detail', from: `ai/${pick}`, phone: [390, 1100] },
    );
  }
  const aiCat = (() => {
    try { return fs.readdirSync(path.join(DIST, 'ai', 'category')).filter(f => f.endsWith('.html')).sort()[0]; }
    catch (e) { return null; }
  })();
  if (aiCat) {
    SHOTS.push(
      { name: 'ai-category-light', from: `ai/category/${aiCat}`, w: 1440, h: 1080 },
      { name: 'ai-category-dark', from: `ai/category/${aiCat}?theme=dark`, w: 1440, h: 1080 },
    );
    // 子类页是两级导航的第二层，只有够门槛才有 —— 用产物目录判断，不写死
    const sub = (() => {
      try {
        const dir = path.join(DIST, 'ai', 'category', aiCat.replace(/\.html$/, ''));
        if (!fs.statSync(dir).isDirectory()) return null;
        const f = fs.readdirSync(dir).filter(x => x.endsWith('.html')).sort()[0];
        return f ? `ai/category/${aiCat.replace(/\.html$/, '')}/${f}` : null;
      } catch (e) { return null; }
    })();
    if (sub) {
      SHOTS.push(
        { name: 'ai-subcat-light', from: sub, w: 1440, h: 1080 },
        { name: 'ai-subcat-dark', from: `${sub}?theme=dark`, w: 1440, h: 1080 },
        { name: 'phone-ai-subcat', from: sub, phone: [390, 1000] },
      );
    }
  }
}

const list = only ? SHOTS.filter(s => s.name.includes(only)) : SHOTS;
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/index.html 不存在，先跑 npm run build。');
  process.exit(1);
}
const browser = findBrowser();
if (!browser) {
  console.error('找不到 Chrome 或 Edge。可设置环境变量 CHROME_PATH。');
  process.exit(1);
}

const cut = u => { const i = u.search(/[?#]/); return i === -1 ? { file: u, suffix: '' } : { file: u.slice(0, i), suffix: u.slice(i) }; };
const reviewFiles = [];

/** 造一个复核页：注入 CSS（改样式）、套 iframe（改视口宽度）、还原根路径（file:// 专用）
    注意顺序 —— 先把 CSS 注进去得到一份中间页，iframe 必须指向那份中间页，
    指向原始文件的话注入的样式就丢了（踩过：手机截图里区块根本没被隐藏）。 */
function makeReview(s) {
  const { file: src, suffix } = cut(s.from);
  if (!s.css && !s.phone && !s.deprefix && !s.drawer) return null;

  const abs = path.join(DIST, src);
  if (!fs.existsSync(abs)) return null;

  let target = src;

  if (s.css || s.deprefix || s.drawer) {
    let html = fs.readFileSync(abs, 'utf8');
    if (s.css) html = html.replace('</head>', `<style>${s.css}</style></head>`);
    // 抽屉的开启态由 app.js 在点击时才写进 DOM，截图时没有人去点它，
    // 所以直接把属性预设好 —— 复核的是抽屉的排版，不是按钮的事件绑定。
    if (s.drawer) {
      html = html.replace('<html ', '<html data-side="open" ');
      html = html.replace('</body>', `<script>
        document.documentElement.setAttribute('data-side','open');
        document.getElementById('sideScrim').removeAttribute('hidden');
        document.getElementById('sideScrim').setAttribute('data-open','');
      </script></body>`);
    }
    // 404 页故意用根绝对路径（它可能被任意层级的 URL 命中），线上是对的；
    // 但在 file:// 下 /assets/... 会指向盘符根，样式全丢，看着像布局崩了。
    // 复核时把根路径还原成相对路径，才看得到真实排版。
    if (s.deprefix) html = html.replace(/(href|src)="\//g, '$1="');
    /* 复核页必须与原页**同目录**：产物里的链接是相对路径（产品页写的是 ../assets/styles.css），
       放到 dist 根目录就全部 404 —— 页面看着像「样式丢了」，其实是复核页站错了位置。
       踩过：products/haofox.html 的「只看运营指南」截图，整页变成未样式化的巨大黑块。
       （UPGRADE-PLAN.md 里记过同一条教训：「测量工具的 bug 会伪装成产品的 bug」——
       这次是它第二次出现，所以修在工具里，而不是每次截图时绕开。）
       根目录页面 path.dirname 得到 '.'，落点与以前完全一致（不是行为变更）。 */
    const mid = path.join(path.dirname(src), `__review-css-${s.name}.html`);
    fs.writeFileSync(path.join(DIST, mid), html);
    reviewFiles.push(path.join(DIST, mid));
    // iframe 复核页固定在 dist 根目录，所以 src 要写成「相对 dist 根」的路径（Windows 用 /）
    target = mid.split(path.sep).join('/');
  }

  if (s.phone) {
    const out = path.join(DIST, `__review-${s.name}.html`);
    reviewFiles.push(out);
    fs.writeFileSync(out, `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      html,body{margin:0;height:100%;background:#22252b}
      body{display:flex;justify-content:center;align-items:flex-start}
      iframe{width:${s.phone[0]}px;height:${s.phone[1]}px;border:0;display:block;background:#fff}
    </style></head><body><iframe src="${target}${suffix}"></iframe></body></html>`);
    return out;
  }
  return path.join(DIST, target);
}

console.log(`浏览器：${browser}`);
console.log(`输出目录：${path.relative(process.cwd(), OUTDIR)}\n`);

let fail = 0;
const retried = [];
for (const s of list) {
  const { file: src, suffix } = cut(s.from);
  if (!fs.existsSync(path.join(DIST, src))) { console.log(`  SKIP ${s.name}（${src} 不存在）`); fail++; continue; }

  const review = makeReview(s);
  const url = review ? fileUrl(review) + suffix : fileUrl(path.join(DIST, src)) + suffix;
  const w = s.phone ? PHONE_W : s.w;
  const h = s.phone ? s.phone[1] : s.h;
  const out = path.join(OUTDIR, `${s.name}.png`);

  // 连拍几十张时，偶尔会有一张没落盘：无头 Chrome 退出时清理临时 profile 有延迟，
  // 下一张启动时撞上就会直接失败（实测：同一张图孤立跑必过、连跑必挂一张，且每次挂的不是同一张）。
  // 所以失败重试一次 —— 目标是把「偶发」和「真的坏了」分开：
  // 页面真坏了重试仍然失败，只有偶发才会被重试救回来。
  let ok = shoot(browser, url, out, { w, h, scale: s.scale || 1, wait: s.wait || 0 });
  if (!ok) {
    cleanupProfile();
    await new Promise(r => setTimeout(r, 700));
    ok = shoot(browser, url, out, { w, h, scale: s.scale || 1, wait: s.wait || 0 });
    if (ok) retried.push(s.name);
  }
  const size = ok ? pngSize(out) : null;
  if (!size) { console.log(`  FAIL ${s.name}（重试后仍失败）`); fail++; continue; }
  console.log(`  ok   ${s.name.padEnd(22)} ${size.w}×${size.h}  ${(size.bytes / 1024).toFixed(0)} KB`);
}
if (retried.length) console.log(`\n重试后成功 ${retried.length} 张（偶发，非页面问题）：${retried.join(', ')}`);

// 复核页绝不留在要部署的目录里。
for (const f of reviewFiles) { try { fs.rmSync(f, { force: true }); } catch (e) { /* 忽略 */ } }
// 复核页现在会落在**源页所在目录**（子目录页面也要能保住相对路径），所以扫描必须下探，
// 只看 dist 根会漏掉 products/、apps/ 里残留的复核页 —— 那是会被一起部署出去的东西。
const leftover = (function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'assets' ? [] : walk(p);
    return e.name.startsWith('__review-') ? [path.relative(DIST, p)] : [];
  });
})(DIST);
if (leftover.length) console.log(`\n注意：dist 里还有残留复核页 ${leftover.join(', ')}`);

cleanupProfile();
console.log(fail ? `\n${fail} 张失败` : `\n全部完成，共 ${list.length} 张`);
process.exit(fail ? 1 : 0);
