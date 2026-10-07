/* ============================================================
   通道层：GitHub API + 国内可用镜像
   ------------------------------------------------------------
   实测结论（2026-09，本机）：
     api.github.com                        ✅ 可达
     codeload.github.com                   ✅ 可达
     objects.githubusercontent.com         ✅ 可达
     release-assets.githubusercontent.com  ❌ 超时（Release 资产真正落在的域）
     raw.githubusercontent.com             ❌ 超时
     cdn.jsdelivr.net / f-droid.org        ❌ 超时
     ghproxy.net / gh-proxy.com / ghfast.top ✅ 能代理上面两个 ❌ 的域

   所以：API 直连，文件下载一律走镜像，并做多镜像故障转移。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { log, warn, sleep, humanSize, isZip, sha256File, sniffImage } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UA = 'xihaouc-daily-collector (+https://github.com/)';

/**
 * Token 来源优先级：环境变量 → 本地文件。
 * 配了 token 核心 API 配额从 60 次/小时升到 5000，采集不再容易中途断。
 * 只读 fine-grained token 即可（不需要勾任何权限），过期了就换一个。
 */
function loadToken() {
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN.trim(), from: 'env GITHUB_TOKEN' };
  if (process.env.GH_TOKEN) return { token: process.env.GH_TOKEN.trim(), from: 'env GH_TOKEN' };
  const f = path.join(__dirname, 'state', 'github-token.txt');
  try {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (t) return { token: t, from: f };
  } catch { /* 没配就没有 */ }
  return { token: '', from: null };
}
const TOKEN_INFO = loadToken();
const TOKEN = TOKEN_INFO.token;
export const hasToken = !!TOKEN;
export const tokenSource = TOKEN_INFO.from;

/* GitHub 核心 API 配额快照，供流程判断要不要提前收工 */
export const quota = { coreRemaining: null, coreLimit: null, coreReset: null, searchRemaining: null };

function headers(extra = {}) {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': UA, ...extra };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

async function ghFetch(url, { attempt = 0 } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(30000) });
  } catch (e) {
    if (attempt < 3) { await sleep(1500 * (attempt + 1)); return ghFetch(url, { attempt: attempt + 1 }); }
    throw new Error(`网络失败: ${e.message}`);
  }

  const isCore = !url.includes('/search/');
  const rem = res.headers.get('x-ratelimit-remaining');
  const lim = res.headers.get('x-ratelimit-limit');
  const rst = res.headers.get('x-ratelimit-reset');
  if (rem != null) {
    if (isCore) { quota.coreRemaining = +rem; quota.coreLimit = +lim; quota.coreReset = +rst; }
    else quota.searchRemaining = +rem;
  }

  if (res.status === 403 || res.status === 429) {
    const waitMs = rst ? Math.max(3000, (+rst * 1000) - Date.now() + 2000) : 60000;
    if (!TOKEN && isCore && +rem === 0) {
      const err = new Error(`GitHub 核心 API 配额耗尽，${Math.round(waitMs / 1000)}s 后恢复（未认证只有 60 次/小时，配 GITHUB_TOKEN 可到 5000）`);
      err.rateLimited = true;
      throw err;
    }
    if (attempt < 2) {
      warn(`限流，等待 ${Math.round(waitMs / 1000)}s 后重试…`);
      await sleep(Math.min(waitMs, 70000));
      return ghFetch(url, { attempt: attempt + 1 });
    }
    throw new Error(`限流 (${res.status})`);
  }
  if (res.status === 404) { const e = new Error('404 不存在'); e.notFound = true; throw e; }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ---------- 搜索 ---------- */
export async function searchRepos(q, { sort = 'stars', order = 'desc', page = 1, perPage = 30 } = {}) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}`
    + `&sort=${sort}&order=${order}&per_page=${perPage}&page=${page}`;
  const j = await ghFetch(url);
  return {
    total: j.total_count,
    items: (j.items || []).map(normalizeRepo),
  };
}

export function normalizeRepo(it) {
  return {
    fullName: it.full_name,
    owner: it.owner ? it.owner.login : null,
    name: it.name,
    url: it.html_url,
    desc: it.description || '',
    stars: it.stargazers_count,
    forks: it.forks_count,
    license: it.license ? (it.license.spdx_id || null) : null,
    licenseName: it.license ? (it.license.name || null) : null,
    lang: it.language,
    topics: it.topics || [],
    archived: !!it.archived,
    fork: !!it.fork,
    homepage: it.homepage || null,
    defaultBranch: it.default_branch || 'main',
    createdAt: it.created_at,
    pushedAt: it.pushed_at,
    sizeKB: it.size,
    openIssues: it.open_issues_count,
    avatar: it.owner ? it.owner.avatar_url : null,
  };
}

export async function getRepo(fullName) {
  return normalizeRepo(await ghFetch(`https://api.github.com/repos/${fullName}`));
}

