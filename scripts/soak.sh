#!/usr/bin/env bash
# scripts/soak.sh — 6-hour demo soak with scenario runs, RSS logging, mid-soak model swap,
# followed by reconcile / latency-report / export-ledger and a summary markdown.
# Works under Git Bash and WSL on Windows.
#
# Env vars:
#   SOAK_HOURS        — total soak duration in hours (default 6)
#   DASHBOARD_TOKEN   — bearer token for the Settings API model swap
#   DASHBOARD_PORT    — dashboard port (default 8787)
#
# Exit 0 when reconcile exits 0, else 1.

set -euo pipefail

SOAK_HOURS="${SOAK_HOURS:-6}"
DASHBOARD_PORT="${DASHBOARD_PORT:-8787}"
SOAK_SECS=$(( SOAK_HOURS * 3600 ))
SCENARIO_INTERVAL=1200   # 20 min
RSS_INTERVAL=300         # 5 min
EVIDENCE_DIR="docs/evidence"
LOG_DIR="${EVIDENCE_DIR}/soak-logs"
HYDRA_LOG="${LOG_DIR}/hydra.log"
SCENARIO_LOG="${LOG_DIR}/scenarios.log"
RSS_LOG="${LOG_DIR}/rss.log"
SUMMARY="${EVIDENCE_DIR}/soak-summary.md"

mkdir -p "${LOG_DIR}"

# ---- helpers ----------------------------------------------------------------
ts() { date '+%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[$(ts)] $*"; }

rss_kb() {
  # Try /proc first (Linux / WSL); fall back to tasklist (Git Bash on Windows).
  # tasklist CSV memory column is quoted and locale-formatted: '"12,345 K"'.
  # Split on '"' to get the raw fields, strip non-digits from the mem field.
  local pid="$1"
  if [[ -f "/proc/${pid}/status" ]]; then
    grep VmRSS "/proc/${pid}/status" 2>/dev/null | awk '{print $2}' || echo 0
  else
    tasklist //FI "PID eq ${pid}" //FO CSV //NH 2>/dev/null \
      | awk -F'"' '{gsub(/[^0-9]/,"",$10); if($10+0>0) print $10+0}' \
      | head -1 || echo 0
  fi
}

scenario_pass=0
scenario_fail=0
rss_min=0
rss_max=0
rss_sampled=0

# ---- start hydra in demo mode -----------------------------------------------
log "Starting HYDRA in demo mode..."
bun run src/main.ts --mode demo > "${HYDRA_LOG}" 2>&1 &
HYDRA_PID=$!
log "HYDRA PID=${HYDRA_PID}"

# Give it 10 s to boot
sleep 10
if ! kill -0 "${HYDRA_PID}" 2>/dev/null; then
  log "ERROR: HYDRA exited immediately; check ${HYDRA_LOG}"
  exit 1
fi

START_TS="$(ts)"
START_EPOCH=$(date +%s)
END_EPOCH=$(( START_EPOCH + SOAK_SECS ))
LAST_SCENARIO=${START_EPOCH}
LAST_RSS=${START_EPOCH}
MID_SWAP_DONE=0
MID_EPOCH=$(( START_EPOCH + SOAK_SECS / 2 ))

# ---- soak loop --------------------------------------------------------------
log "Soak running for ${SOAK_HOURS}h (until $(date -d "@${END_EPOCH}" '+%H:%M:%S' 2>/dev/null || date -r "${END_EPOCH}" '+%H:%M:%S' 2>/dev/null || echo '?'))..."

while true; do
  NOW=$(date +%s)
  [[ ${NOW} -ge ${END_EPOCH} ]] && break

  # Scenario runs every 20 min.
  # HYDRA_SOAK=1 tells bootHot() to use an isolated state dir and shifted ports so scenarios
  # do not collide with the running HYDRA process on the same SQLite or ports.
  if (( NOW - LAST_SCENARIO >= SCENARIO_INTERVAL )); then
    LAST_SCENARIO=${NOW}
    for scenario in 1 3 4; do
      log "Running scenario ${scenario}..." | tee -a "${SCENARIO_LOG}"
      SCENARIO_TMP="state/scenario-soak-${scenario}-${NOW}"
      if HYDRA_SOAK=1 HYDRA_SCENARIO_STATE_DIR="${SCENARIO_TMP}" \
         bun run src/cli.ts scenario "${scenario}" >> "${SCENARIO_LOG}" 2>&1; then
        log "  scenario ${scenario}: PASS" | tee -a "${SCENARIO_LOG}"
        (( scenario_pass++ )) || true
      else
        log "  scenario ${scenario}: FAIL (exit $?)" | tee -a "${SCENARIO_LOG}"
        (( scenario_fail++ )) || true
      fi
      # Clean up the isolated state dir so it doesn't accumulate between runs.
      rm -rf "${SCENARIO_TMP}" 2>/dev/null || true
    done
  fi

  # RSS every 5 min
  if (( NOW - LAST_RSS >= RSS_INTERVAL )); then
    LAST_RSS=${NOW}
    if kill -0 "${HYDRA_PID}" 2>/dev/null; then
      RSS=$(rss_kb "${HYDRA_PID}")
      if [[ "${RSS}" -gt 0 ]] 2>/dev/null; then
        log "RSS ${RSS} kB" | tee -a "${RSS_LOG}"
        if [[ ${rss_sampled} -eq 0 ]]; then
          rss_min=${RSS}
          rss_max=${RSS}
          rss_sampled=1
        else
          (( RSS < rss_min )) && rss_min=${RSS} || true
          (( RSS > rss_max )) && rss_max=${RSS} || true
        fi
      fi
    fi
  fi

  # Mid-soak Settings model swap (once)
  if [[ ${MID_SWAP_DONE} -eq 0 && ${NOW} -ge ${MID_EPOCH} ]]; then
    MID_SWAP_DONE=1
    log "Mid-soak: triggering Settings model swap via dashboard API..."
    SWAP_PAYLOAD='{"agents":{"commander":{"model":"google/gemini-flash-1.5"}}}'
    if curl -sf -X PUT "http://127.0.0.1:${DASHBOARD_PORT}/api/config/agents" \
         -H "Authorization: Bearer ${DASHBOARD_TOKEN:-}" \
         -H "Content-Type: application/json" \
         -d "${SWAP_PAYLOAD}" >> "${SCENARIO_LOG}" 2>&1; then
      log "  model swap: OK" | tee -a "${SCENARIO_LOG}"
    else
      log "  model swap: FAILED (non-fatal)" | tee -a "${SCENARIO_LOG}"
    fi
  fi

  sleep 10
done

END_TS="$(ts)"
log "Soak complete. Stopping HYDRA (PID=${HYDRA_PID})..."
kill "${HYDRA_PID}" 2>/dev/null || true
wait "${HYDRA_PID}" 2>/dev/null || true

# ---- post-soak scripts ------------------------------------------------------
log "Running reconcile..."
RECONCILE_RESULT="PASS"
set +e
bun run scripts/reconcile.ts 2>&1 | tee "${LOG_DIR}/reconcile.log"
RC=${PIPESTATUS[0]}
set -e
case "$RC" in 0) RECONCILE_RESULT="PASS" ;; 2) RECONCILE_RESULT="UNVERIFIED (no venue keys)" ;; *) RECONCILE_RESULT="FAIL" ;; esac

