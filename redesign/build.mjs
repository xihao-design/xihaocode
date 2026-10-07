#!/usr/bin/env node
/* ============================================================
   西浩资源库 静态站生成器
   ------------------------------------------------------------
   输入：../.kb-raw.json（从 xlsx 抽取的原始记录）
         ./site.config.json（品牌 / 域名 / 备案 / 导航 / 频道 / 主题色）
         ./curation.json（展示名 / 分类 / 一句话定位 / slug）
         ./data/github.json（联网核实到的仓库与图标信息，可选）
         ./src/styles/*.css（设计系统，按文件名顺序拼接）
         ./assets/icons/*（本地图标，可选）
   输出：./dist（可直接上传 EdgeOne Pages）

   设计原则：
   - 页面内容全部构建期直出，搜索引擎可抓取；客户端 JS 只做增强
   - 所有内部链接为相对路径，dist 目录可直接双击打开预览
   - 缺失数据不编造：没有图标就退回首字标记，没有仓库就不显示开源信息
   - 品牌与文案只在 site.config.json / curation.json 里改，不写死在代码里
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import appDelta from './live/app-delta.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(__dirname, 'dist');
const ICON_DIR = path.join(__dirname, 'assets', 'icons');

const warnings = [];
const excluded = [];
const readJSON = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
};

/* ---------- 0. 站点配置 ---------- */
const cfg = readJSON(path.join(__dirname, 'site.config.json'));
const SITE = {
  url: cfg.url.replace(/\/+$/, ''),
  host: cfg.host || cfg.url.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  name: cfg.name,
  short: cfg.shortName || cfg.name,
  tagline: cfg.tagline,
  suffix: cfg.titleSuffix || cfg.name,
  homeTitle: cfg.homeTitle || `${cfg.name} - ${cfg.tagline}`,
  slogan: cfg.slogan || '',
  beian: cfg.beian,
  since: cfg.since,
  until: cfg.until,
  email: (cfg.contact && cfg.contact.email) || '',
  nav: cfg.nav || [],
  channels: cfg.channels || [],
  promises: cfg.promises || [],
  verification: cfg.verification || {},
  theme: {
    key: (cfg.theme && cfg.theme.storageKey) || 'xihaoz.theme',
    light: (cfg.theme && cfg.theme.light && cfg.theme.light.themeColor) || '#FAF9F5',
    dark: (cfg.theme && cfg.theme.dark && cfg.theme.dark.themeColor) || '#0B0C10',
  },
};
if (!SITE.email) warnings.push('site.config.json 未填 contact.email：合规页会退化成「暂未开通公开邮箱」的表述');

// 自营产品：单独标注的站长自营推广位，与「开源收录」相互独立。
// 所有字段给空值兜底，保证删掉 product 配置块时既不产出页面、也不残留 undefined。
const PRODUCT = (cfg.product && cfg.product.name)
  ? {
      name: cfg.product.name,
      en: cfg.product.en || '',
      badge: cfg.product.badge || '官方出品 · 自营',
      slug: cfg.product.slug || 'haofox',
      url: cfg.product.url || '',
      tagline: cfg.product.tagline || '',
      cta: cfg.product.cta || '访问官网',
      download: (cfg.product.download && cfg.product.download.url)
        ? {
            label: cfg.product.download.label || '网盘下载',
            url: cfg.product.download.url,
            pwd: cfg.product.download.pwd || '',
            note: cfg.product.download.note || '',
          }
        : null,
      desc: cfg.product.desc || '',
      homeTitle: cfg.product.homeTitle || '',
      homeText: cfg.product.homeText || '',
      homeNote: cfg.product.homeNote || '',
      scenarios: Array.isArray(cfg.product.scenarios) ? cfg.product.scenarios : [],
      features: Array.isArray(cfg.product.features) ? cfg.product.features : [],
      why: Array.isArray(cfg.product.why) ? cfg.product.why : [],
      faq: Array.isArray(cfg.product.faq) ? cfg.product.faq : [],
    }
  : null;

// 联盟导购位（第三方推广，区别于自营产品）：programs 为数组，支持多联盟方。
// enabled=false、缺 id 或缺 url 的项不渲染 —— 保证删配置/未填链接时不产出死链。
const AFFILIATES = (cfg.affiliate && Array.isArray(cfg.affiliate.programs))
  ? cfg.affiliate.programs
      .filter(p => p && p.enabled && p.id && p.url)
      .map(p => ({
        id: p.id,
        provider: p.provider || '云服务',
        title: p.title || '',
        text: p.text || '',
        cta: p.cta || '查看优惠',
        url: p.url,
      }))
  : [];

// 点击埋点：百度统计站点 ID（全站加载 + 联盟点击事件上报），beaconUrl 为可选额外端点。
const ANALYTICS = {
  baiduTongjiId: (cfg.analytics && cfg.analytics.baiduTongjiId) || '',
  beaconUrl: (cfg.analytics && cfg.analytics.beaconUrl) || '',
};

// 百度统计脚本：仅当配置了站点 ID 才注入（留空则全站不加载）
const BAIDU_TJ = ANALYTICS.baiduTongjiId
  ? `<script>var _hmt=_hmt||[];(function(){var hm=document.createElement("script");hm.src="https://hm.baidu.com/hm.js?${ANALYTICS.baiduTongjiId}";var s=document.getElementsByTagName("script")[0];s.parentNode.insertBefore(hm,s);})();</script>`
  : '';

// Google AdSense：单点维护，新增页面（含每日自动发布的详情页）自动带上
const ADSENSE = (cfg.adsense && cfg.adsense.enabled)
  ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${cfg.adsense.client}" crossorigin="anonymous"></script>`
  : '';

/* 主题引导：必须在样式表之前执行，否则首屏会先画浅色再跳深色（闪白）。
   ?theme=dark|light|auto 是预览用的临时覆盖，不写入 localStorage —— 方便截图核对与分享。 */
const THEME_BOOT = `<script>(function(){var K=${JSON.stringify(SITE.theme.key)};var R=document.documentElement;` +
  `function sys(){return (window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light'}` +
  `var p='';try{p=(new URLSearchParams(location.search)).get('theme')||''}catch(e){}` +
  `if(['auto','light','dark'].indexOf(p)<0)p='';var s=p;` +
  `if(!s){try{s=localStorage.getItem(K)||'auto'}catch(e){s='auto'}}` +
  `if(['auto','light','dark'].indexOf(s)<0)s='auto';` +
  `R.dataset.themeKey=K;R.dataset.themeSource=s;R.dataset.theme=(s==='auto')?sys():s;` +
  `R.dataset.themeColorLight=${JSON.stringify(SITE.theme.light)};R.dataset.themeColorDark=${JSON.stringify(SITE.theme.dark)};` +
  `window.__THEME_PREVIEW__=!!p})();</script>`;

/* ---------- 1. 设计系统 ----------
   视觉以**线上版本**为准，不再从 src/styles 拼接。
   原因：这场对话里改过一轮 UI（左导航 → 顶栏巨型菜单、紫↔珊瑚双色），
   结果不理想，用户要求回到线上那版观感 —— 而线上那版的样式表就是
   `redesign/live/styles.css`（从线上直接取回的原产物，50578B）。
   把线上产物当唯一真源，而不是「照着记忆改回 token」：
   后者很容易漏掉一两处，改完看着像、细节对不上。

   src/styles/*.css 仍然保留（是那版的源码，供日后从源码侧再演进），
   但构建不再读它 —— 避免「改了源码却没生效」这种更难查的问题。 */
const LIVE_DIR = path.join(__dirname, 'live');
/* live/styles.css 保持逐字节不变（可与线上比对），
   新内容需要的少量类放在 live/addon.css 里追加 —— 两者职责分开，
   产物样式永远等于「线上样式 + 已知增量」，回退的可验证性才成立。 */
const LIVE_CSS = fs.readFileSync(path.join(LIVE_DIR, 'styles.css'), 'utf8');
const CSS_ADDON = fs.readFileSync(path.join(LIVE_DIR, 'addon.css'), 'utf8');
const CSS = LIVE_CSS + '\n\n' + CSS_ADDON;
/* 脚本同理，但**增量的形式不同**：脚本的改动是修改线上已有的函数（筛选器的分面匹配），
   追加在末尾够不着 IIFE 里的 $ / $$，复制一份实现又是本工程最反对的事。
   所以脚本走「登记式替换」：live/app-delta.js 逐条写明替换什么、为什么，并且每处必须命中
   恰好一次 —— 命中不了就抛错，不会静默少改一行、也不会悄悄改到别处。
   等式同样是可核对的：产物 app.js == 线上 app.js（逐字节，sha256 可对） + 已登记增量，
   `npm run check` 会断言它。 */
const APPJS = appDelta.applyAppDelta(fs.readFileSync(path.join(LIVE_DIR, 'app.js'), 'utf8'));
const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
const CSS_V = hash(CSS);
const JS_V = hash(APPJS);

/* ---------- 2. 组装数据 ---------- */
const raw = readJSON(path.join(ROOT, '.kb-raw.json'));
const curation = readJSON(path.join(__dirname, 'curation.json'));
const gh = readJSON(path.join(__dirname, 'data', 'github.json'), {});

const cats = curation.categories;
const catById = Object.fromEntries(cats.map(c => [c.id, c]));

