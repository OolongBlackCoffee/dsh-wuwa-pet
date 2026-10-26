<#
  一键部署 / 还原 WuwaTappo 的 CDP 调试端口（读账气泡注入的前置条件）
  ------------------------------------------------------------------
  WuwaTappo 是 Tauri 应用，WebView2 的 additionalBrowserArgs 被编译进 exe，
  只要宿主自己设了这个参数，WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 环境变量就会被忽略。
  所以唯一可行的办法：把这 105 字节的参数字符串**等长**替换成带调试端口的版本。

  本脚本做的事：
    1. 定位 exe（读注册表 "Wuwa Tappo" 的 DisplayIcon/InstallLocation，失败再试常见安装位置）
    2. 判断当前状态：官方原样 / 已打补丁 / 认不出来的新版本（不认就停手，不乱改）
    3. 备份（带版本号留档，升级后的新文件另存一份，不会覆盖旧备份）
    4. 等长替换字节，写完立刻回读校验
    5. 重启应用并等端口起来
    6. 检查 DSH 侧 dsh-wuwa-pet 是否还在启用

  典型用法（官方更新后跑一次即可）：
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy-cdp.ps1
    powershell ... -File deploy-cdp.ps1 -Restore        # 还原成官方原文件
    powershell ... -File deploy-cdp.ps1 -Port 9333      # 换端口（插件侧也要同步改）
#>
[CmdletBinding()]
param(
  [switch]$Restore,
  [switch]$Force,
  [switch]$Quiet,
  [switch]$NoRestart,
  [int]$Port = 9222
)

$ErrorActionPreference = 'Stop'
$script:Lines = New-Object System.Collections.Generic.List[string]
$script:LogFile = Join-Path $PSScriptRoot 'deploy-cdp.log'

function Say {
  param([string]$Message, [string]$Level = 'INFO')
  $line = '[{0}] {1}' -f $Level, $Message
  $script:Lines.Add($line) | Out-Null
  if (-not $Quiet) {
    switch ($Level) {
      'OK'   { Write-Host $line -ForegroundColor Green }
      'WARN' { Write-Host $line -ForegroundColor Yellow }
      'ERR'  { Write-Host $line -ForegroundColor Red }
      default { Write-Host $line }
    }
  } elseif ($Level -eq 'OK' -or $Level -eq 'ERR') {
    # -Quiet 只把结论行吐给调用方（自动启动脚本要记日志），不刷屏
    Write-Host $line
  }
}

function Save-Log {
  try {
    $head = '==== ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ===='
    Add-Content -Path $script:LogFile -Value $head -Encoding UTF8
    Add-Content -Path $script:LogFile -Value ($script:Lines -join "`r`n") -Encoding UTF8
  } catch {}
}

# ---------------------------------------------------------------- 常量
# 官方原串（105 字节，Rust 编译期常量，长度不可变）
$ORIG = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required'
# 补丁串：把前半段换成调试端口，尾部 autoplay 保留，剩余补空格
$PATCH_BASE = '--remote-debugging-port=' + $Port + ' --remote-allow-origins=* --autoplay-policy=no-user-gesture-required'

$ORIG_LEN = $ORIG.Length
if ($PATCH_BASE.Length -gt $ORIG_LEN) {
  Say ('补丁串太长（{0} > {1} 字节），这个端口号放不下' -f $PATCH_BASE.Length, $ORIG_LEN) 'ERR'
  Save-Log
  exit 1
}
$PATCH = $PATCH_BASE + (' ' * ($ORIG_LEN - $PATCH_BASE.Length))

$ENC = [System.Text.Encoding]::GetEncoding(28591)   # ISO-8859-1：字节与字符 1:1，可当字节串用

# ---------------------------------------------------------------- 工具函数
function Get-FileText {
  param([string]$Path)
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  return @{ Bytes = $bytes; Text = $ENC.GetString($bytes) }
}

function Resolve-Exe {
  # 1) 注册表：DisplayName 含 Wuwa Tappo
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($r in $roots) {
    $items = Get-ItemProperty $r -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -match 'Wuwa\s*Tappo' }
    foreach ($it in $items) {
      foreach ($cand in @($it.DisplayIcon, $it.InstallLocation)) {
        if (-not $cand) { continue }
        $p = $cand.Trim('"')
        if ($p -like '*.exe' -and (Test-Path $p)) { return $p }
        $join = Join-Path $p 'WuwaTappo.exe'
        if (Test-Path $join) { return $join }
      }
    }
  }
  # 2) 常见安装位置（安装器默认装在用户选的目录，这里把几种常见写法都试一遍）
  $cands = @()
  if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'WuwaTappo\WuwaTappo.exe') }
  if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'WuwaTappo\WuwaTappo.exe') }
  if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Programs\WuwaTappo\WuwaTappo.exe') }
  $cands += @('D:\WuwaTappo\WuwaTappo.exe', 'C:\WuwaTappo\WuwaTappo.exe', 'E:\WuwaTappo\WuwaTappo.exe')
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  return $null
}

