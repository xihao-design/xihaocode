#!/usr/bin/env node
/* ============================================================
   线上核对：部署完之后跑这个，确认真的生效了
   ------------------------------------------------------------
   为什么需要它：本地 build 成功 ≠ 线上更新了。
   你可能忘了部署、传错了目录、CDN 还在缓存 —— 这些本地都看不出来。
   这个脚本直接去线上抓，用本地数据当基准做三件事：
     1. 对比条目集合：线上少了谁（没部署成功）、线上多了谁（本地已排除或不该有）
     2. 逐个打开详情页，确认 HTTP 200 且页面里确实带着那个网盘链接
     3. 报告首页显示的软件数与本地是否一致

   站点地址从 redesign\dist\sitemap.xml 里读（那是 build 时写死的绝对地址），
   也可以用 --base 覆盖。

   命令：
     node tools/daily/verify-live.mjs
     node tools/daily/verify-live.mjs --only=antennapod,amazefilemanager
     node tools/daily/verify-live.mjs --limit=5
     node tools/daily/verify-live.mjs --base=https://www.xihaouc.top
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, warn, fail, readJSON } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(SITE_ROOT, '..');

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const hit = argv.find(a => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return d;
  const eq = hit.indexOf('=');
  return eq > 0 ? hit.slice(eq + 1) : true;
};
const ONLY = arg('only', null);
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;

const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function get(url, timeoutMs = 20000) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'xihaouc-verify-live' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e.message };
  }
}

function baseUrl() {
  const explicit = arg('base', null);
  if (explicit) return String(explicit).replace(/\/+$/, '');
  const sm = path.join(SITE_ROOT, 'dist', 'sitemap.xml');
  if (fs.existsSync(sm)) {
    const m = fs.readFileSync(sm, 'utf8').match(/<loc>(https?:\/\/[^/<]+)\/?<\/loc>/);
    if (m) return m[1].replace(/\/+$/, '');
  }
  // 退路：从 build.mjs 里读 SITE.url
  const b = fs.readFileSync(path.join(SITE_ROOT, 'build.mjs'), 'utf8');
  const m = b.match(/url:\s*'([^']+)'/);
  if (m) return m[1].replace(/\/+$/, '');
  return null;
}

async function main() {
  const base = baseUrl();
  if (!base) {
    fail('拿不到站点地址。用 --base=https://你的域名 指定。');
    return 1;
  }
  log(`════════════════════════════════════════════════`);
  log(`线上核对  ${base}`);
  log(`════════════════════════════════════════════════`);

  /* ---------- 本地基准 ---------- */
  const cur = readJSON(path.join(SITE_ROOT, 'curation.json'));
  const kb = readJSON(path.join(REPO_ROOT, '.kb-raw.json'), []);
  const kbByRow = new Map(kb.map(r => [String(r.row), r]));

  const localAll = Object.entries(cur.apps)
    .filter(([row, meta]) => !row.startsWith('_') && meta)
    .map(([row, meta]) => {
      const slug = meta.slug || (/^[\x20-\x7e]+$/.test(meta.name) ? slugify(meta.name) : null);
      const raw = kbByRow.get(row) || {};
      return { row, name: meta.name, slug, status: meta.status || 'ok', link: raw.link || null, pwd: raw.pwd || null };
    });
  let published = localAll.filter(a => a.status !== 'exclude' && a.slug);
  const excluded = localAll.filter(a => a.status === 'exclude');

  if (ONLY) {
    const want = new Set(String(ONLY).split(',').map(s => s.trim()).filter(Boolean));
    published = published.filter(a => want.has(a.slug));
  }
  if (LIMIT) published = published.slice(-LIMIT);

  log(`\n本地基准：已发布 ${localAll.filter(a => a.status !== 'exclude' && a.slug).length} 个，已排除 ${excluded.length} 个`
    + (ONLY || LIMIT ? `（本次只核对 ${published.length} 个）` : ''));

  /* ---------- 线上首页 ---------- */
  log('\n──────── 一、首页与条目集合 ────────');
  const home = await get(`${base}/`);
  if (!home.ok) {
    fail(`首页打不开：HTTP ${home.status}${home.error ? ' ' + home.error : ''}`);
    return 1;
  }
  const liveSlugs = [...new Set([...home.text.matchAll(/apps\/([a-z0-9-]+)\.html/g)].map(m => m[1]))];
  const liveCount = (home.text.match(/(\d+)\s*款软件/) || [])[1] || null;
  log(`线上首页：HTTP 200，卡片 ${liveSlugs.length} 个${liveCount ? `，页面标注「${liveCount} 款软件」` : ''}`);

  const localPublishedSlugs = localAll.filter(a => a.status !== 'exclude' && a.slug).map(a => a.slug);
  const liveSet = new Set(liveSlugs);
  const localSet = new Set(localPublishedSlugs);
  const missing = localPublishedSlugs.filter(s => !liveSet.has(s));       // 本地有、线上没有
  const extra = liveSlugs.filter(s => !localSet.has(s));                 // 线上有、本地不该有

  let problems = 0;      // 硬失败：这次该上线的没上线
  const drift = [];      // 软漂移：线上还留着本地已删/已排除的旧条目，不算失败但要说明
  if (missing.length) {
    problems += missing.length;
    fail(`线上缺少 ${missing.length} 个已发布条目（本次部署可能没生效或传错了目录）：`);
    for (const s of missing) log(`  · ${s}`);
  } else {
    log('✓ 本地已发布的条目，线上都有');
  }
  if (extra.length) {
    log(`\n⚠ 线上多出 ${extra.length} 个条目（本地没有或已排除）：`);
    for (const s of extra) {
      const ex = excluded.find(a => a.slug === s);
      drift.push(s);
      log(`  · ${s}${ex ? ` —— 本地已标记排除（${ex.name}），下次部署后会消失` : ' —— 本地数据里完全没有，需要确认'}`);
    }
  }
  if (liveCount && Number(liveCount) !== localPublishedSlugs.length) {
    warn(`首页标注 ${liveCount} 款，本地已发布 ${localPublishedSlugs.length} 款 —— 线上是旧版本`);
    if (!drift.length) drift.push('count-mismatch');
  }

  /* ---------- 详情页 ---------- */
  log(`\n──────── 二、详情页与网盘链接（逐个打开 ${published.length} 个）────────`);
  let okCount = 0;
  const failures = [];
  for (const a of published) {
    const url = `${base}/apps/${a.slug}.html`;
    const r = await get(url);
    if (!r.ok) {
      failures.push(`${a.slug}：HTTP ${r.status || '连接失败'}${r.error ? ' ' + r.error : ''}`);
      continue;
    }
    const hasLink = a.link ? r.text.includes(a.link) : true;
    const hasName = r.text.includes(a.name);
    if (!hasLink || !hasName) {
      failures.push(`${a.slug}：页面能打开，但${!hasName ? '找不到应用名' : ''}${!hasName && !hasLink ? '、' : ''}${!hasLink ? `找不到网盘链接（期望 ${a.link}）` : ''}`);
      continue;
    }
    okCount++;
  }
  log(`✓ ${okCount} / ${published.length} 个详情页正常，且页面里带着网盘链接`);
  if (failures.length) {
    problems += failures.length;
    fail(`${failures.length} 个详情页有问题：`);
    for (const f of failures) log(`  ✗ ${f}`);
  }

  /* ---------- 三、全站 URL 覆盖（sitemap 全量）----------
     上面第二节只核对了 App 这一层。站上还有 AI 库（149 个工具页 + 39 个分类/子类页）、
     技能库、电脑软件频道、运营指南、号狐浏览器等页面 —— 它们都不在第二节的覆盖范围里。
     也就是说，过去那句「线上与本地完全一致」是说大了：它只对 App 层负责。

     这里不再按层写逻辑（每加一个频道就要改一次），而是直接拿 sitemap 当清单逐条开 —— 
     sitemap 是构建产物，新频道一上线就自动进来，核对范围永远跟着站点走。 */
  const smPath = path.join(SITE_ROOT, 'dist', 'sitemap.xml');
  const smUrls = fs.existsSync(smPath)
    ? [...fs.readFileSync(smPath, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim())
    : [];
  log(`\n──────── 三、全站 URL 覆盖（sitemap ${smUrls.length} 条）────────`);
  const urlFails = [];
  let urlOk = 0;
  for (const u of smUrls) {
    const r = await get(u);
    if (r.ok) { urlOk++; continue; }
    urlFails.push(`${u.startsWith(base) ? u.slice(base.length) : u} → HTTP ${r.status || '连接失败'}`);
  }
  log(`✓ ${urlOk} / ${smUrls.length} 条 URL 可访问（含 AI 库、技能库、分类、标签、专题、静态页）`);
  if (urlFails.length) {
    problems += urlFails.length;
    fail(`${urlFails.length} 条 URL 在线上打不开：`);
    for (const f of urlFails.slice(0, 20)) log(`  ✗ ${f}`);
    if (urlFails.length > 20) log(`  …另有 ${urlFails.length - 20} 条`);
  }

  /* ---------- 结论 ---------- */
  log('\n════════════════ 结论 ════════════════');
  if (problems) {
    log(`✗ 发现 ${problems} 处问题，见上。`);
    log('常见原因：');
    log('  · 忘了部署，或部署时传的不是 redesign\\dist\\ 这个目录');
    log('  · CDN 缓存还没刷新（等几分钟再跑一次）');
    log('  · 传到了子目录，导致路径变成 /xxx/apps/...');
    return 1;
  }
  if (drift.length) {
    log('✓ 这次要上线的条目，线上都已经生效了。');
    warn(`但线上还残留 ${drift.length} 处旧内容（见上），下次部署 dist 时会一并清掉。`);
    log('  也就是说：本次部署是成功的，只是线上还带着上一版的尾巴。');
    return 0;
  }
  log('✓ 线上与本地完全一致，本次部署已生效。');
  return 0;
}

