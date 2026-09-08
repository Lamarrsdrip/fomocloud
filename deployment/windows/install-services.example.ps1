param(
  [Parameter(Mandatory=$true)][string]$Root,
  [string]$EnvFile = "C:\MemeCloud\.env",
  [string]$Nssm = "C:\ClipForge\bin\nssm.exe"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path $Root).Path
if (-not (Test-Path $EnvFile)) { throw "Shared MemeCloud env not found: $EnvFile" }
if (-not (Test-Path $Nssm)) { throw "NSSM not found: $Nssm" }

$Node = if (Test-Path "C:\ClipForge\runtime\node\node.exe") {
  "C:\ClipForge\runtime\node\node.exe"
} else {
  (Get-Command node -ErrorAction Stop).Source
}

$Expected = (Split-Path $Root -Leaf).ToLowerInvariant()
$Logs = "C:\MemeCloud\logs"
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

# Wallet-first production runtime. These are the only MemeCloud application services that remain.
$Services = @(
  @{Name="memecloud-api"; Script="apps\api\dist\server.js"},
  @{Name="memecloud-listener"; Script="services\listener\dist\index.js"},
  @{Name="memecloud-market-worker"; Script="services\market-worker\dist\index.js"},
  @{Name="memecloud-global-brain"; Script="services\brain-worker\dist\index.js"},
  @{Name="memecloud-notification-worker"; Script="services\notification-worker\dist\index.js"},
  @{Name="memecloud-executor"; Script="services\executor\dist\index.js"},
  @{Name="memecloud-exits"; Script="services\exits\dist\index.js"},
  @{Name="memecloud-balance-worker"; Script="services\balance-worker\dist\index.js"},
  @{Name="memecloud-analytics-worker"; Script="services\analytics-worker\dist\index.js"},
  @{Name="memecloud-social-worker"; Script="services\social-worker\dist\index.js"}
)

# Old candidate/discovery/paper runtime is permanently retired. Disable, do not reinstall.
$Retired = @(
  "memecloud-discovery-worker","memecloud-scoring-worker","memecloud-paper-worker","memecloud-forward-worker",
  "memecloud-flow-worker","memecloud-evm-flow-worker"
)

# Historical service names can otherwise come back after reboot and bind the same API/queues.
$LegacyAppServices = @(
  "fomocloud-api","fomocloud-listener","fomocloud-executor","fomocloud-exits",
  "fomocloud-market-worker","fomocloud-balance-worker","fomocloud-analytics-worker",
  "fomocloud-notification-worker","fomocloud-discovery-worker","fomocloud-scoring-worker",
  "fomocloud-forward-worker","fomocloud-paper-worker","fomocloud-global-brain",
  "fomocloud-flow-worker","fomocloud-evm-flow-worker","fomocloud-social-worker"
)

foreach ($s in $Services) {
  $scriptPath = Join-Path $Root $s.Script
  if (-not (Test-Path $scriptPath)) { throw "Built service artifact missing: $scriptPath" }
}

# Backup the exact current service configuration before touching it.
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = "C:\MemeCloud\nssm-backup-$stamp.json"
$backup = @()
foreach ($s in $Services) {
  if (Get-Service -Name $s.Name -ErrorAction SilentlyContinue) {
    $backup += [pscustomobject]@{
      Name=$s.Name
      Application=(& $Nssm get $s.Name Application 2>$null | Out-String).Trim()
      AppDirectory=(& $Nssm get $s.Name AppDirectory 2>$null | Out-String).Trim()
      AppParameters=(& $Nssm get $s.Name AppParameters 2>$null | Out-String).Trim()
      Start=(& $Nssm get $s.Name Start 2>$null | Out-String).Trim()
    }
  }
}
$backup | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $backupPath
Write-Host "Saved NSSM rollback snapshot: $backupPath"

foreach ($name in ($Retired + $LegacyAppServices)) {
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  if ($svc) {
    & $Nssm stop $name 2>$null | Out-Null
    & $Nssm set $name Start SERVICE_DISABLED | Out-Null
    Write-Host "RETIRED/DISABLED: $name"
  }
}

# Enforce the MongoDB sparse/unique indexes Prisma cannot declare for nullable fields. These are
# execution/idempotency invariants, not optional maintenance.
& $Node "--env-file=$EnvFile" (Join-Path $Root "packages\db\scripts\ensure-indexes.mjs")
if ($LASTEXITCODE -ne 0) { throw "Critical MongoDB index verification/creation failed" }

