#!/usr/bin/env node
/* ============================================================
   技能类目 · 条目生成器（文案事实包）
   ------------------------------------------------------------
   设计对应已确认的决策 ①b：**流水线内不调 API**。
   脚本负责「事实」，人/会话里的 AI 负责「文案」：
     - 事实字段（来源仓库、目录、commit、协议、宿主、文件清单、Star）→ 脚本填满，不许人改
     - 文案字段（中文名、一句话定位、正文、功能特点、安装步骤、宿主说明）→ 留 null，等起草
     - status 默认 draft：**文案没填完、链接没回填的条目不会进站点**

   re-run 安全：已存在的条目只刷新事实字段，**不覆盖已写好的文案、链接与状态**。
   所以可以反复跑（发现器/打包器更新后重跑一次即可）。

   用法：
     npm run skills:entries            # 由 manifest.json 生成/刷新条目
     npm run skills:entries -- --check # 只检查已发布条目有没有缺文案/缺链接
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SKILLS_DIR = path.join(ROOT, '_daily', 'skills');
const OUT_DIR = path.resolve(__dirname, '..', '..', 'content', 'skill');
const MANIFEST = path.join(SKILLS_DIR, 'manifest.json');
const CAND = path.join(SKILLS_DIR, 'candidates.json');

const COPY_FIELDS = ['nameZh', 'tagline', 'desc', 'features', 'install', 'hostNote'];
const CHECK = process.argv.includes('--check');

const readJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } };

/* ---------- --check：发布前的硬闸门 ---------- */
if (CHECK) {
  if (!fs.existsSync(OUT_DIR)) { console.log('content/skill/ 还没有条目。'); process.exit(0); }
  const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.json'));
  let bad = 0, published = 0, draft = 0;
  for (const f of files) {
    const e = readJSON(path.join(OUT_DIR, f), {});
    if (e.status !== 'ok') { draft++; continue; }           // draft / exclude 不参与检查
    published++;
    const missing = COPY_FIELDS.filter(k => !e[k] || (Array.isArray(e[k]) && !e[k].length));
    const why = [];
    if (missing.length) why.push(`文案字段为空：${missing.join('、')}`);
    if (e.linkMode !== 'intro' && !e.link) why.push('linkMode=package 但没有网盘链接');
    if (e.linkMode === 'intro' && e.link) why.push('linkMode=intro 却填了链接（应该改成 package）');
    if (why.length) { console.log(`  FAIL ${f}：${why.join('；')}`); bad++; }
  }
  console.log(`\n  已发布 ${published} 条 · 草稿 ${draft} 条`);
  if (!published) {
    console.log('  没有 status=ok 的条目，所以这次检查是空的（不是通过）。填好文案并确认获取方式后把 status 改成 ok。');
  }
  console.log(bad
    ? `\n${bad} 个已发布条目不合格。这正是「宁可少发，不发错」的闸门：文案空着的条目不许 status=ok。`
    : `\n已发布条目检查通过。`);
  process.exit(bad ? 1 : 0);
}

const manifest = readJSON(MANIFEST, null);
const cand = readJSON(CAND, null);
if (!manifest) {
  console.error('没有 manifest.json。先跑 npm run skills:pack。');
  process.exit(1);
}

// 只按「会被发布的候选」建索引：候选池里还带着被排除的副本，它们和原始来源可能
// 同名字（甚至同 slug），从这里取字段会把副本的字段覆盖到原始条目上。
const bySlug = Object.fromEntries(
  (cand?.skills || [])
    .filter(s => s.distributable && s.origin === 'original' && !s.aggregator && !s.suspect && !s.vendoredPath)
    .map(s => [s.slug, s]));
fs.mkdirSync(OUT_DIR, { recursive: true });

const created = [], refreshed = [];
for (const m of manifest.items) {
  const c = bySlug[m.slug] || {};
  const file = path.join(OUT_DIR, `${m.slug}.json`);
  const prev = readJSON(file, null);

  const facts = {
    type: 'skill',
    slug: m.slug,
    name: m.name,
    category: c.category || 'ai-skill',
    source: {
      repo: m.repo,
      repoUrl: `https://github.com/${m.repo}`,
      path: m.path,
      commit: m.commit,
      commitDate: m.commitDate,
      license: m.license,
      stars: c.repoStars || null,
      treeUrl: `https://github.com/${m.repo}/tree/${m.commit}/${m.path}`,
      hostGuess: c.hostGuess || null,
      licenseFile: c.licenseFile || null,
    },
    files: m.files.map(f => ({ path: f.path, bytes: f.bytes })),
    pack: { dirBytes: m.dirBytes, packedAt: manifest.generatedAt },
    link: prev?.link ?? null,
    pwd: prev?.pwd ?? null,
    // linkMode 决定「没有网盘链接」是缺陷还是设计：
    //   package = 本站提供网盘包，必须有链接
    //   intro   = 仅中文介绍 + 官方获取指引（授权不明时的降级路径），不要求链接
    linkMode: prev?.linkMode ?? 'package',
    status: prev?.status ?? 'draft',
  };

  // 文案字段：已有就保留，没有就留 null 等人填
  const copy = {};
  for (const k of COPY_FIELDS) copy[k] = prev ? prev[k] ?? null : null;

  const entry = { ...facts, ...copy };
  const missing = COPY_FIELDS.filter(k => !entry[k] || (Array.isArray(entry[k]) && !entry[k].length));
  entry._todo = missing.length ? missing : undefined;
  if (!entry._todo) delete entry._todo;

  fs.writeFileSync(file, JSON.stringify(entry, null, 2) + '\n');
  (prev ? refreshed : created).push({ slug: m.slug, missing });
}

console.log(`条目生成完成 → content/skill/`);
if (created.length) {
  console.log(`\n  新建 ${created.length} 条（文案待填）：`);
  for (const c of created) console.log(`    ${c.slug.padEnd(30)} 缺 ${c.missing.join('、')}`);
}
if (refreshed.length) {
  console.log(`\n  刷新 ${refreshed.length} 条（只更新了事实字段，文案/链接/状态原样保留）：`);
  for (const r of refreshed) console.log(`    ${r.slug.padEnd(30)} ${r.missing.length ? '仍缺 ' + r.missing.join('、') : '文案已齐'}`);
}
console.log(`\n  下一步：填 ${COPY_FIELDS.join(' / ')}，上传网盘后填 link，再把 status 改成 ok，然后 npm run skills:entries -- --check`);
