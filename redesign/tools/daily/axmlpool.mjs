/* ============================================================
   Android 二进制 XML 底座（零依赖）
   ------------------------------------------------------------
   两个上层模块都要用：
     apk.mjs  解析 AndroidManifest.xml（要包名/版本/图标引用）
     arsc.mjs 解析 resources.arsc 里的字符串池
   所以把「字符串池解析」和「元素/属性遍历」放在这里，避免各写一份。

   二进制 XML 的 block 序列：
     RES_XML 头 → RES_STRING_POOL → RES_XML_RESOURCE_MAP
     → START_NAMESPACE / START_ELEMENT / END_ELEMENT / CDATA …
   注意（踩过坑）：START_ELEMENT 的属性起始位置 =
     chunk起点 + headerSize(16) + attributeStart，
   写成 chunk起点 + 8 + attributeStart 会整体错位 8 字节，
   表现是「元素名读得出、属性全读不到」。
   ============================================================ */

export const RES_STRING_POOL_TYPE = 0x0001;
export const RES_XML_TYPE = 0x0003;
export const RES_XML_START_ELEMENT_TYPE = 0x0102;

const UTF8_FLAG = 1 << 8;

/** 读字符串池，返回 { strings, chunkSize }；偏移非法时返回 null */
export function parseStringPoolRaw(buf, offset) {
  if (offset < 0 || offset + 28 > buf.length) return null;
  if (buf.readUInt16LE(offset) !== RES_STRING_POOL_TYPE) return null;
  const headerSize = buf.readUInt16LE(offset + 2);
  const chunkSize = buf.readUInt32LE(offset + 4);
  const stringCount = buf.readUInt32LE(offset + 8);
  const flags = buf.readUInt32LE(offset + 16);
  const stringsStart = buf.readUInt32LE(offset + 20);
  const isUtf8 = (flags & UTF8_FLAG) !== 0;

  const strings = new Array(stringCount);
  const base = offset + stringsStart;
  for (let i = 0; i < stringCount; i++) {
    const offPos = offset + headerSize + i * 4;
    if (offPos + 4 > buf.length) { strings[i] = ''; continue; }
    const so = base + buf.readUInt32LE(offPos);
    try {
      if (isUtf8) {
        // 两级长度前缀：UTF-16 字符数、UTF-8 字节数，各 1 或 2 字节（高位为续标志）
        let q = so;
        let n = buf[q++];
        if (n & 0x80) n = ((n & 0x7f) << 8) | buf[q++];
        let m = buf[q++];
        if (m & 0x80) m = ((m & 0x7f) << 8) | buf[q++];
        strings[i] = buf.subarray(q, q + m).toString('utf8');
      } else {
        let q = so;
        let n = buf.readUInt16LE(q); q += 2;
        if (n & 0x8000) { n = ((n & 0x7fff) << 16) | buf.readUInt16LE(q); q += 2; }
        strings[i] = buf.subarray(q, q + n * 2).toString('utf16le');
      }
    } catch { strings[i] = ''; }
  }
  return { strings, chunkSize, isUtf8 };
}

export const DATA_TYPE = {
  0x00: 'null', 0x01: 'reference', 0x02: 'attribute', 0x03: 'string',
  0x04: 'float', 0x05: 'dimension', 0x06: 'fraction',
  0x10: 'int_dec', 0x11: 'int_hex', 0x12: 'int_boolean',
  0x1c: 'int_color_argb8', 0x1d: 'int_color_rgb8', 0x1e: 'int_color_argb4', 0x1f: 'int_color_rgb4',
};

/**
 * 遍历二进制 XML，返回全部 START_ELEMENT 及其属性。
 * 每个属性给三份视图：
 *   str  文本值（dataType=string 时）
 *   ref  资源 ID（dataType=reference 时）—— 解析图标靠它
 *   int  整数值（int/boolean 时）
 */
export function parseBinaryXml(buf) {
  if (!buf || buf.length < 8) throw new Error('XML 太短');
  const type = buf.readUInt16LE(0);
  if (type !== RES_XML_TYPE && type !== 0x0002) {
    const head = buf.subarray(0, 256).toString('utf8').trimStart();
    if (head.startsWith('<')) throw new Error('这是文本 XML，不是二进制 XML');
    throw new Error(`不是二进制 XML（type=0x${type.toString(16)}）`);
  }

  let offset = buf.readUInt16LE(2);
  let pool = null;
  const elements = [];

  while (offset + 8 <= buf.length) {
    const ctype = buf.readUInt16LE(offset);
    const headerSize = buf.readUInt16LE(offset + 2);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkSize <= 0) break;

    if (ctype === RES_STRING_POOL_TYPE) {
      pool = parseStringPoolRaw(buf, offset);
    } else if (ctype === RES_XML_START_ELEMENT_TYPE && pool) {
      const nameIdx = buf.readUInt32LE(offset + 20);
      const attrStart = buf.readUInt16LE(offset + 24);
      const attrSize = buf.readUInt16LE(offset + 26);
      const attrCount = buf.readUInt16LE(offset + 28);
      const name = pool.strings[nameIdx] || '';

      const attrs = {};
      const aBase = offset + (headerSize || 16) + attrStart;
      for (let i = 0; i < attrCount; i++) {
        const ap = aBase + i * (attrSize || 20);
        if (ap + 20 > buf.length) break;
        const aName = pool.strings[buf.readUInt32LE(ap + 4)] || '';
        const rawIdx = buf.readUInt32LE(ap + 8);
        const dt = buf.readUInt8(ap + 15);
        const data = buf.readUInt32LE(ap + 16);
        if (!aName) continue;

        const a = { dataType: dt, kind: DATA_TYPE[dt] || `0x${dt.toString(16)}`, data, str: null, ref: null, int: null };
        if (dt === 0x03) {
          a.str = (rawIdx !== 0xffffffff ? pool.strings[rawIdx] : pool.strings[data]) ?? null;
        } else if (dt === 0x01) {
          a.ref = data >>> 0;
        } else if (dt === 0x10 || dt === 0x11 || dt === 0x12) {
          a.int = data;
        } else if (rawIdx !== 0xffffffff) {
          a.str = pool.strings[rawIdx] ?? null;
        }
        attrs[aName] = a;
      }
      elements.push({ name, attrs, line: buf.readUInt32LE(offset + 8) });
    }
    offset += chunkSize;
  }
  return { elements, strings: pool ? pool.strings : [] };
}

/** 文本 XML 兜底（极少见，但代价很低） */
export function parsePlainXmlElements(text) {
  const elements = [];
  const re = /<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*\/?>/g;
  let m;
  while ((m = re.exec(text))) {
    const attrs = {};
    const ar = /([\w.:-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = ar.exec(m[2]))) {
      const key = a[1].includes(':') ? a[1].split(':').pop() : a[1];
      attrs[key] = { dataType: 0x03, kind: 'string', data: 0, str: a[2], ref: null, int: null };
    }
    elements.push({ name: m[1], attrs, line: 0 });
  }
  return { elements, strings: [] };
}
