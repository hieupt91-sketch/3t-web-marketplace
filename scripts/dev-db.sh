#!/usr/bin/env bash
# Local PostgreSQL for development/tests using the host's PostgreSQL binaries.
# Data lives in runtime-data/pg (git-ignored). Listens on 127.0.0.1 only, trust auth for local dev.
# Alternative: `docker compose -f infra/compose.dev.yml up -d postgres`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/runtime-data/pg"
PORT="${DEV_DB_PORT:-55432}"
PG_BIN="${PG_BIN:-$(dirname "$(command -v pg_ctl 2>/dev/null || ls /usr/lib/postgresql/*/bin/pg_ctl | sort -V | tail -1)")}"

run() {
  # PostgreSQL refuses to run as root; delegate to the postgres account when needed.
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

case "${1:-}" in
  start)
    mkdir -p "$ROOT/runtime-data"
    if [ ! -s "$DATA/PG_VERSION" ]; then
      mkdir -p "$DATA"
      [ "$(id -u)" = "0" ] && chown postgres:postgres "$DATA"
      run "$PG_BIN/initdb" -D "$DATA" -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 >/dev/null
    fi
    if ! run "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      run "$PG_BIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w \
        -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" start >/dev/null
    fi
    for db in marketplace marketplace_test; do
      if ! "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='marketplace'" | grep -q 1; then
        "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -qc "CREATE ROLE marketplace LOGIN"
      fi
      if ! "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
        "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -qc "CREATE DATABASE $db OWNER marketplace"
      fi
    done
    echo "PostgreSQL ready on 127.0.0.1:$PORT (databases: marketplace, marketplace_test)"
    ;;
  stop)
    run "$PG_BIN/pg_ctl" -D "$DATA" -w stop >/dev/null && echo "PostgreSQL stopped"
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
