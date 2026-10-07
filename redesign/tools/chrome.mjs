/* ============================================================
   无头浏览器封装：给「生成 OG 图」和「视觉核对截图」共用。
   ------------------------------------------------------------
   为什么用无头浏览器而不是图片库：截图必须是**浏览器真实渲染的结果**，
   否则核对的就是一段想象。零第三方依赖，只用系统里已有的 Chrome / Edge。

   注意：spawn 一律 stdio:'ignore' —— 在受限沙箱下，管道式 stdio 会 EPERM，
   而这里的目的是让浏览器落盘一张图，不需要读它的输出。
   ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 独立的临时配置目录：不指定的话无头浏览器会去抢你正在用的那个 Chrome 配置目录，
    轻则启动变慢，重则直接卡住（踩过：整轮截图跑不完）。 */
const PROFILE = path.join(os.tmpdir(), `dsh-chrome-${process.pid}`);

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft/Edge/Application/msedge.exe') : null,
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export function findBrowser() {
  for (const p of CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* 忽略 */ }
  }
  return null;
}

export function fileUrl(p) {
  return 'file:///' + path.resolve(p).replace(/\\/g, '/').replace(/^\//, '');
}

/** 截一张图。返回 true 表示文件确实生成了。 */
export function shoot(browser, url, out, { w = 1440, h = 1000, scale = 1, wait = 0 } = {}) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--disable-sync',
    '--disable-component-update',
    `--user-data-dir=${PROFILE}`,
    `--force-device-scale-factor=${scale}`,
    `--window-size=${w},${h}`,
    `--virtual-time-budget=${1200 + wait}`,
    `--screenshot=${out}`,
    url,
  ];
  try { fs.rmSync(out, { force: true }); } catch (e) { /* 忽略 */ }
  spawnSync(browser, args, { stdio: 'ignore', timeout: 90000 });
  return fs.existsSync(out);
}

/** 读 PNG 的 IHDR 拿宽高，用来确认截图真的是我要的尺寸 */
export function pngSize(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length < 24 || b.toString('ascii', 1, 4) !== 'PNG') return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
  } catch (e) { return null; }
}

/** 加载页面、执行脚本、取回渲染后的 DOM（冒烟测试用）
    windowSize：不传时 Chrome 用默认窗口宽（约 764px，**不是**桌面宽度）。
    要量桌面布局就必须显式传，否则量到的是窄屏下的结果 —— 实测踩过：
    「检查顶栏与内容区左右留白是否相等」在 764px 下跑，
    少了滚动条与桌面断点的影响，结论看着对、其实没验到桌面。 */
export function dumpDom(browser, url, { timeout = 60000, w = 1440, h = 1000 } = {}) {
  const args = [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--no-first-run', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-breakpad',
    `--window-size=${w},${h}`,
    `--user-data-dir=${PROFILE}`,
    '--virtual-time-budget=1500',
    '--dump-dom', url,
  ];
  const r = spawnSync(browser, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    timeout, maxBuffer: 64 * 1024 * 1024,
  });
  return r.stdout || '';
}

/** 带重试的 dumpDom。
    为什么需要：连续 dump 几十个页面时，偶发会有一两次完全拿不到输出
    （临时 profile 清理有延迟，下一次启动撞上就空手而归）。
    实测同一页孤立跑必成功、连跑必挂一张，且每次挂的不是同一页 ——
    是环境抖动，不是页面坏了。不重试的话守门脚本会随机报假失败，
    最后必然被无视，等于没有守门。 */
export function dumpDomRetry(browser, url, opts = {}) {
  for (let i = 0; i < 2; i++) {
    const dom = dumpDom(browser, url, opts);
    if (dom && dom.length > 500) return dom;
    cleanupProfile();
    // spawnSync 是同步的，这里只能忙等一小会儿让上一轮进程收尾
    const until = Date.now() + 600;
    while (Date.now() < until) { /* 同步等待，避免引入 async 传染整个调用链 */ }
  }
  return '';
}

/** 用完清掉临时配置目录，别在系统临时区留垃圾 */
export function cleanupProfile() {
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}
