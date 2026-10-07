#!/usr/bin/env node
/* ============================================================
   技能类目 · 候选发现器
   ------------------------------------------------------------
   它只做一件事：把「GitHub 上哪些目录是 skill」找出来，并如实记下每个目录的授权状态。
   不下载、不打包、不写文案 —— 那三步是后面的工序，各自需要你的判断。

   为什么这么设计（都是实测逼出来的）：
   1) 技能条目的原子单位是 SKILL.md **目录**，不是仓库。
      实测 anthropics/skills 一个仓库里 20 个 skill，wshobson/agents 里 183 个 ——
      按仓库收 2 条，按目录收 203 条，差 100 倍。页面数量就差在这里。
   2) 授权必须**按目录**判。实测 anthropics/skills 的仓库级 license 字段是 null，
      但每个 skill 目录里各有一份 LICENSE.txt。若沿用仓库级协议闸门，
      这个最优质的技能源会被整仓拒收，而且日志只会写「无明确许可」，看不出真因。
   3) topic 标记被滥用，必须跨 topic 去重，且**类型不能靠 topic 判定**。
      实测 topic:mcp-server 按 Star 排序第一名是 n8n（工作流平台，只是顺带支持 MCP）。

   用法：
     npm run skills:discover                 # 按 sources.json 配置跑
     npm run skills:discover -- --limit=60   # 多内省一些仓库
     npm run skills:discover -- --dry        # 只发现不写文件
   产物：
     _daily/skills/candidates.json   机器可读的候选池（含每个 skill 的授权来源）
     _daily/skills/candidates.md     给你看的审核表
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));
const OUT_DIR = path.join(ROOT, '_daily', 'skills');
const TOKEN_FILE = path.resolve(__dirname, '..', 'daily', 'state', 'github-token.txt');

const arg = k => {
  const a = process.argv.find(x => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : '';
};
const DRY = process.argv.includes('--dry');
const LIMIT = Number(arg('limit')) || CFG.maxReposPerRun || 40;
const MIN_STARS = Number(arg('min-stars')) || CFG.minStars || 200;

/* ---------- Token（与 daily/channels.mjs 同样的优先级） ---------- */
const TOKEN = (() => {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { return ''; }
})();
if (!TOKEN) {
  console.error('没有 GitHub Token。未认证只有 60 次/小时，内省 40 个仓库就会中途耗尽。');
  console.error('先按 npm run token 的提示配好再跑。');
  process.exit(1);
}

const stats = { requests: 0, rateRemaining: null };
async function api(url) {
  stats.requests++;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'xihaoz-skill-discover',
      Authorization: `Bearer ${TOKEN}`,
    },
    signal: AbortSignal.timeout(40000),
  });
  const rem = res.headers.get('x-ratelimit-remaining');
  if (rem != null) stats.rateRemaining = +rem;
  if (res.status === 403 || res.status === 429) {
    if (stats.rateRemaining === 0) throw new Error('API 配额耗尽，等配额重置后重跑（已扫到的结果会保留在内存里，但本轮不会写文件）');
    throw new Error(`限速 HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 1. 按 topic 发现候选仓库 ---------- */
const since = new Date(Date.now() - (CFG.pushedWithinDays || 240) * 864e5).toISOString().slice(0, 10);
const byRepo = new Map();
const topicStats = [];

for (const src of CFG.sources) {
  for (const topic of src.topics) {
    const q = `topic:${topic} stars:>=${MIN_STARS} pushed:>=${since}`;
    let data;
    try {
      data = await api(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=50`);
    } catch (e) {
      topicStats.push({ topic, error: e.message });
      console.log(`  ${topic.padEnd(26)} 失败：${e.message}`);
      continue;
    }
    topicStats.push({ topic, available: data.total_count, fetched: data.items.length });
    console.log(`  ${topic.padEnd(26)} 命中 ${String(data.total_count).padStart(6)} · 取回 ${data.items.length}`);
    for (const r of data.items) {
      const prev = byRepo.get(r.full_name);
      if (prev) { prev.topics.push(topic); continue; }   // 跨 topic 去重，同时记下「被几个 topic 同时挂」
      byRepo.set(r.full_name, {
        fullName: r.full_name,
        stars: r.stargazers_count,
        pushedAt: (r.pushed_at || '').slice(0, 10),
        archived: !!r.archived,
        repoLicense: r.license ? r.license.spdx_id : null,
        desc: (r.description || '').slice(0, 200),
        topics: [topic],
        source: src.id,
        deliverable: src.deliverable || 'package',
        defaultBranch: r.default_branch,
      });
    }
    await sleep(150);
  }
}

