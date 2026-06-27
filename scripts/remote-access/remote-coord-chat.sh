#!/usr/bin/env bash
# Remote human: join the shared agent-coord room over SSH (WSL or Git Bash).
#
#   ./remote-coord-chat.sh alice
#
# Defaults:
#   AGENT_COORD_DIR  host bus dir (WSL path to Windows profile agent-coord)
#   AIRPG_REPO       this repo (auto-detected from script location)

set -euo pipefail

ID="${1:-}"
if [ -z "$ID" ]; then
  echo "usage: remote-coord-chat.sh <agentId>" >&2
  echo "  example: remote-coord-chat.sh alice" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${AIRPG_REPO:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
COORD_DIR="${AGENT_COORD_DIR:-/mnt/c/Users/sehui/agent-coord}"

if [ ! -d "$COORD_DIR" ]; then
  echo "AGENT_COORD_DIR not found: $COORD_DIR" >&2
  echo "Set AGENT_COORD_DIR to the host's agent-coord folder." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node not found — install Node.js 20+ in WSL." >&2
  exit 1
fi

export AGENT_COORD_DIR="$COORD_DIR"
cd "$REPO"
exec node scripts/coord-chat.mjs --id "$ID" --dir "$COORD_DIR"
