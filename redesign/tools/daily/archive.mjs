/* ============================================================
   便携版压缩包处理：zip / 7z / tar.gz 的"看一眼 + 解出来"
   ------------------------------------------------------------
   为什么需要它：桌面软件有相当一部分是 zip 便携版（Green/Portable）。
   原样丢进网盘，用户下载后面对的是一个看不出里面有什么的压缩包 ——
   而这恰好是第三方下载站塞捆绑软件的常见形态，用户也没法核对。
   所以我们解开它：拿到里面的可执行文件名，写进 README.txt 与审核表，
   让"这个 zip 里到底是哪个 exe"成为可核实的事实。

   自己实现 zip 读取而不是引依赖：本仓库的原则是零第三方依赖，
   而便携版 zip 用的压缩法几乎只有 store(0) 与 deflate(8) 两种，
   zlib.inflateRawSync 就能解开，不值得为此引入一个包。

   tar.gz 与 7z 只做"列内容"的尽量尝试，解包交给用户/系统工具：
   · tar.gz：结构简单，能列出条目，但**不动**（便携版里多为 linux 化布局）
   · 7z    ：有依赖才能可靠解开，这里只识别、不处理，README 里说明用系统工具打开
   ============================================================ */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

/** 便携版压缩包按扩展名分类 */
export function archiveKind(name) {
  const n = String(name).toLowerCase();
  if (n.endsWith('.zip')) return 'zip';
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz';
  if (n.endsWith('.7z')) return '7z';
  return null;
}

/* ---------- 最小 zip 中央目录读取 ---------- */
/**
 * 读 zip 的中央目录，返回条目列表。
 * 走中央目录而不是顺序扫本地头：能顺带拿到准确的未压缩大小，
 * 而且被打包的目录项（名字以 / 结尾）一眼就能滤掉。
 */
