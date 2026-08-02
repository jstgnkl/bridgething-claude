#!/usr/bin/env bash
# Installs the Mac side of claude-thing on bridgething:
#   • node dependencies for the daemon and the control page, bun's for the app
#   • the control page and device app builds
#   • Claude Code hooks (a backup of settings.json is written)
#   • two LaunchAgents, started at login and restarted if they die:
#       com.claudething.daemon — the host daemon on 127.0.0.1:8790
#       com.claudething.tunnel — the reverse tunnel that republishes that
#                                daemon on the device's own loopback
#
#   ./mac/install.sh              # install everything
#   ./mac/install.sh --no-agent   # skip both LaunchAgents (run things by hand)
#
# Everything here is reversible with ./mac/uninstall.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

DAEMON_LABEL="com.claudething.daemon"
TUNNEL_LABEL="com.claudething.tunnel"
AGENT_DIR="$HOME/Library/LaunchAgents"
DAEMON_PLIST="$AGENT_DIR/$DAEMON_LABEL.plist"
TUNNEL_PLIST="$AGENT_DIR/$TUNNEL_LABEL.plist"

# Same default and override as mac/tunnel.sh, so the reachability check below
# tests the host the tunnel will actually dial.
DEVICE="${CLAUDE_THING_DEVICE:-10.42.1.178}"

WANT_AGENT=1
[ "${1:-}" = "--no-agent" ] && WANT_AGENT=0

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

say "Checking prerequisites"
command -v node >/dev/null || die "node not found — install Node 18 or newer"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "node $NODE_MAJOR is too old — need 18 or newer"
ok "node $(node -v)"

command -v claude >/dev/null || die "the 'claude' CLI is not on PATH — install Claude Code first"
ok "claude $(claude --version 2>/dev/null | head -1)"

# The device app is a bun project — bun runs the vite build and the push
# script, and bun.lock is the committed lockfile. npm is not a substitute.
command -v bun >/dev/null || die "bun not found — install it from https://bun.sh"
ok "bun $(bun --version)"

say "Installing dependencies"
npm --prefix daemon install --no-audit --no-fund >/dev/null
ok "daemon"
npm --prefix webpage install --no-audit --no-fund >/dev/null
ok "control page"
bun install --silent
ok "device app"

say "Building"
npm --prefix webpage run build >/dev/null
ok "control page → webpage/dist"
# --silent so bun does not echo the command past the redirect; build errors
# still reach stderr.
bun run --silent build >/dev/null
ok "device app → dist"

say "Claude Code hooks"
node daemon/scripts/install-hooks.js | sed 's/^/  /'

if [ "$WANT_AGENT" = "1" ]; then
  say "LaunchAgents"
  mkdir -p "$AGENT_DIR" daemon/logs logs
  # A LaunchAgent inherits almost no PATH, so bake in the directories that hold
  # node and claude on this machine.
  AGENT_PATH="$(dirname "$(command -v node)"):$(dirname "$(command -v claude)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  sed -e "s|__NODE__|$(command -v node)|g" \
      -e "s|__ROOT__|$ROOT|g" \
      -e "s|__PATH__|$AGENT_PATH|g" \
      mac/com.claudething.daemon.plist.template > "$DAEMON_PLIST"
  ok "wrote $DAEMON_PLIST"

  sed -e "s|__ROOT__|$ROOT|g" \
      mac/com.claudething.tunnel.plist.template > "$TUNNEL_PLIST"
  ok "wrote $TUNNEL_PLIST"

  launchctl unload "$DAEMON_PLIST" 2>/dev/null || true
  launchctl load "$DAEMON_PLIST"
  ok "daemon loaded — starts at login"

  launchctl unload "$TUNNEL_PLIST" 2>/dev/null || true
  launchctl load "$TUNNEL_PLIST"
  ok "tunnel loaded — reconnects within 10s of any break"

  for _ in $(seq 1 40); do
    curl -sf http://127.0.0.1:8790/status >/dev/null && break
    sleep 0.25
  done
  if curl -sf http://127.0.0.1:8790/status >/dev/null; then
    ok "daemon answering on http://127.0.0.1:8790"
  else
    warn "daemon did not answer yet — check daemon/logs/launchd.err.log"
  fi
else
  say "LaunchAgents skipped"
  echo "  start the daemon yourself with: npm --prefix daemon start"
  echo "  start the tunnel yourself with: ./mac/tunnel.sh"
fi

# The Mac half is useful before the device is ever plugged in — the control page
# and the session watching work without it. So this warns, it does not fail.
say "Device"
if /usr/bin/ssh -o ConnectTimeout=5 \
      -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile="$HOME/.ssh/known_hosts_carthing" \
      "root@$DEVICE" true 2>/dev/null; then
  ok "$DEVICE reachable over USB"
else
  warn "$DEVICE not reachable — plug the Car Thing in. The tunnel agent keeps"
  warn "  retrying every 10s, so it picks the device up on its own."
fi

say "Done"
cat <<EOF
  Control page:  http://127.0.0.1:8790
  Push the app:  bun run push

  Logs:          daemon/logs/launchd.{out,err}.log
                 logs/tunnel.{out,err}.log
EOF