function slugify(s) {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
/** 中文名转拼音式 slug 不现实，改用手工 slug 或拉丁名 */
function makeSlug(meta, name) {
  if (meta.slug) return meta.slug;
  if (/^[\x20-\x7e]+$/.test(name)) return slugify(name);
  return null; // 纯中文名必须显式给 slug
}

const apps = [];
for (const r of raw) {
  const meta = curation.apps[String(r.row)];
  if (!meta) { warnings.push(`row ${r.row} 无策展数据，已跳过`); continue; }
  const cat = catById[meta.cat];
  if (!cat) { warnings.push(`row ${r.row} 分类 ${meta.cat} 不存在，已跳过`); continue; }

  // 明确排除的条目不进入站点（原因记录在策展层，构建报告里列出）
  if (meta.status === 'exclude') {
    excluded.push({ row: r.row, name: meta.name, reason: meta.excludeReason || '未说明原因' });
    continue;
  }

  const slug = meta.slug || makeSlug(meta, meta.name);
  if (!slug) { warnings.push(`row ${r.row}「${meta.name}」是纯中文名但没有 slug，已跳过`); continue; }

  const info = gh[String(r.row)] || gh[meta.name] || {};
  const iconFile = ['.png', '.svg', '.webp', '.jpg']
    .map(ext => path.join(ICON_DIR, slug + ext))
    .find(p => fs.existsSync(p));

  apps.push({
    row: r.row,
    slug,
    name: meta.name,
    cat: cat.id,
    catName: cat.name,
    tone: cat.tone,
    tagline: meta.tagline,
    // 知识库原文在少数条目上与事实不符，策展层可覆盖（未覆盖则用原文）
    desc: meta.descOverride || r.category,
    features: meta.featOverride || r.features,
    link: r.link,
    pwd: r.pwd,
    icon: iconFile ? 'assets/icons/' + path.basename(iconFile) : null,
    status: meta.status || 'ok',
    flag: meta.flag || null,
    reviewReason: meta.reviewReason || null,
    gh: {
      isOpenSource: info.isOpenSource,
      repoFullName: info.repoFullName || null,
      repoUrl: info.repoUrl || null,
      stars: info.stars || null,
      license: info.license || null,
      platform: info.platform || null,
      pkg: info.pkg || null,
      confidence: info.confidence || null,
      notes: info.notes || null,
    },
  });
}

// 校验
const slugSeen = new Set();
for (const a of apps) {
  if (slugSeen.has(a.slug)) warnings.push(`slug 重复: ${a.slug}`);
  slugSeen.add(a.slug);
  if (!a.icon) warnings.push(`缺少图标: ${a.name}（${a.slug}）`);
  if (!a.gh.repoUrl) warnings.push(`未核实到仓库: ${a.name}`);
  if (a.gh.isOpenSource === false) warnings.push(`疑似非开源: ${a.name}`);
  if (a.gh.confidence === 'low') warnings.push(`仓库可信度低: ${a.name}`);
  if (a.status === 'review') warnings.push(`待确认条目: ${a.name}`);
  if (!a.gh.isOpenSource) a.gh.isOpenSource = a.gh.repoUrl ? true : undefined;
}

apps.sort((a, b) => a.row - b.row);
const bySlug = Object.fromEntries(apps.map(a => [a.slug, a]));
const byCat = Object.fromEntries(cats.map(c => [c.id, apps.filter(a => a.cat === c.id)]));
const starOf = a => parseInt(a.gh.stars || '0', 10) || 0;
const repoCount = apps.filter(a => a.gh.repoUrl).length;
const withLinkCount = apps.filter(a => a.link).length;

/* ---------- 2.2 电脑软件频道 ----------
   判据与 content/tags.json 的「支持桌面端」标签**完全一致**：核实到的 platform 字段里
   提到 Windows / macOS / Linux / 跨平台。不另立一套判据 —— 同一件事有两个口径，
   迟早出现「标签页说有 7 条、频道页说有 4 条」这种自己跟自己打架的情况。

   两个刻意的选择：
   · 只看核实字段，不看条目文案。实测有条目介绍写「兼容 Android 和桌面平台」，
     而核实到的平台只有 Android —— 按文本归类会跟本站自己的核实结论打架。
   · 门槛（minItems，默认 8 条）来自 site.config.json，不够就不产出页面、不亮频道卡。
     一个 6 条的薄频道页对访客和百度都是负分，这也是技能库当初的既定做法。
   跨平台条目（如 Kazumi、思源笔记）既在手机端也在电脑端，会同时出现在两个频道里 ——
   这是如实反映，不是重复收录，页面上也写明了判据。 */
const DESKTOP_PLATFORM_RE = /windows|macos|linux|跨平台/i;
const desktopApps = apps.filter(a => DESKTOP_PLATFORM_RE.test(String(a.gh.platform || '')));
const desktopChannelCfg = SITE.channels.find(c => c.id === 'desktop') || {};
const DESKTOP_MIN = desktopChannelCfg.minItems || 8;
const desktopLive = desktopApps.length >= DESKTOP_MIN;

/** 频道是否上线：内容不够（requires + minItems）就不算 live，卡片退回「筹备中」、不产出页面 */
function channelLive(c) {
  if (c.status !== 'live') return false;
  if (c.requires === 'desktop') return desktopLive;
  if (c.requires === 'skills') return skills.length > 0;
  if (c.requires === 'tools') return toolsLive;
  const count = c.countFrom === 'skills' ? skills.length
    : c.countFrom === 'tools' ? toolsOk.length
    : c.countFrom === 'apps' ? apps.length : null;
  return count === null || count > 0;
}
/* 对外展示的频道列表：hidden:true 的整条不出现。
   为什么用 hidden 而不是从 site.config.json 里删掉：用户说的是「先隐藏」，
   保留配置日后一行就能恢复；删掉就得凭记忆重建 id/desc/门槛这些字段。
   所有展示入口（频道卡、导语、关于页）都必须走这个列表，
   否则会出现「首页没有这张卡、关于页却还列着」的不一致。 */
const visibleChannels = SITE.channels.filter(c => !c.hidden);
/** 按 channel id 取条目数（没有的返回 null = 无法计数，卡片显示「已上线」） */
function channelCount(c) {
  if (!c) return null;
  if (c.countFrom === 'skills') return skills.length;
  if (c.countFrom === 'apps') return apps.length;
  if (c.countFrom === 'desktop') return desktopApps.length;
  if (c.countFrom === 'tools') return toolsOk.length;
  return null;
}
/**
 * 频道入口的导语。
 * 以前这里写死「软件库已上线；AI 工具、开源技能与中文教程正在筹备」——
 * 新增电脑软件频道后它就成了错话（页面上明明白白多了一张已上线的卡）。
 * 现在按实际状态拼，频道增删都不用再改这句话。
 */
function channelsBlurb() {
  const live = visibleChannels.filter(channelLive).map(c => c.name);
  const soon = visibleChannels.filter(c => !channelLive(c)).map(c => c.name);
  const parts = [];
  if (live.length) parts.push(`${live.join('、')}已上线`);
  if (soon.length) parts.push(`${soon.join('、')}正在筹备`);
  return `${parts.join('；')}，上线前不占位、不产出空页面。`;
}

/* ---------- 2.5 标签与专题 ----------
   标签只按条目自身文本归类（关键词命中），不人工贴标签 —— 每个标签都有据可查；
   命中数不足 minItems 的标签不产出页面，避免一页只挂一两条的薄内容。
   专题是人工策展的跨分类清单，成员用 slug 引用，写错会被报出来。 */
const tagsCfg = readJSON(path.join(__dirname, 'content', 'tags.json'), { tags: [], minItems: 3 });
const topicsCfg = readJSON(path.join(__dirname, 'content', 'topics.json'), { topics: [] });
const TAG_MIN = tagsCfg.minItems || 3;

const corpusOf = a => [a.name, a.tagline, a.desc, a.features, a.catName]
  .filter(Boolean).join(' ').toLowerCase();

for (const t of tagsCfg.tags) t.items = [];
for (const a of apps) {
  a.tags = [];
  const text = corpusOf(a);
  const lic = String(a.gh.license || '').toUpperCase();
  const plat = String(a.gh.platform || '');
  for (const t of tagsCfg.tags) {
    let hit = false;
    if (Array.isArray(t.kw)) hit = t.kw.some(k => text.includes(String(k).toLowerCase()));
    if (!hit && Array.isArray(t.license) && lic) {
      hit = t.license.some(l => lic.includes(String(l).toUpperCase()));
    }
    // 平台类标签走核实到的字段，不走宣传文本 —— 实测有条目介绍写「兼容桌面平台」
    // 而核实到的平台只有 Android，按文本归类会跟本站自己的核实结论打架
    if (!hit && Array.isArray(t.platform) && plat) {
      hit = t.platform.some(p => plat.toLowerCase().includes(String(p).toLowerCase()));
    }
    if (hit) { a.tags.push(t.slug); t.items.push(a); }
  }
}

const liveTags = tagsCfg.tags.filter(t => t.items.length >= TAG_MIN);
const skippedTags = tagsCfg.tags.filter(t => t.items.length < TAG_MIN);

/* ---------- 2.6 电脑软件页的「平台」筛选 ----------
   值域**直接取自 content/tags.json 的「支持桌面端」条目**（platform: Windows/macOS/Linux/跨平台），
   不另抄一份词表：频道门槛、页面上方的归类说明、/tag/desktop 与这里的 chips 共用同一个判据，
   改一处四处同时变 —— 否则迟早出现「标签页说 14 条、频道页说 12 条」这种自己跟自己打架。
   （这条规矩是阶段 3c 定下的：判据只有一份，见下面的 DESKTOP_PLATFORM_RE 注释。）

   一款软件可以同时命中多个值（实测 16 条里 1 条五个平台、2 条两个平台），所以卡片上同一个
   key 会重复出现，筛选器按「同一维度内取或」处理（live/app.js 的 initSkillsFilter 支持多值）。 */
const desktopTagCfg = tagsCfg.tags.find(t => t.slug === 'desktop') || {};
const DESKTOP_PLATFORM_VALUES = Array.isArray(desktopTagCfg.platform) ? desktopTagCfg.platform : [];

/** 一款软件命中哪些平台值，顺序照 tags.json 来（chips 的排列就与标签页的判据一致） */
const desktopPlatformsOf = a => {
  const plat = String(a.gh.platform || '').toLowerCase();
  return DESKTOP_PLATFORM_VALUES.filter(p => plat.includes(String(p).toLowerCase()));
};
/** 卡片上的分面串；同 key 多值，值用 tags.json 的原话（与 chip 的 data-facet 严格对应） */
const desktopFacetsOf = a => desktopPlatformsOf(a).map(p => `plat=${p}`).join(';');
/** chips：带计数，0 条的值不出现（不产出点了没结果的按钮） */
function desktopPlatformFacets() {
  return DESKTOP_PLATFORM_VALUES
    .map(v => ({ value: v, label: v, n: desktopApps.filter(a => desktopPlatformsOf(a).includes(v)).length }))
    .filter(v => v.n > 0);
}

const topics = [];
for (const tp of (topicsCfg.topics || [])) {
  const want = tp.slugs || [];
  const missing = want.filter(s => !bySlug[s]);
  if (missing.length) warnings.push(`专题「${tp.title}」引用了不存在的 slug：${missing.join('、')}`);
  const members = want.map(s => bySlug[s]).filter(Boolean);
  if (members.length < 2) { warnings.push(`专题「${tp.title}」有效成员不足 2 个，已跳过`); continue; }
  topics.push({ ...tp, members });
}

/** Star 榜：同分类最多取 2 个，避免头部全是同一类；不足再按剩余补齐 */
function topByStars(n) {
  const pool = apps.filter(a => a.gh.repoUrl).slice().sort((x, y) => starOf(y) - starOf(x));
  const picked = [], perCat = {}, rest = [];
  for (const a of pool) {
    if (picked.length >= n) break;
    const c = perCat[a.cat] || 0;
    if (c >= 2) { rest.push(a); continue; }
    perCat[a.cat] = c + 1;
    picked.push(a);
  }
  for (const a of rest) { if (picked.length >= n) break; picked.push(a); }
  return picked.slice(0, n);
}

/* ---------- 2.6 content 层条目（skill / tool / tutorial） ----------
   两条装载路径产出同一种条目形状：
     app 层  ← .kb-raw.json + curation.json + data/github.json（每日采集流水线在写）
     content 层 ← content/<type>/<slug>.json（新增类型自己的存储，per-item 一个文件）
   之所以不一次全迁到 per-item：app 层的写入口是采集流水线，现在迁要改 merge/verify/extract
   三处写入，等阶段 3 泛化多类型时一次性完成（见 UPGRADE-PLAN.md）。 */
const CONTENT_DIR = path.join(__dirname, 'content');
const contentItems = [];
const drafts = [];

/** 递归收集一个类型目录下的所有条目文件。
    为什么要递归：AI 工具按分类分了子目录（content/tool/<分类>/<slug>.json）——
    一个类目上百条时全平铺在一个目录里没法翻阅；技能与指南是平铺的，两种都要支持。
    目录名不参与语义（条目自己的 cat 字段才是分类依据），所以这里只认 .json 后缀。 */
function walkContentDir(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkContentDir(p));
    else if (e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

if (fs.existsSync(CONTENT_DIR)) {
  for (const type of fs.readdirSync(CONTENT_DIR)) {
    const dir = path.join(CONTENT_DIR, type);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const p of walkContentDir(dir).sort()) {
      const f = path.relative(dir, p).replace(/\\/g, '/');
      const e = readJSON(p, null);
      if (!e || !e.slug) { warnings.push(`content/${type}/${f} 不是有效条目，已跳过`); continue; }
      const item = { ...e, type: e.type || type };
      if (item.status === 'exclude') {
        excluded.push({ row: '-', name: item.nameZh || item.name || item.slug, reason: item.excludeReason || '内容层标记排除' });
        continue;
      }
      if (item.status !== 'ok') { drafts.push(item); continue; }
      // 硬闸门：已发布的 content 条目必须有中文文案 —— 宁可少发，不发错
      // title（指南类）与 nameZh（技能类）二选一即可
      const missing = ['tagline', 'desc'].filter(k => !item[k]);
      if (!item.title && !item.nameZh) missing.push('title/nameZh');
      if (missing.length) {
        warnings.push(`content 条目 ${item.slug} 缺文案（${missing.join('、')}），已跳过不发布`);
        continue;
      }
      contentItems.push(item);
    }
  }
}
const skills = contentItems.filter(i => i.type === 'skill');
const guides = contentItems.filter(i => i.type === 'guide')
  .sort((a, b) => (a.order || 99) - (b.order || 99));

/* ---------- 2.7 AI 工具库（type: tool） ----------
   AI 工具是**在线服务**，没有安装包、没有 github.json 里那套核实字段，所以它的
   数据模型与前两类不同，这里如实说明边界：

   · 可抓/可核实的：官网地址、是否开源、免费额度形态、支持平台
   · 必须人判断的：「国内是否要梯子」「中文支持程度」—— 这两项是访问体验，
     脚本在服务器侧测得通畅不代表用户侧通畅，所以是人工核实后写进条目的字段

   合规边界：条目的名称/官网/是否开源属于事实，可以收录；
   **一句介绍与功能要点一律是本站自己写的**，不搬运任何工具目录站的文案 ——
   采集站文案既侵权，也会被百度判重复内容降权（这正是「想提高搜索流量」的反面）。 */
const tools = contentItems.filter(i => i.type === 'tool');
const TOOL_CATS = (cfg.toolCategories || []).slice();
const toolCatById = Object.fromEntries(TOOL_CATS.map(c => [c.id, c]));
const toolsByCat = Object.fromEntries(TOOL_CATS.map(c => [c.id, []]));

/* 跨分类的 slug 冲突：详情页 URL 是 /ai/<slug>，与分类无关，所以同一个 slug
   在两个分类目录下各存一份时，产物里两个页面会写进同一个 URL（后者覆盖前者），
   sitemap 也会出现两条一样的 loc —— 实测正是这么被 check-dist 抓出来的。
   事实包是分批导入的，导入器只能在「本次导入 vs 已落盘」之间查官网重复，
   查不到「两份都已落盘」的情况，所以构建期必须再兜一道：
   保留第一个（按分类配置顺序），把冲突如实报出来，绝不静默覆盖。 */
const toolsBySlug = new Map();
const toolSlugClash = [];
for (const t of tools) {
  const prev = toolsBySlug.get(t.slug);
  if (prev) {
    toolSlugClash.push({ slug: t.slug, kept: prev.cat, dropped: t.cat });
    continue;
  }
  toolsBySlug.set(t.slug, t);
}
const toolsDeduped = [...toolsBySlug.values()];
for (const c of toolSlugClash) {
  warnings.push(
    `AI 工具 slug「${c.slug}」同时存在于分类 ${c.kept} 与 ${c.dropped}：` +
    `详情页 URL /ai/${c.slug} 只能有一个，已保留 ${c.kept}。` +
    `请手动删除 content/tool/${c.dropped}/${c.slug}.json（或改 slug），否则两个分类的计数都会虚高。`);
}

// 归类错了要能被发现，而不是默默掉出站点：分类不存在的条目直接报出来
const toolUncategorized = [];
for (const t of toolsDeduped) {
  const c = toolCatById[t.cat];
  if (!c) { toolUncategorized.push(t); continue; }
  toolsByCat[c.id].push(t);
}
for (const t of toolUncategorized) {
  warnings.push(`AI 工具「${t.nameZh || t.slug}」的分类 ${t.cat} 不在 site.config.json 的 toolCategories 里，已跳过`);
}
const toolsOk = toolsDeduped.filter(t => toolCatById[t.cat]);

/* ---------- 2.8 AI 库的两级分类（父类 → 功能子类） ----------
   配置在 content/tool-subcats.json，成员是**人工判定**的，不做关键词匹配。
   实测关键词会犯实质错误：ACE Studio（歌声合成）因介绍里有「分离」被判进「音轨分离」，
   魔音工坊 / 讯飞智作（配音平台）因介绍里有「音色克隆」被判进「语音克隆」。
   子类页归错类比没有子类页更糟 —— 访客一眼就看出不对。

   两个刻意的取舍：
   1) **一个条目可以同时属于多个子类**（如「多模态理解」的助手也在「通用对话助手」里）。
      这跟标签页同一个道理：子类是功能视角，不是抽屉，一个工具能做两件事就如实出现在两处。
      但由此产生的后果必须处理 —— 见下一条。
   2) **成员集合与父类完全相同的子类不产出页面**。chatbot 下「通用对话助手」如果就是全部 10 条，
      那这一页跟父类页一模一样，是纯粹的自己抄自己。这种子类只作为分类页上的筛选标签，
      并会打印出来说明原因。 */
const subcatCfg = readJSON(path.join(CONTENT_DIR, 'tool-subcats.json'), { subcats: [], minItems: 4 });
const SUBCAT_MIN = subcatCfg.minItems || 4;

/** 一个父类下的子类定义（已解析成员、已判是否产出页面） */
const subsByCat = {};
/** slug → 它所属的子类列表（详情页/面包屑按需查） */
const subcatsOfTool = {};
/** 不够门槛、不产出页面的子类（构建报告里逐条说明原因） */
const notLiveSubs = [];

for (const group of (subcatCfg.subcats || [])) {
  const cat = group.cat;
  if (!toolCatById[cat]) {
    warnings.push(`tool-subcats.json 里的分类 ${cat} 不在 site.config.json 的 toolCategories 里，已跳过`);
    continue;
  }
  const parentSlugs = new Set(toolsByCat[cat].map(t => t.slug));
  const seenSlug = new Set();
  const defs = [];

  for (const raw of (group.items || [])) {
    if (!raw.name || !raw.slug) {
      warnings.push(`tool-subcats.json：分类 ${cat} 下有一个子类缺 name 或 slug，已跳过（slug 必须是 ASCII，不能由中文名推导）`);
      continue;
    }
    if (seenSlug.has(raw.slug)) { warnings.push(`tool-subcats.json：分类 ${cat} 下子类 slug「${raw.slug}」重复，已跳过`); continue; }
    seenSlug.add(raw.slug);

    for (const s of (raw.slugs || [])) {
      if (!parentSlugs.has(s)) warnings.push(`tool-subcats.json：子类「${raw.name}」引用了不属于 ${cat} 的条目 ${s}，已忽略该引用`);
    }
    // 成员顺序按「父类中的顺序」排，而不是按配置里 slugs 的书写顺序 ——
    // 同一个工具在不同子类页上的相对位置才一致，翻页时不会觉得顺序在跳
    const members = toolsByCat[cat].filter(t => (raw.slugs || []).includes(t.slug));
    if (!members.length) { warnings.push(`tool-subcats.json：子类「${raw.name}」解析后没有成员，已跳过`); continue; }

    // 成员与父类完全相同的子类不产出页面：那一页就是父类页的副本
    const sameAsParent = members.length === toolsByCat[cat].length;
    const live = members.length >= SUBCAT_MIN && !sameAsParent;
    if (!live) {
      notLiveSubs.push({
        cat, name: raw.name, n: members.length,
        why: sameAsParent
          ? `成员与父类完全相同（${members.length}/${toolsByCat[cat].length}），产出会是父类页的副本`
          : `只有 ${members.length} 条，不足门槛 ${SUBCAT_MIN}`,
      });
    }
    defs.push({ name: raw.name, desc: raw.desc || '', slug: raw.slug, members, live, sameAsParent });
  }

  if (defs.length) {
    subsByCat[cat] = defs;
    for (const d of defs) for (const t of d.members) {
      (subcatsOfTool[t.slug] = subcatsOfTool[t.slug] || []).push({ cat, sub: d.slug, name: d.name });
    }
  }
}
/** 某个父类下「真的产出页面」的子类 */
const liveSubsOf = cat => (subsByCat[cat] || []).filter(d => d.live);
const liveSubcatCount = Object.keys(subsByCat).reduce((n, c) => n + liveSubsOf(c).length, 0);

/* 只产出「够条数」的分类：一两条的分类页对访客和搜索引擎都是薄内容。
   门槛与频道页/标签页同一套 minItems 思路 —— 不够就不产出页面、筛选条上也不出现。 */
const TOOLCAT_MIN = (cfg.toolCategoryMinItems || 4);
const liveToolCats = TOOL_CATS.filter(c => toolsByCat[c.id].length >= TOOLCAT_MIN);
const thinToolCats = TOOL_CATS.filter(c => toolsByCat[c.id].length > 0 && toolsByCat[c.id].length < TOOLCAT_MIN);
/* 频道门槛：AI 库至少要有这么多条才上线（首页频道卡、导航项、频道页用同一个答案） */
const aiChannelCfg = SITE.channels.find(c => c.id === 'ai') || {};
const TOOLS_MIN = aiChannelCfg.minItems || 24;
const toolsLive = toolsOk.length >= TOOLS_MIN;

/** 宿主短标签：从路径推断出来的宿主名收敛成卡片上一个短词 */
const hostShort = s => {
  const h = (s.source && s.source.hostGuess) || '';
  if (/Claude Code/i.test(h)) return 'Claude Code';
  if (/Gemini/i.test(h)) return 'Gemini CLI';
  if (/OpenClaw/i.test(h)) return 'OpenClaw';
  if (/Cursor/i.test(h)) return 'Cursor';
  if (/Anthropic|Claude/i.test(h)) return 'Claude 技能';
  return '技能';
};

/* ---------- 3. 工具 ---------- */
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* 「功能特点」正文。知识库里这个字段有两种形态，渲染必须都吃得下：
     · 早期条目（以及手工策展的覆盖值）是一个字符串段落 → 原样渲染成 <p>
     · 每日采集流水线 merge.mjs 写入的是一条条特性 → 渲染成 <ul>
   漏掉数组这一支的后果不是报错，而是 Array→String 隐式转换把
   ["支持协议 A","支持协议 B"] 印成「支持协议 A,支持协议 B」——首屏看着像一句话，
   实际是一串没有标点的拼接，而且静默通过所有校验。2026-10-05 发布的 5 条就这样上过线。 */
const featureBlock = f => {
  if (Array.isArray(f)) {
    const items = f.filter(x => String(x == null ? '' : x).trim());
    if (!items.length) return '';
    return `<ul>${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  }
  return `<p>${esc(f)}</p>`;
};

const initial = name => {
  const ch = String(name || '?').trim()[0];
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch;
};

/** 取一段话的完整分句，不截断在句子中间 —— 首页 Bento 大卡用它填内容 */
function snippet(s, max = 84) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const p = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('！'), cut.lastIndexOf('，'));
  return (p > 24 ? cut.slice(0, p + 1) : cut) + '…';
}

/** 相对根路径前缀：index.html -> ''，apps/x.html -> '../' */
const up = depth => depth === 0 ? '' : '../'.repeat(depth);

/** 打开网盘用的地址：把提取码拼回 ?pwd= —— 实测百度认这个参数会**自动填入并直接进文件列表**，
    而站上存的 link 是剥掉 pwd 的干净地址（展示用），所以打开时必须自己拼回去。
    链接本身已经带 pwd 的就不重复拼（防御，历史数据可能有）。 */
function panOpenUrl(link, pwd) {
  if (!link) return '';
  if (!pwd || /[?&]pwd=/i.test(link)) return link;
  return link + (link.includes('?') ? '&' : '?') + 'pwd=' + encodeURIComponent(pwd);
}

const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M12 6l6 6-6 6"/></svg>';
const STAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.7l6.1-.9z"/></svg>';

/** 品牌标记：三层递减的横条 = 资源的层叠。
    顶条改用紫→珊瑚渐变（skillhub 双色的品牌签名），下两条跟随文字色。 */
const LOGO_MARK = '<svg class="brand__mark" viewBox="0 0 32 32" aria-hidden="true">' +
  '<defs><linearGradient id="xhb" x1="0" y1="0" x2="1" y2="0">' +
  '<stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent-2)"/></linearGradient></defs>' +
  '<rect x="4" y="6" width="24" height="6.4" rx="3.2" fill="url(#xhb)"/>' +
  '<rect x="4" y="14.8" width="17.6" height="6.4" rx="3.2" fill="currentColor" opacity=".55"/>' +
  '<rect x="4" y="23.6" width="11.2" height="6.4" rx="3.2" fill="currentColor" opacity=".28"/></svg>';

const THEME_ICONS =
  '<svg data-ic="auto" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><path d="M12 3.4a8.6 8.6 0 0 0 0 17.2z" fill="currentColor" stroke="none"/></svg>' +
  '<svg data-ic="light" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.5 5.5l1.6 1.6M16.9 16.9l1.6 1.6M18.5 5.5l-1.6 1.6M7.1 16.9l-1.6 1.6"/></svg>' +
  '<svg data-ic="dark" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.6 14.7A8.7 8.7 0 1 1 9.3 3.4a7 7 0 0 0 11.3 11.3z"/></svg>';

/* ---------- 4. 片段 ---------- */
function iconHTML(a, cls = 'ico', size = 40) {
  const style = `--tone:var(--tone-${a.tone});--tint:var(--tint-${a.tone})`;
  if (a.icon) {
    return `<span class="${cls}" data-tone="${a.tone}" style="${style}">` +
      `<img src="__R__${a.icon}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">` +
      `</span>`;
  }
  return `<span class="${cls}" data-tone="${a.tone}" style="${style}" aria-hidden="true">${esc(initial(a.name))}</span>`;
}

function starHTML(a) {
  const n = starOf(a);
  if (!n) return '';
  return `<span class="star" title="GitHub Star 数">${STAR_ICON}${n.toLocaleString('en-US')}</span>`;
}

/** 资源卡片。facets 只在需要多维筛选的页面上传（电脑软件页的平台维度）——
    不默认全站都带：带 data-facets 的卡片会改走 initSkillsFilter，首页那套 data-cat
    单维筛选就会被让开，多出来的东西不该顺手改掉既有的筛选行为。 */
function cardHTML(a, depth, facets) {
  const r = up(depth);
  const hay = [a.name, a.tagline, a.desc, a.catName].join(' ').toLowerCase().replace(/"/g, '');
  return `<a class="card" href="${r}apps/${a.slug}.html" data-cat="${a.cat}"${facets ? ` data-facets="${esc(facets)}"` : ''} data-hay="${esc(hay)}" data-tone="${a.tone}">
  <span class="card__top">${iconHTML(a).replace('__R__', r)}<span class="card__name">${esc(a.name)}</span></span>
  <span class="card__tl">${esc(a.tagline)}</span>
  <span class="card__bot"><span class="tag">${esc(a.catName)}</span><span class="card__go">查看${ARROW}</span></span>
</a>`;
}

function chipsHTML(depth, activeCat) {
  const r = up(depth);
  let h = `<a class="chip" data-cat="all" href="${r}index.html" aria-pressed="${activeCat === 'all'}"${activeCat === 'all' ? ' aria-current="page"' : ''}>全部<span class="chip__n">${apps.length}</span></a>`;
  for (const c of cats) {
    const on = activeCat === c.id;
    h += `<a class="chip" data-cat="${c.id}" href="${r}category/${c.id}.html" aria-pressed="${on}"${on ? ' aria-current="page"' : ''}>${esc(c.name)}<span class="chip__n">${byCat[c.id].length}</span></a>`;
  }
  return h;
}

/** 顶栏导航项。
    可见性与频道页用同一个判定函数，避免两处口径漂移。
    **每个导航项都是可点的真链接**，不再有「只能展开不能点」的入口 ——
    顶栏巨型菜单那一版已经回退，导航恢复成线上那版的一排链接。 */
function navItemsHTML(depth, active) {
  const r = up(depth);
  return SITE.nav.filter(n => {
    if (!n.requires) return true;
    if (n.requires === 'skills') return skills.length > 0;
    if (n.requires === 'tools') return toolsLive;
    if (n.requires === 'desktop') return desktopLive;
    if (n.requires === 'product') return !!PRODUCT;
    if (n.requires === 'guides') return guides.length > 0;
    return true;
  }).map(n => {
    const on = active === n.key || (n.key === 'cat' && catById[active]);
    return `<a href="${r}${n.href}"${on ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`;
  }).join('\n      ');
}

function headerHTML(depth, active) {
  return `<a class="skip" href="#main">跳到主要内容</a>
<header class="hdr">
  <div class="wrap hdr__in">
    <a class="brand" href="${up(depth)}index.html">${LOGO_MARK}<span>${esc(SITE.name)}</span><span class="brand__sub">${esc(SITE.tagline)}</span></a>
    <nav class="nav" aria-label="主导航">
      ${navItemsHTML(depth, active)}
    </nav>
    <div class="hdr__spacer"></div>
    <button class="theme-btn" id="themeBtn" type="button" aria-label="切换主题">${THEME_ICONS}</button>
  </div>
</header>`;
}

function footerHTML(depth) {
  const r = up(depth);
  const link = (label, href) => {
    const full = /^https?:/.test(href) ? href : r + href;
    const ext = /^https?:/.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<li><a href="${full}"${ext}>${esc(label)}</a></li>`;
  };
  const catLinks = cats.map(c => link(c.name, `category/${c.id}.html`)).join('');
  const legal = [
    link('关于本站', 'about.html'),
    link('免责声明', 'disclaimer.html'),
    link('版权与侵权处理', 'copyright.html'),
  ].join('');
  const productLink = PRODUCT ? link('号狐浏览器 · 自营', 'products/haofox.html') : '';
  const contact = SITE.email
    ? `<li><a href="mailto:${esc(SITE.email)}">${esc(SITE.email)}</a></li>`
    : '';

  return `<footer class="ftr">
  <div class="wrap">
    <div class="ftr__top">
      <div class="ftr__brand-col">
        <div class="ftr__brand">${LOGO_MARK}<span>${esc(SITE.name)}</span></div>
        <p class="ftr__slogan">${esc(SITE.slogan)}</p>
      </div>
      <div class="ftr__col">
        <h3>浏览</h3>
        <ul>${link('全部资源', 'index.html')}${link('频道入口', 'index.html#cats')}${link('专题合集', 'index.html#topics')}${productLink}${legal}</ul>
      </div>
      <div class="ftr__col">
        <h3>分类</h3>
        <ul>${catLinks}</ul>
      </div>
      <div class="ftr__col">
        <h3>联系与合规</h3>
        <ul>
          ${contact}
          <li><a href="https://beian.miit.gov.cn/#/Integrated/index" target="_blank" rel="noopener noreferrer">${esc(SITE.beian)}</a></li>
          <li><span class="muted">内容仅收录开源与非商业免费资源</span></li>
        </ul>
      </div>
    </div>
    <p class="ftr__note">
      免责声明：本站是资源整理与索引站点，不存储、不制作、不修改任何软件与文档，也不提供破解、去广告或商业授权版本。
      站内条目均来自公开渠道，版权归各自作者所有；本站仅提供信息整理与获取指引，资源仅供个人学习与研究使用，
      请于下载后 24 小时内自行删除，并前往官方渠道支持作者。若权利人认为本站内容不妥，请通过本页联系方式告知，我们会及时核实处理。
    </p>
    <div class="ftr__legal">
      <span>Copyright © ${SITE.since}–${SITE.until} ${esc(SITE.name)}</span>
      <span class="muted">每一条都核对了官方来源</span>
    </div>
  </div>
</footer>`;
}

const tweaksHTML = `<div class="tw">
  <div class="tw__panel" id="twPanel">
    <div class="tw__row"><span>主题</span>
      <div class="seg" id="twTheme">
        <button data-v="auto" aria-pressed="true">自动</button>
        <button data-v="light" aria-pressed="false">浅色</button>
        <button data-v="dark" aria-pressed="false">深色</button>
      </div>
    </div>
    <div class="tw__row"><span>卡片密度</span>
      <div class="seg" id="twDensity">
        <button data-v="comfy" aria-pressed="true">舒展</button>
        <button data-v="compact" aria-pressed="false">紧凑</button>
      </div>
    </div>
    <div class="tw__row"><span>分类色彩</span>
      <div class="seg" id="twNeutral">
        <button data-v="0" aria-pressed="true">彩色</button>
        <button data-v="1" aria-pressed="false">单色</button>
      </div>
    </div>
  </div>
  <button class="tw__btn" id="twBtn" aria-expanded="false">外观</button>
</div>`;

const toTopHTML = `<button class="totop" id="toTop" type="button" aria-label="返回顶部"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V6M6 12l6-6 6 6"/></svg></button>`;

/** 站长平台验证 meta：只放首页 —— 百度/搜狗/360 验证的都是站点根地址。
    留空的平台整行不输出，不产生空 content。 */
function verificationMeta() {
  const v = SITE.verification || {};
  const rows = [
    ['baidu-site-verification', v.baidu],
    ['sogou_site_verification', v.sogou],
    ['360-site-verification', v['360']],
  ].filter(([, val]) => val);
  return rows.map(([name, val]) => `<meta name="${name}" content="${esc(val)}">`).join('\n') + (rows.length ? '\n' : '');
}

/* ---------- 5. 页面骨架 ----------
   恢复成线上那版：**朴素顶栏 + 单列内容**，没有左右外壳、没有抽屉。
   各页面函数生成的 body 本身就以 headerHTML() 开头、再接 <main>，
   所以这里直接原样输出 —— 不再像顶栏巨型菜单那版那样把顶栏「提」到外层
   （那版需要 .app/.app__main 两列外壳，现在外壳已回退，提出来反而会多一层）。 */
function page({ depth, title, desc, canonical, body, jsonld, extraHead = '', active = '' }) {
  const r = up(depth);
  void active;   // 线上那版顶栏高亮由各页传入的 active 决定，保留参数以免 20 个调用点报错
  const blocks = Array.isArray(jsonld) ? jsonld : (jsonld ? [jsonld] : []);
  const ld = blocks.length
    ? blocks.map(b => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join('\n') + '\n'
    : '';
  const content = body;
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="${SITE.theme.light}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(SITE.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE.url}/assets/og.png">
<meta name="twitter:card" content="summary_large_image">
${THEME_BOOT}
<link rel="icon" href="${r}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${r}assets/styles.css?v=${CSS_V}">
${ADSENSE}
${BAIDU_TJ}
${extraHead}${ld}</head>
<body>
${content}
${tweaksHTML}
${toTopHTML}
<script src="${r}assets/app.js?v=${JS_V}" defer></script>
</body>
</html>
`;
}

/* ---------- 6. 首页 ---------- */
function channelsHTML() {
  return `<div class="channels">
${visibleChannels.map((c, i) => {
    // 有内容才算上线：空频道不占位、不产出空页面；要求了门槛的（requires + minItems）
    // 由 channelLive 统一判定 —— 首页卡片与频道页是否产出必须用同一个答案
    const live = channelLive(c);
    const n = live ? channelCount(c) : null;
    const inner = `
    <span class="chan__hd"><span class="chan__name">${esc(c.name)}</span><span class="chan__en">${esc(c.en || '')}</span></span>
    <span class="chan__desc">${esc(c.desc)}</span>
    <span class="chan__foot">${live
      ? `<span class="chan__n">${n == null ? '已上线' : n + ' 条'}</span><span>· 持续更新</span>`
      : `<span class="badge">筹备中</span><span>· ${c.requires === 'desktop' && n == null ? `已有 ${desktopApps.length}/${DESKTOP_MIN} 条` : '敬请期待'}</span>`}</span>`;
    return live
      ? `<a class="chan" href="${c.href || 'index.html'}" data-status="live" data-reveal style="--reveal-delay:${i * 60}ms">${inner}\n  </a>`
      : `<div class="chan" data-status="soon" data-reveal style="--reveal-delay:${i * 60}ms">${inner}\n  </div>`;
  }).join('\n')}
</div>`;
}

function bentoHTML() {
  const top = topByStars(5);
  if (!top.length) return '';
  const [lead, ...rest] = top;
  const leadCard = `<a class="bento__i bento__i--lg" href="apps/${lead.slug}.html" data-tone="${lead.tone}"
    style="--tint:var(--tint-${lead.tone})" data-reveal>
    <span class="bento__rank">STAR #1</span>
    ${iconHTML(lead, 'ico', 58).replace('__R__', '')}
    <span class="bento__name">${esc(lead.name)}</span>
    <span class="bento__tl">${esc(lead.tagline)}</span>
    ${snippet(lead.desc) ? `<span class="bento__more">${esc(snippet(lead.desc))}</span>` : ''}
    <span class="bento__foot"><span class="tag">${esc(lead.catName)}</span>${starHTML(lead)}</span>
  </a>`;
  const small = rest.map((a, i) => `<a class="bento__i" href="apps/${a.slug}.html" data-tone="${a.tone}"
    style="--tint:var(--tint-${a.tone})" data-reveal data-reveal-delay="${(i + 1) * 70}">
    <span class="bento__rank">#${i + 2}</span>
    ${iconHTML(a, 'ico', 40).replace('__R__', '')}
    <span class="bento__name">${esc(a.name)}</span>
    <span class="bento__tl">${esc(a.tagline)}</span>
    <span class="bento__foot"><span class="tag">${esc(a.catName)}</span>${starHTML(a)}</span>
  </a>`).join('\n  ');
  return `<div class="bento">
  ${leadCard}
  ${small}
</div>`;
}

function promisesHTML() {
  if (!SITE.promises.length) return '';
  return `<div class="promises">
${SITE.promises.map(p => `  <div class="promise"><b>${esc(p.k)}</b><p>${esc(p.v)}</p></div>`).join('\n')}
</div>`;
}

/* 自营产品：首页推广横幅。与开源资源分开展示，明确「官方出品 · 自营」身份 */
function productBannerHTML() {
  if (!PRODUCT) return '';
  return `<div class="promo" data-reveal>
  <span class="promo__badge">${esc(PRODUCT.badge)}</span>
  <h2 class="promo__title">${esc(PRODUCT.homeTitle)}</h2>
  <p class="promo__text">${esc(PRODUCT.homeText)}</p>
  <div class="promo__acts">
    <a class="btn btn--product" href="products/${PRODUCT.slug}.html">了解详情${ARROW}</a>
    ${PRODUCT.url ? `<a class="btn btn--ghost" href="${esc(PRODUCT.url)}" target="_blank" rel="noopener noreferrer">访问官网</a>` : ''}
  </div>
  ${PRODUCT.homeNote ? `<span class="promo__note">${esc(PRODUCT.homeNote)}</span>` : ''}
</div>`;
}

/* 官方出品：首页只放自营产品横幅。
   原先这里是「自营产品 + 运营指南」合成的一块，用户要求把指南层挪进自营产品详情页
   （/products/haofox.html）。理由也站得住：指南本就是围绕这款产品写的实操内容，
   放在产品页里「介绍产品 → 读实操 → 开始使用」是一条完整的路径；
   留在首页则要在两处重复说明「与开源收录相互独立」。
   指南的渲染（guideCardHTML / productGuidesHTML）产品页继续复用，没有复制一份。
   产品为空时整块不产出（此时指南另有入口：导航的「运营指南」→ guides/index.html）。 */
function productSectionHTML() {
  if (!PRODUCT) return '';
  return `<section class="sec sec--tight" id="official">
    <div class="wrap">
      <div class="sec-hd">
        <h2>官方出品</h2>
        <p>站长自营的产品，单独标注，与上方开源收录相互独立。</p>
      </div>
      ${productBannerHTML()}
    </div>
  </section>`;
}

/* 联盟导购卡片（第三方推广）：与自营产品视觉上分开，用「广告」角标标识推广身份。
   点击走本地跳转页 /go/<id>.html?ref=…，跳转页记录来源后再重定向到真实联盟链接，
   这样能区分「首页 / 哪个软件」带来的点击。ref 用于来源标记。 */
function affiliateCardHTML(p, depth, ref) {
  const r = up(depth);
  const goHref = `${r}go/${p.id}.html?ref=${encodeURIComponent(ref || 'direct')}`;
  // 配了百度统计就上报点击事件（类别 affiliate / 动作=联盟方 id / 标签=来源）
  const track = ANALYTICS.baiduTongjiId
    ? ` onclick="if(window._hmt){_hmt.push(['_trackEvent','affiliate','${p.id}','${ref || 'direct'}']);}"`
    : '';
  return `<aside class="aff">
  <div class="aff__top">
    <span class="aff__tag">广告</span>
    <span class="aff__provider">${esc(p.provider)}</span>
  </div>
  <h3 class="aff__title">${esc(p.title)}</h3>
  <p class="aff__text">${esc(p.text)}</p>
  <div class="aff__acts"><a class="btn btn--solid" href="${goHref}"${track}>${esc(p.cta)}${ARROW}</a></div>
</aside>`;
}

/* 首页「云服务器推荐」区块。用户要求放在 App 列表**下方**（原先在首屏英雄区之后、
   频道入口之前）：导购位不该比收录内容更早出现，访客先看到资源列表，
   再看到「想自建服务可以看这些云厂商」才顺。位置由 buildHome 的顺序决定，不在这里控制。 */
function affiliateSectionHTML() {
  if (!AFFILIATES.length) return '';
  return `<section class="sec sec--tight" id="affiliate">
    <div class="wrap">
      <div class="sec-hd">
        <h2>云服务器推荐</h2>
        <p>想自建服务？这些云厂商面向新人有首购优惠。</p>
      </div>
      <div class="aff-grid">
        ${AFFILIATES.map(p => affiliateCardHTML(p, 0, 'home')).join('\n        ')}
      </div>
    </div>
  </section>`;
}

function topicsHTML() {
  if (!topics.length) return '';
  return `<div class="topics">
${topics.map((tp, i) => `  <a class="topic" href="topic/${tp.slug}.html" data-tone="${esc(tp.tone || 'slate')}" data-reveal style="--reveal-delay:${i * 60}ms">
    <span class="topic__n">${tp.members.length} 条</span>
    <span class="topic__t">${esc(tp.title)}</span>
    <span class="topic__s">${esc(tp.sub || '')}</span>
    <span class="topic__go">查看专题${ARROW}</span>
  </a>`).join('\n')}
</div>`;
}

function tagRowHTML() {
  if (!liveTags.length) return '';
  return `<div class="tagrow">
  <span class="tagrow__lab">按标签找</span>
  <div class="chips">
${liveTags.map(t => `    <a class="chip" href="tag/${t.slug}.html">${esc(t.name)}<span class="chip__n">${t.items.length}</span></a>`).join('\n')}
  </div>
</div>`;
}

function buildHome() {
  const cards = apps.map(a => cardHTML(a, 0)).join('\n');
  const catNames = cats.map(c => c.name).join('、');
  const lede = `${apps.length} 款经过挑选的开源应用，覆盖${catNames}。每款都附官方仓库地址与百度网盘获取方式，提取码一键复制。` +
    `AI 工具、开源技能与中文教程正在陆续上线。`;

  const body = `${headerHTML(0, 'all')}
<main id="main">
  <section class="hero is-glow">
    <div class="wrap">
    <p class="eyebrow">${esc(SITE.tagline)}</p>
    <h1>把 GitHub 上值得用的开源软件，<br>做成你<em>直接能拿到手</em>的中文资源。</h1>
    <p class="hero__lede">${esc(lede)}</p>
    <div class="hero__acts">
      <a class="btn btn--solid" href="#all">浏览全部资源${ARROW}</a>
      <a class="btn btn--ghost" href="about.html">为什么可信</a>
    </div>
    <div class="hero__stats">
      <div class="stat"><b>${apps.length}</b><span>收录条目</span></div>
      <div class="stat"><b>${cats.length}</b><span>资源分类</span></div>
      <div class="stat"><b>${apps.length ? Math.round(repoCount / apps.length * 100) : 0}%</b><span>已核实官方仓库</span></div>
      <div class="stat"><b>${apps.length ? Math.round(withLinkCount / apps.length * 100) : 0}%</b><span>可直接获取</span></div>
    </div>
    </div>
  </section>

  <section class="sec" id="cats">
    <div class="wrap">
      <div class="sec-hd">
        <h2>频道入口</h2>
        <p>${esc(channelsBlurb())}</p>
      </div>
      ${channelsHTML()}
    </div>
  </section>

  ${productSectionHTML()}

  <section class="tools" id="all">
    <div class="wrap tools__in">
      <div class="chips" id="chips" role="group" aria-label="按分类筛选">${chipsHTML(0, 'all')}</div>
      <div class="tools__meta"><b id="shown">${apps.length}</b><span>条</span></div>
      <div class="search">
        <svg class="search__ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="q" type="search" placeholder="搜索名称或功能…" aria-label="搜索资源" autocomplete="off">
        <button class="search__clr" id="clr" type="button" aria-label="清除搜索"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        <kbd>/</kbd>
      </div>
    </div>
  </section>

  <section class="wrap grid-sec">
    <h2 class="sr">资源列表</h2>
    <div class="grid" id="grid">
${cards}
    </div>
    <div class="empty" id="empty" hidden>
      <p>没有匹配的资源</p>
      <button class="btn btn--ghost" id="reset" type="button">清除筛选条件</button>
    </div>
    <noscript><p style="padding:40px 0;color:var(--ink-3);font-size:15px">筛选与搜索需要启用 JavaScript；上方已列出全部 ${apps.length} 条资源，可直接点击进入详情页。</noscript>
  </section>

  ${affiliateSectionHTML()}

  <section class="sec" id="topics">
    <div class="wrap">
      <div class="sec-hd">
        <h2>专题合集</h2>
        <p>按场景把跨分类的条目串起来 —— 分类切不出来的角度，才值得单独做一页。</p>
      </div>
      ${topicsHTML()}
      ${tagRowHTML()}
    </div>
  </section>

  <section class="sec sec--tight" id="stars">
    <div class="wrap">
      <div class="sec-hd">
        <h2>Star 最多的开源软件</h2>
        <p>按 GitHub Star 数排序，数据为核实仓库时抓取的快照 —— 不是编辑推荐，可自行前往仓库复核。</p>
      </div>
      ${bentoHTML()}
    </div>
  </section>

  <section class="sec" id="promises">
    <div class="wrap">
      <div class="sec-hd"><h2>本站承诺</h2></div>
      ${promisesHTML()}
    </div>
  </section>
</main>
${footerHTML(0)}`;

  return page({
    depth: 0,
    active: 'all',
    title: SITE.homeTitle,
    desc: lede,
    canonical: SITE.url + '/',
    body,
    extraHead: verificationMeta(),
    jsonld: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: SITE.name,
        alternateName: SITE.short,
        url: SITE.url + '/',
        description: SITE.slogan,
        inLanguage: 'zh-CN',
      },
      {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: SITE.name,
        url: SITE.url + '/',
        description: SITE.slogan,
      },
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: `${SITE.name} · ${SITE.tagline}`,
        numberOfItems: apps.length,
        itemListElement: apps.map((a, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: a.name,
          url: `${SITE.url}/apps/${a.slug}`,
        })),
      },
    ],
  });
}

/* ---------- 7. 详情页 ---------- */
function buildDetail(a) {
  const depth = 1;
  const R = up(depth);
  const rel = byCat[a.cat].filter(x => x.slug !== a.slug).slice(0, 6);
  // 「可自建服务」场景：这类软件常需自托管，详情页顺带放云服务器联盟导购位
  const isSelfHosted = (a.tags || []).includes('self-hosted');

  const metaCells = [];
  if (a.gh.repoUrl) {
    const isGitLab = a.gh.repoUrl.includes('gitlab.com');
    const shown = a.gh.repoFullName || a.gh.repoUrl.replace(/^https?:\/\//, '');
    metaCells.push(`<div class="meta__cell"><div class="meta__k">${isGitLab ? 'GitLab' : 'GitHub'} 仓库</div><div class="meta__v"><a href="${esc(a.gh.repoUrl)}" target="_blank" rel="noopener noreferrer">${esc(shown)}</a></div></div>`);
  }
  if (a.gh.stars) metaCells.push(`<div class="meta__cell"><div class="meta__k">Star</div><div class="meta__v">${esc(Number(starOf(a)).toLocaleString('en-US'))}</div></div>`);
  if (a.gh.license) metaCells.push(`<div class="meta__cell"><div class="meta__k">开源协议</div><div class="meta__v">${esc(a.gh.license)}</div></div>`);
  if (a.gh.platform) metaCells.push(`<div class="meta__cell"><div class="meta__k">支持平台</div><div class="meta__v">${esc(a.gh.platform)}</div></div>`);
  metaCells.push(`<div class="meta__cell"><div class="meta__k">分类</div><div class="meta__v"><a href="../category/${a.cat}.html">${esc(a.catName)}</a></div></div>`);

  const repoBtn = a.gh.repoUrl
    ? `<a class="btn btn--ghost" href="${esc(a.gh.repoUrl)}" target="_blank" rel="noopener noreferrer">查看官方仓库</a>`
    : '';

  const nonOssNote = a.gh.isOpenSource === false
    ? `<p class="dl__tip">注：该软件未找到公开源码仓库，「开源」表述以官方渠道为准。</p>`
    : '';

  // 核实过程中发现的问题，如实告诉访客，不藏着
  const notices = [];
  if (a.status === 'review') {
    notices.push(`<div class="notice"><b>待确认</b><span>${esc(a.reviewReason)}</span></div>`);
  }
  if (a.flag) {
    notices.push(`<div class="notice"><b>备注</b><span>${esc(a.flag)}</span></div>`);
  }

  const dlBlock = a.link
    ? `<div class="dl">
        <div class="dl__lab">百度网盘${a.pwd ? ' · 需提取码' : ''}</div>
        <div class="dl__url">${esc(a.link)}</div>
        ${a.pwd ? `<div class="dl__pwd"><span>提取码</span><b>${esc(a.pwd)}</b><button class="btn btn--ghost btn--sm" type="button" data-copy="${esc(a.pwd)}">复制提取码</button></div>` : ''}
        <p class="dl__tip"><b>建议先转存到自己网盘</b>：转存后再下载，不怕原分享链接失效，也方便日后重装。</p>
        <p class="dl__tip">资源整理自公开渠道，仅供个人学习与研究使用。建议同时前往官方仓库获取最新版本。</p>
        ${nonOssNote}
      </div>`
    : `<div class="dl">
        <div class="dl__lab">获取方式</div>
        <p class="dl__tip">该条目暂未提供网盘地址，请前往官方仓库获取。</p>
        ${nonOssNote}
      </div>`;

  // 只挂「够格出页面」的标签，避免链到不存在的标签页
  const tagPills = (a.tags || [])
    .map(s => liveTags.find(t => t.slug === s))
    .filter(Boolean)
    .map(t => `<a class="pill" href="../tag/${t.slug}.html">${esc(t.name)}</a>`)
    .join('');

  // 联盟导购位：仅「可自建服务」标签的软件展示，放详情页顶部明显处
  const affBlock = (isSelfHosted && AFFILIATES.length)
    ? `<section class="aff-detail">${AFFILIATES.map(p => affiliateCardHTML(p, depth, a.slug)).join('\n  ')}</section>`
    : '';

  const body = `${headerHTML(depth, a.cat)}
<main class="wrap" id="main">
  <nav class="crumb" aria-label="面包屑">
    <a href="../index.html">全部资源</a><span>/</span>
    <a href="../category/${a.cat}.html">${esc(a.catName)}</a><span>/</span>
    <span>${esc(a.name)}</span>
  </nav>

  <header class="page-hd" data-tone="${a.tone}">
    ${iconHTML(a, 'ico page-hd__ico', 64).replace('__R__', R)}
    <div class="page-hd__main">
      <h1>${esc(a.name)}${a.link ? ' 下载' : ''}</h1>
      <p class="page-hd__tl">${esc(a.tagline)}</p>
      <div class="page-hd__acts">
        ${a.link ? `<a class="btn btn--accent" id="dGet" href="${esc(panOpenUrl(a.link, a.pwd))}" target="_blank" rel="noopener noreferrer" data-url="${esc(a.link)}"${a.pwd ? ` data-pwd="${esc(a.pwd)}"` : ''}>${a.pwd ? '打开网盘并填入提取码' : '打开网盘下载'}${ARROW}</a>` : ''}
        ${repoBtn}
      </div>
    </div>
  </header>

  <div class="meta">${metaCells.join('')}</div>
${affBlock}
${tagPills ? `  <div class="pills" aria-label="标签">${tagPills}</div>\n` : ''}${notices.length ? '  ' + notices.join('\n  ') + '\n' : ''}
  <div class="prose">
    <section class="blk"><h2>关于这款软件</h2><p>${esc(a.desc)}</p></section>
    <section class="blk"><h2>功能特点</h2>${featureBlock(a.features)}</section>

    <section class="blk">
      <h2>下载 / 获取方式</h2>
      ${dlBlock}
    </section>

    ${rel.length ? `<section class="rel">
      <h2>同类软件</h2>
      <div class="rel__grid">
        ${rel.map(x => `<a class="rel__i" href="${x.slug}.html" data-tone="${x.tone}">${iconHTML(x, 'ico', 32).replace('__R__', R)}<span><b>${esc(x.name)}</b><small>${esc(x.tagline)}</small></span></a>`).join('\n        ')}
      </div>
    </section>` : ''}
  </div>
</main>
${footerHTML(depth)}`;

  const descParts = [
    a.tagline,
    `${a.name} 开源免费${a.link ? '，本站提供官方仓库地址与百度网盘获取方式，提取码可一键复制' : ''}`,
    a.gh.platform ? `支持 ${a.gh.platform} 平台` : '',
  ].filter(Boolean);
  const descRaw = descParts.join('。');
  const desc = descRaw.length > 150 ? descRaw.slice(0, 148) + '…' : descRaw;

  return page({
    depth,
    active: a.cat,
    title: `${a.name}${a.link ? '下载' : ''} - ${a.tagline} | ${SITE.suffix}`,
    desc,
    canonical: `${SITE.url}/apps/${a.slug}`,
    body,
    jsonld: [
      {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: a.name,
        description: desc,
        applicationCategory: a.catName,
        operatingSystem: a.gh.platform || 'Android',
        ...(a.gh.repoUrl ? { codeRepository: a.gh.repoUrl } : {}),
        ...(a.gh.license ? { license: a.gh.license } : {}),
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'CNY' },
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '全部资源', item: SITE.url + '/' },
          { '@type': 'ListItem', position: 2, name: a.catName, item: `${SITE.url}/category/${a.cat}` },
          { '@type': 'ListItem', position: 3, name: a.name, item: `${SITE.url}/apps/${a.slug}` },
        ],
      },
    ],
  });
}

/* ---------- 8.0 电脑软件频道页 /desktop/ ----------
   为什么单独开一页而不是只留标签页：标签页是「归类依据」导向的窄入口，
   频道页是导航级入口（首页频道卡与主导航都指向它），两者职责不同 ——
   技能库当初也是「技能库 + 技能详情」而不是靠一个标签页承担导航。

   判据（platform 字段提到 Windows/macOS/Linux/跨平台）在页面上写明，
   并且如实说明跨平台条目会同时出现在手机端与电脑端 —— 不装成「纯桌面专用」。 */
function buildDesktop() {
  const list = desktopApps;
  const platFacets = desktopPlatformFacets();
  /* 平台筛选条：与技能库同一套 data-facets / data-facet 机制（live/app.js 的 initSkillsFilter）。
     没有可筛的值时整条不产出 —— 空的筛选条点不动，等于一个坏按钮。
     页面下方的 #empty / #reset 也照技能库那页给上：单一维度取「或」时点 chips 基本筛不出空集
     （每个值都至少有一条），但**分享链接带着一个已经不存在的平台值**时会走到这里（值掉到 0 条
     就会从 chips 上消失），那时得有个能点的复位按钮，而不是一片空白。 */
  const facetBar = platFacets.length
    ? `  <section class="tools" id="all">
    <div class="wrap tools__in">
      <div class="chips" id="chips" role="group" aria-label="按平台筛选">
      <span class="chipset"><span class="chipset__lab">平台</span><button class="chip" type="button" data-facet="plat=*" aria-pressed="true">全部<span class="chip__n">${list.length}</span></button>${platFacets.map(v => `<button class="chip" type="button" data-facet="plat=${esc(v.value)}" aria-pressed="false">${esc(v.label)}<span class="chip__n">${v.n}</span></button>`).join('')}</span>
      </div>
      <div class="tools__meta"><b id="shown">${list.length}</b><span>条</span></div>
    </div>
  </section>`
    : '';

  const body = `${headerHTML(1, 'desktop')}
<main class="wrap" id="main">
  <nav class="crumb" aria-label="面包屑"><a href="../index.html">全部资源</a><span>/</span><span>电脑软件</span></nav>
  <section class="page-hd" style="border-bottom:0;padding-bottom:8px">
    <div class="page-hd__main">
      <p class="kicker">频道</p>
      <h1>电脑软件</h1>
      <p class="page-hd__tl">共 ${list.length} 款可在 Windows / macOS / Linux 上运行的开源软件，附官方仓库、协议与获取方式</p>
    </div>
  </section>
  <div class="prose" style="padding-block:0">
    <section class="blk" style="padding-block:18px 22px;border-bottom:0">
      <p>这一页按<strong>核实到的支持平台字段</strong>归类，不是按条目文案推断的：字段里提到 Windows / macOS / Linux / 跨平台 的条目才进来，依据写在每个条目的详情页里，可以自行复核。
      其中一部分是手机与电脑都支持的跨平台软件（例如思源笔记、Kazumi），它们会同时出现在手机端列表与这一页 —— 这是如实反映，不是重复收录。</p>
      <p>上方平台筛选的计数按<strong>核实字段里出现过的平台</strong>统计：一款软件同时支持 Windows 与 macOS 时，两个值都会算它一次，
      所以各值的条数之和大于本页条目总数。「跨平台」是核实字段里的原话，不是我们另外判的。</p>
      <p>每条都给出官方仓库、开源协议与对应平台的获取方式；下载走百度网盘转存，提取码在详情页一键复制。</p>
    </section>
  </div>
${facetBar}
  <section class="grid-sec" style="padding-top:8px">
    <h2 class="sr">电脑软件列表</h2>
    <div class="grid" id="grid">
${list.map(a => cardHTML(a, 1, desktopFacetsOf(a))).join('\n')}
    </div>
    <div class="empty" id="empty" hidden>
      <p>没有匹配这个平台条件的软件</p>
      <button class="btn btn--ghost" id="reset" type="button">清除筛选条件</button>
    </div>
    <noscript><p style="padding:40px 0;color:var(--ink-3);font-size:15px">平台筛选需要启用 JavaScript；上面已列出全部 ${list.length} 款电脑软件，可直接点击进入详情页。</noscript>
  </section>
  <section class="sec sec--tight">
    <div class="tagrow" style="border-top:0;padding-top:0">
      <span class="tagrow__lab">按分类浏览</span>
      <div class="chips">${chipsHTML(1, '')}</div>
    </div>
  </section>
</main>
${footerHTML(1)}`;

  return page({
    depth: 1,
    active: 'desktop',
    title: `电脑软件 - Windows/macOS/Linux 开源软件合集 | ${SITE.suffix}`,
    desc: `${SITE.name}整理的电脑软件共 ${list.length} 款：${list.slice(0, 12).map(a => a.name).join('、')}${list.length > 12 ? ' 等' : ''}。均可运行在 Windows/macOS/Linux，附官方仓库、开源协议与百度网盘获取方式。`,
    canonical: `${SITE.url}/desktop/`,
    body,
    jsonld: {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '全部资源', item: SITE.url + '/' },
        { '@type': 'ListItem', position: 2, name: '电脑软件', item: `${SITE.url}/desktop/` },
      ],
    },
  });
}

/* ---------- 8.1 分类页 ---------- */
function buildCategory(c) {
  const list = byCat[c.id];
  const body = `${headerHTML(1, c.id)}
<main class="wrap" id="main">
  <nav class="crumb" aria-label="面包屑"><a href="../index.html">全部资源</a><span>/</span><span>${esc(c.name)}</span></nav>
  <section class="page-hd" data-tone="${c.tone}" style="border-bottom:0;padding-bottom:10px">
    <div class="page-hd__main">
      <h1>${esc(c.name)}</h1>
      <p class="page-hd__tl">共 ${list.length} 条开源资源，均附官方仓库与获取方式</p>
    </div>
  </section>
  <div class="tools" style="top:var(--hdr-h);border-top:0">
    <div class="tools__in"><div class="chips">${chipsHTML(1, c.id)}</div></div>
  </div>
  <section class="grid-sec">
    <div class="grid">
${list.map(a => cardHTML(a, 1)).join('\n')}
    </div>
  </section>
</main>
${footerHTML(1)}`;

  return page({
    depth: 1,
    active: c.id,
    title: `${c.name}开源软件合集 - 免费下载 | ${SITE.suffix}`,
    desc: `${SITE.name}整理的${c.name}类开源软件共 ${list.length} 款：${list.map(a => a.name).join('、')}。全部免费开源、附官方仓库与百度网盘获取方式。`,
    canonical: `${SITE.url}/category/${c.id}`,
    body,
    jsonld: {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '全部资源', item: SITE.url + '/' },
        { '@type': 'ListItem', position: 2, name: c.name, item: `${SITE.url}/category/${c.id}` },
      ],
    },
  });
}

/* ---------- 8.5 标签页 / 专题合集页 ---------- */

/** 标签页的导语必须跟着「归类依据」走：文本归类和核实字段归类不能共用一句话 */
const tagIntro = t => t.kw
  ? `这个标签不是我们自己打的分，而是按条目官方介绍里的说法归类：下面是介绍中确实提到相关表述的 ${t.items.length} 款开源软件。谁进了这份名单，依据都在各自的详情页里，可以自行复核。`
  : `这个标签来自核实到的字段（开源协议或支持平台），不是靠条目文案推断的：下面是核实结果属于这一类的 ${t.items.length} 款开源软件。字段是核实当时的快照，请以各条目的官方仓库为准。`;

function buildTag(t) {
  const body = `${headerHTML(1, '')}
<main class="wrap" id="main">
  <nav class="crumb" aria-label="面包屑"><a href="../index.html">全部资源</a><span>/</span><span>标签</span><span>/</span><span>${esc(t.name)}</span></nav>
  <section class="page-hd" style="border-bottom:0;padding-bottom:8px">
    <div class="page-hd__main">
      <p class="kicker">标签</p>
      <h1>${esc(t.name)}</h1>
      <p class="page-hd__tl">共 ${t.items.length} 条 · 收录依据：${esc(t.basis)}</p>
    </div>
  </section>
  <div class="prose" style="padding-block:0">
    <section class="blk" style="padding-block:20px 24px;border-bottom:0">
      <p>${esc(tagIntro(t))}</p>
    </section>
  </div>
  <section class="grid-sec" style="padding-top:8px">
    <div class="grid">
${t.items.map(a => cardHTML(a, 1)).join('\n')}
    </div>
  </section>
  <section class="sec sec--tight">
    <div class="tagrow" style="border-top:0;padding-top:0">
      <span class="tagrow__lab">其他标签</span>
      <div class="chips">
${liveTags.filter(x => x.slug !== t.slug).map(x => `        <a class="chip" href="${x.slug}.html">${esc(x.name)}<span class="chip__n">${x.items.length}</span></a>`).join('\n')}
      </div>
    </div>
  </section>
</main>
${footerHTML(1)}`;

  return page({
    depth: 1,
    active: 'tag:' + t.slug,
    title: `${t.name}的开源软件有哪些（共 ${t.items.length} 款）| ${SITE.suffix}`,
    desc: `${t.name}相关的开源软件共 ${t.items.length} 款：${t.items.map(a => a.name).join('、')}。收录依据：${t.basis}，每条都附官方仓库与获取方式。`,
    canonical: `${SITE.url}/tag/${t.slug}`,
    body,
    jsonld: {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '全部资源', item: SITE.url + '/' },
        { '@type': 'ListItem', position: 2, name: t.name, item: `${SITE.url}/tag/${t.slug}` },
      ],
    },
  });
}

function buildTopic(tp) {
  const body = `${headerHTML(1, '')}
<main class="wrap" id="main">
  <nav class="crumb" aria-label="面包屑"><a href="../index.html">全部资源</a><span>/</span><span>专题合集</span><span>/</span><span>${esc(tp.title)}</span></nav>
  <section class="page-hd" data-tone="${esc(tp.tone || 'slate')}" style="border-bottom:0;padding-bottom:8px">
    <div class="page-hd__main">
      <p class="kicker">专题合集</p>
      <h1>${esc(tp.title)}</h1>
      <p class="page-hd__tl">${esc(tp.sub || '')} · 共收录 ${tp.members.length} 条</p>
    </div>
  </section>
  <div class="prose" style="padding-block:0">
    <section class="blk" style="padding-block:20px 24px;border-bottom:0">
      ${(tp.intro || []).map(p => `<p>${esc(p)}</p>`).join('\n      ')}
      <p>清单里的每一条都能单独打开详情页，看到功能介绍、官方仓库地址与获取方式。顺序按使用场景排，不代表推荐程度。</p>
    </section>
  </div>
  <section class="grid-sec" style="padding-top:8px">
    <div class="grid">
${tp.members.map(a => cardHTML(a, 1)).join('\n')}
    </div>
  </section>
</main>
${footerHTML(1)}`;

  const desc = `${tp.sub || tp.title}。${SITE.name}整理的《${tp.title}》共 ${tp.members.length} 条：${tp.members.map(a => a.name).join('、')}。每条都附官方仓库与获取方式。`;
  return page({
    depth: 1,
    active: 'topic:' + tp.slug,
    title: `${tp.title}（${tp.members.length} 款开源软件）| ${SITE.suffix}`,
    desc: desc.length > 150 ? desc.slice(0, 148) + '…' : desc,
    canonical: `${SITE.url}/topic/${tp.slug}`,
    body,
    jsonld: [
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: tp.title,
        description: tp.sub || '',
        numberOfItems: tp.members.length,
        itemListElement: tp.members.map((a, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: a.name,
          url: `${SITE.url}/apps/${a.slug}`,
        })),
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '全部资源', item: SITE.url + '/' },
          { '@type': 'ListItem', position: 2, name: tp.title, item: `${SITE.url}/topic/${tp.slug}` },
        ],
      },
    ],
  });
}

/* ---------- 8.7 技能：卡片 / 详情页 / 技能库首页 ----------
   注意链接层级：技能页都在 /skills/ 下（depth=1），所以页面之间互链用同目录相对路径，
   只有从首页（depth=0）过来才写 skills/xxx.html。这也是为什么技能不会出现在
   tag/topic 这类 depth=1 的其他目录页里 —— 那会把相对路径算错。 */
/** 技能卡片的可筛选属性 + 维度定义。
    维度不是写死的：只为「真的有两种以上取值」的维度产出筛选项 ——
    现在 40 条里宿主只有一种，硬做宿主筛选就是噪音；等 Gemini CLI 那批进来它会自动出现。 */
const repoLabel = repo => (/^anthropics\//i.test(repo) ? 'Anthropic 官方' : repo.split('/')[0]);
const skillModeOf = s => (s.link && s.linkMode !== 'intro') ? 'package' : 'intro';
const MODE_LABEL = { package: '有网盘包', intro: '官方获取' };
const skillFacetsOf = s => `repo=${s.source.repo};host=${hostShort(s)};mode=${skillModeOf(s)}`;

function skillFacetGroups() {
  const count = (fn, label = x => x) => {
    const m = new Map();
    for (const s of skills) { const k = fn(s); m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n, label: label(value) }));
  };
  const groups = [];
  const repos = count(s => s.source.repo, repoLabel);
  if (repos.length > 1) groups.push({ key: 'repo', label: '来源', values: repos });
  const hosts = count(hostShort);
  if (hosts.length > 1) groups.push({ key: 'host', label: '宿主', values: hosts });
  const modes = count(skillModeOf, v => MODE_LABEL[v] || v);
  if (modes.length > 1) groups.push({ key: 'mode', label: '获取方式', values: modes });
  return groups;
}

function skillFacetsHTML() {
  return skillFacetGroups().map(g => `<span class="chipset"><span class="chipset__lab">${esc(g.label)}</span>` +
    `<button class="chip" type="button" data-facet="${esc(g.key)}=*" aria-pressed="true">全部<span class="chip__n">${skills.length}</span></button>` +
    g.values.map(v => `<button class="chip" type="button" data-facet="${esc(g.key)}=${esc(v.value)}" aria-pressed="false">${esc(v.label)}<span class="chip__n">${v.n}</span></button>`).join('') +
    '</span>').join('\n      ');
}

function skillCardHTML(s, depth) {
  const href = depth === 0 ? `skills/${s.slug}.html` : `${s.slug}.html`;
  const hay = [s.nameZh, s.name, s.tagline, s.desc, s.source && s.source.repo]
    .join(' ').toLowerCase().replace(/"/g, '');
  const ico = `<span class="ico" data-tone="plum" style="--tone:var(--tone-plum);--tint:var(--tint-plum)" aria-hidden="true">${esc(initial(s.nameZh || s.name))}</span>`;
  const owned = skillModeOf(s) === 'package'
    ? '<span class="badge badge--accent">有网盘包</span>' : '';
  return `<a class="card" href="${href}" data-hay="${esc(hay)}" data-facets="${esc(skillFacetsOf(s))}" data-tone="plum">
  <span class="card__top">${ico}<span class="card__name">${esc(s.nameZh)}</span></span>
  <span class="card__tl">${esc(s.tagline)}</span>
  <span class="card__bot"><span class="tag">${esc(hostShort(s))}</span>${owned}<span class="card__go">查看${ARROW}</span></span>
</a>`;
}

function buildSkillDetail(s) {
  const depth = 1;
  const src = s.source || {};
  const files = s.files || [];
  const bytes = (s.pack && s.pack.dirBytes) || files.reduce((n, f) => n + f.bytes, 0);

  const cell = (k, v) => `<div class="meta__cell"><div class="meta__k">${k}</div><div class="meta__v">${v}</div></div>`;
  const cells = [cell('适用宿主', esc(src.hostGuess || '未确认'))];
  if (src.repo) cells.push(cell('来源仓库', `<a href="${esc(src.repoUrl)}" target="_blank" rel="noopener noreferrer">${esc(src.repo)}</a>`));
  if (src.commit) cells.push(cell('固定版本', `<span class="nowrap">${esc(String(src.commit).slice(0, 10))}</span>`));
  if (src.commitDate) cells.push(cell('版本日期', esc(src.commitDate)));
  if (src.license) cells.push(cell('开源协议', esc(src.license)));
  if (src.stars) cells.push(cell('Star', Number(src.stars).toLocaleString('en-US')));
  cells.push(cell('内容体积', `${files.length} 个文件 · ${Math.round(bytes / 1024)} KB`));

  const repoBtn = src.treeUrl
    ? `<a class="btn btn--ghost" href="${esc(src.treeUrl)}" target="_blank" rel="noopener noreferrer">查看官方目录</a>` : '';
  const hasPack = s.linkMode !== 'intro' && s.link;
  const getBtn = hasPack
    ? `<a class="btn btn--accent" id="dGet" href="${esc(panOpenUrl(s.link, s.pwd))}" target="_blank" rel="noopener noreferrer" data-url="${esc(s.link)}"${s.pwd ? ` data-pwd="${esc(s.pwd)}"` : ''}>${s.pwd ? '打开网盘并填入提取码' : '打开网盘下载'}${ARROW}</a>`
    : repoBtn;

  const dlBlock = hasPack
    ? `<div class="dl">
        <div class="dl__lab">百度网盘${s.pwd ? ' · 需提取码' : ''}</div>
        <div class="dl__url">${esc(s.link)}</div>
        ${s.pwd ? `<div class="dl__pwd"><span>提取码</span><b>${esc(s.pwd)}</b><button class="btn btn--ghost btn--sm" type="button" data-copy="${esc(s.pwd)}">复制提取码</button></div>` : ''}
        <p class="dl__tip"><b>建议先转存到自己网盘</b>：转存后再下载，不怕原分享链接失效。</p>
        <p class="dl__tip">本包内附 README.txt，写明来源仓库、固定 commit、开源协议与每个文件的 sha256，可自行校验。</p>
      </div>`
    : `<div class="dl">
        <div class="dl__lab">获取方式</div>
        <p class="dl__tip">这个技能本站暂未提供网盘包，请前往官方仓库目录获取：</p>
        <div class="dl__url">${esc(src.treeUrl || src.repoUrl || '')}</div>
        <p class="dl__tip">之所以不放网盘包，可能是授权状态未确认，或者还没来得及整理。本页的中文介绍与信息整理仍然有效。</p>
      </div>`;

  const rel = skills.filter(x => x.slug !== s.slug && x.source && x.source.repo === src.repo).slice(0, 6);
  const relAny = rel.length ? rel : skills.filter(x => x.slug !== s.slug).slice(0, 6);

  const body = `${headerHTML(depth, 'skills')}
<main class="wrap" id="main">
  <nav class="crumb" aria-label="面包屑">
    <a href="../index.html">全部资源</a><span>/</span>
    <a href="index.html">技能库</a><span>/</span>
    <span>${esc(s.nameZh)}</span>
  </nav>

  <header class="page-hd" data-tone="plum">
    <div class="page-hd__main">
      <p class="kicker">技能</p>
      <h1>${esc(s.nameZh)}</h1>
      <p class="page-hd__tl">${esc(s.tagline)}</p>
      <p class="meta__k" style="margin-top:8px">${esc(s.name || s.slug)}</p>
      <div class="page-hd__acts">${getBtn}${hasPack ? repoBtn : ''}</div>
    </div>
  </header>

  <div class="meta">${cells.join('')}</div>
  ${s.hostNote ? `<div class="notice"><b>宿主</b><span>${esc(s.hostNote)}</span></div>` : ''}
  <div class="prose">
    <section class="blk"><h2>这个技能做什么</h2><p>${esc(s.desc)}</p></section>
    ${(s.features || []).length ? `<section class="blk"><h2>包含什么</h2><ul>${s.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul></section>` : ''}
    ${(s.install || []).length ? `<section class="blk"><h2>怎么用</h2><ul>${s.install.map(t => `<li>${esc(t)}</li>`).join('')}</ul></section>` : ''}
    <section class="blk"><h2>获取方式</h2>${dlBlock}</section>
    ${files.length ? `<section class="blk"><h2>目录内容（${files.length} 个文件）</h2>
      <ul class="filelist">${files.map(f => `<li><code>${esc(f.path)}</code><span>${Math.max(1, Math.round(f.bytes / 1024))} KB</span></li>`).join('')}</ul>
    </section>` : ''}
    ${relAny.length ? `<section class="rel">
      <h2>同源技能</h2>
      <div class="grid">${relAny.map(x => skillCardHTML(x, 1)).join('\n')}</div>
    </section>` : ''}
  </div>
</main>
${footerHTML(depth)}`;

  const descRaw = [s.tagline, s.desc].filter(Boolean).join('。');
  return page({
    depth,
    active: 'skills',
    title: `${s.nameZh} - ${s.tagline} | ${SITE.suffix}`,
    desc: descRaw.length > 150 ? descRaw.slice(0, 148) + '…' : descRaw,
    canonical: `${SITE.url}/skills/${s.slug}`,
    body,
    jsonld: [
      {
        '@context': 'https://schema.org',
        '@type': 'SoftwareSourceCode',
        name: s.nameZh,
        alternateName: s.name,
        description: descRaw,
        ...(src.license ? { license: src.license } : {}),
        ...(src.repoUrl ? { codeRepository: src.repoUrl } : {}),
        ...(src.commit ? { version: String(src.commit).slice(0, 10) } : {}),
        inLanguage: 'zh-CN',
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '全部资源', item: SITE.url + '/' },
          { '@type': 'ListItem', position: 2, name: '技能库', item: `${SITE.url}/skills/` },
          { '@type': 'ListItem', position: 3, name: s.nameZh, item: `${SITE.url}/skills/${s.slug}` },
        ],
      },
    ],
  });
}

function buildSkillsIndex() {
  const hosts = [...new Set(skills.map(s => s.source && s.source.hostGuess).filter(Boolean))];
  const repos = [...new Set(skills.map(s => s.source && s.source.repo).filter(Boolean))];
  const packable = skills.filter(s => s.linkMode !== 'intro' && s.link);

  const body = `${headerHTML(1, 'skills')}
<main class="wrap" id="main">
  <nav class="crumb" aria-label="面包屑"><a href="../index.html">全部资源</a><span>/</span><span>技能库</span></nav>
  <section class="page-hd" style="border-bottom:0;padding-bottom:10px">
    <div class="page-hd__main">
      <p class="kicker">技能库</p>
      <h1>开源 AI 技能与 MCP 服务</h1>
      <p class="page-hd__tl">共 ${skills.length} 个技能，来自 ${repos.length} 个官方仓库，每个都固定到具体 commit</p>
    </div>
  </section>
  <div class="prose" style="padding-block:0">
    <section class="blk" style="padding-block:18px 24px;border-bottom:0">
      <p>技能（Skill）是给 AI 编程助手看的一份说明加一组脚本：把它放到宿主的技能目录里，助手在遇到相关任务时会自己加载它。本站收录的都是<strong>官方仓库里的原始技能</strong>，不是二手转抄 —— 每个条目都记着来源仓库、目录路径、固定 commit 与开源协议，可以逐项复核。</p>
      <p>本站的作用是把它们翻成中文：说清楚这个技能解决什么问题、包含哪些文件、装到哪个目录、需要什么环境。技能本身能直接用，不需要我跟你要任何东西。</p>
    </section>
  </div>
  <section class="tools" id="all">
    <div class="wrap tools__in">
      <div class="chips" id="chips">
      ${skillFacetsHTML()}
      </div>
      <div class="tools__meta"><b id="shown">${skills.length}</b><span>条</span></div>
      <div class="search">
        <svg class="search__ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="q" type="search" placeholder="搜索技能名或用途…" aria-label="搜索技能" autocomplete="off">
        <button class="search__clr" id="clr" type="button" aria-label="清除搜索"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        <kbd>/</kbd>
      </div>
    </div>
  </section>
  <section class="grid-sec" style="padding-top:22px">
    <h2 class="sr">技能列表</h2>
    <div class="grid" id="grid">
${skills.map(s => skillCardHTML(s, 1)).join('\n')}
    </div>
    <div class="empty" id="empty" hidden>
      <p>没有匹配的技能</p>
      <button class="btn btn--ghost" id="reset" type="button">清除筛选条件</button>
    </div>
    <noscript><p style="padding:40px 0;color:var(--ink-3);font-size:15px">筛选与搜索需要启用 JavaScript；上方已列出全部 ${skills.length} 个技能，可直接点击进入详情页。</noscript>
  </section>
  <section class="sec">
    <div class="sec-hd"><h2>关于收录标准</h2></div>
    <div class="promises">
      <div class="promise"><b>只收原始来源</b><p>从官方仓库的 SKILL.md 目录收，聚合仓库里转抄的副本不收</p></div>
      <div class="promise"><b>按目录判授权</b><p>协议看技能目录内的 LICENSE，不是看仓库级字段 —— 有的官方库仓库级字段是空的</p></div>
      <div class="promise"><b>非开源协议不收</b><p>实测拦下 160 条：fair-code（限制商用）、NC 条款、保留所有权利都不进站</p></div>
      <div class="promise"><b>版本固定</b><p>每条都记录 commit SHA，内容不会因为作者改了分支而悄悄变样</p></div>
    </div>
    <p class="muted" style="margin-top:14px;font-size:13px">已确认宿主：${hosts.map(esc).join(' · ') || '—'}。宿主是按目录路径推断的，未经逐条实测，用前请对照宿主文档。</p>
  </section>
</main>
${footerHTML(1)}`;

  return page({
    depth: 1,
    active: 'skills',
    title: `技能库 - ${skills.length} 个开源 AI 技能与 MCP 服务 | ${SITE.suffix}`,
    desc: `收录 ${skills.length} 个开源 AI 技能与 MCP 服务，均来自官方仓库原始目录：中文介绍、包含文件、安装方法、适用宿主与开源协议，每条固定到具体 commit 可复核。`,
    canonical: `${SITE.url}/skills/`,
    body,
    jsonld: [
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: '开源 AI 技能与 MCP 服务',
        numberOfItems: skills.length,
        itemListElement: skills.map((s, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: s.nameZh,
          url: `${SITE.url}/skills/${s.slug}`,
        })),
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '全部资源', item: SITE.url + '/' },
          { '@type': 'ListItem', position: 2, name: '技能库', item: `${SITE.url}/skills/` },
        ],
      },
    ],
  });
}

/* ---------- 8.7c AI 工具库 /ai/ ----------
   这一类与前几类最大的不同：**没有网盘交付物**。AI 工具多半是在线服务，
   没有安装包可转存，所以页面价值不在「给你文件」，而在：
     ① 中文说明白它是什么、能做什么
     ② 把官网、定价页、是否开源这类事实钉住，省掉用户逐个去查
     ③ 把「国内要不要梯子」「有没有中文」这两个最难查、最影响决策的点标出来

   这三件事合起来才是「信息差」。如果只是把工具的官网链接堆成一页，
   那对用户没有价值，对搜索引擎就是采集内容 —— 这也是为什么条目的中文介绍
   必须自己写，而不是从别的工具目录站搬。 */

/** 免费额度形态的显示文案。枚举值在这三个之外的一律不显示，
    宁可空着也不编一个看起来专业的说法。 */
const TOOL_FREE = {
  free: '完全免费',
  freemium: '免费额度 + 付费',
  paid: '需付费',
  trial: '仅试用',
};
const TOOL_FREE_TONE = { free: 'sage', freemium: 'amber', paid: 'slate', trial: 'slate' };

/** 工具卡片的相对路径。
    四种层级各算各的，别用一个深度公式套（实测漏过一档，80 张卡片全部死链）：
      · depth 0 → 首页                → ai/<slug>.html
      · depth 1 → /ai/ 或 /ai/<slug>   → <slug>.html
      · depth 2 → /ai/<cat>/           → ../<slug>.html
      · depth 3 → /ai/<cat>/<sub>/     → ../../<slug>.html */
function toolHref(slug, depth) {
  return depth === 0 ? `ai/${slug}.html` : depth === 1 ? `${slug}.html` : depth === 2 ? `../${slug}.html` : `../../${slug}.html`;
}

/** 工具卡片。筛选用 data-facets（分类/是否开源/是否需梯子/免费形态），
    与技能库共用 initSkillsFilter 那套多维度筛选 —— 同一件事不写两份筛选器。
    groupByCat 只在 AI 库首页开：那一页的筛选里有「分类」维度，
    分类页自己就是分类维度的结果，再挂一遍 data-cat 就是重复。 */
function toolCardHTML(t, depth, groupByCat = false) {
  const c = toolCatById[t.cat] || { name: 'AI 工具', tone: 'slate' };
  const href = toolHref(t.slug, depth);
  const hay = [t.nameZh, t.name, t.vendor, t.tagline, t.desc, c.name]
    .filter(Boolean).join(' ').toLowerCase().replace(/"/g, '');
  const facets = `cat=${t.cat};oss=${t.opensource ? 'yes' : 'no'};vpn=${t.needsVpn ? 'yes' : 'no'};free=${t.freeTier || 'unknown'}`;
  const ico = `<span class="ico" data-tone="${esc(c.tone || 'slate')}" aria-hidden="true">${esc(initial(t.nameZh || t.name))}</span>`;
  const flags = [];
  if (t.opensource) flags.push('<span class="badge badge--accent">开源</span>');
  // 「国内直连」是这一类最有价值的一个标签，所以它用肯定式表达
  flags.push(t.needsVpn
    ? '<span class="badge">需代理</span>'
    : '<span class="badge">国内直连</span>');
  return `<a class="card" href="${href}"${groupByCat ? ` data-cat="${esc(t.cat)}"` : ''} data-facets="${esc(facets)}" data-hay="${esc(hay)}" data-tone="${esc(c.tone || 'slate')}">
  <span class="card__top">${ico}<span class="card__name">${esc(t.nameZh || t.name)}</span></span>
  <span class="card__tl">${esc(t.tagline)}</span>
  <span class="card__bot"><span class="tag">${esc(c.name)}</span>${flags.join('')}<span class="card__go">查看${ARROW}</span></span>
</a>`;
}

/** AI 库顶部筛选条：**只保留分类**这一个维度。
    用户要求去掉「源码 / 访问 / 费用」三组 —— 理由也站得住：
    页面上已经按分类分区堆叠、每区还带子类标签，顶部再放四个维度属于重复筛选；
    而「源码 / 访问 / 费用」这些属性在卡片上已经用徽标标出来了（开源 / 国内直连 / 需代理），
    要按这些挑，扫一眼卡片比在一排 chip 里点更直接。
    分类组做成**链接**（进各分类页），不是按钮 —— 可索引、可分享、能直接跳转。 */
function toolFacetHTML() {
  const cats = liveToolCats
    .map(c => ({ id: c.id, n: toolsByCat[c.id].length, name: c.name }))
    .sort((a, b) => b.n - a.n);
  if (cats.length < 2) return '';
  // 「全部」锚到本页的工具列表（列表就在同一页，不需要跳别处）
  const all = `<a class="chip" href="#all" aria-pressed="true">全部<span class="chip__n">${toolsOk.length}</span></a>`;
  return `<span class="chipset"><span class="chipset__lab">分类</span>${all}` +
    cats.map(c => `<a class="chip" href="category/${c.id}.html">${esc(c.name)}<span class="chip__n">${c.n}</span></a>`).join('') +
    '</span>';
}

/** 分类区块里的子类筛选标签行。
    覆盖该分类下的**全部**子类（含不够门槛、不产出页面的），因为作为筛选器它们依然有用：
    门槛管的是「要不要单独做一页」，不是「这个概念值不值得筛」。
    有独立页面的渲染成链接（可索引、可分享、可收藏），没有的渲染成按钮（走前端筛选）。 */
function subcatChipsHTML(cat, depth) {
  const defs = subsByCat[cat] || [];
  if (defs.length < 2) return '';
  const r = up(depth);
  const total = toolsByCat[cat].length;
  const parts = [`<a class="chip" href="${r}ai/category/${cat}.html" aria-pressed="true">全部<span class="chip__n">${total}</span></a>`];
  for (const d of defs) {
    parts.push(d.live
      ? `<a class="chip" href="${r}ai/category/${cat}/${d.slug}.html">${esc(d.name)}<span class="chip__n">${d.members.length}</span></a>`
      : `<button class="chip" type="button" data-facet="sub=${esc(d.slug)}" aria-pressed="false">${esc(d.name)}<span class="chip__n">${d.members.length}</span></button>`);
  }
  return `<div class="chipset chipset--sub"><span class="chipset__lab">按功能</span>${parts.join('')}</div>`;
}

/** 目录页里的一个分类区块：标题 + 子类标签 + 卡片网格。
    这是参考站的核心排布方式（分区堆叠），也是这次改版的主要内容 ——
    原来是一个筛选条 + 一个大网格，16 个分类混在一起，根本看不出结构。 */
function toolSectionHTML(c, depth) {
  const list = toolsByCat[c.id];
  if (!list.length) return '';
  return `<section class="sec sec--tight ai-sec" id="cat-${esc(c.id)}">
  <div class="sec-hd">
    <h2>${esc(c.name)}</h2>
    <p>${esc(c.desc || '')} · 共 ${list.length} 款</p>
    <a class="sec-hd__link" href="${up(depth)}ai/category/${c.id}.html">全部 ${list.length} 款${ARROW}</a>
  </div>
  <!-- 子类筛选行已按要求去掉（2026-10-03）：原有的「按分类浏览」区块已经承担了导航，
       两排标签重复，反而把页面撑长。subcatChipsHTML() 暂时没有调用方，保留以备复用。
       注意：注释里不要再写那三个字，否则会污染对产物 HTML 的 grep 校验。 -->
  <div class="grid">
${list.slice(0, 9).map(t => toolCardHTML(t, depth)).join('\n')}
  </div>
</section>`;
}

function buildToolsIndex() {
  const ossCount = toolsOk.filter(t => t.opensource).length;
  const directCount = toolsOk.filter(t => !t.needsVpn).length;
  const zhCount = toolsOk.filter(t => t.zhSupport).length;
  const freeCount = toolsOk.filter(t => t.freeTier === 'free' || t.freeTier === 'freemium').length;
  const vendorCount = new Set(toolsOk.map(t => t.vendor).filter(Boolean)).size;

  const body = `${headerHTML(1, 'ai')}
<main class="wrap" id="main">
  <nav class="crumb" aria-label="面包屑"><a href="../index.html">全部资源</a><span>/</span><span>AI 库</span></nav>
  <section class="page-hd" style="border-bottom:0;padding-bottom:10px">
    <div class="page-hd__main">
      <p class="kicker">AI 库</p>
      <h1>AI 工具库</h1>
      <p class="page-hd__tl">共收录 ${toolsOk.length} 款 AI 工具，覆盖 ${liveToolCats.length} 个分类，每条都标出官网、是否开源、免费额度与国内访问情况</p>
    </div>
  </section>
  <div class="prose" style="padding-block:0">
    <section class="blk" style="padding-block:18px 24px;border-bottom:0">
      <p>收录标准只有一条：<strong>官网能打开、服务在运营、信息能核实</strong>。每条的中文介绍由本站自己撰写，功能要点以官方说明为准；查不到的字段留空，不编。</p>
      <p>这一类里有 ${directCount} 款在国内可以直连、${zhCount} 款原生支持中文输入输出，其中 ${freeCount} 款提供免费或免费额度 —— 这三项是逐条核实后标注的，因为它们直接决定你能不能真的用上。
      带「需代理」标记的意思是：从中国大陆访问通常需要自备网络条件，本站只做如实标注，不提供任何访问方式。</p>
      <p>另外 ${ossCount} 款是开源项目（附源码仓库），${vendorCount} 款来自不同开发方；同一家厂商的产品不会因为数量多就被优待，排序只按分类分组，不做推荐位。</p>
    </section>
  </div>
  <section class="sec sec--tight" id="toc">
    <div class="sec-hd"><h2>按分类浏览</h2><p>共 ${liveToolCats.length} 个分类；点分类可进入该分类页，再按功能子类细分。</p></div>
    <div class="chips">
${liveToolCats.map(c => `      <a class="chip" href="#cat-${esc(c.id)}">${esc(c.name)}<span class="chip__n">${toolsByCat[c.id].length}</span></a>`).join('\n')}
    </div>
  </section>

  <div id="grid">
    <h2 class="sr">AI 工具列表</h2>
${liveToolCats.map(c => toolSectionHTML(c, 1)).join('\n')}
    <div class="empty" id="empty" hidden>
      <p>没有匹配的工具</p>
      <button class="btn btn--ghost" id="reset" type="button">清除筛选条件</button>
    </div>
  </div>
  <noscript><p style="padding:0 0 40px;color:var(--ink-3);font-size:15px">筛选与搜索需要启用 JavaScript；上方已按分类列出全部 ${toolsOk.length} 款工具，可直接点击进入详情页。</noscript>

  <section class="sec">
    <div class="sec-hd"><h2>关于收录标准</h2></div>
    <div class="promises">
      <div class="promise"><b>文案自己写</b><p>中文介绍与功能要点由本站撰写，不搬运其他工具目录站的文字 —— 采集内容会被搜索引擎判重降权</p></div>
      <div class="promise"><b>事实钉在官网</b><p>官网、定价页、是否开源都可点进官方页面复核，不写「据说」「听说」</p></div>
      <div class="promise"><b>访问情况如实标</b><p>「国内直连 / 需代理」逐条核实标注，不为了好看一律标成能直连</p></div>
      <div class="promise"><b>查不到就留空</b><p>免费额度、中文支持这类字段拿不到准确值就留空，用官方定价页链接代替猜测</p></div>
    </div>
    <p class="muted" style="margin-top:14px;font-size:13px">本站与上述工具均无合作关系，收录不代表推荐，也不收取任何形式的收录费用。工具的功能、价格与服务条款以各自官网为准。</p>
  </section>
</main>
${footerHTML(1)}`;

  return page({
    depth: 1,
    active: 'ai',
    title: `AI 工具库 - ${toolsOk.length} 款 AI 工具清单（含免费额度与国内访问说明）| ${SITE.suffix}`,    desc: `${SITE.name}整理的 AI 工具库共 ${toolsOk.length} 款，覆盖${liveToolCats.map(c => c.name).join('、')}。每条都标明官网、是否开源、免费额度形态、国内能否直连与中文支持，中文介绍为本站原创撰写。`,
    canonical: `${SITE.url}/ai/`,
    body,
    jsonld: [
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: 'AI 工具库',
        description: `${toolsOk.length} 款可核实的 AI 工具清单，标注官网、免费额度与国内访问情况。`,
        url: `${SITE.url}/ai/`,
        inLanguage: 'zh-CN',
      },
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: 'AI 工具库',
        numberOfItems: toolsOk.length,
        itemListElement: toolsOk.map((t, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: t.nameZh || t.name,
          url: `${SITE.url}/ai/${t.slug}`,
        })),
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '全部资源', item: SITE.url + '/' },
          { '@type': 'ListItem', position: 2, name: 'AI 库', item: `${SITE.url}/ai/` },
        ],
      },
    ],
  });
}

/** 分类页上的「功能子类」区块：有独立页面的给链接，没有的给筛选按钮。
    门槛只决定「要不要单独做一页」，不决定「这个概念值不值得筛」——
    所以不够门槛的子类在这里照常出现，只是不再是链接。 */
function subcatBlockHTML(cat, depth) {
  const defs = subsByCat[cat] || [];
  if (defs.length < 2) return '';
  const r = up(depth);
  const cards = defs.map(d => {
    const inner = `
      <span class="chan__hd"><span class="chan__name">${esc(d.name)}</span><span class="chan__en">${d.members.length} 款</span></span>
      <span class="chan__desc">${esc(d.desc || '')}</span>
      <span class="chan__foot">${d.live ? `<span class="chan__n">查看这一子类</span>` : `<span class="badge">筛选</span><span>· 条目较少，不单独成页</span>`}</span>`;
    // 子类页在 /ai/category/<父类>/<子类>.html —— 比本页（/ai/category/<父类>.html）深一层，
    // 所以要带上父类那一段。写成 `<sub>.html` 会链到 /ai/category/<sub>.html（不存在）——
    // 实测 22 个分类页全部死链，一次被 check-dist 报出来。
    return d.live
      ? `      <a class="chan" href="${cat}/${d.slug}.html">${inner}\n      </a>`
      : `      <div class="chan" data-status="soon">${inner}\n      </div>`;
  }).join('\n');
  return `  <section class="sec sec--tight">
    <div class="sec-hd"><h2>按功能细分</h2><p>子类是按「这个工具主要用来做什么」划的，同一个工具可能同时出现在两个子类里。</p></div>
    <div class="channels">
${cards}
    </div>
  </section>`;
}

/** 功能子类页 /ai/category/<cat>/<sub>.html
    这一层是这次参考 ai-bio.cn 之后新增的：参考站的分类下面还有一层功能标签
    （AI图像工具 → 插画生成 / 背景移除 / 图像放大…），能吃到「AI 抠图工具」这类更长的长尾词。
    只有成员数够门槛的子类才产出页面（薄子类页对访客和搜索引擎都是负分）。 */
function buildToolSubcat(c, d) {
  const list = d.members;
  const siblings = (subsByCat[c.id] || []).filter(x => x.slug !== d.slug);
  const body = `${headerHTML(3, 'ai:' + c.id + ':' + d.slug)}
<main class="wrap" id="main">
  <nav class="crumb" aria-label="面包屑">
    <a href="../../../index.html">全部资源</a><span>/</span>
    <a href="../../index.html">AI 库</a><span>/</span>
    <a href="../${esc(c.id)}.html">${esc(c.name)}</a><span>/</span>
    <span>${esc(d.name)}</span>
  </nav>
  <section class="page-hd" data-tone="${esc(c.tone || 'slate')}" style="border-bottom:0;padding-bottom:10px">
    <div class="page-hd__main">
      <p class="kicker">AI 库 · ${esc(c.name)}</p>
      <h1>${esc(d.name)}</h1>
      <p class="page-hd__tl">${esc(d.desc || '')} · 共 ${list.length} 款</p>
    </div>
  </section>
  <section class="grid-sec" style="padding-top:8px">
    <div class="grid">
${list.map(t => toolCardHTML(t, 3)).join('\n')}
    </div>
  </section>
  ${siblings.length ? `  <section class="sec sec--tight">
    <div class="tagrow" style="border-top:0;padding-top:0">
      <span class="tagrow__lab">${esc(c.name)}的其他功能</span>
      <div class="chips">
        <a class="chip" href="../${esc(c.id)}.html">全部 ${toolsByCat[c.id].length}</a>
${siblings.map(x => `        ${x.live
      ? `<a class="chip" href="${x.slug}.html">${esc(x.name)}<span class="chip__n">${x.members.length}</span></a>`
      : `<span class="chip chip--muted">${esc(x.name)}<span class="chip__n">${x.members.length}</span></span>`}`).join('\n')}
      </div>
    </div>
  </section>` : ''}
</main>
${footerHTML(3)}`;

  const names = list.map(t => t.nameZh || t.name);
  return page({
    depth: 3,
    active: 'ai:' + c.id + ':' + d.slug,
    title: `${d.name}工具有哪些（共 ${list.length} 款，含免费额度说明）| ${SITE.suffix}`,
    desc: `${SITE.name}整理的${c.name} · ${d.name}共 ${list.length} 款：${names.join('、')}。每条标明官网、是否开源、免费额度形态与国内访问情况，中文介绍为本站原创撰写。`,
    canonical: `${SITE.url}/ai/category/${c.id}/${d.slug}`,
    body,
    jsonld: [
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: `${c.name} · ${d.name}`,
        description: d.desc || '',
        numberOfItems: list.length,
        itemListElement: list.map((t, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: t.nameZh || t.name,
          url: `${SITE.url}/ai/${t.slug}`,
        })),
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '全部资源', item: SITE.url + '/' },
          { '@type': 'ListItem', position: 2, name: 'AI 库', item: `${SITE.url}/ai/` },
          { '@type': 'ListItem', position: 3, name: c.name, item: `${SITE.url}/ai/category/${c.id}` },
          { '@type': 'ListItem', position: 4, name: d.name, item: `${SITE.url}/ai/category/${c.id}/${d.slug}` },
        ],
      },
    ],
  });
}

/** AI 工具的分类页 /ai/category/<id>.html
    独立成页而不是只在首页筛选：一个可索引的分类 URL 能吃到
    「AI 写作工具」「AI 配音工具」这类类目词，筛选器做不到这件事。 */
function buildToolCategory(c) {
  const list = toolsByCat[c.id];
  const others = liveToolCats.filter(x => x.id !== c.id);
  const body = `${headerHTML(2, 'ai')}
<main class="wrap" id="main">
  <nav class="crumb" aria-label="面包屑"><a href="../../index.html">全部资源</a><span>/</span><a href="../index.html">AI 库</a><span>/</span><span>${esc(c.name)}</span></nav>
  <section class="page-hd" data-tone="${esc(c.tone || 'slate')}" style="border-bottom:0;padding-bottom:10px">
    <div class="page-hd__main">
      <p class="kicker">AI 库 · 分类</p>
      <h1>${esc(c.name)}</h1>
      <p class="page-hd__tl">${esc(c.desc || '')} · 共 ${list.length} 款</p>
    </div>
  </section>
  ${subcatBlockHTML(c.id, 2)}
  <section class="grid-sec" style="padding-top:8px">
    <div class="grid">
${list.map(t => toolCardHTML(t, 2)).join('\n')}
    </div>
  </section>
  <section class="sec sec--tight">
    <div class="tagrow" style="border-top:0;padding-top:0">
      <span class="tagrow__lab">其他分类</span>
      <div class="chips">
${others.map(x => `        <a class="chip" href="${x.id}.html">${esc(x.name)}<span class="chip__n">${toolsByCat[x.id].length}</span></a>`).join('\n')}
      </div>
    </div>
  </section>
</main>
${footerHTML(2)}`;

  const subNote = liveSubsOf(c.id).length
    ? `，并按${liveSubsOf(c.id).map(d => d.name).join('、')}等 ${liveSubsOf(c.id).length} 个功能子类进一步细分`
    : '';
  return page({
    depth: 2,
    active: 'ai:' + c.id,
    title: `${c.name}有哪些（共 ${list.length} 款，含免费额度说明）| ${SITE.suffix}`,
    desc: `${SITE.name}整理的${c.name}共 ${list.length} 款：${list.slice(0, 14).map(t => t.nameZh || t.name).join('、')}${list.length > 14 ? ' 等' : ''}${subNote}。每条标明官网、是否开源、免费额度与国内访问情况。`,
    canonical: `${SITE.url}/ai/category/${c.id}`,
    body,
    jsonld: [
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: c.name,
        numberOfItems: list.length,
        itemListElement: list.map((t, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: t.nameZh || t.name,
          url: `${SITE.url}/ai/${t.slug}`,
        })),
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '全部资源', item: SITE.url + '/' },
          { '@type': 'ListItem', position: 2, name: 'AI 库', item: `${SITE.url}/ai/` },
          { '@type': 'ListItem', position: 3, name: c.name, item: `${SITE.url}/ai/category/${c.id}` },
        ],
      },
    ],
  });
}

function buildToolDetail(t) {
  const depth = 1;
  const c = toolCatById[t.cat] || { name: 'AI 工具', tone: 'slate' };
  const cell = (k, v) => `<div class="meta__cell"><div class="meta__k">${k}</div><div class="meta__v">${v}</div></div>`;
  const ext = 'target="_blank" rel="noopener noreferrer"';

  const cells = [cell('分类', `<a href="category/${esc(t.cat)}.html">${esc(c.name)}</a>`)];
  if (t.vendor) cells.push(cell('开发者', esc(t.vendor)));
  cells.push(cell('费用', t.freeTier && TOOL_FREE[t.freeTier] ? esc(TOOL_FREE[t.freeTier]) : '<span class="muted">见官网定价页</span>'));
  if (t.freeTier === 'freemium' || t.freeTier === 'trial') {
    cells.push(cell('免费额度', t.pricingUrl
      ? `<a href="${esc(t.pricingUrl)}" ${ext}>以官方定价页为准</a>`
      : '<span class="muted">以官方说明为准</span>'));
  }
  cells.push(cell('国内访问', t.needsVpn
    ? '<span class="warnish">通常需自备网络条件</span>'
    : '可直连'));
  cells.push(cell('中文支持', t.zhSupport ? '原生支持中文' : '以英文为主'));
  if (Array.isArray(t.platforms) && t.platforms.length) cells.push(cell('支持平台', esc(t.platforms.join(' · '))));
  cells.push(cell('是否开源', t.opensource ? '开源' : '闭源'));

  const acts = [];
  if (t.site) acts.push(`<a class="btn btn--accent" href="${esc(t.site)}" ${ext}>访问官网${ARROW}</a>`);
  if (t.repo) acts.push(`<a class="btn btn--ghost" href="${esc(t.repo)}" ${ext}>查看源码仓库</a>`);
  if (t.pricingUrl) acts.push(`<a class="btn btn--ghost" href="${esc(t.pricingUrl)}" ${ext}>官方定价页</a>`);

  const rel = toolsByCat[t.cat].filter(x => x.slug !== t.slug).slice(0, 6);

  const body = `${headerHTML(depth, 'ai')}
<main class="wrap" id="main">
  <nav class="crumb" aria-label="面包屑">
    <a href="../index.html">全部资源</a><span>/</span>
    <a href="index.html">AI 库</a><span>/</span>
    <a href="category/${esc(t.cat)}.html">${esc(c.name)}</a><span>/</span>
    <span>${esc(t.nameZh || t.name)}</span>
  </nav>

  <header class="page-hd" data-tone="${esc(c.tone || 'slate')}">
    <span class="ico page-hd__ico" data-tone="${esc(c.tone || 'slate')}" aria-hidden="true">${esc(initial(t.nameZh || t.name))}</span>
    <div class="page-hd__main">
      <p class="kicker">${esc(c.name)}</p>
      <h1>${esc(t.nameZh || t.name)}</h1>
      <p class="page-hd__tl">${esc(t.tagline)}</p>
      ${t.name && t.name !== t.nameZh ? `<p class="meta__k" style="margin-top:8px">${esc(t.name)}</p>` : ''}
      <div class="page-hd__acts">${acts.join('')}</div>
    </div>
  </header>

  <div class="meta">${cells.join('')}</div>

  ${t.accessNote ? `<div class="notice"><b>访问说明</b><span>${esc(t.accessNote)}</span></div>` : ''}
  ${t.openNote ? `<div class="notice"><b>开源说明</b><span>${esc(t.openNote)}</span></div>` : ''}

  <div class="prose">
    <section class="blk"><h2>这个工具是什么</h2><p>${esc(t.desc)}</p></section>

    ${(t.features || []).length ? `<section class="blk"><h2>能做什么</h2><ul>${t.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul></section>` : ''}

    ${(t.goodFor || []).length ? `<section class="blk"><h2>适合谁用</h2><ul>${t.goodFor.map(f => `<li>${esc(f)}</li>`).join('')}</ul></section>` : ''}

    <section class="blk">
      <h2>怎么开始用</h2>
      <ul>
        ${(t.howto || []).map(x => `<li>${esc(x)}</li>`).join('')}
      </ul>
      ${t.pricingUrl ? `<p>费用、额度与订阅方式以官方定价页为准：<a href="${esc(t.pricingUrl)}" ${ext}>${esc(t.pricingUrl.replace(/^https?:\/\//, ''))}</a>。价格随时可能调整，站内不写具体金额，避免给你过期信息。</p>` : ''}
      ${t.needsVpn ? `<p>再说明一次访问前提：该站点从中国大陆访问通常需要自备网络条件。请先确认自己的网络环境，再决定是否把它纳入工作流 —— 用不了的工具，功能再全也没有意义。</p>` : ''}
    </section>

    ${(t.alternatives || []).length ? `<section class="blk"><h2>同类可替代的工具</h2>
      <ul>${t.alternatives.map(a => `<li><b>${esc(a.name)}</b>：${esc(a.why)}</li>`).join('')}</ul>
      <p>以上为同类工具的事实性对比，最终选哪个取决于你的具体场景。</p>
    </section>` : ''}

    ${rel.length ? `<section class="rel">
      <h2>${esc(c.name)}里的其他工具</h2>
      <div class="grid">${rel.map(x => toolCardHTML(x, 1)).join('\n')}</div>
    </section>` : ''}
  </div>
</main>
${footerHTML(depth)}`;

  const descRaw = [t.tagline, t.desc].filter(Boolean).join('。');
  return page({
    depth,
    active: 'ai',
    title: `${t.nameZh || t.name} - ${t.tagline} | ${SITE.suffix}`,
    desc: (descRaw.length > 150 ? descRaw.slice(0, 148) + '…' : descRaw) +
      (t.needsVpn ? '（国内访问通常需自备网络条件）' : '（国内可直连）'),
    canonical: `${SITE.url}/ai/${t.slug}`,
    body,
    jsonld: [
      {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: t.nameZh || t.name,
        ...(t.name && t.name !== t.nameZh ? { alternateName: t.name } : {}),
        description: descRaw,
        applicationCategory: c.name,
        ...(t.vendor ? { author: { '@type': 'Organization', name: t.vendor } } : {}),
        ...(t.site ? { url: t.site } : {}),
        ...(t.opensource && t.repo ? { codeRepository: t.repo } : {}),
        ...(t.freeTier === 'free' ? { offers: { '@type': 'Offer', price: '0', priceCurrency: 'CNY' } } : {}),
        inLanguage: 'zh-CN',
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '全部资源', item: SITE.url + '/' },
          { '@type': 'ListItem', position: 2, name: 'AI 库', item: `${SITE.url}/ai/` },
          { '@type': 'ListItem', position: 3, name: c.name, item: `${SITE.url}/ai/category/${c.id}` },
          { '@type': 'ListItem', position: 4, name: t.nameZh || t.name, item: `${SITE.url}/ai/${t.slug}` },
        ],
      },
    ],
  });
}

/* ---------- 8.7b 运营指南 /guides/ ----------
   跨境电商 / 多账号运营方向的实操内容，承接自营产品号狐浏览器。
   这是「官方出品」的编辑内容，与开源收录相互独立：正文免费阅读，
   文末号狐 CTA 明确标注官方出品，不混入资源列表。 */
function productCtaHTML(depth) {
  if (!PRODUCT) return '';
  const r = up(depth);
  return `<aside class="guide-cta">
  <div class="guide-cta__main">
    <span class="guide-cta__kicker">官方出品</span>
    <b>${esc(PRODUCT.name)}</b>
    <p>${esc(PRODUCT.tagline)} · ${esc(PRODUCT.homeText)}</p>
  </div>
  <a class="btn btn--product" href="${r}products/${PRODUCT.slug}.html">了解${esc(PRODUCT.name)}${ARROW}</a>
</aside>`;
}

function guideBlockHTML(b) {
  const h = b.h ? `<h2>${esc(b.h)}</h2>` : '';
  const p = Array.isArray(b.p) ? b.p.map(x => `<p>${esc(x)}</p>`).join('') : '';
  const li = Array.isArray(b.li) ? `<ul>${b.li.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  return `<section>${h}${p}${li}</section>`;
}

/** base 是「到 /guides/ 目录的相对前缀」，不是层级深度 —— 卡片在两个不同目录下被调用，
    各自的相对路径不同（指南目录页 ''、产品详情页 '../guides/'），
    用 depth 表达不了产品页（它在 products/ 下，要去兄弟目录），所以显式传前缀。 */
function guideCardHTML(g, base = '') {
  return `<a class="guide-card" href="${base}${g.slug}.html">
  <span class="guide-card__meta"><span class="guide-card__tag">指南</span>${g.date ? `<span class="guide-card__date">${esc(g.date)}</span>` : ''}</span>
  <b class="guide-card__t">${esc(g.title)}</b>
  <p class="guide-card__s">${esc(g.tagline)}</p>
  <span class="guide-card__go">阅读${ARROW}</span>
</a>`;
}

/* 产品详情页里的「运营指南」模块 —— 从首页「官方出品」挪过来的那一层（用户要求）。
   形态刻意保持原样（小标题行 .sec-sub + 指南卡片网格 + 「全部 N 篇」入口），
   只有链接前缀变了：产品页在 /products/ 下，卡片刻意指向兄弟目录 ../guides/。
   首屏只放 3 篇，其余走「全部 N 篇」—— 与它还在首页时的取舍一致。 */
function productGuidesHTML(depth = 1) {
  if (!PRODUCT || !guides.length) return '';
  const r = up(depth);
  return `<section class="blk blk--guides" id="guides">
      <div class="sec-sub">
        <h3>运营指南</h3>
        <p>从指纹浏览器入门到多账号矩阵实操</p>
        <a class="sec-hd__link" href="${r}guides/index.html">全部 ${guides.length} 篇${ARROW}</a>
      </div>
      <div class="guide-grid">
        ${guides.slice(0, 3).map(g => guideCardHTML(g, `${r}guides/`)).join('\n        ')}
      </div>
    </section>`;
}

function buildGuideIndex() {
  const body = `${headerHTML(1, 'guides')}
<main class="wrap" id="main">
  <nav class="crumb" aria-label="面包屑"><a href="../index.html">全部资源</a><span>/</span><span>运营指南</span></nav>
  <section class="page-hd" style="border-bottom:0;padding-bottom:10px">
    <div class="page-hd__main">
      <p class="kicker">运营指南</p>
      <h1>跨境电商与多账号运营指南</h1>
      <p class="page-hd__tl">从指纹浏览器入门到多账号矩阵实操，结合号狐浏览器落地。</p>
    </div>
  </section>
  <div class="prose" style="padding-block:0">
    <section class="blk" style="padding-block:18px 24px;border-bottom:0">
      <p>这些是本站作者结合自营产品「号狐浏览器」整理的实操向指南，覆盖跨境电商多店铺、社媒矩阵、广告投放等场景。内容免费阅读；具体产品功能、套餐与价格以 accfox.cn 官网为准。</p>
    </section>
  </div>
  <section class="grid-sec" style="padding-top:8px">
    <div class="guide-grid">
${guides.map(g => guideCardHTML(g, '')).join('\n')}
    </div>
  </section>
</main>
${footerHTML(1)}`;

  return page({
    depth: 1,
    active: 'guides',
    title: `跨境电商与多账号运营指南 | ${SITE.suffix}`,
    desc: `跨境电商、社媒矩阵、广告投放等场景的多账号运营指南：指纹浏览器入门、多店铺防关联、矩阵多账号管理等 ${guides.length} 篇实操内容，结合号狐浏览器落地。`,
    canonical: `${SITE.url}/guides/`,
    body,
    jsonld: [
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: '跨境电商与多账号运营指南',
        description: '跨境电商与多账号运营的实操指南，结合号狐浏览器落地。',
        url: `${SITE.url}/guides/`,
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '全部资源', item: SITE.url + '/' },
          { '@type': 'ListItem', position: 2, name: '运营指南', item: `${SITE.url}/guides/` },
        ],
      },
    ],
  });
}

function buildGuideDetail(g) {
  const depth = 1;
  const rel = guides.filter(x => x.slug !== g.slug).slice(0, 4);
  const body = `${headerHTML(depth, 'guides')}
<main class="wrap" id="main">
  <nav class="crumb" aria-label="面包屑"><a href="../index.html">全部资源</a><span>/</span><a href="index.html">运营指南</a><span>/</span><span>${esc(g.title)}</span></nav>
  <header class="page-hd" data-tone="slate">
    <div class="page-hd__main">
      <p class="kicker">运营指南</p>
      <h1>${esc(g.title)}</h1>
      <p class="page-hd__tl">${esc(g.tagline)}${g.date ? ` · ${esc(g.date)}` : ''}</p>
    </div>
  </header>
  <div class="prose">
    <div class="guide">
      ${(g.blocks || []).map(guideBlockHTML).join('\n      ')}
      ${productCtaHTML(depth)}
    </div>
    ${rel.length ? `<section class="rel">
      <h2>更多指南</h2>
      <div class="rel__grid">
        ${rel.map(x => `<a class="rel__i" href="${x.slug}.html" data-tone="slate"><span><b>${esc(x.title)}</b><small>${esc(x.tagline)}</small></span></a>`).join('\n        ')}
      </div>
    </section>` : ''}
  </div>
</main>
${footerHTML(depth)}`;

  return page({
    depth,
    active: 'guides',
    title: `${g.title} | ${SITE.suffix}`,
    desc: (g.desc && g.desc.length > 150) ? g.desc.slice(0, 148) + '…' : (g.desc || g.tagline),
    canonical: `${SITE.url}/guides/${g.slug}`,
    body,
    jsonld: [
      {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: g.title,
        description: g.desc || g.tagline,
        ...(g.date ? { datePublished: g.date, dateModified: g.date } : {}),
        inLanguage: 'zh-CN',
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '全部资源', item: SITE.url + '/' },
          { '@type': 'ListItem', position: 2, name: '运营指南', item: `${SITE.url}/guides/` },
          { '@type': 'ListItem', position: 3, name: g.title, item: `${SITE.url}/guides/${g.slug}` },
        ],
      },
    ],
  });
}

