#!/usr/bin/env node
/* ============================================================
   技能类目 · 网盘链接回填
   ------------------------------------------------------------
   把 _daily/skills/links.txt 里你填的链接写回 content/skill/<slug>.json。

   links.txt 支持的写法（跟每日流水线一致）：
     mcp-builder = https://pan.baidu.com/s/1abc 提取码：xy12
     mcp-builder = https://pan.baidu.com/s/1abc?pwd=xy12
     mcp-builder = https://pan.baidu.com/s/1abc
     提取码: xy12                    ← 单独一行，补给上一条
     复制这段内容后打开百度网盘手机App… 链接:https://pan.baidu.com/s/1abc?pwd=xy12

   两条硬规则（来自 tools/daily/README.md 的实测记录，这里必须一致）：
   1) **提取码宁可留空，绝不猜。** 认不出就留空并在报告里点出来 —— 访客拿着错的提取码
      根本打不开链接，比留空严重得多。
   2) **--dry 必须真的 dry，且演示结果必须等于真实结果。** 所以下面只算一次，
      写与不写走同一份内存结果，dry 时不碰任何文件。

   为什么解析函数是抄的而不是 import：`tools/daily/manual.mjs` 没有 main guard
   （只有 merge/publish 有），import 它会把整个手动上传流程跑起来。
   改动这里时请对照 manual.mjs 的 parseShareText 保持一致。

   用法：
     npm.cmd run skills:links             # 回写
     npm.cmd run skills:links -- --dry    # 只看会写什么
     npm.cmd run skills:links -- --file=某个文件
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SKILLS_DIR = path.join(ROOT, '_daily', 'skills');
const CONTENT_DIR = path.resolve(__dirname, '..', '..', 'content', 'skill');

const arg = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
const DRY = process.argv.includes('--dry');
const UPDATE = process.argv.includes('--update');   // 允许改写「已经填过的链接」
const FILE = arg('file') ? path.resolve(arg('file')) : path.join(SKILLS_DIR, 'links.txt');

/* ---------- 认链接与提取码（对照 daily/manual.mjs 的 parseShareText） ---------- */
function parseShareText(text) {
  const s = String(text || '');
  let shareUrl = null, pwd = null;

  // share/init?surl=xxx 形态先转成标准短链
  const initM = s.match(/https?:\/\/pan\.baidu\.com\/share\/init\?[^\s，,、)"'<>]*surl=([A-Za-z0-9_-]+)/i);
  if (initM) shareUrl = `https://pan.baidu.com/s/${initM[1]}`;

  if (!shareUrl) {
    const m = s.match(/https?:\/\/pan\.baidu\.com\/s\/[A-Za-z0-9_-]+(?:\?[^\s，,、)"'<>]*)?/i);
    if (m) shareUrl = m[0];
  }
  if (shareUrl) {
    const pm = shareUrl.match(/[?&]pwd=([A-Za-z0-9]{4})/i);
    if (pm) pwd = pm[1];
    // 站点把链接和提取码分开存储展示，所以存干净的链接
    shareUrl = shareUrl.split(/[?#]/)[0].replace(/[.,;，。；、]+$/, '');
  }
  if (!pwd) {
    // 关键词必须是独立词。踩过的坑：`.../s/1NoPwdHere` 里含 "Pwd"，
    // 不加边界会把后面的 "Here" 当提取码。
    const pm = s.match(/(?:^|[^A-Za-z0-9])(?:提取码|密码|pwd)\s*[:：=]?\s*([A-Za-z0-9]{4})(?![A-Za-z0-9])/i);
    if (pm) pwd = pm[1];
  }
  return { shareUrl, pwd };
}

if (!fs.existsSync(FILE)) {
  console.error(`找不到 ${path.relative(ROOT, FILE)}。先跑 npm.cmd run skills:pack 生成登记表。`);
  process.exit(1);
}

const entries = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, f), 'utf8')));
const bySlug = Object.fromEntries(entries.map(e => [e.slug, e]));
const order = entries.map(e => e.slug);

const lines = fs.readFileSync(FILE, 'utf8').split(/\r?\n/);
const parsed = new Map();      // slug -> { link, pwd, line, dirty }
const problems = [];
const loosePwd = [];           // 单独一行的提取码，补给上一条
const urlSeen = new Map();
let cur = null;

lines.forEach((raw, i) => {
  const no = i + 1;
  const line = raw.replace(/#.*$/, '').trim();
  if (!line) return;

  // 单独一行的提取码 → 补给上一条
  const solo = line.match(/^(?:提取码|密码|pwd)\s*[:：=]?\s*([A-Za-z0-9]{4})$/i);
  if (solo && !line.includes('=')) {
    if (cur && !parsed.get(cur)?.pwd) { parsed.get(cur).pwd = solo[1]; parsed.get(cur).dirty = true; }
    else loosePwd.push({ no, pwd: solo[1] });
    return;
  }

  // slug = 链接
  const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
  if (!m) { problems.push(`第 ${no} 行看不懂（应为 \`slug = 链接\`）：${line.slice(0, 60)}`); return; }
  const slug = m[1];
  const rest = m[2].trim();

  if (!bySlug[slug]) { problems.push(`第 ${no} 行：slug \`${slug}\` 在 content/skill 里不存在`); cur = null; return; }
  if (parsed.has(slug)) { problems.push(`第 ${no} 行：${slug} 前面已经填过链接了（第 ${parsed.get(slug).line} 行）`); return; }

  if (!rest) { parsed.set(slug, { link: null, pwd: null, line: no, dirty: false }); cur = slug; return; }

  const p = parseShareText(rest);
  if (!p.shareUrl) { problems.push(`第 ${no} 行（${slug}）：认不出百度网盘链接 —— ${rest.slice(0, 60)}`); return; }
  if (urlSeen.has(p.shareUrl)) { problems.push(`第 ${no} 行：链接重复（已经给了 ${urlSeen.get(p.shareUrl)}）`); return; }
  urlSeen.set(p.shareUrl, slug);
  // 注意字段名：parseShareText 返回的是 shareUrl，写进 parsed 时统一叫 link ——
  // 两边名字不一致过一次，结果 --dry 报「待写入 0 条」（写不进去但不报错）。
  parsed.set(slug, { link: p.shareUrl, pwd: p.pwd, line: no, dirty: true });
  cur = slug;
});

/* ---------- 汇总：真实写什么，dry 就演示什么 ---------- */
const toWrite = [], filled = [], unchanged = [], noPwd = [], notPacked = [], excludedHit = [], needUpdate = [];
for (const e of entries) {
  const p = parsed.get(e.slug);
  if (!p) { notPacked.push(e.slug); continue; }
  if (!p.link) { unchanged.push(e.slug); continue; }
  // 已排除的条目：链接照收，但不回写也不发布 —— 免得以后有人把 status 改回来时
  // 莫名其妙带着一个链接上线（也免得报告里看不出它被跳过了）
  if (e.status === 'exclude') { excludedHit.push({ slug: e.slug, why: e.excludeReason || '已排除' }); continue; }
  const next = { link: p.link, pwd: p.pwd || null, linkMode: 'package' };

  // 改写「已经填过的链接」必须显式 --update。
  // 理由是踩过：修正 dupe 链接期间，规范位置的登记表还留着旧值（文件被占用没同步成功），
  // 这时如果谁跑一次不带参数的 skills:links，就会把已经改好的链接**改回错的**。
  // 改链接本身是可疑操作（要么是修正，要么是失误），值得要求一次显式确认。
  if (e.link && e.link !== next.link && !UPDATE) {
    needUpdate.push({ slug: e.slug, from: e.link, to: next.link, line: p.line });
    continue;
  }

  const changed = e.link !== next.link || e.pwd !== next.pwd || e.linkMode !== next.linkMode;
  if (changed) { toWrite.push({ file: path.join(CONTENT_DIR, `${e.slug}.json`), entry: e, next }); filled.push(e.slug); }
  else unchanged.push(e.slug);
  if (!p.pwd) noPwd.push(e.slug);
}

console.log(`登记表：${path.relative(ROOT, FILE)}`);
console.log(`  content/skill 条目 ${entries.length} 条 · 登记表里出现 ${parsed.size} 条 · 待写入 ${toWrite.length} 条\n`);

if (filled.length) {
  console.log('  将回填（linkMode → package）：');
  for (const w of toWrite) {
    const p = parsed.get(w.entry.slug);
    console.log(`    ${w.entry.slug.padEnd(30)} 第 ${String(p.line).padStart(2)} 行  ${p.link}${p.pwd ? `　提取码 ${p.pwd}` : '　（无提取码）'}`);
  }
}
if (noPwd.length) console.log(`\n  没有提取码的 ${noPwd.length} 条：${noPwd.join('、')}\n  （若该分享确实是公开链接，忽略即可；认不出就留空，绝不猜。）`);
if (unchanged.length) console.log(`\n  未变化 ${unchanged.length} 条：${unchanged.slice(0, 12).join('、')}${unchanged.length > 12 ? ' …' : ''}`);
if (needUpdate.length) {
  console.log(`\n  要改写已填过的链接（${needUpdate.length} 条）—— 需要加 --update 才会执行：`);
  for (const u of needUpdate) {
    console.log(`    ${u.slug}（第 ${u.line} 行）`);
    console.log(`      现在: ${u.from}`);
    console.log(`      改成: ${u.to}`);
  }
  console.log('    这是刻意设的闸门：改链接要么是修正、要么是失误，值得显式确认一次。');
  console.log('    确认无误就重跑并加 --update。');
}
if (loosePwd.length) console.log(`\n  孤立提取码（没有对应条目，已忽略）：第 ${loosePwd.map(l => l.no).join('、')} 行`);
if (excludedHit.length) {
  console.log(`\n  已排除的条目（链接已登记但不回写、不发布）：`);
  for (const x of excludedHit) console.log(`    ${x.slug} —— ${x.why}`);
}
if (notPacked.length) console.log(`\n  登记表里没有的条目 ${notPacked.length} 条：${notPacked.slice(0, 12).join('、')}${notPacked.length > 12 ? ' …' : ''}`);

if (problems.length) {
  console.log(`\n  问题 ${problems.length} 条（这些行没有生效）：`);
  for (const p of problems) console.log(`    ✗ ${p}`);
}

if (DRY) {
  console.log(`\n  --dry：以上没有写入任何文件。真实运行时写入的就是上面列出的 ${toWrite.length} 条。`);
  process.exit(problems.length ? 1 : 0);
}

for (const w of toWrite) {
  w.entry.link = w.next.link;
  w.entry.pwd = w.next.pwd;
  w.entry.linkMode = w.next.linkMode;
  const missing = ['nameZh', 'tagline', 'desc', 'features', 'install', 'hostNote'].filter(k => !w.entry[k]);
  if (missing.length) console.log(`  ⚠ ${w.entry.slug} 文案还没填完（缺 ${missing.join('、')}），链接已写入但状态仍是 ${w.entry.status}`);
  if (w.entry.status === 'draft') console.log(`  ⚠ ${w.entry.slug} 状态是 draft，链接已写入但页面不会发布`);
  fs.writeFileSync(w.file, JSON.stringify(w.entry, null, 2) + '\n');
}

console.log(`\n  已回写 ${toWrite.length} 条到 content/skill/`);
if (toWrite.length) {
  console.log('  下一步：npm.cmd run skills:entries -- --check 确认闸门，再 npm.cmd run build 重建站点。');
}
process.exit(problems.length ? 1 : 0);
