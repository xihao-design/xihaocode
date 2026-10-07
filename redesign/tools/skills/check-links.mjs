#!/usr/bin/env node
/* ============================================================
   网盘链接存活巡检
   ------------------------------------------------------------
   为什么值得单独做：**链接失效是这类站最大的用户流失点，也是佣金流失点，而页面上完全看不出来。**
   访客点进去看到「分享已取消」就走了，你不会知道；百度也不会告诉你。

   能力边界（先说清楚，免得给出假的安全感）：
   这是**尽力而为的 HTTP 检查**，不是登录后的权威判定。百度对匿名请求可能返回安全验证页，
   这时候脚本给的是「无法判断」而不是猜「失效」——**把不能确定的判成坏的，比不检查更糟**
   （你会去补一个本来好好的链接）。最终确认还是要在浏览器里打开一次（必要时输提取码）。

   判据：抓页面正文，匹配百度自己的报错文案。
     失效：分享的文件已经被取消 / 此链接分享内容可能因为涉及侵权…无法访问 / 你访问的页面不存在
     有效：出现提取码输入框、分享文件列表、或分享数据
     无法判断：命中安全验证，或者文案不认识（会把页面前 80 个字打出来给你看）

   用法：
     npm.cmd run skills:check-links              # 只查技能条目的链接
     npm.cmd run skills:check-links -- --apps    # 连软件类目的链接一起查（共 100 条）
     npm.cmd run skills:check-links -- --only=mcp-builder,canvas-design
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTENT = path.resolve(__dirname, '..', '..', 'content', 'skill');
const STATE = path.join(ROOT, '_daily', 'link-check.json');

const arg = k => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
const WITH_APPS = process.argv.includes('--apps');
const CONC = Number(arg('concurrency')) || 3;
const TIMEOUT = Number(arg('timeout')) || 20000;

/* ---------- 百度自己的报错/正常文案（改了就得跟着改） ---------- */
const FAIL = [
  [/分享的文件已经被取消|分享已取消/, '分享已被取消'],
  [/此链接分享内容可能因为涉及|无法访问/, '被平台屏蔽（侵权/违规）'],
  [/你访问的页面不存在|链接不存在|分享已经过期|已失效|来晚了/, '链接不存在或已过期'],
];
const OK = [
  [/提取码|请输入提取码/, '出现提取码输入'],
  [/分享的文件|文件列表|共\d+个文件/, '出现文件列表'],
  [/yunData|locals\.mset|initData/, '返回分享数据'],
];
const WALL = [
  [/安全验证|请输入验证码|verify|网络异常/, '被要求安全验证'],
];

const strip = html => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const classify = (html, status) => {
  const text = strip(html);
  for (const [re, why] of FAIL) if (re.test(html) || re.test(text)) return { verdict: 'broken', why };
  for (const [re, why] of WALL) if (re.test(text)) return { verdict: 'unknown', why };
  for (const [re, why] of OK) if (re.test(html) || re.test(text)) return { verdict: 'ok', why };
  return { verdict: 'unknown', why: `HTTP ${status}，文案不匹配已知特征`, sample: text.slice(0, 80) };
};

/* ---------- 收集要查的链接 ---------- */
const targets = [];
for (const f of fs.readdirSync(CONTENT).filter(x => x.endsWith('.json'))) {
  const e = JSON.parse(fs.readFileSync(path.join(CONTENT, f), 'utf8'));
  if (e.status !== 'ok' || !e.link) continue;
  targets.push({ slug: e.slug, kind: 'skill', link: e.link, pwd: e.pwd });
}
if (WITH_APPS) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, '.kb-raw.json'), 'utf8'));
    const curation = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'curation.json'), 'utf8'));
    for (const r of raw) {
      const meta = curation.apps[String(r.row)];
      if (!meta || meta.status === 'exclude' || !r.link) continue;
      targets.push({ slug: meta.slug || String(r.row), kind: 'app', link: r.link, pwd: r.pwd });
    }
  } catch (e) {
    console.warn('  读 .kb-raw.json 失败，跳过软件类目：' + e.message);
  }
}
const only = arg('only');
const list = only ? targets.filter(t => only.split(',').includes(t.slug)) : targets;

if (!list.length) { console.error('没有可检查的链接。'); process.exit(1); }
console.log(`巡检 ${list.length} 条链接（并发 ${CONC}，超时 ${TIMEOUT / 1000}s）\n`);

async function check(t) {
  try {
    const res = await fetch(t.link, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Referer': 'https://pan.baidu.com/',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    const html = await res.text();
    return { ...t, ...classify(html, res.status), status: res.status };
  } catch (e) {
    return { ...t, verdict: 'unknown', why: '请求失败：' + e.message, status: null };
  }
}

const results = [];
for (let i = 0; i < list.length; i += CONC) {
  const batch = list.slice(i, i + CONC);
  results.push(...await Promise.all(batch.map(check)));
  if ((i + CONC) % 15 === 0 || i + CONC >= list.length) {
    console.log(`  已查 ${Math.min(i + CONC, list.length)}/${list.length}`);
  }
  await new Promise(r => setTimeout(r, 400));   // 别把百度惹毛
}

const broken = results.filter(r => r.verdict === 'broken');
const unknown = results.filter(r => r.verdict === 'unknown');
const ok = results.filter(r => r.verdict === 'ok');

console.log(`\n———————— 巡检结果 ————————`);
console.log(`  有效 ${ok.length} · 失效 ${broken.length} · 无法判断 ${unknown.length}\n`);
for (const r of results) {
  const mark = r.verdict === 'ok' ? '✓' : r.verdict === 'broken' ? '✗' : '?';
  console.log(`  ${mark} ${r.slug.padEnd(32)} ${r.why}${r.sample ? ' · ' + r.sample : ''}`);
}
if (broken.length) {
  console.log(`\n  失效的 ${broken.length} 条要尽快处理：`);
  console.log('    · 重新分享一次，把新链接填进 content/skill/<slug>.json 的 link 字段');
  console.log('    · 或者临时把 linkMode 改成 intro，页面会切成「官方获取指引」，不给访客一个坏链接');
}
if (unknown.length) {
  console.log(`\n  无法判断的 ${unknown.length} 条：脚本判断不了，请在浏览器里打开确认一次。`);
  console.log('  （把不能确定的报成失效比不检查更糟 —— 你会去补一个本来好好的链接）');
}

/* ---------- 记录历史：第一次失效的日期比"当前状态"更有用 ---------- */
fs.mkdirSync(path.dirname(STATE), { recursive: true });
const prev = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return { links: {} }; } })();
prev.links = prev.links || {};
const today = new Date().toISOString().slice(0, 10);
for (const r of results) {
  const p = prev.links[r.slug] || {};
  p.verdict = r.verdict;
  p.why = r.why;
  p.lastChecked = today;
  if (r.verdict === 'broken' && !p.firstBroken) p.firstBroken = today;
  if (r.verdict === 'ok') p.firstBroken = null;
  prev.links[r.slug] = p;
}
prev.updatedAt = new Date().toISOString();
fs.writeFileSync(STATE, JSON.stringify(prev, null, 2) + '\n');
console.log(`\n  历史：${path.relative(ROOT, STATE)}（记首次失效日期，便于判断"坏了多久"）`);

process.exit(broken.length ? 1 : 0);