/* ---------- 8.8 自营产品落地页 /products/<slug>.html ----------
   站长自营的商业产品，与「只收录开源资源」的主内容分开：独立目录、独立品牌色、
   明确「官方出品 · 自营」身份，绝不混入 apps/category 的收录列表。 */
/** 产品图标：assets/icons/<slug>.<ext> 存在就用真 logo，缺失退回首字标记（与 app 图标同一套退让原则） */
function productIcon(depth) {
  const ext = ['.webp', '.png', '.svg', '.jpg']
    .find(e => fs.existsSync(path.join(ICON_DIR, `${PRODUCT.slug}${e}`)));
  if (!ext) {
    return `<span class="ico page-hd__ico" style="--tone:var(--product);--tint:var(--product-tint)" aria-hidden="true">${esc(initial(PRODUCT.name))}</span>`;
  }
  return `<span class="ico page-hd__ico" style="--tone:var(--product);--tint:var(--product-tint)">` +
    `<img src="${up(depth)}assets/icons/${PRODUCT.slug}${ext}" alt="${esc(PRODUCT.name)}" ` +
    `width="64" height="64" loading="lazy" decoding="async"></span>`;
}

function buildProduct() {
  const P = PRODUCT;
  const depth = 1;
  const host = P.url.replace(/^https?:\/\//, '').replace(/\/+$/, '');

  const metaCells = [
    `<div class="meta__cell"><div class="meta__k">产品类型</div><div class="meta__v">指纹浏览器 · 防关联浏览器</div></div>`,
    `<div class="meta__cell"><div class="meta__k">核心能力</div><div class="meta__v">多开 · 指纹隔离 · 防关联</div></div>`,
    `<div class="meta__cell"><div class="meta__k">适用人群</div><div class="meta__v">跨境电商 / 社媒矩阵 / 广告投放</div></div>`,
    P.url ? `<div class="meta__cell"><div class="meta__k">官方地址</div><div class="meta__v"><a href="${esc(P.url)}" target="_blank" rel="noopener noreferrer">${esc(host)}</a></div></div>` : '',
  ].filter(Boolean).join('');

  const scenGrid = P.scenarios.length
    ? `<div class="scens">${P.scenarios.map(s => `<div class="scen"><b>${esc(s.title)}</b><p>${esc(s.desc)}</p></div>`).join('\n        ')}</div>`
    : '';

  const featList = P.features.length
    ? `<ul>${P.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>`
    : '';

  const whyList = P.why.length
    ? `<ul>${P.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`
    : '';

  const faqList = P.faq.length
    ? P.faq.map(f => `<details class="faq"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('\n        ')
    : '';

  const officialBtn = P.url
    ? `<a class="btn btn--product" href="${esc(P.url)}" target="_blank" rel="noopener noreferrer">${esc(P.cta)}${ARROW}</a>`
    : '';

  // 自营产品网盘直下：站长自己上传的客户端，放在「开始使用」与页头 CTA，随提取码一起展示
  const dl = P.download && P.download.url ? P.download : null;
  const dlBtn = dl
    ? `<a class="btn btn--product" href="${esc(dl.url)}" target="_blank" rel="noopener noreferrer">${esc(dl.label || '网盘下载')}${ARROW}</a>`
    : '';
  const dlBlock = dl
    ? `<div style="margin:16px 0 22px">
         <div>${dlBtn}${dl.pwd ? `<span style="margin-left:14px">提取码 <code style="font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--surface-2, #f2f2f4);padding:2px 8px;border-radius:6px">${esc(dl.pwd)}</code></span>` : ''}</div>
         ${dl.note ? `<p style="margin-top:10px;color:var(--muted, #888)">${esc(dl.note)}</p>` : ''}
       </div>`
    : '';

  const body = `${headerHTML(depth, 'product')}
<main class="wrap product-page" id="main">
  <nav class="crumb" aria-label="面包屑"><a href="../index.html">全部资源</a><span>/</span><span>官方出品</span><span>/</span><span>${esc(P.name)}</span></nav>

  <header class="page-hd">
    ${productIcon(depth)}
    <div class="page-hd__main">
      <p class="kicker" style="color:var(--product-deep)">官方出品 · 自营产品</p>
      <h1>${esc(P.name)}</h1>
      <p class="page-hd__tl">${esc(P.tagline)}</p>
      <div class="page-hd__acts">
        ${dlBtn}
        ${officialBtn}
        ${P.scenarios.length ? `<a class="btn btn--ghost" href="#scenarios">了解适用场景</a>` : ''}
      </div>
    </div>
  </header>

  <div class="meta">${metaCells}</div>

  <div class="notice notice--product"><b>自营产品</b><span>${esc(P.name)} 是站长自营的商业产品，与本站「只收录开源资源」的内容相互独立。本站只做如实介绍，具体功能、套餐与使用方式以 <a href="${esc(P.url)}" target="_blank" rel="noopener noreferrer">${esc(host)}</a> 官网为准。</span></div>

  <div class="prose">
    <section class="blk"><h2>关于${esc(P.name)}</h2><p>${esc(P.desc)}</p></section>

    ${P.scenarios.length ? `<section class="blk" id="scenarios"><h2>适用场景</h2>${scenGrid}</section>` : ''}

    ${P.features.length ? `<section class="blk"><h2>核心能力</h2>${featList}</section>` : ''}

    ${P.why.length ? `<section class="blk"><h2>为什么选它</h2>${whyList}</section>` : ''}

    ${productGuidesHTML(depth)}

    ${P.faq.length ? `<section class="blk"><h2>常见问题</h2>${faqList}</section>` : ''}

    <section class="blk">
      <h2>开始使用</h2>
      ${dl
        ? `<p>可通过网盘直接下载客户端，或前往 ${esc(host)} 官网注册使用。</p>${dlBlock}<p>具体功能、套餐与价格以官网为准。</p>`
        : `<p>前往 ${esc(host)} 官网注册并下载客户端即可。具体功能、套餐与价格以官网为准。</p><div style="margin-top:18px">${officialBtn}</div>`}
    </section>
  </div>
</main>
${footerHTML(depth)}`;

  const descRaw = [P.tagline, P.desc].filter(Boolean).join('。');
  return page({
    depth,
    active: 'product',
    title: `${P.name} - ${P.tagline} | ${SITE.suffix}`,
    desc: descRaw.length > 150 ? descRaw.slice(0, 148) + '…' : descRaw,
    canonical: `${SITE.url}/products/${P.slug}`,
    body,
    jsonld: [
      {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: P.name,
        description: descRaw,
        applicationCategory: 'BrowserApplication',
        ...(P.url ? { url: P.url } : {}),
        inLanguage: 'zh-CN',
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '全部资源', item: SITE.url + '/' },
          { '@type': 'ListItem', position: 2, name: P.name, item: `${SITE.url}/products/${P.slug}` },
        ],
      },
    ],
  });
}

/* ---------- 8.9 联盟跳转页 /go/<id>.html ----------
   记录点击来源（?ref=）后重定向到真实联盟链接。noindex：跳转页不参与索引。
   跳转不等待、不阻塞：sendBeacon 是 fire-and-forget，即使立即 location.replace 也能送达；
   没配 beaconUrl 时，来源信息仍可通过 ?ref= 查询参数在 EdgeOne Pages 访问日志里看到。 */
function buildGoRedirect(program) {
  const targetJson = JSON.stringify(program.url);
  const beaconJson = JSON.stringify(ANALYTICS.beaconUrl || '');
  const tagJson = JSON.stringify(program.id);

  const body = `${headerHTML(1, '')}
<main class="wrap" id="main">
  <section class="hero" style="padding-block:clamp(44px,7vw,84px)">
    <p class="eyebrow">跳转中</p>
    <h1>正在前往${esc(program.provider)}…</h1>
    <p class="hero__lede">页面没有自动跳转？点击下面的链接即可。</p>
    <div class="hero__acts">
      <a class="btn btn--solid" href="${esc(program.url)}" rel="sponsored nofollow">前往${esc(program.provider)}${ARROW}</a>
    </div>
  </section>
</main>
${footerHTML(1)}
<script>
(function(){
  var target = ${targetJson};
  var ref = 'direct';
  try { ref = new URLSearchParams(location.search).get('ref') || 'direct'; } catch(e){}
  var beacon = ${beaconJson};
  try {
    if (beacon) { navigator.sendBeacon(beacon, JSON.stringify({evt:'affiliate', tag:${tagJson}, ref:ref, t:Date.now()})); }
  } catch(e){}
  if (window.console && window.console.debug) { window.console.debug('[affiliate] ${program.id} ref=', ref); }
  if (target) { location.replace(target); }
})();
</script>`;

  return page({
    depth: 1,
    title: `正在前往${program.provider} | ${SITE.suffix}`,
    desc: `正在跳转到${program.provider}。`,
    canonical: `${SITE.url}/go/${program.id}`,
    body,
    extraHead: '<meta name="robots" content="noindex,nofollow">',
  });
}

/* ---------- 9. 静态页（关于 / 免责 / 版权） ---------- */
const LEGAL_CRUMB = (label) => `<nav class="crumb" aria-label="面包屑"><a href="index.html">全部资源</a><span>/</span><span>${esc(label)}</span></nav>`;

function buildAbout() {
  const catNames = cats.map(c => c.name).join('、');
  // 状态必须与首页频道卡一致：写死 status 会让「筹备中」的电脑软件在关于页显示成已上线
  const channels = visibleChannels.map(ch =>
    `<li><b>${esc(ch.name)}</b>——${esc(ch.desc)}${channelLive(ch) ? '（已上线）' : '（筹备中）'}</li>`).join('\n      ');
  const body = `${headerHTML(0, 'about')}
<main class="wrap" id="main">
  ${LEGAL_CRUMB('关于本站')}
  <section class="page-hd" style="border-bottom:0">
    <div class="page-hd__main">
      <h1>关于本站</h1>
      <p class="page-hd__tl">${esc(SITE.slogan)}</p>
    </div>
  </section>
  <div class="prose" style="max-width:none">
    <section class="blk">
      <h2>我们在做什么</h2>
      <p>${esc(SITE.name)}（${esc(SITE.host)}）把 GitHub 等公开渠道上值得一用的开源资源整理成中文条目：说清楚它是什么、解决什么问题、怎么拿到手。挑选标准很简单——源码公开、免费使用、无广告、有在维护。</p>
      <p>目前收录 ${apps.length} 条，覆盖${catNames}；其中 ${repoCount} 条已核实到官方代码仓库，${withLinkCount} 条可直接在本站获取。</p>
    </section>
    <section class="blk">
      <h2>接下来会有什么</h2>
      <ul>
      ${channels}
      </ul>
      <p>没有内容的频道不会提前上线占位——空页面既浪费你的时间，也会被搜索引擎判为低质内容。</p>
    </section>
    <section class="blk">
      <h2>每一条都查过</h2>
      <p>站内每个条目都逐一核实过官方代码仓库、开源协议与维护状态，详情页可以直接跳到作者仓库。核实过程中发现的问题——比如描述与实际功能不符、项目已停止维护、代码托管在 GitHub 之外——都会在该条目的详情页如实标注，不做美化。</p>
      <p>遇到确实无法核实的条目，我们会标明「待确认」而不是含糊带过；拿不到的信息宁可留空，也不用假数据凑数。</p>
    </section>
    <section class="blk">
      <h2>资源怎么获取</h2>
      <p>在首页按分类浏览或直接搜索，进入任意条目的详情页即可看到功能介绍、官方仓库地址与获取方式。资源以百度网盘转存方式提供，提取码可在详情页一键复制。</p>
      <p><b>建议先转存到自己网盘再下载</b>：原分享链接可能因平台风控或作者调整而失效，转存后不受影响。如果发现链接失效或版本过期，欢迎反馈。</p>
    </section>
    ${PRODUCT ? `<section class="blk">
      <h2>自营产品</h2>
      <p>除了整理开源资源，本站作者也运营自己的产品——<a href="products/${PRODUCT.slug}.html">${esc(PRODUCT.name)}</a>，一款面向跨境电商、社媒矩阵与广告投放的指纹浏览器（多账号防关联管理）。</p>
      <p>需要说明的是：它是<strong>商业产品</strong>，与本站「只收录开源资源」的主内容相互独立。本站只把它作为「官方出品」单独介绍，绝不混入开源收录清单；具体功能、套餐与价格以 <a href="${esc(PRODUCT.url)}" target="_blank" rel="noopener noreferrer">${esc(PRODUCT.url.replace(/^https?:\/\//, ''))}</a> 官网为准。</p>
    </section>` : ''}
    <section class="blk">
      <h2>版权与联系</h2>
      <p>本站是资源整理与索引站点，不存储、不制作、不修改任何软件与文档，也不提供任何破解、修改或商业授权版本。站内收录的内容均为公开渠道可获取的开源或非商业免费资源，版权归各自作者所有。</p>
      <p>若您是权利人并认为本站内容不妥，请依照<a href="copyright.html">版权与侵权处理</a>页面说明与我们联系，我们会及时核实处理。其余问题也欢迎通过同样的渠道反馈。</p>
      <p>${SITE.email ? `联系邮箱：<a href="mailto:${esc(SITE.email)}">${esc(SITE.email)}</a>` : '本站暂未开通公开邮箱，联系方式开通后会在本页与页脚公布。'}</p>
    </section>
  </div>
</main>
${footerHTML(0)}`;

  return page({
    depth: 0,
    active: 'about',
    title: `关于本站 - ${SITE.slogan} | ${SITE.suffix}`,
    desc: `${SITE.name}是一个开源资源整理站，收录 ${apps.length} 条开源软件，覆盖${catNames}，每条都核实官方仓库与开源协议，并提供百度网盘获取方式。`,
    canonical: `${SITE.url}/about`,
    body,
  });
}

function buildDisclaimer() {
  const body = `${headerHTML(0, 'about')}
<main class="wrap" id="main">
  ${LEGAL_CRUMB('免责声明')}
  <section class="page-hd" style="border-bottom:0">
    <div class="page-hd__main">
      <h1>免责声明</h1>
      <p class="page-hd__tl">最后更新：随站点内容同步维护</p>
    </div>
  </section>
  <div class="prose" style="max-width:none">
    <section class="blk">
      <h2>一、本站性质</h2>
      <p>${esc(SITE.name)}（${esc(SITE.host)}）是资源整理与索引站点，<b>不存储、不制作、不修改任何软件与文档</b>，也不提供任何破解、去广告或商业授权版本。本站的作用仅限于信息整理与获取指引。</p>
    </section>
    <section class="blk">
      <h2>二、内容来源与版权</h2>
      <p>站内条目均来自公开渠道（如开源项目的官方代码仓库、官方发布页），版权归各自作者所有。我们只收录有明确开源协议或官方免费公开的内容；无法确认授权状态的内容不予收录。</p>
      <p>详情页展示的开源协议、仓库地址等信息为核实时的快照，可能随项目变化而变动，请以官方仓库为准。</p>
    </section>
    <section class="blk">
      <h2>三、下载与使用</h2>
      <p>站内资源仅供个人学习与研究使用，请于下载后 24 小时内自行删除。商业使用请自行向权利人取得授权，本站不承担由此产生的任何责任。</p>
      <p>建议优先前往官方渠道获取最新版本，以获得安全更新与作者支持。</p>
    </section>
    <section class="blk">
      <h2>四、第三方网盘</h2>
      <p>资源通过百度网盘等第三方平台分享，链接由第三方提供与承载。本站无法保证分享链接长期有效，也不对第三方平台的可用性、下载速度与数据安全负责。链接失效时，欢迎反馈，我们会尽快核实补链。</p>
    </section>
    <section class="blk">
      <h2>五、无担保</h2>
      <p>本站不对站内资源的完整性、安全性、适用性作出任何明示或默示担保。请在下载与安装前自行判断风险，因使用站内资源导致的任何直接或间接损失，本站不承担责任。</p>
    </section>
    <section class="blk">
      <h2>六、声明变更</h2>
      <p>本站保留随时修改本声明的权利，修改后的内容自发布之时生效。若您认为本站内容侵犯了您的合法权益，请依照<a href="copyright.html">版权与侵权处理</a>页面的说明联系我们。</p>
    </section>
  </div>
</main>
${footerHTML(0)}`;

  return page({
    depth: 0,
    active: 'disclaimer',
    title: `免责声明 | ${SITE.suffix}`,
    desc: `${SITE.name}免责声明：本站为资源整理与索引站点，不存储、不制作、不修改任何软件与文档，资源仅供个人学习研究使用。`,
    canonical: `${SITE.url}/disclaimer`,
    body,
  });
}

function buildCopyright() {
  const contact = SITE.email
    ? `<p>请将通知发送至：<a href="mailto:${esc(SITE.email)}">${esc(SITE.email)}</a></p>`
    : `<p>本站暂未开通公开邮箱，联系方式开通后会在本页与页脚公布。在联系方式公布前，您仍可通过域名登记信息中的渠道与我们取得联系。</p>`;
  const body = `${headerHTML(0, 'about')}
<main class="wrap" id="main">
  ${LEGAL_CRUMB('版权与侵权处理')}
  <section class="page-hd" style="border-bottom:0">
    <div class="page-hd__main">
      <h1>版权与侵权处理</h1>
      <p class="page-hd__tl">我们尊重每一位作者的权益，也欢迎权利人直接指出问题</p>
    </div>
  </section>
  <div class="prose" style="max-width:none">
    <section class="blk">
      <h2>我们只收录什么</h2>
      <ul>
        <li>有明确开源协议的项目（MIT、Apache-2.0、GPL、AGPL、MPL、BSD 等）</li>
        <li>以 CC 等开放许可发布，或作者明确允许自由传播的资料</li>
        <li>官方免费公开、可自由获取的软件与文档</li>
      </ul>
    </section>
    <section class="blk">
      <h2>我们不做什么</h2>
      <ul>
        <li>不收录付费课程、付费电子书、影视资源等需要授权才能传播的内容</li>
        <li>不提供破解、注册机、去广告版本，不绕过任何授权机制</li>
        <li>不篡改原始软件，不重新打包分发非官方构建</li>
        <li>不把无明确协议的代码用于再分发</li>
      </ul>
    </section>
    <section class="blk">
      <h2>若你认为本站内容侵权</h2>
      <p>我们愿意在第一时间处理。为便于快速核实，请在通知中尽量包含以下信息：</p>
      <ul>
        <li>权利人的姓名（或单位名称）与有效联系方式</li>
        <li>主张权利的权属证明（如著作权登记、商标注册、官方发布页等）</li>
        <li>涉嫌侵权内容在本站的具体网址（URL）</li>
        <li>认为构成侵权的说明，以及希望我们采取的措施（删除内容或移除链接）</li>
        <li>声明通知内容真实、并愿意承担因通知不实所产生责任的表述</li>
      </ul>
      ${contact}
    </section>
    <section class="blk">
      <h2>我们会怎么处理</h2>
      <p>收到有效通知后，我们会及时核实：确属侵权的，立即移除相关内容或链接；存在争议的，会先暂停展示涉争内容，并与通知人沟通确认。</p>
      <p>如果你是被收录项目的作者，也可以直接联系我们——包括希望补充信息、更正描述，或者不希望项目出现在本站。</p>
    </section>
    <section class="blk">
      <h2>关于开源协议的提醒</h2>
      <p>开源不等于无版权。GPL、AGPL、LGPL 等协议要求向接收者提供对应源码，MIT、Apache-2.0 等协议要求保留版权声明。本站每个条目均标注核实到的协议与官方仓库地址，请在遵守对应协议的前提下使用。</p>
    </section>
  </div>
</main>
${footerHTML(0)}`;

  return page({
    depth: 0,
    active: 'copyright',
    title: `版权与侵权处理 | ${SITE.suffix}`,
    desc: `${SITE.name}只收录开源协议或官方免费公开的内容，不提供破解与商业授权版本。若认为本站内容侵权，可按本页说明提交有效通知，我们会及时核实处理。`,
    canonical: `${SITE.url}/copyright`,
    body,
  });
}

/* ---------- 10. 404 ----------
   404 会被任意层级的 URL 命中，所以站内链接一律要用根绝对路径 —— 相对路径在
   /a/b/c 这种地址下会解析到 /a/b/ 里去（`apps/x.html` 变成 `/a/b/apps/x.html`）。
   也因此 404 不套侧栏：套上就得把侧栏里几十条链接全部绝对化，
   而 404 唯一的任务是「把人送回站内」，给几个根路径入口即可。 */
/** 把页面里所有本地引用改成根绝对路径（只给 404 用） */
function absolutize(html) {
  return html.replace(/(href|src)="(?!https?:|mailto:|#|data:|\/)([^"]*)"/g, '$1="/$2"');
}
function build404() {
  const body = `${headerHTML(0, '')}
<main class="wrap" id="main">
  <section class="hero">
    <p class="eyebrow">404</p>
    <h1>这个页面不存在。</h1>
    <p class="hero__lede">链接可能已经失效，或者你输错了地址。回到首页看看这 ${apps.length} 条开源资源。</p>
    <div class="hero__acts"><a class="btn btn--solid" href="index.html">返回首页${ARROW}</a></div>
  </section>
</main>
${footerHTML(0)}`;
  const inner = absolutize(body);
  return page({
    depth: 0,
    title: `页面不存在 | ${SITE.suffix}`,
    desc: '页面不存在',
    canonical: SITE.url + '/404',
    body: inner,
  });
}

/* ---------- 11. 静态资源（样式 / 脚本 / 图标 / favicon） ---------- */
function buildAssets() {
  const out = path.join(DIST, 'assets');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'styles.css'), CSS);
  fs.writeFileSync(path.join(out, 'app.js'), APPJS);

  // favicon：三层资源条。favicon 是独立 SVG 文件、读不到 CSS 变量，
  // 所以直接用 skillhub 双色的固定值（紫 #6840F6 → 珊瑚 #F17136）。
  fs.writeFileSync(path.join(out, 'favicon.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0" stop-color="#6840F6"/><stop offset="1" stop-color="#F17136"/></linearGradient></defs>` +
    `<rect x="4" y="6" width="24" height="6.4" rx="3.2" fill="url(#g)"/>` +
    `<rect x="4" y="14.8" width="17.6" height="6.4" rx="3.2" fill="#8B8E99"/>` +
    `<rect x="4" y="23.6" width="11.2" height="6.4" rx="3.2" fill="#8B8E99" opacity=".5"/>` +
    `</svg>\n`);

  // assets 根目录下的散件（og.png 等）直接随构建分发
  const assetsRoot = path.join(__dirname, 'assets');
  if (fs.existsSync(assetsRoot)) {
    for (const f of fs.readdirSync(assetsRoot)) {
      const p = path.join(assetsRoot, f);
      if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(out, f));
    }
  }

  // 图标目录
  const iconOut = path.join(out, 'icons');
  if (fs.existsSync(ICON_DIR)) {
    fs.mkdirSync(iconOut, { recursive: true });
    for (const f of fs.readdirSync(ICON_DIR)) {
      fs.copyFileSync(path.join(ICON_DIR, f), path.join(iconOut, f));
    }
  }
}

