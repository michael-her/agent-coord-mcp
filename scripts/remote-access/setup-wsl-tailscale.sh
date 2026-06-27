#!/bin/sh
# Ubuntu WSL: Tailscale so remote users SSH to this WSL's 100.x address (no Windows portproxy).
#
#   wsl -d Ubuntu
#   cd /mnt/g/dev/airpg/scripts/remote-access
#   sudo sh setup-wsl-tailscale.sh
#
# Then on the host: approve the node in https://login.tailscale.com/admin/machines
# Guest connects: ssh alice@<this-wsl-tailscale-ip>

set -e

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo sh setup-wsl-tailscale.sh" >&2
  exit 1
fi

if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

echo "Starting Tailscale in WSL (browser auth or reuse tailnet)..."
tailscale up --ssh --accept-routes

echo ""
echo "WSL Tailscale status:"
tailscale status
echo ""
IP=$(tailscale ip -4 2>/dev/null || true)
if [ -n "$IP" ]; then
  echo "Remote guest SSH (after Linux user exists):"
  echo "  ssh <user>@${IP}"
  echo ""
  echo "Then start coord-chat:"
  echo "  /mnt/g/dev/airpg/scripts/remote-access/remote-coord-chat.sh <agentId>"
else
  echo "No Tailscale IPv4 yet — complete login in the URL above, then: tailscale ip -4"
fi
