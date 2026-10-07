#!/usr/bin/env node
/* ============================================================
   APK 结构速查（排障用）
   ------------------------------------------------------------
   日常采集不需要它。当某个 APK 的包名/图标解析不出来时，
   用它看清包里到底有什么、arsc 里到底怎么指的。

   用法：
     node redesign\tools\daily\inspect-apk.mjs <apk路径>
     node redesign\tools\daily\inspect-apk.mjs <apk路径> .png      # 只看含 .png 的条目
   ============================================================ */
import path from 'node:path';
import fs from 'node:fs';
import { Zip, parseManifest, detectSignature, inspectApk } from './apk.mjs';
import { parseArsc, expandResource } from './arsc.mjs';
import { humanSize } from './util.mjs';

const file = process.argv[2];
const filter = process.argv[3] || '';
if (!file) {
  console.error('用法：node inspect-apk.mjs <apk路径> [条目过滤关键字]');
  process.exit(1);
}

const zip = new Zip(file);
try {
  const all = zip.list();
  console.log(`文件 ${path.basename(file)}  ${humanSize(zip.size)}  条目 ${all.length}`);

  if (filter) {
    const hits = all.filter(e => e.name.includes(filter));
    console.log(`\n匹配 "${filter}" 的条目 ${hits.length} 个：`);
    for (const e of hits.sort((a, b) => b.rawSize - a.rawSize).slice(0, 50)) {
      console.log(`  ${humanSize(e.rawSize).padStart(11)}  ${e.name}`);
    }
  } else {
    console.log('\n=== manifest ===');
    try { console.log(JSON.stringify(parseManifest(zip.read('AndroidManifest.xml', 4 * 1024 * 1024)), null, 2)); }
    catch (e) { console.log('  解析失败：' + e.message); }

    console.log('\n=== 签名 ===');
    console.log('  ' + JSON.stringify(detectSignature(zip)));

    if (zip.has('resources.arsc')) {
      console.log('\n=== 图标资源反查 ===');
      try {
        const m = parseManifest(zip.read('AndroidManifest.xml', 4 * 1024 * 1024));
        const arsc = parseArsc(zip.read('resources.arsc', 64 * 1024 * 1024));
        for (const [label, id] of [['icon', m.iconRef], ['roundIcon', m.roundIconRef], ['label', m.labelRef]]) {
          if (id == null) { console.log(`  ${label}: manifest 里没有此引用`); continue; }
          const vs = expandResource(arsc, id);
          console.log(`  ${label} 0x${(id >>> 0).toString(16)} → ${vs.length} 个取值`);
          for (const v of vs.slice(0, 8)) console.log(`      ${v.densityName}/${v.typeName}/${v.keyName} → ${v.path ?? v.kind}`);
        }
      } catch (e) { console.log('  反查失败：' + e.message); }
    }

    console.log('\n=== 完整解析（与采集流程一致）===');
    const r = inspectApk(file);
    console.log('  ' + JSON.stringify({
      package: r.manifest && r.manifest.package, versionName: r.manifest && r.manifest.versionName,
      label: r.label, hasDex: r.hasDex, hasArsc: r.hasArsc, signature: r.signature,
      icon: r.icon ? { path: r.icon.path, via: r.icon.via, size: `${r.icon.w || '?'}×${r.icon.h || '?'}`, density: r.icon.density } : null,
    }, null, 2));
    if (r.notes.length) { console.log('  说明：'); r.notes.forEach(n => console.log('    · ' + n)); }
    if (r.errors.length) { console.log('  错误：'); r.errors.forEach(n => console.log('    ✗ ' + n)); }
    if (r.icon) {
      const out = `_icon-${path.basename(file, '.apk')}.png`;
      fs.writeFileSync(out, r.icon.buf);
      console.log(`  图标已写出：${out}`);
    }
  }
} finally {
  zip.close();
}
