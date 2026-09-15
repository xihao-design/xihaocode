# 从「GitHub开源软件分享知识库.xlsx」抽取原始条目
#
# 产出 .kb-raw.json（build.mjs 与 fetch-icons.mjs 的输入）。
# 之所以单列一步：xlsx 解析比站点生成更容易出错，抽一次、多回复用，
# 且原始抽取结果进版本库后，站点构建不再依赖 xlsx 本身。
#
# 注意：本脚本必须以「带 UTF-8 BOM」保存，否则 Windows PowerShell 5.1 会按
# ANSI 读取，脚本内的中文字面量会被破坏（踩过一次坑）。
#
# 用法：npm run extract   或   powershell -File redesign/tools/extract-kb.ps1

param(
  [string]$Xlsx = '',
  [string]$Out  = ''
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Xlsx) {
  # 不硬编码中文文件名：脚本按 ANSI 被读取时中文会变成乱码，导致找不到文件。
  # 改为在仓库根目录里找唯一的 xlsx（排除 Excel 打开时生成的 ~$ 锁文件）。
  $cand = Get-ChildItem -Path $repoRoot -Filter '*.xlsx' -File -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -notlike '~$*' } | Select-Object -First 1
  if (-not $cand) { Write-Error "No .xlsx found in $repoRoot"; exit 1 }
  $Xlsx = $cand.FullName
}
if (-not $Out) { $Out = Join-Path $repoRoot '.kb-raw.json' }

if (-not (Test-Path $Xlsx)) { Write-Error "xlsx not found: $Xlsx"; exit 1 }

# Excel 可能正占用该文件，用共享读方式复制一份再解析
# 注意：流变量不能叫 $out，会与上面的输出路径参数 $Out 冲突
$tmp = Join-Path $env:TEMP 'xihaouc-kb.xlsx'
$inStream  = New-Object System.IO.FileStream($Xlsx, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
$outStream = New-Object System.IO.FileStream($tmp, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$inStream.CopyTo($outStream); $outStream.Close(); $inStream.Close()

$zip = [System.IO.Compression.ZipFile]::OpenRead($tmp)

function ReadEntry($name) {
  $e = $zip.Entries | Where-Object { $_.FullName -eq $name }
  if (-not $e) { return $null }
  $sr = New-Object System.IO.StreamReader($e.Open(), [System.Text.Encoding]::UTF8)
  $t = $sr.ReadToEnd(); $sr.Close(); return $t
}
function UnEsc($s) {
  return $s -replace '&lt;','<' -replace '&gt;','>' -replace '&quot;','"' -replace '&apos;',"'" -replace '&#10;',"`n" -replace '&amp;','&'
}
function StripTags($s) {
  $t = $s -replace '(?s)<br\s*/?>', "`n" -replace '(?s)</p>', "`n"
  $t = $t -replace '(?s)<[^>]+>', ''
  $t = UnEsc $t
  $t = $t -replace '[ \t]+', ' '
  return (($t -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }) -join "`n").Trim()
}
function ColToIndex($ref) {
  $letters = ($ref -replace '\d','')
  $n = 0
  foreach ($ch in $letters.ToCharArray()) { $n = $n * 26 + ([int][char]$ch - 64) }
  return $n - 1
}

# 全角方括号用码位构造，避免依赖脚本文件编码
$LB = [string][char]0x3010
$RB = [string][char]0x3011

$shared = @()
$ssXml = ReadEntry 'xl/sharedStrings.xml'
if ($ssXml) {
  foreach ($si in [regex]::Matches($ssXml, '(?s)<si>(.*?)</si>')) {
    $parts = [regex]::Matches($si.Groups[1].Value, '(?s)<t[^>]*>(.*?)</t>') | ForEach-Object { $_.Groups[1].Value }
    $shared += (UnEsc ($parts -join ''))
  }
}

$sx = ReadEntry 'xl/worksheets/sheet1.xml'
$rows = [regex]::Matches($sx, '(?s)<row[^>]*r="(\d+)"[^>]*>(.*?)</row>')
$result = New-Object System.Collections.ArrayList

foreach ($r in $rows) {
  $rn = [int]$r.Groups[1].Value
  if ($rn -eq 1) { continue }   # 表头

  $cells = @{}
  foreach ($c in [regex]::Matches($r.Groups[2].Value, '(?s)<c r="([A-Z]+)\d+"([^>]*)>(.*?)</c>')) {
    $col = ColToIndex $c.Groups[1].Value
    $attrs = $c.Groups[2].Value
    $inner = $c.Groups[3].Value
    $val = ''
    if ($attrs -match 't="s"') {
      $idx = [int]([regex]::Match($inner,'<v>(\d+)</v>').Groups[1].Value)
      if ($idx -lt $shared.Count) { $val = $shared[$idx] }
    } else {
      $val = UnEsc ([regex]::Match($inner,'<v>(.*?)</v>').Groups[1].Value)
    }
    $cells[$col] = $val
  }

  $q = if ($cells.ContainsKey(0)) { StripTags $cells[0] } else { '' }
  $a = if ($cells.ContainsKey(1)) { $cells[1] } else { '' }

  # 网盘链接与提取码
  $link = ''; $pwd = ''
  $m = [regex]::Match($a, 'href="([^"]+)"[^>]*>([^<]*)</a>')
  if ($m.Success) {
    $full = UnEsc $m.Groups[1].Value
    $pm = [regex]::Match($full, '[?&]pwd=([A-Za-z0-9]+)')
    if ($pm.Success) { $pwd = $pm.Groups[1].Value }
    $link = $full -replace '\?pwd=[A-Za-z0-9]+$',''
  }

  # 正文中以全角左括号开头的行，依次是「名称与类别」「功能特点」
  $body = StripTags $a
  $cat = ''; $feat = ''
  $bracket = @($body -split "`n" | Where-Object { $_.StartsWith($LB) })
  if ($bracket.Count -ge 1) {
    $i = $bracket[0].IndexOf($RB); if ($i -ge 0) { $cat = $bracket[0].Substring($i + 1).Trim() }
  }
  if ($bracket.Count -ge 2) {
    $i = $bracket[1].IndexOf($RB); if ($i -ge 0) { $feat = $bracket[1].Substring($i + 1).Trim() }
  }

  [void]$result.Add([ordered]@{
    row = $rn; rawTitle = $q; link = $link; pwd = $pwd
    linkText = (StripTags $m.Groups[2].Value); category = $cat; features = $feat
  })
}

$zip.Dispose()
$json = $result | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "extracted $($result.Count) rows -> $Out"
