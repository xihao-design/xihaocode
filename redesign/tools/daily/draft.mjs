/* ============================================================
   审核表生成：draft.md
   ------------------------------------------------------------
   这是每天唯一需要你亲自看的东西。原则：
     · 机器只陈述事实（包名/版本/Star/协议/哈希/来源），不写卖点文案
     · 每一项「需要人做的事」都单独列出来，不藏在细节里
     · 落选原因全列出，便于你判断筛选规则要不要调
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { humanSize, escapeMd } from './util.mjs';

const CAT_NAMES = {
  media: '影音播放', anime: '动漫阅读', system: '系统工具',
  image: '图片处理', focus: '效率笔记', life: '生活健康',
};

export function writeDraft(bundle, dayDir, cfg) {
  const { apps, rejected, downloadFailures, date } = bundle;
  const L = [];
  const p = s => L.push(s);

  p(`# 每日采集审核表 · ${date}`);
  p('');
  p(`> 本表由 \`tools/daily/collect.mjs\` 生成。**脚本不写文案** —— 站点原则是不编造，`
    + `机器翻译出来的卖点就是编造。文案一栏留给你/我复核时填。`);
  p('');
  p(`> 两个通道的配额是分开的：手机 App 与电脑软件（Windows）各算各的。`
    + `电脑软件条目**没有 APK 可解析**，所以包名/签名/SDK 一栏显示「不适用」，这是正常的。`);
  p('');
  p(`| 项目 | 值 |`);
  p(`| --- | --- |`);
  p(`| 交付数量 | ${apps.length} / 目标 ${cfg.quota}${bundle.delivered && bundle.delivered.desktopQuota ? ` 手机 + ${bundle.delivered.desktopQuota} 电脑` : ''} |`);
  p(`| GitHub Token | ${bundle.githubTokenProvided ? '已配置' : '**未配置**（核心 API 仅 60 次/小时，容易中途配额耗尽）'} |`);
  p(`| 核心 API 剩余 | ${bundle.rateLimit.coreRemaining ?? '未知'}${bundle.rateLimit.coreLimit ? ' / ' + bundle.rateLimit.coreLimit : ''} |`);
  p(`| 下载失败 | ${downloadFailures.length} |`);
  p(`| 落选 | ${rejected.length} |`);
  p(`| 产物目录 | \`${dayDir}\` |`);
  p('');

  /* ---------- 待办清单：先看这个 ---------- */
  const todos = [];
  for (const a of apps) {
    if (!a.netdisk.shareUrl) todos.push(`**${a.name}** 还没有网盘分享链接 —— 上传环节没成功，见下方「网盘」一节`);
    if (a.needsCopy) todos.push(`**${a.name}** 文案待写：\`curation.tagline\` / \`desc\` / \`features\` 三处空白`);
    todos.push(`**${a.name}** 分类待确认：脚本猜的是「${CAT_NAMES[a.catSuggestion] || a.catSuggestion}」，请核对`);
    if (!a.icon) todos.push(`**${a.name}** 缺图标 —— 站点会退化成首字标记，建议手动补一张到 \`redesign/assets/icons/${a.slug}.png\``);
    else if (a.icon.source === 'largest-square') todos.push(`**${a.name}** 图标来源不可靠（取自「res 下最大方形图」\`${a.icon.path}\`），请人工确认`);
    if (a.signature && a.signature.signed === false) todos.push(`**${a.name}** ⚠ 未检出签名，这种包很可能装不上，建议先装机验证`);
    if (!a.package && a.source !== 'desktop') todos.push(`**${a.name}** 包名未读到，详情页会缺一项信息`);
    // 桌面端刻意加一条：安装包没有签名可验、可能捆绑推广组件，这一步只能人做
    if (a.source === 'desktop') todos.push(`**${a.name}** 发布前请实机装一遍：桌面安装包无签名可验，安装器还可能捆绑推广组件 —— 这条脚本替不了你`);
    for (const f of a.riskFlags) todos.push(`**${a.name}** ${f}`);
    if (a.errors && a.errors.length) todos.push(`**${a.name}** 解析告警：${a.errors.join('；')}`);
  }
  p(`## 一、需要你做的事（共 ${todos.length} 项）`);
  p('');
  if (!todos.length) p('- 无，全部干净 ✅');
  else for (const t of todos) p(`- [ ] ${t}`);
  p('');

  /* ---------- 总览表 ---------- */
  p(`## 二、交付清单`);
  p('');
  if (!apps.length) {
    p('本轮没有产出条目。看看下面的落选原因，可能需要放宽筛选条件。');
    p('');
  } else {
    p('| # | 来源 | 名称 | 应用内名称 | 包名 | 版本 | Star | 协议 | 安装包大小 | 签名 | 图标 | minSdk | 网盘 |');
    p('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    apps.forEach((a, i) => {
      const src = a.source === 'fdroid' ? 'F-Droid' : a.source === 'desktop' ? '电脑软件' : 'GitHub';
      p(`| ${i + 1} | ${src} | ${escapeMd(a.name)} | ${escapeMd(a.appLabel || '—')} | \`${a.package || (a.source === 'desktop' ? '—（桌面端无包名）' : '—')}\` | ${a.versionName || '—'} | ${a.repo.stars ?? '—'} | ${a.repo.license || '—'} | ${a.apk ? humanSize(a.apk.bytes) : '未下载'} | ${a.signature ? (a.signature.signed ? a.signature.schemes.join('+') : '⚠ 未检出') : (a.source === 'desktop' ? '—（不适用）' : '—')} | ${a.icon ? (a.icon.source === 'largest-square' ? '⚠ 可疑' : '✓') : '✗ 缺'} | ${a.minSdk || '—'} | ${a.netdisk.shareUrl ? '✓' : '待传'} |`);
    });
    p('');
  }

  /* ---------- 逐个详情 ---------- */
  p(`## 三、逐个详情`);
  p('');
  for (const [i, a] of apps.entries()) {
    p(`### ${i + 1}. ${a.name}${a.appLabel && a.appLabel !== a.name ? `（应用内名称：${a.appLabel}）` : ''}`);
    p('');
    p(`- **发现来源**：${a.source === 'fdroid'
      ? `F-Droid 索引（${a.fdroid ? a.fdroid.indexSource : '—'}，快照 ${a.fdroid && a.fdroid.indexFetchedAt ? a.fdroid.indexFetchedAt.slice(0, 10) : '—'}）`
      : a.source === 'desktop'
        ? '电脑软件通道（GitHub Release 的 Windows 资产）'
        : 'GitHub Search'}`);
    p(`- **仓库**：${a.repo.url}  ★${a.repo.stars ?? '未知'} · fork ${a.repo.forks ?? '—'} · open issues ${a.repo.openIssues ?? '—'}`);
    p(`- **协议**：${a.repo.license || '未标注'}　**语言**：${a.repo.lang || '未知'}　**最近更新**：${(a.repo.pushedAt || '').slice(0, 10) || '未知'}`);
    p(`- **GitHub 原始描述**：${a.repoDesc || '（无）'}`);
    if (a.factsForCopy) {
      const f = a.factsForCopy;
      if (f.fdroidZhSummary) p(`- **F-Droid 官方中文摘要**（人工翻译，可直接作为文案事实来源）：${f.fdroidZhSummary}`);
      if (f.fdroidSummary) p(`- **F-Droid 英文摘要**：${f.fdroidSummary}`);
      if (f.fdroidZhDescription) {
        p(`- **F-Droid 官方中文描述**（人工翻译，写 desc/features 时的事实来源）：`);
        p('');
        p('  ```');
        for (const line of String(f.fdroidZhDescription).split(/\r?\n/).slice(0, 30)) p('  ' + line);
        p('  ```');
      }
      if (f.categories && f.categories.length) p(`- **F-Droid 分类**：${f.categories.join('、')}`);
      if (f.antiFeatures && f.antiFeatures.length) p(`- **F-Droid 反特性标记**：${f.antiFeatures.join('、')}`);
      if (f.website) p(`- **官网**：${f.website}`);
      if (f.issueTracker) p(`- **问题反馈**：${f.issueTracker}`);
    }
    if (a.fdroid) {
      p(`- **F-Droid 索引信息**：包名 \`${a.fdroid.packageName}\`　versionCode ${a.fdroid.versionCode}　minSdk ${a.fdroid.minSdk ?? '—'} / targetSdk ${a.fdroid.targetSdk ?? '—'}${a.fdroid.nativecode && a.fdroid.nativecode.length ? `　架构 ${a.fdroid.nativecode.join('/')}` : ''}`);
      if (a.fdroid.srcname) p(`- **源码压缩包**：\`${a.fdroid.srcname}\`（GPL/AGPL 合规要的「对应源码」，已在 README.txt 里给出地址）`);
    }
    if (a.repo.topics && a.repo.topics.length) p(`- **topics**：${a.repo.topics.slice(0, 12).join(', ')}`);
    p(`- **Release**：${a.release.tag}${a.release.publishedAt ? `（${a.release.publishedAt.slice(0, 10)}）` : ''}`);
    // 桌面端没有 APK，措辞随之改成「安装包」—— 打印「APK」会让人以为产物漏了
    p(`- **${a.source === 'desktop' ? '安装包' : 'APK'}**：\`${a.apk ? path.basename(a.apk.file) : a.asset.name}\`　${humanSize(a.asset.size)}${a.asset.downloads != null ? `　下载数 ${a.asset.downloads}` : ''}`);
    if (a.apk) {
      p(`- **SHA-256**：\`${a.apk.sha256}\``);
      const how = a.source === 'fdroid'
        ? 'F-Droid 索引官方 sha256 比对通过（第三方独立来源，可信度高于只信 GitHub）'
        : (a.asset.digest ? 'GitHub 官方 digest 比对通过' : 'GitHub 未提供 digest，仅比对文件大小');
      p(`- **校验**：${how}　**下载通道**：${a.apk.mirror}${a.apk.resumed ? '（含断点续传）' : ''}`);
    }
    if (a.otherApks && a.otherApks.length > 1) {
      p(`- **同仓库其它资产**（可能含历史版本）：${a.otherApks.filter(n => n !== a.asset.name).slice(0, 6).map(n => `\`${n}\``).join('、')}`);
    }
    if (a.source === 'desktop') {
      const d = a.desktop || {};
      p(`- **形态**：**${d.assetKind === 'portable' ? '便携版 / 免安装' : '安装器'}**　原始资产名 \`${a.asset.name}\``);
      if (d.mainExecutable) p(`- **解包后的主程序**：\`${d.mainExecutable}\`（便携版已解到上传目录的 \`app/\` 下，用户可直接运行）`);
      else if (d.archiveNote) p(`- **压缩包**：${d.archiveNote}`);
      if (d.peVersionInfo) {
        const pe = d.peVersionInfo;
        p(`- **exe 内自带的版本信息**（读取自 PE 的 VERSIONINFO，独立于 release tag）：${['ProductName', 'FileVersion', 'ProductVersion', 'CompanyName'].filter(k => pe[k]).map(k => `${k} = ${pe[k]}`).join('　')}`);
        // tag 与 exe 内版本不一致不算错（tag 是作者自拟的），但要摆出来 —— 详情页展示哪个版本由人定
        const peVer = pe.FileVersion || pe.ProductVersion;
        if (peVer && a.release.tag && !String(peVer).includes(String(a.release.tag).replace(/^v/i, '').replace(/[^\w.]/g, ''))) {
          p(`  - ⚠ release tag 是 \`${a.release.tag}\`，exe 内写的是 \`${peVer}\` —— 两者不同。详情页展示哪个版本请你定（tag 是仓库作者自拟的，exe 内是程序实际自报的）。`);
        }
      }
      if (d.archiveKept === false) p(`- **原始压缩包已删除**：内容已完整解包到 \`app/\`（避免同一份文件占两倍上传体积）。原始资产名 \`${d.originalAsset}\` 已记入 README.txt 备查。`);
      if (d.pickedBy) p(`- **资产是怎么挑的**：${d.pickedBy}`);
      p(`- **包名 / SDK / 签名**：桌面端不适用（没有 AndroidManifest，也没有 APK 签名可验）。**安装包本身未经签名核验，发布前建议实机装一遍。**`);
    } else {
      p(`- **包名 / 版本**：\`${a.package || '未读到'}\` / ${a.versionName || '?'} (code ${a.versionCode || '?'})`);
      p(`- **SDK**：min ${a.minSdk || '?'}　target ${a.targetSdk || '?'}`);
    }
    const plat = a.platform || 'Android';
    // 桌面端的 platform 就是「这是给电脑用的」这件事本身，
    // 不能套用 Android TV / Wear 那句「不是普通手机应用」的提示（那是另一回事）
    p(`- **支持平台**：${plat === 'Android' ? 'Android'
      : a.source === 'desktop' ? `**${plat}**（电脑软件，与站内 Android 条目不是同一端，别下错）`
        : `**${plat}**（manifest 里对应硬件特性是必需项，**不是普通手机应用**，手机装了用不了）`}`);
    if (a.signature) p(`- **签名**：${a.signature.signed ? '已签名（' + a.signature.schemes.join(' + ') + '）' : '**未检出签名**'}`);
    if (a.icon) {
      p(`- **图标**：\`${a.icon.file}\`　${a.icon.w ? a.icon.w + '×' + a.icon.h : '尺寸未知'}　密度 ${a.icon.density || '?'}`);
      p(`  - 来源：\`${a.icon.source}\`${a.icon.path ? ` → ${a.source === 'desktop' ? '源码仓库' : 'APK 内'} \`${a.icon.path}\`` : ''}`);
    } else {
      p(`- **图标**：未取到`);
    }
    if (a.licenseFile) p(`- **协议原文**：\`licenses/${a.licenseFile}\`（已一并放进上传目录）`);
    if (a.notes && a.notes.length) {
      p(`- **采集说明**：`);
      for (const n of a.notes) p(`  - ${n}`);
    }
    if (a.riskFlags.length) {
      p(`- **⚠ 风险标记**：`);
      for (const f of a.riskFlags) p(`  - ${f}`);
    }
    p(`- **分类建议**：「${CAT_NAMES[a.catSuggestion] || a.catSuggestion}」${a.catSuggestionConfidence === 'medium' ? '（来自 F-Droid 结构化分类，仍建议你确认）' : '（脚本按关键词猜的，**必须人工确认**）'}`);
    p(`- **文案**：⬜ 待写 —— \`tagline\`（一句话定位）、\`desc\`（介绍）、\`features\`（特性）`);
    p(`- **网盘**：${a.netdisk.shareUrl ? `${a.netdisk.shareUrl}${a.netdisk.pwd ? `　提取码 \`${a.netdisk.pwd}\`` : ''}` : '⬜ 待上传/待填'}`);
    p(`- **网盘远端路径**：\`${a.netdisk.remotePath || '—'}\``);
    p('');
  }

  /* ---------- 网盘 ---------- */
  p(`## 四、网盘（百度网盘 / BaiduPCS-Go）`);
  p('');
  const nd = bundle.netdisk || {};
  if (nd.attempted) {
    p(`- 可执行文件：\`${nd.binPath || '未找到'}\``);
    p(`- 登录状态：${nd.logins === 'yes' ? '已登录' : nd.logins === 'no' ? '未登录' : '无法判定'}`);
    p(`- 远端目录：\`${nd.remoteDateDir || '—'}\``);
    p(`- 上传成功：${nd.uploaded ?? 0} 个　分享链接创建成功：${nd.shared ?? 0} 个`);
  } else {
    p(`- **本轮没有自动执行**：${nd.reason || '未启用'}`);
  }
  if (nd.errors && nd.errors.length) {
    p('');
    p(`**问题：**`);
    for (const e of nd.errors) p(`- ${e}`);
  }
  p('');
  p(`兜底脚本（自动失败时右键运行）：\`${path.join(dayDir, 'upload.ps1')}\``);
  p('');

  /* ---------- 下一步 ---------- */
  p(`## 五、接下来怎么做`);
  p('');
  p('```powershell');
  p('# 1) 写文案 + 定分类：编辑 bundle.json 里每个 app 的');
  p('#    tagline / desc / features / catSuggestion（后两者确认后改 curation 用的 cat）');
  p(`#    文件：${path.join(dayDir, 'bundle.json')}`);
  p('');
  p('# 2) 合并进站点数据（会拒绝空文案、重复 slug、缺分享链接的条目）');
  p(`node redesign\\tools\\daily\\merge.mjs --date=${date}`);
  p('');
  p('# 3) 重建并校验站点');
  p('npm run build');
  p('npm run check');
  p('```');
  p('');

  /* ---------- 落选原因 ---------- */
  p(`## 六、落选原因（共 ${rejected.length} 个，用于校准筛选规则）`);
  p('');
  const grouped = new Map();
  for (const r of rejected) {
    const key = r.why.replace(/（[^）]*）/g, '（…）').replace(/：.*$/, '');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }
  const sorted = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [why, list] of sorted) {
    p(`- **${why}** × ${list.length}`);
    for (const r of list.slice(0, 6)) p(`  - ${r.fullName}${r.stars != null ? `（★${r.stars}${r.license ? ', ' + r.license : ''}）` : ''}`);
    if (list.length > 6) p(`  - …还有 ${list.length - 6} 个`);
  }
  p('');
  if (downloadFailures.length) {
    p(`## 七、下载/解析失败（${downloadFailures.length} 个）`);
    p('');
    for (const d of downloadFailures) p(`- \`${d.fullName}\`：${d.why.split('\n')[0]}`);
    p('');
  }

  const file = path.join(dayDir, 'draft.md');
  fs.writeFileSync(file, L.join('\n'), 'utf8');
  return file;
}
