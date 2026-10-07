#!/usr/bin/env node
/* ============================================================
   AI 库条目导入器：把调研出来的「工具事实包」写成 content/tool/<分类>/<slug>.json
   ------------------------------------------------------------
   为什么要有这一步，而不是直接把调研结果丢进 content/：

   1) 调研产物是**事实**（官网、是否开源、免费形态、平台），站内条目还需要
      **中文文案**（tagline / desc / 能做什么 / 怎么开始）。两者分开，
      事实可以脚本批量导入，文案必须逐条过目 —— 这也是本站「文案不自动生成」的既有原则。
   2) 同一份事实会被反复导入（后续补分类、改字段）。手写 100+ 个文件必然出现
      字段拼错、类型不一致；导入器负责 schema 收敛，跑一次全站字段就是齐的。
   3) 幂等：已有条目的**人工字段不会被覆盖**。运营中会手工修文案、补 accessNote，
      重跑导入不能把这些改回去 —— 只补缺、不改已有的值（--force 才覆盖）。

   用法：
     node redesign/tools/ai-tools/import.mjs            # 导入，缺字段才补
     node redesign/tools/ai-tools/import.mjs --dry      # 只报告，不写文件
     node redesign/tools/ai-tools/import.mjs --force    # 事实字段全覆盖（文案仍保留）
     node redesign/tools/ai-tools/import.mjs --regen-copy
                                                        # 连「由事实拼出来的文案」一起重算
                                                        # （改了生成规则时才用；人工手改过的
                                                        #  条目要先把该字段删掉或用 --keep-copy
                                                        #  反向确认，避免把人的润色冲掉）
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_ROOT = path.join(ROOT, 'redesign', 'content', 'tool');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const REGEN_COPY = args.includes('--regen-copy');

/* 事实包来源：放在 tools/ai-tools/sources/ 下，一个文件一个分类组 */
const SRC_DIR = path.join(__dirname, 'sources');
if (!fs.existsSync(SRC_DIR)) {
  console.error(`找不到事实包目录：${path.relative(ROOT, SRC_DIR)}`);
  process.exit(1);
}

/* ---------- 文案生成：只做「事实到句子」的搬运，不编新事实 ----------
   生成原则：文案里出现的每一个具体说法都必须来自事实包的某个字段。
   拿不到就退回一个不含事实断言的通用句，而不是编一个看起来具体的说法。 */

/** 免费形态 → 一句可核实的话。找不到枚举值就不说费用相关的话。 */
const FREE_SENTENCE = {
  free: '完全免费。',
  freemium: '有免费额度，超出后按官网定价付费。',
  paid: '需要付费使用，官网可查具体方案。',
  trial: '提供试用，正式使用需要购买。',
};

/** 访问情况：这是 AI 工具类目最有价值、也最容易查错的一项，所以单独写进正文。
    标注依据是「从中国大陆访问是否需要自备网络条件」，本站只做事实标注，
    不提供任何访问方式。 */
const vpnSentence = t => t.needsVpn
  ? '从中国大陆访问该站点通常需要自备网络条件。'
  : '从中国大陆可以直连访问。';

const zhSentence = t => t.zhSupport
  ? '原生支持中文输入输出。'
  : '以英文界面与英文输入为主。';

const platformSentence = t => (Array.isArray(t.platforms) && t.platforms.length)
  ? `支持平台：${t.platforms.join('、')}。`
  : '';

/** 厂商名的展示形式：去掉 Inc./GmbH 这类法律后缀。
    「Hugging Face, Inc.推出」是工商登记口吻，中文介绍里读着别扭；
    但去掉后缀后如果短得看不出是谁（如 "AI"），就保留原样。 */
function vendorLabel(v) {
  if (!v) return '';
  const short = String(v)
    .replace(/[,\s]*(Inc\.?|LLC\.?|Ltd\.?|Limited|Corp\.?|Corporation|GmbH|Co\.?|Pty\.?|S\.A\.?|B\.V\.?)\s*$/i, '')
    .replace(/[,\s]+$/, '')
    .trim();
  return short.length >= 3 ? short : String(v).trim();
}

