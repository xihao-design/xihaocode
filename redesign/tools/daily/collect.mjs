#!/usr/bin/env node
/* ============================================================
   XihaoUC 每日采集主流程
   ------------------------------------------------------------
   三个发现源，主次分明：
     主：F-Droid 索引
         每条都是真能装的 Android 开源 App，自带官方 sha256 与签名构建，
         还有 1081 条官方中文摘要。产量稳定，不会把服务端项目当成手机应用。
     补：GitHub Search
         用于捞 F-Droid 没收录的高星项目。这里的检索词做了 Android 硬约束，
         并且加了一道「必须像应用、不能像库/服务端」的闸门。
     新：电脑软件（Windows）—— 实现在 tools/daily/desktop.mjs
         桌面端**没有 APK 可当铁证**，所以确凿证据是「Release 里真有能装的 Windows
         资产」+「描述不像库/框架/服务端」。整段绕开 APK 解析：版本取 release tag
         （再从 exe 的 PE 头读一条独立佐证）、校验用 GitHub 官方 digest、图标走源码
         仓库。**配额独立**（默认 2 个/天），不占手机 App 的 4 个 —— 桌面包大一个
         量级，网盘上传是真实瓶颈，两边不该互相挤。

   一天跑一次，按顺序做六件事：
     发现 → 核实（真有能装的东西才算数）→ 下载（校验 sha256）→ 解析（包名/图标；桌面端跳过）
     → 产出（安装包 + 图标 + 审核表 + 网盘上传目录）

   文案（tagline / desc / features）刻意不由脚本生成 —— 站点原则是「不编造」，
   机器翻译出来的卖点文案就是编造。这一层留给人工/AI 复核时写。
   （F-Droid 的官方中文摘要会作为事实来源一并放进 bundle，供撰写时参考。）

   命令：
     node tools/daily/collect.mjs                       # 正常跑（含电脑软件通道）
     node tools/daily/collect.mjs --quota=5             # 临时改手机 App 数量
     node tools/daily/collect.mjs --desktop-quota=1     # 临时改电脑软件数量（独立名额）
     node tools/daily/collect.mjs --no-desktop          # 本轮不跑电脑软件通道
     node tools/daily/collect.mjs --desktop-only        # 只跑电脑软件通道
     node tools/daily/collect.mjs --only=owner/repo     # 只处理指定仓库（调试，两个通道都认）
     node tools/daily/collect.mjs --no-download         # 只出清单，不下安装包
     node tools/daily/collect.mjs --no-netdisk          # 跳过网盘环节
     node tools/daily/collect.mjs --fresh               # 忽略历史，重新检查
     node tools/daily/collect.mjs --github-only         # 只走 GitHub 通道
     node tools/daily/collect.mjs --fdroid-only         # 只走 F-Droid 通道
     node tools/daily/collect.mjs --refresh-index       # 强制刷新 F-Droid 索引
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  searchRepos, getRepo, listReleases, pickApkRelease, downloadTo, fetchSmall, rawUrl, hasToken, tokenSource, quota,
  fetchRepoIcon,
} from './channels.mjs';
import * as FD from './fdroid.mjs';
import { inspectApk } from './apk.mjs';
import { archiveKind, unzipPortable, readPeVersionInfo } from './archive.mjs';
import { uploadBundle, netdiskAvailable, manualUploadScript } from './netdisk.mjs';
import { writeLinksSheet, writeManualGuide } from './manual.mjs';
import {
  log, warn, ok, fail, openLog, closeLog, ensureDir, readJSON, writeJSON,
  today, dayIndex, daysAgoISO, sleep, slugify, nameKey, humanSize, escapeMd,
} from './util.mjs';
import { discoverDesktop, loadDesktopCfg } from './desktop.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, '..', '..');        // redesign/
const REPO_ROOT = path.resolve(SITE_ROOT, '..');              // 仓库根
const STATE_DIR = path.join(__dirname, 'state');

/* ---------- 命令行参数 ---------- */
const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq > 0 ? hit.slice(eq + 1) : true;
};
const DATE = String(arg('date', today()));
const DRY_NO_DOWNLOAD = !!arg('no-download', false);
const SKIP_NETDISK = !!arg('no-netdisk', false);
const FRESH = !!arg('fresh', false);
const ONLY = arg('only', null);
const GITHUB_ONLY = !!arg('github-only', false);
const FDROID_ONLY = !!arg('fdroid-only', false);
const REFRESH_INDEX = !!arg('refresh-index', false);

const cfg = readJSON(path.join(__dirname, 'config.json'));
if (arg('quota')) cfg.quota = Math.max(1, parseInt(arg('quota'), 10) || cfg.quota);
cfg.desktop = cfg.desktop || {};
// tools/desktop/config.json 读一次，后面发现与核实都用这一份，避免两处读盘读出不一致
const DESKTOP_CFG = loadDesktopCfg(cfg).cfg;

/* ---------- 电脑软件通道：独立配额、独立开关 ----------
   为什么配额独立：桌面包比 APK 大一个量级，网盘上传是真实瓶颈。
   收进同一份配额会两头难受 —— 要么手机 App 被挤掉，要么桌面包撑爆上传时间。
   所以 config.desktop.quota 是**额外**的名额（默认 2 个/天），--quota 不影响它。 */
const DESKTOP_ENABLED = cfg.desktop.enabled !== false && !arg('no-desktop', false);
const DESKTOP_ONLY_MODE = !!arg('desktop-only', false);
const DESKTOP_QUOTA = Math.max(0, parseInt(arg('desktop-quota', cfg.desktop.quota != null ? cfg.desktop.quota : 2), 10) || 0);
// --desktop-only 的含义是「只跑桌面」：手机那两源整体跳过，桌面配额照给。
// 若同时没启用桌面通道，这个组合等于什么都不跑，明确拦下来。
if (DESKTOP_ONLY_MODE && !DESKTOP_ENABLED) {
  fail('--desktop-only 与 --no-desktop 互斥，这样跑不出任何东西。去掉其中一个。');
  process.exit(1);
}

const OUT_ROOT = cfg.output.root;
const DAY_DIR = path.join(OUT_ROOT, DATE);
ensureDir(DAY_DIR);
openLog(path.join(DAY_DIR, 'log.txt'));

/* ---------- 站点已有条目：用来去重 ---------- */
function loadSiteIndex() {
  const gh = readJSON(path.join(SITE_ROOT, 'data', 'github.json'), {});
  const curation = readJSON(path.join(SITE_ROOT, 'curation.json'), { apps: {} });
  const repos = new Map();
  const names = new Map();
  const pkgs = new Set();
  for (const [row, info] of Object.entries(gh)) {
    if (row.startsWith('_') || !info) continue;
    if (info.repoFullName) repos.set(info.repoFullName.toLowerCase(), `站点第 ${row} 行`);
    if (info.pkg) pkgs.add(info.pkg);
    const meta = curation.apps[row];
    if (meta && meta.name) names.set(nameKey(meta.name), meta.name);
  }
  return { repos, names, pkgs };
}

/* ---------- 状态：记住处理过的对象，省 API 配额 ---------- */
function loadState() {
  const st = readJSON(path.join(STATE_DIR, 'seen.json'), null) || {};
  st.repos = st.repos || {};
  st.fdroid = st.fdroid || {};
  st.names = st.names || {};
  return st;
}
function saveState(st) {
  writeJSON(path.join(STATE_DIR, 'seen.json'), {
    _note: '检查过的仓库/包名与结论。避免每天重复消耗 API 配额，也避免重复收录。',
    _updated: DATE,
    repos: st.repos,
    fdroid: st.fdroid,
    names: st.names,
  });
}
function loadPending() { return readJSON(path.join(STATE_DIR, 'pending.json'), null) || { items: [] }; }
function savePending(p) {
  writeJSON(path.join(STATE_DIR, 'pending.json'), {
    _note: '已核实通过、但当天配额用完没交付的候选。下次优先交付，且不用再花 API 复查。',
    _updated: DATE,
    items: p.items,
  });
}

/* ---------- 分类猜测（F-Droid 有结构化分类，GitHub 只能靠关键词） ---------- */
const CAT_RULES = [
  ['anime', /anime|comic|manga|novel|light novel|bangumi|danmaku|acg|番|漫画|小说|追番|弹幕|reader|reading|ebook|book/i],
  ['media', /music|audio|player|video|movie|podcast|radio|stream|lyric|equalizer|mpv|vlc|youtube|bilibili|iptv|影音|音乐|播放|直播/i],
  ['image', /image|photo|gallery|camera|watermark|screenshot|ocr|paint|wallpaper|icon pack|图片|相册|相机|水印|壁纸/i],
  ['focus', /note|todo|task|habit|calendar|markdown|rss|wiki|pomodoro|clipboard|password|journal|diary|bookmark|笔记|待办|习惯|日历|密码/i],
  ['life', /weather|fitness|workout|health|medic|sleep|food|recipe|nutrition|finance|expense|map|navigation|transit|tracker|water|天气|健身|健康|睡眠|饮食|记账|地图|导航/i],
  ['system', /launcher|keyboard|file manager|cleaner|root|adb|terminal|battery|permission|vpn|firewall|dns|recorder|flashlight|clock|automation|tool|系统|工具|清理|键盘|桌面/i],
];
function guessCategory(text) {
  for (const [cat, re] of CAT_RULES) if (re.test(text)) return cat;
  return 'system';
}

/* ---------- 风险标记：只提示，不代替人判断 ----------
   @param {string[]} [extra] 调用方补的标记（例如桌面端的分发形态提醒） */