log "Running latency-report..."
bun run scripts/latency-report.ts --since "${SOAK_HOURS}" --out "${EVIDENCE_DIR}/latency.csv" \
  2>&1 | tee "${LOG_DIR}/latency-report.log"
LATENCY_P95=$(grep 'p95=' "${LOG_DIR}/latency-report.log" | grep -o 'p95=[0-9.]*' | cut -d= -f2 || echo "n/a")
LATENCY_VERDICT=$(grep 'p95 target' "${LOG_DIR}/latency-report.log" | grep -o 'PASS\|FAIL\|NO DATA' || echo "n/a")

log "Running export-ledger..."
bun run scripts/export-ledger.ts --out "${EVIDENCE_DIR}/ledger-export.json" \
  2>&1 | tee "${LOG_DIR}/export-ledger.log"

# ---- soak-summary.md --------------------------------------------------------
if [[ ${rss_sampled} -eq 0 ]]; then
  RSS_MIN_DISP="n/a (hydra crashed before first sample)"
  RSS_MAX_DISP="n/a"
  RSS_DRIFT_DISP="n/a"
else
  RSS_DRIFT=$(( rss_max - rss_min ))
  RSS_MIN_DISP="${rss_min} kB"
  RSS_MAX_DISP="${rss_max} kB"
  RSS_DRIFT_DISP="${RSS_DRIFT} kB"
fi

cat > "${SUMMARY}" <<EOF
# Soak Summary

| Key | Value |
|-----|-------|
| Start | ${START_TS} |
| End   | ${END_TS} |
| Duration | ${SOAK_HOURS} h |
| Scenarios PASS | ${scenario_pass} |
| Scenarios FAIL | ${scenario_fail} |
| RSS min | ${RSS_MIN_DISP} |
| RSS max | ${RSS_MAX_DISP} |
| RSS drift | ${RSS_DRIFT_DISP} |
| Reconcile | ${RECONCILE_RESULT} |
| Latency p95 | ${LATENCY_P95} ms |
| Latency verdict | ${LATENCY_VERDICT} |

## Logs

- \`${HYDRA_LOG}\` — HYDRA stdout/stderr
- \`${SCENARIO_LOG}\` — scenario run log
- \`${RSS_LOG}\` — RSS samples
- \`${LOG_DIR}/reconcile.log\` — reconcile output
- \`${LOG_DIR}/latency-report.log\` — latency report output
- \`${LOG_DIR}/export-ledger.log\` — export-ledger output
EOF

log "Summary written to ${SUMMARY}"
log "SOAK DONE. Reconcile: ${RECONCILE_RESULT}"

[[ "${RECONCILE_RESULT}" == "PASS" ]] && exit 0 || exit 1
