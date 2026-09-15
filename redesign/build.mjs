#!/usr/bin/env node
/* ============================================================
   XihaoUC 静态站生成器
   ------------------------------------------------------------
   输入：../.kb-raw.json（从 xlsx 抽取的原始记录）
         ./curation.json（展示名 / 分类 / 一句话定位 / slug）
         ./data/github.json（联网核实到的仓库与图标信息，可选）
         ./assets/icons/*（本地图标，可选）
   输出：./dist（可直接上传 EdgeOne Pages）

   设计原则：
   - 页面内容全部构建期直出，搜索引擎可抓取；客户端 JS 只做增强
   - 所有内部链接为相对路径，dist 目录可直接双击打开预览
   - 缺失数据不编造：没有图标就退回首字标记，没有仓库就不显示开源信息
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(__dirname, 'src');
const DIST = path.join(__dirname, 'dist');
const ICON_DIR = path.join(__dirname, 'assets', 'icons');

const SITE = {
  url: 'https://www.xihaouc.top',
  name: 'XihaoUC',
  tagline: '精选 GitHub 开源软件',
  beian: '鲁ICP备2025193604号',
};

const warnings = [];
const excluded = [];
const readJSON = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
};

/* ---------- 1. 组装数据 ---------- */
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

/* ---------- 2. 工具 ---------- */
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const initial = name => {
  const ch = String(name || '?').trim()[0];
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch;
};

/** 相对根路径前缀：index.html -> ''，apps/x.html -> '../' */
const up = depth => depth === 0 ? '' : '../'.repeat(depth);

const ARROW = '<svg viewBox="0 0 24 24"><path d="M5 12h13M12 6l6 6-6 6"/></svg>';

/* ---------- 3. 片段 ---------- */
function iconHTML(a, cls = 'ico', size = 40) {
  const style = `--tone:var(--tone-${a.tone});--tint:var(--tint-${a.tone})`;
  if (a.icon) {
    return `<span class="${cls}" data-tone="${a.tone}" style="${style}">` +
      `<img src="__R__${a.icon}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">` +
      `</span>`;
  }
  return `<span class="${cls}" data-tone="${a.tone}" style="${style}" aria-hidden="true">${esc(initial(a.name))}</span>`;
}

