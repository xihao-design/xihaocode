#!/usr/bin/env node
/* ============================================================
   技能类目 · 打包器
   ------------------------------------------------------------
   把选中的 skill 目录落成可直接上传网盘的文件夹，并生成合规说明。

   产物结构（每个 skill 一个文件夹，直接拖进网盘即可）：
     _daily/skills/upload/<slug>/
       ├── SKILL.md / scripts/ / reference/ …   ← skill 原样内容
       ├── LICENSE                              ← 目录内没有时，从仓库根补一份
       └── README.txt                           ← 来源 / 协议 / 固定版本 / 校验 / 权利人异议

   两个设计决定：
   1) **不写 tar 解析器**。候选池里已经带了每个 skill 的文件清单（发现器扫目录树时就有），
      所以直接按清单用 raw 端点取文件即可 —— raw 不吃 API 配额，也不需要解 tar.gz。
      每个仓库只花 1 次 API 请求（把分支解析成 commit SHA）。
   2) **版本用 commit SHA 固定**。按分支名下载的话，同一路径下次内容可能已经变了，
      页面上写的「已核实」就随时间失真。SHA 写进 README，也进条目数据。

   用法：
     npm run skills:pack                          # 读 _daily/skills/pick.txt
     npm run skills:pack -- --pick=mcp-builder,skill-creator
     npm run skills:pack -- --dry                 # 只看会打包什么，不下载
     npm run skills:pack -- --all --yes           # 打包全部可打包候选（超过 30 个要 --yes）
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SKILLS_DIR = path.join(ROOT, '_daily', 'skills');
const CAND = path.join(SKILLS_DIR, 'candidates.json');
const PICK = path.join(SKILLS_DIR, 'pick.txt');
const UPLOAD = path.join(SKILLS_DIR, 'upload');
const LINKS = path.join(SKILLS_DIR, 'links.txt');
const TOKEN_FILE = path.resolve(__dirname, '..', 'daily', 'state', 'github-token.txt');
const SITE_CFG = path.resolve(__dirname, '..', '..', 'site.config.json');

const arg = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
const DRY = process.argv.includes('--dry');
const ALL = process.argv.includes('--all');
const YES = process.argv.includes('--yes');
const MAX_FILE_MB = 2;                    // 技能包应该是文本；超过就跳过并报出来，避免把大二进制拖进来

if (!fs.existsSync(CAND)) {
  console.error('没有候选池。先跑 npm run skills:discover。');
  process.exit(1);
}

const TOKEN = (() => {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { return ''; }
})();
const EMAIL = (() => {
  try { return JSON.parse(fs.readFileSync(SITE_CFG, 'utf8')).contact.email || ''; } catch (e) { return ''; }
})();

const cand = JSON.parse(fs.readFileSync(CAND, 'utf8'));
const packageable = cand.skills.filter(s =>
  s.distributable && s.origin === 'original' && !s.aggregator && !s.suspect && !s.vendoredPath);

/* ---------- 选哪些 ---------- */
let want;
if (arg('pick')) {
  want = arg('pick').split(',').map(s => s.trim()).filter(Boolean);
} else if (ALL) {
  want = packageable.map(s => s.slug);
} else if (fs.existsSync(PICK)) {
  want = fs.readFileSync(PICK, 'utf8').split(/\r?\n/)
    .map(l => l.replace(/#.*$/, '').trim()).filter(Boolean);
} else {
  console.error(`没有指定要打包哪些。三种方式任选：

  A) 写一个 ${path.relative(ROOT, PICK)}，一行一个 slug（# 开头是注释）
  B) npm run skills:pack -- --pick=slug1,slug2
  C) npm run skills:pack -- --all --yes        # 打包全部 ${packageable.length} 条

  可打包候选（前 30 条）：
${packageable.slice(0, 30).map(s => '    ' + s.slug.padEnd(34) + s.repo + '  ' + s.path).join('\n')}`);
  process.exit(1);
}

const selected = [];
const unknown = [];
for (const slug of want) {
  const hit = packageable.find(s => s.slug === slug);
  if (hit) selected.push(hit); else unknown.push(slug);
}
if (unknown.length) {
  console.error(`这些 slug 不在可打包候选里（拼错？或者它被授权/聚合/副本规则排除了）：\n  ${unknown.join('\n  ')}`);
  process.exit(1);
}
if (!selected.length) { console.error('没有选中任何条目。'); process.exit(1); }
if (selected.length > 30 && !YES) {
  console.error(`要打包 ${selected.length} 个，超过 30 个需要显式确认：加 --yes。`);
  process.exit(1);
}

console.log(`将打包 ${selected.length} 个 skill：`);
for (const s of selected) console.log(`  ${s.slug.padEnd(34)} ${s.repo} · ${s.path} · ${s.license} · ${s.files.length} 文件 ${Math.round(s.dirBytes / 1024)}KB`);

const oversize = selected.flatMap(s => s.files.filter(f => f.bytes > MAX_FILE_MB * 1024 * 1024).map(f => ({ slug: s.slug, file: f.path, mb: (f.bytes / 1048576).toFixed(1) })));
if (oversize.length) {
  console.log(`\n  跳过 ${oversize.length} 个超 ${MAX_FILE_MB}MB 的文件（技能包应为文本，大二进制不进包）：`);
  for (const o of oversize) console.log(`    ${o.slug} · ${o.file} · ${o.mb}MB`);
}
if (DRY) { console.log('\n  --dry：不下载、不写文件。'); process.exit(0); }

/* ---------- 按仓库解析 commit SHA（每仓库 1 次 API 请求） ---------- */
const repos = [...new Set(selected.map(s => s.repo))];
const shaOf = {};
for (const repo of repos) {
  const branch = (cand.repoReports.find(r => r.fullName === repo) || {}).defaultBranch || 'HEAD';
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${branch}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'xihaoz-skill-pack',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) { console.error(`  解析 ${repo} 的 commit 失败：HTTP ${res.status}`); process.exit(1); }
  const j = await res.json();
  shaOf[repo] = { sha: j.sha, date: (j.commit?.committer?.date || '').slice(0, 10) };
  console.log(`  ${repo.padEnd(34)} → ${j.sha.slice(0, 10)}（${shaOf[repo].date}）`);
}

/* ---------- 下载并落盘 ----------
   文件取用方式：api.github.com 的 git/blobs 通道（Accept: raw）。
   为什么不用 raw.githubusercontent.com：实测本机连不通（185.199.108-111.x 连接超时），
   而 api.github.com 稳定可达。代价是 1 个文件 1 次配额 —— 5000 次/小时够用，
   而且打包是低频操作（不像每日采集天天跑）。
   为什么不用仓库 tarball：那需要自己写 tar 解析器；候选池里已经带了完整文件清单，
   按清单取文件更直接，少一个可能出错的部件。 */
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function getBlob(repo, blobSha, displayPath) {
  const url = `https://api.github.com/repos/${repo}/git/blobs/${blobSha}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github.raw',
          'User-Agent': 'xihaoz-skill-pack',
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 403 || res.status === 429) throw new Error(`限速 HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt === 2) throw new Error(`${e.message} · ${repo}/${displayPath}`);
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

const manifest = [];
let totalBytes = 0;
for (const s of selected) {
  const { sha, date } = shaOf[s.repo];
  const outDir = path.join(UPLOAD, s.slug);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const listed = [];
  const files = s.files.filter(f => f.bytes <= MAX_FILE_MB * 1024 * 1024 && f.blob);
  for (const f of files) {
    const buf = await getBlob(s.repo, f.blob, `${s.path}/${f.path}`);
    const dest = path.join(outDir, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    listed.push({ path: f.path, bytes: buf.length, sha256: sha256(buf) });
    totalBytes += buf.length;
  }

  // 目录内没有协议文件时，从仓库根补一份，保证包里始终带着授权依据
  let licenseNote = `${s.license}（目录内 ${s.licenseFile}）`;
  const hasOwnLicense = listed.some(f => /(^|\/)(LICENSE|LICENCE|COPYING)/i.test(f.path));
  if (!hasOwnLicense && s.licenseFile && s.licenseBlob) {
    try {
      const buf = await getBlob(s.repo, s.licenseBlob, s.licenseFile);
      fs.writeFileSync(path.join(outDir, 'LICENSE'), buf);
      listed.push({ path: 'LICENSE', bytes: buf.length, sha256: sha256(buf) });
      totalBytes += buf.length;
      licenseNote = `${s.license}（自仓库根 ${s.licenseFile} 补入）`;
    } catch (e) {
      console.warn(`    警告：${s.slug} 的协议文件拉取失败（${e.message}）`);
    }
  }

  const readme = [
    '西浩资源库 · 分发说明',
    '============================================================',
    `条目名称   : ${s.name}`,
    `来源仓库   : ${s.repo}`,
    `来源目录   : ${s.path}`,
    `固定版本   : ${sha}（${date}）`,
    `开源协议   : ${licenseNote}`,
    `官方地址   : https://github.com/${s.repo}/tree/${sha}/${s.path}`,
    `打包时间   : ${new Date().toISOString()}`,
    '',
    '文件清单与校验（sha256）',
    '------------------------------------------------------------',
    ...listed.map(f => `  ${f.path}\n    ${f.sha256}  ${f.bytes} 字节`),
    '',
    '关于协议',
    '------------------------------------------------------------',
    '  本包内容按上述协议分发，版权归原作者所有。',
    '  若协议要求向接收者提供对应源码（如 GPL/AGPL 系），源码地址见上方「官方地址」。',
    '',
    '免责声明',
    '------------------------------------------------------------',
    '  本包由「西浩资源库」整理自公开仓库，仅供个人学习与研究使用，',
    '  请于下载后 24 小时内自行删除，并前往官方渠道支持作者。',
    '  本包不含任何破解、修改或商业授权内容。',
    EMAIL ? `  如您是权利人并认为此处分发不妥，请联系 ${EMAIL}，我们会及时核实处理。` : '  如您是权利人并认为此处分发不妥，请通过本站公布的方式联系我们，我们会及时核实处理。',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'README.txt'), readme);

  manifest.push({ slug: s.slug, name: s.name, repo: s.repo, path: s.path, commit: sha, commitDate: date, license: s.license, files: listed, dirBytes: listed.reduce((n, f) => n + f.bytes, 0) });
  console.log(`  ✓ ${s.slug.padEnd(34)} ${listed.length} 文件 · ${Math.round(listed.reduce((n, f) => n + f.bytes, 0) / 1024)}KB → upload/${s.slug}/`);
}

/* ---------- 落盘清单与链接登记表 ---------- */
fs.writeFileSync(path.join(SKILLS_DIR, 'manifest.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  count: manifest.length,
  items: manifest,
}, null, 2) + '\n');

