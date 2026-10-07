#!/usr/bin/env node
/* ============================================================
   电脑软件 · 候选发现器（只发现，不下载）
   ------------------------------------------------------------
   为什么先做这个而不是直接改每日流水线：
   桌面软件有两个假设必须先验证，验证错了后面全白做 ——
     1) 资产选择准不准。**GitHub 会给每个 Release 自动附
        「Source code (zip)」和「Source code (tar.gz)」，名字里就带 zip。**
        扩展名过滤器不显式排除它们的话，每个仓库都会"看起来有可用资产"，
        然后收进来一堆源码包。
     2) 体积分布能不能承受。桌面软件比 APK 大一个量级，而百度网盘上传慢、
        占空间 —— 到底有多少是 <100MB 的便携版？这个数字决定这个类目值不值得做。

   用法：
     npm.cmd run desktop:discover
     npm.cmd run desktop:discover -- --limit=30 --min-stars=500
   产物：
     _daily/desktop/candidates.json   机器可读
     _daily/desktop/candidates.md     审核表（含体积分布）
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DESKTOP_ASSET_RULES as ASSET_RULES,
  DESKTOP_REJECT_RE as REJECT_RE,
  DESKTOP_REPO_REJECT_RE as REPO_REJECT_RE,
  desktopPlatform as platformOf,
  pickDesktopRelease,
} from './signals.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.join(ROOT, '_daily', 'desktop');
const TOKEN_FILE = path.resolve(__dirname, '..', 'daily', 'state', 'github-token.txt');

const arg = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const LIMIT = Number(arg('limit')) || 25;
const MIN_STARS = Number(arg('min-stars')) || CFG.minStars || 500;
const MAX_MB = Number(arg('max-mb')) || CFG.maxMB || 300;

/* Windows 优先：国内用户 Windows 占绝大多数，macOS 供给量同级但可后置 */
const TOPICS = CFG.topics || ['windows', 'desktop-app'];
const PUSHED_DAYS = CFG.pushedWithinDays || 365;
const re = list => new RegExp(list.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
const DENY_REPO_RE = re(CFG.deny?.repoPatterns || []);
const DENY_DESC_RE = re(CFG.deny?.descPatterns || []);
const SERVER_RE = re(CFG.serverSignals || []);
const NON_APP_RE = re(CFG.nonAppSignals || []);

/* 资产扩展名规则、拒收正则、平台判定全部来自 ./signals.mjs（唯一一份）。
   抽出去的原因：这里的 platformOf 与 daily/channels.mjs 的同名函数曾经各写一份，
   平台判定漂移过一次（x64 只在其中一份里），于是「便携版优先」被静默吃掉。
   规则要改，去 signals.mjs 改；这里的注释只说明为什么这么定：

   平台必须是**硬过滤**，不能当加分项 —— 第一版把「便携版」的权重放在平台之上，
   结果给 Windows 用户挑中了 .dmg 和 .AppImage（实测：Clash Verge 挑中 dmg、
   rustdesk 挑中 AppImage）。国内用户 Windows 占绝大多数，平台错了这条就废了。 */

const TOKEN = (() => {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { return ''; }
})();
if (!TOKEN) { console.error('需要 GitHub Token（未认证核心 API 只有 60 次/小时，跑不动）。'); process.exit(1); }

let requests = 0;
async function api(url) {
  requests++;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'xihaoz-desktop-discover', Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.replace(/^https:\/\/api\.github\.com/, '')}`);
  return res.json();
}

/* ---------- 1. 按 topic 发现仓库 ---------- */
const since = new Date(Date.now() - PUSHED_DAYS * 864e5).toISOString().slice(0, 10);
const byRepo = new Map();
for (const topic of TOPICS) {
  const q = `topic:${topic} stars:>=${MIN_STARS} pushed:>=${since}`;
  let d;
  try { d = await api(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=50`); }
  catch (e) { console.log(`  ${topic.padEnd(16)} 失败：${e.message}`); continue; }
  console.log(`  ${topic.padEnd(16)} 命中 ${String(d.total_count).padStart(6)} · 取回 ${d.items.length}`);
  for (const r of d.items) {
    if (byRepo.has(r.full_name) || r.archived) continue;
    byRepo.set(r.full_name, {
      fullName: r.full_name, stars: r.stargazers_count, pushedAt: (r.pushed_at || '').slice(0, 10),
      license: r.license ? r.license.spdx_id : null, desc: (r.description || '').slice(0, 160),
      topics: [topic], defaultBranch: r.default_branch,
    });
  }
  await new Promise(r => setTimeout(r, 250));
}
const repos = [...byRepo.values()].sort((a, b) => b.stars - a.stars);
console.log(`\n  去重后候选仓库 ${repos.length} 个`);