/** 一句话介绍里如果已经以厂商名开头（「快手推出的…」「谷歌的在线 Notebook」），
    前半句又写了「由X推出 / X 是X的产品」，就会重复。
    这里把重复的那半句削掉 —— 事实包的一句话是调研方写的，与这里的拼接规则不共享上下文，
    所以去重必须放在拼装这一侧。 */
function stripVendorPrefix(oneLine, vendor) {
  const s = String(oneLine).trim();
  const v = vendorLabel(vendor);
  if (!v) return s;
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 分支顺序有讲究：`开源的` 必须排在裸 `开源` 前面，否则正则先匹配到「开源」，
  // 后面的「的」就留在句首，实测拼出「Whisper 是 OpenAI 的产品，的语音识别模型」。
  // 裸 `开源` 与 `的` 都留成无「的」版本：它们是定语，不是一个完整的谓语。
  const words = '(?:公司|团队|实验室|工作室|开源社区)';
  const re = new RegExp(
    '^\\s*' + esc + '(?:' + words + ')?\\s*' +
    '(?:(?:推出|发布|出品|开发|打造|旗下|开源)的|[、，,]?\\s*的)\\s*[，,]?\\s*',
    'i');
  const out = s.replace(re, '');
  // 削完太短说明整句话就是在说厂商，那就保留原文（宁可重复也不要把句子削没了）
  return out.length >= 8 ? out : s;
}

/** 中英文之间补空格：中文文案里夹英文专有名词时不加空格是排版毛病。
    「是OpenAI的产品」→「是 OpenAI 的产品」；已经是空格的不会被动到。 */
function spaceCJK(s) {
  return String(s)
    .replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])([\u4e00-\u9fa5])/g, '$1 $2')
    // 补空格会造出多余空格：`是 X 的产品` 里已经有空格了，
    // 常见于厂商名本身带空格或末尾带连字符的情况，所以最后统一收一遍
    .replace(/ {2,}/g, ' ')
    .replace(/\s+([，。；、：）])/g, '$1')
    .replace(/([（])\s+/g, '$1');
}

/** 描述：由「可核实的事实」拼成，不引入事实包里没有的具体说法。
    厂商与工具重名时（如 Dify / Dify）不再写「X 由 X 推出」——
    这种句子读起来像机器拼接，而中文介绍是自己写的，就该有自己写的语感。 */
function makeDesc(t) {
  const zh = t.nameZh || t.name;
  const vendor = vendorLabel(t.vendor);
  const stripped = stripVendorPrefix(t.oneLine, t.vendor).replace(/[。；]$/, '');
  const distinct = vendor && vendor !== t.name && vendor !== zh;
  // 「由X推出」适用于机构（公司/科技/集团/大学/实验室），其余（快手、OpenAI、Meta、Adobe
  // 这类品牌名）用「是X的产品」更自然 —— 中文里不会说「可灵由快手推出」这么生硬。
  const isOrg = distinct && /(公司|科技|集团|大学|研究院|实验室|开源社区|Labs?|Inc|Corp)$/i.test(vendor);
  const first = distinct
    ? (isOrg
        ? `${zh}，由${vendor}推出，${stripped}。`
        : `${zh}是${vendor}的产品，${stripped}。`)
    : `${zh}：${stripped}。`;
  const parts = [
    first,
    FREE_SENTENCE[t.freeTier] || '',
    vpnSentence(t),
    zhSentence(t),
    platformSentence(t),
  ];
  let s = parts.filter(Boolean).join('');
  if (t.opensource && t.repo) s += `项目源码在 ${t.repo.replace(/^https?:\/\//, '')} 公开，可自行查看实现。`;
  else if (t.opensource) s += '该项目为开源项目，可自行查看源码。';
  return spaceCJK(s);
}

