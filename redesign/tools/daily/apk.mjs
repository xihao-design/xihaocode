/* ============================================================
   APK 解析器（零依赖）
   ------------------------------------------------------------
   为什么自己写 zip / AXML / arsc 解析，而不是调 Expand-Archive：
   1. 站点工程的原则是「只有 Node 内置模块」，不引入解压依赖
   2. 沙箱里 Node 的管道 stdio 被禁，spawn 外部工具拿不到输出
   3. AndroidManifest.xml 是二进制 XML，resources.arsc 是二进制资源表，
      本来就得自己解

   图标为什么必须走 arsc：
   实测 FlashDim 的 APK 开启了资源混淆，图标是 res/NU.png，
   文件名里根本没有 "launcher" 字样，「按文件名找图标」必然失败。
   权威做法是按 AndroidManifest 里的 application@icon 资源 ID 反查 arsc，
   既不怕混淆，还能拿到最高密度的那张。

   产出全部来自 APK 文件本身，读不到就是 null，不猜、不编造。
   ============================================================ */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { sniffImage } from './util.mjs';
import { parseBinaryXml, parsePlainXmlElements } from './axmlpool.mjs';
import { parseArsc, expandResource } from './arsc.mjs';

/* ============ 一、ZIP 读取 ============ */
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CD = 0x02014b50;
const SIG_LFH = 0x04034b50;

function readAt(fd, pos, len) {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (n <= 0) break;
    got += n;
  }
  return got === len ? buf : buf.subarray(0, got);
}

