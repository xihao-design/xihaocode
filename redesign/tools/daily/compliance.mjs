/* ============================================================
   合规硬拒（compliance deny）
   ------------------------------------------------------------
   与 riskFlags() 的区别：
     riskFlags  → **只标记**，命中的照收，靠人逐条读描述点头再发
     complianceDeny → **直接不收**，不看人

   为什么必须有后者：riskFlags 的兜底是「人读描述」，实测会漏。2026-10-03 那批里的
   intra 就是例子 —— 它的官方摘要只写「加密 DNS 客户端」，一个敏感词都没有；
   能识别它的是**仓库级**信息（Jigsaw-Code 是 Google 的反审查团队）。
   这类工具对一个有备案的站风险和翻墙工具同级，不能靠关键词碰运气。

   规则全部写在 config.json 的 compliance.denyRepos / denyKeywords 里，
   **每条都带理由** —— 底线是人定的，代码只负责执行；以后加规则不用改代码。

   用法（采集器里在候选入库前调用）：
     const deny = complianceDeny({ repoFullName, name, desc, topics });
     if (deny) { rejected.push({ ...c, why: deny }); continue; }
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadCfg() {
  // 兼容两种位置：本目录下的 config.json（采集器的），或调用方传入后的缓存
  const p = path.join(__dirname, 'config.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; }
}

/**
 * @returns {string|null} 命中返回可读理由（用于写进 rejected 列表），否则 null
 */
export function complianceDeny({ repoFullName = '', name = '', desc = '', topics = [] }, cfg = null) {
  const c = cfg || loadCfg();
  const repo = String(repoFullName).toLowerCase();
  const hay = [name, desc, (topics || []).join(' ')].join(' ').toLowerCase();

  for (const r of (c.compliance && c.compliance.denyRepos) || []) {
    const pat = String(r.pattern || '').toLowerCase();
    if (pat && repo.includes(pat)) return `合规硬拒：仓库命中「${r.pattern}」—— ${r.reason}`;
  }
  for (const k of (c.compliance && c.compliance.denyKeywords) || []) {
    const w = String(k.word || '').toLowerCase();
    if (w && hay.includes(w)) return `合规硬拒：命中「${k.word}」—— ${k.reason}`;
  }
  return null;
}

/* 自测：node redesign/tools/daily/compliance.mjs */
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
  const cases = [
    ['intra（真实案例：反审查组织下的 DNS 工具）', { repoFullName: 'Jigsaw-Code/Intra', name: 'Intra', desc: '加密 DNS 客户端' }],
    ['普通下载器（不该被拒）', { repoFullName: 'GopeedLab/gopeed', name: 'Gopeed', desc: 'A fast, modern download manager' }],
    ['普通播放器（不该被拒）', { repoFullName: 'moneytoo/Player', name: 'Just (Video) Player', desc: '基于 ExoPlayer 的简单视频播放器' }],
    ['描述里出现「翻墙」', { repoFullName: 'someone/tool', name: 'Tool', desc: '帮助你翻墙访问被屏蔽的网站' }],
  ];
  let pass = 0;
  for (const [label, c] of cases) {
    const r = complianceDeny(c);
    const shouldDeny = !label.includes('不该被拒');
    const ok = shouldDeny ? !!r : !r;
    if (ok) pass++;
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    console.log(`      → ${r || '（放行）'}`);
  }
  console.log(`\n通过 ${pass} / ${cases.length}`);
  process.exit(pass === cases.length ? 0 : 1);
}