export function listZip(buf) {
  const entries = [];
  // 从尾部找 EOCD（End Of Central Directory）签名 0x06054b50
  let eocd = -1;
  const from = Math.max(0, buf.length - 66000);   // 注释最长 64KB
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const rawSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, rawSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 解出指定条目到内存。只支持 store(0) 与 deflate(8)。
 *
 * 本地头的 name/extra 长度可能与中央目录不同（打包器会改 extra 字段），
 * 所以必须重新读本地头来定位数据起点 —— 直接用中央目录的偏移量会读到垃圾。
 */
export function readZipEntry(buf, entry) {
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error(`本地头损坏：${entry.name}`);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.slice(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`不支持的压缩方式 ${entry.method}（${entry.name}）`);
}

/** 便携版里真正有用的东西：可执行文件与说明文件 */
const INTERESTING_RE = /\.(exe|msi|com|bat|cmd|sh|appimage|dmg|deb|rpm|txt|md|pdf|url|lnk)$/i;
const EXEC_RE = /\.(exe|msi|com|bat|cmd|sh|appimage)$/i;

/**
 * 解包便携版 zip。
 *
 * 安全闸门（都不是理论问题）：
 *   · zip-slip：条目名里带 ../ 或绝对路径时，解出来会写到目标目录之外
 *   · 解压炸弹：rawSize 合计远大于压缩包本身时说明有问题，先看总量再动手
 *   · 条目数上限：正常便携版几十到几千个文件；上万条多半不是应用
 *
 * @param {string} zipPath
 * @param {string} outDir  解包目标目录（会被创建）
 * @returns {{files:string[], main:string|null, bytes:number, note:string}}
 */
export function unzipPortable(zipPath, outDir) {
  const buf = fs.readFileSync(zipPath);
  const all = listZip(buf).filter(e => e.name && !e.name.endsWith('/') && !e.name.startsWith('__MACOSX/'));
  if (!all.length) throw new Error('压缩包里没有文件');
  if (all.length > 20000) throw new Error(`压缩包条目过多（${all.length}），拒绝解压`);
  const totalRaw = all.reduce((n, e) => n + (e.rawSize || 0), 0);
  if (totalRaw > 4 * 1024 * 1024 * 1024) throw new Error(`解压后体积过大（${(totalRaw / 1073741824).toFixed(1)}GB），拒绝解压`);

  fs.mkdirSync(outDir, { recursive: true });
  const root = path.resolve(outDir);
  const written = [];
  for (const e of all) {
    const dest = path.resolve(root, e.name);
    if (dest !== root && !dest.startsWith(root + path.sep)) throw new Error(`压缩包内含越界路径，已中止：${e.name}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readZipEntry(buf, e));
    written.push(e.name.replace(/\\/g, '/'));
  }

  // 主程序：优先根目录下的 exe/msi，其次任意一层里名字最"像主程序"的那个。
  // 便携版常见两种布局：App.exe 直接在根，或 App-1.2.3/App.exe 套一层目录。
  const execs = written.filter(n => EXEC_RE.test(n));
  const shallow = n => n.split('/').length;
  execs.sort((a, b) => (shallow(a) - shallow(b)) || (a.length - b.length));
  const main = execs[0] || null;

  const kb = Math.round(fs.statSync(zipPath).size / 1024);
  return {
    files: written,
    main,
    bytes: totalRaw,
    note: `已解包（原始压缩包 ${kb}KB，解得 ${written.length} 个文件${main ? `，主程序 ${main}` : ''}）`,
  };
}

/** tar.gz 只列条目，不解包（本频道的便携版以 zip 为主，tar.gz 多为 linux 布局） */
export function listTarGz(gzPath, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const buf = fs.readFileSync(gzPath);
  const tar = zlib.gunzipSync(buf, { maxOutputLength: maxBytes });
  const names = [];
  for (let off = 0; off + 512 <= tar.length;) {
    const name = tar.slice(off, off + 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break;
    const sizeStr = tar.slice(off + 124, off + 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    names.push(name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return { files: names, interesting: names.filter(n => INTERESTING_RE.test(n)).slice(0, 30) };
}

/* ============================================================
   PE 版本信息：从 exe 里读作者自己写的版本号
   ------------------------------------------------------------
   为什么值得单独读它：桌面软件没有 AndroidManifest 那种「官方身份证」，
   版本只能取 release tag —— 而 tag 是仓库作者随手起的（v1.2.3、2024.10、nightly），
   未必等于程序里写的版本。读 PE 的 VERSIONINFO 就多一条**独立于 tag 的**核实事实，
   和 Android 那边「APK 里的版本 vs F-Droid 索引版本」的交叉验证是同一个道理。

   只读，不改。解析全程做边界检查：exe 是外部文件，坏数据不能把流程带崩。
   ============================================================ */

/** 从 PE 里读 StringFileInfo 中的键值（FileVersion / ProductName / CompanyName…） */
export function readPeVersionInfo(file, { maxBytes = 64 * 1024 * 1024 } = {}) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (buf.length < 0x40 || buf.length > maxBytes) return null;
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) return null;                 // 'MZ'
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 24 > buf.length || buf.readUInt32LE(peOff) !== 0x00004550) return null;   // 'PE\0\0'
  const optOff = peOff + 24;
  const magic = buf.readUInt16LE(optOff);
  if (magic !== 0x10b && magic !== 0x20b) return null;                 // PE32 / PE32+
  const numSec = buf.readUInt16LE(peOff + 6);
  const secOff = optOff + buf.readUInt16LE(peOff + 20);
  const dirOff = optOff + (magic === 0x20b ? 112 : 96);

  const rvaToOff = rva => {
    for (let i = 0; i < numSec; i++) {
      const s = secOff + i * 40;
      if (s + 40 > buf.length) break;
      const vsize = buf.readUInt32LE(s + 8);
      const va = buf.readUInt32LE(s + 12);
      const raw = buf.readUInt32LE(s + 20);
      if (rva >= va && rva < va + Math.max(vsize, buf.readUInt32LE(s + 16))) return raw + (rva - va);
    }
    return null;
  };

  try {
    const resRva = buf.readUInt32LE(dirOff + 2 * 8);                   // 资源表是数据目录第 3 项
    const resSize = buf.readUInt32LE(dirOff + 2 * 8 + 4);
    if (!resRva || !resSize) return null;
    const resOff = rvaToOff(resRva);
    if (resOff == null || resOff + 16 > buf.length) return null;

    /* 资源树三级：类型 → 名字 → 语言。只要类型 16（RT_VERSION）那条。
       每层结构相同：头 16 字节 + 每项 8 字节，项的高位标记"指向下一层目录"。 */
    const children = rel => {
      const out = [];
      const named = buf.readUInt16LE(resOff + rel + 12);
      const ids = buf.readUInt16LE(resOff + rel + 14);
      let p = resOff + rel + 16;
      for (let i = 0; i < named + ids; i++) {
        if (p + 8 > buf.length) break;
        const id = buf.readUInt32LE(p);
        const off = buf.readUInt32LE(p + 4);
        out.push({ id: id & 0x7fffffff, isDir: !!(off & 0x80000000), rel: off & 0x7fffffff });
        p += 8;
      }
      return out;
    };
    const typeLevel = children(0).filter(e => e.isDir && e.id === 16);
    if (!typeLevel.length) return null;
    const nameLevel = children(typeLevel[0].rel).filter(e => e.isDir);
    if (!nameLevel.length) return null;
    const langLevel = children(nameLevel[0].rel);
    if (!langLevel.length) return null;

    const verRva = buf.readUInt32LE(resOff + langLevel[0].rel);        // 叶子：数据项的 RVA
    const verOff = rvaToOff(verRva);
    if (verOff == null) return null;

    /* VS_VERSIONINFO 里 StringFileInfo → StringTable → 一串键值对。
       不严格逐层走结构（各打包器写法有出入），直接扫 UTF-16 的「键\0值\0」形态，
       再用白名单挑 —— 坏数据最多是漏读，不会崩。 */
    const text = buf.slice(verOff, Math.min(buf.length, verOff + 8192)).toString('utf16le');
    const kv = {};
    const re = /(FileVersion|ProductVersion|ProductName|CompanyName|FileDescription|LegalCopyright|OriginalFilename)\0([^\0]{1,200})\0/g;
    let m;
    while ((m = re.exec(text))) {
      const v = m[2].trim();
      if (v && !kv[m[1]]) kv[m[1]] = v;
    }
    return Object.keys(kv).length ? kv : null;
  } catch {
    return null;
  }
}
