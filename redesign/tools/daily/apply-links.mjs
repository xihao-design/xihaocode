#!/usr/bin/env node
/* ============================================================
   把你粘贴来的分享链接，对号入座写进 links.txt
   ------------------------------------------------------------
   为什么要单独做这一步：链接和 App 的对应关系一旦搞错，
   访客点 A 的下载按钮拿到 B 的网盘，比没有链接更糟。
   所以这个脚本的原则是：
     · 能唯一确定才写；匹配到多个 App 就报错，不猜
     · 没写名字的按顺序匹配，但会明确标注「按顺序，请确认」
     · 同一个 App 被写两次、同一个链接给了两个 App 都会拦住

   输入格式很宽松，每行一条，第一段写 App 标识（slug / 名称 / 包名都行），
   后面直接把从百度网盘复制的内容整段粘上：

     amazefilemanager  链接：https://pan.baidu.com/s/1xxxx 提取码：ab12
     Amaze 文件管理器   https://pan.baidu.com/s/1xxxx 提取码：ab12
     com.amaze.filemanager  ...
     https://pan.baidu.com/s/1yyyy?pwd=xy34        ← 没写名字则按顺序匹配

   # 开头的行是注释。空行忽略。

   命令：
     node tools/daily/apply-links.mjs --date=2026-09-16 --file=links-in.txt
     node tools/daily/apply-links.mjs --date=2026-09-16          # 从 stdin 读
     node tools/daily/apply-links.mjs --date=2026-09-16 --file=x --dry-run
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShareText, writeLinksSheet, readLinksSheet } from './manual.mjs';
import { log, warn, fail, readJSON, today } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = readJSON(path.join(__dirname, 'config.json'));

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const hit = argv.find(a => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  const eq = hit.indexOf('=');
  return eq > 0 ? hit.slice(eq + 1) : true;
};
const DATE = String(arg('date', today()));
const DRY = !!arg('dry-run', false);
const DAY_DIR = path.join(cfg.output.root, DATE);

/** 归一化用于比对：小写、去掉空格与标点，保留中文与字母数字 */
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');

function readInput() {
  const f = arg('file', null);
  if (f) {
    const p = path.isAbsolute(String(f)) ? String(f) : path.join(process.cwd(), String(f));
    if (!fs.existsSync(p)) { fail(`找不到输入文件：${p}`); return null; }
    return { text: fs.readFileSync(p, 'utf8'), from: p };
  }
  try {
    const text = fs.readFileSync(0, 'utf8');
    if (text.trim()) return { text, from: 'stdin' };
  } catch { /* 没有 stdin */ }
  fail('没有输入。用 --file=<文件>，或者把内容通过管道喂进来。');
  return null;
}

