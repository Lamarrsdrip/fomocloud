# Run as Administrator AFTER pnpm install/build and after setting a production .env.
# This intentionally does not contain server passwords or secrets.
$Root = "C:\FomoCloud"
$Node = (Get-Command node).Source
$Nssm = (Get-Command nssm).Source

$services = @(
  @{Name="fomocloud-api"; Script="apps\api\dist\server.js"},
  @{Name="fomocloud-listener"; Script="services\listener\dist\index.js"},
  @{Name="fomocloud-executor"; Script="services\executor\dist\index.js"},
  @{Name="fomocloud-exits"; Script="services\exits\dist\index.js"},
  @{Name="fomocloud-market-worker"; Script="services\market-worker\dist\index.js"},
  @{Name="fomocloud-balance-worker"; Script="services\balance-worker\dist\index.js"},
  @{Name="fomocloud-analytics-worker"; Script="services\analytics-worker\dist\index.js"},
  @{Name="fomocloud-notification-worker"; Script="services\notification-worker\dist\index.js"}
)

New-Item -ItemType Directory -Force -Path "$Root\logs" | Out-Null
foreach ($s in $services) {
  & $Nssm stop $s.Name 2>$null | Out-Null
  & $Nssm remove $s.Name confirm 2>$null | Out-Null
  & $Nssm install $s.Name $Node "$Root\$($s.Script)"
  & $Nssm set $s.Name AppDirectory $Root
  & $Nssm set $s.Name AppEnvironmentExtra "NODE_ENV=production"
  & $Nssm set $s.Name AppStdout "$Root\logs\$($s.Name).out.log"
  & $Nssm set $s.Name AppStderr "$Root\logs\$($s.Name).err.log"
  & $Nssm set $s.Name AppRotateFiles 1
  & $Nssm set $s.Name AppRotateBytes 10485760
  & $Nssm set $s.Name Start SERVICE_AUTO_START
  & $Nssm set $s.Name AppExit Default Restart
  & $Nssm start $s.Name
}
Get-Service fomocloud-* | Format-Table Name,Status,StartType
