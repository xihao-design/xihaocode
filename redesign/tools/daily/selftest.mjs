#!/usr/bin/env node
/* ============================================================
   APK 解析器自检
   ------------------------------------------------------------
   拿真实 Release 里的真 APK 跑一遍解析，确认：
     能解开 zip、能读出包名/版本、能判定签名、能抠出图标
   用法：node tools/daily/selftest.mjs [owner/repo ...]
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listReleases, pickApkRelease, downloadTo, hasToken } from './channels.mjs';
import { inspectApk } from './apk.mjs';
import { ensureDir, humanSize, sniffImage, log } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const TMP = path.join(__dirname, '_selftest');
ensureDir(TMP);

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['cyb3rko/flashdim', 'Predidit/Kazumi', 'JunkFood02/Seal'];

log(`GitHub Token：${hasToken ? '已配置' : '未配置（核心 API 只有 60 次/小时）'}`);
log(`测试目标：${targets.join(', ')}\n`);

let pass = 0, fail = 0;

for (const repo of targets) {
  log(`── ${repo} ─────────────────────────────`);
  try {
    const releases = await listReleases(repo, 5);
    const pick = pickApkRelease(releases, cfg.filters);
    if (!pick) { log('  · 没有可用的 APK 资产，跳过'); continue; }

    const a = pick.asset;
    log(`  release ${pick.release.tag}  asset ${a.name}  ${humanSize(a.size)}  digest=${a.digest || '无'}`);

    const dest = path.join(TMP, `${repo.replace('/', '__')}.apk`);
    if (!fs.existsSync(dest) || fs.statSync(dest).size !== a.size) {
      await downloadTo(a.url, dest, {
        mirrors: cfg.mirrors,
        tryDirect: cfg.tryDirect,
        expectSize: a.size,
        expectSha256: a.digest ? a.digest.replace(/^sha256:/, '') : null,
        label: a.name,
      });
    } else {
      log('  · 本地已有同尺寸文件，跳过下载');
    }

    const r = inspectApk(dest);
    const m = r.manifest || {};
    log(`  包名        ${m.package || '（未读到）'}`);
    log(`  版本        ${m.versionName || '?'} (code ${m.versionCode || '?'})`);
    log(`  SDK         min ${m.minSdk || '?'} / target ${m.targetSdk || '?'}`);
    log(`  签名        ${r.signature.signed === true ? '已签名 ' + r.signature.schemes.join('+') : r.signature.signed === false ? '⚠ 未检出签名' : '未知'}`);
    log(`  组件        activity ${m.activities ? m.activities.length : 0} 个，权限 ${m.permissions.length} 条`);
    log(`  应用内名称  ${r.label || '（未解析到）'}`);
    log(`  dex         ${r.hasDex ? '有' : '⚠ 无'}`);
    if (r.icon) {
      const side = r.icon.w ? `${r.icon.w}×${r.icon.h}` : '尺寸未知';
      log(`  图标        ${r.icon.path} (${r.icon.density}, ${side}, ${humanSize(r.icon.buf.length)}, via=${r.icon.via})`);
      fs.writeFileSync(path.join(TMP, path.basename(repo) + '.icon.png'), r.icon.buf);
    } else {
      log('  ⚠ 图标        未从 APK 中提取到');
    }
    for (const n of r.notes || []) log(`  · ${n}`);
    if (r.errors.length) for (const e of r.errors) log(`  ⚠ ${e}`);

    const good = m.package && r.hasDex && r.signature.signed === true;
    if (good) { pass++; log('  ✓ 通过'); } else { fail++; log('  ✗ 关键字段缺失'); }
  } catch (e) {
    fail++;
    log(`  ✗ 失败：${e.message}`);
  }
  log('');
}

log(`自检结果：通过 ${pass} / 失败 ${fail}`);
log(`样例产物在 ${TMP}`);