/* ---------- 12. 输出 ---------- */
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'apps'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'category'), { recursive: true });
if (liveTags.length) fs.mkdirSync(path.join(DIST, 'tag'), { recursive: true });
if (topics.length) fs.mkdirSync(path.join(DIST, 'topic'), { recursive: true });
if (skills.length) fs.mkdirSync(path.join(DIST, 'skills'), { recursive: true });
if (toolsLive) {
  fs.mkdirSync(path.join(DIST, 'ai'), { recursive: true });
  if (liveToolCats.length) fs.mkdirSync(path.join(DIST, 'ai', 'category'), { recursive: true });
}
if (desktopLive) fs.mkdirSync(path.join(DIST, 'desktop'), { recursive: true });
if (PRODUCT) fs.mkdirSync(path.join(DIST, 'products'), { recursive: true });
if (AFFILIATES.length) fs.mkdirSync(path.join(DIST, 'go'), { recursive: true });
if (guides.length) fs.mkdirSync(path.join(DIST, 'guides'), { recursive: true });

const STATIC_PAGES = [
  { file: 'about.html', url: '/about', pri: '0.6', html: buildAbout },
  { file: 'disclaimer.html', url: '/disclaimer', pri: '0.3', html: buildDisclaimer },
  { file: 'copyright.html', url: '/copyright', pri: '0.3', html: buildCopyright },
];

