/* ============================================================
   产物校验：提交前必跑
   ------------------------------------------------------------
   校验的是「产物事实」，不是「我以为写了什么」：
   - 死链、图标存在性、h1 数量、占位符残留
   - 每页必须有 title/description/canonical/lang/ICP/AdSense
   - 双主题引导脚本必须在（否则首屏会闪白）
   - 旧品牌名不允许残留（改名最容易漏在某个角落）
   - sitemap 覆盖全部页面，且首页能到达每个详情页
   ============================================================ */
const fs = require('fs');
const path = require('path');

const DIST = 'D:/vitepress/redesign/dist';
const ICON_DIR = 'D:/vitepress/redesign/assets/icons';
const SITE = 'https://www.xihaouc.top';
const OLD_BRAND = 'XihaoUC';           // 改名前的品牌，产物里一次都不该出现
const STATIC_PAGES = ['about', 'disclaimer', 'copyright'];
const MIN_THEME_BOOT = /dataset\.themeSource/;

let fail = 0, warn = 0, checked = 0;

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : [p];
});

const htmls = walk(DIST).filter(f => f.endsWith('.html'));
const bad = (rel, msg) => { console.log(`  FAIL ${rel} ${msg}`); fail++; };

for (const f of htmls) {
  const html = fs.readFileSync(f, 'utf8');
  const rel = path.relative(DIST, f);

  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const r = m[1];
    if (/^(https?:|mailto:|#|data:)/.test(r)) continue;
    checked++;
    const clean = r.split('#')[0].split('?')[0];
    if (!clean) continue;
    const target = clean.startsWith('/') ? path.join(DIST, clean) : path.resolve(path.dirname(f), clean);
    if (!fs.existsSync(target)) bad(rel, `-> ${r}`);
  }

  const need = [
    ['title', /<title>[^<]+<\/title>/],
    ['meta description', /name="description" content="[^"]+"/],
    ['canonical', new RegExp(`rel="canonical" href="${SITE.replace(/\./g, '\\.')}`)],
    ['lang', /<html lang="zh-CN"/],
    ['styles.css', /assets\/styles\.css\?v=[0-9a-f]{8}/],
    ['app.js', /assets\/app\.js\?v=[0-9a-f]{8}/],
    ['ICP', /ICP备2025193604号/],
    ['adsense', /pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js\?client=ca-pub-7382599676480629/],
    ['主题引导脚本', MIN_THEME_BOOT],
    ['theme-color', /name="theme-color" content="#[0-9A-Fa-f]{6}"/],
    ['color-scheme', /name="color-scheme" content="light dark"/],
    ['主题切换按钮', /id="themeBtn"/],
    ['跳转主内容', /class="skip" href="#main"/],
  ];
  for (const [label, re] of need) {
    if (!re.test(html)) bad(rel, `missing ${label}`);
  }

  // 旧品牌名残留：最容易漏在 meta / og / 页脚角落
  if (html.includes(OLD_BRAND)) bad(rel, `残留旧品牌名 ${OLD_BRAND}`);

  const h1 = (html.match(/<h1[^>]*>/g) || []).length;
  if (h1 !== 1) bad(rel, `h1 count=${h1}`);
  if (html.includes('__R__')) bad(rel, 'unreplaced __R__');
  if (html.includes('undefined')) { console.log(`  WARN ${rel} contains undefined`); warn++; }

  for (const m of html.matchAll(/assets\/icons\/([^"]+)/g)) {
    if (!fs.existsSync(path.join(ICON_DIR, m[1]))) bad(rel, `icon missing: ${m[1]}`);
  }
}

/* ---------- 首页可达性：61 个详情页一个都不能漏 ---------- */
const home = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const appLinks = new Set([...home.matchAll(/href="apps\/([^"]+)\.html"/g)].map(m => m[1]));
const appFiles = new Set(fs.readdirSync(path.join(DIST, 'apps')).map(f => f.replace('.html', '')));

const unreachable = [...appFiles].filter(s => !appLinks.has(s));
if (unreachable.length) bad('index.html', `unreachable from home: ${unreachable.join(',')}`);

for (const s of ['auto-jingling', 'legado', 'loop', 'cuppa']) {
  if (appFiles.has(s)) bad('dist/apps', `excluded item present: ${s}`);
  if (home.includes(`apps/${s}.html`)) bad('index.html', `links excluded: ${s}`);
}

/* ---------- 合规页必须能从首页页脚走到 ---------- */
for (const p of STATIC_PAGES) {
  if (!fs.existsSync(path.join(DIST, `${p}.html`))) bad('dist', `缺少页面 ${p}.html`);
  if (p !== 'about' && !home.includes(`${p}.html`)) bad('index.html', `页脚没有链接到 ${p}.html`);
}

/* ---------- 站长平台验证码：配置里写了，产物里就必须有 ----------
   这东西丢了没有任何可见症状，只会在平台后台悄悄变成「验证失败」，
   所以值得被断言盯着。 */
const VERIF_META = {
  baidu: 'baidu-site-verification',
  sogou: 'sogou_site_verification',
  360: '360-site-verification',
};
let verifCfg = {};
try {
  verifCfg = JSON.parse(fs.readFileSync('D:/vitepress/redesign/site.config.json', 'utf8')).verification || {};
} catch (e) {
  console.log(`  WARN 读不到 site.config.json（${e.message}）`); warn++;
}
for (const [key, val] of Object.entries(verifCfg)) {
  const name = VERIF_META[key];
  if (!name) { console.log(`  WARN site.config.json 里有未识别的验证平台: ${key}`); warn++; continue; }
  if (!home.includes(`name="${name}" content="${val}"`)) bad('index.html', `缺少站长验证 meta: ${name}`);
}

/* ---------- 主题相关的样式必须在产物里 ---------- */
const css = fs.readFileSync(path.join(DIST, 'assets', 'styles.css'), 'utf8');
for (const [label, re] of [
  ['深色主题变量', /\[data-theme="dark"\]\s*\{/],
  ['毛玻璃', /backdrop-filter/],
  ['毛玻璃降级', /prefers-reduced-transparency/],
  ['动效偏好', /prefers-reduced-motion/],
  ['分类色调', /--tone-clay/],
]) {
  if (!re.test(css)) bad('assets/styles.css', `missing ${label}`);
}

/* ---------- 脚本产物的等式：线上脚本（逐字节） + 已登记增量 ----------
   样式那边靠「live/styles.css 逐字节不动」就能比对；脚本的增量是**修改**线上已有的函数，
   没法追加，只能登记式替换（redesign/live/app-delta.js）。
   于是这里断言那条等式本身：产物 assets/app.js 必须**逐字节等于**「线上 app.js + 已登记增量」。
   少了它，直接改产物、或取回一份新的线上脚本而增量没跟着改，都会静默上线。 ---------- */
const appDelta = require(path.join(__dirname, '..', 'live', 'app-delta.js'));
const onlineAppPath = path.join(__dirname, '..', 'live', 'app.js');
let expectedApp = null;
try {
  expectedApp = appDelta.applyAppDelta(fs.readFileSync(onlineAppPath, 'utf8'));
} catch (e) {
  bad('live/app.js', `登记式增量应用失败：${e.message.split('\n')[0]}`);
}
if (expectedApp !== null) {
  const shippedApp = fs.readFileSync(path.join(DIST, 'assets', 'app.js'), 'utf8');
  if (shippedApp !== expectedApp) {
    bad('assets/app.js', '不等于「线上 app.js + 已登记增量」（直接改了产物，或改完没重新构建）');
  }
  if (!shippedApp.includes(appDelta.SENTINEL)) {
    bad('assets/app.js', '增量哨兵不在产物里（平台筛选的多值匹配缺失）');
  }
}

/* ---------- sitemap：不硬编码页面数，改成「产物与 sitemap 必须互相覆盖」
   硬编码 1+3+6+N 这种式子每加一类页面就得改一次，而且改错了也看不出来；
   双向覆盖检查则对新增页面类型天然成立，还会在页面数暴跌时报警。 ---------- */
const sm = fs.readFileSync(path.join(DIST, 'sitemap.xml'), 'utf8');
const smLocs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);

const dupes = [...new Set(smLocs.filter((l, i) => smLocs.indexOf(l) !== i))];
if (dupes.length) bad('sitemap.xml', `重复 URL: ${dupes.join(', ')}`);

/** sitemap URL → dist 相对路径。三种写法都要认：
    `/` → index.html · `/skills/` → skills/index.html · `/apps/x` → apps/x.html */
const toRel = loc => {
  const pathname = loc.replace(/^https?:\/\/[^/]+/, '');
  let rel = pathname.replace(/^\/+/, '');
  if (rel === '') return 'index.html';
  if (rel.endsWith('/')) return rel + 'index.html';
  if (rel.endsWith('.html')) return rel;
  return rel + '.html';
};

for (const l of smLocs) {
  if (!fs.existsSync(path.join(DIST, toRel(l)))) bad('sitemap.xml', `指向不存在的页面: ${l}`);
}

const IGNORE = new Set(['404.html']);
const htmlRel = htmls
  .map(f => path.relative(DIST, f).replace(/\\/g, '/'))
  .filter(r => !IGNORE.has(r) && !r.startsWith('__review') && !r.startsWith('go/'));
const locRel = new Set(smLocs.map(toRel));
for (const rel of htmlRel) {
  if (!locRel.has(rel)) bad(rel, '没有被写进 sitemap');
}

for (const s of appFiles) {
  if (!smLocs.some(l => l.endsWith('/apps/' + s))) bad('sitemap.xml', `missing app: ${s}`);
}

// 双向覆盖已经保证了产物与 sitemap 数量一致，这里只兜底「页面数暴跌 = 构建坏了」，不是「精简了」
if (smLocs.length < 60) bad('sitemap.xml', `URL 只有 ${smLocs.length} 条，疑似构建异常`);

if (!fs.readFileSync(path.join(DIST, 'robots.txt'), 'utf8').includes('Sitemap:')) bad('robots.txt', '缺少 Sitemap 行');

const countIn = d => {
  try { return fs.readdirSync(path.join(DIST, d)).filter(f => f.endsWith('.html')).length; }
  catch (e) { return 0; }
};
console.log(`\nchecked ${htmls.length} html / ${checked} internal refs / ${appFiles.size} detail pages`);
console.log(`  详情 ${appFiles.size} · 分类 ${countIn('category')} · 标签 ${countIn('tag')} · 专题 ${countIn('topic')} · sitemap ${smLocs.length} 条`);
console.log(fail ? `FAILED: ${fail}` : 'ALL PASS');
if (warn) console.log(`  (${warn} warnings)`);
process.exit(fail ? 1 : 0);
