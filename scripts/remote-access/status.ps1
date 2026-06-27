# Quick check: Tailscale + WSL SSH readiness (no admin required).
#
#   .\status.ps1

$ts = "C:\Program Files\Tailscale\tailscale.exe"
Write-Host "=== Windows Tailscale ==="
if (Test-Path $ts) {
  & $ts status 2>&1
  $ip = & $ts ip -4 2>$null
  if ($ip) { Write-Host "IPv4: $ip" }
} else {
  Write-Host "Tailscale not installed"
}

Write-Host ""
Write-Host "=== Ubuntu WSL ==="
wsl -d Ubuntu -e sh -c "hostname; command -v tailscale >/dev/null && tailscale status 2>/dev/null | head -5; command -v tailscale >/dev/null && tailscale ip -4 2>/dev/null; dpkg -l openssh-server 2>/dev/null | grep openssh-server | head -1; ss -tlnp 2>/dev/null | grep ':22' || true"

Write-Host ""
Write-Host "=== agent-coord bus ==="
$coord = Join-Path $env:USERPROFILE "agent-coord\room.jsonl"
if (Test-Path $coord) {
  $lines = (Get-Content $coord | Measure-Object -Line).Lines
  Write-Host "room.jsonl: $coord ($lines lines)"
} else {
  Write-Host "room.jsonl not found at $coord"
}