fs.writeFileSync(path.join(DIST, 'index.html'), buildHome());
for (const a of apps) fs.writeFileSync(path.join(DIST, 'apps', `${a.slug}.html`), buildDetail(a));
for (const c of cats) fs.writeFileSync(path.join(DIST, 'category', `${c.id}.html`), buildCategory(c));
for (const p of STATIC_PAGES) fs.writeFileSync(path.join(DIST, p.file), p.html());
for (const t of liveTags) fs.writeFileSync(path.join(DIST, 'tag', `${t.slug}.html`), buildTag(t));
for (const tp of topics) fs.writeFileSync(path.join(DIST, 'topic', `${tp.slug}.html`), buildTopic(tp));
if (skills.length) {
  fs.writeFileSync(path.join(DIST, 'skills', 'index.html'), buildSkillsIndex());
  for (const s of skills) fs.writeFileSync(path.join(DIST, 'skills', `${s.slug}.html`), buildSkillDetail(s));
}
if (guides.length) {
  fs.writeFileSync(path.join(DIST, 'guides', 'index.html'), buildGuideIndex());
  for (const g of guides) fs.writeFileSync(path.join(DIST, 'guides', `${g.slug}.html`), buildGuideDetail(g));
}
if (toolsLive) {
  fs.writeFileSync(path.join(DIST, 'ai', 'index.html'), buildToolsIndex());
  // 分类页在主频道页之前先跑：分类页里链接的是同目录的兄弟分类页，
  // 首页里链接的是 category/<id>.html —— 两边都必须存在，否则 check-dist 报死链
  for (const c of liveToolCats) fs.writeFileSync(path.join(DIST, 'ai', 'category', `${c.id}.html`), buildToolCategory(c));
  // 子类页在 /ai/category/<父类>/<子类>.html：多一层目录，先建好
  for (const c of liveToolCats) {
    const subs = liveSubsOf(c.id);
    if (!subs.length) continue;
    const dir = path.join(DIST, 'ai', 'category', c.id);
    fs.mkdirSync(dir, { recursive: true });
    for (const d of subs) fs.writeFileSync(path.join(dir, `${d.slug}.html`), buildToolSubcat(c, d));
  }
  for (const t of toolsOk) fs.writeFileSync(path.join(DIST, 'ai', `${t.slug}.html`), buildToolDetail(t));
}
if (desktopLive) fs.writeFileSync(path.join(DIST, 'desktop', 'index.html'), buildDesktop());
if (PRODUCT) fs.writeFileSync(path.join(DIST, 'products', `${PRODUCT.slug}.html`), buildProduct());
for (const p of AFFILIATES) fs.writeFileSync(path.join(DIST, 'go', `${p.id}.html`), buildGoRedirect(p));
fs.writeFileSync(path.join(DIST, '404.html'), build404());
buildAssets();

