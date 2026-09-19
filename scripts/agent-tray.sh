#!/bin/sh
# agent-tray.sh — launch the Sidekicks Agent Tray (macOS menu-bar app).
#
# Thin wrapper: resolves the repo root from this script's location and runs
# the tray with the repo-root .venv python (rumps lives there).
#
#   scripts/agent-tray.sh                 # start the tray
#   scripts/agent-tray.sh --no-autostart  # open without starting the configured members
#   scripts/agent-tray.sh --smoke         # print one snapshot's model, no GUI
#   scripts/agent-tray.sh --interval 5    # slower poll
#
# Start at login: see scripts/launchd/com.sidekicks.agent-tray.plist.
# macOS-only (the tray refuses to start elsewhere and says why).

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/.venv/bin/python"

if [ ! -x "$PY" ]; then
  echo "agent-tray: $PY not found — create the repo venv and install deps:" >&2
  echo "  python3 -m venv .venv && .venv/bin/pip install rumps" >&2
  exit 1
fi

exec "$PY" "$ROOT/.agents/skills/sk-agent-tray/scripts/agent_tray.py" "$@"
