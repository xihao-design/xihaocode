/* ============================================================
   公共工具：日志 / 日期 / 文件 / 哈希 / slug
   ------------------------------------------------------------
   零第三方依赖，只用 Node 内置模块 —— 与站点工程保持一致。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';

/* ---------- 日志：同时写控制台和日志文件 ---------- */
let LOG_STREAM = null;
let LOG_PLAIN = false;

export function openLog(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  LOG_STREAM = fs.createWriteStream(file, { flags: 'a' });
  return file;
}
export function setPlainLog(v) { LOG_PLAIN = !!v; }

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export function log(msg = '') {
  const line = `[${stamp()}] ${msg}`;
  if (!LOG_PLAIN) console.log(line);
  if (LOG_STREAM) LOG_STREAM.write(line + '\n');
}
export function logRaw(msg = '') {
  process.stdout.write(msg + '\n');
  if (LOG_STREAM) LOG_STREAM.write(msg + '\n');
}
export function warn(msg) { log('⚠ ' + msg); }
export function fail(msg) { log('✗ ' + msg); }
export function ok(msg) { log('✓ ' + msg); }
export function closeLog() {
  return new Promise(r => { if (!LOG_STREAM) return r(); LOG_STREAM.end(r); });
}

/* ---------- 时间 ---------- */
export const pad = n => String(n).padStart(2, '0');
/** 本地日期 YYYY-MM-DD（不用 toISOString，避免时区把日期算早一天） */
export function today(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function daysAgoISO(n) {
  const d = new Date(Date.now() - n * 86400000);
  return today(d);
}
/** 年内第几天，用来轮换搜索切片 */
export function dayIndex(d = new Date()) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 86400000);
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 字符串 ---------- */
export const slugify = s => String(s).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const humanSize = b => b >= 1048576
  ? (b / 1048576).toFixed(1) + ' MB'
  : (b / 1024).toFixed(1) + ' KB';
export const escapeMd = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/* ---------- 文件 ---------- */
export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

export function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
export function writeJSON(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export async function sha256File(file) {
  const h = crypto.createHash('sha256');
  const rs = fs.createReadStream(file);
  rs.on('data', c => h.update(c));
  await once(rs, 'end');
  return h.digest('hex');
}

/** 魔数嗅探图片类型：避免把 HTML 错误页当图标存下来 */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  const head = buf.slice(0, 2048).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
}

export function isZip(buf) {
  return buf && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b
    && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

/** 名字与已有条目的相似度粗判，用来挡掉重复收录 */
export function nameKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}
