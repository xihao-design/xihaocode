#!/usr/bin/env node
/* ============================================================
   电脑软件资产选择 · 回归测试
   ------------------------------------------------------------
   为什么要有这个：pickDesktopRelease 的每一条规则都对应一个**实际踩过的坑**，
   而坑是很容易被"顺手简化"回去的。下面每个用例就是那个坑的复现。
   改选择逻辑后必须跑这个（npm.cmd run desktop:test）。

   用例来源于 2026-09 的实测：
     · Clash Verge 曾挑中 .dmg、rustdesk 曾挑中 .AppImage（给 Windows 频道挑 mac/linux）
     · cc-switch / v2rayN / ImHex 曾挑中 arm64（国内 Windows 以 x64 为主）
     · GitHub 给每个 Release 自动附 Source code (zip)，不排除则每个仓库都"看起来有资产"
     · tldr-pages 的保加利亚语语言包 0.1MB 曾通过体积下限
   ============================================================ */
import { pickDesktopRelease } from '../daily/channels.mjs';

const A = (name, mb, downloads = 100) => ({ name, size: Math.round(mb * 1048576), downloads, digest: null });
const rel = (assets, tag = 'v1.0.0') => [{ tag_name: tag, draft: false, prerelease: false, publishedAt: '2026-09-01T00:00:00Z', assets }];

let pass = 0, fail = 0;
function t(name, releases, expect) {
  const got = pickDesktopRelease(releases, {});
  const picked = got ? got.asset.name : null;
  const ok = picked === expect;
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) { console.log(`      期望 ${expect ?? '(不选)'} · 实际 ${picked ?? '(不选)'}`); fail++; } else pass++;
}

console.log('电脑软件资产选择 · 回归测试\n');

t('平台硬过滤：有 dmg 和 exe 时必选 exe（坑：曾挑中 Clash 的 dmg）',
  rel([A('Clash.Verge_2.5.5_x64.dmg', 200), A('Clash.Verge_2.5.5_x64-setup.exe', 50)]),
  'Clash.Verge_2.5.5_x64-setup.exe');

t('平台硬过滤：只有 mac/linux 资产时不选（坑：曾挑中 rustdesk 的 AppImage）',
  rel([A('rustdesk-1.4.9-x86_64.AppImage', 80), A('rustdesk-1.4.9.dmg', 90)]),
  null);

t('平台判定先具体后泛化：darwin-x64 不算 Windows（坑：干跑时给 Windows 挑了 brave 的 darwin-x64 包）',
  rel([A('brave-origin-v1.97.47-darwin-x64.zip', 220), A('brave-origin-v1.97.47-win32-x64.zip', 200)]),
  'brave-origin-v1.97.47-win32-x64.zip');

t('平台硬过滤：只有 darwin-x64（无 Windows 资产）时返回空',
  rel([A('brave-origin-v1.97.47-darwin-x64.zip', 220)]),
  null);

t('架构：x64 必须压过 arm64（坑：cc-switch / v2rayN / ImHex 都曾挑中 arm64）',
  rel([A('CC-Switch-v3-Windows-arm64-Portable.zip', 13), A('CC-Switch-v3-Windows-x64-Portable.zip', 14)]),
  'CC-Switch-v3-Windows-x64-Portable.zip');

t('源码包除外：只有 Source code 时返回空（坑：不排除则每个仓库都"看起来有资产"）',
  rel([A('Source code (zip)', 2), A('Source code (tar.gz)', 3)]),
  null);

t('体积下限：语言包/词典分片不算资产（坑：tldr 的保加利亚语包 0.1MB）',
  rel([A('tldr-pages.bg.zip', 0.1), A('tldr-x64.exe', 10)]),
  'tldr-x64.exe');

t('体积下限：只剩小文件时返回空',
  rel([A('tldr-pages.bg.zip', 0.1)]),
  null);

t('体积上限：超过 300MB 不选',
  rel([A('HugeApp-x64.exe', 500)]),
  null);

t('便携版优先于安装器（同平台同架构）',
  rel([A('App-x64-setup.exe', 30), A('App-x64-portable.zip', 40)]),
  'App-x64-portable.zip');

t('无线索 zip 让位于平台确定的 exe',
  rel([A('App.zip', 20), A('App-x64.exe', 30)]),
  'App-x64.exe');

t('预发布版本跳过',
  [{ tag_name: 'v2.0.0-beta', draft: false, prerelease: true, assets: [A('App-x64.exe', 30)] },
   ...rel([A('App-x64.exe', 25)], 'v1.9.0')],
  'App-x64.exe');

t('签名与校验文件不算资产',
  rel([A('App-x64.exe', 30), A('App-x64.exe.sig', 0.01), A('checksums.sha256', 0.01)]),
  'App-x64.exe');

t('配套件不是主程序包：Dependencies/redist 一律跳过（坑：winget-cli 挑中 Dependencies.zip）',
  rel([A('DesktopAppInstaller_Dependencies.zip', 93), A('DesktopAppInstaller.msixbundle', 40)]),
  null);

t('配套件跳过但主程序仍要选中',
  rel([A('App-1.2-x64-portable.zip', 40), A('App-1.2-redist-x64.exe', 20)]),
  'App-1.2-x64-portable.zip');

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
