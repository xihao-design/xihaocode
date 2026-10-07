/* ============================================================
   F-Droid 索引发现源（主通道）
   ------------------------------------------------------------
   为什么这是更好的主源（对比 GitHub Search）：
     1. 每条都是一个「真能装」的 Android 开源 App，不存在把服务端项目
        当成手机应用捞进来的问题（GitHub Search 实测 18 个候选只有 2 个有 APK）
     2. APK 由 F-Droid 官方构建并签名，索引里直接给了 sha256
        —— 完整性有独立第三方背书，比只信 GitHub Release 更强
     3. 许可证、反特性（Ads/Tracking/…）、分类、minSdk 都是结构化字段
     4. 1081 个条目带官方中文摘要（localized['zh-CN'].summary），
        是人工翻译而非机器翻译，可以作为文案的事实来源
     5. 附源码压缩包名，GPL/AGPL 合规要的「对应源码」直接有出处

   索引地址：官方 f-droid.org 在本机不可达，实测清华 TUNA 镜像可用。
   索引约 59MB / 4385 个 App，本地缓存，默认 3 天刷新一次。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, warn, ensureDir, readJSON, writeJSON, slugify, nameKey } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(__dirname, 'state');
const CACHE = path.join(STATE, 'fdroid-index.json');

/** F-Droid 分类 → 站点六个分类。只给建议，最终由人确认 */
const CAT_MAP = {
  Multimedia: 'media', Reading: 'anime', 'News & Magazine': 'anime',
  System: 'system', Connectivity: 'system', Security: 'system',
  Internet: 'system', 'Keyboard & IME': 'system', Development: 'system',
  Graphics: 'image', Photography: 'image',
  Writing: 'focus', Time: 'focus', Productivity: 'focus', 'Local Media': 'focus',
  'Sports & Health': 'life', Navigation: 'life', Money: 'life', Food: 'life',
  Lifestyle: 'life', 'Science & Education': 'life', 'Theming': 'image',
  Phone: 'system', 'Phone & SMS': 'system', 'Voice & Video': 'media',
  'Text Editors': 'focus', 'File Sharing': 'system', 'File Transfer': 'system',
  'Maps & Navigation': 'life', 'Music & Audio': 'media', 'Video & Movies': 'media',
  'Podcast & Radio': 'media', 'Book & Reference': 'anime', 'E-Book': 'anime',
  Comics: 'anime', Calendar: 'focus', Notes: 'focus', Tasks: 'focus',
  Weather: 'life', Fitness: 'life', 'Health & Fitness': 'life',
};
/** 站点不收游戏：站点是「软件站」，塞游戏会跑偏分类体系 */
const GAME_RE = /game|arcade|puzzle|strategy|action|shooter|racing|sports game|board|card game/i;

export function mirrorList(cfg) {
  return (cfg.fdroid && cfg.fdroid.mirrors) || ['https://mirrors.tuna.tsinghua.edu.cn/fdroid/repo'];
}

/**
 * 索引瘦身：原始索引 59MB / 4385 个 App，其中绝大部分字段（捐赠地址、
 * 上百种语言的 localize、几十个历史版本条目）我们用不到。
 * 只保留判断与展示需要的字段，缓存能缩到几 MB，每天解析也不再卡。
 */
function pruneIndex(index) {
  const apps = [];
  for (const a of index.apps) {
    const loc = a.localized || {};
    const keepLoc = {};
    for (const k of ['zh-CN', 'zh-TW', 'en-US', 'en-GB']) if (loc[k]) keepLoc[k] = loc[k];
    const versions = index.packages[a.packageName] || [];
    const ver = versions.find(v => String(v.versionCode) === String(a.suggestedVersionCode)) || versions[0] || null;
    if (!ver) continue;
    apps.push({
      packageName: a.packageName,
      license: a.license || null,
      categories: a.categories || [],
      sourceCode: a.sourceCode || null,
      webSite: a.webSite || null,
      issueTracker: a.issueTracker || null,
      icon: a.icon || null,
      added: a.added || null,
      lastUpdated: a.lastUpdated || null,
      antiFeatures: a.antiFeatures || [],
      description: (a.description || '').slice(0, 4000),
      localized: keepLoc,
      ver: {
        apkName: ver.apkName, hash: ver.hash, hashType: ver.hashType, size: ver.size,
        versionCode: ver.versionCode, versionName: ver.versionName,
        minSdkVersion: ver.minSdkVersion, targetSdkVersion: ver.targetSdkVersion,
        nativecode: ver.nativecode || [], srcname: ver.srcname || null,
      },
    });
  }
  return {
    repo: { name: index.repo && index.repo.name, timestamp: index.repo && index.repo.timestamp, version: index.repo && index.repo.version },
    apps,
  };
}