/* ---------- 授权判定：存在 LICENSE 文件 ≠ 允许再分发 ----------
   这是第一版工具的漏洞：n8n 用的是 Sustainable Use License（fair-code，限制商用），
   不是开源协议，但它有 LICENSE 文件，于是被标成「有授权 42 个」。
   所以不能只判断「有没有协议文件」，要判断「协议是否允许再分发」。 */
const SPDX_ALLOW = ['MIT', 'Apache-2.0', 'GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0',
  'AGPL-3.0', 'MPL-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Unlicense', 'CC0-1.0',
  'Zlib', '0BSD', 'MIT-0', 'EPL-2.0', 'CC-BY-4.0', 'CC-BY-SA-4.0'];
const TEXT_DENY = [
  [/sustainable use license/i, 'Sustainable Use License（fair-code，限制商用）'],
  [/business source license/i, 'Business Source License（限时专有）'],
  [/elastic license/i, 'Elastic License（限制提供托管服务）'],
  [/server side public license|SSPL/i, 'SSPL（非 OSI 认可）'],
  [/non-?commercial/i, '非商业条款（NC）'],
  [/CC BY-NC/i, 'CC BY-NC（禁止商用）'],
  [/all rights reserved/i, '保留所有权利'],
  [/proprietary/i, '专有授权'],
];
const TEXT_ALLOW = [
  [/MIT License/i, 'MIT'], [/Apache License/i, 'Apache-2.0'],
  [/GNU (GENERAL|LESSER|AFFERO) PUBLIC LICENSE/i, 'GPL 系'],
  [/Mozilla Public License/i, 'MPL-2.0'], [/BSD .*License|Redistribution and use/i, 'BSD'],
  [/ISC License/i, 'ISC'], [/The Unlicense|This is free and unencumbered/i, 'Unlicense'],
  [/CC0|Creative Commons Zero/i, 'CC0'],
];

/** 读协议文件判定协议。
    通道：api.github.com 的 git/blobs（Accept: raw）。
    为什么不用 raw.githubusercontent.com：实测本机时通时不通（185.199.x.x 连接超时）。
    这不是性能问题而是**正确性问题**：读不到协议文件会被判成「无明确授权」，
    于是可打包条目被静默降级成「仅介绍」—— 网络抖一下，合规结论就变了。
    所以这里走稳定通道，并把失败次数统计出来，失败多了直接让整轮跑失败。 */