function main() {
  const bundle = readJSON(path.join(DAY_DIR, 'bundle.json'), null);
  if (!bundle || !Array.isArray(bundle.apps)) {
    fail(`找不到 ${path.join(DAY_DIR, 'bundle.json')}。--date 要指向已有采集产物的日期。`);
    return 1;
  }
  const input = readInput();
  if (!input) return 1;

  // 每个 App 的可识别标识
  const targets = bundle.apps.map(a => ({
    slug: a.slug,
    name: a.name,
    appLabel: a.appLabel || null,
    pkg: a.package || null,
    keys: [a.slug, norm(a.name), a.appLabel ? norm(a.appLabel) : null, a.package || null].filter(Boolean),
  }));

  const lines = input.text.split(/\r?\n/)
    .map((raw, i) => ({ raw: raw.trim(), no: i + 1 }))
    .filter(l => l.raw && !l.raw.startsWith('#'));

  if (!lines.length) { fail('输入里没有有效行（只有注释或空行）。'); return 1; }

  const assigned = new Map();     // slug -> {shareUrl, pwd, how, line}
  const unnamed = [];
  const problems = [];
  const urlToSlug = new Map();

  for (const line of lines) {
    // 1) 先看这一行里有没有能唯一确定 App 的标识
    const hay = norm(line.raw);
    const hits = targets.filter(t => t.keys.some(k => {
      const nk = norm(k);
      return nk.length >= 3 && hay.includes(nk);
    }));

    let target = null;
    let how = null;
    if (hits.length === 1) { target = hits[0]; how = '按名称/标识匹配'; }
    else if (hits.length > 1) {
      problems.push(`第 ${line.no} 行同时匹配到多个 App：${hits.map(h => h.name).join('、')} —— 请改成只写 slug`);
      continue;
    }

    // 2) 认链接与提取码
    const parsed = parseShareText(line.raw);
    if (!parsed.shareUrl) {
      if (!target) { unnamed.push({ line }); continue; }
      problems.push(`第 ${line.no} 行（${target.name}）认不出网盘链接：${line.raw.slice(0, 60)}`);
      continue;
    }

    if (!target) { unnamed.push({ line, parsed }); continue; }

    if (assigned.has(target.slug)) {
      problems.push(`第 ${line.no} 行：${target.name} 已经有链接了（前面第 ${assigned.get(target.slug).line} 行）`);
      continue;
    }
    if (urlToSlug.has(parsed.shareUrl)) {
      problems.push(`第 ${line.no} 行：这个链接已经给了 ${urlToSlug.get(parsed.shareUrl)}，链接重复`);
      continue;
    }
    assigned.set(target.slug, { ...parsed, how, line: line.no });
    urlToSlug.set(parsed.shareUrl, target.name);
  }

  // 3) 没写名字的行，按顺序补给还没分到的 App，但明确标注
  const rest = targets.filter(t => !assigned.has(t.slug));
  if (unnamed.length > rest.length) {
    problems.push(`有 ${unnamed.length} 行没写 App 标识，但只剩 ${rest.length} 个 App 没分到链接 —— 对不上，请给每行写上 App 名`);
  } else {
    unnamed.forEach((u, i) => {
      const t = rest[i];
      if (!t || !u.parsed) return;
      if (urlToSlug.has(u.parsed.shareUrl)) {
        problems.push(`第 ${u.line.no} 行：链接重复（已给 ${urlToSlug.get(u.parsed.shareUrl)}）`);
        return;
      }
      assigned.set(t.slug, { ...u.parsed, how: '⚠ 按顺序匹配（没写 App 名，请确认）', line: u.line.no });
      urlToSlug.set(u.parsed.shareUrl, t.name);
    });
  }

  /* ---------- 对照表 ---------- */
  log('════════════════ 对号入座结果 ════════════════');
  log(`输入：${input.from}　共 ${lines.length} 行有效内容`);
  log('');
  for (const t of targets) {
    const a = assigned.get(t.slug);
    if (a) {
      log(`  ✓ ${t.slug.padEnd(20)} ${a.shareUrl}${a.pwd ? `　提取码 ${a.pwd}` : '　（无提取码）'}`);
      log(`      ${a.how}`);
    } else {
      log(`  · ${t.slug.padEnd(20)} （本次没有给链接）`);
    }
  }
  log('');

  if (problems.length) {
    fail('以下问题必须先解决，没有写入任何东西：');
    for (const p of problems) log(`  ✗ ${p}`);
    return 1;
  }
  if (!assigned.size) { fail('没有解析出任何有效链接。'); return 1; }

  const risky = [...assigned.values()].filter(v => v.how.includes('按顺序'));
  if (risky.length) warn(`有 ${risky.length} 条是按顺序猜的匹配，务必核对上面的对照表。`);
  if ([...assigned.values()].some(v => !v.pwd)) warn('有条目没有提取码。若该分享确实是公开链接，忽略即可。');

  if (DRY) { log('--dry-run：以上没有写入 links.txt。'); return 0; }

  /* ---------- 写回 links.txt ---------- */
  const sheetPath = path.join(DAY_DIR, 'links.txt');
  if (fs.existsSync(sheetPath)) {
    // 保留已有内容（支持分几天慢慢填）
    const cur = readLinksSheet(DAY_DIR);
    for (const item of cur.items) {
      if (!assigned.has(item.slug) && item.shareUrl) {
        assigned.set(item.slug, { shareUrl: item.shareUrl, pwd: item.pwd || '', how: '（links.txt 里原有的）', line: 0 });
      }
    }
  }
  const merged = bundle.apps.map(a => ({ ...a, _link: assigned.get(a.slug) || null }));
  // 用既有的写表函数保证格式一致，然后回填链接
  writeLinksSheet(merged, { dayDir: DAY_DIR, date: DATE });
  const text = fs.readFileSync(sheetPath, 'utf8');
  const out = [];
  let curSlug = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const head = rawLine.match(/^###\s*([A-Za-z0-9._-]+)\s*\|/);
    if (head) curSlug = head[1];
    if (/^链接:\s*$/.test(rawLine) && curSlug && assigned.has(curSlug)) {
      out.push(`链接: ${assigned.get(curSlug).shareUrl}`);
      continue;
    }
    if (/^提取码:\s*$/.test(rawLine) && curSlug && assigned.has(curSlug)) {
      out.push(`提取码: ${assigned.get(curSlug).pwd || ''}`);
      continue;
    }
    out.push(rawLine);
  }
  fs.writeFileSync(sheetPath, out.join('\r\n'), 'utf8');

  log(`已写入 ${sheetPath}（共 ${assigned.size} 条）`);
  log('');
  log('下一步：node redesign\\tools\\daily\\publish.mjs --date=' + DATE);
  return 0;
}

process.exitCode = main();
