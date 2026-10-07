/* ============================================================
   百度网盘环节：BaiduPCS-Go 封装
   ------------------------------------------------------------
   能力与边界（先说清楚，免得你被"全自动"误导）：
     能做到：自动上传目录、自动创建分享链接、自动拿回分享链接与提取码
     做不到：替你登录。BDUSS/STOKEN 等同于你的账号密码，
             必须你本人在自己电脑上执行一次 login，脚本不碰这步。

   为什么用「文件重定向」而不是管道抓输出：
   沙箱环境下 Node 的管道 stdio 会被拒（EPERM），
   所以 spawnSync 的 stdout/stderr 一律重定向到临时文件再读回来。

   为什么开关要运行时探测：
   `share set` 支持哪些参数没有权威文档（README 只写了基本用法），
   硬编码一个不存在的 -p 会让整步分享失败。
   所以先跑一次 `share set -h`，只传它真有的开关。
   ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log, warn, fail, ok } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_NAMES = ['BaiduPCS-Go.exe', 'BaiduPCS-Go'];

export function findBinary(cfg = {}) {
  const cands = [];
  if (cfg.binPath) cands.push(cfg.binPath);
  for (const n of BIN_NAMES) cands.push(path.join(__dirname, 'bin', n));
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch {} }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of BIN_NAMES) {
      const p = path.join(dir, n);
      try { if (fs.existsSync(p)) return p; } catch {}
    }
  }
  return null;
}

export function netdiskAvailable(cfg = {}) {
  const bin = findBinary(cfg);
  if (!bin) {
    return {
      ok: false,
      binPath: null,
      why: '没找到 BaiduPCS-Go。下载一个 exe 放到 redesign/tools/daily/bin/BaiduPCS-Go.exe，'
         + '或在 config.json 的 netdisk.binPath 里写绝对路径。',
    };
  }
  return { ok: true, binPath: bin, why: null };
}

/** 跑一条 BaiduPCS-Go 命令；输出走临时文件，避开沙箱对管道 stdio 的限制 */
export function run(bin, args, { timeoutMs = 900000, quiet = false } = {}) {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const outF = path.join(os.tmpdir(), `bpcs-${stamp}.out`);
  const errF = path.join(os.tmpdir(), `bpcs-${stamp}.err`);
  let fdOut, fdErr;
  try {
    fdOut = fs.openSync(outF, 'w');
    fdErr = fs.openSync(errF, 'w');
    const r = spawnSync(bin, args, {
      stdio: ['ignore', fdOut, fdErr],
      timeout: timeoutMs,
      windowsHide: true,
    });
    const stdout = fs.existsSync(outF) ? fs.readFileSync(outF, 'utf8') : '';
    const stderr = fs.existsSync(errF) ? fs.readFileSync(errF, 'utf8') : '';
    const res = {
      code: r.status,
      stdout,
      stderr,
      timedOut: r.error && r.error.code === 'ETIMEDOUT',
      error: r.error ? String(r.error.message || r.error) : null,
      signal: r.signal || null,
    };
    if (!quiet) {
      log(`    $ ${path.basename(bin)} ${args.join(' ')}  → 退出码 ${res.code}${res.timedOut ? '（超时）' : ''}`);
      const tail = (s, n = 12) => s.split(/\r?\n/).filter(Boolean).slice(-n).join('\n      ');
      if (res.stdout.trim()) log('      ' + tail(res.stdout));
      if (res.stderr.trim()) log('      [stderr] ' + tail(res.stderr));
    }
    return res;
  } finally {
    try { if (fdOut) fs.closeSync(fdOut); } catch {}
    try { if (fdErr) fs.closeSync(fdErr); } catch {}
    try { fs.rmSync(outF, { force: true }); } catch {}
    try { fs.rmSync(errF, { force: true }); } catch {}
  }
}

function combined(r) { return `${r.stdout}\n${r.stderr}`; }

