#!/usr/bin/env sh
set -eu

pids=""

shutdown() {
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}

trap shutdown INT TERM

node dist/wait-for-postgres.mjs

node dist/server.mjs &
pids="$pids $!"

HOST="${HOST:-0.0.0.0}" PORT="${NEARZERO_CONSOLE_PORT:-4321}" node console-dist/server/entry.mjs &
pids="$pids $!"

wait