/* sitemap */
const urls = [
  { loc: SITE.url + '/', pri: '1.0' },
  ...STATIC_PAGES.map(p => ({ loc: SITE.url + p.url, pri: p.pri })),
  ...(skills.length ? [{ loc: `${SITE.url}/skills/`, pri: '0.8' }] : []),
  ...(toolsLive ? [{ loc: `${SITE.url}/ai/`, pri: '0.9' }] : []),
  ...(toolsLive ? liveToolCats.map(c => ({ loc: `${SITE.url}/ai/category/${c.id}`, pri: '0.8' })) : []),
  ...(toolsLive ? liveToolCats.flatMap(c => liveSubsOf(c.id).map(d => ({ loc: `${SITE.url}/ai/category/${c.id}/${d.slug}`, pri: '0.7' }))) : []),
  // 目录型页面的 URL 必须带尾斜杠：check-dist 的 toRel 认 `/skills/` → skills/index.html，
  // 写成 `/desktop` 会被当成 desktop.html（不存在）—— 实测校验器直接报了两条 FAIL
  ...(desktopLive ? [{ loc: `${SITE.url}/desktop/`, pri: '0.8' }] : []),
  ...(guides.length ? [{ loc: `${SITE.url}/guides/`, pri: '0.7' }] : []),
  ...(PRODUCT ? [{ loc: `${SITE.url}/products/${PRODUCT.slug}`, pri: '0.7' }] : []),
  ...topics.map(tp => ({ loc: `${SITE.url}/topic/${tp.slug}`, pri: '0.7' })),
  ...cats.map(c => ({ loc: `${SITE.url}/category/${c.id}`, pri: '0.8' })),
  ...liveTags.map(t => ({ loc: `${SITE.url}/tag/${t.slug}`, pri: '0.5' })),
  ...apps.map(a => ({ loc: `${SITE.url}/apps/${a.slug}`, pri: '0.7' })),
  ...skills.map(s => ({ loc: `${SITE.url}/skills/${s.slug}`, pri: '0.7' })),
  ...(toolsLive ? toolsOk.map(t => ({ loc: `${SITE.url}/ai/${t.slug}`, pri: '0.7' })) : []),
  ...guides.map(g => ({ loc: `${SITE.url}/guides/${g.slug}`, pri: '0.7' })),
];
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><priority>${u.pri}</priority></url>`).join('\n') +
  `\n</urlset>\n`);

fs.writeFileSync(path.join(DIST, 'robots.txt'),
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE.url}/sitemap.xml\n`);