/* ---------- Release ---------- */
export async function listReleases(fullName, perPage = 10) {
  const arr = await ghFetch(`https://api.github.com/repos/${fullName}/releases?per_page=${perPage}`);
  return (Array.isArray(arr) ? arr : []).map(r => ({
    tag: r.tag_name,
    name: r.name || r.tag_name,
    draft: !!r.draft,
    prerelease: !!r.prerelease,
    publishedAt: r.published_at,
    createdAt: r.created_at,
    body: (r.body || '').slice(0, 4000),
    assets: (r.assets || []).map(a => ({
      name: a.name,
      size: a.size,
      downloads: a.download_count,
      url: a.browser_download_url,
      contentType: a.content_type,
      digest: a.digest || null,          // 新版 API 直接给 "sha256:xxxx"
      updatedAt: a.updated_at,
    })),
    tarballUrl: r.tarball_url,
    zipballUrl: r.zipball_url,
  }));
}

/**
 * 从 Release 列表里挑出「最值得打包的那个 APK」。
 * 规则：跳过 draft / 预发布 / debug 包；优先 universal > arm64 > 其它；
 *       同类里优先下载数高的（下载数是「能不能用」的民间投票）。
 */
export function pickApkRelease(releases, cfg = {}) {
  const rejectDebug = cfg.rejectDebugBuilds !== false;
  const maxMB = cfg.maxApkMB || 300;
  const minMB = cfg.minApkMB || 0.05;

  const scored = [];
  for (const rel of releases) {
    if (rel.draft) continue;
    if (rel.prerelease) continue;
    for (const a of rel.assets) {
      const lower = a.name.toLowerCase();
      if (!lower.endsWith('.apk')) continue;
      if (rejectDebug && /(debug|unsigned|test)\.apk$/.test(lower)) continue;
      const mb = a.size / 1048576;
      if (mb > maxMB || mb < minMB) continue;

      let pref = 0;
      if (/universal|all[-_.]?abi|fat/.test(lower)) pref += 3;
      if (/arm64|aarch64|arm64-v8a/.test(lower)) pref += 2;
      if (/armeabi|armv7/.test(lower)) pref += 1;
      if (/fdroid|f-droid|release/.test(lower)) pref += 1;
      if (/x86/.test(lower)) pref -= 2;

      scored.push({ rel, asset: a, pref, publishedAt: rel.publishedAt || rel.createdAt });
    }
  }
  if (!scored.length) return null;

  scored.sort((x, y) => {
    if (y.pref !== x.pref) return y.pref - x.pref;
    if (y.asset.downloads !== x.asset.downloads) return y.asset.downloads - x.asset.downloads;
    return new Date(y.publishedAt || 0) - new Date(x.publishedAt || 0);
  });
  const best = scored[0];
  return { release: best.rel, asset: best.asset, allApks: scored.map(s => s.asset.name) };
}

/* ---------- 电脑软件（Windows）：资产选择 ----------
   pickDesktopRelease（含平台判定、扩展名规则、Source code 陷阱的正则）已统一到
   tools/desktop/signals.mjs —— 原先这里和 desktop/discover.mjs 各有一份，
   平台判定漂移过一次（x64 只在其中一份里），所以规则只保留一处。
   那里的注释写清了每条规则对应的坑，改规则请去那里改。 */

export { pickDesktopRelease } from '../desktop/signals.mjs';

/* ---------- 文件下载（按实测速度排序 + 多镜像故障转移） ---------- */

/**
 * 镜像实测速度（2026-09，本机，138MB 的 APK）：
 *   ghfast.top    6.3 MB/s   ← 最快
 *   gh-proxy.com  2.0 MB/s
 *   ghproxy.net   0.8 MB/s   ← 慢 8 倍，放在最后
 *   direct        被墙，0 字节
 * 速度会随时间变化，所以这里边用边测：把每次成功的吞吐量记进
 * state/mirror-stats.json，下次按实测速度从快到慢排队。
 */
const MIRROR_STATS_FILE = path.join(__dirname, 'state', 'mirror-stats.json');
const DEFAULT_SPEED = 1.5 * 1048576;   // 没测过的镜像给个中位估计，MB/s