/* ---------- 部署核对通过之后：推送给百度 ----------
   为什么挂在这里而不是 publish 里：publish 跑完时页面还没部署（部署是你手动传 dist），
   那一刻推送推不到东西。而**核对通过 = 线上确实生效了** —— 这才是「发布即推送」的正确时机，
   当天新增的页面当天就能进百度队列，不用等第二天再跑一次 publish。

   --no-push 可以跳过（只核对不推送）。 */
async function pushToBaidu() {
  if (process.argv.includes('--no-push')) { log('\n--no-push：跳过百度推送。'); return; }
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');

  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const pushTool = path.join(__dirname, '..', 'baidu-push.mjs');
  const hasToken = !!process.env.BAIDU_PUSH_TOKEN
    || fs.existsSync(path.join(repoRoot, '_daily', 'baidu-push-token.txt'))
    || fs.existsSync(path.join(__dirname, 'state', 'baidu-push-token.txt'));

  log('');
  log('════════════════ 百度收录推送 ════════════════');
  if (!hasToken) {
    log('  未配置推送 token，跳过（不影响核对结果）。');
    log('  配置方法见 redesign/tools/baidu-push.mjs 头部注释。');
    return;
  }
  if (!fs.existsSync(pushTool)) { log(`  找不到 ${path.relative(repoRoot, pushTool)}，跳过。`); return; }

  // --max=10：普通收录配额实测 10 条/天，每次推送只取这么多，
  // 剩下的留在队列里明天继续（工具自己记着哪些推过、哪些内容变了）
  const r = spawnSync(process.execPath, [pushTool, '--max=10'], { stdio: 'inherit' });
  if (r.status === 2) {
    log('');
    log('  今日推送配额已用尽，属正常状态（配额每天重置），未推的页面明天自动继续。');
  } else if (r.status !== 0) {
    log('');
    log('  推送没跑成（原因见上）。手动重试：node redesign\\tools\\baidu-push.mjs --max=10');
  }
}

main().then(async code => {
  process.exitCode = code;
  if (code === 0) await pushToBaidu();
}).catch(e => { fail('核对脚本异常：' + (e && e.stack ? e.stack : e)); process.exitCode = 1; });
