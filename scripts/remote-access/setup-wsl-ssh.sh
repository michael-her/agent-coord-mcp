#!/bin/sh
# Ubuntu WSL: OpenSSH server for remote coord-chat guests (run over Tailscale).
#
#   wsl -d Ubuntu
#   cd /mnt/g/dev/airpg/scripts/remote-access
#   sudo sh setup-wsl-ssh.sh
#
# After this, run setup-wsl-tailscale.sh (same dir) so guests reach WSL via Tailscale IP.

set -e

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo sh setup-wsl-ssh.sh" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y openssh-server

# Listen on all interfaces inside WSL (Tailscale / localhost forward).
if grep -q '^#*ListenAddress' /etc/ssh/sshd_config; then
  sed -i 's/^#*ListenAddress.*/ListenAddress 0.0.0.0/' /etc/ssh/sshd_config
else
  echo 'ListenAddress 0.0.0.0' >> /etc/ssh/sshd_config
fi

for key in PasswordAuthentication PubkeyAuthentication PermitRootLogin; do
  case "$key" in
    PasswordAuthentication) val="yes" ;;
    PubkeyAuthentication) val="yes" ;;
    PermitRootLogin) val="no" ;;
  esac
  if grep -q "^#*${key}" /etc/ssh/sshd_config; then
    sed -i "s/^#*${key}.*/${key} ${val}/" /etc/ssh/sshd_config
  else
    echo "${key} ${val}" >> /etc/ssh/sshd_config
  fi
done

service ssh restart 2>/dev/null || systemctl restart ssh 2>/dev/null || /etc/init.d/ssh restart

echo ""
echo "OpenSSH is running in WSL."
ss -tlnp 2>/dev/null | grep ':22' || netstat -tlnp 2>/dev/null | grep ':22' || true
echo ""
echo "Add a guest Linux user (example):"
echo "  sudo adduser alice"
echo "  sudo usermod -aG sudo alice   # optional"
echo ""
echo "Next: sudo sh setup-wsl-tailscale.sh"