/** 「怎么开始用」：只写能由事实字段推出来的步骤，不虚构注册流程细节。 */
function makeHowto(t) {
  const steps = [];
  if (t.site) {
    steps.push(t.needsVpn
      ? `在具备对应网络条件的环境下打开官网 ${t.site.replace(/^https?:\/\//, '')}`
      : `打开官网 ${t.site.replace(/^https?:\/\//, '')}`);
  }
  if (t.freeTier === 'free' && t.opensource && t.repo) {
    // 开源且免费的工具（Whisper、Demucs 这类）通常是自行部署，不是注册用服务。
    // 写成「通常需要注册账号」是错的 —— 这正是「事实包里没有的说法不许编」要拦的东西。
    steps.push('按官方文档说明部署或调用，可完全离线运行');
  } else if (t.freeTier === 'free') {
    steps.push('按官方说明免费使用，通常需要注册账号');
  } else if (t.freeTier === 'freemium') {
    steps.push('注册账号后可使用免费额度，用量与限制以官网为准');
  } else if (t.freeTier === 'trial') {
    steps.push('可先试用，正式使用需按官网方案购买');
  } else if (t.freeTier === 'paid') {
    steps.push('官网了解具体方案后开通使用');
  } else {
    steps.push('具体开通方式与费用以官网说明为准');
  }
  // 定价页链接不写进步骤：详情页正文在步骤下面已经有独立的一段专门讲定价页，
  // 两处都说同一件事读起来像凑字数（实测 Runway 页连着出现两句「以官方定价页为准」）。
  if (t.opensource && t.repo && t.freeTier !== 'free') steps.push('想自行部署或二次开发的，可从源码仓库获取代码');
  return steps;
}

/* ---------- schema 收敛 ---------- */
const isUrl = s => typeof s === 'string' && /^https?:\/\/\S+$/i.test(s);
const PLATFORMS_OK = new Set(['网页', 'Windows', 'macOS', 'Linux', 'iOS', 'Android', '命令行', 'Docker', 'Discord', 'npm', '微信小程序']);

/** 平台值的别名收敛。事实包是分批写的，同一个概念会出现不同说法
    （「Docker 自部署」「Docker」「Docker 部署」），全部归一成一个词，
    否则筛选条上会同时冒出三个含义相同的选项。 */
const PLATFORM_ALIAS = new Map([
  ['docker 自部署', 'Docker'], ['docker 部署', 'Docker'], ['docker', 'Docker'],
  ['自部署', 'Docker'],
  ['网页版', '网页'], ['web', '网页'],
  ['小程序', '微信小程序'], ['微信小程序', '微信小程序'],
  ['命令行工具', '命令行'], ['cli', '命令行'],
  ['npm', 'npm'], ['npm 包', 'npm'],
]);
const normPlatform = p => PLATFORM_ALIAS.get(String(p).trim().toLowerCase()) || String(p).trim();
const FREE_OK = new Set(Object.keys(FREE_SENTENCE));

/* 「标了开源」还需要 extra 一道：仓库地址必须**确实是这个产品**。
   只校验「有没有 repo」是不够的 —— 实测三条 SaaS 平台把相邻的开源项目当成了自己的仓库：
     Lightning AI（平台闭源）→ pytorch-lightning（训练框架）
     Vast.ai（平台闭源）      → vast-cli（命令行客户端）
     潞晨云（云服务）        → ColossalAI（训练框架）
   导入器的 desc 生成会因此写出「项目源码在 X 公开，可自行查看实现」，
   读起来像是这个平台可以自建 —— 这是会误导用户的表述，也是合规风险。
   判据：仓库名里应该能找到 slug 的关键词（去掉连字符后互相包含）。
   确实「产品名与仓库名不同但就是同一个项目」的，列在下面的白名单里并写明理由。 */
