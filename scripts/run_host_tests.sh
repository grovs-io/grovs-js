#!/usr/bin/env bash
# Runs the in-app host-app matrix (e2e/hosts) against the local backend.
#   scripts/run_host_tests.sh preflight|smoke|full|rich [playwright args...]
# HOST_APPS=plain,react,next,vue and HOST_BROWSERS=chromium,webkit,firefox narrow the matrix.
set -euo pipefail

MODE="${1:-smoke}"
shift || true
case "$MODE" in preflight|smoke|full|rich) ;; *) echo "usage: $0 preflight|smoke|full|rich [playwright args...]" >&2; exit 2 ;; esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="${GROVS_BACKEND_DIR:-$ROOT/../backend-development-internal/grovs}"
API_HOST="${HOST_API_HOST:-http://api.lvh.me:3000}"
PROJECT_ID="${HOST_TEST_PROJECT:-2796}"
HELPER_PORT="${HOST_HELPER_PORT:-4809}"
RUN_ID="${HOST_TEST_RUN_ID:-$(date +%s)}"
STATE_DIR="$ROOT/test-results/hosts-state/$RUN_ID"
mkdir -p "$STATE_DIR"

runner() { (cd "$BACKEND" && bundle exec rails runner "$1" 2>/dev/null); }

# 1. The stack
curl -fs -o /dev/null "$API_HOST/in_app/preview" || { echo "Stack not ready: rails ($API_HOST)"; exit 1; }
pgrep -f sidekiq >/dev/null || { echo "Stack not ready: sidekiq"; exit 1; }

TOKEN_ID=""
HELPER_PID=""
cleanup() {
  local status=$?
  set +e
  # Whatever a test left behind, hard-deleted by the exact ids this run recorded; never by name.
  if [[ -n "$HELPER_PID" ]] && [[ -s "$STATE_DIR/campaigns.txt" || -s "$STATE_DIR/segments.txt" ]]; then
    request=$(python3 -c 'import json,sys
read=lambda p: sorted({l.strip() for l in open(p)} - {""}) if __import__("os").path.exists(p) else []
print(json.dumps({"op":"purge","campaigns":read(sys.argv[1]),"segments":read(sys.argv[2])}))' "$STATE_DIR/campaigns.txt" "$STATE_DIR/segments.txt")
    echo "Sweep: $(echo "$request" | nc -w 120 127.0.0.1 "$HELPER_PORT")"
    left=$(runner "
      ids = Array(%w[$(sort -u "$STATE_DIR/campaigns.txt" 2>/dev/null | tr '\n' ' ')]).map { |h| InAppCampaign.decode_id(h) }
      segs = Array(%w[$(sort -u "$STATE_DIR/segments.txt" 2>/dev/null | tr '\n' ' ')]).map { |h| Segment.decode_id(h) }
      puts [InAppCampaign.where(id: ids).count, Segment.where(id: segs).count].join(' ')" | tail -1)
    echo "Left by this run (campaigns segments): $left"
  fi
  if [[ -n "$HELPER_PID" ]]; then kill "$HELPER_PID" 2>/dev/null; wait "$HELPER_PID" 2>/dev/null; fi
  if [[ -n "$TOKEN_ID" ]]; then
    runner "Doorkeeper::AccessToken.find($TOKEN_ID).revoke" >/dev/null && echo "Revoked token $TOKEN_ID"
  fi
  exit $status
}
trap cleanup EXIT

# 2. A short-lived token, and the project's SDK key (read only)
read -r TOKEN_ID HOST_TEST_TOKEN HOST_SDK_KEY < <(runner "
  t = Doorkeeper::AccessToken.create!(application_id: Doorkeeper::Application.first.id, resource_owner_id: 1, expires_in: 3600)
  puts [t.id, t.token, Project.find($PROJECT_ID).identifier].join(' ')" | tail -1)
[[ -n "$TOKEN_ID" && -n "$HOST_TEST_TOKEN" && -n "$HOST_SDK_KEY" ]] || { echo "Could not mint a token"; exit 1; }
export HOST_TEST_TOKEN HOST_SDK_KEY
export HOST_TEST_RUN_ID="$RUN_ID" HOST_TEST_PROJECT="$PROJECT_ID" HOST_TEST_API="$API_HOST/api/v1"
export HOST_BASE_URL="${HOST_BASE_URL:-http://sdk.lvh.me:3000}" HOST_HELPER_PORT="$HELPER_PORT" HOST_STATE_DIR="$STATE_DIR"
echo "Run $RUN_ID, token $TOKEN_ID, state in $STATE_DIR"

# 3. The helper: segment population, visitor lookups, and the batch tick the dev stack lacks
(cd "$BACKEND" && HOST_TEST_RUN_ID="$RUN_ID" HOST_TEST_PROJECT_ID="$PROJECT_ID" HOST_HELPER_PORT="$HELPER_PORT" \
  exec bundle exec rails runner "$ROOT/e2e/hosts/support/backend_helper.rb") >"$STATE_DIR/helper.log" 2>&1 &
HELPER_PID=$!
ping=""
for _ in $(seq 1 60); do
  ping=$(echo '{"op":"ping"}' | nc -w 2 127.0.0.1 "$HELPER_PORT" 2>/dev/null || true)
  [[ -n "$ping" ]] && break
  kill -0 "$HELPER_PID" 2>/dev/null || { echo "Helper exited; see $STATE_DIR/helper.log"; exit 1; }
  sleep 1
done
[[ "$ping" == *'"clickhouse":true'* ]] || { echo "Stack not ready: clickhouse (${ping:-helper did not answer})"; exit 1; }
[[ "$MODE" == "preflight" ]] && { echo "Preflight ok"; exit 0; }

# 4. The SDK and the hosts
cd "$ROOT"
npm run build --silent >/dev/null
IFS=',' read -r -a HOSTS <<<"${HOST_APPS:-plain,react,next,vue}"
for host in "${HOSTS[@]}"; do
  [[ "$host" == plain ]] && continue
  npm ci --prefix "e2e/hosts/$host" --no-audit --no-fund --loglevel=error >/dev/null
done

# 5. The matrix
HOST_SUITE="$MODE" npx playwright test -c e2e/hosts/hosts.config.ts "$@"
