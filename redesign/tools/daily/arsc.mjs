/* ============================================================
   resources.arsc 解析（零依赖）
   ------------------------------------------------------------
   为什么非要有它：现代 APK 普遍开启资源精简/混淆，图标文件名会变成
   res/NU.png 这种看不出用途的东西（实测 FlashDim 就是），
   靠「文件名里有没有 ic_launcher」找图标必然失败。

   权威做法是按资源 ID 反查：
     AndroidManifest 里 application@icon = @0x7f0e0000
       → packageId 0x7f，typeId 0x0e，entryIndex 0
       → 在 arsc 里定位该条目 → 拿到字符串 "res/NU.png"
   这条路径不受资源名混淆影响，而且能顺带解出 App 的真实名称。

   结构：ResTable_header → 全局字符串池 → 每个包(PACKAGE)
         包内：类型字符串池 + 键字符串池 + 每个配置一份 TYPE chunk
   ============================================================ */
import { parseStringPoolRaw } from './axmlpool.mjs';

const RES_TABLE_TYPE = 0x0002;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;

const FLAG_SPARSE = 0x01;
const FLAG_OFFSET16 = 0x02;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;

/** 密度：数值越大越清晰（anydpi/nodpi 用 0，排最后再兜底） */
const DENSITY_NAMES = {
  0: 'default', 120: 'ldpi', 160: 'mdpi', 213: 'tvdpi', 240: 'hdpi',
  320: 'xhdpi', 480: 'xxhdpi', 640: 'xxxhdpi',
  0xfffe: 'anydpi', 0xffff: 'nodpi',
};

function readConfigDensity(buf, configOffset) {
  // ResTable_config: size(4) imsi(4) locale(4) screenType{orientation(1),touchscreen(1),density(2)}
  // => density 位于 config 起点 +14
  if (configOffset + 16 > buf.length) return 0;
  const size = buf.readUInt32LE(configOffset);
  if (size < 16) return 0;
  return buf.readUInt16LE(configOffset + 14);
}

export function parseArsc(buf) {
  if (!buf || buf.length < 12) throw new Error('arsc 太短');
  const type = buf.readUInt16LE(0);
  if (type !== RES_TABLE_TYPE) throw new Error(`不是 arsc（type=0x${type.toString(16)}）`);

  // 全局字符串池紧跟在 12 字节的 ResTable_header 之后
  const poolOffset = buf.readUInt16LE(2);
  const globalPool = parseStringPoolRaw(buf, poolOffset);
  const globalStrings = globalPool ? globalPool.strings : [];

  const packages = [];
  let p = poolOffset + (globalPool ? globalPool.chunkSize : 0);
  while (p + 8 <= buf.length) {
    const ctype = buf.readUInt16LE(p);
    const headerSize = buf.readUInt16LE(p + 2);
    const chunkSize = buf.readUInt32LE(p + 4);
    if (chunkSize <= 0) break;

    if (ctype === RES_TABLE_PACKAGE_TYPE) {
      const id = buf.readUInt32LE(p + 8);
      const typeStringsOff = buf.readUInt32LE(p + 8 + 256 + 4);
      const keyStringsOff = buf.readUInt32LE(p + 8 + 256 + 12);

      const typePool = parseStringPoolRaw(buf, p + typeStringsOff);
      const keyPool = parseStringPoolRaw(buf, p + keyStringsOff);

      const types = new Map(); // typeId -> [ {configDensity, entries: Map} ]
      let q = p + headerSize;
      while (q + 8 <= p + chunkSize) {
        const st = buf.readUInt16LE(q);
        const shs = buf.readUInt16LE(q + 2);
        const ssz = buf.readUInt32LE(q + 4);
        if (ssz <= 0) break;
        if (st === RES_TABLE_TYPE_TYPE && q + 20 <= buf.length) {
          const typeId = buf.readUInt8(q + 8);
          const flags = buf.readUInt8(q + 9);
          const entryCount = buf.readUInt32LE(q + 12);
          const entriesStart = buf.readUInt32LE(q + 16);
          const density = readConfigDensity(buf, q + 20);

          const entries = new Map();
          const dataBase = q + entriesStart;
          const offBase = q + shs;

          const readEntryAt = (index, entryOffset) => {
            // 只有 0xFFFFFFFF 表示「该下标没有条目」。
            // offset = 0 是合法值（条目数据紧跟在 entriesStart 处，第一条的偏移就是 0）——
            // 早前把 0 也当成「无条目」丢掉，导致整个下标错位一位，
            // 症状是 manifest 指向 entryIndex 0 却查不到（AntennaPod 的图标就是这么丢的）。
            if (entryOffset === 0xffffffff) return;
            const ep = dataBase + entryOffset;
            if (ep + 8 > buf.length) return;
            const eSize = buf.readUInt16LE(ep);
            if (eSize < 8 || eSize > 256) return;   // 头长度不合理，视为无效偏移
            const eFlags = buf.readUInt16LE(ep + 2);
            const keyIdx = buf.readUInt32LE(ep + 4);
            if (eFlags & 0x0001) return;        // 复杂条目（bag），图标不会走这里
            const vp = ep + eSize;
            if (vp + 8 > buf.length) return;
            const dataType = buf.readUInt8(vp + 3);
            if (dataType > 0x1f) return;        // Res_value 的 dataType 超出已知范围
            const data = buf.readUInt32LE(vp + 4);
            entries.set(index, { keyIdx, dataType, data });
          };

          if (flags & FLAG_SPARSE) {
            for (let i = 0; i + 4 <= entryCount * 4 && offBase + i + 4 <= buf.length; i += 4) {
              const idx = buf.readUInt16LE(offBase + i);
              const off = buf.readUInt16LE(offBase + i + 2) * 4;
              if (idx === 0xffff) continue;
              readEntryAt(idx, off);
            }
          } else if (flags & FLAG_OFFSET16) {
            for (let i = 0; i < entryCount; i++) {
              const op = offBase + i * 2;
              if (op + 2 > buf.length) break;
              const off = buf.readUInt16LE(op);
              if (off === 0xffff) continue;
              readEntryAt(i, off * 4);
            }
          } else {
            for (let i = 0; i < entryCount; i++) {
              const op = offBase + i * 4;
              if (op + 4 > buf.length) break;
              readEntryAt(i, buf.readUInt32LE(op));
            }
          }

          if (!types.has(typeId)) types.set(typeId, []);
          types.get(typeId).push({ density, entries });
        }
        q += ssz;
      }

      packages.push({
        id,
        typeNames: typePool ? typePool.strings : [],
        keyNames: keyPool ? keyPool.strings : [],
        types,
        start: p,
      });
    }
    p += chunkSize;
  }

  return { globalStrings, packages };
}