function loadMirrorStats() {
  try { return JSON.parse(fs.readFileSync(MIRROR_STATS_FILE, 'utf8')); }
  catch { return { _note: '各镜像的实测吞吐量（字节/毫秒）。自动更新，可随时删掉重新学习。', mirrors: {} }; }
}
function saveMirrorStats(stats) {
  try {
    fs.mkdirSync(path.dirname(MIRROR_STATS_FILE), { recursive: true });
    fs.writeFileSync(MIRROR_STATS_FILE, JSON.stringify(stats, null, 2), 'utf8');
  } catch { /* 写不了就算了，不影响下载 */ }
}
function recordMirrorSpeed(host, bytes, ms) {
  if (!host || !bytes || !ms) return;
  const stats = loadMirrorStats();
  const e = stats.mirrors[host] || { samples: 0, avgBps: null, lastBps: null };
  const bps = bytes / ms;                     // 字节/毫秒
  e.avgBps = e.avgBps == null ? bps : (e.avgBps * 0.6 + bps * 0.4);   // 指数平滑，重近期表现
  e.lastBps = bps;
  e.samples = (e.samples || 0) + 1;
  e.updatedAt = new Date().toISOString();
  stats.mirrors[host] = e;
  saveMirrorStats(stats);
}

export function mirrorCandidates(url, mirrors, tryDirect) {
  const stats = loadMirrorStats();
  const list = [];
  for (const m of mirrors) {
    const host = new URL(m).host;
    const s = stats.mirrors[host];
    list.push({ label: host, url: m.replace(/\/?$/, '/') + url, speed: s && s.avgBps ? s.avgBps : DEFAULT_SPEED, measured: !!(s && s.avgBps) });
  }
  // 快的排前面；没测过的按默认估计参与排队，跑几次就能自己学到真实速度
  list.sort((a, b) => b.speed - a.speed);
  if (tryDirect) list.unshift({ label: 'direct', url, speed: Infinity, measured: false });
  return list;
}