function Test-PortOpen {
  param([int]$P, [int]$TimeoutMs = 1200)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync('127.0.0.1', $P)
    if (-not $task.Wait($TimeoutMs)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    try { $client.Close() } catch {}
  }
}

function Stop-Tappo {
  $procs = @(Get-Process -Name 'WuwaTappo' -ErrorAction SilentlyContinue)
  if (-not $procs.Count) { return $false }
  foreach ($p in $procs) {
    try { $p.Kill() } catch {}
  }
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-Process -Name 'WuwaTappo' -ErrorAction SilentlyContinue)) { return $true }
  }
  return $true
}

function Start-Tappo {
  param([string]$Exe)
  Start-Process -FilePath $Exe -WorkingDirectory (Split-Path -Parent $Exe) | Out-Null
}

function Wait-Port {
  param([int]$P, [int]$Seconds = 25)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-PortOpen -P $P) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

# ---------------------------------------------------------------- 主流程
Say '== WuwaTappo CDP 部署 ==' 'INFO'

$exe = Resolve-Exe
if (-not $exe) {
  Say ('找不到 WuwaTappo.exe（注册表里没有 Wuwa Tappo，默认路径 {0} 也不存在）' -f $DEFAULT_EXE) 'ERR'
  Say '如果装在别处，手动改脚本里的 $DEFAULT_EXE，或把 exe 路径告诉我。' 'WARN'
  Save-Log
  exit 1
}
Say ('安装位置：' + $exe) 'INFO'

$item = Get-Item $exe
$ver = $item.VersionInfo.FileVersion
Say ('文件大小：{0:N0} B   版本：{1}   写入时间：{2}' -f $item.Length, $ver, $item.LastWriteTime) 'INFO'

$backup = $exe + '.orig-backup'
$cur = Get-FileText -Path $exe

$hasOrig = $cur.Text.IndexOf($ORIG, [System.StringComparison]::Ordinal)
$hasPatch = $cur.Text.IndexOf($PATCH_BASE, [System.StringComparison]::Ordinal)

# ------------------------------------------------ 还原分支
if ($Restore) {
  if (-not (Test-Path $backup)) {
    Say '没有找到备份 .orig-backup，无法还原（可能从没打过补丁，或备份被删了）' 'ERR'
    Save-Log
    exit 1
  }
  $bk = Get-Item $backup
  if ($bk.Length -ne $item.Length -and -not $Force) {
    Say ('备份大小 {0:N0} B 与当前 exe {1:N0} B 不一致 —— 说明应用已经升级过，' -f $bk.Length, $item.Length) 'WARN'
    Say '把旧备份写回去等于降级，已停手。确实要降级请加 -Force。' 'WARN'
    Save-Log
    exit 2
  }
  Stop-Tappo | Out-Null
  Copy-Item -Path $backup -Destination $exe -Force
  Say '已从备份还原官方原文件' 'OK'
  if (-not $NoRestart) {
    Start-Tappo -Exe $exe
    if (Wait-Port -P $Port -Seconds 6) {
      Say ('意外：端口 {0} 还在监听（可能被别的程序占用）' -f $Port) 'WARN'
    } else {
      Say '已重启应用，调试端口已关闭（符合预期）' 'OK'
    }
  }
  Say ('还原完成。原文件：' + $backup) 'OK'
  Save-Log
  exit 0
}

# ------------------------------------------------ 状态判断
$state = 'unknown'
if ($hasOrig -ge 0 -and $hasPatch -lt 0) { $state = 'clean' }
elseif ($hasPatch -ge 0) { $state = 'patched' }

Say ('当前状态：' + $(switch ($state) {
  'clean'   { '官方原样（未打补丁）' }
  'patched' { '已打补丁（调试端口已开）' }
  default   { '无法识别' }
})) 'INFO'

if ($state -eq 'unknown') {
  Say '当前 exe 里既没有官方原串，也没有补丁串。' 'ERR'
  Say '多半是官方换了 WebView2 参数（新版本改了这段）。为避免改坏文件，脚本已停手。' 'WARN'
  Say '处理办法：把新的这段参数字符串告诉我，我按新长度重新做等长替换；或者临时用环境变量方案（本应用无效）。' 'WARN'
  Save-Log
  exit 3
}

if ($state -eq 'patched') {
  Say '不需要改动。' 'OK'
  if (-not $NoRestart) {
    $alive = @(Get-Process -Name 'WuwaTappo' -ErrorAction SilentlyContinue).Count -gt 0
    if (-not $alive) {
      Say '应用没在运行，顺手启动一下' 'INFO'
      Start-Tappo -Exe $exe
      if (-not (Wait-Port -P $Port)) { Say ('启动后 {0} 秒内端口 {1} 没起来，建议看应用是否被拦或换个端口' -f 25, $Port) 'WARN' }
    } elseif (Test-PortOpen -P $Port) {
      Say ('端口 {0} 正常监听' -f $Port) 'OK'
    } else {
      Say ('应用在跑但端口 {0} 没监听 —— 多半是打完补丁没重启，重启一次即可' -f $Port) 'WARN'
    }
  }
  # 插件侧检查
  $prof = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\package.json'
  if (Test-Path $prof) {
    try {
      $pj = Get-Content $prof -Raw -Encoding UTF8 | ConvertFrom-Json
      $inBundles = @($pj.dsh.profile.bundles) -contains 'dsh-wuwa-pet'
      if ($inBundles) { Say 'DSH 侧：dsh-wuwa-pet 仍在启用列表里' 'OK' }
      else { Say 'DSH 侧：dsh-wuwa-pet 不在启用列表（气泡不会出现，用插件目录里的 tools\toggle.ps1 打开）' 'WARN' }
    } catch {
      Say ('读 profile 失败：' + $_.Exception.Message) 'WARN'
    }
  }
  Save-Log
  exit 0
}

