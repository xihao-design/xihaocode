/* ============================================================
   电脑软件频道 · 信号与资产规则的**唯一一份**
   ------------------------------------------------------------
   为什么单独抽一个文件：这些正则原先在 discover.mjs（探测脚本）和
   channels.mjs（流水线）里各写了一份，已经漂移过一次 ——
   x64 平台判定只在 channels.mjs 里有，探测脚本那份漏了。
   同一个判断写两遍，迟早会给出两个答案。

   现在约定：
     · 资产扩展名 / 拒收正则 / 平台判定 → channels.mjs 从这里 import
     · 探测脚本（discover.mjs）与每日接线（daily/desktop.mjs）都从这里读
   改规则只改这一个文件。
   ============================================================ */

/** 可执行资产。[正则, 形态, 平台线索（null = 看文件名判断）] */
export const DESKTOP_ASSET_RULES = [
  [/\.exe$/i, 'installer', 'win'],
  [/\.msi$/i, 'installer', 'win'],
  [/\.zip$/i, 'portable', null],
  [/\.7z$/i, 'portable', null],
  [/\.appimage$/i, 'portable', 'linux'],
  [/\.dmg$/i, 'installer', 'mac'],
  [/\.pkg$/i, 'installer', 'mac'],
  [/\.deb$/i, 'installer', 'linux'],
  [/\.rpm$/i, 'installer', 'linux'],
  [/\.tar\.gz$/i, 'portable', null],
];

/** 明确排除：源码包、签名、校验、调试符号、语言包、草案版本。
 *  「Source code (zip)」必须在这里挡掉 —— GitHub 给每个 Release 自动附它，名字里就带 zip。 */
export const DESKTOP_REJECT_RE = /source\s*code|\.sig$|\.asc$|\.sha(256|512)?$|\.md5$|\.pdb$|\.dSYM$|symbols|\.diff$|\.patch$|\.json$|\.txt$|\.yml$|\.yaml$|beta|alpha|nightly|canary|\.torrent$/i;

/**
 * 资产名里出现这些，说明它**不是主程序包**，而是配套件。
 * 实测来源：microsoft/winget-cli 的 Release 里最"像便携版"的资产是
 * `DesktopAppInstaller_Dependencies.zip` —— 名字与扩展名都完全正常，
 * 体积 93MB 也正常，其实是一包运行时依赖。用户下了它装不上任何东西。
 * 这类只能从资产名拦：dependencies / redist / runtime / symbols / debug / symbols。
 */
export const DESKTOP_NON_MAIN_ASSET_RE = /dependenc|redist|runtime|\bsdk\b|symbols|debug|libs?\b|docs?\b|manual|portableapps\.com|checksums/i;

/** 仓库名里出现这些，八成是「库 / 框架 / 主题 / 文档 / 清单」，不是能装的应用 */
export const DESKTOP_REPO_REJECT_RE = /(^|\/)(awesome|framework|sdk|library|lib|theme|themes|docs?|dotfiles|config|template|boilerplate|example|starter)/i;

/**
 * 平台判定：资产自带线索优先，否则看文件名。
 *
 * ⚠ 判定顺序是**先具体后泛化**，不能反过来：
 *   `brave-origin-v1.97.47-darwin-x64.zip` 同时含 `darwin` 与 `x64`。
 *   早前把「裸 x64 算 Windows」放在最前面，于是 macOS 的包被判成 Windows，
 *   直接进了 Windows 频道（实测干跑抓到的：给 Windows 用户挑了 darwin-x64 的 220MB 包）。
 *   所以先认明确的 mac / linux 词，再轮到「裸 x64」这条弱信号。
 */
export function desktopPlatform(name, hinted) {
  if (hinted) return hinted;
  if (/mac(os)?|osx|darwin|apple/i.test(name)) return 'mac';
  if (/linux|ubuntu|debian|fedora|appimage/i.test(name)) return 'linux';
  // 最后才轮到裸 x64：Linux/macOS 的惯例是 x86_64 / amd64 / universal，写裸 x64 的多半是 Windows。
  // 这条不能删 —— 漏了它，`App-x64-portable.zip` 会被判成"平台不确定"而输给平台确定的 setup.exe，
  // 「便携版优先」就被静默吃掉了（回归测试抓到的）。
  if (/win(dows)?|win64|win32|mingw|msvc|\bx64\b/i.test(name)) return 'win';
  return null;   // 没线索 → 可能是通用 zip，降一档但不排除
}