/**
 * 登录状态检测。
 *
 * 这里踩过一个假阳性：早先用 `loglist` 的输出里是否出现 "uid/用户名" 等字样来判断，
 * 结果**空表的表头**（`# UID 用户名 性别 AGE`）也会命中，于是未登录被误判成已登录。
 * 现在改用 `who` 的 uid 字段，这是唯一不会骗人的信号。
 * 本机实测的三种输出：
 *   未登录：当前帐号 uid: 0, 用户名: , 性别: , 年龄: 0.0
 *   已登录：当前帐号 uid: 123456, 用户名: someone, 性别: , 年龄: 0.0
 *   quota 兜底: 错误 31045「可能百度帐号登录状态过期」= 未登录
 */
export function checkLogin(bin) {
  const r = run(bin, ['who'], { timeoutMs: 60000, quiet: true });
  const all = combined(r);
  const uidM = all.match(/uid\s*[:：]\s*(\d+)/i);
  const nameM = all.match(/用户名\s*[:：]\s*([^,\r\n]*)/);
  const uid = uidM ? Number(uidM[1]) : null;
  const username = nameM ? nameM[1].trim() : '';

  if (uid != null) {
    const loggedIn = uid > 0 && username.length > 0;
    return { status: loggedIn ? 'yes' : 'no', uid, username, detail: all.trim() };
  }

  // who 解析不出结果时才退到 quota（会走网络）
  const q = run(bin, ['quota'], { timeoutMs: 60000, quiet: true });
  const qa = combined(q);
  if (/31045|请尝试重新登录|user not exists|未登录|not logged/i.test(qa)) {
    return { status: 'no', uid: null, username: '', detail: qa.trim() };
  }
  if (/总空间|已用空间|空间配额|quota/i.test(qa)) {
    return { status: 'yes', uid: null, username: '', detail: qa.trim() };
  }
  return { status: 'unknown', uid: null, username: '', detail: (all + '\n' + qa).trim().slice(0, 400) };
}

/** 运行时探测子命令支持哪些开关，避免传了不存在的参数 */
export function discoverFlags(bin, subcommand) {
  const r = run(bin, [...subcommand.split(' '), '-h'], { timeoutMs: 30000, quiet: true });
  const all = combined(r);
  const flags = new Set();
  for (const m of all.matchAll(/(?:^|\s)(-[a-zA-Z][\w-]*)/g)) flags.add(m[1]);
  for (const m of all.matchAll(/(--[a-zA-Z][\w-]*)/g)) flags.add(m[1]);
  return flags;
}

function parseShareOutput(text) {
  const link = text.match(/(https?:\/\/pan\.baidu\.com\/s\/[A-Za-z0-9_\-]+)/);
  // 两种格式都兼容：
  //   不带 -f：shareID: 1, 链接: https://pan.baidu.com/s/xxx, 密码: abcd
  //   带   -f：shareID: 1, 链接: https://pan.baidu.com/s/xxx?pwd=abcd
  const pwd = text.match(/(?:pwd=|密码[:：]\s*|提取码[:：]\s*)([A-Za-z0-9]{4})/);
  const shareId = text.match(/shareID[:：]\s*(\d+)/);
  return {
    shareUrl: link ? link[1] : null,
    pwd: pwd ? pwd[1] : null,
    shareId: shareId ? shareId[1] : null,
  };
}

/**
 * 上传当天全部 App 并逐个建分享链接。
 * 每个 App 独立 try/catch：一个失败不影响其它，失败项落进 errors 由人工补。
 */
