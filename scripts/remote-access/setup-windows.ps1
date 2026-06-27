# Windows host prep for WSL + Tailscale remote guests (run PowerShell as Administrator).
#
#   cd G:\dev\airpg\scripts\remote-access
#   .\setup-windows.ps1
#
# Does NOT replace WSL setup — run setup-wsl-ssh.sh and setup-wsl-tailscale.sh in Ubuntu after.

$ErrorActionPreference = "Stop"

$wslconfig = Join-Path $env:USERPROFILE ".wslconfig"
$wslconfigBody = @"
[wsl2]
localhostForwarding=true
"@

if (-not (Test-Path $wslconfig)) {
  Set-Content -Path $wslconfig -Value $wslconfigBody -Encoding UTF8
  Write-Host "Created $wslconfig (localhostForwarding=true)"
} elseif (-not (Select-String -Path $wslconfig -Pattern "localhostForwarding" -Quiet)) {
  Add-Content -Path $wslconfig -Value "`nlocalhostForwarding=true"
  Write-Host "Appended localhostForwarding=true to $wslconfig"
} else {
  Write-Host ".wslconfig already has localhostForwarding"
}

Write-Host ""
Write-Host "Restart WSL to apply .wslconfig:"
Write-Host "  wsl --shutdown"
Write-Host "  wsl -d Ubuntu"
Write-Host ""

$ts = "C:\Program Files\Tailscale\tailscale.exe"
if (Test-Path $ts) {
  Write-Host "Windows Tailscale status:"
  & $ts status
  $ip = & $ts ip -4 2>$null
  if ($ip) { Write-Host "This PC (Windows) Tailscale IP: $ip" }
} else {
  Write-Host "Tailscale not found at $ts — install from https://tailscale.com/download/windows"
}

Write-Host ""
Write-Host "Next steps (Ubuntu WSL):"
Write-Host "  wsl -d Ubuntu"
Write-Host "  cd /mnt/g/dev/airpg/scripts/remote-access"
Write-Host "  sudo sh setup-wsl-ssh.sh"
Write-Host "  sudo sh setup-wsl-tailscale.sh"
Write-Host "  sudo adduser alice"
Write-Host ""
Write-Host "Guest (on tailnet): ssh alice@<wsl-tailscale-ip>"
Write-Host "  remote-coord-chat.sh alice"
