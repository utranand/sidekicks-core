#!/bin/sh
# install-delegate-launchagent.sh — install (or remove) the macOS LaunchAgent
# that keeps ONE orchestrator lane's delegate runner always-on.
#
# Usage:
#   scripts/install-delegate-launchagent.sh <agent>
#   scripts/install-delegate-launchagent.sh <agent> --uninstall
#
# One template (scripts/launchd/com.sidekicks.agent-delegate.plist), N lanes.
# The label it produces — com.sidekicks.<agent>-delegate — is exactly what the
# agent tray's launchd_label() expects, so the tray's Terminate… offers the
# `launchctl bootout` path instead of a kill that KeepAlive would undo.
#
# macOS only (launchd). On Windows use schtasks; see the plist header.

set -e

AGENT="$1"
if [ -z "$AGENT" ] || [ "${AGENT#-}" != "$AGENT" ]; then
  echo "usage: scripts/install-delegate-launchagent.sh <agent> [--uninstall]" >&2
  exit 2
fi
shift

if [ "$(uname -s)" != "Darwin" ]; then
  echo "install-delegate-launchagent.sh: launchd is macOS-only (this is $(uname -s))" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.sidekicks.${AGENT}-delegate"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [ "$1" = "--uninstall" ]; then
  # One implementation of removal — see scripts/uninstall-delegate-launchagent.sh
  # (which also handles --all and --dry-run).
  exec "$ROOT/scripts/uninstall-delegate-launchagent.sh" "$AGENT"
fi

# The charter must exist AND be an orchestrator: both `agent start --headless`
# and `agent delegate` refuse a worker charter, so catching it here beats a
# LaunchAgent that respawns into the same refusal every few seconds.
ROLE="$(node "$ROOT/bin/sidekicks" agent show "$AGENT" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).charter?.role||JSON.parse(s).role||""))}catch{}})')"
if [ -z "$ROLE" ]; then
  echo "install-delegate-launchagent.sh: no agent '$AGENT' — create it first (sidekicks agent create $AGENT --role orchestrator ...)" >&2
  exit 2
fi
if [ "$ROLE" != "orchestrator" ]; then
  echo "install-delegate-launchagent.sh: '$AGENT' is a '$ROLE' charter — only an orchestrator lane runs a delegate (see docs/guide/delegate-agent-application.md)" >&2
  exit 2
fi

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "install-delegate-launchagent.sh: node is not on PATH" >&2
  exit 2
fi

# $HOME/.local/bin first: the official claude installer's default location, and
# launchd expands nothing, so it has to be spelled out.
LAUNCH_PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__AGENT__|${AGENT}|g" \
    -e "s|__REPO_ROOT__|${ROOT}|g" \
    -e "s|__NODE__|${NODE_BIN}|g" \
    -e "s|__PATH__|${LAUNCH_PATH}|g" \
    "$ROOT/scripts/launchd/com.sidekicks.agent-delegate.plist" > "$DEST"

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"

echo "installed ${LABEL}"
echo "  plist:  ${DEST}"
echo "  node:   ${NODE_BIN}"
echo "  log:    ${ROOT}/.sidekicks/agents/.bridge/runtime/logs/delegate-${AGENT}.log"
echo "  remove: scripts/install-delegate-launchagent.sh ${AGENT} --uninstall"