export async function uploadBundle(apps, { dayDir, date, cfg, available }) {
  const report = {
    attempted: false, binPath: available && available.binPath || null,
    uploaded: 0, shared: 0, pending: [], errors: [], logins: null,
    remoteRoot: cfg.remoteRoot, remoteDateDir: null,
  };
  if (!apps.length) { report.errors.push('没有待上传的条目'); return report; }

  const avail = available || netdiskAvailable(cfg);
  if (!avail.ok) {
    report.errors.push(avail.why);
    report.pending = apps.map(a => a.slug);
    return report;
  }
  report.binPath = avail.binPath;

  const login = checkLogin(avail.binPath);
  report.logins = login.status;
  report.loginUid = login.uid ?? null;
  report.loginUsername = login.username || null;
  log(`  BaiduPCS-Go: ${avail.binPath}`);
  log(`  登录状态: ${login.status === 'yes' ? `已登录（uid ${login.uid}，${login.username}）` : login.status === 'no' ? '未登录' : '无法判定（继续尝试）'}`);
  if (login.status === 'no') {
    report.errors.push(
      'BaiduPCS-Go 尚未登录 —— 这步必须你亲自做一次（脚本不能也不需要碰你的账号密码）：\n'
      + '      方式一（上游推荐，最省事）：浏览器登录 pan.baidu.com，按 F12 → Application → Cookies，\n'
      + `        复制完整 Cookies 后执行： "${avail.binPath}" login --cookies="BDUSS=xxx; STOKEN=xxx; ..."\n`
      + '      方式二：只取 BDUSS 与 STOKEN（STOKEN 必须从网盘页面取，普通站点的那份无效）\n'
      + `        "${avail.binPath}" login --bduss=<BDUSS> --stoken=<STOKEN>\n`
      + `      然后执行 "${avail.binPath}" who 确认 uid 大于 0 即可。\n`
      + '      完成后再跑一次采集，或先手动上传后运行 upload.ps1 建分享链接',
    );
    report.pending = apps.map(a => a.slug);
    return report;
  }

  report.attempted = true;
  const remoteDateDir = `${cfg.remoteRoot.replace(/\/+$/, '')}/${date}`;
  report.remoteDateDir = remoteDateDir;

  // 目录先建好：BaiduPCS-Go 不会自动补父目录
  run(avail.binPath, ['mkdir', cfg.remoteRoot.replace(/\/+$/, '')], { timeoutMs: 60000 });
  run(avail.binPath, ['mkdir', remoteDateDir], { timeoutMs: 60000 });

  const shareFlags = discoverFlags(avail.binPath, 'share set');
  log(`  share set 支持的开关：${[...shareFlags].join(' ') || '（无）'}`);

  for (const app of apps) {
    const localDir = path.join(dayDir, 'upload', app.slug);
    const remotePath = `${remoteDateDir}/${app.slug}`;
    app.netdisk.remotePath = remotePath;
    try {
      if (!fs.existsSync(localDir)) throw new Error(`本地目录不存在：${localDir}`);

      const up = run(avail.binPath, ['upload', localDir, remoteDateDir, '--policy', cfg.uploadPolicy || 'skip'],
        { timeoutMs: 1800000 });
      const upAll = combined(up);
      if (up.code !== 0 || /失败|error/i.test(upAll)) {
        throw new Error(`上传退出码 ${up.code}${up.timedOut ? '（超时）' : ''}：${upAll.trim().split(/\r?\n/).slice(-3).join(' | ')}`);
      }

      // 上传后核对：目录里真的能看到那个 APK 才算数
      const ls = run(avail.binPath, ['ls', remotePath], { timeoutMs: 120000, quiet: true });
      const lsAll = combined(ls);
      const apkName = app.apk ? path.basename(app.apk.file) : null;
      if (apkName && !lsAll.includes(apkName)) {
        throw new Error(`上传后目录里没看到 ${apkName}，视为上传失败（可到网盘网页版确认）`);
      }
      report.uploaded++;
      log(`  ✓ 已上传 ${app.slug} → ${remotePath}`);

      // 建分享链接。
      // 开关名以本机实测的 `share set -h` 为准：
      //   -p value        提取码
      //   --period value  有效天数, 0 为永久 (default: 0)
      //   -f              输出带密码的完整链接格式
      // 早前按 -e 传有效天数 —— 那个开关根本不存在，等于静默失效（已修正）。
      // 刻意不加 -f：站点把 link 与 pwd 分开存储展示，非合并格式更合用。
      const args = ['share', 'set', remotePath];
      if (cfg.sharePwd && shareFlags.has('-p')) args.push('-p', String(cfg.sharePwd));
      if (cfg.shareExpireDays && shareFlags.has('--period')) args.push('--period', String(cfg.shareExpireDays));
      const sh = run(avail.binPath, args, { timeoutMs: 180000 });
      const parsed = parseShareOutput(combined(sh));
      if (!parsed.shareUrl) {
        throw new Error(`分享命令没返回链接：${combined(sh).trim().split(/\r?\n/).slice(-3).join(' | ')}`);
      }
      app.netdisk.shareUrl = parsed.shareUrl;
      app.netdisk.pwd = parsed.pwd;
      app.netdisk.shareId = parsed.shareId;
      app.netdisk.uploadedAt = new Date().toISOString();
      report.shared++;
      log(`  ✓ 分享已建 ${app.slug}：${parsed.shareUrl}${parsed.pwd ? ' 提取码 ' + parsed.pwd : '（无提取码）'}`);
    } catch (e) {
      report.pending.push(app.slug);
      report.errors.push(`${app.slug}：${e.message}`);
      fail(`  ✗ ${app.slug}：${e.message}`);
    }
  }
  return report;
}

