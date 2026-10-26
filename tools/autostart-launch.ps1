# dsh-wuwa-pet autostart launcher (run at logon, window hidden).
#
# Order matters:
#   1. make sure the bundle is still enabled in the DSH profile
#   2. make sure WuwaTappo.exe still carries the CDP patch (app updates wipe it)
#   3. start the pet, wait for its debug port, then start DeepSeek Harness
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
# Invoke-WebRequest prints a progress bar to the console otherwise
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir 'autostart.log'

# rotate at 64 KB, keep one generation
try {
  if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 65536)) {
    Move-Item -Force $LogFile ($LogFile + '.1')
  }
} catch {}

function Log([string]$msg) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg
  if (-not $DryRun) {
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch {}
  }
  Write-Host $line
}

function Find-PetExe {
  # 1) registry uninstall entry written by the Tauri installer
  foreach ($hive in @('HKCU:', 'HKLM:')) {
    $root = $hive + '\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
    if (-not (Test-Path $root)) { continue }
    foreach ($k in Get-ChildItem $root -ErrorAction SilentlyContinue) {
      if ($k.PSChildName -notmatch 'Wuwa') { continue }
      $p = (Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue)
      $cand = @($p.InstallLocation, $p.DisplayIcon) | Where-Object { $_ }
      foreach ($c in $cand) {
        $c2 = ($c -replace '^"', '' -replace '",\d+$', '' -replace ',\d+$', '')
        if (Test-Path $c2) { return (Resolve-Path $c2).Path }
      }
    }
  }
  # 2) common install roots
  $cands = @()
  if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'WuwaTappo\WuwaTappo.exe') }
  if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'WuwaTappo\WuwaTappo.exe') }
  if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Programs\WuwaTappo\WuwaTappo.exe') }
  $cands += @('D:\WuwaTappo\WuwaTappo.exe', 'C:\WuwaTappo\WuwaTappo.exe', 'E:\WuwaTappo\WuwaTappo.exe')
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

function Find-DshExe {
  # 1) the running launcher knows its own path
  $p = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($p -and $p.Path) { return $p.Path }
  # 2) registry uninstall entry
  foreach ($hive in @('HKCU:', 'HKLM:')) {
    $root = $hive + '\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
    if (-not (Test-Path $root)) { continue }
    foreach ($k in Get-ChildItem $root -ErrorAction SilentlyContinue) {
      if ($k.PSChildName -notmatch 'DeepSeek|dsh') { continue }
      $q = (Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue)
      foreach ($c in @($q.DisplayIcon, $q.InstallLocation)) {
        if (-not $c) { continue }
        $c2 = ($c -replace '^"', '' -replace '",\d+$', '' -replace ',\d+$', '')
        if (Test-Path $c2) {
          if ((Get-Item $c2).PSIsContainer) {
            $hit = Get-ChildItem $c2 -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($hit) { return $hit.FullName }
          } else { return (Resolve-Path $c2).Path }
        }
      }
    }
  }
  # 3) common install roots
  $cands = @()
  if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe') }
  if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe') }
  $cands += @('D:\DSH\DeepSeek Harness.exe')
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

$PetExe = Find-PetExe
$DshExe = Find-DshExe
$PetName = 'WuwaTappo'
$DshName = 'DeepSeek Harness'

function Test-Running([string]$name) {
  return [bool](Get-Process -Name $name -ErrorAction SilentlyContinue)
}

Log '--- autostart begin ---'

# ---- 1. bundle enabled ----------------------------------------------------
$toggle = Join-Path $PSScriptRoot 'toggle.ps1'
if (Test-Path $toggle) {
  if ($DryRun) {
    Log '[dry] would run toggle.ps1 on'
  } else {
    try {
      $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $toggle on 2>&1
      Log ('bundle: ' + (($out | Out-String).Trim() -replace '\s+', ' '))
    } catch {
      Log ('bundle: toggle failed -- ' + $_.Exception.Message)
    }
  }
}

# ---- 2. CDP patch present? ------------------------------------------------
function Test-Patched {
  if (-not (Test-Path $PetExe)) { return $null }
  try {
    $bytes = [System.IO.File]::ReadAllBytes($PetExe)
    $text = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)  # latin1: byte-preserving
    return ($text.IndexOf('--remote-debugging-port=9222') -ge 0)
  } catch {
    Log ('patch probe failed: ' + $_.Exception.Message)
    return $null
  }
}

$patched = Test-Patched
if ($patched -eq $false) {
  Log 'CDP patch missing (app was probably updated) -- trying to re-apply'
  if (Test-Running $PetName) {
    Log 'pet is running, cannot patch a live exe; close it and double-click tools\deploy-cdp.ps1 (or 一键部署CDP.bat)'
  } else {
    # deploy-cdp.ps1 is pure PowerShell (no python needed); -NoRestart because we start the pet below
    $patcher = Join-Path $PSScriptRoot 'deploy-cdp.ps1'
    if (-not (Test-Path $patcher)) {
      Log ('patcher not found: ' + $patcher)
    } elseif ($DryRun) {
      Log '[dry] would run deploy-cdp.ps1 -Quiet -NoRestart'
    } else {
      try {
        $o = & powershell -NoProfile -ExecutionPolicy Bypass -File $patcher -Quiet -NoRestart 2>&1
        $code = $LASTEXITCODE
        $tail = ((@($o) | Select-Object -Last 3) -join ' / ')
        Log ('patch: exit=' + $code + ' ' + ($tail -replace '\s+', ' '))
        if ($code -eq 3) {
          Log 'patch: the vendor changed the WebView2 args string -- need a new equal-length patch, not auto-fixable'
        }
      } catch {
        Log ('patch failed -- ' + $_.Exception.Message)
      }
    }
  }
} elseif ($patched -eq $true) {
  Log 'CDP patch: ok'
}

# ---- 3. start pet, then DSH ----------------------------------------------
if (-not (Test-Path $PetExe)) {
  Log ('pet exe not found: ' + $PetExe)
} elseif (Test-Running $PetName) {
  Log 'pet already running'
} else {
  if ($DryRun) { Log '[dry] would start pet' }
  else {
    try {
      Start-Process -FilePath $PetExe -WorkingDirectory (Split-Path -Parent $PetExe) | Out-Null
      Log 'pet started'
    } catch {
      Log ('pet start failed: ' + $_.Exception.Message)
    }
  }
}

# wait for the WebView2 debug port, at most ~30s (plugin connects as soon as it is up)
if (-not $DryRun) {
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 750
  }
  if ($ready) { Log 'pet debug port ready (9222)' }
  else { Log 'pet debug port not ready after 30s -- plugin will keep retrying' }
}

if (-not (Test-Path $DshExe)) {
  Log ('DSH exe not found: ' + $DshExe)
} elseif (Test-Running $DshName) {
  Log 'DSH already running'
} elseif ($DryRun) {
  Log '[dry] would start DSH'
} else {
  try {
    Start-Process -FilePath $DshExe -WorkingDirectory (Split-Path -Parent $DshExe) | Out-Null
    Log 'DSH started'
  } catch {
    Log ('DSH start failed: ' + $_.Exception.Message)
  }
}

Log '--- autostart end ---'