# ------------------------------------------------ 打补丁
$origCount = ([regex]::Matches($cur.Text, [regex]::Escape($ORIG))).Count
Say ('官方原串出现次数：' + $origCount) 'INFO'
if ($origCount -ne 1) {
  Say ('原串出现 {0} 次（预期 1 次），为免误伤已中止' -f $origCount) 'ERR'
  Save-Log
  exit 4
}

Stop-Tappo | Out-Null

# 备份：升级后的新文件另存一份，不覆盖历史备份
if (Test-Path $backup) {
  $same = $false
  try {
    $oldLen = (Get-Item $backup).Length
    if ($oldLen -eq $item.Length) {
      $oldHash = (Get-FileHash $backup -Algorithm SHA256).Hash
      $newHash = (Get-FileHash $exe -Algorithm SHA256).Hash
      $same = ($oldHash -eq $newHash)
    }
  } catch {}
  if (-not $same) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $oldName = '{0}.{1}-{2}' -f $backup, $ver, $stamp
    Move-Item -Path $backup -Destination $oldName -Force
    Say ('旧备份已留档：' + $oldName) 'INFO'
  }
}
if (-not (Test-Path $backup)) {
  Copy-Item -Path $exe -Destination $backup -Force
  Say ('已备份官方原文件 -> ' + $backup) 'OK'
}

$idx = $hasOrig
$newBytes = New-Object byte[] $cur.Bytes.Length
$patchBytes = $ENC.GetBytes($PATCH)
[System.Array]::Copy($cur.Bytes, 0, $newBytes, 0, $idx)
[System.Array]::Copy($patchBytes, 0, $newBytes, $idx, $patchBytes.Length)
$tailStart = $idx + $ORIG_LEN
[System.Array]::Copy($cur.Bytes, $tailStart, $newBytes, $idx + $patchBytes.Length, $cur.Bytes.Length - $tailStart)

# 写（文件可能被安全软件短暂占用，重试几次）
$written = $false
$lastErr = ''
for ($i = 0; $i -lt 10; $i++) {
  try {
    [System.IO.File]::WriteAllBytes($exe, $newBytes)
    $written = $true
    break
  } catch {
    $lastErr = $_.Exception.Message
    Start-Sleep -Milliseconds 400
  }
}
if (-not $written) {
  Say ('写文件失败：' + $lastErr) 'ERR'
  if ($lastErr -match '拒绝访问|denied|UnauthorizedAccess') {
    Say '权限问题（装在受保护目录）—— 请以管理员身份运行本脚本 / 那个 .bat' 'WARN'
  } else {
    Say '文件多半仍被占用 —— 手动退出 WuwaTappo（含托盘图标）后重跑' 'WARN'
  }
  Save-Log
  exit 5
}

# 回读校验
$after = Get-FileText -Path $exe
$okLen = ($after.Bytes.Length -eq $cur.Bytes.Length)
$okPatch = $after.Text.IndexOf($PATCH_BASE, [System.StringComparison]::Ordinal) -ge 0
$okNoOrig = $after.Text.IndexOf($ORIG, [System.StringComparison]::Ordinal) -lt 0
if ($okLen -and $okPatch -and $okNoOrig) {
  Say ('已写入补丁：偏移 {0}，长度保持不变（{1:N0} B）' -f $idx, $after.Bytes.Length) 'OK'
  Say ('新参数：' + $PATCH_BASE) 'INFO'
} else {
  Say ('校验失败：长度一致={0} 含补丁={1} 无原串={2}' -f $okLen, $okPatch, $okNoOrig) 'ERR'
  Save-Log
  exit 6
}

# 重启 + 等端口
if ($NoRestart) {
  Say ('按要求未自动启动；下次打开应用时端口 {0} 就会开' -f $Port) 'INFO'
} else {
  Start-Tappo -Exe $exe
  Say '已启动应用，等待调试端口…' 'INFO'
  if (Wait-Port -P $Port -Seconds 25) {
    $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    Say ('端口 {0} 已就绪（pid {1}）' -f $Port, $owner) 'OK'
  } else {
    Say ('25 秒内端口 {0} 未就绪 —— 首次启动较慢可再等一会儿；仍然不行就检查安全软件拦截' -f $Port) 'WARN'
  }
}

Say '' 'INFO'
Say '完成。DSH 侧插件若已启用，气泡会在桌宠页面上自动出现（重开 DSH 或重启桌宠可强制刷新）。' 'OK'
Save-Log
exit 0