function cardHTML(a, depth) {
  const r = up(depth);
  const hay = [a.name, a.tagline, a.desc, a.catName].join(' ').toLowerCase().replace(/"/g, '');
  return `<a class="card" href="${r}apps/${a.slug}.html" data-cat="${a.cat}" data-hay="${esc(hay)}" data-tone="${a.tone}">
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

function headerHTML(depth, active) {
  const r = up(depth);
  const cur = k => active === k ? ' aria-current="page"' : '';
  return `<header class="hdr">
  <div class="wrap hdr__in">
    <a class="brand" href="${r}index.html"><span class="brand__dot"></span>${SITE.name}</a>
    <nav class="nav" aria-label="主导航">
      <a href="${r}index.html"${cur('all')}>全部软件</a>
      <a href="${r}index.html#cats">分类浏览</a>
      <a href="${r}about.html">关于本站</a>
    </nav>
    <div class="hdr__spacer"></div>
    <span class="hdr__count">${apps.length} 款软件 · ${cats.length} 个分类</span>
  </div>
</header>`;
}

function footerHTML(depth) {
  const r = up(depth);
  return `<footer class="ftr">
  <div class="wrap">
    <div class="ftr__top">
      <div>
        <div class="ftr__brand"><span class="brand__dot"></span>${SITE.name}</div>
        <p style="margin-top:10px;font-size:13px;color:var(--ink-3);max-width:28em;line-height:1.8">
          专注收集整理免费开源软件，把好工具带给更多人。
        </p>
      </div>
      <div class="ftr__meta">
        <div><a href="${r}about.html">关于本站</a></div>
        <div><a href="https://beian.miit.gov.cn/#/Integrated/index" target="_blank" rel="noopener noreferrer">${SITE.beian}</a></div>
        <div>Copyright © 2025–2027 ${SITE.name}</div>
      </div>
    </div>
    <p class="ftr__note">
      免责声明：本站所列软件均为开源项目，版权归各自作者所有。本站仅提供信息整理与下载指引，不提供任何破解、修改或商业授权。所有资源仅供个人学习与研究使用，请于下载后 24 小时内自行删除，并前往项目官方仓库支持作者。若权利人认为本站内容侵犯其权益，请联系我们删除。
    </p>
  </div>
</footer>`;
}

const tweaksHTML = `<div class="tw">
  <div class="tw__panel" id="twPanel">
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
  <button class="tw__btn" id="twBtn" aria-expanded="false">Tweaks</button>
</div>`;

/* ---------- 4. 页面骨架 ---------- */
function page({ depth, title, desc, canonical, body, jsonld, extraHead = '' }) {
  const r = up(depth);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE.url}/assets/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${r}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${r}assets/styles.css">
${extraHead}${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>\n` : ''}</head>
<body>
${body}
${tweaksHTML}
<script src="${r}assets/app.js" defer></script>
</body>
</html>
`;
}

/* ---------- 5. 首页 ---------- */
function buildHome() {
  const cards = apps.map(a => cardHTML(a, 0)).join('\n');
  const lede = `${apps.length} 款经过挑选的开源应用，覆盖${cats.map(c => c.name).join('、')}。每款都附有官方仓库地址，无广告、无需付费。`;
  const body = `${headerHTML(0, 'all')}
<main>
  <section class="wrap hero">
    <p class="eyebrow">GitHub 开源软件合集</p>
    <h1>把好用的开源软件，<br>从 GitHub 带到<em>你的手机</em>。</h1>
    <p class="hero__lede">${esc(lede)}</p>
    <div class="hero__acts">
      <a class="btn btn--solid" href="#all">浏览全部软件${ARROW}</a>
    </div>
  </section>

  <section class="tools" id="all">
    <div class="wrap tools__in">
      <div class="chips" id="chips" role="group" aria-label="按分类筛选">${chipsHTML(0, 'all')}</div>
      <div class="search">
        <svg class="search__ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="q" type="search" placeholder="搜索软件名称或功能…" aria-label="搜索软件" autocomplete="off">
        <button class="search__clr" id="clr" aria-label="清除搜索"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
    </div>
  </section>

  <section class="wrap grid-sec">
    <h2 class="sr">软件列表</h2>
    <div class="grid" id="grid">
${cards}
    </div>
    <div class="empty" id="empty" hidden>
      <p>没有匹配的软件</p>
      <button class="btn btn--ghost" id="reset">清除筛选条件</button>
    </div>
    <noscript><p style="padding:40px 0;color:var(--ink-3);font-size:15px">筛选与搜索需要启用 JavaScript；上方已列出全部 ${apps.length} 款软件，可直接点击进入详情页。</p></noscript>
  </section>
</main>
${footerHTML(0)}`;

  return page({
    depth: 0,
    title: `${SITE.name} · ${SITE.tagline}`,
    desc: lede,
    canonical: SITE.url + '/',
    body,
    jsonld: {
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
  });
}

/* ---------- 6. 详情页 ---------- */
function buildDetail(a) {
  const depth = 1;
  const R = up(depth);
  const rel = byCat[a.cat].filter(x => x.slug !== a.slug).slice(0, 6);

  const metaCells = [];
  if (a.gh.repoUrl) {
    const isGitLab = a.gh.repoUrl.includes('gitlab.com');
    const shown = a.gh.repoFullName || a.gh.repoUrl.replace(/^https?:\/\//, '');
    metaCells.push(`<div class="meta__cell"><div class="meta__k">${isGitLab ? 'GitLab' : 'GitHub'} 仓库</div><div class="meta__v"><a href="${esc(a.gh.repoUrl)}" target="_blank" rel="noopener noreferrer">${esc(shown)}</a></div></div>`);
  }
  if (a.gh.stars) metaCells.push(`<div class="meta__cell"><div class="meta__k">Star</div><div class="meta__v">${esc(a.gh.stars)}</div></div>`);
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

  const body = `${headerHTML(depth, a.cat)}
<main class="wrap">
  <nav class="crumb" aria-label="面包屑">
    <a href="../index.html">全部软件</a><span>/</span>
    <a href="../category/${a.cat}.html">${esc(a.catName)}</a><span>/</span>
    <span>${esc(a.name)}</span>
  </nav>

  <header class="page-hd" data-tone="${a.tone}">
    ${iconHTML(a, 'ico page-hd__ico', 64).replace('__R__', R)}
    <div class="page-hd__main">
      <h1>${esc(a.name)}</h1>
      <p class="page-hd__tl">${esc(a.tagline)}</p>
      <div class="page-hd__acts">
        <button class="btn btn--accent" id="dGet" data-url="${esc(a.link)}"${a.pwd ? ` data-pwd="${esc(a.pwd)}"` : ''}>${a.pwd ? '复制提取码并打开网盘' : '打开网盘下载'}${ARROW}</button>
        ${repoBtn}
      </div>
    </div>
  </header>

  <div class="meta">${metaCells.join('')}</div>
${notices.length ? '  ' + notices.join('\n  ') + '\n' : ''}
  <div class="prose">
    <section class="blk"><h2>关于这款软件</h2><p>${esc(a.desc)}</p></section>
    <section class="blk"><h2>功能特点</h2><p>${esc(a.features)}</p></section>

    <section class="blk">
      <h2>下载 / 获取方式</h2>
      <div class="dl">
        <div class="dl__lab">百度网盘</div>
        <div class="dl__url">${esc(a.link)}</div>
        ${a.pwd ? `<div class="dl__pwd"><span>提取码</span><b>${esc(a.pwd)}</b><button class="btn btn--ghost btn--sm" data-copy="${esc(a.pwd)}">复制提取码</button></div>` : ''}
        <p class="dl__tip">资源整理自互联网，仅供个人学习与研究使用。建议同时前往官方仓库获取最新版本。</p>
        ${nonOssNote}
      </div>
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

  const descParts = [a.tagline, a.desc].filter(Boolean).join('。');
  const desc = descParts.length > 150 ? descParts.slice(0, 148) + '…' : descParts;

  return page({
    depth,
    title: `${a.name} — ${a.tagline} | ${SITE.name}`,
    desc,
    canonical: `${SITE.url}/apps/${a.slug}`,
    body,
    jsonld: {
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
  });
}

/* ---------- 7. 分类页 ---------- */
function buildCategory(c) {
  const list = byCat[c.id];
  const body = `${headerHTML(1, c.id)}
<main class="wrap">
  <nav class="crumb" aria-label="面包屑"><a href="../index.html">全部软件</a><span>/</span><span>${esc(c.name)}</span></nav>
  <section class="page-hd" data-tone="${c.tone}" style="border-bottom:0;padding-bottom:10px">
    <div class="page-hd__main">
      <h1>${esc(c.name)}</h1>
      <p class="page-hd__tl">共 ${list.length} 款开源软件</p>
    </div>
  </section>
  <div class="tools" style="top:64px;border-top:0">
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
    title: `${c.name} · 开源软件合集 | ${SITE.name}`,
    desc: `${SITE.name} 整理的${c.name}类开源软件共 ${list.length} 款：${list.map(a => a.name).join('、')}。全部免费开源、无广告。`,
    canonical: `${SITE.url}/category/${c.id}`,
    body,
  });
}

/* ---------- 8. 关于页 ---------- */
function buildAbout() {
  const body = `${headerHTML(0, 'about')}
<main class="wrap">
  <nav class="crumb" aria-label="面包屑"><a href="index.html">全部软件</a><span>/</span><span>关于本站</span></nav>
  <section class="page-hd" style="border-bottom:0">
    <div class="page-hd__main">
      <h1>关于本站</h1>
      <p class="page-hd__tl">一个只做开源软件的资源站</p>
    </div>
  </section>
  <div class="prose" style="max-width:none">
    <section class="blk"><h2>我们在做什么</h2>
      <p>${SITE.name} 收集整理那些值得被更多人用上的开源软件。挑选标准很简单：源码公开、免费使用、无广告、有在维护。目前收录 ${apps.length} 款，覆盖${cats.map(c => c.name).join('、')}。</p>
    </section>
    <section class="blk"><h2>每一条都查过</h2>
      <p>站内每款软件都逐一核实过官方代码仓库、开源协议与维护状态，详情页可以直接跳到作者仓库。核实过程中发现的问题——比如描述与实际功能不符、项目已停止维护、代码托管在 GitHub 之外——都会在该软件的详情页如实标注，不做美化。</p>
      <p>遇到确实无法核实的条目，我们会标明「待确认」而不是含糊带过。</p>
    </section>
    <section class="blk"><h2>如何使用</h2>
      <p>在首页按分类浏览或直接搜索，进入任意软件的详情页即可看到功能介绍、官方仓库地址与获取方式。下载链接为网盘转存，提取码可在详情页一键复制。</p>
    </section>
    <section class="blk"><h2>关于版权</h2>
      <p>本站收录的软件版权均归其作者所有，本站不提供任何破解、修改或商业授权版本。若您是权利人并认为本站内容不妥，请通过页脚联系方式告知，我们会立即处理。</p>
      <p>链接失效或版本过期属于常见情况，欢迎反馈。</p>
    </section>
  </div>
</main>
${footerHTML(0)}`;

  return page({
    depth: 0,
    title: `关于本站 | ${SITE.name}`,
    desc: `${SITE.name} 是一个只做开源软件的资源站，收录 ${apps.length} 款免费开源应用，覆盖${cats.map(c => c.name).join('、')}。`,
    canonical: `${SITE.url}/about`,
    body,
  });
}

/* ---------- 9. 404 ---------- */
/** 404 页会被任意层级的 URL 命中，所有本地引用必须是根绝对路径 */
function absolutize(html) {
  return html.replace(/(href|src)="(?!https?:|mailto:|#|data:|\/)([^"]*)"/g, '$1="/$2"');
}
function build404() {
  const body = `${headerHTML(0, '')}
<main class="wrap">
  <section class="hero">
    <p class="eyebrow">404</p>
    <h1>这个页面不存在。</h1>
    <p class="hero__lede">链接可能已经失效，或者你输错了地址。回到首页看看 ${apps.length} 款开源软件。</p>
    <div class="hero__acts"><a class="btn btn--solid" href="index.html">返回首页${ARROW}</a></div>
  </section>
</main>
${footerHTML(0)}`;
  return absolutize(page({ depth: 0, title: `页面不存在 | ${SITE.name}`, desc: '页面不存在', canonical: SITE.url + '/404', body }));
}

/* ---------- 10. 图标占位（favicon / og） ---------- */
function buildAssets() {
  fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'styles.css'), path.join(DIST, 'assets', 'styles.css'));
  fs.copyFileSync(path.join(SRC, 'app.js'), path.join(DIST, 'assets', 'app.js'));

  // favicon：珊瑚色方点，与站标一致
  fs.writeFileSync(path.join(DIST, 'assets', 'favicon.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#FAF9F5"/><rect x="9" y="9" width="14" height="14" rx="4" fill="#D97757"/></svg>\n`);

  // assets 根目录下的散件（og.png 等）直接随构建分发
  const assetsRoot = path.join(__dirname, 'assets');
  if (fs.existsSync(assetsRoot)) {
    for (const f of fs.readdirSync(assetsRoot)) {
      const p = path.join(assetsRoot, f);
      if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(DIST, 'assets', f));
    }
  }

  // 图标目录
  const iconOut = path.join(DIST, 'assets', 'icons');
  if (fs.existsSync(ICON_DIR)) {
    fs.mkdirSync(iconOut, { recursive: true });
    for (const f of fs.readdirSync(ICON_DIR)) {
      fs.copyFileSync(path.join(ICON_DIR, f), path.join(iconOut, f));
    }
  }
}