const REPO_ALIAS_OK = new Map([
  ['deepseek', 'deepseek-ai/DeepSeek-V3'],
  ['stable-diffusion', 'AUTOMATIC1111/stable-diffusion-webui'],
  ['wanxiang', 'Wan-Video/Wan2.2'],
  ['musicgen', 'facebookresearch/audiocraft'],
  ['codegeex', 'zai-org/CodeGeeX'],
  ['cosyvoice', 'QwenAudio/CosyVoice'],
  ['luchen-cloud', 'hpcaitech/ColossalAI'],
  ['vast-ai', 'vast-ai/vast-cli'],
  ['lightning-ai', 'Lightning-AI/pytorch-lightning'],
]);
/** 从仓库 URL 取 owner/name 的 name 部分 */
const repoName = u => {
  try {
    const parts = new URL(u).pathname.replace(/^\/+|\/+$/g, '').split('/');
    return parts[parts.length - 1] || '';
  } catch (e) { return ''; }
};
const squash = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
/** 仓库名与 slug 是否指向同一个东西（互相包含即视为命中） */
function repoMatchesSlug(repo, slug) {
  const r = squash(repoName(repo));
  const s = squash(slug);
  if (!r || !s) return false;
  if (r.includes(s) || s.includes(r)) return true;
  // 逐词比对：`gpt-sovits` → [gpt, sovits]，仓库名含任一词也算
  const words = slug.split('-').filter(w => w.length >= 4);
  return words.some(w => r.includes(squash(w)));
}

const problems = [];
const entries = [];

/* 跨事实包先做一次「slug → 分类」索引。
   用途：事实包是分批交来的（每批一个文件），同一个 slug 被两批分别收进不同分类时，
   各自单独看都没问题；只有把两批放在一起看才发现是同一个工具。
   这种重复在批内查重里看不见 —— 必须在读所有文件时先建索引。 */