function riskFlags({ name, desc, topics, license, source, fdroidInfo }, extra = []) {
  const hay = [name, desc, (topics || []).join(' ')].join(' ');
  const hits = (cfg.compliance.contentRiskKeywords || []).filter(k => hay.toLowerCase().includes(k.toLowerCase()));
  const flags = [];
  if (hits.length) {
    flags.push(`内容风险：命中 ${hits.slice(0, 4).join('、')}。站内 legado 已有作者因侵权担责的先例，这类务必你点头再发。`);
  }
  if (['AGPL-3.0', 'GPL-3.0', 'GPL-2.0'].includes(String(license).replace(/-(only|or-later)$/i, ''))) {
    flags.push(`协议义务：${license} 要求随包提供源码获取方式（README.txt 里已写入源码与源码包地址）。`);
  }
  if (source === 'fdroid') {
    if (fdroidInfo.antiFeatures.includes('TetheredNet')) {
      flags.push('可用性风险：F-Droid 标记为 TetheredNet —— 该 App 是自托管服务的前端，必须你/用户自建服务器才能用，单独安装无法工作。');
    }
    if (fdroidInfo.antiFeatures.includes('NonFreeNet')) {
      flags.push('依赖非自由网络服务（F-Droid 标记 NonFreeNet）：功能依赖某个闭源在线服务，该服务随时可能停服。');
    }
    if (fdroidInfo.antiFeatures.includes('NonFreeAssets')) {
      flags.push('含非自由素材（图标/字体等不在开源授权范围内），展示时需保留出处。');
    }
  }
  for (const e of extra) if (e && !flags.includes(e)) flags.push(e);
  return flags;
}

/* ---------- 「像应用」还是「像库/服务端」 ---------- */
const LIB_SIGNAL = /\b(library|sdk|framework|plugin for|wrapper|binding|widget library|sample app|demo app|boilerplate|template for|api client for|toolchain|gradle plugin|annotation processor|self-hosted|docker|kubernetes|helm chart|nginx|postgres|mysql|backend|server-side|web app|browser extension|chrome extension|vscode extension|cli tool|neovim|wordpress|nextcloud app)\b/i;
const APP_SIGNAL = /\b(app|application|client|player|reader|manager|viewer|editor|launcher|browser|downloader|tracker|reminder|wallet|notes?|gallery|camera|keyboard|cleaner|scanner|converter|monitor|timer|clock|calculator|translator|explorer|chat|messenger)\b/i;
const ANDROID_TIMES = /\b(android|f-droid|fdroid|apk|play store|material you|jetpack compose)\b/i;

/**
 * Android 硬约束。
 * 早前只靠 APP_SIGNAL，结果 self-hosted 那批服务端项目全被放进来，
 * 18 个候选里只有 2 个真有 APK。现在必须同时满足「像 Android 应用」。
 */
function androidAppCheck(repo) {
  const topics = (repo.topics || []).map(t => t.toLowerCase());
  const hay = [repo.name, repo.desc, topics.join(' ')].join(' ');
  let score = 0;
  if (topics.some(t => ['android', 'android-app', 'android-application', 'android-client', 'f-droid', 'kotlin-android', 'jetpack-compose', 'compose-android', 'material-you', 'android-ui', 'android-widget', 'wear-os'].includes(t))) score += 5;
  if (ANDROID_TIMES.test(hay)) score += 3;
  if (['Kotlin', 'Java', 'Dart'].includes(repo.lang)) score += 2;
  if (/\b(apk|fdroid|f-droid|material you|compose)\b/i.test(hay)) score += 2;
  if (LIB_SIGNAL.test(hay)) score -= 6;
  if (!APP_SIGNAL.test(hay)) score -= 3;
  return { score, ok: score > 0 };
}

function scoreGithubCandidate(repo) {
  let s = Math.log10(Math.max(repo.stars, 1)) * 10;
  if (repo.desc && repo.desc.length > 30) s += 3;
  if ((repo.topics || []).some(t => ['android', 'android-app', 'android-application'].includes(t))) s += 4;
  if (['MIT', 'Apache-2.0'].includes(repo.license)) s += 2;
  if (['Kotlin', 'Java', 'Dart'].includes(repo.lang)) s += 3;
  const days = (Date.now() - new Date(repo.pushedAt).getTime()) / 86400000;
  if (days < 30) s += 5; else if (days < 90) s += 3; else if (days < 180) s += 1;
  return s;
}

/* ---------- GitHub 检索切片：每天换一批，且限定 Android ---------- */
function buildSearchSpecs(discovery, minStars) {
  const specs = [];
  for (const t of discovery.topics) {
    for (const band of discovery.starBands) {
      specs.push({ q: `topic:${t} stars:${band} archived:false fork:false`, sort: 'stars' });
    }
  }
  for (const k of discovery.keywords) {
    specs.push({ q: `topic:android ${k} stars:>=${minStars} archived:false fork:false`, sort: 'stars' });
  }
  specs.push({ q: `topic:android stars:>=${minStars} pushed:>=${daysAgoISO(120)} archived:false fork:false`, sort: 'updated' });
  return specs;
}

/* ---------- 组装 F-Droid 候选项的统一结构 ---------- */
function makeFdroidRec(c, repo, cfg, cache) {
  const base = (cfg.fdroid.mirrors || [])[0];
  return {
    source: 'fdroid',
    /** 应用展示名（可能含中文），与下面的 repo 字段是两回事：
     *  repo 来自 GitHub 复核，里面没有「应用叫什么」这个信息。 */
    displayName: c.name,
    repo: repo || {
      fullName: c.repo.fullName, owner: c.repo.owner, name: c.repo.name,
      url: c.repo.url, stars: null, license: c.license,
      lang: null, topics: [], archived: false, pushedAt: null, createdAt: null,
      homepage: c.website, defaultBranch: 'main', forks: null, openIssues: null,
      desc: c.summary || '',
    },
    release: {
      tag: `v${c.asset.versionName || ''}`,
      name: `${c.name} ${c.asset.versionName || ''}`.trim(),
      publishedAt: c.lastUpdated ? new Date(c.lastUpdated).toISOString() : null,
      body: null,
    },
    asset: {
      name: c.asset.name, size: c.asset.size, downloads: null,
      url: FD.apkUrl(base, c.asset.name), digest: c.asset.digest,
    },
    assetUrls: (cfg.fdroid.mirrors || []).slice(1).map(b => FD.apkUrl(b, c.asset.name)),
    otherApks: [],
    fdroid: {
      packageName: c.packageName,
      versionName: c.asset.versionName, versionCode: c.asset.versionCode,
      minSdk: c.asset.minSdk, targetSdk: c.asset.targetSdk,
      nativecode: c.asset.nativecode, srcname: c.asset.srcname,
      license: c.license, categories: c.categories, antiFeatures: c.antiFeatures,
      summary: c.summary, zhSummary: c.zhSummary, zhName: c.zhName,
      description: c.description, zhDescription: c.zhDescription || null,
      website: c.website, issueTracker: c.issueTracker,
      iconFile: c.iconFile || null,
      lastUpdated: c.lastUpdated, added: c.added,
      indexSource: cache._source, indexFetchedAt: cache._fetchedAt,
    },
    checkedAt: DATE,
  };
}

/* ---------- 图标兜底：从源码仓库里找 ----------
   实现在 channels.mjs（网络层），因为「按仓库路径试探取图」本身就是网络行为，
   放在那边补数脚本也能复用同一份逻辑，不会两边各写一套而慢慢跑偏。 */

/* ============================================================
   主流程
   ============================================================ */
