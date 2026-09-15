#!/usr/bin/env node
/* ============================================================
   仓库核实器（走 GitHub 官方 Search API）
   ------------------------------------------------------------
   为什么自己跑而不是靠网页抓取：
   - Search API 返回的是 GitHub 自己的权威字段（full_name / stars /
     license / description / owner.avatar_url），不存在"编造仓库"的可能
   - 每条只需一次请求，且可复现

   产出 data/_candidates.json 供人工定夺；最终结论写进 data/github.json。
   未认证配额：search 10 次/分钟 —— 脚本按 6.5s 间隔自限速。
   用法：node tools/verify-repos.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const curation = JSON.parse(fs.readFileSync(path.join(ROOT, 'curation.json'), 'utf8'));

/* 每个条目一条精确查询：用功能关键词 + in:name,description 提高信噪比 */
const QUERIES = {
  '2':  'MusicFree music player',
  '3':  'SimpleLive live streaming',
  '4':  'SD Maid SE',
  '5':  'Seal yt-dlp video downloader android',
  '6':  'FlashDim screen brightness',
  '7':  '自动精灵 android auto clicker',
  '8':  'Miru anime android',
  '9':  'Kazumi anime',
  '10': 'Animeko anime',
  '11': 'bangumi android client',
  '12': 'LaQoo anime',
  '13': 'siyuan note',
  '14': 'QWeather android client',
  '15': 'ImageToolbox',
  '16': 'Loop android automation',
  '17': 'Rain weather android open source',
  '18': 'Hikari Novel',
  '19': 'MedTimer medication reminder',
  '20': 'legado reader',
  '21': 'Sky Map android astronomy',
  '22': 'Fennec F-Droid firefox android',
  '23': 'Noice ambient noise android',
  '24': 'gkd android',
  '25': 'mhabit habit tracker',
  '26': '简单水印 watermark',
  '27': 'organicmaps',
  '28': 'Cuppa water reminder',
  '29': 'NewPipe',
  '30': 'InnerTune music',
  '31': 'bilimiao',
  '32': 'PiliPala bilibili',
  '33': 'Xtra twitch',
  '34': 'openfoodfacts android',
  '35': 'chrono timer android open source',
  '36': 'Feeel workout',
  '37': 'TrailSense hiking',
  '38': 'FoodYou nutrition',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function searchRepo(q, attempt = 0) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=5`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'xihaouc-repo-verifier',
    },
    signal: AbortSignal.timeout(25000),
  });

  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset');
    const waitMs = reset ? Math.max(5000, (+reset * 1000) - Date.now() + 2000) : 65000;
    if (attempt < 3) {
      process.stderr.write(`    限流，等待 ${Math.round(waitMs / 1000)}s 后重试…\n`);
      await sleep(Math.min(waitMs, 70000));
      return searchRepo(q, attempt + 1);
    }
    return { error: `rate limited (${res.status})` };
  }
  if (!res.ok) return { error: `HTTP ${res.status}` };

  const j = await res.json();
  return {
    total: j.total_count,
    items: (j.items || []).map(it => ({
      fullName: it.full_name,
      url: it.html_url,
      stars: it.stargazers_count,
      license: it.license ? it.license.spdx_id : null,
      lang: it.language,
      desc: it.description,
      archived: it.archived,
      topics: it.topics,
      avatar: it.owner.avatar_url,
      homepage: it.homepage,
      pushedAt: it.pushed_at,
    })),
  };
}

const out = {};
const rows = Object.keys(QUERIES);

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const meta = curation.apps[row];
  const q = QUERIES[row];
  const t0 = Date.now();
  const r = await searchRepo(q);
  out[row] = { name: meta.name, query: q, ...r };

  if (r.error) {
    console.log(`[${row}] ${meta.name}  →  ${r.error}`);
  } else {
    console.log(`[${row}] ${meta.name}  (query="${q}", ${r.total} 命中)`);
    for (const it of r.items.slice(0, 4)) {
      console.log(`      ${it.fullName}  ★${it.stars}  ${it.license || '无协议'}  ${it.archived ? '[已归档] ' : ''}${(it.desc || '').slice(0, 70)}`);
    }
  }
  // 自限速，留出余量（10 次/分钟）
  if (i < rows.length - 1) await sleep(6500);
}

fs.writeFileSync(path.join(ROOT, 'data', '_candidates.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(`\n候选已写入 data/_candidates.json（${rows.length} 条查询）`);