/* ---------- 13. 报告 ---------- */
const iconCount = apps.filter(a => a.icon).length;
console.log(`构建完成 → ${path.relative(ROOT, DIST)}`);
console.log(`  品牌「${SITE.name}」· ${SITE.host}`);
console.log(`  首页 1 · 详情页 ${apps.length} · 分类页 ${cats.length} · 静态页 ${STATIC_PAGES.length}（${STATIC_PAGES.map(p => p.file.replace('.html', '')).join(' / ')}）· 404 1`);
console.log(`  标签页 ${liveTags.length} · 专题页 ${topics.length} · 技能页 ${skills.length ? skills.length + 1 : 0}${skills.length ? `（技能库 + ${skills.length} 条）` : ''}`);
// AI 库：门槛没到就不产出页面，但要把「还差几条」说清楚 —— 否则没人知道该补什么
if (toolsLive) {
  console.log(`  AI 库 已上线：${toolsOk.length} 款工具 · ${liveToolCats.length} 个分类页 · ${liveSubcatCount} 个子类页（目录 1 + 分类 ${liveToolCats.length} + 子类 ${liveSubcatCount} + 详情 ${toolsOk.length}）`);
  console.log(`    按分类：${liveToolCats.map(c => `${c.name} ${toolsByCat[c.id].length}${liveSubsOf(c.id).length ? `(子类 ${liveSubsOf(c.id).length})` : ''}`).join(' · ')}`);
  // 不够门槛的子类逐条说明原因 —— 「为什么这个子类没有页面」必须能查到，
  // 否则下次没人知道该补条目还是该合并子类
  if (notLiveSubs.length) {
    console.log(`    子类未产出页面 ${notLiveSubs.length} 个（${SUBCAT_MIN} 条门槛 / 不与父类重复）：${notLiveSubs.map(s => `${s.name} ${s.n}`).join(' · ')}`);
  }
} else {
  console.log(`  AI 库 未上线（${toolsOk.length}/${TOOLS_MIN} 款，差 ${TOOLS_MIN - toolsOk.length} 款；目录、导航项与 sitemap 条目都不产出，避免薄频道页）`);
}
if (toolUncategorized.length) {
  console.log(`    ⚠ ${toolUncategorized.length} 款工具分类无效（见下方警告）`);
}
// 电脑软件频道：没到门槛就不产出页面，但要把「还差几条」说清楚 —— 否则没人知道该补什么
console.log(`  电脑软件频道 ${desktopLive ? `已上线（${desktopApps.length} 条）` : `未上线（${desktopApps.length}/${DESKTOP_MIN} 条，差 ${DESKTOP_MIN - desktopApps.length} 条；页面与导航项都不产出，避免薄频道页）`}`);
if (PRODUCT) console.log(`  自营产品「${PRODUCT.name}」已上线：/products/${PRODUCT.slug}.html（与开源收录相互独立）`);
if (drafts.length) {
  console.log(`  内容层草稿 ${drafts.length} 条（status 不是 ok，未发布）：${drafts.map(d => d.slug).join(' · ')}`);
}
if (liveTags.length) {
  console.log(`    标签命中：${liveTags.map(t => `${t.name} ${t.items.length}`).join(' · ')}`);
}
if (skippedTags.length) {
  console.log(`    标签未达门槛（<${TAG_MIN} 条，不产出页面，避免薄内容）：${skippedTags.map(t => `${t.name} ${t.items.length}`).join(' · ')}`);
}
console.log(`  图标 ${iconCount}/${apps.length} · 已核实仓库 ${repoCount}/${apps.length} · 可获取 ${withLinkCount}/${apps.length}`);
console.log(`  sitemap URL ${urls.length} 条`);
console.log(`  样式 ${(CSS.length / 1024).toFixed(1)} KB (v=${CSS_V}) · 脚本 ${(APPJS.length / 1024).toFixed(1)} KB (v=${JS_V})`);
if (excluded.length) {
  console.log(`\n未收录 ${excluded.length} 条（原因见下，可在 curation.json 里把 status 改回 ok 恢复）：`);
  for (const e of excluded) console.log(`  ✗ ${e.name}：${e.reason}`);
}
if (warnings.length) {
  console.log(`\n警告 ${warnings.length} 条：`);
  for (const w of warnings) console.log('  - ' + w);
}