async function main() {
  log('════════════════════════════════════════════════');
  log(`XihaoUC 每日采集  ${DATE}`);
  log(`手机 App 配额 ${cfg.quota} 个 · 电脑软件配额 ${DESKTOP_ENABLED ? DESKTOP_QUOTA + ' 个（Windows，独立名额）' : '已关闭'}`);
  log(`GitHub Token ${hasToken ? '已配置（' + tokenSource + '）' : '未配置（核心 API 60 次/小时）'}`);
  log('════════════════════════════════════════════════');

  const site = loadSiteIndex();
  const state = loadState();
  const pending = loadPending();
  log(`站点已收录 ${site.repos.size} 个仓库 / ${site.pkgs.size} 个包名；历史记录 ${Object.keys(state.repos).length} 仓库 / ${Object.keys(state.fdroid).length} 包名；待交付 ${pending.items.length} 个`);
  warnUnpublished(DAY_DIR);

  const accepted = [];        // Android 最终交付（rec 结构）
  const rejected = [];        // 落选（含原因）
  const downloadFailures = [];
  const desktopAccepted = []; // 电脑软件最终交付（rec 结构，配额独立）

  /* ---------- 阶段 1：先消费上一轮遗留 ---------- */
  log('\n【1/6】处理上一轮遗留候选');
  const usablePending = [];
  for (const it of pending.items) {
    // 只认结构完整的遗留项。早前版本的遗留项可能没有 source/asset，
    // 那种直接丢弃并说明原因，避免把结构不对的东西当成品交付。
    if (!it || !it.repo || !it.source) { log(`  ⊘ 丢弃一条结构不完整的遗留项（${it && it.repo ? it.repo.fullName : '无仓库信息'}）`); continue; }
    if (it.source === 'fdroid' && (!it.asset || !it.fdroid)) { log(`  ⊘ 丢弃结构不完整的 F-Droid 遗留项（${it.repo.fullName}）`); continue; }
    if (it.source === 'github' && !it.asset) { log(`  ⊘ 丢弃未核实的 GitHub 遗留项（${it.repo.fullName}）`); continue; }
    usablePending.push(it);
  }
  if (usablePending.length !== pending.items.length) {
    log(`  遗留队列 ${pending.items.length} 条 → 可用 ${usablePending.length} 条`);
  }
  pending.items = usablePending;
  for (const it of pending.items) {
    if (accepted.length >= cfg.quota) break;
    accepted.push(it);
    log(`  ✓ [${it.source}] ${it.repo.fullName}（${it.release ? it.release.tag : '—'}）沿用上次已核实的结果`);
  }
  pending.items = pending.items.filter(it => !accepted.includes(it));
  if (!accepted.length) log('  · 没有可用的遗留候选');

  /* ---------- 阶段 2：F-Droid 主通道 ---------- */
  if (!GITHUB_ONLY && !DESKTOP_ONLY_MODE && accepted.length < cfg.quota) {
    log('\n【2/6】发现候选（F-Droid 主通道）');
    const cache = await FD.loadIndex(cfg, { force: REFRESH_INDEX });
    if (cache) {
      const excludePkgs = new Set([...site.pkgs]);
      for (const k of Object.keys(state.fdroid)) excludePkgs.add(k);
      const seen = new Set(Object.keys(state.fdroid).map(k => `fdroid:${k}`));

      const cands = FD.candidates(cache.index, cfg, {
        seen, siteNames: new Set(site.names.keys()), excludePackages: excludePkgs, date: DATE,
      });
      log(`  符合硬条件的候选 ${cands.length} 个（共 ${cache.index.apps.length} 个 App）`);

      const ranked = cands.map(c => ({ c, s: FD.score(c) })).sort((a, b) => b.s - a.s);
      const enrichTop = Math.min(ranked.length, cfg.fdroid.githubEnrichTop || 16);
      log(`  取分数最高的 ${enrichTop} 个去 GitHub 复核 Star / 归档状态（每次 1 次核心 API 调用）`);

      const base = (cfg.fdroid.mirrors || [])[0];
      for (const { c } of ranked.slice(0, enrichTop)) {
        if (accepted.length >= cfg.quota) break;
        const key = c.repo.fullName.toLowerCase();
        try {
          const repo = await getRepo(c.repo.fullName);
          if (repo.archived && !cfg.filters.allowArchived) { rejected.push({ repo, why: '仓库已归档（F-Droid 通道）' }); continue; }
          const days = (Date.now() - new Date(repo.pushedAt).getTime()) / 86400000;
          if (days > cfg.filters.pushedWithinDays) { rejected.push({ repo, why: `GitHub 仓库超过 ${cfg.filters.pushedWithinDays} 天没更新（F-Droid 通道）` }); continue; }
          if ((cfg.fdroid.minStars || 0) > 0 && repo.stars < cfg.fdroid.minStars) {
            rejected.push({ repo, why: `Star 不足 ${cfg.fdroid.minStars}（F-Droid 通道，★${repo.stars}）` }); continue;
          }
          const assetUrls = (cfg.fdroid.mirrors || []).slice(1).map(b => FD.apkUrl(b, c.asset.name));
          const rec = makeFdroidRec(c, repo, cfg, cache);
          rec.assetUrls = assetUrls;
          accepted.push(rec);
          log(`  ✓ ${repo.fullName}（★${repo.stars}）${c.packageName} ${c.asset.versionName} · ${c.license} · ${humanSize(c.asset.size)}${c.zhSummary ? ' · 有官方中文摘要' : ''}`);
          state.fdroid[c.packageName] = { firstSeen: DATE, lastRun: DATE, stage: 'accepted', repo: repo.fullName };
          await sleep(300);
        } catch (e) {
          if (e.rateLimited) { fail('  GitHub 核心 API 配额耗尽，F-Droid 通道的复核中止'); break; }
          if (e.notFound) {
            rejected.push({ repo: c.repo, why: 'GitHub 仓库不存在或已改名（F-Droid 索引里的源码地址失效）' });
            state.fdroid[c.packageName] = { firstSeen: DATE, lastRun: DATE, stage: 'rejected', why: 'repo-not-found' };
            continue;
          }
          warn(`  ✗ ${c.repo.fullName} 复核失败：${e.message}`);
        }
      }
      // 没轮上的 F-Droid 候选刻意不记进遗留队列：
      // 索引会缓存 3 天、评分是确定性的，而且这些包名没有被标记为 seen，
      // 明天它们自然就是下一批最高分，零额外成本。写进队列反而会污染它。
      if (!accepted.filter(a => a.source === 'fdroid').length) log('  · F-Droid 通道本轮没有产出');
    }
  } else if (GITHUB_ONLY) {
    log('\n【2/6】--github-only：跳过 F-Droid 通道');
  } else if (DESKTOP_ONLY_MODE) {
    log('\n【2/6】--desktop-only：跳过 F-Droid 通道');
  }

  /* ---------- 阶段 3：GitHub 补充通道 ---------- */
  if (!FDROID_ONLY && !DESKTOP_ONLY_MODE && accepted.length < cfg.quota) {
    log(`\n【3/6】发现候选（GitHub 补充通道，还差 ${cfg.quota - accepted.length} 个）`);
    const specs = buildSearchSpecs(cfg.discovery, cfg.filters.minStars);
    const start = dayIndex() % specs.length;
    const picks = [];
    for (let i = 0; i < cfg.discovery.searchesPerRun; i++) picks.push(specs[(start + i) % specs.length]);
    log(`  本轮检索切片 ${start}~${(start + picks.length - 1) % specs.length}（共 ${specs.length} 个切片轮换）`);

    const candidates = [];
    const seenFull = new Set();
    for (const spec of picks) {
      const page = 1 + (dayIndex() % cfg.discovery.pageRotation);
      try {
        const r = await searchRepos(spec.q, { sort: spec.sort, order: 'desc', page, perPage: cfg.discovery.perPage });
        log(`  「${spec.q}」第 ${page} 页 → ${r.total} 命中，取回 ${r.items.length} 个`);
        for (const it of r.items) {
          const key = it.fullName.toLowerCase();
          if (seenFull.has(key)) continue;
          seenFull.add(key);
          candidates.push(it);
        }
      } catch (e) {
        fail(`  检索失败（${spec.q}）：${e.message}`);
        if (e.rateLimited) break;
      }
      await sleep(6500);   // 搜索 API 未认证 10 次/分钟，留余量
    }

    log('  粗筛中…');
    const pool = [];
    const filters = cfg.filters;
    for (const c of candidates) {
      const key = c.fullName.toLowerCase();
      if (site.repos.has(key)) { rejected.push({ repo: c, why: '站点已收录' }); continue; }
      if (!FRESH && state.repos[key]) { rejected.push({ repo: c, why: `历史已检查：${state.repos[key].stage}` }); continue; }
      if (site.names.has(nameKey(c.name)) || state.names[nameKey(c.name)]) { rejected.push({ repo: c, why: '名称与已收录条目重复' }); continue; }
      if (c.archived && !filters.allowArchived) { rejected.push({ repo: c, why: '仓库已归档' }); continue; }
      if (c.stars < filters.minStars) { rejected.push({ repo: c, why: `Star 不足（${c.stars} < ${filters.minStars}）` }); continue; }
      const days = (Date.now() - new Date(c.pushedAt).getTime()) / 86400000;
      if (days > filters.pushedWithinDays) { rejected.push({ repo: c, why: `超过 ${filters.pushedWithinDays} 天没更新` }); continue; }
      if (!c.desc) { rejected.push({ repo: c, why: '没有项目描述' }); continue; }
      if (filters.requireLicense && !c.license) { rejected.push({ repo: c, why: '没有开源协议（不允许再分发）' }); continue; }
      if (cfg.license.deny.includes(c.license)) { rejected.push({ repo: c, why: `协议不允许再分发：${c.license}` }); continue; }
      if (!cfg.license.allow.includes(c.license)) { rejected.push({ repo: c, why: `协议不在白名单：${c.license}` }); continue; }

      const a = androidAppCheck(c);
      if (!a.ok) { rejected.push({ repo: c, why: `不像 Android 应用（Android 特征分 ${a.score}）` }); continue; }
      c.score = scoreGithubCandidate(c) + a.score;
      c.androidScore = a.score;
      pool.push(c);
    }
    log(`  粗筛通过 ${pool.length} 个，落选 ${rejected.length} 个`);

    pool.sort((a, b) => b.score - a.score);
    const toCheck = pool.slice(0, Math.max(0, filters.maxReleaseChecks));
    log(`  核实 Release（最多查 ${toCheck.length} 个候选的 APK 资产）`);
    // 配额满了之后再多核实几个：这些是「已确认真有 APK」的候选，
    // 存进遗留队列后明天零 API 成本就能交付。未核实的一律不写队列，
    // 否则队列会变成「待办垃圾堆」（早前版本就踩过：20 条里 2 条根本没 APK）。
    const DEFER_VERIFY_EXTRA = 3;
    let extraChecked = 0;
    for (const c of toCheck) {
      const quotaFull = accepted.length >= cfg.quota;
      if (quotaFull && extraChecked >= DEFER_VERIFY_EXTRA) {
        log(`  · ${c.fullName} 及之后不再核实（配额已满，遗留队列也够了）`);
        break;
      }
      try {
        const releases = await listReleases(c.fullName, 8);
        const pick = pickApkRelease(releases, filters);
        if (!pick) { rejected.push({ repo: c, why: 'Release 里没有可用的 APK 资产' }); log(`  ✗ ${c.fullName}：没有可用的 APK 资产`); continue; }
        const rec = {
          source: 'github',
          repo: c,
          release: { tag: pick.release.tag, name: pick.release.name, publishedAt: pick.release.publishedAt, body: pick.release.body },
          asset: { name: pick.asset.name, size: pick.asset.size, downloads: pick.asset.downloads, url: pick.asset.url, digest: pick.asset.digest },
          assetUrls: [],
          otherApks: pick.allApks,
          fdroid: null,
          checkedAt: DATE,
        };
        if (quotaFull) {
          pending.items.push(rec);
          extraChecked++;
          log(`  · ${c.fullName} 已确认有 APK（${pick.release.tag} / ${pick.asset.name}），但今天配额已满 → 留给下次（零 API 成本）`);
        } else {
          accepted.push(rec);
          log(`  ✓ ${c.fullName}（★${c.stars}）→ ${pick.release.tag} / ${pick.asset.name}（${humanSize(pick.asset.size)}）`);
        }
      } catch (e) {
        if (e.rateLimited) { fail('  GitHub 核心 API 配额耗尽，停止核实。'); break; }
        if (e.notFound) { rejected.push({ repo: c, why: '仓库不存在' }); continue; }
        fail(`  ✗ ${c.fullName}：${e.message}`);
        rejected.push({ repo: c, why: `核实失败：${e.message}` });
      }
    }
  } else if (FDROID_ONLY) {
    log('\n【3/6】--fdroid-only：跳过 GitHub 通道');
  } else if (DESKTOP_ONLY_MODE) {
    log('\n【3/6】--desktop-only：跳过 GitHub 通道');
  } else {
    log('\n【3/6】GitHub 通道无需执行（配额已满）');
  }

  /* ---------- 阶段 4：下载与解析（手机 App） ---------- */
  log(`\n【4/6】下载与解析（${accepted.length} 个手机 App）`);
  const apps = [];

  for (const rec of accepted) {
    const c = rec.repo;
    const label = rec.source === 'fdroid' ? `${c.fullName} / ${rec.fdroid.packageName}` : c.fullName;
    log(`\n▸ ${label}  ${rec.release ? rec.release.tag : '（待核实）'}`);

    // 遗留的 GitHub 候选还没核实 Release，这里补上
    if (!rec.asset) {
      try {
        const releases = await listReleases(c.fullName, 8);
        const pick = pickApkRelease(releases, cfg.filters);
        if (!pick) { downloadFailures.push({ fullName: c.fullName, why: '没有可用的 APK 资产' }); continue; }
        rec.release = { tag: pick.release.tag, name: pick.release.name, publishedAt: pick.release.publishedAt, body: pick.release.body };
        rec.asset = { name: pick.asset.name, size: pick.asset.size, downloads: pick.asset.downloads, url: pick.asset.url, digest: pick.asset.digest };
        rec.otherApks = pick.allApks;
      } catch (e) {
        downloadFailures.push({ fullName: c.fullName, why: `核实失败：${e.message}` });
        continue;
      }
    }

    // 应用展示名必须取 F-Droid 的，不能取 rec.repo.name ——
    // rec.repo 是 GitHub 复核结果，它的 name 是仓库名（例如 apps-android-commons），
    // 拿它当应用名会显示成仓库名（早前版本就犯过这个错）。
    const displayName = rec.displayName || (rec.fdroid && (rec.fdroid.zhName || rec.fdroid.packageName)) || c.name || rec.repo.name;
    // slug 一律从 GitHub 仓库名生成（纯 ASCII，稳定）；中文展示名照样能用，
    // 因为 slug 会显式写进 curation.json，不依赖 build.mjs 自动推导。
    const slug = slugify(rec.repo.name || c.fullName.split('/')[1]) || slugify(rec.fdroid ? rec.fdroid.packageName : c.fullName);
    const version = String(rec.release.tag || '').replace(/^v/i, '').replace(/[^\w.\-]/g, '') || 'unknown';
    const appDir = ensureDir(path.join(DAY_DIR, 'upload', slug));
    // APK 文件名用 slug（纯 ASCII）：中文文件名在网盘分享链接、URL 里容易出问题
    const apkName = `${slug}-${version}.apk`;
    const apkPath = path.join(appDir, apkName);

    let dl = null;
    if (!DRY_NO_DOWNLOAD) {
      try {
        dl = await downloadTo(rec.asset.url, apkPath, {
          // F-Droid 的地址本身就是镜像直链，不能再套 GitHub 镜像前缀
          mirrors: rec.source === 'fdroid' ? [] : cfg.mirrors,
          tryDirect: rec.source === 'fdroid' ? true : cfg.tryDirect,
          extraUrls: rec.source === 'fdroid' ? (rec.assetUrls || []) : [],
          expectSize: rec.asset.size,
          expectSha256: rec.asset.digest || null,
          label: rec.asset.name,
        });
      } catch (e) {
        fail(`  下载失败：${e.message}`);
        downloadFailures.push({ fullName: c.fullName, why: e.message });
        continue;
      }
    }

    /* 解析 APK：包名 / 版本 / 签名 / 图标，全部读文件本身 */
    let info = null;
    if (dl) {
      try {
        info = inspectApk(apkPath);
        const m = info.manifest || {};
        log(`  包名 ${m.package || '未读到'} · 版本 ${m.versionName || '?'} · minSdk ${m.minSdk || '?'} · 签名 ${info.signature.signed ? info.signature.schemes.join('+') : '⚠未检出'}`);
        if (!info.signature.signed) warn('  未检出签名 —— 这种包多半装不上，建议人工确认后再发');
        if (!info.hasDex) warn('  包里没有 classes.dex —— 可能不是可安装的 APK');
        // F-Droid 通道：索引里给的包名/版本/哈希与实际文件对不上就报警，这是独立交叉验证
        if (rec.fdroid) {
          if (m.package && m.package !== rec.fdroid.packageName) {
            warn(`  ⚠ 包名与 F-Droid 索引不一致：索引 ${rec.fdroid.packageName}，APK 内 ${m.package}`);
          }
          if (m.versionName && rec.fdroid.versionName && m.versionName !== rec.fdroid.versionName) {
            warn(`  ⚠ 版本与 F-Droid 索引不一致：索引 ${rec.fdroid.versionName}，APK 内 ${m.versionName}`);
          }
        }
      } catch (e) {
        fail(`  APK 解析失败：${e.message}`);
      }
    }

    /* 图标三条路，按可靠性排序：
         1. 从 APK 里抠 —— 本地解析，不用外网，最可靠
         2. 从源码仓库常见路径找（fastlane 等）
         3. 都失败就明确标记「缺图标」，交给人工补；站点会退化成首字标记（build.mjs 的既定行为）
       刻意不走 F-Droid 自己的图标 URL：实测 TUNA 只镜像了索引与 APK，
       <镜像>/fdroid/repo/icon_xxx.png 一律 404，那条路是死的。 */
    let iconFile = null;
    // 图标的来源必须显式记录，不能事后推断：
    // 早前是「info.icon 存在就用它的 via，否则一律写 fdroid-index」，
    // 结果从源码仓库取到图标时，来源被记成 fdroid-index、路径记成 F-Droid 索引里的文件名，
    // 而实际用的是仓库文件 —— github.json 的备注因此陈述了错误事实。踩过这个坑。
    let iconSource = null;
    let iconPath = null;
    let iconUnreliable = false;      // 来源不可靠（largest-square），必须人工核对
    const iconDir = ensureDir(path.join(DAY_DIR, 'icons'));
    if (info && info.icon) {
      iconFile = `${slug}.${info.icon.kind === 'jpg' ? 'jpg' : info.icon.kind}`;
      iconSource = info.icon.via;
      iconPath = info.icon.path || null;
      fs.writeFileSync(path.join(iconDir, iconFile), info.icon.buf);
      log(`  图标 ${iconFile}（${info.icon.w || '?'}×${info.icon.h || '?'}，来源 ${info.icon.via}${info.icon.resName ? ' ' + info.icon.resName : ''}）`);
    } else if (!dl) {
      log('  · 本轮未下载 APK，图标会在下载后从 APK 内提取');
    } else {
      // 退路一：源码仓库里的官方图标。比「包里最大方形图」可靠得多，
      // 所以必须排在它前面 —— 早前因为 inspectApk 内部已经兜底返回了图，
      // 这一步永远走不到，Meshtastic 因此拿到了 res/drawable 里的通用头像素材。
      const got = await fetchRepoIcon(c, cfg, (rec.fdroid && rec.fdroid.packageName) || (info && info.manifest && info.manifest.package) || null);
      if (got && got.buf) {
        iconFile = `${slug}.${got.kind}`;
        iconSource = 'repo-file';
        iconPath = got.path;
        fs.writeFileSync(path.join(iconDir, iconFile), got.buf);
        log(`  图标 ${iconFile}（APK 内无可信位图，取自源码仓库 ${got.path}，via ${got.mirror}）`);
      } else if (info && info.iconLargestSquare) {
        // 退路二：包里最大的方形图。来源不可靠，站点上可能是错的图，
        // 所以明确标注、并留给人工核对（我会逐张看）。
        const ls = info.iconLargestSquare;
        iconFile = `${slug}.${ls.kind === 'jpg' ? 'jpg' : ls.kind}`;
        iconSource = 'largest-square';
        iconPath = ls.path;
        iconUnreliable = true;
        fs.writeFileSync(path.join(iconDir, iconFile), ls.buf);
        log(`  ⚠ 图标 ${iconFile}（APK 内无可信位图、仓库也没取到，退回「res 下最大方形图」${ls.path}）`);
        log('    → 该来源不可靠，需人工核对是不是应用图标；不对就删掉它，站点会显示首字标记');
      } else {
        log('  ⚠ 图标：APK 内无可信位图、源码仓库里也没找到、包里也没有可用的方形图');
        log('    → 审核表里已标为「缺图标」；站点会退化成首字标记，建议人工补一张');
        if (got && got.tried && got.tried.length) log(`    试过的仓库路径：${got.tried.slice(0, 6).join('；')}`);
      }
    }

    /* LICENSE 原文 */
    let licenseFile = null;
    if (cfg.compliance.fetchLicenseFile && rec.source === 'github') {
      for (const p of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING', 'LICENSE-APACHE']) {
        // tryDirect: false —— raw.githubusercontent.com 实测被墙，直连只会白等超时
        const got = await fetchSmall(rawUrl(c.owner || c.fullName.split('/')[0], c.name || c.fullName.split('/')[1], c.defaultBranch || 'main', p), { mirrors: cfg.mirrors, tryDirect: false, timeoutMs: 12000 });
        if (got && got.buf.length > 40) {
          licenseFile = `${slug}-LICENSE.txt`;
          ensureDir(path.join(DAY_DIR, 'licenses'));
          fs.writeFileSync(path.join(DAY_DIR, 'licenses', licenseFile), got.buf);
          log(`  协议原文 ${p}（${got.buf.length}B，via ${got.mirror}）`);
          break;
        }
      }
      if (!licenseFile) log('  · 没取到 LICENSE 原文（仓库可能放在别的文件名下）');
    }

    /* 上传目录里的 README.txt：来源、协议、源码、哈希 —— 合规凭据 + 日后自查依据 */
    if (cfg.compliance.bundleReadme && dl) {
      const owner = c.owner || c.fullName.split('/')[0];
      const rname = c.name || c.fullName.split('/')[1];
      const lines = [
        `${displayName} ${rec.release.tag}`,
        '',
        `开源仓库: ${c.url || `https://github.com/${c.fullName}`}`,
        `开源协议: ${(rec.fdroid && rec.fdroid.license) || c.license || '未标注'}`,
        `发行页面: ${c.url || ''}/releases/tag/${rec.release.tag}`,
      ];
      if (rec.fdroid && rec.fdroid.srcname) {
        lines.push(`源码压缩包: ${String((cfg.fdroid.mirrors || [])[0]).replace(/\/+$/, '')}/${rec.fdroid.srcname}`);
      } else {
        lines.push(`源码获取: ${c.url || ''}/archive/refs/tags/${rec.release.tag}.zip`);
      }
      lines.push(
        `APK 文件: ${apkName}`,
        `文件大小: ${dl.bytes} 字节`,
        `SHA-256 : ${dl.sha256}`,
        `下载通道: ${dl.mirror}`,
        `采集日期: ${DATE}`,
      );
      if (rec.fdroid) {
        lines.push(
          `来源索引: F-Droid（${rec.fdroid.indexSource}）`,
          `包名    : ${rec.fdroid.packageName}`,
          `版本    : ${rec.fdroid.versionName}（versionCode ${rec.fdroid.versionCode}）`,
          rec.fdroid.nativecode && rec.fdroid.nativecode.length ? `CPU 架构: ${rec.fdroid.nativecode.join(', ')}` : '',
        );
      }
      lines.push(
        '',
        '说明：',
        '本 APK 为上述开源项目官方发布的安装包，此处仅做原样转存，未做任何修改。',
        '按 GPL / AGPL / LGPL 等协议要求，对应源码可通过上面的「源码」链接获得。',
        '如你是权利人并认为此处分发不妥，请联系本站删除。',
      );
      fs.writeFileSync(path.join(appDir, 'README.txt'), lines.filter(l => l !== '').join('\r\n'), 'utf8');
      if (licenseFile) fs.copyFileSync(path.join(DAY_DIR, 'licenses', licenseFile), path.join(appDir, 'LICENSE.txt'));
    }

    const m = (info && info.manifest) || {};
    const catSuggestion = rec.fdroid
      ? (rec.fdroid.categories && FD.mapCategory(rec.fdroid.categories)) || 'system'
      : guessCategory([c.name, c.desc, (c.topics || []).join(' ')].join(' '));

    apps.push({
      slug,
      source: rec.source,
      name: displayName,
      appLabel: (info && info.label) || rec.fdroid && rec.fdroid.zhName || null,
      catSuggestion,
      catSuggestionConfidence: rec.fdroid ? 'medium' : 'low',
      needsCopy: true,
      tagline: '',
      desc: '',
      features: '',
      repoDesc: c.desc || (rec.fdroid ? rec.fdroid.summary : '') || '',
      /** 事实来源：F-Droid 官方中文摘要与中文详细描述（人工翻译，非机器翻译），撰写站点文案时可直接引用 */
      factsForCopy: rec.fdroid ? {
        fdroidZhSummary: rec.fdroid.zhSummary,
        fdroidSummary: rec.fdroid.summary,
        fdroidZhDescription: rec.fdroid.zhDescription || null,
        fdroidDescription: (rec.fdroid.description || '').slice(0, 3000),
        categories: rec.fdroid.categories,
        website: rec.fdroid.website,
        issueTracker: rec.fdroid.issueTracker,
        antiFeatures: rec.fdroid.antiFeatures,
      } : null,
      repo: {
        fullName: c.fullName, url: c.url || `https://github.com/${c.fullName}`, stars: c.stars ?? null,
        license: (rec.fdroid && rec.fdroid.license) || c.license || null,
        lang: c.lang || null, topics: c.topics || [], archived: !!c.archived,
        pushedAt: c.pushedAt || null, createdAt: c.createdAt || null,
        homepage: c.homepage || (rec.fdroid ? rec.fdroid.website : null),
        defaultBranch: c.defaultBranch || null, forks: c.forks ?? null, openIssues: c.openIssues ?? null,
      },
      release: rec.release,
      asset: {
        name: rec.asset.name, size: rec.asset.size, downloads: rec.asset.downloads,
        url: rec.asset.url, digest: rec.asset.digest,
        publishedAt: rec.release.publishedAt,
      },
      otherApks: rec.otherApks || [],
      fdroid: rec.fdroid || null,
      apk: dl ? {
        file: path.relative(DAY_DIR, apkPath).replace(/\\/g, '/'),
        bytes: dl.bytes, sha256: dl.sha256, mirror: dl.mirror, resumed: dl.resumed,
      } : null,
      package: m.package || (rec.fdroid ? rec.fdroid.packageName : null),
      // 运行平台由 manifest 的必需特性判定（可能是 Android TV / Wear 等），
      // 不能一律写 Android —— TV 专用应用手机装了用不了
      platform: (info && info.platform) || 'Android',
      versionName: m.versionName || (rec.fdroid ? rec.fdroid.versionName : null),
      versionCode: m.versionCode || (rec.fdroid ? String(rec.fdroid.versionCode) : null),
      minSdk: m.minSdk || (rec.fdroid ? String(rec.fdroid.minSdk ?? '') || null : null),
      targetSdk: m.targetSdk || (rec.fdroid ? String(rec.fdroid.targetSdk ?? '') || null : null),
      signature: info ? info.signature : null,
      icon: iconFile ? {
        file: `icons/${iconFile}`,
        source: iconSource,                 // arsc / filename / repo-file / largest-square
        path: iconPath,                     // 实际用到的那张图的位置
        unreliable: iconUnreliable,         // true = 来源不可靠，必须人工核对
        w: info && info.icon ? info.icon.w || null : null,
        h: info && info.icon ? info.icon.h || null : null,
        density: info && info.icon ? info.icon.density || null : null,
      } : null,
      licenseFile,
      notes: info ? info.notes : [],
      errors: info ? info.errors : [],
      riskFlags: riskFlags({
        name: displayName, desc: c.desc || '', topics: c.topics || [],
        license: (rec.fdroid && rec.fdroid.license) || c.license,
        source: rec.source, fdroidInfo: rec.fdroid || { antiFeatures: [] },
      }),
      netdisk: { remotePath: null, shareUrl: null, pwd: null, uploadedAt: null },
      accepted: true,
    });

    // 记录状态，避免明天重复收录
    state.repos[c.fullName.toLowerCase()] = { firstSeen: DATE, lastRun: DATE, stage: 'accepted', slug };
    if (rec.fdroid) state.fdroid[rec.fdroid.packageName] = { firstSeen: DATE, lastRun: DATE, stage: 'accepted', repo: c.fullName };
    state.names[nameKey(c.name)] = c.name;
    await sleep(300);
  }

  /* ---------- 阶段 5：电脑软件通道（Windows，独立配额） ----------
     为什么整段独立：桌面软件的第 4 段（下面这段的桌面分支）和手机 App 完全不同 ——
     **没有 APK 可解析**。包名、签名、minSdk 这些字段在桌面端根本不存在，
     版本取 release tag、校验用 GitHub 官方 digest、图标走源码仓库。
     所以这里不套用上面那套「下载 → inspectApk → 抠图标」的流程，
     而是自己走一遍，产出同样结构的 apps 条目（platform: 'Windows'）。
     下游（审核表 / merge / 网盘）本来就是平台无关的，能直接吃。 */
  if (DESKTOP_ENABLED && DESKTOP_QUOTA > 0) {
    log(`\n【5/6】电脑软件通道（Windows，配额 ${DESKTOP_QUOTA} 个 · 独立名额）`);
    const existingNames = new Set([...site.names.keys(), ...Object.keys(state.names)]);
    for (const a of apps) existingNames.add(nameKey(a.name));
    const t0 = Date.now();
    let dres;
    try {
      dres = await discoverDesktop({
        dailyCfg: cfg,
        desktopCfg: DESKTOP_CFG,
        site,
        state,
        date: DATE,
        limit: DESKTOP_QUOTA,
        only: ONLY,
        existingNames,
      });
    } catch (e) {
      fail(`  电脑软件通道失败：${e.message}`);
      dres = { apps: [], rejected: [], failed: [], reason: `通道异常：${e.message}` };
    }
    log(`  耗时 ${Math.round((Date.now() - t0) / 1000)}s · 候选仓库 ${dres.raw ?? 0} 个 → 粗筛通过 ${dres.passed ?? 0} 个 → 确认可交付 ${dres.apps.length} 个`);
    rejected.push(...dres.rejected);
    // 打上来源标记：汇总里要把桌面通道的失败与手机 App 的分开说
    for (const f of dres.failed) downloadFailures.push({ ...f, source: 'desktop' });

    /* 下载 + 取证 + 打包。与手机段的差别逐条写在对应位置。 */
    for (const rec of dres.apps) {
      const c = rec.repo;
      const displayName = rec.displayName || c.name;
      const slugBase = slugify(rec.repo.name || c.fullName.split('/')[1]);
      const slug = apps.some(a => a.slug === slugBase) ? `${slugBase}-win` : slugBase;
      // 版本号可能带 tag 前缀之外的点划（实测 v.0.16.0 → 去掉 v 后开头还是个点，
      // 生成的文件名会变成 shadps4-.0.16.0.zip 这种别扭样子），去掉首尾的点划
      const version = String(rec.release.tag || '').replace(/^v/i, '').replace(/[^\w.\-]/g, '').replace(/^[.\-]+|[.\-]+$/g, '') || 'unknown';
      const appDir = ensureDir(path.join(DAY_DIR, 'upload', slug));
      const assetName = `${slug}-${version}${path.extname(rec.asset.name).toLowerCase()}`;
      const assetPath = path.join(appDir, assetName);
      log(`\n▸ ${displayName}（${c.fullName}）  ${rec.release.tag}  ${rec.desktop.assetKind === 'portable' ? '便携版' : '安装器'} ${humanSize(rec.asset.size)}`);

      /* 1) 下载。桌面端的地址就是 GitHub Release 资产，和 GitHub 通道同款：
            走镜像故障转移；F-Droid 那套「直连 + 多镜像」参数不适用。 */
      let dl = null;
      if (!DRY_NO_DOWNLOAD) {
        try {
          dl = await downloadTo(rec.asset.url, assetPath, {
            mirrors: cfg.mirrors,
            tryDirect: cfg.tryDirect,
            extraUrls: [],
            expectSize: rec.asset.size,
            expectSha256: rec.asset.digest || null,     // 官方 digest 有就核对，没有只比大小
            label: rec.asset.name,
          });
        } catch (e) {
          fail(`  下载失败：${e.message}`);
          downloadFailures.push({ fullName: c.fullName, why: e.message, source: 'desktop' });
          continue;
        }
      }

      /* 2) 便携版压缩包：解开，让「这里面是哪个 exe」成为可核实的事实。
            原样丢一个 zip 到网盘，用户面对的是看不出内容的压缩包 ——
            而那正是第三方下载站塞捆绑软件的形态，用户没法核对。
            解包失败的（非 zip / 加密 / 越界路径）不当作失败：压缩包照样发，
            只是 README 与审核表里如实写「未能查看内容」。 */
      let archiveInfo = null;
      let shippedName = assetName;                 // 最终交付给用户的文件名（写入 README 与备案）
      let keptArchive = true;                      // 原始压缩包是否还在目录里
      let mainExePath = path.join(appDir, assetName);
      let mainExeName = assetName;
      if (dl && archiveKind(assetName) === 'zip') {
        try {
          archiveInfo = unzipPortable(assetPath, path.join(appDir, 'app'));
          const files = archiveInfo.files || [];
          const rootFiles = files.filter(n => !n.includes('/')).length;
          if (files.length > 200 && rootFiles > 20) {
            // 几千个文件的绿色版：解出来反而把上传目录弄得没法看，保留压缩包并说明
            log(`  · 压缩包内有 ${files.length} 个文件（大目录结构），保留压缩包不解包，README 里说明内含文件数`);
            archiveInfo = { ...archiveInfo, unpacked: false };
          } else {
            archiveInfo.unpacked = true;
            if (archiveInfo.main) {
              mainExeName = archiveInfo.main;
              mainExePath = path.join(appDir, 'app', archiveInfo.main);
              shippedName = mainExeName;
            } else {
              shippedName = 'app/ 目录';
            }
            log(`  ✓ ${archiveInfo.note}`);
            /* 解包成功后删掉原始压缩包：内容一模一样地放在 app/ 下，
               留着等于让用户白上传一份（实测 29MB 的包解开后 60MB 的 exe，
               两个都留就是 89MB —— 网盘上传时间是真实成本）。
               解包失败或结构太大时保留压缩包，这时它是唯一可用形态。 */
            fs.rmSync(assetPath, { force: true });
            keptArchive = false;
            log(`  · 已删除原始压缩包（内容已解包到 app/，避免同一份东西传两遍）`);
          }
        } catch (e) {
          warn(`  压缩包未能解开：${e.message}（压缩包照常交付，README 里如实说明）`);
          archiveInfo = { failed: e.message, files: [], main: null };
        }
      } else if (dl && archiveKind(assetName) === '7z') {
        log('  · 7z 压缩包：本流程不自动解包（需要外部工具），README 里说明用 7-Zip 打开');
      }

      /* 3) 版本核实：从 exe 的 PE 头里读作者写的版本，与 release tag 对照。
            这是桌面端唯一一条**独立于 tag** 的核实事实 —— tag 是作者随手起的。 */
      let peInfo = null;
      if (dl && /\.(exe|msi)$/i.test(mainExeName)) {
        peInfo = readPeVersionInfo(mainExePath);
        if (peInfo) {
          const bits = ['ProductName', 'FileVersion', 'ProductVersion', 'CompanyName']
            .filter(k => peInfo[k]).map(k => `${k}=${peInfo[k]}`);
          log(`  程序自带版本信息：${bits.join(' · ')}`);
          if (peInfo.FileVersion && version && !String(peInfo.FileVersion).includes(version.replace(/-/g, '.'))) {
            log(`    · Release tag 是 ${rec.release.tag}，exe 内写的是 ${peInfo.FileVersion} —— 两者不必相同（tag 多为仓库作者自拟），以 exe 内为准展示时可注明`);
          }
        } else {
          log('  · 没读到 exe 内的版本信息（部分打包器不写 VERSIONINFO）');
        }
      }

      /* 4) 图标：桌面端**没有 APK 可抠**，所以只有「源码仓库里的官方素材」这一条路。
            常见的 assets/icon.png、build/icon.png、public/logo.png 在
            channels.repoIconPathsDesktop 里；刻意不查 Tauri 的脚手架占位图。 */
      let iconFile = null;
      let iconSource = null;
      let iconPath = null;
      let iconUnreliable = false;
      if (dl) {
        const got = await fetchRepoIcon(c, cfg, null, 'desktop');
        if (got && got.buf) {
          const iconDir = ensureDir(path.join(DAY_DIR, 'icons'));
          iconFile = `${slug}.${got.kind}`;
          iconSource = 'repo-file';
          iconPath = got.path;
          fs.writeFileSync(path.join(iconDir, iconFile), got.buf);
          log(`  图标 ${iconFile}（取自源码仓库 ${got.path}，via ${got.mirror}）`);
        } else {
          log('  ⚠ 图标：源码仓库里没找到官方图标（桌面端没有 APK 可抠图）');
          log('    → 审核表里标为「缺图标」；站点会退化成首字标记，建议人工补一张');
          if (got && got.tried && got.tried.length) log(`    试过的仓库路径：${got.tried.slice(0, 6).join('；')}`);
        }
      }

      /* 5) LICENSE 原文：与手机段同一套（raw.githubusercontent 被墙，只走镜像） */
      let licenseFile = null;
      if (dl && cfg.compliance.fetchLicenseFile) {
        for (const p of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING', 'LICENSE-APACHE']) {
          const got = await fetchSmall(rawUrl(c.owner || c.fullName.split('/')[0], c.name || c.fullName.split('/')[1], c.defaultBranch || 'main', p), { mirrors: cfg.mirrors, tryDirect: false, timeoutMs: 12000 });
          if (got && got.buf.length > 40) {
            licenseFile = `${slug}-LICENSE.txt`;
            ensureDir(path.join(DAY_DIR, 'licenses'));
            fs.writeFileSync(path.join(DAY_DIR, 'licenses', licenseFile), got.buf);
            log(`  协议原文 ${p}（${got.buf.length}B，via ${got.mirror}）`);
            break;
          }
        }
        if (!licenseFile) log('  · 没取到 LICENSE 原文（仓库可能放在别的文件名下）');
      }

      /* 6) 上传目录里的 README.txt：桌面端必须写清「安装包叫什么、是安装器还是便携版、
            便携版怎么用、校验值是多少」—— 网盘用户拿到一个 exe/zip，这几句话是他判断的依据。 */
      if (dl && cfg.compliance.bundleReadme) {
        const lines = [
          `${displayName} ${rec.release.tag}`,
          '',
          `开源仓库: ${c.url || `https://github.com/${c.fullName}`}`,
          `开源协议: ${c.license || '未标注'}`,
          `发行页面: ${c.url || `https://github.com/${c.fullName}`}/releases/tag/${rec.release.tag}`,
          `源码获取: ${c.url || ''}/archive/refs/tags/${rec.release.tag}.zip`,
          '',
          `平台    : Windows`,
          `安装包  : ${shippedName}`,
          `形态    : ${rec.desktop.assetKind === 'portable' ? '便携版 / 免安装' : '安装器'}`,
          // 原始资产名一定写下来：官方发行页上的名字，是用户日后自查来源的依据
          `原始资产: ${rec.asset.name}`,
          `文件大小: ${dl.bytes} 字节`,
          `SHA-256 : ${dl.sha256}`,
          `下载通道: ${dl.mirror}`,
          `采集日期: ${DATE}`,
        ];
        if (archiveInfo && archiveInfo.unpacked && archiveInfo.main) {
          lines.push('', `使用方法: 已解包到 app/ 目录，直接运行 ${archiveInfo.main}（便携版免安装）`);
          if (!keptArchive) lines.push(`说明: 原始压缩包 ${rec.asset.name} 已删除 —— 内容已完整解包，避免同一份文件占两倍空间`);
        } else if (archiveInfo && archiveInfo.files && archiveInfo.files.length && !archiveInfo.unpacked) {
          lines.push('', `压缩包内含 ${archiveInfo.files.length} 个文件，请用压缩软件解压后运行其中的主程序`);
        } else if (archiveInfo && archiveInfo.failed) {
          lines.push('', `说明: 本机未能查看压缩包内容（${archiveInfo.failed}），请解压后运行主程序`);
        } else if (rec.desktop.assetKind === 'installer') {
          lines.push('', '使用方法: 双击运行安装');
        }
        if (peInfo) {
          lines.push('', '程序自带版本信息（读取自 exe）:',
            ...['ProductName', 'FileVersion', 'ProductVersion', 'CompanyName'].filter(k => peInfo[k]).map(k => `  ${k}: ${peInfo[k]}`));
        }
        lines.push(
          '',
          '说明：',
          `本安装包为上述开源项目官方发布的产物（原始资产 ${rec.asset.name}），此处仅做原样转存${keptArchive ? '' : '与解包'}，未做任何修改。`,
          '请从本目录或上方官方发行页面获取；不要使用第三方下载站的重打包版本。',
          '如你是权利人并认为此处分发不妥，请联系本站删除。',
        );
        fs.writeFileSync(path.join(appDir, 'README.txt'), lines.join('\r\n'), 'utf8');
        if (licenseFile) fs.copyFileSync(path.join(DAY_DIR, 'licenses', licenseFile), path.join(appDir, 'LICENSE.txt'));
      }

      const catSuggestion = guessCategory([displayName, c.desc, (c.topics || []).join(' ')].join(' '));
      apps.push({
        slug,
        source: 'desktop',
        kind: 'desktop',
        name: displayName,
        appLabel: (peInfo && peInfo.ProductName) || null,
        catSuggestion,
        catSuggestionConfidence: 'low',
        needsCopy: true,
        tagline: '',
        desc: '',
        features: '',
        repoDesc: c.desc || '',
        factsForCopy: {
          desktop: {
            releaseTag: rec.release.tag,
            assetName: rec.asset.name,
            assetKind: rec.desktop.assetKind,
            windowsAssetCandidates: rec.alternatives || [],
            peVersionInfo: peInfo,
            archive: archiveInfo ? {
              unpacked: !!archiveInfo.unpacked,
              main: archiveInfo.main || null,
              fileCount: (archiveInfo.files || []).length,
              sampleFiles: (archiveInfo.files || []).slice(0, 30),
            } : null,
          },
        },
        repo: {
          fullName: c.fullName, url: c.url || `https://github.com/${c.fullName}`, stars: c.stars ?? null,
          license: c.license || null,
          lang: c.lang || null, topics: c.topics || [], archived: !!c.archived,
          pushedAt: c.pushedAt || null, createdAt: c.createdAt || null,
          homepage: c.homepage || null,
          defaultBranch: c.defaultBranch || null, forks: c.forks ?? null, openIssues: c.openIssues ?? null,
        },
        release: rec.release,
        asset: {
          name: rec.asset.name, size: rec.asset.size, downloads: rec.asset.downloads,
          url: rec.asset.url, digest: rec.asset.digest,
          publishedAt: rec.release.publishedAt,
        },
        otherApks: [],
        fdroid: null,
        // 桌面包也要登记文件事实：下载大小 / 哈希 / 通道，与 APK 那套字段同名，
        // 这样网盘上传后的核对、审计备注都能复用现成逻辑。
        // file 指向**最终交付给用户的那个文件**：便携版解包成功后就是解出来的 exe
        // （原始 zip 已被删掉），否则是原始资产本身。
        apk: dl ? {
          file: path.relative(DAY_DIR, archiveInfo && archiveInfo.unpacked && archiveInfo.main ? mainExePath : assetPath).replace(/\\/g, '/'),
          bytes: dl.bytes, sha256: dl.sha256, mirror: dl.mirror, resumed: dl.resumed,
          originalAsset: rec.asset.name,
          archiveKept: keptArchive,
        } : null,
        package: null,                       // 桌面端没有包名这个概念，不编造
        platform: 'Windows',
        versionName: (peInfo && (peInfo.FileVersion || peInfo.ProductVersion)) || version,
        versionCode: null,
        minSdk: null,
        targetSdk: null,
        signature: null,                     // 桌面端没有 APK 签名可验，null 表示"未涉及"，不是"未检出"
        icon: iconFile ? {
          file: `icons/${iconFile}`,
          source: iconSource,
          path: iconPath,
          unreliable: iconUnreliable,
          // 标记来源是桌面端：merge.mjs 写审计备注时要用它换措辞
          //（"APK 内没有可用的启动图标位图"对 exe 不成立）
          kindDesktop: true,
          w: null, h: null, density: null,
        } : null,
        licenseFile,
        desktop: {
          assetKind: rec.desktop.assetKind,
          // 解包后的主程序名是人工核对「这个包确实是这个应用」的主要凭据
          mainExecutable: archiveInfo && archiveInfo.unpacked ? mainExeName : null,
          archiveKept: keptArchive,
          originalAsset: rec.asset.name,
          archiveNote: archiveInfo ? (archiveInfo.failed ? `未能查看压缩包内容：${archiveInfo.failed}` : archiveInfo.note) : null,
          peVersionInfo: peInfo,
          pickedBy: rec.desktop.pickedBy,
        },
        notes: rec.notes || [],
        errors: [],
        riskFlags: riskFlags({
          name: displayName, desc: c.desc || '', topics: c.topics || [],
          license: c.license, source: 'desktop', fdroidInfo: { antiFeatures: [] },
        }, [
          // 措辞按资产形态分叉：便携版说"安装包"是不准确的，用户会去找安装程序
          rec.desktop.assetKind === 'installer'
            ? '分发形态：这是 Windows **安装器**（exe/msi），站内此前的条目都是 Android APK。安装器可能捆绑第三方推广组件（部分项目在安装时勾选），发布前建议实机装一遍确认。'
            : '分发形态：这是 Windows **便携版**（免安装，解包后直接运行 exe），站内此前的条目都是 Android APK。请确认 /desktop/ 频道页与详情页的措辞能说清平台，避免用户下错端。',
          ...(c.notes || []),
        ]),
        netdisk: { remotePath: null, shareUrl: null, pwd: null, uploadedAt: null },
        accepted: true,
      });
      state.repos[c.fullName.toLowerCase()] = { firstSeen: DATE, lastRun: DATE, stage: 'accepted', slug, channel: 'desktop' };
      state.names[nameKey(displayName)] = displayName;
      await sleep(300);
    }
    if (!apps.some(a => a.source === 'desktop')) warn(`  电脑软件通道本轮没有产出${dres.reason ? `：${dres.reason}` : ''}`);
  } else if (!DESKTOP_ENABLED) {
    log('\n【5/6】--no-desktop：跳过电脑软件通道');
  } else {
    log('\n【5/6】电脑软件通道配额为 0，跳过（--desktop-quota=N 可临时改）');
  }

  /* ---------- 阶段 6：网盘 ---------- */
  const netdiskMode = (cfg.netdisk && cfg.netdisk.mode) || 'manual';
  let netdiskReport;
  const skipNetdisk = SKIP_NETDISK || !cfg.netdisk.enabled || DRY_NO_DOWNLOAD || !apps.length;

  if (skipNetdisk) {
    const why = SKIP_NETDISK ? '--no-netdisk' : !cfg.netdisk.enabled ? 'config.json 里 netdisk.enabled 为 false' : DRY_NO_DOWNLOAD ? '--no-download' : '没有可交付的条目';
    log(`\n【6/6】跳过网盘环节（${why}）`);
    netdiskReport = { attempted: false, mode: netdiskMode, reason: '本轮未执行', pending: apps.map(a => a.slug) };
  } else if (netdiskMode === 'auto') {
    log('\n【6/6】百度网盘（自动模式 / BaiduPCS-Go）');
    const avail = netdiskAvailable(cfg.netdisk);
    netdiskReport = await uploadBundle(apps, { dayDir: DAY_DIR, date: DATE, cfg: cfg.netdisk, available: avail });
    netdiskReport.mode = 'auto';
    // 自动模式下才给 upload.ps1：它是 BaiduPCS-Go 的命令行补传方案，
    // 自动上传失败时用来兜底。手动模式用不上它（你直接拖文件夹），
    // 早前这里无条件生成，导致手动模式的产物目录里混进一个用不上的脚本。
    if (netdiskReport.errors && netdiskReport.errors.length) {
      const f = manualUploadScript(apps, { dayDir: DAY_DIR, date: DATE, cfg: cfg.netdisk });
      log(`  已生成命令行补传脚本：${f}`);
    }
  } else {
    log('\n【6/6】百度网盘（手动模式）');
    const linksFile = writeLinksSheet(apps, { dayDir: DAY_DIR, date: DATE });
    const guideFile = writeManualGuide(apps, { dayDir: DAY_DIR, date: DATE, cfg });
    log(`  ✓ 已准备上传目录：${path.join(DAY_DIR, 'upload')}`);
    log(`  ✓ 登记表：${linksFile}（把分享链接粘进「链接: 」后面即可）`);
    log(`  ✓ 操作说明：${guideFile}`);
    // 刻意不生成 upload.ps1：手动模式你是用网盘客户端拖文件，
    // 那个脚本是 BaiduPCS-Go 的命令行补传方案，放在这里只会造成困惑。
    netdiskReport = { attempted: false, mode: 'manual', reason: '手动模式：等你上传并填 links.txt', linksFile, guideFile, pending: apps.map(a => a.slug) };
  }

  /* ---------- 落盘 ---------- */
  const nDesktop = apps.filter(a => a.source === 'desktop').length;
  const bundle = {
    _note: '每日采集产物。netdisk.shareUrl/pwd 由 BaiduPCS-Go 自动回填；tagline/desc/features 需人工或 AI 复核后填写，merge.mjs 拒绝空文案。',
    date: DATE,
    generatedAt: new Date().toISOString(),
    config: {
      quota: cfg.quota,
      desktopQuota: DESKTOP_ENABLED ? DESKTOP_QUOTA : 0,
      sources: cfg.sources,
      mirrors: cfg.mirrors,
      fdroidMirrors: cfg.fdroid.mirrors,
    },
    githubTokenProvided: hasToken,
    rateLimit: { ...quota },
    apps,
    // 手机 App 与电脑软件的名额是分开的，交付数也分开报 ——
    // 合成一个数字会掩盖「今天手机没凑满、但桌面补上了」这种情况
    delivered: {
      total: apps.length,
      android: apps.length - nDesktop,
      desktop: nDesktop,
      androidQuota: cfg.quota,
      desktopQuota: DESKTOP_ENABLED ? DESKTOP_QUOTA : 0,
    },
    rejected: rejected.map(r => ({ fullName: r.repo.fullName, stars: r.repo.stars, license: r.repo.license, why: r.why })),
    downloadFailures,
    netdisk: netdiskReport,
  };
  writeJSON(path.join(DAY_DIR, 'bundle.json'), bundle);

  for (const r of rejected) {
    const key = r.repo.fullName.toLowerCase();
    if (!state.repos[key]) state.repos[key] = { firstSeen: DATE, lastRun: DATE, stage: 'rejected', why: r.why };
  }
  saveState(state);
  savePending(pending);

  const { writeDraft } = await import('./draft.mjs');
  const draftPath = writeDraft(bundle, DAY_DIR, cfg);
  pruneOldDays(DAY_DIR);

  /* ---------- 汇总 ---------- */
  log('\n════════════════ 汇总 ════════════════');
  log(`交付 ${apps.length} 个（手机 App ${apps.length - nDesktop} / 目标 ${cfg.quota}：F-Droid ${apps.filter(a => a.source === 'fdroid').length} · GitHub ${apps.filter(a => a.source === 'github').length}；电脑软件 ${nDesktop} / 目标 ${DESKTOP_ENABLED ? DESKTOP_QUOTA : '已关闭'}）`);
  for (const a of apps) {
    // 桌面端没有包名，改报平台与形态 —— 打印「包名未读到」会让人以为出了问题
    const ident = a.source === 'desktop'
      ? `Windows/${a.desktop ? (a.desktop.assetKind === 'portable' ? '便携版' : '安装器') : '—'}`
      : (a.package || '包名未读到');
    log(`  ✓ [${a.source === 'desktop' ? '电脑' : a.source || '?'}] ${a.name} (${ident}) ${a.versionName || ''}  ★${a.repo.stars ?? '未知'}  ${a.repo.license}  ${a.apk ? humanSize(a.apk.bytes) : '未下载'}  图标${a.icon ? '有' : '缺'}${a.riskFlags.length ? '  ⚠' + a.riskFlags.length + ' 项标记' : ''}`);
  }
  if (downloadFailures.length) {
    log(`下载/解析/核实失败 ${downloadFailures.length} 个：`);
    for (const d of downloadFailures) log(`  ✗ ${d.source === 'desktop' ? '[电脑] ' : ''}${d.fullName}：${d.why.split('\n')[0]}`);
  }
  if (apps.length - nDesktop < cfg.quota) log(`手机 App 未凑满 ${cfg.quota} 个 —— 详见审核表里的落选原因`);
  if (DESKTOP_ENABLED && DESKTOP_QUOTA > 0 && nDesktop < DESKTOP_QUOTA) log(`电脑软件未凑满 ${DESKTOP_QUOTA} 个 —— 详见审核表里的落选原因`);
  log(`待交付队列 ${pending.items.length} 个（下次优先处理，不重复消耗 API）`);
  log(`审核表：${draftPath}`);
  log(`产物目录：${DAY_DIR}`);

  if (netdiskReport.attempted) {
    if (netdiskReport.uploaded) log(`网盘已上传 ${netdiskReport.uploaded} 个目录`);
    if (netdiskReport.shared) log(`已自动创建分享链接 ${netdiskReport.shared} 个，提取码已回填 bundle.json`);
    if (netdiskReport.errors && netdiskReport.errors.length) {
      warn('网盘环节有失败项：');
      for (const e of netdiskReport.errors) log(`  ✗ ${e}`);
      log(`  可执行 ${path.join(DAY_DIR, 'upload.ps1')} 手动补传`);
    }
  } else if (DRY_NO_DOWNLOAD && apps.length) {
    log('\n网盘环节：本轮跳过（--no-download）—— 安装包还没下载，没有可上传的东西。');
    log('  这一轮的作用是看候选质量；确认没问题后去掉 --no-download 再跑一次，才会真的下载并准备上传目录。');
  } else if (netdiskReport.mode === 'manual' && apps.length) {
    log('网盘环节：手动模式 —— 接下来轮到你，三步：');
    log(`  1) 把 ${path.join(DAY_DIR, 'upload')} 里每个文件夹传到百度网盘，并各建一个分享链接`);
    log(`  2) 把分享链接粘进 ${netdiskReport.linksFile || path.join(DAY_DIR, 'links.txt')}（整段粘贴就能认）`);
    log(`  3) 一条命令发布到网站：`);
    log(`       node redesign\\tools\\daily\\publish.mjs --date=${DATE}`);
    log(`  当天详细步骤见：${netdiskReport.guideFile || path.join(DAY_DIR, '上传说明.md')}`);
  } else if (apps.length) {
    warn(`网盘环节未执行：${netdiskReport.reason || '未知原因'}`);
  }
}