# Remove old synthetic/candidate rows from PUBLIC presentation without deleting history.
& $Node "--env-file=$EnvFile" (Join-Path $Root "packages\db\scripts\reconcile-wallet-first-public-activity.mjs") --apply
if ($LASTEXITCODE -ne 0) { throw "Public WalletActivity reconciliation failed" }

# Stop only MemeCloud app services. MongoDB, Redis, XAU, Apex and ClipForge services are untouched.
foreach ($s in $Services) {
  if (Get-Service -Name $s.Name -ErrorAction SilentlyContinue) {
    & $Nssm stop $s.Name 2>$null | Out-Null
  }
}

foreach ($s in $Services) {
  $scriptPath = Join-Path $Root $s.Script
  $svc = Get-Service -Name $s.Name -ErrorAction SilentlyContinue
  if (-not $svc) {
    & $Nssm install $s.Name $Node | Out-Null
  }
  & $Nssm set $s.Name Application $Node | Out-Null
  & $Nssm set $s.Name AppDirectory $Root | Out-Null
  & $Nssm set $s.Name AppParameters "--env-file=$EnvFile $scriptPath" | Out-Null
  & $Nssm set $s.Name AppStdout "$Logs\$($s.Name).out.log" | Out-Null
  & $Nssm set $s.Name AppStderr "$Logs\$($s.Name).err.log" | Out-Null
  & $Nssm set $s.Name AppRotateFiles 1 | Out-Null
  & $Nssm set $s.Name AppRotateBytes 10485760 | Out-Null
  & $Nssm set $s.Name AppExit Default Restart | Out-Null
  & $Nssm set $s.Name Start SERVICE_AUTO_START | Out-Null
}

# Start upstream data producers before consumers/execution, then expose the API.
$StartOrder = @(
  "memecloud-listener","memecloud-market-worker","memecloud-balance-worker","memecloud-global-brain","memecloud-notification-worker",
  "memecloud-executor","memecloud-exits","memecloud-analytics-worker",
  "memecloud-social-worker","memecloud-api"
)
foreach ($name in $StartOrder) {
  & $Nssm start $name | Out-Null
  Start-Sleep -Milliseconds 500
}

Start-Sleep -Seconds 15

$failed = @()
foreach ($name in $StartOrder) {
  $status = (& $Nssm status $name 2>$null | Out-String).Trim()
  Write-Host "$name -> $status"
  if ($status -ne "SERVICE_RUNNING") { $failed += $name }
}
if ($failed.Count) { throw "MemeCloud services failed to stay running: $($failed -join ', ')" }

# Every kept service must be CONFIGURED for this immutable release, and its NSSM child Node
# process must actually be running that script. Win32_Service.ProcessId is NSSM itself, not Node.
foreach ($s in $Services) {
  $dir = (& $Nssm get $s.Name AppDirectory 2>$null | Out-String).Trim()
  $params = (& $Nssm get $s.Name AppParameters 2>$null | Out-String).Trim()
  if ($dir -ne $Root -or $params -notmatch [regex]::Escape($Root)) {
    throw "$($s.Name) NSSM config is not pinned to $Root :: dir=$dir params=$params"
  }
  $svc = Get-CimInstance Win32_Service -Filter "Name='$($s.Name)'"
  if (-not $svc -or -not $svc.ProcessId) { throw "No NSSM process for $($s.Name)" }
  $child = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $svc.ProcessId -and $_.Name -ieq "node.exe" } | Select-Object -First 1
  if (-not $child -or $child.CommandLine -notmatch [regex]::Escape($Root)) {
    throw "$($s.Name) child Node process is not running from $Root"
  }
}

# API health reports its actual release directory. This catches the exact stale-backend/404 bug.
$health = Invoke-RestMethod -Uri "https://meme-api.xaucloud.io/health" -TimeoutSec 20
Write-Host ("Public API health: " + ($health | ConvertTo-Json -Compress))
if (-not $health.ok) { throw "Public MemeCloud API is unhealthy" }
if ($health.release -and $health.release.ToString().ToLowerInvariant() -ne $Expected) {
  throw "Public API is serving release '$($health.release)', expected '$Expected'"
}

# Read-only wallet-first invariant proof: source count, listener subscriptions, legacy rows,
# public-transfer leakage and public rows owned by non-Admin sources.
& $Node "--env-file=$EnvFile" (Join-Path $Root "packages\db\scripts\verify-wallet-first-v1.mjs")
if ($LASTEXITCODE -ne 0) { throw "Wallet-first invariant verification failed" }

Write-Host ""
Write-Host "MEMECLOUD DEPLOYMENT VERIFIED: $Expected"
Write-Host "Rollback service config: $backupPath"
