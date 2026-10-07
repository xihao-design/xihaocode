#!/usr/bin/env node
/* ============================================================
   发布：把你在百度网盘手动上传后的成果，一条命令更新到网站
   ------------------------------------------------------------
   依次做四件事：
     1. 读 _daily\<日期>\links.txt，把你粘贴的分享链接与提取码写回 bundle.json
        （bundle.json 是唯一事实来源，登记表只是它的一个「输入界面」）
     2. 校验：链接格式、有没有两个 App 误用同一个链接、提取码空没空
     3. 调用 merge.mjs 把条目并入 .kb-raw.json / curation.json / data/github.json
        + 把图标拷进 assets/icons/
     4. 重建 redesign\dist，并跑产物校验

   做完之后只剩一步需要你操作：把 redesign\dist\ 重新部署上去。

   命令：
     node tools/daily/publish.mjs --date=2026-09-16
     node tools/daily/publish.mjs --date=2026-09-16 --dry-run         # 只演示，不写盘
     node tools/daily/publish.mjs --date=2026-09-16 --allow-missing   # 只发布已填链接的那些
     node tools/daily/publish.mjs --date=2026-09-16 --skip-build      # 只改数据，不重建站点
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readLinksSheet } from './manual.mjs';
import { mergeDay } from './merge.mjs';
import { computeIndexSummary } from '../check-index.mjs';
import { log, warn, fail, readJSON, writeJSON, today } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(SITE_ROOT, '..');
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
const ALLOW_MISSING = !!arg('allow-missing', false);
const SKIP_BUILD = !!arg('skip-build', false);
const NO_OPEN = !!arg('no-open', false);
const DAY_DIR = path.join(cfg.output.root, DATE);

const countSiteApps = () => {
  const cur = readJSON(path.join(SITE_ROOT, 'curation.json'), null);
  if (!cur || !cur.apps) return null;
  return Object.entries(cur.apps).filter(([r, m]) => !r.startsWith('_') && m && m.status !== 'exclude').length;
};

function runScript(script, label) {
  log(`\n──────── ${label} ────────`);
  const r = spawnSync(process.execPath, [script], { stdio: 'inherit', cwd: REPO_ROOT });
  if (r.error) { fail(`${label} 启动失败：${r.error.message}`); return false; }
  if (r.status !== 0) { fail(`${label} 失败（退出码 ${r.status}）`); return false; }
  return true;
}

function main() {
  log(`════════════════════════════════════════════════`);
  log(`发布 ${DATE}${DRY ? '（--dry-run 演示，不写盘）' : ''}`);
  log(`════════════════════════════════════════════════`);

  /* ---------- 1. 读登记表 ---------- */
  const bundlePath = path.join(DAY_DIR, 'bundle.json');
  const bundle = readJSON(bundlePath, null);
  if (!bundle || !Array.isArray(bundle.apps)) {
    fail(`找不到 ${bundlePath}。先用 --date 指定已有采集产物的日期。`);
    return 1;
  }

  const sheet = readLinksSheet(DAY_DIR);
  if (!sheet.exists) {
    fail(`找不到登记表 ${sheet.file}`);
    log('  它是采集时自动生成的。若被删了，重跑一次采集（--no-download 也可以）即可重建。');
    return 1;
  }

  /* ---------- 2. 把链接写回 bundle ---------- */
  const bySlug = new Map(sheet.items.map(i => [i.slug, i]));
  const missing = [];
  let newlyFilled = 0;

  for (const a of bundle.apps) {
    const it = bySlug.get(a.slug);
    if (!it) { missing.push(`${a.name}：登记表里没有对应分块（可能被整块删掉了）`); continue; }
    if (!it.shareUrl) {
      missing.push(`${a.name}：链接还没填${it.rawLink ? `（读到「${it.rawLink.slice(0, 40)}」但认不出网盘链接）` : ''}`);
      continue;
    }
    a.netdisk = a.netdisk || {};
    if (a.netdisk.shareUrl !== it.shareUrl || (a.netdisk.pwd || '') !== (it.pwd || '')) newlyFilled++;
    a.netdisk.shareUrl = it.shareUrl;
    a.netdisk.pwd = it.pwd || '';
    a.netdisk.source = 'manual';
    a.netdisk.filledAt = new Date().toISOString();
  }

  // 反过来查一遍：登记表里填了链接、但这次要发布的 bundle 里没有对应分块。
  // 最常见的原因是采集器在进入 bundle 之前就把它滤掉了（实例：bongocat 的资产是
  // 源码归档 .gz，不是能装的东西，所以没进候选）。不说一声的话，这些链接会**静默失效**，
  // 而汇总只报「N / N 个已填链接」，很容易让人以为全都发出去了 —— 实际发生过一次。
  const bundleSlugs = new Set(bundle.apps.map(a => a.slug));
  const orphans = [...bySlug.entries()].filter(([slug, it]) => !bundleSlugs.has(slug) && it.shareUrl);
  if (orphans.length) {
    warn('以下分块填了链接，但这次没有要发布的对应条目（多半在采集阶段就被滤掉了）：');
    for (const [slug, it] of orphans) log(`  · ${slug}：${String(it.shareUrl).slice(0, 52)}…`);
    log('  这些链接不会被写进站点。若你认为该收录，去 bundle.json 的 rejected 里找它的拒收原因。');
    log('');
  }

  const ready = bundle.apps.filter(a => a.netdisk && a.netdisk.shareUrl);
  log(`\n登记表：${ready.length} / ${bundle.apps.length} 个已填链接${newlyFilled ? `（本次新填入 ${newlyFilled} 个）` : ''}`);

  if (missing.length) {
    warn('以下条目还没有可用链接：');
    for (const m of missing) log(`  · ${m}`);
    if (!ALLOW_MISSING) {
      log('');
      log('补好链接再跑一次；或加 --allow-missing 只发布已填链接的那些。');
      return 1;
    }
    log('  （--allow-missing：以上会被 merge 跳过，不写入站点）');
  }

  if (!ready.length) {
    fail('没有任何一个 App 有分享链接，无需发布。');
    return 1;
  }

  /* ---------- 3. 校验 ---------- */
  const urlOwner = new Map();
  const problems = [];
  for (const a of ready) {
    const u = a.netdisk.shareUrl;
    if (!/^https:\/\/pan\.baidu\.com\/s\/[\w-]+$/.test(u)) {
      problems.push(`${a.name}：链接格式可疑 → ${u}`);
    }
    if (urlOwner.has(u)) problems.push(`${a.name} 与 ${urlOwner.get(u)} 用了同一个分享链接（多半是复制错了）`);
    else urlOwner.set(u, a.name);
    if (!a.netdisk.pwd) warn(`${a.name}：没有提取码（若该分享确实是公开链接，忽略即可）`);
  }
  if (problems.length) {
    fail('校验没通过，已中止（没有写入任何东西）：');
    for (const p of problems) log(`  ✗ ${p}`);
    return 1;
  }
  log('校验通过：链接格式正常、没有重复链接。');

  /* ---------- 4. 写回 bundle + 合并 ---------- */
  const before = countSiteApps();
  if (!DRY) {
    writeJSON(bundlePath, bundle);
    log(`\n已把链接写回 ${bundlePath}`);
  }

  const r = mergeDay({ date: DATE, dryRun: DRY, bundle });
  if (!r.ok) { fail('合并失败，已中止。'); return 1; }

  if (DRY) {
    log('\n--dry-run 结束：以上都没有写盘，也没有重建站点。');
    return 0;
  }
  if (!r.written) {
    // 退出码语义要准：否则计划任务会把「今天没有新条目」当成「发布失败」误报。
    // 判据来自 merge 带回来的原因分类（它才知道为什么没写成）：
    //   actionable > 0 → 有内容问题要你处理（文案没写、分类非法、链接没填）→ 非 0
    //   否则          → 良性无事可做（站上已收录、或今天没有可发布条目）→ 0
    const candidates = ready ? ready.length : 0;
    if (r.actionable) {
      warn(`有 ${candidates} 个条目填了链接，其中 ${r.actionable} 个因内容问题被拒（原因见上）。站点未改动。`);
      return 1;
    }
    log('');
    log(r.alreadyOnly
      ? '这个日期的条目都已经在站上了（重跑 publish 是幂等的），站点未改动。'
      : '今天没有可发布的条目（登记表里没有已填链接的新条目），站点未改动。');
    log('两种情况都不算失败（exit 0）—— 需要你处理时才返回非 0。');
    return 0;
  }

  /* ---------- 5. 重建 + 校验 ---------- */
  if (SKIP_BUILD) {
    log('\n--skip-build：跳过重建站点。要生效请手动跑 node redesign\\build.mjs');
  } else {
    if (!runScript(path.join(SITE_ROOT, 'build.mjs'), '重建站点')) return 1;
    if (!runScript(path.join(SITE_ROOT, 'tools', 'check-dist.js'), '校验产物')) return 1;
    // 筛选是纯客户端行为，check-dist 只看静态 HTML 看不出来 —— 发布前同样要过一遍，
    // 免得「多平台筛选悄悄退回一张卡只算一个平台」这种问题跟着上线
    if (!runScript(path.join(SITE_ROOT, 'tools', 'check-facets.mjs'), '核对筛选')) return 1;
  }

  /* ---------- 6. 汇总 ---------- */
  const after = SKIP_BUILD ? null : countSiteApps();
  log('\n════════════════ 发布完成 ════════════════');
  log(`新增 ${r.written} 个条目${r.skipped ? `，跳过 ${r.skipped} 个` : ''}`);
  if (before != null && after != null) log(`站点条目数：${before} → ${after}`);
  for (const e of r.entries || []) log(`  ✓ 第 ${e.row} 行 ← ${e.name}`);

  /* ---------- 7. 部署提示 ---------- */
  const distDir = path.join(SITE_ROOT, 'dist');
  let fileCount = 0;
  let bytes = 0;
  try {
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else { fileCount++; bytes += fs.statSync(p).size; }
      }
    };
    walk(distDir);
  } catch { /* 统计失败不影响主流程 */ }

  log('');
  log('════════════════ 最后一步：部署 ════════════════');
  log('本地已经重建好了，但访客还看不到 —— 需要你把下面这个目录传上去（覆盖旧文件）：');
  log(`  ${distDir}`);
  if (fileCount) log(`  （${fileCount} 个文件，共 ${(bytes / 1048576).toFixed(1)} MB）`);
  log('');
  log('传完之后核对一下（直接用线上真实页面检查条目和网盘链接）：');
  log('  node redesign\\tools\\daily\\verify-live.mjs');
  /* ---------- 8. 百度收录推送 ----------
     注意顺序：这一步跑的时候页面**还没部署**（部署要你手动传 dist）。
     所以这里只推「已经能打开的」页面，新的那几个会被记成「等待部署」，
     等你传完 dist 再跑一次本步骤就会自动补推 —— 先验证再推，顺序错了也不会推错。 */
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const pushTool = path.join(__dirname, '..', 'baidu-push.mjs');
  const hasToken = !!process.env.BAIDU_PUSH_TOKEN
    || fs.existsSync(path.join(repoRoot, '_daily', 'baidu-push-token.txt'))
    || fs.existsSync(path.join(__dirname, 'state', 'baidu-push-token.txt'));

  log('');
  log('════════════════ 百度收录推送 ════════════════');
  if (!hasToken) {
    log('  未配置推送 token，跳过（不影响发布）。');
    log('  配置一次即可：百度搜索资源平台 → 普通收录 → API 提交 → 推送接口，取那串 token，然后');
    log(`    [IO.File]::WriteAllText('${path.join(repoRoot, '_daily', 'baidu-push-token.txt')}', '你的token', [Text.UTF8Encoding]::new($false))`);
  } else if (!fs.existsSync(pushTool)) {
    log(`  找不到 ${path.relative(repoRoot, pushTool)}，跳过。`);
  } else {
    try {
      // --max=10：百度普通收录配额实测只有 10 条/天，所以每次发布只推这么多，
      // 免得候选上百条时撞上「超过 20 条需要显式确认」的闸门而整天推不动。
      const r = spawnSync(process.execPath, [pushTool, '--max=10'], { stdio: 'inherit' });
      if (r.status === 2) {
        log('');
        log('  今日推送配额已用尽，属正常状态（配额每天重置），未推的页面明天自动继续。');
      } else if (r.status !== 0) {
        log('');
        log('  推送没跑成（上面的原因）。常用两条：');
        log('    node redesign\\tools\\baidu-push.mjs --max=10    # 先推重点页面，省配额');
        log('    node redesign\\tools\\baidu-push.mjs --all       # 首次全量');
      }
    } catch (e) {
      log(`  推送步骤执行失败（${e.message}），不影响发布本身。`);
    }
  }
  log('');
  log('部署完 dist 之后，再跑一次推送即可把本次新增页面补上：');
  log('  node redesign\\tools\\baidu-push.mjs');

  /* ---------- 9. 收录自检：把积压快照写进当日日志 ----------
     跑在推送之后，所以「积压」是本次 publish 推完之后的真实剩余量；
     新增页面此刻还没部署、必然算在「从未提交」里，部署完再推一次就会下去。 */
  log('');
  log('════════════════ 收录自检 ════════════════');
  try {
    const s = computeIndexSummary();
    if (s && !s.error) {
      const line = `sitemap ${s.total} · 已提交 ${s.current} · 需重推 ${s.stale} · 积压 ${s.pending}（从未提交 ${s.never}）`;
      log(`  ${line}`);
      const logFile = path.join(DAY_DIR, 'log.txt');
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.appendFileSync(logFile, `[收录自检] ${line}\n`, 'utf8');
        log(`  （已写入当日日志 ${path.relative(REPO_ROOT, logFile)}）`);
      } catch (e) {
        log(`  （写当日日志失败：${e.message}）`);
      }
    } else if (s && s.error) {
      log(`  ${s.error}`);
    }
  } catch (e) {
    log(`  收录自检失败（${e.message}）`);
  }

  if (!NO_OPEN) {
    try {
      spawnSync('explorer.exe', [distDir], { stdio: 'ignore' });
      log('');
      log('已经帮你把 dist 文件夹打开了（不想自动打开就加 --no-open）。');
    } catch { /* 打不开就算了，路径上面已经给了 */ }
  }
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = main();
