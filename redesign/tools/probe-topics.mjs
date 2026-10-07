#!/usr/bin/env node
/* ============================================================
   GitHub topic 探测：给采集源选型用
   ------------------------------------------------------------
   为什么需要它：topic 名字不能凭印象定。实测过几次「听起来一定有」的 topic
   其实只有零星几个仓库，而某些冷门写法（带不带连字符、单复数）差一个数量级。
   选源之前先量一遍，比收完一轮再发现候选太少强。

   对每个 topic 查两次：
     1) 不带过滤 —— 看清这个 topic 到底有多少仓库（总量）
     2) stars:>= 门槛 —— 看清「真有价值可收」的有多少（漏斗）
   并打印前几个仓库的 Star / 最近推送 / 协议，用来判断是不是一堆弃坑项目。

   用法：
     npm run topics                      # 探测内置候选清单
     npm run topics -- --min=500         # 换 Star 门槛
     npm run topics -- --topics=mcp-server,claude-skills
   注意：未认证的 GitHub Search API 限 10 次/分钟，脚本会按间隔发请求。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.resolve(__dirname, 'daily', 'state', 'github-token.txt');

// 主候选（查两次：总量 + 过门槛）与次候选（只查总量）
const PRIMARY = [
  'mcp-server',              // MCP 服务端，生态最大的一块
  'model-context-protocol',  // MCP 官方写法，与上面多有重叠
  'claude-skills',           // Claude Skills：新，可能量少但精准
  'agent-skills',            // 同上，另一常见写法
  'claude-code-plugin',      // Claude Code 插件
  'cursor-rules',            // Cursor 规则
  'ai-agents',               // AI Agent 通用
  'n8n-workflow',            // 自动化流程模板
];
const SECONDARY = ['mcp', 'claude-code', 'prompt-engineering', 'ai-tools', 'dify', 'subagents'];

const arg = k => {
  const a = process.argv.find(x => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : '';
};
const MIN = Number(arg('min')) || 300;
const custom = arg('topics');
const primary = custom ? custom.split(',').map(s => s.trim()).filter(Boolean) : PRIMARY;
const secondary = custom ? [] : SECONDARY;

const token = (() => {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { return ''; }
})();
if (!token) console.log('提示：未找到 GitHub Token（tools/daily/state/github-token.txt），按未认证限速跑，会慢一些。\n');

const GAP = token ? 1200 : 6500;   // 认证 30 次/分钟，未认证 10 次/分钟
const sleep = ms => new Promise(r => setTimeout(r, ms));

let rateLimited = false;
async function search(q) {
  const url = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(q) +
    '&sort=stars&order=desc&per_page=8';
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'xihaoz-topic-probe',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 403 || res.status === 429) {
    rateLimited = true;
    throw new Error(`限速（HTTP ${res.status}）：未认证 Search 只允许 10 次/分钟，等一分钟再跑，或配置 Token。`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const rows = [];
for (const [tier, topics] of [['primary', primary], ['secondary', secondary]]) {
  for (const topic of topics) {
    try {
      const raw = await search(`topic:${topic}`);
      await sleep(GAP);
      let filtered = null;
      if (tier === 'primary') {
        filtered = await search(`topic:${topic} stars:>=${MIN}`);
        await sleep(GAP);
      }
      const top = raw.items.slice(0, 3).map(r => {
        const lic = r.license ? r.license.spdx_id : '—';
        const pushed = (r.pushed_at || '').slice(0, 10);
        return `${r.full_name} ★${r.stargazers_count} ${pushed} ${lic}`;
      });
      rows.push({ topic, tier, total: raw.total_count, filtered: filtered ? filtered.total_count : null, top });
      const fl = filtered ? `  可用(★≥${MIN}) ${String(filtered.total_count).padStart(6)}` : '';
      console.log(`  ${topic.padEnd(24)} 总量 ${String(raw.total_count).padStart(7)}${fl}`);
      for (const t of top) console.log(`      ${t}`);
    } catch (e) {
      console.log(`  ${topic.padEnd(24)} 查询失败：${e.message}`);
      if (rateLimited) {
        console.log('\n限速中断，已探测的结果见上。');
        break;
      }
    }
    if (rateLimited) break;
  }
  if (rateLimited) break;
}

console.log('\n———————— 小结 ————————');
const ok = rows.filter(r => r.filtered !== null).sort((a, b) => b.filtered - a.filtered);
for (const r of ok) console.log(`  ${r.topic.padEnd(24)} ★≥${MIN} 可用 ${String(r.filtered).padStart(6)} / 总量 ${r.total}`);
const thin = rows.filter(r => r.filtered === null).sort((a, b) => b.total - a.total);
if (thin.length) {
  console.log('  仅总量（差一个数量级就别当主源）：');
  for (const r of thin) console.log(`    ${r.topic.padEnd(22)} ${r.total}`);
}
console.log('\n判断标准：可用数太少（<100）说明这个 topic 撑不起一个类目；');
console.log('总量大但可用数极少，说明里面基本是玩具项目，要抬高 stars 门槛或换源。');
