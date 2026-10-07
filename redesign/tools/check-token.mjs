#!/usr/bin/env node
/* ============================================================
   GitHub Token 体检
   ------------------------------------------------------------
   为什么需要单独一个命令：「配了没生效」是这里最容易发生的事——
   文件路径写错、记事本加了 BOM、Token 过期、配额其实还是 60。
   这些都不会报错，只会让采集悄悄变慢、中途配额耗尽。
   所以这里不猜，直接拿 Token 打一次 GitHub，把配额和权限读回来看。

   用法：npm run token
   安全：只打印 Token 的前几位掩码，完整内容永不输出。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.resolve(__dirname, 'daily', 'state', 'github-token.txt');
const REL = path.relative(path.resolve(__dirname, '..', '..'), TOKEN_FILE);

/* 与 tools/daily/channels.mjs 的 loadToken() 保持同样的优先级：环境变量 → 文件。
   这里刻意复制这段小逻辑而不是导出 Token：导出会让「把密钥当普通变量用」变得顺手。 */
function load() {
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, from: '环境变量 GITHUB_TOKEN' };
  if (process.env.GH_TOKEN) return { token: process.env.GH_TOKEN, from: '环境变量 GH_TOKEN' };
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
    const bom = raw.charCodeAt(0) === 0xfeff;
    const nl = /[\r\n]/.test(raw);
    const t = raw.trim();
    if (t) return { token: t, from: `文件 ${REL}`, raw, bom, nl };
    // 文件在但是空的：这是真实存在的情况（占位文件），必须说清楚，
    // 否则「文件存在」会让人以为已经配好了
    return { token: '', from: null, empty: true };
  } catch (e) {
    return { token: '', from: null, err: e.code };
  }
}

const mask = t => (t.length <= 8 ? '****' : `${t.slice(0, 7)}…${t.slice(-4)}（共 ${t.length} 位）`);

const limitOf = async token => {
  const res = await fetch('https://api.github.com/rate_limit', {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'xihaoz-token-check',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  return {
    status: res.status,
    core: res.headers.get('x-ratelimit-limit'),
    remaining: res.headers.get('x-ratelimit-remaining'),
    reset: res.headers.get('x-ratelimit-reset'),
    scopes: res.headers.get('x-oauth-scopes'),
    body: res.status === 200 ? await res.json().catch(() => null) : null,
  };
};

console.log('GitHub Token 体检\n');

// 1) 当前状态（不带头）
const anon = await limitOf('');
console.log(`  未认证配额：核心 API ${anon.core} 次/小时`);

// 2) 找到了什么
const found = load();
if (!found.token) {
  const why = found.empty
    ? `${REL} 存在，但内容是空的（占位文件）`
    : found.err === 'ENOENT' ? `${REL} 不存在` : '没有配置 Token';
  console.log(`\n  结果：${why}`);
  console.log(`
  实际影响：核心 API 60 次/小时 —— 扫一个仓库的目录树就是 1 次请求，
  按目录收技能（拿 SKILL.md）这条路线在未认证下跑不动。

  配置方式（二选一）：
    A) 写文件（推荐，计划任务更稳）
       在 GitHub → Settings → Developer settings 生成 token，然后：
       [IO.File]::WriteAllText('${TOKEN_FILE}', '你的token', [Text.UTF8Encoding]::new($false))
       注意别用记事本（可能写进 BOM）。

    B) 环境变量
       [Environment]::SetEnvironmentVariable('GITHUB_TOKEN','你的token','User')

  然后重跑：npm run token
  （Token 不要贴到任何聊天窗口里，包括贴给我；直接写进文件即可。）`);
  process.exit(1);
}

console.log(`  Token 来源：${found.from}`);
console.log(`  Token 掩码：${mask(found.token)}`);
if (found.bom) console.log('  注意：文件带 BOM —— 代码里的 trim() 能吃掉它，但建议按 README 的方式重写一遍。');
if (found.nl) console.log('  提示：文件含换行（无害，读取时会 trim）。');

// 3) 形状检查：三种常见形态
const shape =
  /^ghp_[A-Za-z0-9]{20,}$/.test(found.token) ? '经典 PAT（ghp_）' :
  /^github_pat_[A-Za-z0-9_]{20,}$/.test(found.token) ? 'fine-grained PAT（github_pat_）' :
  /^[0-9a-f]{40}$/i.test(found.token) ? '旧式 40 位 token' :
  '形态不常见';
console.log(`  Token 形态：${shape}`);
if (shape === '形态不常见') {
  console.log('  警告：不像 GitHub PAT 的常见格式，可能复制时多了引号或空格。');
}

// 4) 真打一次
let authed;
try {
  authed = await limitOf(found.token);
} catch (e) {
  console.log(`\n  失败：请求 GitHub 出错（${e.message}）。检查网络后重试。`);
  process.exit(1);
}

if (authed.status === 401) {
  console.log(`\n  失败：HTTP 401 —— Token 无效或已过期/被撤销。`);
  console.log('  去 GitHub → Settings → Developer settings 重新生成一个，再跑一次 npm run token。');
  process.exit(1);
}
if (authed.status !== 200) {
  console.log(`\n  失败：HTTP ${authed.status}，不是预期的 200。`);
  process.exit(1);
}

const core = authed.body?.resources?.core;
console.log(`\n  认证后配额：核心 API ${authed.core} 次/小时（剩余 ${authed.remaining}）`);
if (core) {
  const resetIn = Math.max(0, Math.round((core.reset * 1000 - Date.now()) / 60000));
  console.log(`  Search API：${authed.body.resources.search.limit} 次/分钟（剩余 ${authed.body.resources.search.remaining}）`);
  console.log(`  配额重置于约 ${resetIn} 分钟后`);
}
console.log(`  授权范围：${authed.scopes ? authed.scopes : '（无任何 scope —— 正是只读公开数据需要的）'}`);

const ok = Number(authed.core) >= 5000;
console.log(ok
  ? '\n  结论：Token 生效。采集与目录扫描可以按 5000 次/小时的量级规划。'
  : `\n  结论：Token 似乎没被接受（配额仍是 ${authed.core}）。检查是否复制了多余字符。`);
process.exit(ok ? 0 : 1);