/* ---------- 2. 逐个查 Release，挑可用资产 ---------- */
const picked = repos.slice(0, LIMIT);
const found = [], rejected = [], cases = { onlySource: 0, noRelease: 0, tooBig: 0, tooTiny: 0, otherPlatform: 0, repoRejected: 0, denyProxy: 0, serverApp: 0 };
console.log(`  开始查 Release（每个仓库 1 次请求，最多 ${picked.length} 个）…`);
for (const repo of picked) {
  // 仓库级过滤放在查 Release 之前：既拦住"资产正常但不是应用"的一类，也省一次 API 请求。
  // 判断顺序有讲究：**合规底线优先**，其次是性质（服务端/非应用）。
  const short = repo.fullName.split('/')[1] || '';
  const desc = repo.desc || '';
  const denied = DENY_REPO_RE.exec(short) || DENY_REPO_RE.exec(desc) || DENY_DESC_RE.exec(desc);
  if (denied) {
    rejected.push({ ...repo, why: `**合规底线**：命中代理/翻墙信号「${denied[0]}」` });
    cases.denyProxy++; continue;
  }
  // 服务端信号**只标记，不硬拒**。实测硬拒会两头出错：
  //   误杀：rustdesk（★124k 远程桌面）描述里有 "self-host"，但它主体是桌面客户端
  //   漏过：wiki.js 描述里一个信号词都没有，照样混进来
  // 关键词判断不出「这个仓库的主体是不是桌面应用」，所以交回给人 —— 脚本给标记，人做决定，
  // 这也正是流水线一贯的原则（脚本给事实与建议，收不收由你点头）。
  const srv = SERVER_RE.exec(desc);
  const flags = [];
  if (srv) flags.push(`疑似服务端应用（命中「${srv[0]}」）—— 确认它不是只跑在服务器上的东西再用`);
  const nonApp = NON_APP_RE.exec(desc);
  if (nonApp) {
    rejected.push({ ...repo, why: `非应用（命中「${nonApp[0]}」）` });
    cases.repoRejected++; continue;
  }
  if (REPO_REJECT_RE.test(short)) {
    rejected.push({ ...repo, why: '仓库名像 库/框架/主题/文档/清单' });
    cases.repoRejected++; continue;
  }
  let rels;
  try { rels = await api(`https://api.github.com/repos/${repo.fullName}/releases?per_page=10`); }
  catch (e) { rejected.push({ ...repo, why: e.message }); continue; }
  await new Promise(r => setTimeout(r, 120));

  if (!Array.isArray(rels) || !rels.length) { cases.noRelease++; rejected.push({ ...repo, why: '没有 Release' }); continue; }

  // 挑资产**不再在这里重写一遍**：原来这段打分逻辑与 channels.mjs 的 pickDesktopRelease
  // 是两份实现（规则已漂移过一次），现在统一调用 signals.mjs 里的那一份。
  // 诊断计数（超限/小文件/别的平台）单独轻量扫一遍就够 —— 它们只进报告，不参与判定。
  for (const rel of rels) {
    if (rel.draft || rel.prerelease) continue;
    for (const a of rel.assets || []) {
      if (REJECT_RE.test(a.name)) { if (/source\s*code/i.test(a.name)) sawSourceOnly = true; continue; }
      const rule = ASSET_RULES.find(([re]) => re.test(a.name));
      if (!rule) continue;
      const plat = platformOf(a.name, rule[2]);
      if (plat && plat !== 'win') { sawOtherPlatform = true; continue; }
      const mb = a.size / 1048576;
      if (mb > MAX_MB) { cases.tooBig++; continue; }
      if (mb < (rule[1] === 'portable' ? (CFG.minPortableMB || 1) : (CFG.minInstallerMB || 0.05))) cases.tooTiny++;
    }
  }
  const pick = pickDesktopRelease(rels, { platform: 'win', maxDesktopMB: MAX_MB, minPortableMB: CFG.minPortableMB, minInstallerMB: CFG.minInstallerMB });
  if (!pick) {
    if (sawOtherPlatform) cases.otherPlatform++;
    else if (sawSourceOnly) cases.onlySource++;
    rejected.push({
      ...repo,
      why: sawOtherPlatform ? '只有 macOS / Linux 资产（Windows 频道不收，留作以后）'
        : sawSourceOnly ? '**只有 Source code 资产**（正是那个陷阱）' : '没有可用的可执行资产',
    });
    continue;
  }
  found.push({
    slug: repo.fullName.split('/')[1].toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    repo: repo.fullName, stars: repo.stars, pushedAt: repo.pushedAt, license: repo.license, desc: repo.desc,
    tag: pick.release.tag, asset: pick.asset.name, kind: pick.kind, mb: pick.mb,
    downloads: pick.asset.downloads, digest: pick.asset.digest || null,
    flags,
    allAssets: pick.alternatives || [],
  });
  console.log(`    ✓ ${repo.fullName.padEnd(44)} ${pick.kind.padEnd(9)} ${pick.mb.toFixed(1).padStart(6)}MB  ${pick.asset.name.slice(0, 34)}`);
}

