#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/observability/docker-compose.otel.yml"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT_DIR="$ROOT_DIR/tmp/verification/$STAMP"
WORKFLOW_PATH="$ROOT_DIR/workflows/agent-trace-otel-demo.tsx"
RUN_ID="agent-trace-otel-demo-$STAMP"
FAIL_RUN_ID="agent-trace-otel-demo-fail-$STAMP"
mkdir -p "$OUT_DIR"

export SMITHERS_OTEL_ENABLED=1
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=smithers-dev
export SMITHERS_LOG_FORMAT=json

run_success() {
  bun run "$ROOT_DIR/src/cli/index.ts" run "$WORKFLOW_PATH" --run-id "$RUN_ID" --annotations '{"custom.demo":true,"custom.ticket":"OBS-123"}'
}

run_failure() {
  bun run "$ROOT_DIR/src/cli/index.ts" run "$WORKFLOW_PATH" --run-id "$FAIL_RUN_ID" --input '{"failureMode":"malformed-json"}' --annotations '{"custom.demo":true,"custom.ticket":"OBS-ERR"}'
}

retry_until() {
  local name=$1
  local attempts=$2
  local validator=$3
  local command=$4
  local delay=2
  local out="$OUT_DIR/$name.json"

  for attempt in $(seq 1 "$attempts"); do
    echo "[verify] $name attempt $attempt/$attempts"
    eval "$command" > "$out.tmp"
    if jq -e "$validator" "$out.tmp" >/dev/null 2>&1; then
      mv "$out.tmp" "$out"
      return 0
    fi
    sleep "$delay"
    delay=$((delay * 2))
  done

  echo "[verify] failed: $name" >&2
  cat "$out.tmp" >&2 || true
  return 1
}

loki_query() {
  local query=$1
  local limit=${2:-200}
  curl --max-time 30 -sG 'http://localhost:3100/loki/api/v1/query_range' \
    --data-urlencode "query=$query" \
    --data-urlencode "limit=$limit"
}

tempo_search() {
  curl --max-time 30 -s 'http://localhost:3200/api/search'
}

tempo_trace() {
  local trace_id=$1
  curl --max-time 30 -s "http://localhost:3200/api/traces/$trace_id"
}

append_json() {
  local title=$1
  local path=$2
  {
    echo
    echo "## $title"
    echo
    echo '```json'
    cat "$path"
    echo
    echo '```'
  } >> "$OUT_DIR/report.md"
}

trace_summary_json() {
  local path=$1
  node -e "const fs=require('fs'); const rows=fs.readFileSync(process.argv[1],'utf8').trim().split('\n').map(JSON.parse); console.log(JSON.stringify(rows.at(-1).summary));" "$path"
}

echo "[verify] reset stack"
"$ROOT_DIR/scripts/obs-reset.sh"

echo "[verify] capture stack state"
docker compose -f "$COMPOSE_FILE" ps > "$OUT_DIR/compose-ps.txt"
curl --max-time 20 -s http://localhost:3001/api/health | jq . > "$OUT_DIR/grafana-health.json"
curl --max-time 20 -s http://localhost:3001/api/datasources | jq 'map({name,type,url,uid})' > "$OUT_DIR/grafana-datasources.json"
curl --max-time 20 -s http://localhost:9090/api/v1/query --data-urlencode 'query=up' | jq . > "$OUT_DIR/prometheus-up.json"

echo "[verify] run success workflow"
run_success | tee "$OUT_DIR/success-run.txt"

echo "[verify] run failure workflow"
set +e
run_failure | tee "$OUT_DIR/failure-run.txt"
FAIL_EXIT=$?
set -e
printf '%s\n' "$FAIL_EXIT" > "$OUT_DIR/failure-exit-code.txt"

sleep 6

retry_until loki-all-events 6 '.streams >= 2' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\"' 200 | jq '{streams:(.data.result|length), counts:(.data.result|map(.values|length)), lines:[.data.result[]?.values[]?[1]][0:5]}'"

