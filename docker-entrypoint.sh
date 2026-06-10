#!/bin/sh
# Docker entrypoint — runs as root to ensure the data volume is writable by
# the unprivileged appuser, then drops privileges and starts the service.
set -e

DATA_DIR="/app/data"
mkdir -p "$DATA_DIR"
chown -R appuser:app "$DATA_DIR"

exec runuser -u appuser -- sh -c "node boot-guard.mjs && tsx src/index.ts"