/**
 * 检查历史产物里有没有「采集了但没发布」的条目。
 *
 * 为什么需要这道保险：state/seen.json 在**采集成功时**就把包名记为 accepted，
 * 所以第二天不会再推荐同一批。如果你某天没发布，又没注意到 _daily 里的产物，
 * 这批 App 就等于被静默跳过了。这里在每次运行开头把它们点出来。
 */
function warnUnpublished(currentDir) {
  let dirs = [];
  try { dirs = fs.readdirSync(OUT_ROOT); } catch { return; }
  const pendingList = [];
  for (const d of dirs) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const dir = path.join(OUT_ROOT, d);
    if (dir === currentDir) continue;
    const b = readJSON(path.join(dir, 'bundle.json'), null);
    if (!b || !Array.isArray(b.apps)) continue;
    for (const a of b.apps) {
      if (!a.accepted) continue;
      if (a.netdisk && a.netdisk.shareUrl) continue;      // 已建分享链接 = 已发布
      pendingList.push(`${a.name}（${d}）`);
    }
  }
  if (!pendingList.length) return;
  warn(`有 ${pendingList.length} 个历史条目采集了但还没有网盘分享链接：`);
  log(`  ${pendingList.slice(0, 12).join('、')}${pendingList.length > 12 ? ` 等 ${pendingList.length} 个` : ''}`);
  log('  这些 APK 还在各自的 _daily\\<日期>\\upload\\ 里。可以：');
  log('   · 运行该日期的 upload.ps1 补传并建分享链接，再把链接填进 bundle.json 后跑 merge；或');
  log('   · 确认不要了，从 state\\seen.json 里删掉对应条目，让它们重新进入候选池。');
}

/** 清理过期产物，只动 _daily 下符合日期命名的目录 */
function pruneOldDays(currentDir) {  const keep = cfg.output.keepDays || 60;
  if (!keep) return;
  let dirs;
  try { dirs = fs.readdirSync(OUT_ROOT); } catch { return; }
  const cutoff = Date.now() - keep * 86400000;
  let removed = 0;
  for (const d of dirs) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const full = path.join(OUT_ROOT, d);
    if (full === currentDir) continue;
    if (new Date(d).getTime() >= cutoff) continue;
    try { fs.rmSync(full, { recursive: true, force: true }); removed++; } catch { /* 占用中就算了 */ }
  }
  if (removed) log(`已清理 ${removed} 个超过 ${keep} 天的旧产物目录`);
}

main()
  .then(async () => { await closeLog(); })
  .catch(async (e) => {
    fail('流程异常终止：' + (e && e.stack ? e.stack : e));
    if (e && e.rateLimited) log('提示：配置 GITHUB_TOKEN 可把核心 API 配额从 60 次/小时提到 5000。');
    await closeLog();
    process.exitCode = 1;
  });
