# Reset forgotten Ubuntu WSL sudo password (no old password needed).
#
# WSL default user can log in as root without the user password:
#   wsl -d Ubuntu -u root
#
# Interactive reset:
#   wsl -d Ubuntu -u root passwd sehui
#
# Or run this script — prompts for a NEW password twice:

$ErrorActionPreference = "Stop"
$user = if ($args[0]) { $args[0] } else { "sehui" }

Write-Host "Resetting password for WSL user: $user"
Write-Host "(root login does not need your old password)"
Write-Host ""

wsl -d Ubuntu -u root passwd $user

if ($LASTEXITCODE -eq 0) {
  Write-Host ""
  Write-Host "Done. Test: wsl -d Ubuntu -e sudo -k true"
  Write-Host "Then continue remote setup:"
  Write-Host "  cd /mnt/g/dev/airpg/scripts/remote-access"
  Write-Host "  sudo sh setup-wsl-ssh.sh"
}
