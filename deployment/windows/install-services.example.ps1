# Run as Administrator AFTER pnpm install, prisma generate/db push and pnpm build.
# Existing XAU/MT5 and ClipForge services/Caddy routes are intentionally not touched.
$Root = "C:\MemeCloud"
$Node = (Get-Command node).Source
$Nssm = (Get-Command nssm).Source

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
  @{Name="memecloud-paper-worker"; Script="services\paper-worker\dist\index.js"}
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
