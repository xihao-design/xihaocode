/* ============================================================
   手动上传模式
   ------------------------------------------------------------
   你选择自己用百度网盘客户端上传，所以脚本负责三件事：
     1. 把每个 App 整理成「一个文件夹」（APK + README.txt + LICENSE.txt），
        整个文件夹拖进网盘即可，不用自己找文件
     2. 生成 links.txt 登记表：把分享链接粘进去就行，整段粘贴都能认
     3. 生成 上传说明.md：当天这一批的操作步骤与注意事项

   为什么登记表用「### 分块」而不是 CSV/TSV：
   手填的表最怕的是错位（少一个逗号整张表就串行）和转义。
   分块格式只需要你把光标放到「链接: 」后面粘贴，不存在列错位问题，
   而且能容忍你粘贴一整段带「链接：」「提取码：」的手机分享口令。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, humanSize } from './util.mjs';

/* ---------- 从粘贴内容里认链接与提取码 ---------- */

/**
 * 从任意粘贴文本里抽出网盘分享链接与提取码。
 * 要能认这些形态（都是百度实际会给出的）：
 *   https://pan.baidu.com/s/1abc?pwd=xy12
 *   链接：https://pan.baidu.com/s/1abc 提取码：xy12
 *   https://pan.baidu.com/share/init?surl=1abc      （手机口令里的形态）
 *   复制这段内容后打开百度网盘手机App，操作更方便哦 链接:https://pan.baidu.com/s/1abc?pwd=xy12
 */
