# Install dsh-onenpc into the desktop DSH profile (junction + package.json registration).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install-profile.ps1
#
# 幂等：重复跑只补齐缺项，不重复写。
# 迁移：本项目改名过两次（dsh-npc → dsh-edict → dsh-onenpc）。脚本会清掉所有旧名的
#       junction 与 dependencies 条目，再把 bundles 里的旧名换成新名——旧名都是本项目
#       自己，所以链接一律删除，不判断「源码目录是否还在」。
# 注意：源码目录为 D:\Projects\dsh-onenpc（2026-11-08 由 D:\Projects\dsh-edict 改名而来，
#       运行中的会话会因此失去 cwd，改名前先确认没有会话把该目录当工作区）。
# 兼容：Windows PowerShell 5.1 与 PowerShell 7（只用字符串操作，不对悬空链接做 Get-Item）。
$ErrorActionPreference = 'Stop'
$profileDir = 'C:\Users\yolo\.dsh\profiles\desktop'
$p = Join-Path $profileDir 'package.json'
$pkgName = 'dsh-onenpc'
$srcDir = 'D:\Projects\dsh-edict'
$staleNames = @('dsh-npc', 'dsh-edict')

# 1) backup (keep the first/original backup of this profile file)
$bak = "$p.bak-$pkgName"
if (-not (Test-Path $bak)) {
  Copy-Item $p $bak -Force
  Write-Host "backup ok: $bak"
} else {
  Write-Host "backup exists: $bak (kept)"
}

# 2) 清掉所有旧名的 junction（它们都是本项目自己，源码目录存在与否都不该留着）
foreach ($s in $staleNames) {
  $staleLink = Join-Path $profileDir "node_modules\$s"
  if (Test-Path $staleLink) {
    Remove-Item $staleLink -Force -Recurse -ErrorAction SilentlyContinue
    if (Test-Path $staleLink) { cmd /c rmdir "$staleLink" | Out-Null }
    Write-Host "removed stale junction: $staleLink"
  }
}

# 3) junction
$link = Join-Path $profileDir "node_modules\$pkgName"
if (Test-Path $link) {
  Write-Host "junction exists: $link"
} else {
  New-Item -ItemType Junction -Path $link -Target $srcDir | Out-Null
  Write-Host "junction created: $link -> $srcDir"
}

# 4) register in package.json (idempotent, string surgery keeps the file's formatting)
$text = [IO.File]::ReadAllText($p)
$changed = $false
$nl = "`r`n"

# 4a) drop every stale dependency line (whole line, so no blank line is left behind)
foreach ($s in $staleNames) {
  $pat = '(?m)^[ \t]*"' + [regex]::Escape($s) + '"[ \t]*:[ \t]*"[^"]*"[ \t]*,?[ \t]*\r?\n'
  if ([regex]::IsMatch($text, $pat)) {
    $text = [regex]::Replace($text, $pat, '')
    $changed = $true
    Write-Host "deps: removed stale $s"
  }
}
# 删掉可能变成悬空的逗号（`,\n  }` → `\n  }`），保证 JSON 仍合法
$text = [regex]::Replace($text, ',(\s*)([}\]])', '$1$2')

# 4b) ensure our dependency line
$depLine = '    "' + $pkgName + '": "link:' + $srcDir.Replace('\', '\\') + '",'
if ($text.IndexOf('"' + $pkgName + '": "link:') -lt 0) {
  $depsIdx = $text.IndexOf('"dependencies"')
  if ($depsIdx -lt 0) { throw 'deps anchor not found ("dependencies")' }
  $braceIdx = $text.IndexOf('{', $depsIdx)
  $text = $text.Insert($braceIdx + 1, $nl + $depLine)
  $changed = $true
  Write-Host "deps: registered $pkgName"
} else { Write-Host "deps already has $pkgName" }

# 4c) bundles: 旧名换成新名；仍没有就追加到数组末尾
$bundlesIdx = $text.IndexOf('"bundles"')
if ($bundlesIdx -lt 0) { throw 'bundles array not found' }
$openIdx = $text.IndexOf('[', $bundlesIdx)
$closeIdx = $text.IndexOf(']', $openIdx)
if ($openIdx -lt 0 -or $closeIdx -lt 0) { throw 'bundles array bounds not found' }
$inner = $text.Substring($openIdx + 1, $closeIdx - $openIdx - 1)
foreach ($s in $staleNames) {
  if ($inner.IndexOf('"' + $s + '"') -ge 0) {
    $inner = $inner.Replace('"' + $s + '"', '"' + $pkgName + '"')
    $changed = $true
    Write-Host "bundles: $s -> $pkgName"
  }
}
if ($inner.IndexOf('"' + $pkgName + '"') -lt 0) {
  $inner = $inner.TrimEnd()
  if ($inner.Length -gt 0) { $inner = $inner + ',' }
  $inner = $inner + $nl + '        "' + $pkgName + '"'
  $changed = $true
  Write-Host "bundles: appended $pkgName"
}
if ($changed) {
  $text = $text.Substring(0, $openIdx + 1) + $inner + $text.Substring($closeIdx)
  [IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# 5) validate
$j = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host ("deps.$pkgName = " + $j.dependencies.$pkgName)
foreach ($s in $staleNames) { Write-Host ("deps.$s = " + $j.dependencies.$s) }
Write-Host ("bundles has $pkgName = " + ($j.'dsh'.profile.bundles -contains $pkgName))
Write-Host ("bundles count = " + $j.'dsh'.profile.bundles.Count)
if (-not $j.dependencies.$pkgName) { throw 'deps validation failed' }
if (-not ($j.'dsh'.profile.bundles -contains $pkgName)) { throw 'bundles validation failed' }
foreach ($s in $staleNames) { if ($j.dependencies.$s) { throw "stale dep $s still present" } }
Write-Host 'INSTALL DONE - restart DeepSeekRuntime to take effect'
