<#
================================================================
 注册（或卸载）每日采集计划任务
 ----------------------------------------------------------------
 为什么用「只在用户登录时运行」：
   百度网盘凭据存在 %APPDATA%\BaiduPCS-Go，是当前用户的配置。
   用「不管用户是否登录都运行」要么得存密码，要么读不到那份配置。
   所以任务设定为：你登录着、机器开着，到点就自动跑。

 用法（普通权限即可，不需要管理员）：
   powershell -ExecutionPolicy Bypass -File redesign\tools\daily\install-task.ps1
   powershell -ExecutionPolicy Bypass -File redesign\tools\daily\install-task.ps1 -Time 08:30 -Quota 5
   powershell -ExecutionPolicy Bypass -File redesign\tools\daily\install-task.ps1 -Status
   powershell -ExecutionPolicy Bypass -File redesign\tools\daily\install-task.ps1 -RunNow
   powershell -ExecutionPolicy Bypass -File redesign\tools\daily\install-task.ps1 -Uninstall
================================================================
#>
[CmdletBinding()]
param(
  [string]$Time = '21:00',
  [int]$Quota = 0,
  [string]$TaskName = 'XihaoUC-Daily-Collect',
  [switch]$NoNetdisk,
  [switch]$Status,
  [switch]$RunNow,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$dailyDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $dailyDir '..\..\..')).Path
$cmdPath  = Join-Path $dailyDir 'run-daily.cmd'

