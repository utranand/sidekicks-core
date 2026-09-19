#!/bin/sh
# start-john.sh — bring the persistent agent 'john' online with one command.
#
# Usage (from anywhere):
#   scripts/start-john.sh              # open a new terminal window running john
#   scripts/start-john.sh --print      # just print the launch command, no window
#   scripts/start-john.sh --model opus # any extra flags pass through to `agent start`
#
# Thin wrapper over `sidekicks agent start john --spawn` so the launch logic
# (charter CLI/model resolution, per-OS terminal spawning) stays in one place:
# lib/agent-lifecycle/start.mjs. Runs on macOS and Windows (Git Bash) alike.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/bin/sidekicks" agent start john --spawn "$@"