/* ---------- 11. 输出 ---------- */
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'apps'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'category'), { recursive: true });

fs.writeFileSync(path.join(DIST, 'index.html'), buildHome());
for (const a of apps) fs.writeFileSync(path.join(DIST, 'apps', `${a.slug}.html`), buildDetail(a));
for (const c of cats) fs.writeFileSync(path.join(DIST, 'category', `${c.id}.html`), buildCategory(c));
fs.writeFileSync(path.join(DIST, 'about.html'), buildAbout());
fs.writeFileSync(path.join(DIST, '404.html'), build404());
buildAssets();

/* sitemap */
const urls = [
  { loc: SITE.url + '/', pri: '1.0' },
  { loc: SITE.url + '/about', pri: '0.6' },
  ...cats.map(c => ({ loc: `${SITE.url}/category/${c.id}`, pri: '0.8' })),
  ...apps.map(a => ({ loc: `${SITE.url}/apps/${a.slug}`, pri: '0.7' })),
];
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><priority>${u.pri}</priority></url>`).join('\n') +
  `\n</urlset>\n`);

fs.writeFileSync(path.join(DIST, 'robots.txt'),
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE.url}/sitemap.xml\n`);

/* ---------- 12. 报告 ---------- */
const iconCount = apps.filter(a => a.icon).length;
const repoCount = apps.filter(a => a.gh.repoUrl).length;
console.log(`构建完成 → ${path.relative(ROOT, DIST)}`);
console.log(`  首页 1 · 详情页 ${apps.length} · 分类页 ${cats.length} · 关于 1 · 404 1`);
console.log(`  图标 ${iconCount}/${apps.length} · 已核实仓库 ${repoCount}/${apps.length}`);
console.log(`  sitemap URL ${urls.length} 条`);
if (excluded.length) {
  console.log(`\n未收录 ${excluded.length} 条（原因见下，可在 curation.json 里把 status 改回 ok 恢复）：`);
  for (const e of excluded) console.log(`  ✗ ${e.name}：${e.reason}`);
}
if (warnings.length) {
  console.log(`\n警告 ${warnings.length} 条：`);
  for (const w of warnings) console.log('  - ' + w);
}