function Show-Status {
  # 注意：受限环境（沙箱 / 权限不足）下，Get-ScheduledTask 可能返回空集合而**不报错**。
  # 必须把「读不到」和「真的不存在」区分开，否则会给出误导性的结论
  # （本机实测：沙箱里报"未注册"，实际用 schtasks 查得到，任务好好的）。
  $all = @()
  try { $all = @(Get-ScheduledTask -ErrorAction Stop) } catch { $all = @() }
  if ($all.Count -eq 0) {
    Write-Host '无法读取计划任务库（受限环境或权限不足）——这不代表任务不存在。' -ForegroundColor Yellow
    Write-Host '请用系统自带命令交叉验证：' -ForegroundColor Yellow
    Write-Host "  schtasks /query /tn `"$TaskName`" /fo LIST" -ForegroundColor Cyan
    return
  }
  $t = $all | Where-Object { $_.TaskName -eq $TaskName }
  if (-not $t) { Write-Host "任务「$TaskName」未注册。" -ForegroundColor Yellow; return }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host "任务名称 : $($t.TaskName)"
  Write-Host "状态     : $($t.State)"
  Write-Host "下次运行 : $($info.NextRunTime)"
  Write-Host "上次运行 : $($info.LastRunTime)  退出码 $($info.LastTaskResult)"
  Write-Host "触发器   : $($t.Triggers | ForEach-Object { $_.StartBoundary })"
  $act = $t.Actions | Select-Object -First 1
  Write-Host "动作     : $($act.Execute) $($act.Arguments)"
}

if ($Status) { Show-Status; return }

if ($Uninstall) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已卸载任务「$TaskName」。" -ForegroundColor Green
  } else {
    Write-Host "任务「$TaskName」本来就不存在。" -ForegroundColor Yellow
  }
  return
}

if ($RunNow) {
  Write-Host "立即跑一次采集（前台，输出直接显示）…" -ForegroundColor Cyan
  & $cmdPath
  Write-Host "退出码：$LASTEXITCODE"
  return
}

# ---- 环境自检：把问题在注册前就说清楚 ----
Write-Host "环境自检" -ForegroundColor Cyan
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw '找不到 node，请先安装 Node.js 18+ 并确保在 PATH 里。' }
Write-Host "  node            : $($node.Source)"

if (-not (Test-Path $cmdPath)) { throw "找不到入口脚本：$cmdPath" }
Write-Host "  入口脚本        : $cmdPath"

# ---- 网盘模式：从 config.json 读。manual 模式不需要（也不该）检查 BaiduPCS-Go ----
$netdiskMode = 'manual'
$cfgPath = Join-Path $dailyDir 'config.json'
if (Test-Path $cfgPath) {
  try {
    $parsed = (Get-Content -Raw -Encoding UTF8 $cfgPath | ConvertFrom-Json)
    if ($parsed.netdisk -and $parsed.netdisk.mode) { $netdiskMode = [string]$parsed.netdisk.mode }
  } catch { }
}
Write-Host "  网盘模式        : $netdiskMode" -ForegroundColor Green

if ($netdiskMode -ne 'auto') {
  Write-Host "                    → 手动上传。每天采集完会自动准备好三样东西：" -ForegroundColor Gray
  Write-Host "                        upload\ 目录（每个 App 一个文件夹，含 APK 与来源说明）" -ForegroundColor Gray
  Write-Host "                        links.txt（分享链接登记表，整段粘贴就能认）" -ForegroundColor Gray
  Write-Host "                        上传说明.md（当天这一批的步骤与注意事项）" -ForegroundColor Gray
  Write-Host "                      你上传完、把链接粘进 links.txt 后，一条命令发布：" -ForegroundColor Gray
  Write-Host "                        node redesign\tools\daily\publish.mjs --date=<日期>" -ForegroundColor Gray
} else {
  $bpcs = @(
    (Join-Path $dailyDir 'bin\BaiduPCS-Go.exe'),
    (Join-Path $env:USERPROFILE 'BaiduPCS-Go.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $bpcs) {
    $bpcs = (Get-Command 'BaiduPCS-Go.exe' -ErrorAction SilentlyContinue).Source
  }
  if ($bpcs) {
    Write-Host "  BaiduPCS-Go     : $bpcs" -ForegroundColor Green
    # 顺带把登录状态也查了 —— 否则要到晚上跑完才发现没登录，白等一天。
    # 必须用 who 的 uid 判断，不能用 loglist：未登录时 loglist 只打印一行表头
    # （`# UID 用户名 性别 AGE`），那行表头很容易被误读成「已登录有账号」——
    # 本项目的 netdisk.mjs 就在这个坑里翻过车，已改为解析 who。
    try {
      $whoOut = (& $bpcs who 2>&1 | Out-String)
      $uid = 0
      if ($whoOut -match 'uid\s*[:：]\s*(\d+)') { $uid = [int]$Matches[1] }
      if ($uid -gt 0) {
        $uname = ''
        if ($whoOut -match '用户名\s*[:：]\s*([^,\r\n]*)') { $uname = $Matches[1].Trim() }
        Write-Host "  网盘登录状态    : 已登录（uid $uid $uname）" -ForegroundColor Green
      } else {
        Write-Host "  网盘登录状态    : 未登录" -ForegroundColor Yellow
        Write-Host "                    → 采集与下载照常，上传环节会在运行时跳过并提示登录方法。" -ForegroundColor Yellow
        Write-Host "                    → 登录（上游推荐用 cookies）：" -ForegroundColor Yellow
        Write-Host "                      `"$bpcs`" login --cookies=`"BDUSS=xxx; STOKEN=xxx; ...`"" -ForegroundColor Yellow
        Write-Host "                      再用 `"$bpcs`" who 确认 uid 大于 0" -ForegroundColor Yellow
      }
    } catch {
      Write-Host "  网盘登录状态    : 无法判定（$($_.Exception.Message)）" -ForegroundColor Yellow
    }
  } else {
    Write-Host "  BaiduPCS-Go     : 未找到（auto 模式需要）" -ForegroundColor Yellow
    Write-Host "                    → 把 BaiduPCS-Go.exe 放到 $dailyDir\bin\ 下；" -ForegroundColor Yellow
    Write-Host "                    → 或者把 config.json 的 netdisk.mode 改回 manual 手动上传。" -ForegroundColor Yellow
  }
}

$tokenFile = Join-Path $dailyDir 'state\github-token.txt'
if ($env:GITHUB_TOKEN) {
  Write-Host "  GitHub Token    : 已通过环境变量 GITHUB_TOKEN 提供" -ForegroundColor Green
} elseif (Test-Path $tokenFile) {
  Write-Host "  GitHub Token    : 已读取 state\github-token.txt" -ForegroundColor Green
} else {
  Write-Host "  GitHub Token    : 未配置" -ForegroundColor Yellow
  Write-Host "                    → 不配也能跑，但核心 API 只有 60 次/小时，候选查得少，容易凑不满配额。" -ForegroundColor Yellow
  Write-Host "                    → 建议建一个只读 fine-grained token（无需任何权限勾选），存到：" -ForegroundColor Yellow
  Write-Host "                      $tokenFile" -ForegroundColor Yellow
}

# ---- 注册任务 ----
[datetime]$when = [datetime]::ParseExact($Time, 'HH:mm', $null)
$datePart = (Get-Date).Date.AddDays(1).AddHours($when.Hour).AddMinutes($when.Minute)
if ($datePart -lt (Get-Date)) { $datePart = $datePart.AddDays(1) }

$args = ''
if ($Quota -gt 0) { $args += " --quota=$Quota" }
if ($NoNetdisk)   { $args += ' --no-netdisk' }

$action = New-ScheduledTaskAction -Execute $cmdPath -Argument $args -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $datePart
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4) `
  -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force `
  -Description 'XihaoUC 每日从 GitHub 采集开源 Android App：发现、核实、下载 APK、生成审核表、上传百度网盘。' | Out-Null

Write-Host ''
Write-Host "任务「$TaskName」已注册，每天 $Time 运行。" -ForegroundColor Green
Write-Host "  触发时间 : $($datePart.ToString('yyyy-MM-dd HH:mm'))（此后每天同一时间）"
Write-Host "  参数     :$args"
Write-Host ''
Show-Status
Write-Host ''
Write-Host "常用操作：" -ForegroundColor Cyan
Write-Host "  立刻跑一次   : powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -RunNow"
Write-Host "  查看状态     : powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Status"
Write-Host "  卸载任务     : powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Uninstall"