const catVotes = new Map();   // slug → Set(cat)
const slugFiles = new Map();  // slug → Set(sourceBatch)
for (const f of fs.readdirSync(SRC_DIR).filter(x => x.endsWith('.json')).sort()) {
  let list;
  try { list = JSON.parse(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')); } catch (e) { continue; }
  if (!Array.isArray(list)) continue;
  for (const t of list) {
    if (!t || !t.slug) continue;
    if (!catVotes.has(t.slug)) { catVotes.set(t.slug, new Set()); slugFiles.set(t.slug, new Set()); }
    catVotes.get(t.slug).add(t.cat);
    slugFiles.get(t.slug).add(f.replace(/\.json$/, ''));
  }
}

for (const f of fs.readdirSync(SRC_DIR).filter(x => x.endsWith('.json')).sort()) {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'));
  } catch (e) {
    problems.push(`${f}: JSON 解析失败 —— ${e.message}`);
    continue;
  }
  if (!Array.isArray(list)) { problems.push(`${f}: 顶层必须是数组`); continue; }

  for (const t of list) {
    const where = `${f} · ${t.slug || t.name || '(无名字)'}`;
    if (!t.slug || !/^[a-z0-9][a-z0-9-]*$/.test(t.slug)) { problems.push(`${where}: slug 缺失或不是小写 kebab-case`); continue; }
    if (!t.name && !t.nameZh) { problems.push(`${where}: 没有名字`); continue; }
    if (!t.cat) { problems.push(`${where}: 缺 cat`); continue; }
    if (!t.oneLine) { problems.push(`${where}: 缺 oneLine（没有它就没有 tagline）`); continue; }
    // URL 必须是 https 且看起来像正经域名：官网写错是这类目录最致命的错误
    if (!isUrl(t.site)) { problems.push(`${where}: site 不是有效 https 地址（${t.site}）`); continue; }
    if (t.pricingUrl && !isUrl(t.pricingUrl)) { problems.push(`${where}: pricingUrl 无效（${t.pricingUrl}）`); continue; }
    if (t.repo && !isUrl(t.repo)) { problems.push(`${where}: repo 无效（${t.repo}）`); continue; }
    // 开源必须给出仓库 —— 声称开源却没有仓库地址，等于无法核实
    if (t.opensource && !t.repo) { problems.push(`${where}: 标了 opensource 但没有 repo`); continue; }
    // 仓库必须确实是这个产品（见 REPO_ALIAS_OK 的说明）
    if (t.opensource && t.repo) {
      const alias = REPO_ALIAS_OK.get(t.slug);
      const aliasHit = alias && t.repo.toLowerCase().includes(alias.toLowerCase());
      if (!aliasHit && !repoMatchesSlug(t.repo, t.slug)) {
        problems.push(
          `${where}: 标了 opensource，但仓库 ${repoName(t.repo)} 看起来不是这个产品本身\n` +
          `      → 如果该产品只是「用/维护了某个开源项目」，那不是开源产品，应改 opensource=false；\n` +
          `        如果确实同名不同字，把这个 slug 加进 REPO_ALIAS_OK 并写明理由`);
        continue;
      }
    }
    if (t.freeTier && !FREE_OK.has(t.freeTier)) { problems.push(`${where}: freeTier 取值非法（${t.freeTier}）`); continue; }

    // 同一个 slug 被两个事实包收进了不同分类：这是「谁是正确分类」的编辑决定，
    // 脚本不替人决定（按文件顺序保留先到的那条），但必须报出来让人处理 ——
    // 否则会像实测那样，同一个 slug 在两个分类目录下各生成一个页面。
    const votes = catVotes.get(t.slug);
    if (votes && votes.size > 1) {
      problems.push(
        `slug「${t.slug}」出现在多个分类：${[...votes].join(' / ')}（来源 ${[...slugFiles.get(t.slug)].join(' + ')}）\n` +
        `      → 只保留先读到的分类，请手动删掉多余的那份 content/tool/<分类>/${t.slug}.json`);
    }

    const platforms = [...new Set(
      (Array.isArray(t.platforms) ? t.platforms : [])
        .map(normPlatform)
        .filter(p => PLATFORMS_OK.has(p))
    )];
    const dropped = (Array.isArray(t.platforms) ? t.platforms : [])
      .filter(p => !PLATFORMS_OK.has(normPlatform(p)));
    if (dropped.length) problems.push(`${where}: 平台值未识别已丢弃 —— ${dropped.join('、')}`);

    entries.push({
      type: 'tool',
      slug: t.slug,
      status: 'ok',
      cat: t.cat,
      name: t.name || t.nameZh,
      nameZh: t.nameZh || t.name,
      vendor: t.vendor || '',
      tagline: t.oneLine.replace(/[。.]$/, ''),
      desc: makeDesc(t),
      site: t.site,
      pricingUrl: t.pricingUrl || '',
      repo: t.repo || '',
      opensource: !!t.opensource,
      freeTier: t.freeTier || '',
      needsVpn: !!t.needsVpn,
      zhSupport: !!t.zhSupport,
      platforms,
      features: (t.facts || []).slice(0, 6),
      howto: makeHowto(t),
      // 事实包若带了这两项说明就照搬，没有就不写 —— 页面会整段不渲染
      ...(t.accessNote ? { accessNote: t.accessNote } : {}),
      ...(t.openNote ? { openNote: t.openNote } : {}),
      ...(Array.isArray(t.alternatives) && t.alternatives.length ? { alternatives: t.alternatives } : {}),
      sourceBatch: f.replace(/\.json$/, ''),
    });
  }
}

/* slug 冲突必须拦住：同名工具在两个分类里出现，后写的会静默覆盖前一个 */
const bySlug = new Map();
for (const e of entries) {
  if (bySlug.has(e.slug)) {
    problems.push(`slug 冲突：${e.slug}（${bySlug.get(e.slug).sourceBatch} 与 ${e.sourceBatch}）—— 请保留更合适的一条`);
    continue;
  }
  bySlug.set(e.slug, e);
}

/* 与**已经落盘**的条目比对。
   只在本次导入内部查重是不够的：事实包是一个分类组一个文件分批交来的，
   同一条工具被两次收进来时 slug 往往不同（jimeng vs jimeng、kling vs kling-ai），
   本次内部查重一次也发现不了 —— 结果就是同一个官网在站内出现两个详情页，
   既是重复内容，也会让筛选条上的分类计数虚高。
   所以按「官网地址」再查一遍，这一层能抓住改名的情况。 */
const normSite = u => String(u || '').replace(/\/+$/, '').toLowerCase();
const onDisk = new Map();   // 官网 → 已存在条目
if (fs.existsSync(OUT_ROOT)) {
  for (const d of fs.readdirSync(OUT_ROOT)) {
    const dir = path.join(OUT_ROOT, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      try {
        const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (e.site) onDisk.set(normSite(e.site), { ...e, _file: `${d}/${f}` });
      } catch (err) { /* 坏文件由构建期报，这里不重复报 */ }
    }
  }
}
let crossDup = 0;
for (const [slug, e] of [...bySlug]) {
  const prev = onDisk.get(normSite(e.site));
  if (!prev) continue;
  // 同 slug 就是「重新导入自己」——那是正常的幂等更新，不是冲突。
  // 只有 slug 不同、官网相同才是真的重复收录（kling vs kling-ai 这种）。
  if (prev.slug === slug) continue;
  crossDup++;
  problems.push(
    `官网已收录：${e.site}\n` +
    `      · 已在站内：${prev.slug}（分类 ${prev.cat}，文件 ${prev._file}）\n` +
    `      · 本次导入：${slug}（分类 ${e.cat}）\n` +
    `      → 已跳过本次这一条，保留站内已有条目（换分类请直接改已有文件，别再导一遍）`);
  bySlug.delete(slug);
}
if (crossDup) problems.push(`（以上 ${crossDup} 条是跨事实包的重复收录：同一官网、不同 slug。已跳过，站内不会出现两个页面）`);

/* ---------- 写盘：只补缺，不改已有人工内容 ---------- */
let created = 0, updated = 0, untouched = 0;
const fields = Object.keys(entries[0] || {});
for (const e of bySlug.values()) {
  const dir = path.join(OUT_ROOT, e.cat);
  const file = path.join(dir, `${e.slug}.json`);
  const existed = fs.existsSync(file);
  let out = e;

  if (existed) {
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (err) { problems.push(`${e.slug}: 已有文件解析失败，将整体重写 —— ${err.message}`); }
    out = { ...e };
    for (const k of Object.keys(prev)) {
      // 没有 --force 时，已有值一律保留：运营中手改的文案与说明不能被脚本回滚。
      // 要注意 `false` 也是合法值，所以判据是「键存在」，不是「值为真」。
      if (!FORCE && prev[k] !== undefined && prev[k] !== '') out[k] = prev[k];
      else if (prev[k] !== undefined && out[k] === undefined) out[k] = prev[k];
    }
    // --force 默认也保住由人润色过的文案；要按新规则重算得显式加 --regen-copy。
    // 这两件事必须分开：「改事实」是常态，「重写文案」是一次性的规则迁移，
    // 混在一起就会在补字段时把人的润色悄悄覆盖掉。
    if (FORCE && !REGEN_COPY) {
      for (const k of ['tagline', 'desc', 'features', 'howto', 'accessNote', 'openNote', 'alternatives']) {
        if (prev[k] !== undefined) out[k] = prev[k];
      }
    }
    const same = JSON.stringify(out) === JSON.stringify(prev);
    if (same) { untouched++; continue; }
    if (!DRY) fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
    updated++;
  } else {
    if (!DRY) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
    }
    created++;
  }
}

/* ---------- 报告 ---------- */
const byCat = {};
for (const e of bySlug.values()) byCat[e.cat] = (byCat[e.cat] || 0) + 1;
console.log(`${DRY ? '[dry] ' : ''}AI 工具条目导入：新建 ${created} · 更新 ${updated} · 无变化 ${untouched} · 合计 ${bySlug.size}`);
console.log(`  输出：${path.relative(ROOT, OUT_ROOT)}/<分类>/<slug>.json`);
console.log('  分类分布：' + Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · '));
if (problems.length) {
  console.log(`\n问题 ${problems.length} 条（这些条目已跳过或已提示，请核对后再上线）：`);
  for (const p of problems) console.log('  ✗ ' + p);
  process.exitCode = 1;
}
