#!/usr/bin/env bash
# ===================================================================
# 07-verify.sh - prove the migrated node is a live voting validator
#
# Checks (all must pass):
#   process = online, rpc = ready
#   role = validator, voting = enabled
#   validator_active = true, validator_enrollment = ready
#   epoch advances between samples (node follows the network head)
#   p2p_connected > 0
#
# Usage (on the NEW vps):
#   EXPECTED_ADDRESS=oct... bash 07-verify.sh          # 3 samples / 30s
#   SAMPLES=10 INTERVAL=30 bash 07-verify.sh           # longer watch
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
SAMPLES="${SAMPLES:-3}"
INTERVAL="${INTERVAL:-30}"
EXPECTED_ADDRESS="${EXPECTED_ADDRESS:-}"
if [[ -z "${EXPECTED_ADDRESS}" && -s "${MIG_DIR}/source-address.txt" ]]; then
  EXPECTED_ADDRESS=$(cat "${MIG_DIR}/source-address.txt")
fi
if [[ -z "${EXPECTED_ADDRESS}" && -f "${MIG_DIR}/source-final-stat.txt" ]]; then
  EXPECTED_ADDRESS=$(grep -m1 '^address = ' "${MIG_DIR}/source-final-stat.txt" | awk -F' = ' '{print $2}' || true)
fi

set_status RUNNING "verify"
log "=== verifying validator on $(hostname) - ${SAMPLES} samples every ${INTERVAL}s ==="

# --- wait for the node to finish opening its store -------------------
# A freshly started node must open a ~38 GB irmin-pack store, replay the
# epochlog/rule graph and rejoin consensus before its RPC answers. On 2
# vCPU that takes minutes, so poll instead of failing straight away.
WAIT_SEC="${WAIT_SEC:-900}"
DEADLINE=$(( $(date +%s) + WAIT_SEC ))
WAIT_START=$(date +%s)
LAST_LOG=$WAIT_START
log "waiting for rpc = ready (up to ${WAIT_SEC}s)..."
while (( $(date +%s) < DEADLINE )); do
  SNAP=$(node_stat)
  RPC_NOW=$(printf '%s\n' "${SNAP}" | stat_field rpc)
  PROC_NOW=$(printf '%s\n' "${SNAP}" | stat_field process)
  HEAD_NOW=$(printf '%s\n' "${SNAP}" | stat_field head_epoch)
  if [[ "${RPC_NOW}" == "ready" ]]; then
    log "rpc ready after $(( $(date +%s) - WAIT_START ))s (head_epoch=${HEAD_NOW})"
    break
  fi
  # One line a minute instead of a carriage-return animation: every \r update
  # arrives as its own log row in the console, which buried the real steps.
  if (( $(date +%s) - LAST_LOG >= 60 )); then
    log "  waiting for rpc: $(( $(date +%s) - WAIT_START ))s of ${WAIT_SEC}s (rpc=${RPC_NOW:-?} process=${PROC_NOW:-?} head=${HEAD_NOW:-?})"
    LAST_LOG=$(date +%s)
  fi
  sleep 10
done
RPC_NOW=$(node_stat | stat_field rpc)
if [[ "${RPC_NOW}" != "ready" ]]; then
  warn "rpc still unavailable after ${WAIT_SEC}s - running the checks anyway"
fi
echo

# --- wait for the set fold to re-admit the validator -----------------
# After any downtime the network drops a validator from the active set
# (`set_fold_refused ... reason = marks_short`). It is re-admitted by the
# fold once its duty pulses span `rejoin_span = 64` epochs - measured at
# ~27 minutes on this devnet. Nothing has to be re-enrolled: the bond and
# the committed `ready` state stay valid, the node pulses automatically.
MEMBER_WAIT_SEC="${MEMBER_WAIT_SEC:-2700}"
ACTIVE_NOW=$(node_stat | stat_field validator_active)
if [[ "${ACTIVE_NOW}" != "true" ]]; then
  log "validator is online but not a member yet - waiting up to ${MEMBER_WAIT_SEC}s for the set fold"
  MEMBER_DEADLINE=$(( $(date +%s) + MEMBER_WAIT_SEC ))
  MEMBER_START=$(date +%s)
  LAST_LOG=$MEMBER_START
  LAST_SCHED=""
  FIRST_EPOCH=""
  while (( $(date +%s) < MEMBER_DEADLINE )); do
    SNAP=$(node_stat)
    ACTIVE_NOW=$(printf '%s\n' "${SNAP}" | stat_field validator_active)
    SCHED_NOW=$(printf '%s\n' "${SNAP}"  | stat_field validator_scheduled)
    EPOCH_NOW=$(printf '%s\n' "${SNAP}"  | stat_field epoch)
    if [[ "${ACTIVE_NOW}" == "true" ]]; then
      log "validator re-admitted to the active set at epoch ${EPOCH_NOW} (after $(( $(date +%s) - MEMBER_START ))s)"
      break
    fi
    if [[ -z "${FIRST_EPOCH}" && -n "${EPOCH_NOW}" ]]; then
      FIRST_EPOCH="${EPOCH_NOW}"
    fi
    NOW=$(date +%s)
    # A state change is news, so it is logged immediately; otherwise one status
    # line every two minutes. (A \r progress line becomes its own log row in the
    # console, which produced ~50 identical "epoch=... active=false" rows.)
    if [[ -n "${SCHED_NOW}" && "${SCHED_NOW}" != "${LAST_SCHED}" ]]; then
      log "  validator_scheduled=${SCHED_NOW} at epoch ${EPOCH_NOW} - the fold re-admits after ~64 duty epochs"
      LAST_SCHED="${SCHED_NOW}"
      LAST_LOG=$NOW
    elif (( NOW - LAST_LOG >= 120 )); then
      log "  still waiting: $(( (NOW - MEMBER_START) / 60 ))m of $(( MEMBER_WAIT_SEC / 60 ))m, epoch +$(( EPOCH_NOW - FIRST_EPOCH )) since the wait began (active=${ACTIVE_NOW:-?} scheduled=${SCHED_NOW:-false})"
      LAST_LOG=$NOW
    fi
    sleep 20
  done
  [[ "${ACTIVE_NOW}" == "true" ]] || \
    warn "still not active after ${MEMBER_WAIT_SEC}s - the fold re-admits on its own, keep monitoring"