const licStats = { ok: 0, denied: 0, unknown: 0, failed: 0 };
async function classifyLicense(repo, blobSha, filePath) {
  const url = `https://api.github.com/repos/${repo}/git/blobs/${blobSha}`;
  let text;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github.raw',
          'User-Agent': 'xihaoz-skill-discover',
          Authorization: `Bearer ${TOKEN}`,
        },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 403 || res.status === 429) throw new Error(`限速 HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = (await res.text()).slice(0, 20000);
      break;
    } catch (e) {
      if (attempt === 2) {
        licStats.failed++;
        throw new Error(`读协议失败：${e.message}（${repo}/${filePath}）`);
      }
      await sleep(800 * (attempt + 1));
    }
  }
  for (const [re, why] of TEXT_DENY) if (re.test(text)) { licStats.denied++; return { ok: false, why }; }
  for (const [re, name] of TEXT_ALLOW) if (re.test(text)) { licStats.ok++; return { ok: true, why: name }; }
  licStats.unknown++;
  return { ok: null, why: '协议文件内容不匹配已知开源协议，需人工确认' };
}

/* ---------- 聚合仓库识别 ----------
   实测：ComposioHQ/awesome-claude-skills 里有 864 个 SKILL.md、nexu-io/open-design 537 个、
   ruvnet/ruflo 361 个 —— 这些都是**转抄**别处的 skill（250 组同名重复就是证据：
   algorithmic-art 同时出现在 anthropics/skills 官方库和两个聚合仓库里）。
   聚合仓库的仓库根协议覆盖不了被转抄内容的真实授权，所以不能作为打包来源。
   但它们仍然有用：当作「发现索引」，顺藤摸到原始仓库。 */
const AGG_NAME_RE = /(awesome|collection|curated|directory|marketplace|handbook|-list$|^list-)/i;
const VENDOR_PATH_RE = /(^|\/)(vendor|third[_-]?party|external|upstream|node_modules)\//i;

const repos = [...byRepo.values()].filter(r => !r.archived).sort((a, b) => b.stars - a.stars);
const archived = [...byRepo.values()].filter(r => r.archived).length;
console.log(`\n  去重后候选仓库 ${repos.length} 个（已剔除归档 ${archived} 个）`);

const multiTopic = repos.filter(r => r.topics.length > 1);
if (multiTopic.length) {
  console.log(`  其中 ${multiTopic.length} 个仓库被多个 topic 同时挂上（topic 滥用的直接证据）：`);
  for (const r of multiTopic.slice(0, 5)) console.log(`    ${r.fullName} ← ${r.topics.join(' / ')}`);
}

/* ---------- 2. 逐个仓库内省：找 SKILL.md 目录 + 目录级授权 ---------- */
const LICENSE_RE = /(^|\/)(LICENSE|LICENCE|COPYING|UNLICENSE)(\.(md|txt|rst))?$/i;
const picked = repos.slice(0, LIMIT);
const skills = [];
const repoReports = [];
const licCache = new Map();

console.log(`\n  开始内省（每仓库 1 次请求，最多 ${picked.length} 个）…`);
for (const repo of picked) {
  let tree;
  try {
    tree = await api(`https://api.github.com/repos/${repo.fullName}/git/trees/${repo.defaultBranch || 'HEAD'}?recursive=1`);
    await sleep(120);
  } catch (e) {
    repoReports.push({ ...repo, error: e.message, skills: 0 });
    console.log(`    ✗ ${repo.fullName}：${e.message}`);
    continue;
  }
  const files = tree.tree || [];
  const skillMd = files.filter(t => t.type === 'blob' && /(^|\/)SKILL\.md$/i.test(t.path));
  if (!skillMd.length) { repoReports.push({ ...repo, skills: 0, note: '没有 SKILL.md' }); continue; }

  const rootLic = files.find(t => t.type === 'blob' && LICENSE_RE.test(t.path));
  const branch = repo.defaultBranch || 'HEAD';
  const found = [];
  for (const sm of skillMd) {
    const dir = sm.path.replace(/\/SKILL\.md$/i, '');
    // 目录级授权优先：先 skill 目录内，再仓库根，最后才看仓库级字段
    const dirLic = files.find(t => t.type === 'blob' && t.path.startsWith(dir + '/') && LICENSE_RE.test(t.path.replace(dir + '/', '')));
    const licFile = dirLic || rootLic;

    let verdict;
    if (licFile) {
      const key = `${repo.fullName}|${licFile.path}`;
      // 缓存的是 Promise：一个仓库 183 个 skill 共用仓库根那一份协议，只读一次
      if (!licCache.has(key)) licCache.set(key, classifyLicense(repo.fullName, licFile.sha, licFile.path));
      try {
        verdict = await licCache.get(key);
      } catch (e) {
        verdict = { ok: null, why: e.message };
      }
    } else if (repo.repoLicense && SPDX_ALLOW.includes(repo.repoLicense)) {
      verdict = { ok: true, why: repo.repoLicense };
    } else {
      verdict = { ok: false, why: repo.repoLicense ? `${repo.repoLicense} 不在允许清单里` : '找不到协议文件' };
    }

    const inDir = files.filter(t => t.type === 'blob' && t.path.startsWith(dir + '/'));
    found.push({
      repo: repo.fullName,
      repoStars: repo.stars,
      repoPushedAt: repo.pushedAt,
      repoLicense: repo.repoLicense,
      path: dir,
      skillMdPath: sm.path,
      name: dir.split('/').filter(Boolean).pop() || dir,
      depth: dir.split('/').length,
      licenseSource: dirLic ? '目录内' : rootLic ? '仓库根' : repo.repoLicense ? '仓库字段' : null,
      licenseFile: licFile ? licFile.path : null,
      licenseBlob: licFile ? licFile.sha : null,
      license: verdict.ok ? verdict.why : null,
      licenseBlock: verdict.ok ? null : verdict.why,
      distributable: !!verdict.ok,
      vendoredPath: VENDOR_PATH_RE.test(dir + '/'),
      // 文件清单随候选一起带给打包器：省掉打包时再枚举目录，
      // 也就用不着为解 tar 再写一个解析器。blob SHA 也带上 ——
      // 实测 raw.githubusercontent.com 在本机连不通（185.199.x.x 连接超时），
      // 打包器只能走 api.github.com 的 blob 通道，而那个通道需要 blob SHA。
      files: inDir.map(t => ({ path: t.path.slice(dir.length + 1), bytes: t.size || 0, blob: t.sha })),
      dirBytes: inDir.reduce((n, t) => n + (t.size || 0), 0),
      deliverable: repo.deliverable,
      topics: repo.topics,
    });
  }
  skills.push(...found);
  repoReports.push({ ...repo, skills: found.length, licensed: found.filter(s => s.distributable).length, truncated: !!tree.truncated });
  console.log(`    ✓ ${repo.fullName.padEnd(46)} ${String(found.length).padStart(4)} 个 skill · 有授权 ${found.filter(s => s.distributable).length}${tree.truncated ? ' · ⚠ 目录树被截断' : ''}`);
}

