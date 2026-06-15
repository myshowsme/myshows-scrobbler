#!/bin/sh
# Tiny entrypoint that translates env vars into CLI flags. Keeps the image
# command stable while letting `docker run -e ENABLE_UI=false` / similar
# control behaviour without overriding the whole CMD.

set -eu

ARGS="--port ${PORT:-3000}"

# UI is enabled by default — most NAS / homelab deployments want it. Set
# ENABLE_UI=false on public hosts that put the API behind a reverse proxy
# or want token-only access.
if [ "${ENABLE_UI:-true}" = "true" ]; then
  ARGS="$ARGS --ui"
fi

# The server already defaults to 0.0.0.0 so the container's published port
# is reachable from outside. Override with HOST=... when needed (e.g. to
# bind only to a specific interface inside the container's network namespace).
if [ -n "${HOST:-}" ]; then
  ARGS="$ARGS --host $HOST"
fi

# Forward any extra args from `docker run myshows-scrobbler ... -- --something`.
exec node dist/server/index.mjs $ARGS "$@"
