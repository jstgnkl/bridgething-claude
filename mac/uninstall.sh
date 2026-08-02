#!/usr/bin/env bash
# Removes everything mac/install.sh added outside the checkout: both
# LaunchAgents (daemon and tunnel) and the Claude Code hooks (a backup of
# settings.json is written first).
#
# Deliberately left in place: node_modules, the builds in webpage/dist and
# dist/, and the log files. They cost nothing, and re-running install.sh
# rewrites them anyway.
set -uo pipefail
cd "$(dirname "$0")/.."

AGENT_DIR="$HOME/Library/LaunchAgents"
PORT="${CLAUDE_THING_PORT:-8790}"

ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }

unload_agent() {
  local label="$1" plist="$AGENT_DIR/$1.plist"
  if [ -f "$plist" ]; then
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    ok "$label removed"
  else
    ok "$label not installed"
  fi
}

printf '\n\033[1mStopping the tunnel\033[0m\n'
unload_agent com.claudething.tunnel
# A hand-started tunnel (./mac/tunnel.sh, or the --no-agent path) is not
# launchd's to stop. Match the whole forward spec, not just the port: a looser
# pattern would match this script's own command line and kill the uninstall.
if pkill -f "ssh -N -R ${PORT}:127\.0\.0\.1:${PORT}" 2>/dev/null; then
  ok "hand-started tunnel stopped"
fi

printf '\n\033[1mStopping the daemon\033[0m\n'
unload_agent com.claudething.daemon
if [ -f daemon/.daemon.pid ]; then
  kill "$(cat daemon/.daemon.pid)" 2>/dev/null || true
  rm -f daemon/.daemon.pid
  ok "running daemon stopped"
fi

printf '\n\033[1mClaude Code hooks\033[0m\n'
node daemon/scripts/uninstall-hooks.js | sed 's/^/  /'

printf '\nDone. Your Claude Code settings backup is listed above.\n'
printf 'Left alone: node_modules, builds, logs, and %s/.ssh/known_hosts_carthing.\n' "$HOME"
