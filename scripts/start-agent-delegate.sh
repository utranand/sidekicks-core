#!/bin/sh
# start-agent-delegate.sh — run any orchestrator agent HEADLESS (no terminal window) with one command.
#
# Usage (from anywhere):
#   scripts/start-agent-delegate.sh <agent>                  # start the detached delegate runner
#   scripts/start-agent-delegate.sh <agent> --model opus     # extra flags pass through to `agent start`
#
# The delegate application: a detached Node loop watches the agent's inbox and
# wakes a non-interactive claude session (cwd = repo root — skills, subagents,
# and every sidekicks verb intact) to drain it. Telegram/LAN-bridge daemons
# auto-start alongside per the auto_restart switches.
#
#   Status: node bin/sidekicks agent delegate <agent> --status
#   Logs:   .sidekicks/agents/.bridge/runtime/logs/delegate-<agent>.log
#   Stop:   node bin/sidekicks agent stop <agent>
#
# Thin wrapper over `sidekicks agent start <agent> --headless` so the launch logic
# stays in one place: lib/agent-lifecycle/start.mjs + delegate.mjs. Runs on
# macOS and Windows (Git Bash) alike.

AGENT="$1"
if [ -z "$AGENT" ] || [ "${AGENT#-}" != "$AGENT" ]; then
  echo "usage: scripts/start-agent-delegate.sh <agent> [flags passed to \`agent start\`...]" >&2
  exit 2
fi
shift

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/bin/sidekicks" agent start "$AGENT" --headless "$@"
