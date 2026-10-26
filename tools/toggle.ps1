# Enable / disable the dsh-wuwa-pet bundle in the DSH desktop profile.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI,
# so non-ASCII text here would show up as garbage.
param(
  [ValidateSet('on', 'off', 'status')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
# profile lives under the DSH home (~/.dsh by default; DSH_HOME overrides it)
if ($env:DSH_HOME) { $dshHome = $env:DSH_HOME } else { $dshHome = Join-Path $env:USERPROFILE '.dsh' }
$pkg = Join-Path $dshHome 'profiles\desktop\package.json'
$name = 'dsh-wuwa-pet'

if (-not (Test-Path $pkg)) {
  Write-Host "profile config not found: $pkg" -ForegroundColor Red
  exit 1
}

$json = Get-Content $pkg -Raw -Encoding UTF8 | ConvertFrom-Json
$present = $json.dsh.profile.bundles -contains $name

if ($Action -eq 'status') {
  Write-Host ("enabled: " + $present)
  Write-Host ("bundles: " + $json.dsh.profile.bundles.Count)
  exit 0
}

$list = New-Object System.Collections.ArrayList
foreach ($b in $json.dsh.profile.bundles) {
  if ($b -ne $name) { [void]$list.Add($b) }
}

if ($Action -eq 'on') {
  if ($present) { Write-Host "already enabled (nothing to do)"; exit 0 }
  [void]$list.Add($name)
} else {
  if (-not $present) { Write-Host "already disabled (nothing to do)"; exit 0 }
}

$json.dsh.profile.bundles = @($list.ToArray())
$json | ConvertTo-Json -Depth 12 | Set-Content $pkg -Encoding UTF8 -NoNewline

if ($Action -eq 'on') {
  Write-Host "enabled dsh-wuwa-pet -- restart DeepSeek Harness to apply" -ForegroundColor Green
} else {
  Write-Host "disabled dsh-wuwa-pet -- restart DeepSeek Harness to apply" -ForegroundColor Yellow
}
Write-Host ("bundles now: " + $json.dsh.profile.bundles.Count)