/* ---------- 3. 聚合仓库 / 疑似转抄标记 ---------- */
const reportByRepo = Object.fromEntries(repoReports.map(r => [r.fullName, r]));
for (const rr of repoReports) {
  const count = rr.skills || 0;
  const short = rr.fullName.split('/')[1] || '';
  const nameHit = AGG_NAME_RE.test(short) || AGG_NAME_RE.test(rr.desc || '');
  rr.aggregator = nameHit || count >= 120;
  rr.suspect = !rr.aggregator && count >= 30;
  rr.flagWhy = rr.aggregator
    ? (nameHit ? '仓库名或描述命中聚合特征（awesome/collection/list…）' : `单仓库含 ${count} 个 skill，超过 120 的聚合阈值`)
    : rr.suspect ? `单仓库含 ${count} 个 skill，数量异常但没有聚合特征，需人工确认是否转抄` : null;
}
for (const s of skills) {
  const rr = reportByRepo[s.repo] || {};
  s.aggregator = !!rr.aggregator;
  s.suspect = !!rr.suspect;
  s.repoSkillCount = rr.skills || 0;
  s.repoFlagWhy = rr.flagWhy || null;
}

/* ---------- 4. 同名副本：挑出原始来源 ----------
   实测 250 组同名重复，同一个 skill 同时出现在官方库和聚合仓库里。
   规则：非聚合 → 非疑似 → 该仓库 skill 总数少（专职仓库更可能是原始来源）→ Star 高。 */
const byName = {};
for (const s of skills) (byName[s.name] = byName[s.name] || []).push(s);
const dupGroups = [];
for (const [name, list] of Object.entries(byName)) {
  if (list.length === 1) { list[0].origin = 'original'; continue; }
  const ranked = [...list].sort((a, b) =>
    (a.aggregator ? 1 : 0) - (b.aggregator ? 1 : 0) ||
    (a.suspect ? 1 : 0) - (b.suspect ? 1 : 0) ||
    a.repoSkillCount - b.repoSkillCount ||
    b.repoStars - a.repoStars);
  ranked[0].origin = 'original';
  for (const c of ranked.slice(1)) { c.origin = 'copy'; c.copyOf = ranked[0].repo; }
  dupGroups.push({ name, repos: list.map(x => x.repo), picked: ranked[0].repo });
}

/* ---------- 5. slug 见下方 6.6 ---------- */

/* ---------- 6. 分流：能打包的 / 只能做介绍的 / 排除的 ---------- */
const originals = skills.filter(s => s.origin === 'original' && !s.aggregator && !s.suspect);
const packageable = originals.filter(s => s.distributable);
const introOnly = originals.filter(s => !s.distributable);
const aggSkills = skills.filter(s => s.aggregator);
const suspectSkills = skills.filter(s => !s.aggregator && s.suspect);
const copySkills = skills.filter(s => s.origin === 'copy');
const excluded = skills.filter(s => s.aggregator || s.suspect || s.origin === 'copy');
const aggregators = repoReports.filter(r => r.aggregator);