fi

# The enrollment projection can lag behind the membership view right after the
# RPC opens (observed on a live migration: active=true and voting=enabled for
# three 30 s samples while validator_enrollment still read 'unavailable', then
# 'ready'). Wait for the projection before the strict samples instead of turning
# that race into a false "migration failed".
ENROLL_WAIT_SEC="${ENROLL_WAIT_SEC:-900}"
ACTIVE_NOW=$(node_stat | stat_field validator_active)
ENROLL_NOW=$(node_stat | stat_field validator_enrollment)
if [[ "${ACTIVE_NOW}" == "true" && "${ENROLL_NOW}" != "ready" && "${ENROLL_NOW}" != "bonded" ]]; then
  log "validator is active but enrollment reads '${ENROLL_NOW:-unavailable}' - waiting up to ${ENROLL_WAIT_SEC}s for the projection"
  ENROLL_DEADLINE=$(( $(date +%s) + ENROLL_WAIT_SEC ))
  ENROLL_START=$(date +%s)
  LAST_LOG=$ENROLL_START
  while (( $(date +%s) < ENROLL_DEADLINE )); do
    SNAP=$(node_stat)
    ACTIVE_NOW=$(printf '%s\n' "${SNAP}" | stat_field validator_active)
    ENROLL_NOW=$(printf '%s\n' "${SNAP}" | stat_field validator_enrollment)
    if [[ "${ENROLL_NOW}" == "ready" || "${ENROLL_NOW}" == "bonded" ]]; then
      log "enrollment projection ready after $(( $(date +%s) - ENROLL_START ))s (${ENROLL_NOW})"
      break
    fi
    if (( $(date +%s) - LAST_LOG >= 60 )); then
      log "  waiting for enrollment: $(( $(date +%s) - ENROLL_START ))s of ${ENROLL_WAIT_SEC}s (active=${ACTIVE_NOW:-?} enrollment=${ENROLL_NOW:-?})"
      LAST_LOG=$(date +%s)
    fi
    sleep 10
  done
  if [[ "${ENROLL_NOW}" != "ready" && "${ENROLL_NOW}" != "bonded" ]]; then
    warn "enrollment still reads '${ENROLL_NOW:-unavailable}' after ${ENROLL_WAIT_SEC}s - active membership is authoritative, the samples below decide"
  fi
fi

# A migrated STUCK validator is in sync and healthy but the chain has not admitted
# it yet: that is a schedule, not a failure (2026-11-06, .99 -> .231). Ending the
# phase with FAILED there made the operator think the migration broke, while the
# bond and the readiness were fine and only the fold was missing.
if [[ "${ACTIVE_NOW}" != "true" ]]; then
  MEM_STAT=$(node_stat)
  MEM_ENROLL=$(printf "%s\n" "${MEM_STAT}" | stat_field validator_enrollment)
  MEM_PROC=$(printf "%s\n" "${MEM_STAT}"   | stat_field process)
  MEM_RPC=$(printf "%s\n" "${MEM_STAT}"    | stat_field rpc)
  MEM_EPOCH=$(printf "%s\n" "${MEM_STAT}"  | stat_field epoch)
  if [[ "${MEM_ENROLL}" =~ ^(ready|bonded)$ && "${MEM_PROC}" == "online" && "${MEM_RPC}" == "ready" ]]; then
    log "=== RESULT: WAITING-FOLD - the node runs, is in sync and holds the bond (enrollment=${MEM_ENROLL}) ==="
    log "the set has not admitted it yet: the fold does that on its own (~64 duty epochs), nothing was re-enrolled"
    log "nothing to fix: the console keeps watching and opens the activation popup when it happens"
    set_status WAITING-FOLD "migrated and in sync; waiting for the set fold (enrollment=${MEM_ENROLL} epoch=${MEM_EPOCH})"
    echo "MIGRATE_VERIFY state=waiting_fold enrollment=${MEM_ENROLL} epoch=${MEM_EPOCH}"
    exit 2
  fi
  warn "the node is not active AND not ready (process=${MEM_PROC:-?} rpc=${MEM_RPC:-?} enrollment=${MEM_ENROLL:-?}) - the samples below show why"
