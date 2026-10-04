/* ============================================================
   脚本增量：线上 app.js 的**登记式替换**
   ------------------------------------------------------------
   样式那边是「live/styles.css 逐字节不动 + live/addon.css 追加」。脚本不能照抄这个形式：
   这次的改动是**修改线上已有的函数**（筛选器的分面匹配），追加在文件末尾够不着 IIFE 里的
   `$` / `$$`，把那段逻辑复制一份出来又正是本工程最反对的事（「同一个判断写了两份」）。
   所以脚本的增量改成**精确文本替换**，逐条登记在这里：

     · 每处替换必须命中**恰好一次** —— 少了是静默少改一行，多了是改到了别的地方，都直接抛错；
     · 线上产物换一份（BASE_SHA256 变了）也直接抛错，逼人重新确认每条替换；
     · 因此等式重新成立，而且可以机器核对：

         产物 dist/assets/app.js  ==  线上 app.js（逐字节，sha256 可与线上比对）  +  下面这份增量

   `npm run check`（check-dist）会断言这个等式，并断言哨兵确实进了产物。
   ============================================================ */
'use strict';
const crypto = require('crypto');

/** 基线：这一版线上 app.js 的 sha256。换线上产物时这个值会变 —— 那时应当逐条重看替换是否还成立。 */
const BASE_SHA256 = 'd89ac0849e105e1f81ed8467b405c07c6f9a50265f4470d8bef4410739afc4a3';

/** 留在产物里的哨兵：check-dist 用它断言「增量确实进了产物」，而不是只断言文件存在 */
const SENTINEL = '/* [app-delta] 一维多值：同 key 可重复出现 */';

/** 三处替换 = 一个功能：分面值从「一个 key 一个值」升级为「一个 key 多个值」。
    为什么需要：电脑软件页 /desktop/ 的「平台」维度里，一款软件可能同时支持 Windows 与 macOS
    （值域取自 content/tags.json 的「支持桌面端」，按核实字段取子串），
    旧写法是覆盖，多平台软件只会算进最后一个平台 —— 页面上写「Windows 14」点进去只剩 12 张。 */
const DELTA = [
  {
    why: '分面解析：同一个 key 允许出现多次，值累积成数组而不是互相覆盖',
    find: `      (c.dataset.facets || '').split(';').forEach(function (kv) {
        var i = kv.indexOf('=');
        if (i > 0) f[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      });`,
    replace: `      (c.dataset.facets || '').split(';').forEach(function (kv) {
        ${SENTINEL}
        var i = kv.indexOf('=');
        if (i <= 0) return;
        var k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
        // 累积而不是覆盖：多值卡片（电脑软件页的多平台软件）会被后一个值压掉。
        // 单值卡片（技能库 repo/host/mode）行为与从前完全一致，数组里只有一个值。
        (f[k] = f[k] || []).push(v);
      });`,
  },
  {
    why: '命中判定：该维度已选值与卡片值有交集即命中（同一维度内取「或」，与多选语义一致）',
    find: `          if (!state[k].has(c._facets[k])) { ok = false; break; }`,
    replace: `          var vals = c._facets[k];
          if (!vals || !vals.some(function (v) { return state[k].has(v); })) { ok = false; break; }`,
  },
  {
    why: '深链：平台筛选结果可分享（/desktop/?plat=macOS），与技能库的 repo/host/mode 同一套',
    find: `    ['repo', 'host', 'mode'].forEach(function (k) {`,
    replace: `    ['repo', 'host', 'mode', 'plat'].forEach(function (k) {`,
  },
];

const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** 线上源码 → 产物源码。任何一处对不上都抛错，绝不「尽量替换」。 */
function applyAppDelta(onlineSource) {
  const got = sha256(onlineSource);
  if (got !== BASE_SHA256) {
    throw new Error(
      `线上脚本换代了（live/app.js 的 sha256 = ${got}，登记的是 ${BASE_SHA256}）。\n` +
      `  这说明取回的线上产物不是登记这一版。请逐条确认 live/app-delta.js 里的替换是否仍然命中，` +
      `确认无误后把 BASE_SHA256 更新成上面这个值。`);
  }
  let out = onlineSource;
  DELTA.forEach((d, i) => {
    const parts = out.split(d.find);
    if (parts.length !== 2) {
      throw new Error(
        `第 ${i + 1} 处增量命中 ${parts.length - 1} 次（必须恰好 1 次）—— ${d.why}\n` +
        `  找不到的原文开头：${JSON.stringify(d.find.slice(0, 70))}`);
    }
    // 用 split/join 而不是 String.replace：替换文本里若出现 $& 这类模式，replace 会当特殊序列解释
    out = parts[0] + d.replace + parts[1];
  });
  if (!out.includes(SENTINEL)) throw new Error('增量应用后没有留下哨兵，替换写法可能被改坏了');
  return out;
}

module.exports = { BASE_SHA256, SENTINEL, DELTA, applyAppDelta, sha256 };
