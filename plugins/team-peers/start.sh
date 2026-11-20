#!/bin/sh
# stdout is the MCP stdio channel, so every install message goes to stderr.
set -e
ROOT="$(dirname "$0")"
if [ ! -f "$ROOT/node_modules/.package-lock.json" ] || [ "$ROOT/package-lock.json" -nt "$ROOT/node_modules/.package-lock.json" ]; then
  npm ci --prefix "$ROOT" --omit=dev --no-audit --no-fund --loglevel=error 1>&2
fi
exec node "$ROOT/server/index.ts"