/** 资源 ID → 包 / 类型 / 条目下标 */
export function splitResId(id) {
  const v = id >>> 0;
  return { packageId: (v >>> 24) & 0xff, typeId: (v >>> 16) & 0xff, entryIndex: v & 0xffff };
}

/**
 * 把一个资源 ID 在所有配置下的取值全部摊开，按「清晰度优先」排序。
 *
 * 为什么要摊开而不是只取第一名：自适应图标在 anydpi-v26 下是一个 XML，
 * 而 XML 里的 foreground 也可能是矢量图（没法直接当位图用）。
 * 调用方需要能顺着候选往下试，直到试出一个真能读的位图。
 */
export function expandResource(arsc, resId, depth = 0) {
  if (depth > 4 || resId == null) return [];
  const { packageId, typeId, entryIndex } = splitResId(resId);
  const pkg = arsc.packages.find(p => p.id === packageId);
  if (!pkg) return [];
  const variants = pkg.types.get(typeId) || [];
  const typeName = pkg.typeNames[typeId - 1] || null;

  const out = [];
  for (const v of variants) {
    const entry = v.entries.get(entryIndex);
    if (!entry) continue;
    const keyName = pkg.keyNames[entry.keyIdx] || null;
    const densityName = DENSITY_NAMES[v.density] || String(v.density);

    if (entry.dataType === TYPE_REFERENCE) {
      for (const sub of expandResource(arsc, entry.data, depth + 1)) {
        out.push({ ...sub, via: `@0x${(resId >>> 0).toString(16)} → @0x${(entry.data >>> 0).toString(16)}` });
      }
    } else if (entry.dataType === TYPE_STRING) {
      out.push({ path: arsc.globalStrings[entry.data] ?? null, kind: 'string', refId: resId >>> 0, typeName, keyName, density: v.density, densityName });
    } else if (entry.dataType === TYPE_INT_DEC || entry.dataType === TYPE_INT_HEX) {
      out.push({ path: null, int: entry.data, kind: 'int', refId: resId >>> 0, typeName, keyName, density: v.density, densityName });
    } else {
      out.push({ path: null, kind: `dataType=0x${entry.dataType.toString(16)}`, refId: resId >>> 0, typeName, keyName, density: v.density, densityName });
    }
  }
  return out.sort((a, b) => rankDensity(b.density) - rankDensity(a.density));
}

/** 反查资源 ID，取最优先的那个取值 */
export function resolveResource(arsc, resId) {
  const all = expandResource(arsc, resId);
  const top = all[0] || null;
  if (!top) return { value: null, reason: '该资源没有可解析的取值', variants: [] };
  return {
    value: top.kind === 'int' ? top.int : top.path,
    kind: top.kind, typeName: top.typeName, keyName: top.keyName,
    density: top.density, densityName: top.densityName,
    variants: all,
  };
}

/** 资源 ID 对应的人类可读名，用于日志 */
export function describeResId(arsc, resId) {
  const { packageId, typeId } = splitResId(resId);
  const pkg = arsc.packages.find(p => p.id === packageId);
  return {
    typeName: pkg ? (pkg.typeNames[typeId - 1] || null) : null,
    hex: '0x' + (resId >>> 0).toString(16),
  };
}

function rankDensity(d) {
  if (d === 0xfffe) return 10;   // anydpi：矢量，能缩放到任意尺寸
  if (d === 0xffff) return 5;    // nodpi
  return d || 1;
}

export function dumpArscSummary(arsc) {
  return arsc.packages.map(p => ({
    id: '0x' + p.id.toString(16),
    types: [...p.types.entries()].map(([tid, vs]) => ({
      typeId: tid,
      name: p.typeNames[tid - 1] || '?',
      configs: vs.map(v => `${v.entries.size}条@${DENSITY_NAMES[v.density] || v.density}`),
    })),
  }));
}