const existingLinks = fs.existsSync(LINKS) ? fs.readFileSync(LINKS, 'utf8') : '';
const already = new Set([...existingLinks.matchAll(/^([a-z0-9-]+)\s*=/gm)].map(m => m[1]));
const newLines = manifest.filter(m => !already.has(m.slug)).map(m => `${m.slug} = `);
if (newLines.length) {
  const header = existingLinks.trim() ? '' : [
    '# 技能条目的网盘链接登记表',
    '# 上传 upload/<slug>/ 到网盘后，把分享链接填在这里（提取码可另起一行或用 提取码:xxxx）',
    '# 填完跑 npm.cmd run skills:links 回写进 content/skill/<slug>.json',
    '',
  ].join('\n') + '\n';
  // 末尾没有换行时必须先补一个：编辑器保存常常会吃掉文件末尾的换行，
  // 直接追加会把新 slug 粘到上一行末尾（踩过：webapp-testing 的链接后面粘了 academy-guide）
  const glue = existingLinks && !/\n$/.test(existingLinks) ? '\n' : '';
  // 登记表只是给你填的台账，条目数据才是事实来源。所以写不进去**不该让整轮失败** ——
  // 下载、清单、条目都已经落盘了，为了一个被占用的文件把它们算成失败是错的。
  try {
    fs.appendFileSync(LINKS, glue + header + newLines.join('\n') + '\n');
  } catch (e) {
    console.warn(`\n  ⚠ 登记表写不进去（${e.code}）：${path.relative(ROOT, LINKS)}`);
    console.warn('    打包本身是成功的（文件与清单都已落盘）。请关掉占用该文件的程序后重跑一次本命令；');
    console.warn('    它是幂等的，已下载的文件不会重下，只会补上缺失的登记行。');
    console.warn('    要填的 slug 如下：');
    for (const l of newLines) console.warn('      ' + l.replace(/\s*=\s*$/, ''));
  }
}

console.log(`\n———————— 打包完成 ————————`);
console.log(`  ${manifest.length} 个 skill · 共 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`  产物目录：_daily\\skills\\upload\\`);
console.log(`  清单    ：_daily\\skills\\manifest.json（含每个文件的 sha256 与 commit SHA）`);
console.log(`  登记表  ：_daily\\skills\\links.txt（已追加 ${newLines.length} 行待填）`);
console.log(`\n  下一步：把 upload\\<slug>\\ 逐个拖进百度网盘 → 建分享链接 → 填进 links.txt`);
