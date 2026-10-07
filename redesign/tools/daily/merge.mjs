#!/usr/bin/env node
/* ============================================================
   把每日采集产物并入站点数据
   ------------------------------------------------------------
   一次写入三处 + 一个图标：
     .kb-raw.json              ← 网盘链接 / 提取码 / 正文
     redesign/curation.json    ← 展示名 / 分类 / 一句话定位 / slug
     redesign/data/github.json ← 仓库 / Star / 协议 / 包名 / 备注
     redesign/assets/icons/    ← 图标文件

   拒收规则（宁可少发，不可发错）：
     · 文案空的（tagline/desc/features 任一为空）—— 不编造，缺就是不填
     · 没有网盘分享链接的（除非 allowNoLink）
     · slug / 包名 / 名称 / 仓库与站点已有条目重复

   本文件既可直接当命令跑，也导出 mergeDay() 供 publish.mjs 复用 ——
   这样「合并 → 建站 → 校验」能在一条命令里串起来，不依赖子进程管道。

   命令：
     node tools/daily/merge.mjs --date=2026-09-16
     node tools/daily/merge.mjs --date=2026-09-16 --dry-run
     node tools/daily/merge.mjs --date=2026-09-16 --allow-no-link
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { log, warn, fail, readJSON, writeJSON, ensureDir, today, nameKey } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(SITE_ROOT, '..');
const CFG = readJSON(path.join(__dirname, 'config.json'));

const KB_PATH = path.join(REPO_ROOT, '.kb-raw.json');
const CUR_PATH = path.join(SITE_ROOT, 'curation.json');
const GH_PATH = path.join(SITE_ROOT, 'data', 'github.json');
const ICON_DIR = path.join(SITE_ROOT, 'assets', 'icons');

/**
 * 图标来源的事实描述。
 * 为什么要分情况写：不同来源的可信度差很多，而 github.json 的备注是全站审计凭据，
 * 不能把「包里最大方形图」这种猜测写得像确凿事实（Meshtastic 就曾被它取到
 * res/drawable 里的通用头像素材，却按事实语句写了进去）。
 */
function iconNote(icon) {
  const size = icon.w ? `，${icon.w}×${icon.h}` : '';
  const where = icon.path ? `（${icon.path}${size}）` : (size ? `（${size.replace('，', '')}）` : '');
  switch (icon.source) {
    case 'arsc':
      return `图标由 APK 内的启动图标资源反查 resources.arsc 得到${where}。`;
    case 'filename':
      return `图标取自 APK 内 res/ 目录下的启动图标文件${where}。`;
    case 'repo-file':
      // 桌面端没有 APK 可抠图，图标**只能**来自源码仓库 —— 措辞要跟着变，
      // 否则备注会陈述一个不成立的事实（"APK 内没有可用的启动图标位图"对 exe 没有意义）
      return icon.kindDesktop
        ? `图标取自项目源码仓库中的官方素材${where}。`
        : `APK 内没有可用的启动图标位图，图标取自项目源码仓库中的官方素材${where}。`;
    case 'largest-square':
      return icon.verified
        ? `⚠ APK 内没有可信的启动图标位图，图标暂用「res 下最大方形图」${where}，已人工核对确认是应用图标。`
        : `⚠ 图标来源不可靠：APK 内没有可信的启动图标位图，暂用「res 下最大方形图」${where}，尚未人工核对。`;
    default:
      return `图标来源：${icon.source || '未知'}${where}。`;
  }
}

/**
 * 把某一天的采集产物合并进站点数据。
 * @param {object} [opts.bundle] 直接传入内存中的 bundle（publish 用）。
 *   为什么需要它：dry-run 时 publish 不会把链接写回 bundle.json（不写盘是对的），
 *   但 mergeDay 若是从磁盘重读，读到的就是还没填链接的旧内容，于是报告「可写入 0 个」——
 *   dry-run 结果完全失真。踩过这个坑，所以允许把内存对象传进来。
 * @returns {{ok:boolean, reason?:string, written:number, skipped:number, rows:number[], entries:Array}}
 */