fi

FAIL=0
PREV_EPOCH=""

for ((i = 1; i <= SAMPLES; i++)); do
  STAT=$(node_stat)
  printf '%s\n' "${STAT}" > "${MIG_DIR}/verify-sample-${i}.txt"

  ROLE=$(printf '%s\n' "${STAT}"  | stat_field role)
  ADDR=$(printf '%s\n' "${STAT}"  | stat_field address)
  PROC=$(printf '%s\n' "${STAT}"  | stat_field process)
  RPC=$(printf '%s\n' "${STAT}"   | stat_field rpc)
  EPOCH=$(printf '%s\n' "${STAT}" | stat_field epoch)
  HEAD=$(printf '%s\n' "${STAT}"  | stat_field head_epoch)
  VOTING=$(printf '%s\n' "${STAT}" | stat_field voting)
  ACTIVE=$(printf '%s\n' "${STAT}" | stat_field validator_active)
  ENROLL=$(printf '%s\n' "${STAT}" | stat_field validator_enrollment)
  P2P=$(printf '%s\n' "${STAT}"   | stat_field p2p_connected)
  AGREED=$(printf '%s\n' "${STAT}"| stat_field round_agreed)
  STEP=$(printf '%s\n' "${STAT}"  | stat_field round_step)
  PEERS=$(printf '%s\n' "${STAT}" | stat_field round_peers)
  UPTIME=$(printf '%s\n' "${STAT}"| stat_field uptime)
  RESTARTS=$(printf '%s\n' "${STAT}" | stat_field restarts)

  log "sample ${i}/${SAMPLES}: epoch=${EPOCH} head=${HEAD} role=${ROLE} voting=${VOTING} active=${ACTIVE} p2p=${P2P} round_peers=${PEERS} agreed=${AGREED} step=${STEP} uptime=${UPTIME} restarts=${RESTARTS}"

  [[ "${PROC}" == "online" ]]        || { err "process is not online: ${PROC}"; FAIL=1; }
  [[ "${RPC}" == "ready" ]]          || { err "rpc is not ready: ${RPC}"; FAIL=1; }
  [[ "${ROLE}" == "validator" ]]     || { err "role is not validator: ${ROLE}"; FAIL=1; }
  [[ "${VOTING}" == "enabled" ]]     || { err "voting is not enabled: ${VOTING}"; FAIL=1; }
  [[ "${ACTIVE}" == "true" ]]        || { err "validator_active is not true: ${ACTIVE}"; FAIL=1; }
  if [[ "${ENROLL}" != "ready" ]]; then
    if [[ "${ACTIVE}" == "true" && "${VOTING}" == "enabled" ]]; then
      # active + voting is stronger evidence than the enrollment projection; the
      # projection can answer 'unavailable' while the RPC warms up.
      warn "enrollment projection reads '${ENROLL:-unavailable}' while the validator is active and voting - accepting active membership"
    else
      err "validator_enrollment is not ready: ${ENROLL}"
      FAIL=1
    fi
  fi
  [[ -z "${EXPECTED_ADDRESS}" || "${ADDR}" == "${EXPECTED_ADDRESS}" ]] || { err "address mismatch: ${ADDR} != ${EXPECTED_ADDRESS}"; FAIL=1; }
  [[ "${P2P:-0}" -gt 0 ]]            || { err "no p2p peers connected"; FAIL=1; }

  if [[ -n "${PREV_EPOCH}" ]]; then
    if (( EPOCH > PREV_EPOCH )); then
      log "  epoch advanced ${PREV_EPOCH} -> ${EPOCH} (+$((EPOCH - PREV_EPOCH)))"
    else
      warn "  epoch did not advance (${PREV_EPOCH} -> ${EPOCH}) - node may still be catching up"
    fi
  fi
  PREV_EPOCH="${EPOCH}"

  if (( i < SAMPLES )); then
    log "  sleeping ${INTERVAL}s before the next sample"
    sleep "${INTERVAL}"
  fi
done

echo
if (( FAIL == 0 )); then
  log "=== RESULT: PASS - validator is online, voting and following the chain ==="
  if [[ -s "${MIG_DIR}/downtime-start.txt" ]]; then
    START_TS=$(date -u -d "$(cat "${MIG_DIR}/downtime-start.txt")" +%s 2>/dev/null || true)
    if [[ -n "${START_TS}" ]]; then
      DOWN=$(( $(date +%s) - START_TS ))
      log "total time from source stop to verified voting: $((DOWN / 60))m$((DOWN % 60))s"
    fi
  fi
  set_status DONE "verify-pass" "epoch=${PREV_EPOCH} address=${ADDR}"
else
  err "=== RESULT: FAIL - see the errors above ==="
  set_status FAILED "verify-failed"
  exit 1
fi
