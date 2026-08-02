#!/usr/bin/env bash
# Puts the Mac daemon on the Car Thing's loopback.
#
# The kiosk chromium runs --proxy-server=socks5://127.0.0.1:1080 with no bypass
# list, so anything but loopback is pushed into a SOCKS proxy that nothing is
# listening on — that path is dead here. A reverse tunnel puts the daemon at
# 127.0.0.1:8790 ON THE DEVICE, which the kiosk reaches directly — and the
# daemon keeps its 127.0.0.1 bind, so the permission API is never exposed to a
# network interface.
#
# Reverse, not forward: the Mac holds passwordless root SSH to the device; the
# device holds no credentials for the Mac.
#
# This script is meant to die. launchd (com.claudething.tunnel) restarts it
# every time the link breaks — see mac/com.claudething.tunnel.plist.template.
set -uo pipefail

DEVICE="${CLAUDE_THING_DEVICE:-10.42.1.178}"
PORT="${CLAUDE_THING_PORT:-8790}"

# NOT plain `ssh` — that is aliased to Kitty's ssh kitten and breaks here.
exec /usr/bin/ssh -N \
  -R "${PORT}:127.0.0.1:${PORT}" \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile="$HOME/.ssh/known_hosts_carthing" \
  "root@${DEVICE}"