/* ---------- 6.6 slug ----------
   两条规则，缺一不可：
   1) 重名只在「会被发布的条目」之间解决（副本不发布，不该逼原始来源加前缀）；
   2) 但 slug 必须在**全部条目**里唯一 —— 副本也要加前缀。
   第 2 条是踩出来的：只按 1) 做的话，聚合仓库里的副本会和原始来源撞同一个 slug，
   而按 slug 建索引时后出现的副本会覆盖原始来源，于是页面上的字段莫名其妙变成「未知」。 */
for (const s of skills) {
  const base = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
  const owner = s.repo.split('/')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const originalPeers = originals.filter(o => o.name === s.name).length;
  const needsPrefix = s.origin !== 'original' || originalPeers > 1;
  s.slug = needsPrefix ? `${owner}-${base}` : base;
}

/* ---------- 6.5 适用宿主：从路径推断，不靠想当然 ----------
   实测同一个 SKILL.md 约定被多个宿主使用：
     skills/<名>/               → Anthropic 官方技能格式（Claude）
     .gemini/skills/<名>/       → Gemini CLI
     .openclaw/skills/<名>/     → OpenClaw
     .claude/skills/<名>/       → Claude Code
   所以「这技能能用在哪个宿主」必须逐条看路径，不能默认都是 Claude Code。 */