retry_until loki-node-attempt 6 '.streams >= 10' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" | node_id=\"pi-rich-trace\" | node_attempt=\"1\"' 200 | jq '{streams:(.data.result|length), counts:(.data.result|map(.values|length))}'"

retry_until loki-claude-structured 6 '.streams >= 1' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" | node_id=\"claude-structured-trace\"' 50 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]][0:10]}'"

retry_until loki-gemini-structured 6 '.streams >= 1' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" | node_id=\"gemini-structured-trace\"' 50 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]][0:10]}'"

retry_until loki-codex-structured 6 '.streams >= 1' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" | node_id=\"codex-structured-trace\"' 50 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]][0:10]}'"

retry_until loki-thinking 6 '.streams >= 1' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" | event_kind=\"assistant.thinking.delta\"' 20 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]]}'"

retry_until loki-tool-start 6 '.streams >= 1' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" | event_kind=\"tool.execution.start\"' 20 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]]}'"

retry_until loki-tool-update 6 '.streams >= 1' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" | event_kind=\"tool.execution.update\"' 20 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]]}'"

retry_until loki-tool-end 6 '.streams >= 1' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" | event_kind=\"tool.execution.end\"' 20 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]]}'"

retry_until loki-sdk-final-only 6 '.streams >= 1' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" | node_id=\"sdk-final-only\"' 20 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]]}'"

retry_until loki-claude-text-delta 6 '.streams >= 1' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" | node_id=\"claude-structured-trace\" | event_kind=\"assistant.text.delta\"' 20 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]]}'"

retry_until loki-gemini-text-delta 6 '.streams >= 1' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" | node_id=\"gemini-structured-trace\" | event_kind=\"assistant.text.delta\"' 20 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]]}'"

retry_until loki-claude-usage 6 '.streams >= 1' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" | node_id=\"claude-structured-trace\" | event_kind=\"usage\"' 20 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]]}'"

retry_until loki-gemini-usage 6 '.streams >= 1' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" | node_id=\"gemini-structured-trace\" | event_kind=\"usage\"' 20 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]]}'"

retry_until loki-codex-text-delta 6 '.streams >= 1' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" | node_id=\"codex-structured-trace\" | event_kind=\"assistant.text.delta\"' 20 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]]}'"

retry_until loki-codex-usage 6 '.streams >= 1' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" | node_id=\"codex-structured-trace\" | event_kind=\"usage\"' 20 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]]}'"

retry_until trace-summary-claude 6 '.captureMode == "cli-json-stream" and .traceCompleteness == "full-observed" and (.missingExpectedEventKinds | length) == 0' \
  "trace_summary_json '$ROOT_DIR/workflows/.smithers/executions/$RUN_ID/logs/agent-trace/claude-structured-trace-0-1.ndjson'"

retry_until trace-summary-codex 6 '.captureMode == "cli-json-stream" and .traceCompleteness == "full-observed" and (.missingExpectedEventKinds | length) == 0' \
  "trace_summary_json '$ROOT_DIR/workflows/.smithers/executions/$RUN_ID/logs/agent-trace/codex-structured-trace-0-1.ndjson'"

retry_until loki-capture-errors 6 '.streams >= 1' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$FAIL_RUN_ID\" | event_kind=\"capture.error\"' 20 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]]}'"

retry_until loki-redaction-presence 6 '.streams >= 1' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" |= \"REDACTED_SECRET\"' 20 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]]}'"

retry_until loki-secret-absence 6 '.streams == 0' \
  "loki_query '{service_name=\"smithers-dev\"} | run_id=\"$RUN_ID\" |= \"sk_demo_secret_123456789\"' 20 | jq '{streams:(.data.result|length), lines:[.data.result[]?.values[]?[1]]}'"