/* ---------- 3. 报告：体积分布是这个类目能不能做的关键 ---------- */
const sorted = found.slice().sort((a, b) => a.mb - b.mb);
const bucket = (lo, hi) => sorted.filter(x => x.mb >= lo && x.mb < hi).length;
const licensed = found.filter(f => f.license).length;

console.log(`\n———————— 结果 ————————————————`);
console.log(`  查到可用资产的仓库 ${found.length} / ${picked.length}`);
console.log(`  体积分布： <20MB ${bucket(0, 20)} · 20-50MB ${bucket(20, 50)} · 50-100MB ${bucket(50, 100)} · 100-300MB ${bucket(100, 301)}`);
console.log(`  形态： 便携版 ${found.filter(f => f.kind === 'portable').length} · 安装器 ${found.filter(f => f.kind === 'installer').length}`);
console.log(`  有明确协议 ${licensed} / ${found.length}`);
console.log(`  落选构成： 合规底线拦下 ${cases.denyProxy} · 服务端应用 ${cases.serverApp} · 非应用/库框架 ${cases.repoRejected} · 只有 mac/linux 资产 ${cases.otherPlatform} · 只有源码资产 ${cases.onlySource} · 没有 Release ${cases.noRelease} · 跳过的超大资产 ${cases.tooBig} 个 · 跳过的小文件 ${cases.tooTiny} 个`);
console.log(`  API 请求 ${requests} 次`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'candidates.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  config: { topics: TOPICS, minStars: MIN_STARS, maxMB: MAX_MB, limit: LIMIT },
  cases, found: sorted, rejected,
}, null, 2) + '\n');

const totalMB = sorted.reduce((n, f) => n + f.mb, 0);
fs.writeFileSync(path.join(OUT, 'candidates.md'), [
  `# 电脑软件候选审核表（${new Date().toISOString().slice(0, 10)}）`,
  '',
  `查到可用资产 **${found.length}** 个（探测 ${picked.length} 个仓库）· 合计 **${(totalMB / 1024).toFixed(2)} GB**`,
  '',
  `体积分布：<20MB **${bucket(0, 20)}** · 20–50MB **${bucket(20, 50)}** · 50–100MB **${bucket(50, 100)}** · 100–${MAX_MB}MB **${bucket(100, 301)}**`,
  '',
  `> 体积是这个类目能不能做的关键：百度网盘上传慢、占空间。上表决定每天能发几个。`,
  '',
  '| 仓库 | ★ | 协议 | 形态 | 体积 | 资产 |',
  '| --- | ---: | --- | --- | ---: | --- |',
  ...sorted.map(f => `| ${f.repo} | ${f.stars} | ${f.license || '**无**'} | ${f.kind === 'portable' ? '便携版' : '安装器'} | ${f.mb} MB | \`${f.asset}\` |`),
  '',
  `## 落选（${rejected.length} 个）`,
  '',
  '| 仓库 | ★ | 原因 |',
  '| --- | ---: | --- |',
  ...rejected.slice(0, 30).map(r => `| ${r.fullName} | ${r.stars} | ${r.why} |`),
  '',
].join('\n'));

console.log(`\n  已写出 _daily/desktop/candidates.json 与 candidates.md`);