/** 拉索引，带本地缓存。失败时回退到旧缓存（宁可数据旧一天，也不要当天没有产出） */
export async function loadIndex(cfg, { force = false } = {}) {
  const ttlDays = (cfg.fdroid && cfg.fdroid.cacheTtlDays) || 3;
  const cached = readJSON(CACHE, null);
  const fresh = cached && cached._fetchedAt
    && (Date.now() - new Date(cached._fetchedAt).getTime()) < ttlDays * 86400000;
  if (cached && fresh && !force) {
    log(`  F-Droid 索引：用本地缓存（${cached._fetchedAt.slice(0, 10)}，${cached.index.apps.length} 个 App）`);
    return cached;
  }

  for (const base of mirrorList(cfg)) {
    const url = `${base.replace(/\/+$/, '')}/index-v1.json`;
    try {
      const t0 = Date.now();
      const res = await fetch(url, { headers: { 'User-Agent': 'xihaouc-daily-collector' }, signal: AbortSignal.timeout(240000) });
      if (!res.ok) { warn(`  F-Droid 镜像 ${base} 返回 HTTP ${res.status}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const raw = JSON.parse(buf.toString('utf8'));
      if (!raw.apps || !raw.packages) { warn(`  F-Droid 镜像 ${base} 索引结构异常`); continue; }
      const index = pruneIndex(raw);
      ensureDir(STATE);
      writeJSON(CACHE, { _fetchedAt: new Date().toISOString(), _source: url, _rawBytes: buf.length, index });
      log(`  F-Droid 索引：${base} 拉取成功 ${(buf.length / 1048576).toFixed(1)}MB → 瘦身保留 ${index.apps.length} 个 App，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return { _fetchedAt: new Date().toISOString(), _source: url, _rawBytes: buf.length, index };
    } catch (e) {
      warn(`  F-Droid 镜像 ${base} 失败：${e.message}`);
    }
  }
  if (cached) {
    warn(`  所有 F-Droid 镜像都失败，改用本地缓存（${cached._fetchedAt.slice(0, 10)}）`);
    return cached;
  }
  warn('  F-Droid 索引不可用，本次跳过该发现源');
  return null;
}

/** 该 App 的 APK 直链（与索引同源，保证 sha256 对得上） */
export function apkUrl(base, apkName) {
  return `${String(base).replace(/\/+$/, '')}/${apkName}`;
}

export function licenseAllowed(license, cfg) {
  if (!license) return false;
  // F-Droid 用 SPDX 完整写法（GPL-3.0-only / GPL-3.0-or-later），要归一化后再比
  const norm = String(license).replace(/-(only|or-later)$/i, '');
  const allow = cfg.license.allow.map(l => l.replace(/-(only|or-later)$/i, ''));
  const deny = cfg.license.deny;
  if (deny.includes(license) || deny.includes(norm)) return false;
  return allow.includes(norm) || allow.includes(license);
}

/**
 * 从索引里筛出候选。
 * 硬性拒收：没有 GitHub 源码地址（站点要展示仓库信息）、协议不在白名单、
 *           含 Ads/Tracking/NoSourceSince 反特性、游戏分类、包名已收录。
 */
export function candidates(index, cfg, { seen = new Set(), siteNames = new Set(), date, excludePackages = new Set() } = {}) {
  const fc = cfg.fdroid || {};
  const bad = new Set(fc.rejectAntiFeatures || ['Ads', 'Tracking', 'NoSourceSince']);
  const softFlags = new Set(fc.flagAntiFeatures || ['NonFreeNet', 'TetheredNet', 'NonFreeDep', 'NonFreeAssets']);
  const skipCats = fc.excludeCategories || [];
  const days = fc.updatedWithinDays || 400;
  const cutoff = Date.now() - days * 86400000;
  const out = [];

  for (const app of index.apps) {
    const pkg = app.packageName;
    if (!pkg || excludePackages.has(pkg)) continue;
    if (seen.has(`fdroid:${pkg}`)) continue;

    const src = app.sourceCode || '';
    const m = src.match(/github\.com\/([^/\s#?]+)\/([^/\s#?]+)/i);
    if (!m) continue;
    const fullName = `${m[1]}/${m[2]}`.replace(/\.git$/i, '');

    if (!licenseAllowed(app.license, cfg)) continue;

    const af = app.antiFeatures || [];
    if (af.some(f => bad.has(f))) continue;

    const cats = app.categories || [];
    if (cats.some(c => GAME_RE.test(c))) continue;
    if (cats.some(c => skipCats.includes(c))) continue;

    const ver = app.ver;
    if (!ver || !ver.apkName) continue;

    const sizeMB = ver.size / 1048576;
    if (sizeMB > (cfg.filters.maxApkMB || 300) || sizeMB < (cfg.filters.minApkMB || 0.05)) continue;

    const updated = app.lastUpdated || app.added || 0;
    if (updated && updated < cutoff) continue;

    // 名称与文案要按 locale 分别找：zh-CN 常常只有 summary 没有 name，
    // 写成 `loc.name || en.name` 会因为 loc 取到 zh-CN 而短路，最后退化成包名末段。
    const zh = (app.localized && (app.localized['zh-CN'] || app.localized['zh-TW'])) || {};
    const tw = (app.localized && app.localized['zh-TW']) || {};
    const en = (app.localized && (app.localized['en-US'] || app.localized['en-GB'])) || {};
    const displayName = zh.name || tw.name || en.name || pkg.split('.').pop();
    const zhName = zh.name || tw.name || null;
    const zhSummary = zh.summary || tw.summary || null;
    const summary = en.summary || zhSummary || '';
    // 中文详细描述（很多 App 有 zh-TW 的完整功能列表），是撰写站点文案最靠谱的事实来源
    const zhDescription = zh.description || tw.description || null;
    const enDescription = en.description || app.description || '';
    // F-Droid 的图标文件名藏在各 locale 里（en-US.icon / zh-CN.icon），不在顶层
    const iconFile = app.icon || en.icon || zh.icon || null;
    if (siteNames.has(nameKey(displayName))) continue;

    out.push({
      source: 'fdroid',
      packageName: pkg,
      name: displayName,
      zhName,
      summary,
      zhSummary,
      description: enDescription,
      zhDescription,
      license: app.license,
      categories: cats,
      categorySuggestion: mapCategory(cats),
      antiFeatures: af,
      softFlags: af.filter(f => softFlags.has(f)),
      website: app.webSite || null,
      issueTracker: app.issueTracker || null,
      sourceCode: src,
      /** F-Droid 的图标文件名（首选仍是从 APK 里抠，这个只作兜底） */
      iconFile,
      repo: { fullName, owner: m[1], name: m[2], url: `https://github.com/${fullName}` },
      added: app.added || null,
      lastUpdated: updated || null,
      suggestedVersionName: ver.versionName || null,
      asset: {
        name: ver.apkName,
        size: ver.size,
        digest: ver.hash ? `sha256:${ver.hash}` : null,
        versionCode: ver.versionCode,
        versionName: ver.versionName,
        minSdk: ver.minSdkVersion,
        targetSdk: ver.targetSdkVersion,
        nativecode: ver.nativecode || [],
        srcname: ver.srcname || null,
      },
    });
  }
  return out;
}

export function mapCategory(cats = []) {
  for (const c of cats) {
    if (CAT_MAP[c]) return CAT_MAP[c];
    const key = Object.keys(CAT_MAP).find(k => k.toLowerCase() === String(c).toLowerCase());
    if (key) return CAT_MAP[key];
  }
  const joined = cats.join(' ');
  if (/multimedia|video|audio|music|podcast|radio/i.test(joined)) return 'media';
  if (/reading|comic|book|news/i.test(joined)) return 'anime';
  if (/graphics|photo|theming/i.test(joined)) return 'image';
  if (/writing|time|productivity|note|task|calendar/i.test(joined)) return 'focus';
  if (/health|sport|navigation|money|food|lifestyle|science/i.test(joined)) return 'life';
  return 'system';
}

/**
 * 打分：F-Droid 没有 Star 数，所以先用这些信号排序，
 * 再对靠前的候选查 GitHub 拿 Star 复核（见 collect.mjs）。
 */
export function score(cand) {
  let s = 0;
  if (cand.zhSummary) s += 6;              // 有官方中文摘要，中文站点适配度更高
  if (cand.zhName) s += 2;
  const ageDays = cand.lastUpdated ? (Date.now() - cand.lastUpdated) / 86400000 : 9999;
  if (ageDays < 60) s += 8; else if (ageDays < 180) s += 5; else if (ageDays < 365) s += 2;
  const sizeMB = cand.asset.size / 1048576;
  if (sizeMB >= 3 && sizeMB <= 60) s += 4;  // 太小多半是个壳，太大不适合网盘分发
  else if (sizeMB > 100) s -= 3;
  if (cand.softFlags.includes('TetheredNet')) s -= 10;   // 必须自建服务器才能用，对普通访客没意义
  if (cand.softFlags.length === 0) s += 3;
  if (cand.asset.digest) s += 2;
  if (cand.description && cand.description.length > 200) s += 3;
  if (cand.categories.some(c => /System|Internet|Multimedia|Reading|Security/i.test(c))) s += 2;
  return s;
}