retry_until tempo-search 6 '.smithers | length >= 1' \
  "tempo_search | jq '{smithers:[.traces[] | select(.rootServiceName==\"smithers-dev\") | {traceID, rootServiceName, rootTraceName}]}'"

TRACE_ID=""
for candidate in $(jq -r '.smithers[]?.traceID' "$OUT_DIR/tempo-search.json"); do
  if tempo_trace "$candidate" \
    | jq '{resourceAttrs:[.batches[].resource.attributes], spans:[.batches[].scopeSpans[].spans[] | {name, attrs:.attributes}]}' > "$OUT_DIR/tempo-trace-candidate.json.tmp"; then
    if jq -e ".spans | any(.attrs | any(.key==\"runId\" and .value.stringValue==\"$RUN_ID\"))" "$OUT_DIR/tempo-trace-candidate.json.tmp" >/dev/null 2>&1; then
      TRACE_ID="$candidate"
      mv "$OUT_DIR/tempo-trace-candidate.json.tmp" "$OUT_DIR/tempo-trace-with-runid.json"
      break
    fi
  fi
done

if [[ -z "$TRACE_ID" ]]; then
  echo "[verify] failed: unable to find Tempo trace for success run id $RUN_ID" >&2
  exit 1
fi

cat > "$OUT_DIR/report.md" <<EOF
# Observability verification bundle

- script: scripts/verify-observability.sh
- workflow: $WORKFLOW_PATH
- success run id: $RUN_ID
- failure run id: $FAIL_RUN_ID
- success agents exercised: pi-rich-trace, claude-structured-trace, gemini-structured-trace, codex-structured-trace, sdk-final-only

EOF

append_json grafana-health "$OUT_DIR/grafana-health.json"
append_json grafana-datasources "$OUT_DIR/grafana-datasources.json"
append_json prometheus-up "$OUT_DIR/prometheus-up.json"
append_json loki-all-events "$OUT_DIR/loki-all-events.json"
append_json loki-node-attempt "$OUT_DIR/loki-node-attempt.json"
append_json loki-claude-structured "$OUT_DIR/loki-claude-structured.json"
append_json loki-gemini-structured "$OUT_DIR/loki-gemini-structured.json"
append_json loki-codex-structured "$OUT_DIR/loki-codex-structured.json"
append_json loki-thinking "$OUT_DIR/loki-thinking.json"
append_json loki-tool-start "$OUT_DIR/loki-tool-start.json"
append_json loki-tool-update "$OUT_DIR/loki-tool-update.json"
append_json loki-tool-end "$OUT_DIR/loki-tool-end.json"
append_json loki-sdk-final-only "$OUT_DIR/loki-sdk-final-only.json"
append_json loki-claude-text-delta "$OUT_DIR/loki-claude-text-delta.json"
append_json loki-gemini-text-delta "$OUT_DIR/loki-gemini-text-delta.json"
append_json loki-claude-usage "$OUT_DIR/loki-claude-usage.json"
append_json loki-gemini-usage "$OUT_DIR/loki-gemini-usage.json"
append_json loki-codex-text-delta "$OUT_DIR/loki-codex-text-delta.json"
append_json loki-codex-usage "$OUT_DIR/loki-codex-usage.json"
append_json trace-summary-claude "$OUT_DIR/trace-summary-claude.json"
append_json trace-summary-codex "$OUT_DIR/trace-summary-codex.json"
append_json loki-capture-errors "$OUT_DIR/loki-capture-errors.json"
append_json loki-redaction-presence "$OUT_DIR/loki-redaction-presence.json"
append_json loki-secret-absence "$OUT_DIR/loki-secret-absence.json"
append_json tempo-search "$OUT_DIR/tempo-search.json"
append_json tempo-trace-with-runid "$OUT_DIR/tempo-trace-with-runid.json"

echo "[verify] wrote evidence bundle to $OUT_DIR"
echo "$OUT_DIR"
