# Run as Administrator AFTER pnpm install, prisma generate/db push and pnpm build.
# Existing XAU/MT5 and ClipForge services/Caddy routes are intentionally not touched.
$Root = "C:\memecloud"
$Node = (Get-Command node).Source
$Nssm = (Get-Command nssm).Source

# A completed MemeCloud migration must never leave legacy FomoCloud application
# services enabled. Two API generations previously raced for :4000 after a reboot.
# This deliberately excludes fomocloud-mongo and fomocloud-redis: they may still
# provide shared infrastructure and are outside the application-service migration.
$LegacyAppServices = @(
  "fomocloud-api","fomocloud-listener","fomocloud-executor","fomocloud-exits",
  "fomocloud-market-worker","fomocloud-balance-worker","fomocloud-analytics-worker",
  "fomocloud-notification-worker","fomocloud-discovery-worker","fomocloud-scoring-worker",
  "fomocloud-forward-worker","fomocloud-paper-worker","fomocloud-global-brain",
  "fomocloud-flow-worker","fomocloud-evm-flow-worker","fomocloud-social-worker"
)
foreach ($legacy in $LegacyAppServices) {
  $svc = Get-Service -Name $legacy -ErrorAction SilentlyContinue
  if ($svc) {
    Stop-Service -Name $legacy -Force -ErrorAction SilentlyContinue
    Set-Service -Name $legacy -StartupType Disabled
    Write-Host "Disabled legacy MemeCloud application service: $legacy"
  }
}

$services = @(
  @{Name="memecloud-api"; Script="apps\api\dist\server.js"},
  @{Name="memecloud-listener"; Script="services\listener\dist\index.js"},
  @{Name="memecloud-executor"; Script="services\executor\dist\index.js"},
  @{Name="memecloud-exits"; Script="services\exits\dist\index.js"},
  @{Name="memecloud-market-worker"; Script="services\market-worker\dist\index.js"},
  @{Name="memecloud-balance-worker"; Script="services\balance-worker\dist\index.js"},
  @{Name="memecloud-analytics-worker"; Script="services\analytics-worker\dist\index.js"},
  @{Name="memecloud-notification-worker"; Script="services\notification-worker\dist\index.js"},
  @{Name="memecloud-discovery-worker"; Script="services\discovery-worker\dist\index.js"},
  @{Name="memecloud-scoring-worker"; Script="services\scoring-worker\dist\index.js"},
  @{Name="memecloud-forward-worker"; Script="services\forward-worker\dist\index.js"},
  @{Name="memecloud-paper-worker"; Script="services\paper-worker\dist\index.js"},
  @{Name="memecloud-global-brain"; Script="services\brain-worker\dist\index.js"},
  @{Name="memecloud-flow-worker"; Script="services\flow-worker\dist\index.js"},
  @{Name="memecloud-evm-flow-worker"; Script="services\evm-flow-worker\dist\index.js"},
  @{Name="memecloud-social-worker"; Script="services\social-worker\dist\index.js"}
)

New-Item -ItemType Directory -Force -Path "$Root\logs" | Out-Null
foreach ($s in $services) {
  $exists = Get-Service -Name $s.Name -ErrorAction SilentlyContinue
  if ($exists) { & $Nssm stop $s.Name 2>$null | Out-Null; & $Nssm remove $s.Name confirm 2>$null | Out-Null }
  & $Nssm install $s.Name $Node "$Root\$($s.Script)"
  & $Nssm set $s.Name AppDirectory $Root
  # Node 22 reads the shared .env itself so every service sees identical configuration.
  & $Nssm set $s.Name AppParameters "--env-file=$Root\.env $Root\$($s.Script)"
  & $Nssm set $s.Name AppStdout "$Root\logs\$($s.Name).out.log"
  & $Nssm set $s.Name AppStderr "$Root\logs\$($s.Name).err.log"
  & $Nssm set $s.Name AppRotateFiles 1
  & $Nssm set $s.Name AppRotateBytes 10485760
  & $Nssm set $s.Name Start SERVICE_AUTO_START
  & $Nssm set $s.Name AppExit Default Restart
  & $Nssm start $s.Name
}
Get-Service memecloud-* | Sort-Object Name | Format-Table Name,Status,StartType

# A service reporting Running is not sufficient: verify that the API process which
# owns its public port came from this release, rather than a stale FomoCloud service.
Start-Sleep -Seconds 3
$apiPort = 4000
$listener = Get-NetTCPConnection -State Listen -LocalPort $apiPort -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) { throw "memecloud-api did not bind port $apiPort" }
$owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
if ($owner.CommandLine -notmatch [regex]::Escape($Root)) {
  throw "Port $apiPort is owned by an unexpected runtime: $($owner.CommandLine)"
}
Write-Host "MemeCloud API owns port $apiPort: $($owner.CommandLine)"
