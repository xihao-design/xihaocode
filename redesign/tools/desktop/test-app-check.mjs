#!/usr/bin/env node
/* ============================================================
   电脑软件「像不像应用」判定 · 回归测试
   ------------------------------------------------------------
   为什么要有这个：desktopAppCheck 的每条规则都对应一个**实际漏进来的仓库**，
   而"顺手放宽一点"很容易把它们放回来（第一版就是只扣分不硬判，winget 直接过）。
   下面每个用例都是一次真实漏检的复现，改判定逻辑后必须跑这个。

   用例来源（2026-09 干跑实测）：
     · microsoft/winget-cli 混进来 —— 自述是「a CLI (Command Line Interface)」，
       一个 GUI 信号都没有，但挂着 topic:windows，描述里没有 "cli tool" 这种词组
     · 同一个仓库挑中的资产是 DesktopAppInstaller_Dependencies.zip ——
       一包运行时依赖，名字和体积都正常，用户下了装不上任何东西
     · GPUi 之类的项目必须仍然通过：判定不能矫枉过正把正经桌面应用一起拒掉
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopAppCheck } from './signals.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktop = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'daily', 'config.json'), 'utf8')).desktop;
const desktopCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const R = (name, desc, topics = [], lang = '') => ({ name, fullName: `x/${name}`, desc, topics, lang });

let pass = 0, fail = 0;
function t(label, repo, expect) {
  const got = desktopAppCheck(repo, { desktop, desktopCfg });
  const ok = got.ok === expect;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log(`      期望 ${expect ? '收录' : '拒收'} · 实际 ${got.ok ? '收录' : '拒收'}（分 ${got.score}，cli=${got.cli || '—'}，nonApp=${got.nonApp ? got.nonApp[0] : '—'}）`); fail++; }
  else pass++;
  return got;
}

console.log('电脑软件应用判定 · 回归测试\n');

t('命令行工具必须拒收（坑：winget-cli 自述里只有 "a CLI (Command Line Interface)"）',
  R('winget-cli', 'WinGet is the Windows Package Manager. This project includes a CLI (Command Line Interface), PowerShell modules, and a COM API.', ['command-line', 'package-manager', 'windows', 'winget'], 'C++'),
  false);

t('名字带 cli 且无 GUI 信号 → 拒收',
  R('codex-cli', 'A fast tool for working with large language models.', ['windows', 'ai'], 'Rust'),
  false);

t('topic 里声明 command-line → 拒收',
  R('some-tool', 'A handy utility that does one thing well.', ['command-line', 'windows'], 'Go'),
  false);

t('服务端应用降权但不硬拒（坑：rustdesk 描述里有 self-host，主体是桌面客户端）',
  R('rustdesk', 'Yet another remote desktop software. Self-host your own relay server for better performance.', ['windows', 'remote-desktop', 'cross-platform'], 'Rust'),
  true);

t('非应用（库/框架）必须拒收',
  R('some-ui-kit', 'A library of reusable UI components for desktop applications.', ['windows', 'gui'], 'C++'),
  false);

t('正经 Windows 下载管理器必须收录（不能矫枉过正）',
  R('gopeed', 'A fast, modern download manager for HTTP, BitTorrent, Magnet, and ed2k. Cross-platform, built with Golang and Flutter.', ['android', 'bittorrent', 'cross-platform', 'downloader', 'windows'], 'Dart'),
  true);

t('正经 Windows 桌面应用（GUI 工具）必须收录',
  R('imhex', 'A hex editor for reverse engineers, programmers and people who value their retinas when working at 3AM.', ['windows', 'cross-platform', 'gui', 'hex-editor'], 'C++'),
  true);

t('仓库名像 awesome 清单 → 拒收',
  R('awesome-windows', 'A curated list of awesome Windows applications.', ['windows'], ''),
  false);

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