/**
 * 「像不像一个能装的桌面应用」。
 * 与 channels.mjs 的 pickApkRelease / androidAppCheck 是两套判断，不能互相套用：
 * 桌面端没有 APK 这种确凿证据，只能靠「有没有真能装的 Release 资产 + 描述像不像应用」。
 *
 * @param {{name:string, desc:string, topics?:string[], lang?:string}} repo
 * @param {{desktop:object, desktopCfg:object}} cfg  daily config 与 desktop/config.json
 * @returns {{score:number, ok:boolean}}
 */
export function desktopAppCheck(repo, { desktop, desktopCfg }) {
  const topics = (repo.topics || []).map(t => String(t).toLowerCase());
  const desc = String(repo.desc || '').toLowerCase();
  const name = String(repo.name || '').toLowerCase();
  const short = String(repo.name || '').split('/').pop();
  const hay = `${repo.name} ${repo.desc}`.toLowerCase();
  const listOf = list => (list || []).map(s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const SERVER_RE = new RegExp(`\\b(${listOf(desktopCfg.serverSignals)})\\b`, 'i');
  const NON_APP_RE = new RegExp(`\\b(${listOf(desktopCfg.nonAppSignals)})\\b`, 'i');
  const WIN_RE = new RegExp(`\\b(${listOf(desktop.winSignals)})\\b`, 'i');
  const APP_RE = new RegExp(`\\b(${listOf(desktop.appSignals)})\\b`, 'i');
  const CLI_RE = new RegExp(`\\b(${listOf(desktop.cliSignals)})\\b`, 'i');

  const cliHit = CLI_RE.exec(desc) || CLI_RE.exec(hay);
  const appHit = APP_RE.exec(hay);
  // 命令行工具的判定不能只看描述：microsoft/winget-cli 的自述写的是
  // 「This project includes a CLI (Command Line Interface), PowerShell modules…」，
  // 一个 GUI 信号都没有，却挂着 topic:windows 混进来（实测漏过一次）。
  // 所以名字里带 cli/tui/console，或 topics 里有 command-line/cli，都算命令行工具。
  // ⚠ 不能用 \bcli\b：`winget-cli` 里的 "cli" 后面就是结尾，**没有**词边界，
  //   正则匹配不上（回归测试抓到的 —— 这条踩了两次才写对）。
  const cliName = /(^|[-_.])(cli|tui|console|daemon|terminal)([-_.]|$)/i.test(name)
    || topics.some(t => ['command-line', 'cli', 'console', 'terminal', 'shell'].includes(t));

  /* 硬闸门：仓库名/自身声明说是命令行工具，且**任何地方**都没说自己是 GUI 程序 → 直接拒收。
     为什么要硬拒而不是扣分：winget-cli 的描述里有 "Package Manager"（manager 是我们的
     应用信号词），扣分之后仍能靠 topic:windows 等加分项凑成正数通过 —— 实测就是这个结果
     （分 4，收录）。「名字自己说它是 CLI」是作者的定位声明，比描述里偶然出现的词可信得多，
     扣分制在这里就是不够用。真 GUI 程序不会起名叫 xxx-cli（见 desktopAppCheck 的回归测试）。 */
  const hasGuiClaim = topics.some(t => ['gui', 'desktop-app', 'electron', 'tauri', 'windows-app', 'windows-desktop', 'flutter', 'qt'].includes(t))
    || /(graphical user interface|\bgui\b|^\s*desktop application|desktop app\b|tray icon|system tray|windowed)/i.test(desc);

  let score = 0;
  // 第一档：仓库自己声明了平台 —— 这是最硬的信号
  if (topics.some(t => ['windows', 'windows-app', 'windows-desktop', 'win32', 'desktop-app', 'cross-platform', 'electron', 'tauri', 'gui'].includes(t))) score += 5;
  if (WIN_RE.test(hay)) score += 3;
  if (['C++', 'C#', 'C', 'Rust', 'Go', 'TypeScript', 'JavaScript', 'Python', 'Dart'].includes(repo.lang)) score += 2;
  if (appHit) score += 2;

  // 第二档：本该被关键词拦住、但漏进来的类型
  if (NON_APP_RE.test(desc)) score -= 8;
  if (SERVER_RE.test(desc)) score -= 4;          // 只降权、不硬拒：rustdesk 描述里有 self-host，主体是桌面客户端
  if (cliHit && !appHit) score -= 6;
  // 名字/topic 判定不设 `!appHit` 前提：winget-cli 的描述里写着 "Package Manager"，
  // 会被 APP_RE 当成应用信号，于是「名字带 cli」这条被静默吃掉（回归测试抓到的）。
  // 仓库名与 topic 是作者自己的定位声明，比描述里偶然出现的词更可信。
  if (cliName) score -= 8;
  if (DESKTOP_REPO_REJECT_RE.test(short)) score -= 6;
  if (!appHit && !/\.(exe|msi)|\bapp\b/.test(hay)) score -= 2;

  // 给人看/写进审核表的"为什么判成命令行工具"：优先用命中词，名字或 topic 命中的另说
  const cliWhy = cliHit || (cliName ? (name.match(/(^|[-_.])(cli|tui|console|daemon|terminal)([-_.]|$)/i) || ['命令行工具'])[0] : null);
  const ok = score > 0 && !(cliName && !hasGuiClaim);
  return { score, ok, nonApp: NON_APP_RE.exec(desc), cli: cliWhy, server: SERVER_RE.exec(desc), cliHardReject: cliName && !hasGuiClaim };
}

/**
 * 挑出「最值得打包的那个 Windows 安装包」。
 *
 * ⚠ 原先这个函数（以及它的两条配套正则）在 desktop/discover.mjs 与
 *    daily/channels.mjs 里各有一份，平台判定已经漂移过一次。现在统一到 signals.mjs，
 *    两处都从那里取规则，函数本体也只有这一份。
 *
 * 四条规则都对应一个实际踩过的坑，别顺手简化：
 *   1) 平台是硬过滤，不是加分项 —— 第一版把便携版权重放在平台之上，结果给 Windows
 *      频道挑中了 Clash Verge 的 .dmg 和 rustdesk 的 .AppImage。
 *   2) 惩罚 arm64 —— 国内 Windows 以 x64 为主，cc-switch / v2rayN / ImHex 都中过招。
 *   3) 排除 Source code —— 见 DESKTOP_REJECT_RE 的注释。
 *   4) 体积上下限 —— 上限是网盘成本，下限 1MB（0.05MB 时漏进过 tldr 的保加利亚语语言包）。
 */
export function pickDesktopRelease(releases, cfg = {}) {
  const wantPlatform = (cfg.platform || 'win').toLowerCase();
  const maxMB = cfg.maxDesktopMB || 300;
  const minPortableMB = cfg.minPortableMB || 1;
  const minInstallerMB = cfg.minInstallerMB || 0.05;

  const scored = [];
  for (const rel of releases) {
    if (rel.draft || rel.prerelease) continue;
    for (const a of rel.assets || []) {
      if (DESKTOP_REJECT_RE.test(a.name)) continue;
      if (DESKTOP_NON_MAIN_ASSET_RE.test(a.name)) continue;   // 配套件不是主程序包
      const rule = DESKTOP_ASSET_RULES.find(([re]) => re.test(a.name));
      if (!rule) continue;
      const kind = rule[1];
      const plat = desktopPlatform(a.name, rule[2]);
      if (plat && plat !== wantPlatform) continue;          // 规则 1：硬过滤
      const mb = a.size / 1048576;
      if (mb > maxMB) continue;                              // 规则 4
      if (mb < (kind === 'portable' ? minPortableMB : minInstallerMB)) continue;

      let pref = plat === wantPlatform ? 100 : 20;           // 平台确定 > 无线索
      if (/x64|x86_64|amd64|win64/i.test(a.name)) pref += 12;
      if (/arm64|aarch64/i.test(a.name)) pref -= 6;          // 规则 2
      if (/ia32|x86[^_0-9]|win32/i.test(a.name)) pref -= 3;
      pref += kind === 'portable' ? 6 : 1;                   // 便携版优先（体积小、免安装）
      if (/setup|install/i.test(a.name)) pref -= 2;

      scored.push({ rel, asset: a, kind, plat, mb: +mb.toFixed(1), pref, publishedAt: rel.publishedAt || rel.createdAt });
    }
  }
  if (!scored.length) return null;
  scored.sort((x, y) => {
    if (y.pref !== x.pref) return y.pref - x.pref;
    if ((y.asset.downloads || 0) !== (x.asset.downloads || 0)) return (y.asset.downloads || 0) - (x.asset.downloads || 0);
    return new Date(y.publishedAt || 0) - new Date(x.publishedAt || 0);
  });
  const best = scored[0];
  return {
    release: best.rel, asset: best.asset, kind: best.kind, platform: best.plat, mb: best.mb,
    alternatives: scored.slice(0, 5).map(s => `${s.asset.name}（${s.kind} ${s.mb}MB）`),
  };
}
