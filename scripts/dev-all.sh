#!/usr/bin/env bash
# Start the full development stack: PostgreSQL, migrations, API, worker, preview origin, web.
# Logs go to runtime-data/logs/*.log; Ctrl+C stops everything started here.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
mkdir -p runtime-data/logs
bash scripts/dev-db.sh start
pnpm --filter @3t/core run migrate
pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT INT TERM
pnpm --filter @3t/api run dev > runtime-data/logs/api.log 2>&1 & pids+=($!)
pnpm --filter @3t/preview run dev > runtime-data/logs/preview.log 2>&1 & pids+=($!)
pnpm --filter @3t/worker run dev > runtime-data/logs/worker.log 2>&1 & pids+=($!)
pnpm --filter @3t/web run dev > runtime-data/logs/web.log 2>&1 & pids+=($!)
echo "Web: http://localhost:3000  API: http://127.0.0.1:4000  Preview: http://<label>.preview.localhost:4100"
echo "Logs: runtime-data/logs/  (Ctrl+C to stop)"
wait
