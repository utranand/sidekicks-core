#!/bin/sh
# uninstall-delegate-launchagent.sh — remove the macOS LaunchAgent that keeps an
# orchestrator lane's delegate runner always-on.
#
# Usage:
#   scripts/uninstall-delegate-launchagent.sh <agent> [<agent>...]
#   scripts/uninstall-delegate-launchagent.sh --all
#   scripts/uninstall-delegate-launchagent.sh <agent> --dry-run
#
# The installed unit is labelled com.sidekicks.<agent>-delegate and carries
# KeepAlive, so `sidekicks agent stop <agent>` only ends the current loop —
# launchd respawns it. Booting the LaunchAgent out is the only way to stop it
# for good. This script does that and removes the plist so it does not come back
# at the next login.
#
# Reinstall with: scripts/install-delegate-launchagent.sh <agent>
#
# macOS only (launchd). On Windows the delegate is registered with schtasks;
# remove it with: schtasks /delete /tn "sidekicks-<agent>-delegate" /f
#
# Exit codes: 0 all targets removed (or nothing to do under --all)
#             1 a named target had neither a loaded service nor a plist
#             2 usage / wrong platform

set -e

DRY_RUN=0
ALL=0
AGENTS=""

for arg in "$@"; do
  case "$arg" in
    --all) ALL=1 ;;
    --dry-run|-n) DRY_RUN=1 ;;
    -h|--help)
      echo "usage: scripts/uninstall-delegate-launchagent.sh <agent>... | --all [--dry-run]"
      exit 0
      ;;
    -*)
      echo "uninstall-delegate-launchagent.sh: unknown option '$arg'" >&2
      exit 2
      ;;
    *) AGENTS="$AGENTS $arg" ;;
  esac
done

if [ "$ALL" -eq 0 ] && [ -z "$AGENTS" ]; then
  echo "usage: scripts/uninstall-delegate-launchagent.sh <agent>... | --all [--dry-run]" >&2
  exit 2
fi
if [ "$ALL" -eq 1 ] && [ -n "$AGENTS" ]; then
  echo "uninstall-delegate-launchagent.sh: --all takes no agent names" >&2
  exit 2
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "uninstall-delegate-launchagent.sh: launchd is macOS-only (this is $(uname -s))" >&2
  exit 2
fi

LA_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

# --all: derive the lane names from the installed plists, so an agent whose
# charter was already deleted is still cleaned up.
if [ "$ALL" -eq 1 ]; then
  for plist in "$LA_DIR"/com.sidekicks.*-delegate.plist; do
    [ -e "$plist" ] || continue
    base="${plist##*/}"
    label="${base%.plist}"
    name="${label#com.sidekicks.}"
    AGENTS="$AGENTS ${name%-delegate}"
  done
  if [ -z "$AGENTS" ]; then
    echo "no delegate LaunchAgents installed in $LA_DIR"
    exit 0
  fi
fi

STATUS=0

for AGENT in $AGENTS; do
  LABEL="com.sidekicks.${AGENT}-delegate"
  PLIST="$LA_DIR/${LABEL}.plist"

  LOADED=0
  if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    LOADED=1
  fi
  HAS_PLIST=0
  if [ -f "$PLIST" ]; then
    HAS_PLIST=1
  fi

  if [ "$LOADED" -eq 0 ] && [ "$HAS_PLIST" -eq 0 ]; then
    echo "${LABEL}: not installed (no loaded service, no plist)" >&2
    STATUS=1
    continue
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    [ "$LOADED" -eq 1 ] && echo "would bootout ${DOMAIN}/${LABEL}"
    [ "$HAS_PLIST" -eq 1 ] && echo "would remove  ${PLIST}"
    continue
  fi

  # bootout stops the runner (SIGTERM) and deregisters the unit; removing the
  # plist first would leave the loaded service behind with nothing to unload.
  if [ "$LOADED" -eq 1 ]; then
    launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
  fi
  rm -f "$PLIST"

  if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    echo "${LABEL}: still loaded after bootout — check 'launchctl print ${DOMAIN}/${LABEL}'" >&2
    STATUS=1
    continue
  fi

  echo "removed ${LABEL}"
  echo "  plist:     ${PLIST} (deleted)"
  echo "  reinstall: scripts/install-delegate-launchagent.sh ${AGENT}"
done

exit "$STATUS"
