#!/usr/bin/env node
/* ============================================================
   电脑软件通道（每日流水线的第 3 源）
   ------------------------------------------------------------
   为什么是独立文件而不是塞进 collect.mjs：
   collect.mjs 的 main() 是一条硬编码的线性流程，Android 假设贯穿第 2–4 段
   （F-Droid 索引、APK 校验、APK 解析）。桌面软件的假设完全不同：

     · 发现：按 Windows 桌面 topic 搜 GitHub，不是 F-Droid
     · 确凿证据：桌面端**没有 APK 可当铁证**，只能靠「Release 里真有能装的
       Windows 资产」+「描述不像库/框架/服务端」。所以闸门和 Android 那套
       androidAppCheck 是两套判断，不能互相套用。
     · 解析：**整段绕开 APK 解析**。版本取 release tag，包名没有，
       签名没有，图标走源码仓库（fetchRepoIcon）。

   本模块只做「发现 + 核实 + 挑资产」，把通过核实的条目交回 collect.mjs，
   由它统一走下载、README、审核表、网盘那一套（那些环节本来就是平台无关的）。

   配额是独立的：config.desktop.quota（默认 2 个/天），不占手机 App 的 4 个。
   理由：桌面包比 APK 大一个量级，网盘上传是真实瓶颈，不该互相挤。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchRepos, getRepo, listReleases } from './channels.mjs';
import { pickDesktopRelease, desktopAppCheck } from '../desktop/signals.mjs';
import { log, warn, sleep, nameKey, readJSON, dayIndex, daysAgoISO, humanSize } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** tools/desktop/config.json —— 底线与信号都在那边，人定的规则不进代码 */
export function loadDesktopCfg(dailyCfg) {
  const p = dailyCfg.desktop && dailyCfg.desktop.configFile
    ? path.resolve(__dirname, dailyCfg.desktop.configFile)
    : path.resolve(__dirname, '..', 'desktop', 'config.json');
  const cfg = readJSON(p, null);
  if (!cfg) throw new Error(`电脑软件频道配置读不到：${p}`);
  return { path: p, cfg };
}