/**
 * 无论自动上传成没成，都生成一份可以直接右键运行的手动脚本。
 * 自动化了也要留后路：百度接口随时可能变，脚本挂了你还得能干活。
 */
export function manualUploadScript(apps, { dayDir, date, cfg }) {
  if (!apps.length) return null;
  const bin = findBinary(cfg) || 'BaiduPCS-Go.exe';
  const remoteDateDir = `${String(cfg.remoteRoot).replace(/\/+$/, '')}/${date}`;
  const lines = [
    '# ============================================================',
    `# 手动补传脚本 —— ${date}`,
    '# 右键「使用 PowerShell 运行」。自动上传失败时用这个兜底。',
    '# 前提：BaiduPCS-Go 已登录（它把凭据存在本机配置里，脚本不碰密码）。',
    '# ============================================================',
    '$ErrorActionPreference = "Continue"',
    `$bin = "${bin}"`,
    `$remoteDate = "${remoteDateDir}"`,
    '',
    'Write-Host "建立网盘目录 $remoteDate" -ForegroundColor Cyan',
    `& $bin mkdir "${String(cfg.remoteRoot).replace(/\/+$/, '')}"`,
    '& $bin mkdir $remoteDate',
    '',
  ];
  for (const a of apps) {
    const localDir = path.join(dayDir, 'upload', a.slug);
    const remotePath = `${remoteDateDir}/${a.slug}`;
    lines.push(
      `Write-Host ""`,
      `Write-Host "── ${a.name} (${a.package || '包名未知'}) ──" -ForegroundColor Cyan`,
      `& $bin upload "${localDir}" $remoteDate --policy skip`,
      `& $bin ls "${remotePath}"`,
      `Write-Host "建立分享链接（输出里的 链接/密码 填回 bundle.json 的 netdisk 字段）" -ForegroundColor Yellow`,
      `& $bin share set "${remotePath}"`,
      '',
    );
  }
  lines.push(
    'Write-Host ""',
    'Write-Host "完成后把每个 App 的分享链接与提取码填进 bundle.json：" -ForegroundColor Green',
    'Write-Host "  _daily\\' + date + '\\bundle.json  →  apps[].netdisk.shareUrl / pwd"',
    'Write-Host "再执行：node redesign\\tools\\daily\\merge.mjs --date=' + date + '"',
    '',
    'Read-Host "按回车关闭"',
  );
  const file = path.join(dayDir, 'upload.ps1');
  // 必须带 UTF-8 BOM：Windows PowerShell 5.1 读无 BOM 的 UTF-8 脚本时按 ANSI 解码，
  // 中文会被解成乱码导致语法错误（install-task.ps1 踩过这个坑，报错位置完全对不上）。
  // 行尾也必须用 CRLF。
  fs.writeFileSync(file, '\uFEFF' + lines.join('\r\n'), 'utf8');
  return file;
}