export function rawUrl(owner, repo, ref, file) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${file}`;
}

/**
 * 下载文件到本地，逐镜像重试。三件事必须做对，否则大包必挂：
 *   1. 卡死检测：镜像可能中途彻底静默。只设总超时会导致白等几分钟，
 *      所以额外监控「静默时长」，超时立刻换通道。
 *   2. 断点续传：镜像都支持 Range（实测 206），换通道时接着下，不从头再来。
 *      单通道总超时也设得偏短，让慢通道尽早让位给快通道。
 *   3. 完整性校验：优先比对 release 给的 sha256（权威），没有就比对大小。
 *      校验不过就删掉重来一轮，绝不把半个包上传到网盘。
 *
 * 流式用 pipeline 而不是手写 write/'drain'：
 * 后者在写流出错时 await 会永久挂住，且不会把错误带出来。
 */
export async function downloadTo(url, destPath, {
  mirrors = [], tryDirect = false, extraUrls = [], expectSize = null, expectSha256 = null,
  timeoutMs = 240000, stallMs = 25000, minBytes = 1024, label = '',
} = {}) {
  const cands = mirrorCandidates(url, mirrors, tryDirect);
  // extraUrls 是「同一个文件的其它完整地址」（例如 F-Droid 的其它镜像），
  // 已经是绝对地址，不能再套 GitHub 镜像前缀，所以排在按速度排好的候选之后。
  for (const u of extraUrls) {
    try { cands.push({ label: new URL(u).host, url: u, speed: 0, measured: false }); } catch {}
  }
  const part = destPath + '.part';
  const errors = [];
  const wantSha = expectSha256 ? String(expectSha256).replace(/^sha256:/, '') : null;

  const verify = async () => {
    if (!fs.existsSync(part)) return { ok: false, why: '临时文件不存在' };
    const st = fs.statSync(part);
    if (st.size < minBytes) return { ok: false, why: `文件过小 ${st.size}B` };
    if (expectSize && Math.abs(st.size - expectSize) > 1024) {
      return { ok: false, why: `大小不符：期望 ${expectSize}B 实得 ${st.size}B` };
    }
    const got = await sha256File(part);
    if (wantSha && got !== wantSha) {
      return { ok: false, why: `sha256 不符（期望 ${wantSha.slice(0, 12)}… 实得 ${got.slice(0, 12)}…）` };
    }
    return { ok: true, sha256: got };
  };

  const MAX_ROUNDS = 2;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    for (const c of cands) {
      const stat0 = fs.existsSync(part) ? fs.statSync(part).size : 0;
      const t0 = Date.now();
      const ac = new AbortController();
      let abortedBy = null;
      let lastData = Date.now();
      const idleTimer = setInterval(() => {
        if (Date.now() - lastData > stallMs) {
          abortedBy = `静默 ${Math.round((Date.now() - lastData) / 1000)}s 无数据`;
          ac.abort();
        }
      }, 4000);
      const totalTimer = setTimeout(() => { abortedBy = `单通道超过 ${Math.round(timeoutMs / 1000)}s`; ac.abort(); }, timeoutMs);

      try {
        const headers = { 'User-Agent': UA, Accept: '*/*' };
        if (stat0 > 0) headers.Range = `bytes=${stat0}-`;

        const res = await fetch(c.url, { headers, redirect: 'follow', signal: ac.signal });
        if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
        if (!res.body) throw new Error('响应无正文');

        // 服务端不认 Range（返回 200）时必须从零开始，否则会拼出坏文件
        let startAt = stat0;
        if (startAt > 0 && res.status !== 206) {
          fs.rmSync(part, { force: true });
          startAt = 0;
        }
        const declared = +res.headers.get('content-length') || 0;
        const expectedTotal = startAt > 0 ? startAt + declared : declared;

        let bytes = startAt;
        const counter = new Transform({
          transform(chunk, _enc, cb) { lastData = Date.now(); bytes += chunk.length; cb(null, chunk); },
        });
        await pipeline(
          Readable.fromWeb(res.body),
          counter,
          fs.createWriteStream(part, startAt > 0 ? { flags: 'a' } : {}),
        );

        if (expectedTotal && bytes !== expectedTotal) {
          throw new Error(`传输不完整 ${bytes}/${expectedTotal}`);
        }

        // 容器终检：必须是 zip（APK 就是 zip），挡掉镜像返回的 HTML 错误页
        const fd = fs.openSync(part, 'r');
        const head = Buffer.alloc(4);
        fs.readSync(fd, head, 0, 4, 0);
        fs.closeSync(fd);
        if (!isZip(head)) throw new Error('不是 zip 容器，镜像可能返回了错误页');

        const v = await verify();
        if (!v.ok) throw new Error(v.why);

        fs.renameSync(part, destPath);
        const ms = Date.now() - t0;
        const throughput = bytes - startAt;
        recordMirrorSpeed(c.label, throughput, ms);
        log(`    下载完成 via ${c.label}：${humanSize(bytes)}（本轮续传 ${humanSize(startAt)}），`
          + `${(throughput / 1048576 / (ms / 1000)).toFixed(1)} MB/s，sha256 ${v.sha256.slice(0, 12)}…`);
        return { path: destPath, bytes, sha256: v.sha256, mirror: c.label, ms, verified: true, resumed: startAt > 0 };
      } catch (e) {
        const why = abortedBy || `${e.name || 'Error'}: ${e.message}`;
        errors.push(`${c.label}: ${why}`);
        const nowStat = fs.existsSync(part) ? fs.statSync(part).size : 0;
        if (nowStat > stat0) {
          log(`    ${c.label} 中断于 ${humanSize(nowStat)}（已保留，换通道续传）：${why}`);
          recordMirrorSpeed(c.label, nowStat - stat0, Date.now() - t0);
        } else {
          log(`    ${c.label} 失败：${why}`);
        }
      } finally {
        clearInterval(idleTimer);
        clearTimeout(totalTimer);
      }
    }
    // 所有通道都失败：如果 .part 有内容，删掉重来一轮，
    // 排除「不同通道的字节拼在一起导致文件损坏」这种可能
    const partSize = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (round === 0 && partSize > 0) {
      warn(`所有通道失败，丢弃 ${humanSize(partSize)} 半成品，从头重试一轮`);
      fs.rmSync(part, { force: true });
    }
  }

  const err = new Error(`全部镜像失败（${cands.length} 个通道 × ${MAX_ROUNDS} 轮）\n      ` + errors.join('\n      '));
  err.downloadErrors = errors;
  throw err;
}

/** 小文件（LICENSE / README / 图标）走镜像读进内存 */
export async function fetchSmall(url, { mirrors = [], tryDirect = true, maxBytes = 4 * 1024 * 1024, timeoutMs = 20000 } = {}) {
  for (const c of mirrorCandidates(url, mirrors, tryDirect)) {
    try {
      const res = await fetch(c.url, {
        headers: { 'User-Agent': UA }, redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > maxBytes) continue;
      return { buf, mirror: c.label };
    } catch { /* 试下一个通道 */ }
  }
  return null;
}

/* ---------- 图标兜底：从源码仓库里找官方素材 ---------- */
/**
 * 什么情况下需要它：APK 里没有可信的启动图标位图。
 * 实测多种成因，都是真实存在的形态：
 *   · 纯矢量自适应图标（Adaptive Theme 包内 0 张 PNG、HTTP Request Shortcuts 的前景是 VectorDrawable）
 *   · 启动图标只存在于 anydpi-v26 的 XML 里
 *
 * 为什么不用 F-Droid 自己的图标：索引里的 localized.*.icon 指向
 * <镜像>/fdroid/repo/icon_xxx.png，实测在清华 TUNA 上是 404
 * —— TUNA 只镜像了索引与 APK，没镜像图标。所以只能回源码仓库找。
 */
/**
 * 候选路径。前几条是按**包名**查的：有些仓库（例如 thunderbird-android 这种
 * 一个仓库出多个包的项目）把图标放在 app-metadata/<包名>/en-US/images/icon.png，
 * 而不是通用的 fastlane 路径 —— K-9 Mail 就是靠这条才找到官方图标的。
 */
function repoIconPaths(packageName) {
  const pkg = packageName ? String(packageName).trim() : null;
  const list = [];
  if (pkg) {
    list.push(`app-metadata/${pkg}/en-US/images/icon.png`,
              `metadata/${pkg}/en-US/images/icon.png`,
              `${pkg}/en-US/images/icon.png`);
  }
  list.push(
    'fastlane/metadata/android/en-US/images/icon.png',
    'fastlane/metadata/android/en-US/images/icon.jpg',
    'fastlane/metadata/android/en-US/images/icon.webp',
    'fastlane/metadata/android/en-GB/images/icon.png',
    'build/icon.png',
    'build/icons/icon.png',
    'assets/icon/icon.png',
    'assets/logo.png',
    'assets/images/logo.png',
    'docs/icon.png',
    'icon.png',
  );
  return list;
}

/**
 * 桌面软件的候选路径。
 * 为什么不能复用上面那串：里面有 fastlane/metadata/android/**，那是 Android 的目录约定，
 * 桌面仓库里不存在；而桌面项目放图标的地方是另一批（assets/icon.png、build/icon.png、
 * 打包器生成的 icons/ 目录等）。实测 Windows 桌面项目最常见的两处就是 assets/ 与 build/。
 *
 * ⚠ 刻意不查 src-tauri/icons/icon.png：Tauri 的默认图标是脚手架生成的占位图，
 *   十个 Tauri 项目里九个长得一样，拿来当应用图标比"缺图标"更糟（站点会显示首字标记，
 *   那是诚实的；贴一张错的图是不诚实的）。
 */
function repoIconPathsDesktop() {
  return [
    'assets/icon.png', 'assets/icon.jpg', 'assets/logo.png', 'assets/images/logo.png',
    'build/icon.png', 'build/icon.ico', 'build/icon.jpg',
    'resources/icon.png', 'resources/icon.jpg', 'resources/logo.png',
    'public/icon.png', 'public/logo.png', 'public/favicon.png',
    'docs/icon.png', 'icon.png', 'logo.png',
  ];
}
const REPO_ICON_MAX_REQUESTS = 12;   // 限制请求数，避免为一个图标把时间耗光

/**
 * 从源码仓库里找图标。
 * @param {object} repo  normalizeRepo 结构
 * @param {object} cfg   daily config（要里面的 mirrors）
 * @param {string|null} packageName  Android 用（按包名找 fastlane 目录）；桌面传 null
 * @param {'android'|'desktop'} kind  决定候选路径集合
 */
export async function fetchRepoIcon(repo, cfg = {}, packageName = null, kind = 'android') {
  const mirrors = cfg.mirrors || [];
  const owner = repo.owner || String(repo.fullName).split('/')[0];
  const rname = repo.name || String(repo.fullName).split('/')[1];
  const branches = [repo.defaultBranch || 'main'];
  if (branches[0] !== 'master') branches.push('master');
  const paths = kind === 'desktop' ? repoIconPathsDesktop() : repoIconPaths(packageName);
  let requests = 0;
  const tried = [];
  for (const br of branches) {
    for (const p of paths) {
      if (requests >= REPO_ICON_MAX_REQUESTS) return { failed: true, tried };
      requests++;
      const got = await fetchSmall(rawUrl(owner, rname, br, p), { mirrors, tryDirect: false, timeoutMs: 12000 });
      if (!got || got.buf.length < 200) { tried.push(`${br}/${p}:取不到`); continue; }
      const kind = sniffImage(got.buf);
      if (!kind) { tried.push(`${br}/${p}:不是图片`); continue; }
      return { buf: got.buf, kind, path: `${br}/${p}`, mirror: got.mirror };
    }
  }
  return { failed: true, tried };
}