const HOST_HINTS = [
  [/\.claude\/skills\//i, 'Claude Code'],
  [/\.gemini\/skills\//i, 'Gemini CLI'],
  [/\.openclaw\/skills\//i, 'OpenClaw'],
  [/\.cursor\//i, 'Cursor'],
  [/^skills\//i, 'Claude 技能格式（Anthropic 官方约定）'],
  [/skills\//i, '技能目录（宿主待人工确认）'],
];
for (const s of skills) s.hostGuess = (HOST_HINTS.find(([re]) => re.test(s.path + '/')) || [null, '未知'])[1];
const hostStats = packageable.reduce((m, s) => { m[s.hostGuess] = (m[s.hostGuess] || 0) + 1; return m; }, {});

/* ---------- 7. 报告 ---------- */
const blocked = skills.filter(s => s.licenseBlock);
const blockedWhy = blocked.reduce((m, s) => { m[s.licenseBlock] = (m[s.licenseBlock] || 0) + 1; return m; }, {});
const licByName = packageable.reduce((m, s) => { m[s.license] = (m[s.license] || 0) + 1; return m; }, {});

console.log(`\n———————— 结果 ————————`);
console.log(`  内省仓库 ${picked.length} 个 · 发现 skill 目录 ${skills.length} 个`);
console.log(`  分流：可打包 ${packageable.length} · 仅介绍 ${introOnly.length} · 排除 ${excluded.length}`);
console.log(`    （排除构成：聚合仓库 ${aggSkills.length} · 疑似转抄 ${suspectSkills.length} · 同名副本 ${copySkills.length}）`);
if (Object.keys(licByName).length) {
  console.log(`  可打包条目的协议：${Object.entries(licByName).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
}
if (Object.keys(blockedWhy).length) {
  console.log(`  被协议拦下 ${blocked.length} 条（正是不能只判断「有没有协议文件」的原因）：`);
  for (const [why, n] of Object.entries(blockedWhy).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`    ${String(n).padStart(4)} × ${why}`);
  }
}
if (aggregators.length) {
  console.log(`  聚合仓库 ${aggregators.length} 个（只当发现索引，不作为打包来源）：`);
  for (const a of aggregators.slice(0, 6)) console.log(`    ${a.fullName} · ${a.skills} 个 skill · ${a.flagWhy}`);
}
if (dupGroups.length) {
  console.log(`  同名副本 ${dupGroups.length} 组，挑出的原始来源示例：`);
  for (const g of dupGroups.slice(0, 5)) console.log(`    ${g.name} → ${g.picked}（另有 ${g.repos.length - 1} 份副本）`);
}
console.log(`  API 请求 ${stats.requests} 次 · 剩余配额 ${stats.rateRemaining}`);
console.log(`  协议判定：允许 ${licStats.ok} · 拦下 ${licStats.denied} · 无法识别 ${licStats.unknown} · **读取失败 ${licStats.failed}**`);
if (licStats.failed) {
  console.error(`\n  有 ${licStats.failed} 次协议读取失败。失败会被当成「无明确授权」从而把条目降级成「仅介绍」，`);
  console.error(`  这等于让网络抖动改变合规结论。本轮结果不可信，修好网络后重跑。`);
  process.exit(1);
}

if (DRY) { console.log('\n  --dry：不写文件。'); process.exit(0); }

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(OUT_DIR, 'candidates.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  config: { minStars: MIN_STARS, pushedWithinDays: CFG.pushedWithinDays, limit: LIMIT },
  topicStats,
  counts: {
    repos: picked.length, skills: skills.length,
    packageable: packageable.length, introOnly: introOnly.length, excluded: excluded.length,
    aggregator: aggSkills.length, suspect: suspectSkills.length, copy: copySkills.length,
  },
  repoReports,
  dupGroups,
  skills: [...packageable, ...introOnly, ...excluded],
}, null, 2) + '\n');

const row = s => `| ${s.repo} | ${s.repoStars} | \`${s.path}\` | ${s.license || '—'} | ${s.licenseBlock || ''} |`;
const md = [
  `# 技能候选审核表（${stamp}）`,
  '',
  `内省仓库 **${picked.length}** 个，发现 skill 目录 **${skills.length}** 个。`,
  '',
  `| 分流 | 条数 | 去向 |`,
  `| --- | ---: | --- |`,
  `| 可打包 | ${packageable.length} | 授权明确，可做网盘包 |`,
  `| 仅介绍 | ${introOnly.length} | 无明确授权，只做中文介绍 + 官方获取指引，**不放网盘包** |`,
  `| 排除·聚合仓库 | ${aggSkills.length} | 转抄内容，仓库协议覆盖不了真实授权 |`,
  `| 排除·疑似转抄 | ${suspectSkills.length} | 数量异常，需人工确认 |`,
  `| 排除·同名副本 | ${copySkills.length} | 已有原始来源，副本不收 |`,
  '',
  '## 可打包候选（授权明确）',
  '',
  '| 仓库 | ★ | skill 目录 | 协议 | — |',
  '| --- | ---: | --- | --- | --- |',
  ...packageable.slice(0, 60).map(row),
  '',
  `## 被协议拦下（共 ${blocked.length} 条，样本）`,
  '',
  '> 这些仓库**有 LICENSE 文件，但协议不允许再分发**——第一版工具只看「有没有协议文件」，',
  '> 把 n8n（Sustainable Use License，限制商用）也判成了可分发。这一列就是那次修正的产物。',
  '',
  '| 仓库 | ★ | skill 目录 | 协议 | 拦下原因 |',
  '| --- | ---: | --- | --- | --- |',
  ...blocked.slice(0, 30).map(row),
  '',
  `## 仅介绍（无明确授权，共 ${introOnly.length} 条，样本）`,
  '',
  '| 仓库 | ★ | skill 目录 | 协议 | 拦下原因 |',
  '| --- | ---: | --- | --- | --- |',
  ...introOnly.slice(0, 30).map(row),
  '',
  '## 聚合仓库（不作为打包来源）',
  '',
  '| 仓库 | ★ | skill 数 | 判定依据 |',
  '| --- | ---: | ---: | --- |',
  ...aggregators.map(a => `| ${a.fullName} | ${a.stars} | ${a.skills} | ${a.flagWhy} |`),
  '',
  `## 同名副本（共 ${dupGroups.length} 组，挑出的原始来源）`,
  '',
  '| skill | 挑中 | 出现在 |',
  '| --- | --- | --- |',
  ...dupGroups.slice(0, 40).map(g => `| ${g.name} | **${g.picked}** | ${g.repos.join(' / ')} |`),
  '',
].join('\n');
fs.writeFileSync(path.join(OUT_DIR, 'candidates.md'), md);

console.log(`\n  已写出：`);
console.log(`    _daily/skills/candidates.json   候选池（含每条的授权判定与分流去向）`);
console.log(`    _daily/skills/candidates.md     审核表`);