export function mergeDay({ date, dryRun = false, allowNoLink = false, bundle: bundledOverride = null } = {}) {
  const DATE = String(date || today());
  const DRY = !!dryRun;
  const ALLOW_NO_LINK = !!allowNoLink;
  const DAY_DIR = path.join(CFG.output.root, DATE);

  const bundle = bundledOverride || readJSON(path.join(DAY_DIR, 'bundle.json'));
  if (!bundle) {
    fail(`找不到 ${path.join(DAY_DIR, 'bundle.json')}，先用 --date 指定已有的采集日期`);
    return { ok: false, reason: 'bundle-missing', written: 0, skipped: 0, rows: [], entries: [] };
  }
  const kb = readJSON(KB_PATH, []);
  const cur = readJSON(CUR_PATH);
  const gh = readJSON(GH_PATH);
  if (!Array.isArray(kb) || !cur || !cur.apps || !gh) {
    fail('站点数据文件读取失败，已中止');
    return { ok: false, reason: 'site-data-unreadable', written: 0, skipped: 0, rows: [] };
  }

  // 已有行号最大值 → 新条目从这里往后排
  let nextRow = Math.max(...kb.map(r => Number(r.row) || 0)) + 1;

  const existingSlugs = new Set();
  for (const [row, meta] of Object.entries(cur.apps)) {
    if (row.startsWith('_') || !meta) continue;
    const slug = meta.slug || (meta.name && /^[\x20-\x7e]+$/.test(meta.name)
      ? String(meta.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : null);
    if (slug) existingSlugs.add(slug);
  }
  const existingRepos = new Set();
  const existingPkgs = new Set();
  const existingNames = new Set();
  for (const [row, info] of Object.entries(gh)) {
    if (row.startsWith('_') || !info) continue;
    if (info.repoFullName) existingRepos.add(info.repoFullName.toLowerCase());
    if (info.pkg) existingPkgs.add(info.pkg);
    const meta = cur.apps[row];
    if (meta && meta.name) existingNames.add(nameKey(meta.name));
  }

  const accepted = [];
  const skipped = [];
  for (const a of bundle.apps || []) {
    const problems = [];
    if (!a.accepted) problems.push('accepted 不为 true');
    if (!a.tagline || !String(a.tagline).trim()) problems.push('tagline 为空（文案未写）');
    if (!a.desc || !String(a.desc).trim()) problems.push('desc 为空（文案未写）');
    if (!a.features || !String(a.features).trim()) problems.push('features 为空（文案未写）');
    if (!a.catSuggestion || !cur.categories.some(c => c.id === a.catSuggestion)) {
      problems.push(`分类非法：${a.catSuggestion}`);
    }
    if (!a.netdisk || !a.netdisk.shareUrl) {
      if (!ALLOW_NO_LINK) problems.push('没有网盘分享链接');
    }
    if (existingSlugs.has(a.slug)) problems.push(`slug 已存在：${a.slug}`);
    if (existingRepos.has((a.repo.fullName || '').toLowerCase())) problems.push(`仓库已收录：${a.repo.fullName}`);
    if (a.package && existingPkgs.has(a.package)) problems.push(`包名已收录：${a.package}`);
    if (existingNames.has(nameKey(a.name))) problems.push(`名称已收录：${a.name}`);

    if (problems.length) { skipped.push({ app: a, problems }); continue; }
    accepted.push(a);
  }

  log(`合并 ${DATE}：可写入 ${accepted.length} 个，跳过 ${skipped.length} 个`);
  for (const s of skipped) log(`  ⊘ ${s.app.name}：${s.problems.join('；')}`);
  if (!accepted.length) {
    // 把「拒收原因」分成两类带出去，publish 靠它决定退出码：
    //   已存在/已收录 → 良性（重跑，或者那天本来就发布过了）
    //   其余（文案没写、分类非法、没有链接…）→ 需要你动手
    // 判据用上面 problems 的文案：它们就在本文件里，改动时会一起看到。
    const ALREADY = /已存在|已收录/;
    const actionable = skipped.filter(s => s.problems.some(p => !ALREADY.test(p))).length;
    const alreadyOnly = skipped.length > 0 && actionable === 0;
    log('没有可写入的条目。若文案还没写，先编辑 bundle.json 的 tagline/desc/features。');
    return { ok: true, reason: 'nothing-to-write', written: 0, skipped: skipped.length, rows: [], actionable, alreadyOnly };
  }

  // 先备份，任何批量改写都要能退回去（dry-run 不写盘就不必备份）
  if (!DRY) {
    const backupDir = ensureDir(path.join(DAY_DIR, '_backup-data'));
    for (const [src, name] of [[KB_PATH, '.kb-raw.json'], [CUR_PATH, 'curation.json'], [GH_PATH, 'github.json']]) {
      fs.copyFileSync(src, path.join(backupDir, name));
    }
    log(`原数据已备份到 ${backupDir}`);
  }

  const rows = [];
  const entries = [];
  for (const a of accepted) {
    const row = nextRow++;
    rows.push(row);
    entries.push({ row, slug: a.slug, name: a.name });
    const catName = cur.categories.find(c => c.id === a.catSuggestion).name;
    const apkName = a.apk ? path.basename(a.apk.file) : a.asset.name;
    const isDesktop = a.source === 'desktop' || a.kind === 'desktop';

    /* 1) .kb-raw.json：网盘链接与正文（正文用的就是人工写的文案） */
    // 标题里的平台词必须跟着条目走：桌面条目写成「[安卓软件][…][安卓版][手机版]」
    // 会同时误导搜索引擎和用户（搜"安卓版"搜到一个 exe，是最好的劝退方式）
    kb.push({
      row,
      rawTitle: `${a.name}下载 - ${a.tagline}`,
      link: a.netdisk.shareUrl,
      pwd: a.netdisk.pwd || '',
      linkText: isDesktop
        ? `[电脑软件][${a.name}下载安装][${catName}][Windows版][最新版][电脑版][${a.tagline}]`
        : `[安卓软件][${a.name}下载安装][${catName}][安卓版][最新版][手机版][${a.tagline}]`,
      category: a.desc,
      features: a.features,
    });

    /* 2) curation.json：展示层 */
    cur.apps[String(row)] = { name: a.name, cat: a.catSuggestion, slug: a.slug, tagline: a.tagline };

    /* 3) github.json：核实结论。备注里只写实际验证到的事实 */
    // 桌面端没有 APK，也就没有包名/签名/minSdk 这三项可写 ——
    // 用 Android 的句子填空会变成"未读取到"这种假事实，所以按平台分成两句
    const assetNotes = isDesktop
      ? [
        `Release ${a.release.tag}（${(a.release.publishedAt || '').slice(0, 10) || '日期未知'}）的官方产物 ${apkName}，`
        + `${a.apk ? '已下载并核对 SHA-256 ' + a.apk.sha256.slice(0, 16) + '…' : '未下载'}。`,
        a.desktop && a.desktop.peVersionInfo && a.desktop.peVersionInfo.FileVersion
          ? `exe 内 VERSIONINFO 自报版本 ${a.desktop.peVersionInfo.FileVersion}${a.desktop.peVersionInfo.ProductName ? `，产品名 ${a.desktop.peVersionInfo.ProductName}` : ''}。`
          : '⚠ 未能从 exe 内读到 VERSIONINFO（部分打包器不写），版本以 release tag 为准。',
        a.desktop && a.desktop.mainExecutable ? `便携版压缩包已解包，主程序 ${a.desktop.mainExecutable}。` : '',
        '桌面软件：无 AndroidManifest，无包名与 APK 签名可验；平台以 Release 资产（Windows / x64 优先）判定。',
      ]
      : [
        `Release ${a.release.tag}（${(a.release.publishedAt || '').slice(0, 10) || '日期未知'}）的官方产物 ${apkName}，`
        + `${a.apk ? '已下载并核对 SHA-256 ' + a.apk.sha256.slice(0, 16) + '…' : '未下载'}。`,
        a.package ? `APK 内 AndroidManifest 实读包名 ${a.package}，版本 ${a.versionName || '?'}（code ${a.versionCode || '?'}），minSdk ${a.minSdk || '?'} / targetSdk ${a.targetSdk || '?'}。` : '包名未能读取。',
        a.signature ? (a.signature.signed ? `签名校验：已签名（${a.signature.schemes.join(' + ')}）。` : '⚠ 未检出签名，装机可用性存疑。') : '',
      ];
    const notes = [
      ...assetNotes,
      a.icon ? iconNote(a.icon) : (isDesktop ? '⚠ 未能从源码仓库取到官方图标，站点将显示首字标记。' : '⚠ 未能从 APK 中提取图标，站点将显示首字标记。'),
      a.appLabel && a.appLabel !== a.name ? `应用内显示名称为「${a.appLabel}」。` : '',
      `项目原始描述：${a.repoDesc || '（无）'}`,
      `采集日期 ${DATE}。`,
    ].filter(Boolean).join(' ');
    gh[String(row)] = {
      isOpenSource: true,
      repoFullName: a.repo.fullName,
      repoUrl: a.repo.url,
      stars: String(a.repo.stars),
      license: a.repo.license,
      platform: a.platform || 'Android',
      pkg: a.package || null,
      iconUrl: null,
      iconFallbackUrl: null,
      confidence: a.signature && a.signature.signed && a.package && a.icon ? 'high' : 'medium',
      notes,
    };

    /* 4) 图标落地（dry-run 时绝不写盘） */
    if (a.icon && a.icon.file) {
      const src = path.join(DAY_DIR, a.icon.file);
      if (!fs.existsSync(src)) {
        warn(`  图标文件不存在：${src}（站点会退化成首字标记）`);
      } else if (DRY) {
        log(`  · 图标 ${path.basename(src)} 待复制（--dry-run 未写盘）`);
      } else {
        ensureDir(ICON_DIR);
        const ext = path.extname(src);
        fs.copyFileSync(src, path.join(ICON_DIR, a.slug + ext));
        log(`  ✓ 图标 ${a.slug}${ext} 已放入 assets/icons/`);
      }
    } else {
      warn(`  ${a.name} 没有图标，站点会退化成首字标记（可手动放一张 PNG 到 assets/icons/${a.slug}.png）`);
    }

    log(`  ✓ 第 ${row} 行 ← ${a.name}（${a.catSuggestion}）${a.netdisk && a.netdisk.shareUrl ? a.netdisk.shareUrl : '（无分享链接，allowNoLink）'}`);
  }

  if (DRY) {
    log('\n--dry-run：以上改动没有写盘。去掉 --dry-run 才会真正写入。');
    return { ok: true, dryRun: true, written: 0, wouldWrite: accepted.length, skipped: skipped.length, rows, entries };
  }
  writeJSON(KB_PATH, kb);
  writeJSON(CUR_PATH, cur);
  writeJSON(GH_PATH, gh);
  log('\n已写入：');
  log(`  ${KB_PATH}`);
  log(`  ${CUR_PATH}`);
  log(`  ${GH_PATH}`);
  log('若要撤销：把 _backup-data/ 里的三个文件复制回去即可。');
  return { ok: true, written: accepted.length, skipped: skipped.length, rows, entries };
}

/* ---------- 命令行入口 ---------- */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => {
    const hit = argv.find(a => a === `--${n}` || a.startsWith(`--${n}=`));
    if (!hit) return d;
    const eq = hit.indexOf('=');
    return eq > 0 ? hit.slice(eq + 1) : true;
  };
  const r = mergeDay({
    date: arg('date', today()),
    dryRun: !!arg('dry-run', false),
    allowNoLink: !!arg('allow-no-link', false),
  });
  if (!r.ok) process.exitCode = 1;
  else if (!r.dryRun) log('下一步：node redesign\\build.mjs（或直接跑 publish.mjs，它会连带建站与校验）');
}