export class Zip {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this.entries = new Map();
    this._readCentralDirectory();
  }

  _readCentralDirectory() {
    const tailLen = Math.min(this.size, 66000);
    const tail = readAt(this.fd, this.size - tailLen, tailLen);
    let eocdPos = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocdPos = i; break; }
    }
    if (eocdPos < 0) throw new Error('不是有效的 zip：找不到 EOCD');

    let entryCount = tail.readUInt16LE(eocdPos + 10);
    let cdSize = tail.readUInt32LE(eocdPos + 12);
    let cdOffset = tail.readUInt32LE(eocdPos + 16);

    // Zip64：字段全为 0xFFFF/0xFFFFFFFF 时改读 Zip64 EOCD
    if (entryCount === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      const locPos = this.size - tailLen + eocdPos - 20;
      if (locPos >= 0) {
        const loc = readAt(this.fd, locPos, 20);
        if (loc.readUInt32LE(0) === SIG_EOCD64_LOC) {
          const z64Off = Number(loc.readBigUInt64LE(8));
          const z64 = readAt(this.fd, z64Off, 56);
          if (z64.readUInt32LE(0) === SIG_EOCD64) {
            entryCount = Number(z64.readBigUInt64LE(32));
            cdSize = Number(z64.readBigUInt64LE(40));
            cdOffset = Number(z64.readBigUInt64LE(48));
          }
        }
      }
    }

    const cd = readAt(this.fd, cdOffset, cdSize);
    // 记下中央目录位置：签名检测要靠它精确定位 APK Signing Block
    this.cdOffset = cdOffset;
    this.cdSize = cdSize;
    let p = 0;
    for (let i = 0; i < entryCount && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== SIG_CD) break;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compSize = cd.readUInt32LE(p + 20);
      let rawSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let lfhOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');

      // Zip64 扩展字段：按 原始大小 → 压缩大小 → 本地头偏移 的顺序补 8 字节
      if (rawSize === 0xffffffff || compSize === 0xffffffff || lfhOffset === 0xffffffff) {
        let ep = p + 46 + nameLen;
        const epEnd = ep + extraLen;
        while (ep + 4 <= epEnd) {
          const hid = cd.readUInt16LE(ep);
          const hsz = cd.readUInt16LE(ep + 2);
          if (hid === 0x0001) {
            let q = ep + 4;
            if (rawSize === 0xffffffff) { rawSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (lfhOffset === 0xffffffff) { lfhOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
            break;
          }
          ep += 4 + hsz;
        }
      }

      // 数据起点必须从本地头重算：本地头的 extra 长度可能和中央目录不一致
      const lfh = readAt(this.fd, lfhOffset, 30);
      if (lfh.readUInt32LE(0) === SIG_LFH) {
        const lNameLen = lfh.readUInt16LE(26);
        const lExtraLen = lfh.readUInt16LE(28);
        this.entries.set(name, {
          name, method, crc, compSize, rawSize,
          dataOffset: lfhOffset + 30 + lNameLen + lExtraLen,
          encrypted: (flags & 0x0001) !== 0,
          isDir: name.endsWith('/'),
        });
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  list() { return [...this.entries.values()]; }
  has(name) { return this.entries.has(name); }
  info(name) { return this.entries.get(name) || null; }

  /** 只解压需要的条目，不整包解压 */
  read(name, maxBytes = 32 * 1024 * 1024) {
    const e = this.entries.get(name);
    if (!e) return null;
    if (e.encrypted) throw new Error(`条目已加密: ${name}`);
    if (e.rawSize > maxBytes) throw new Error(`条目过大 ${e.rawSize}B: ${name}`);
    const comp = readAt(this.fd, e.dataOffset, e.compSize);
    if (e.method === 0) return comp;
    if (e.method === 8) return zlib.inflateRawSync(comp, { maxOutputLength: maxBytes });
    throw new Error(`不支持的压缩方式 ${e.method}: ${name}`);
  }

  readHead(name, n = 32) {
    const e = this.entries.get(name);
    if (!e) return null;
    if (e.method !== 0) return this.read(name, 4 * 1024 * 1024).subarray(0, n);
    return readAt(this.fd, e.dataOffset, Math.min(n, e.compSize));
  }

  close() { try { fs.closeSync(this.fd); } catch {} }
}

/* ============ 二、AndroidManifest.xml ============ */

function xmlOf(buf) {
  try { return parseBinaryXml(buf); }
  catch {
    const text = buf.toString('utf8');
    if (text.trimStart().startsWith('<')) return parsePlainXmlElements(text);
    throw new Error('无法解析 AndroidManifest.xml');
  }
}

/**
 * 读出包名、版本、SDK、权限，以及 application 上的图标/名称资源引用。
 * 属性名在字符串池里是明文（package / versionName / minSdkVersion …），
 * 所以按名字匹配即可，不依赖资源 ID 表。
 */
export function parseManifest(buf) {
  const { elements } = xmlOf(buf);
  const result = {
    package: null, versionName: null, versionCode: null,
    minSdk: null, targetSdk: null, compileSdk: null,
    label: null, labelRef: null,
    iconRef: null, roundIconRef: null,
    permissions: [], features: [], requiredFeatures: [], categories: [], activities: [], launcherActivity: null,
    debuggable: null, allowBackup: null,
  };
  const str = a => (a && a.str != null ? String(a.str) : null);
  const num = a => (a && a.int != null ? String(a.int) : null);

  for (const el of elements) {
    const A = el.attrs || {};
    if (el.name === 'manifest') {
      result.package = str(A.package);
      result.versionName = str(A.versionName);
      result.versionCode = num(A.versionCode) ?? str(A.versionCode);
      result.compileSdk = num(A.compileSdkVersion) ?? str(A.compileSdkVersion);
    } else if (el.name === 'uses-sdk') {
      result.minSdk = num(A.minSdkVersion) ?? str(A.minSdkVersion);
      result.targetSdk = num(A.targetSdkVersion) ?? str(A.targetSdkVersion);
    } else if (el.name === 'uses-permission') {
      if (A.name && A.name.str) result.permissions.push(String(A.name.str).replace(/^android\.permission\./, ''));
    } else if (el.name === 'uses-feature') {
      if (A.name && A.name.str) {
        const nm = String(A.name.str).replace(/^android\.hardware\./, '');
        result.features.push(nm);
        // required 不写时默认 true（视为必需）；只有显式 required="false" 才算可选。
        // 这个区分很关键：很多手机应用也声明 leanback 但标为可选（表示顺带支持 TV），
        // 只有必需时才该判定为「TV 专用」。
        const req = A.required && A.required.int != null ? A.required.int !== 0 : true;
        if (req) result.requiredFeatures.push(nm);
      }
    } else if (el.name === 'application') {
      result.label = str(A.label);
      result.labelRef = A.label && A.label.ref != null ? A.label.ref : null;
      result.iconRef = A.icon && A.icon.ref != null ? A.icon.ref : null;
      if (!result.iconRef && A.icon && A.icon.str) result.iconFallbackFile = A.icon.str;
      result.roundIconRef = A.roundIcon && A.roundIcon.ref != null ? A.roundIcon.ref : null;
      result.debuggable = A.debuggable && A.debuggable.int != null ? A.debuggable.int !== 0 : null;
      result.allowBackup = A.allowBackup && A.allowBackup.int != null ? A.allowBackup.int !== 0 : null;
    } else if (el.name === 'category') {
      // intent-filter 里的 category —— LAUNCHER 表示会出现在手机启动器，
      // LEANBACK_LAUNCHER 表示会出现在电视启动器。判断平台就靠它。
      if (A.name && A.name.str) result.categories.push(String(A.name.str));
    } else if (el.name === 'activity' || el.name === 'activity-alias') {
      result.activities.push(str(A.name) || '(匿名)');
    }
  }
  return result;
}

/**
 * 从 manifest 判断实际运行平台。
 *
 * 为什么必须判断：Jellyfin 安卓电视版这类应用，如果站点一律写「支持平台 Android」，
 * 访客不知道它还能装在电视上；反过来 TV 专用应用写 Android，手机用户装了却用不了。
 *
 * 判据用 launcher category，而不是「leanback 是否必需」——
 * 实测 Jellyfin 把 leanback 标成了 required=false，但它同时声明了
 * LAUNCHER 与 LEANBACK_LAUNCHER，说明手机和电视都能用；
 * 而只在 intent-filter 里声明 LEANBACK_LAUNCHER 的才是电视专用。
 */
export function detectPlatform(manifest) {
  const m = manifest || {};
  const req = (m.requiredFeatures || []).map(x => String(x).toLowerCase());
  const cats = (m.categories || []).map(x => String(x));
  const hasReq = s => req.some(x => x.includes(s));
  const TV_CAT = 'android.intent.category.LEANBACK_LAUNCHER';
  const PHONE_CAT = 'android.intent.category.LAUNCHER';

  if (hasReq('leanback')) return { platform: 'Android TV', reason: 'manifest 把 leanback 标为必需' };
  if (cats.includes(TV_CAT) && cats.includes(PHONE_CAT)) {
    return { platform: 'Android / Android TV', reason: '同时声明了 LAUNCHER 与 LEANBACK_LAUNCHER，手机与电视都能用' };
  }
  if (cats.includes(TV_CAT)) return { platform: 'Android TV', reason: '只有 LEANBACK_LAUNCHER，没有普通 LAUNCHER，属电视专用' };
  if (hasReq('type.watch')) return { platform: 'Android Wear', reason: 'manifest 把手表类型标为必需' };
  if (hasReq('automotive')) return { platform: 'Android Automotive', reason: 'manifest 把车机类型标为必需' };
  if (hasReq('type.vr')) return { platform: 'Android VR', reason: 'manifest 把 VR 类型标为必需' };
  if (hasReq('type.embedded')) return { platform: 'Android Embedded', reason: 'manifest 把嵌入式类型标为必需' };
  return { platform: 'Android', reason: null };
}

/* ============ 三、签名检测 ============ */

/**
 * APK 装不装得上取决于签名，所以这个必须准：
 *   v1   → META-INF/ 下有 *.RSA / *.DSA / *.EC
 *   v2/3 → 中央目录紧邻之前有 "APK Sig Block 42" 魔数块
 *
 * 踩过的坑：v2 一开始是在文件末尾 128KB 里搜魔数。对 19.8MB 的 Meshtastic，
 * 中央目录本身就比这个窗口大，于是把 F-Droid 的官方签名包误判成「未检出签名」，
 * 进而让站点写下「装机可用性存疑」这种错误结论。
 * 正确做法是按 EOCD 里的中央目录偏移精确定位——签名块一定紧挨着它前面。
 */
export function detectSignature(zip) {
  const v1 = zip.list().some(e => /^META-INF\/.*\.(RSA|DSA|EC)$/i.test(e.name));
  let v2 = false;
  let at = null;
  try {
    if (zip.cdOffset != null && zip.cdOffset >= 24) {
      // 签名块的最后 16 字节就是魔数；连前面 8 字节的长度字段一起读进来做判断
      const tail = readAt(zip.fd, zip.cdOffset - 24, 24);
      v2 = tail.includes(Buffer.from('APK Sig Block 42'));
      if (v2) at = zip.cdOffset - 16;
    } else {
      const len = Math.min(131072, zip.size);
      v2 = readAt(zip.fd, zip.size - len, len).includes(Buffer.from('APK Sig Block 42'));
    }
  } catch { /* 读不到就不下结论 */ }
  const schemes = [];
  if (v1) schemes.push('v1');
  if (v2) schemes.push('v2/v3');
  return { signed: schemes.length ? true : false, schemes, ...(at != null ? { sigBlockAt: at } : {}) };
}

/* ============ 四、图标：优先 arsc，退路才是文件名 ============ */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function tryBitmapPath(zip, path, maxBytes = 6 * 1024 * 1024) {
  if (!path || !zip.has(path)) return null;
  const e = zip.info(path);
  if (!e || e.rawSize > maxBytes || e.rawSize < 200) return null;
  const buf = zip.read(path, maxBytes);
  const kind = sniffImage(buf);
  if (!kind) return null;
  return { buf, path, kind, ...(pngSize(buf) || {}) };
}

/**
 * 顺着资源引用取位图：
 *   引用 → 可能是图片，也可能是 xml（自适应图标 / 矢量图）
 *   xml 里再找 foreground（前景，通常就是应用图形）→ 继续解引用
 * 关键点：expandResource 会把同一资源在各密度下的取值都摊开并排序，
 * 某个候选解不出位图时能自动往下试，而不是直接判失败。
 */
function bitmapFromResId(zip, arsc, resId, depth = 0) {
  if (depth > 4 || resId == null) return null;
  for (const v of expandResource(arsc, resId)) {
    if (!v.path) continue;
    if (/\.9\.png$/i.test(v.path)) continue;              // 九宫格图不能当图标
    if (/\.(png|webp|jpg|jpeg)$/i.test(v.path)) {
      const got = tryBitmapPath(zip, v.path);
      if (got) return { ...got, via: 'arsc', refId: v.refId, density: v.densityName, resName: `${v.typeName}/${v.keyName}` };
    } else if (/\.xml$/i.test(v.path) && zip.has(v.path)) {
      const got = bitmapFromXml(zip, arsc, v.path, depth + 1);
      if (got) return got;
    }
  }
  return null;
}

function bitmapFromXml(zip, arsc, xmlPath, depth = 0) {
  if (depth > 4) return null;
  let xml;
  try { xml = xmlOf(zip.read(xmlPath, 2 * 1024 * 1024)); }
  catch { return null; }

  // 自适应图标：只认前景。刻意不认 background ——
  // background 常常是一张纯色/纹理方块，拿它当图标会显示成一块色块，
  // 比没有图标更糟。前景取不到就交给外层换别的候选（roundIcon、文件名、最大方形图）。
  for (const want of ['foreground', 'monochrome']) {
    for (const el of xml.elements) {
      if (el.name !== want) continue;
      const d = el.attrs && el.attrs.drawable;
      if (d && d.ref != null) {
        const got = bitmapFromResId(zip, arsc, d.ref, depth + 1);
        if (got) return { ...got, viaXml: xmlPath, layer: want };
      }
      if (d && d.str && zip.has(d.str)) {
        const got = tryBitmapPath(zip, d.str);
        if (got) return { ...got, viaXml: xmlPath, layer: want };
      }
    }
  }
  // 矢量图里也可能直接引用位图
  for (const el of xml.elements) {
    for (const [k, a] of Object.entries(el.attrs || {})) {
      if (a.ref != null && (k === 'drawable' || k === 'src')) {
        const got = bitmapFromResId(zip, arsc, a.ref, depth + 1);
        if (got) return { ...got, viaXml: xmlPath, layer: el.name };
      }
    }
  }
  return null;
}

/* ---- 文件名兜底：arsc 缺失（老包/异常包）时才用 ---- */
const DENSITY_SCORE = {
  xxxhdpi: 640, xxhdpi: 480, xhdpi: 320, hdpi: 240,
  mdpi: 160, ldpi: 120, anydpi: 60, nodpi: 50, tvdpi: 100,
};
const NAME_SCORE = [
  [/^ic_launcher_round/, 6], [/^ic_launcher_foreground/, 4], [/^ic_launcher/, 10],
  [/launcher/, 6], [/^app_?icon/, 8], [/^icon/, 5], [/^logo/, 4], [/ic_app/, 4],
];

function scoreIconEntry(e) {
  const m = e.name.match(/^res\/([a-z0-9-]+)\/(.+)\.(png|webp|jpg|jpeg)$/i);
  if (!m) return null;
  const [, dir, base, extRaw] = m;
  const ext = extRaw.toLowerCase();
  if (!/^(mipmap|drawable)/.test(dir)) return null;
  if (/background|monochrome|banner|splash|notification|widget|foreground/.test(base)) return null;
  if (/\.9$/.test(base)) return null;

  const dens = (dir.match(/(xxxhdpi|xxhdpi|xhdpi|hdpi|mdpi|ldpi|tvdpi|anydpi|nodpi)/) || [])[1] || 'mdpi';
  let s = (DENSITY_SCORE[dens] || 100) / 100;
  for (const [re, w] of NAME_SCORE) if (re.test(base)) { s += w; break; }
  if (ext === 'png') s += 2; else if (ext === 'webp') s += 0.5;
  if (e.rawSize < 400) s -= 8;
  if (e.rawSize > 3 * 1024 * 1024) s -= 6;
  return { score: s, base, dir, ext, density: dens };
}

export function iconByFilename(zip, { minSide = 48 } = {}) {
  const cands = [];
  for (const e of zip.list()) {
    if (e.isDir) continue;
    const info = scoreIconEntry(e);
    if (!info) continue;
    let dim = null;
    if (info.ext === 'png') {
      try { dim = pngSize(zip.readHead(e.name, 32)); } catch {}
      if (dim && (dim.w < minSide || dim.h < minSide)) continue;
    }
    cands.push({ e, info, dim, side: dim ? Math.max(dim.w, dim.h) : 0 });
  }
  cands.sort((a, b) => (b.side - a.side) || (b.info.score - a.info.score) || (b.e.rawSize - a.e.rawSize));
  for (const c of cands) {
    const got = tryBitmapPath(zip, c.e.name);
    if (got) return { ...got, via: 'filename', density: c.info.density };
  }
  return null;
}

/**
 * 兜底中的兜底：res 下最大的那张方形图（明确标注来源，便于人工复核）。
 *
 * 关键约束：**只看 res/ 下的图**。
 * 踩过的坑：Meshtastic 的图标被取成了 assets/composeResources/…/drawable/img_event_defcon.png
 * —— 那是 Compose Resources 里的一张「事件插图」，跟应用图标毫无关系。
 * assets/ 下放的是应用自己的任意素材（插图、示例图、字体预览……），
 * 只有 res/ 才是打包进来的 Android 资源，才可能包含启动图标。
 */
export function iconByLargestSquare(zip, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const cands = [];
  for (const e of zip.list()) {
    if (e.isDir || !/\.png$/i.test(e.name)) continue;
    if (!e.name.startsWith('res/')) continue;          // 只用 Android 资源目录
    if (e.rawSize < 3000 || e.rawSize > maxBytes) continue;
    try {
      const dim = pngSize(zip.readHead(e.name, 32));
      if (!dim || dim.w < 96 || dim.w !== dim.h) continue;
      // mipmap 目录优先（那里放的就是启动图标），其次才是 drawable
      const isMipmap = /^res\/mipmap/.test(e.name);
      cands.push({ e, dim, side: dim.w, isMipmap });
    } catch { /* 忽略读不了的 */ }
  }
  cands.sort((a, b) => (b.isMipmap - a.isMipmap) || (b.side - a.side) || (b.e.rawSize - a.e.rawSize));
  for (const c of cands) {
    const got = tryBitmapPath(zip, c.e.name);
    if (got) return { ...got, via: 'largest-square', density: null };
  }
  return null;
}

/* ============ 五、总入口 ============ */
export function inspectApk(file, { arscMaxBytes = 64 * 1024 * 1024 } = {}) {
  const zip = new Zip(file);
  try {
    const out = {
      ok: true,
      file,
      sizeBytes: zip.size,
      entryCount: zip.list().length,
      hasManifest: zip.has('AndroidManifest.xml'),
      hasDex: zip.list().some(e => /^classes\d*\.dex$/.test(e.name)),
      hasArsc: zip.has('resources.arsc'),
      manifest: null,
      signature: { signed: false, schemes: [] },
      icon: null,
      iconLargestSquare: null,
      iconCandidates: 0,
      label: null,
      platform: null,
      notes: [],
      errors: [],
    };

    if (!out.hasManifest) out.errors.push('缺少 AndroidManifest.xml，可能不是 APK');
    if (!out.hasDex) out.errors.push('缺少 classes*.dex，可能不是可安装的 APK');

    try { out.signature = detectSignature(zip); }
    catch (e) { out.errors.push('签名检测失败: ' + e.message); }

    if (out.hasManifest) {
      try { out.manifest = parseManifest(zip.read('AndroidManifest.xml', 4 * 1024 * 1024)); }
      catch (e) { out.errors.push('manifest 解析失败: ' + e.message); }
      const pl = detectPlatform(out.manifest);
      out.platform = pl.platform;
      out.platformReason = pl.reason;
      if (pl.platform !== 'Android') out.notes.push(`运行平台判定为「${pl.platform}」（${pl.reason}）`);
    }

    // 解 arsc：图标与真实名称都靠它
    let arsc = null;
    if (out.hasArsc) {
      try { arsc = parseArsc(zip.read('resources.arsc', arscMaxBytes)); }
      catch (e) { out.notes.push('arsc 解析失败（将退回按文件名找图标）: ' + e.message); }
    } else {
      out.notes.push('包里没有 resources.arsc');
    }

    const m = out.manifest;
    if (arsc && m) {
      if (m.iconRef) {
        out.icon = bitmapFromResId(zip, arsc, m.iconRef);
        if (out.icon) out.notes.push(`图标由 arsc 反查得到：${out.icon.resName || ''} → ${out.icon.path}（${out.icon.density || '未知密度'}）`);
      }
      if (!out.icon && m.roundIconRef) {
        out.icon = bitmapFromResId(zip, arsc, m.roundIconRef);
        if (out.icon) out.notes.push(`改用 roundIcon：${out.icon.path}`);
      }
      if (m.labelRef != null) {
        const lv = expandResource(arsc, m.labelRef).find(v => v.kind === 'string' && v.path);
        if (lv) out.label = lv.path;
      }
      if (!out.label && m.labelRef == null && m.label) out.label = m.label;
    } else if (m && m.label) {
      out.label = m.label;
    }

    // 退路一：按文件名找
    if (!out.icon) {
      out.icon = iconByFilename(zip);
      if (out.icon) out.notes.push(`arsc 未取到图标，退回按文件名命中：${out.icon.path}`);
    }
    // 退路二：res 下最大的方形图。
    // 刻意**不写进 out.icon**，而是单独放在 out.iconLargestSquare：
    // 这个来源不可靠（实测 Meshtastic 捞到了 res/drawable 里的通用头像素材，
    // 根本不是应用图标）。如果直接塞进 out.icon，调用方就会以为「APK 里取到图标了」，
    // 从而错过更可靠的「去源码仓库取官方图标」这一步。
    // 正确顺序是：arsc/文件名 → 仓库官方图标 → 才轮到它，且必须标注待人工确认。
    if (!out.icon) {
      out.iconLargestSquare = iconByLargestSquare(zip);
      if (out.iconLargestSquare) {
        out.notes.push(`⚠ APK 内没有可信的启动图标位图，备选是「res 下最大方形图」${out.iconLargestSquare.path}（来源不可靠，需人工确认）`);
      }
    }

    return out;
  } finally {
    zip.close();
  }
}

/** 把图标落盘，返回写入的文件名 */
export function saveIcon(icon, outDir, slug) {
  if (!icon || !icon.buf) return null;
  fs.mkdirSync(outDir, { recursive: true });
  const ext = icon.kind === 'jpg' ? 'jpg' : icon.kind;
  const file = `${slug}.${ext}`;
  fs.writeFileSync(`${outDir}/${file}`, icon.buf);
  return file;
}