export function parseShareText(text) {
  const s = String(text || '');
  let shareUrl = null;
  let pwd = null;

  // share/init?surl=xxx 形态先转成标准短链
  const initM = s.match(/https?:\/\/pan\.baidu\.com\/share\/init\?[^\s，,、)"'<>]*surl=([A-Za-z0-9_-]+)/i);
  if (initM) shareUrl = `https://pan.baidu.com/s/${initM[1]}`;

  if (!shareUrl) {
    const m = s.match(/https?:\/\/pan\.baidu\.com\/s\/[A-Za-z0-9_-]+(?:\?[^\s，,、)"'<>]*)?/i);
    if (m) shareUrl = m[0];
  }

  if (shareUrl) {
    const pm = shareUrl.match(/[?&]pwd=([A-Za-z0-9]{4})/i);
    if (pm) pwd = pm[1];
    // 站点把链接和提取码分开存储展示，所以这里存干净的链接
    shareUrl = shareUrl.split(/[?#]/)[0].replace(/[.,;，。；、]+$/, '');
  }

  if (!pwd) {
    // 关键词必须是独立词，不能是更长字母数字串的一部分。
    // 踩过的坑：`.../s/1NoPwdHere` 里含有 "Pwd"，不加边界就会把后面的 "Here" 当成提取码
    // —— 访客拿着错的提取码根本打不开链接，比留空严重得多。
    const pm = s.match(/(?:^|[^A-Za-z0-9])(?:提取码|密码|pwd)\s*[:：=]?\s*([A-Za-z0-9]{4})(?![A-Za-z0-9])/i);
    if (pm) pwd = pm[1];
  }

  // 认不出提取码就留空，绝不猜。
  // 猜错会让访客打不开，宁可让 publish 明确报出来让你补。
  return { shareUrl, pwd };
}

/**
 * 解析「提取码: 」那一行。
 * 刻意严格：只接受「整行就是一个 4 位码」，或行内明确带「提取码/密码/pwd」字样的，
 * 其余一律返回 null。绝不从任意位置抓一个 4 位字母数字当提取码
 * （否则把 URL 片段当提取码写进站点，访客是打不开的）。
 */
export function extractPwd(s) {
  const t = String(s || '').trim().replace(/^["'「『]+|["'」』]+$/g, '');
  if (!t) return null;
  const exact = t.match(/^[A-Za-z0-9]{4}$/);
  if (exact) return exact[0];
  const ctx = t.match(/(?:提取码|密码|pwd)\s*[:：=]?\s*([A-Za-z0-9]{4})(?![A-Za-z0-9])/i);
  return ctx ? ctx[1] : null;
}

/* ---------- 写登记表 ---------- */

export function writeLinksSheet(apps, { dayDir, date }) {
  const L = [];
  const p = s => L.push(s);
  p('# ============================================================');
  p(`#  百度网盘分享登记表 · ${date}`);
  p('# ============================================================');
  p('#');
  p('#  怎么填：在每个 ### 标题下面，把光标放到「链接: 」后面，');
  p('#          粘贴你从百度网盘复制来的分享内容即可。');
  p('#          整段粘贴就能认（带「链接：」「提取码：」，或者手机 App 的分享口令）。');
  p('#');
  p('#  不要改 ### 这一行 —— 程序靠它对应到具体是哪个 App。');
  p('#  不想收录某个 App，把它整块删掉即可。');
  p('#');
  p('#  填完执行（一条命令：校验 → 合并进站点数据 → 重建站点 → 校验产物）：');
  p(`#      node redesign\\tools\\daily\\publish.mjs --date=${date}`);
  p('#');
  p(`#  上传目录：${path.join(dayDir, 'upload')}`);
  p('#  把里面每个文件夹整个传到你的百度网盘（建议路径：/XihaoUC/' + date + '/）。');
  p('');
  for (const a of apps) {
    const apkName = a.apk ? path.basename(a.apk.file) : (a.asset ? a.asset.name : '');
    p(`### ${a.slug} | ${a.name} | ${apkName}`);
    p('链接: ');
    p('提取码: ');
    p('');
  }
  const file = path.join(dayDir, 'links.txt');
  fs.writeFileSync(file, L.join('\r\n'), 'utf8');
  return file;
}

/** 读回登记表。解析很宽松：只认 ### 标题分块，块内按关键词找链接与提取码 */
export function readLinksSheet(dayDir) {
  const file = path.join(dayDir, 'links.txt');
  if (!fs.existsSync(file)) return { file, exists: false, items: [] };

  const text = fs.readFileSync(file, 'utf8');
  const blocks = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/^#{2,}\s*([A-Za-z0-9._-]+)\s*\|\s*([^|]*)\|\s*(.*?)\s*$/);
    if (head) {
      cur = { slug: head[1], name: head[2].trim(), apk: head[3].trim(), body: [] };
      blocks.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.body.push(line);
  }

  for (const b of blocks) {
    const body = b.body.join('\n');
    // 用非贪婪 + 前瞻，容忍把整段分享口令（可能含换行）粘在「链接: 」后面
    const linkPart = (body.match(/链接\s*[:：]([\s\S]*?)(?=\n\s*提取码\s*[:：]|\n\s*#{2,}|$)/) || [, ''])[1];
    const pwdPart = (body.match(/提取码\s*[:：]([\s\S]*?)(?=\n\s*链接\s*[:：]|\n\s*#{2,}|$)/) || [, ''])[1];
    const parsed = parseShareText(`${linkPart}\n${pwdPart}\n${body}`);
    b.shareUrl = parsed.shareUrl;
    b.pwd = extractPwd(pwdPart) || parsed.pwd || '';
    b.filled = !!b.shareUrl;
    b.rawLink = linkPart.trim();
    b.rawPwd = pwdPart.trim();
  }
  return { file, exists: true, items: blocks };
}

/* ---------- 写当天操作说明 ---------- */

export function writeManualGuide(apps, { dayDir, date, cfg }) {
  const remoteRoot = (cfg.netdisk && cfg.netdisk.remoteRoot) || '/XihaoUC';
  const L = [];
  const p = s => L.push(s);

  p(`# 手动上传操作说明 · ${date}`);
  p('');
  p(`这批共 **${apps.length}** 个（手机 App ${apps.filter(a => a.source !== 'desktop').length} 个 + 电脑软件 ${apps.filter(a => a.source === 'desktop').length} 个），已经下载、校验、解析完毕，就等你上传。`);
  p('');
  p('## 一、上传到百度网盘');
  p('');
  p(`1. 打开这个目录：\`${path.join(dayDir, 'upload')}\``);
  p('   里面每个条目一个文件夹，每个文件夹里有：安装包（APK / exe / 便携版压缩包）、`README.txt`（来源与协议凭据）、`LICENSE.txt`（若有）。');
  p('   - 便携版 zip 已解包到文件夹里的 `app/` 下（README.txt 写明了主程序名），用户解压即用，不用再猜压缩包里是什么');
  p(`2. 在百度网盘里建好目录 \`${remoteRoot}/${date}/\`，把每个条目的**文件夹整个**拖进去。`);
  p('3. 在网盘里对每个条目的文件夹单独建分享链接（右键 → 分享）。');
  p('   - 建议设提取码（不设就是公开链接，容易被路人翻到）');
  p('   - 有效期按你的需要选');
  p('');
  p('## 二、把链接登记下来');
  p('');
  p(`打开 \`${path.join(dayDir, 'links.txt')}\`（记事本就行），在每个 App 的「链接: 」后面粘贴分享内容。`);
  p('整段粘贴即可 —— 带「链接：」「提取码：」，或者手机 App 的分享口令都能认出来。');
  p('');
  p('## 三、一条命令发布到网站');
  p('');
  p('```powershell');
  p(`node redesign\\tools\\daily\\publish.mjs --date=${date}`);
  p('```');
  p('');
  p('它会依次做：校验登记表 → 合并进站点数据 → 重建 `redesign/dist` → 校验产物。');
  p('最后把 `redesign\\dist\\` 重新部署上去，页面就更新了。');
  p('');
  p('> 先看看会发生什么而不写盘：加 `--dry-run`。');
  p('');
  p('## 四、这批清单');
  p('');
  p('| # | 名称 | 平台 | 文件夹 | 安装包 | 大小 | 协议 | 图标 |');
  p('| --- | --- | --- | --- | --- | --- | --- | --- |');
  apps.forEach((a, i) => {
    const apkName = a.apk ? path.basename(a.apk.file) : '（未下载）';
    p(`| ${i + 1} | ${a.name} | ${a.platform || 'Android'} | \`upload/${a.slug}/\` | \`${apkName}\` | ${a.apk ? humanSize(a.apk.bytes) : '—'} | ${a.repo.license || '—'} | ${a.icon ? '有' : '缺，需人工补'} |`);
  });
  p('');

  const obligations = apps.filter(a => /GPL|AGPL|LGPL/.test(String(a.repo.license || '')));
  if (obligations.length) {
    p('## 五、协议义务（别删 README.txt）');
    p('');
    p('以下项目的协议要求向接收者提供对应源码，所以上传目录里的 `README.txt` **不能删** ——');
    p('它写明了源码仓库、源码压缩包地址和 APK 的 SHA-256，既是合规凭据，也是你日后自查的依据。');
    p('');
    for (const a of obligations) p(`- ${a.name}（${a.repo.license}）`);
    p('');
  }

  const noIcon = apps.filter(a => !a.icon);
  if (noIcon.length) {
    p('## 六、需要人工补的东西');
    p('');
    for (const a of noIcon) {
      p(`- **${a.name}** 缺图标：${a.source === 'desktop'
        ? '源码仓库里没有官方图标（桌面端没有 APK 可抠图）。'
        : '没能在 APK 内找到位图（多为纯矢量自适应图标），源码仓库里也没有。'}`);
      p(`  手动放一张 PNG 到 \`redesign\\assets\\icons\\${a.slug}.png\` 即可；不放的话站点会显示首字标记。`);
    }
    p('');
  }

  const desktopApps = apps.filter(a => a.source === 'desktop');
  if (desktopApps.length) {
    p('## 七、电脑软件特别注意');
    p('');
    p('本批含 **Windows 安装包**，和站内此前的 Android 条目不是同一端：');
    p('');
    for (const a of desktopApps) {
      p(`- **${a.name}**（${a.desktop && a.desktop.assetKind === 'portable' ? '便携版' : '安装器'}）：发布前**实机装一遍**。`
        + `桌面安装包没有 APK 签名那种可自动核验的东西，安装器还可能捆绑推广组件 —— 这条脚本替不了你。`);
    }
    p('- 详情页/频道页要能一眼看出平台是 Windows，别让手机用户下错端');
    p('- 体积比 APK 大一个量级，上传前先看看剩余空间与耗时，必要时分两天');
    p('');

    p('## 八、一个提醒');
  } else {
    p('## 七、一个提醒');
  }
  p('');
  p('百度网盘对 APK / exe 分享都比较敏感，批量建分享可能触发风控（限速、分享被和谐）。');
  p('建议：');
  p('');
  p('- 别一天建太多分享，分几天也行（`links.txt` 可以慢慢填；某一批只填了一部分时，');
  p('  用 `publish --allow-missing` 先发布已填链接的那些，其余留着下次再发）');
  p('- 本地 `_daily\\` 目录留着做备份，定期抽查分享链接是否还有效');
  p('- 如果某个条目的分享反复被和谐，可以考虑打包成 zip 再分享');
  p('');

  const file = path.join(dayDir, '上传说明.md');
  fs.writeFileSync(file, L.join('\n'), 'utf8');
  return file;
}