/** 把 config 里的信号词表编成一个大小写不敏感的正则；空表返回永不命中的正则（而不是 null） */
function makeMatcher(list) {
  const words = (list || []).map(s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(words.length ? `(${words.join('|')})` : '(?!)', 'i');
}

/**
 * 检索切片：桌面候选用**平台 topic × 星数区间**轮换。
 * 与 Android 那套的差别：Android 用 topic + 关键词，桌面用 topic + 星数区间。
 * 理由：桌面 topic（windows / desktop-app）下的仓库数量在十万级，星数区间能把
 * 「人人皆知的大牌」和「小众但好用」分开，避免每天都是同一批头部项目。
 */
function buildSearchSpecs(desktop) {
  const specs = [];
  for (const t of desktop.topics || []) {
    for (const b of desktop.starBands || ['>=500']) {
      specs.push({ q: `topic:${t} stars:${b} archived:false fork:false`, sort: 'stars' });
    }
  }
  for (const t of (desktop.topics || []).slice(0, 2)) {
    specs.push({ q: `topic:${t} stars:>=${desktop.minStars} pushed:>=${daysAgoISO(desktop.pushedWithinDays)} archived:false fork:false`, sort: 'updated' });
  }
  return specs;
}

function scoreDesktopCandidate(repo, androidScore) {
  let s = Math.log10(Math.max(repo.stars || 1, 1)) * 10;
  if (repo.desc && repo.desc.length > 30) s += 3;
  if ((repo.topics || []).some(t => ['windows', 'desktop-app', 'cross-platform'].includes(t))) s += 4;
  if (['MIT', 'Apache-2.0'].includes(repo.license)) s += 2;
  const days = (Date.now() - new Date(repo.pushedAt || 0).getTime()) / 86400000;
  if (days < 30) s += 5; else if (days < 90) s += 3; else if (days < 180) s += 1;
  return s + androidScore;
}

/* ============================================================
   发现 + 核实
   ------------------------------------------------------------
   @param {object} o
   @param {object} o.dailyCfg        tools/daily/config.json
   @param {object} o.desktopCfg      tools/desktop/config.json
   @param {object} o.site            { repos:Map, names:Map } 站点已有条目
   @param {object} o.state           state/seen.json（本函数只读不写，写盘由 collect 统一做）
   @param {string} o.date
   @param {number} o.limit           本轮最多交付几个（独立配额）
   @param {string|null} o.only       --only=owner/repo：只核实这一个仓库
   @param {Map} o.existingNames      名称去重表（含 state 与站点，且已剔除当天交付过的）
   @returns {Promise<{apps:Array, rejected:Array, failed:Array, raw:number, passed:number, reason?:string}>}
   ============================================================ */
export async function discoverDesktop({ dailyCfg, desktopCfg, site, state, date, limit, only = null, existingNames }) {
  const D = dailyCfg.desktop || {};
  const out = { apps: [], rejected: [], failed: [], raw: 0, passed: 0 };
  if (limit <= 0) { out.reason = '配额为 0'; return out; }

  const DENY_REPO = makeMatcher(desktopCfg.deny && desktopCfg.deny.repoPatterns);
  const DENY_DESC = makeMatcher(desktopCfg.deny && desktopCfg.deny.descPatterns);
  const names = existingNames || new Set();

  /* ---------- 1. 发现候选仓库 ---------- */
  let candidates = [];
  if (only) {
    // 调试通道：只查指定仓库。和 Android 通道的 --only 行为一致。
    const repo = await getRepo(only);
    candidates = [repo];
  } else {
    const specs = buildSearchSpecs(D);
    if (!specs.length) { out.reason = 'config.desktop.topics 为空'; return out; }
    const start = dayIndex() % specs.length;
    const picks = [];
    for (let i = 0; i < (D.searchesPerRun || 2); i++) picks.push(specs[(start + i) % specs.length]);
    log(`  本轮检索切片 ${start}~${(start + picks.length - 1) % specs.length}（共 ${specs.length} 个切片轮换）`);

    const seen = new Set();
    for (const spec of picks) {
      const page = 1 + (dayIndex() % (D.pageRotation || 3));
      try {
        const r = await searchRepos(spec.q, { sort: spec.sort, order: 'desc', page, perPage: D.perPage || 30 });
        log(`  「${spec.q}」第 ${page} 页 → ${r.total} 命中，取回 ${r.items.length} 个`);
        for (const it of r.items) {
          const k = (it.fullName || '').toLowerCase();
          if (!k || seen.has(k)) continue;
          seen.add(k);
          candidates.push(it);
        }
      } catch (e) {
        warn(`  检索失败（${spec.q}）：${e.message}`);
        out.reason = out.reason || `检索失败：${e.message}`;
        if (e.rateLimited) break;
      }
      await sleep(6500);   // 搜索 API 未认证 10 次/分钟，留余量
    }
  }
  out.raw = candidates.length;
  log(`  去重后候选仓库 ${candidates.length} 个`);

  /* ---------- 2. 粗筛（不花 API，全在内存里判） ---------- */
  const f = dailyCfg.filters || {};
  const pool = [];
  for (const c of candidates) {
    const key = c.fullName.toLowerCase();
    if (site.repos.has(key)) { out.rejected.push({ repo: c, why: '站点已收录' }); continue; }
    if (state.repos[key]) { out.rejected.push({ repo: c, why: `历史已检查：${state.repos[key].stage}` }); continue; }
    if (names.has(nameKey(c.name))) { out.rejected.push({ repo: c, why: '名称与已收录条目重复' }); continue; }

    // 合规底线优先：代理/翻墙一个都不收（站方决定，见 desktop/config.json 的 deny 注释）
    const denied = DENY_REPO.exec(c.name) || DENY_REPO.exec(c.desc) || DENY_DESC.exec(c.desc);
    if (denied) { out.rejected.push({ repo: c, why: `合规底线：命中代理/翻墙信号「${denied[0]}」` }); continue; }
    if (c.archived && !f.allowArchived) { out.rejected.push({ repo: c, why: '仓库已归档' }); continue; }
    if ((c.stars || 0) < (D.minStars || 500)) { out.rejected.push({ repo: c, why: `Star 不足（${c.stars} < ${D.minStars}）` }); continue; }
    const days = (Date.now() - new Date(c.pushedAt || 0).getTime()) / 86400000;
    if (days > (D.pushedWithinDays || 365)) { out.rejected.push({ repo: c, why: `超过 ${D.pushedWithinDays} 天没更新` }); continue; }
    if (!c.desc) { out.rejected.push({ repo: c, why: '没有项目描述' }); continue; }
    if (f.requireLicense && !c.license) { out.rejected.push({ repo: c, why: '没有开源协议（不允许再分发）' }); continue; }
    const lic = dailyCfg.license || { allow: [], deny: [] };
    if (lic.deny.includes(c.license)) { out.rejected.push({ repo: c, why: `协议不允许再分发：${c.license}` }); continue; }
    if (!lic.allow.includes(c.license)) { out.rejected.push({ repo: c, why: `协议不在白名单：${c.license}` }); continue; }

    const a = desktopAppCheck(c, { desktop: D, desktopCfg });
    if (!a.ok) {
      const why = a.cliHardReject ? `命令行工具而非桌面应用（名字/自身定位是 ${a.cli || 'CLI'}，且没有任何 GUI 声明）`
        : a.cli ? `命令行工具而非桌面应用（命中「${a.cli}」）`
        : a.nonApp ? `非应用（命中「${a.nonApp[0]}」）`
        : `不像 Windows 桌面应用（特征分 ${a.score}）`;
      out.rejected.push({ repo: c, why });
      continue;
    }
    c.score = scoreDesktopCandidate(c, a.score);
    c.desktopScore = a.score;
    // 提醒而不是拒收：服务端信号判断不出「主体是不是桌面应用」（rustdesk 描述里有 self-host，
    // 但它主体是桌面客户端；wiki.js 一个信号词都没有却混进来过）。脚本给事实，收不收由人点头。
    c.notes = a.server ? [`疑似服务端应用（命中「${a.server[0]}」）—— 确认它不是只跑在服务器上的东西再发`] : [];
    pool.push(c);
  }
  out.passed = pool.length;
  log(`  粗筛通过 ${pool.length} 个（累计落选 ${out.rejected.length} 个）`);

  /* ---------- 3. 逐个查 Release，挑出真能装的 Windows 资产 ---------- */
  pool.sort((a, b) => b.score - a.score);
  const toCheck = pool.slice(0, Math.max(0, only ? 1 : (D.releaseChecks || 10)));
  log(`  核实 Release（每个仓库 1 次核心 API，最多查 ${toCheck.length} 个候选的 Windows 资产）`);

  for (const c of toCheck) {
    if (out.apps.length >= limit) break;
    try {
      const releases = await listReleases(c.fullName, 10);
      const pick = pickDesktopRelease(releases, { ...(f || {}), ...D });
      if (!pick) {
        out.rejected.push({ repo: c, why: 'Release 里没有可用的 Windows 资产（只有 mac/linux 资产、只有源码包、体积超限或没有 Release）' });
        continue;
      }
      const rec = {
        source: 'desktop',
        kind: 'desktop',
        repo: c,
        displayName: c.name,
        release: { tag: pick.release.tag, name: pick.release.name, publishedAt: pick.release.publishedAt, body: pick.release.body },
        asset: {
          name: pick.asset.name, size: pick.asset.size, downloads: pick.asset.downloads,
          url: pick.asset.url, digest: pick.asset.digest || null,
        },
        assetUrls: [],
        otherApks: [],
        alternatives: pick.alternatives || [],
        desktop: {
          assetKind: pick.kind,                 // portable（便携版）| installer（安装器）
          platform: 'Windows',
          mb: pick.mb,
          pickedBy: 'pickDesktopRelease（平台硬过滤 + x64 优先 + 排除 Source code）',
          confidence: 'medium',
        },
        fdroid: null,
        notes: c.notes || [],
        checkedAt: date,
      };
      out.apps.push(rec);
      log(`  ✓ ${c.fullName}（★${c.stars}）→ ${pick.release.tag} / ${pick.asset.name}（${pick.kind === 'portable' ? '便携版' : '安装器'} ${humanSize(pick.asset.size)}）`);
      await sleep(300);
    } catch (e) {
      if (e.rateLimited) { warn('  GitHub 核心 API 配额耗尽，电脑软件通道的核实中止'); break; }
      if (e.notFound) { out.rejected.push({ repo: c, why: '仓库不存在或已改名' }); continue; }
      out.failed.push({ fullName: c.fullName, why: `核实失败：${e.message}` });
    }
  }
  if (!out.apps.length) out.reason = out.reason || '本轮没有可交付的桌面候选';
  return out;
}
