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

node console-dist/server/entry.mjs &
pids="$pids $!"

wait
