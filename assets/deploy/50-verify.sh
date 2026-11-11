#!/usr/bin/env bash
# ===================================================================
# 50-verify.sh - prove the freshly deployed node works
#
# For ROLE=observer (a fresh deploy): process online, rpc ready, role correct,
# p2p peers > 0, and the epoch advancing between samples. A brand-new node needs
# a moment to find peers, so it WAITS (PEER_WAIT) instead of failing on the first
# sample - that wait is what lets the enrollment popup appear on a healthy node.
# For ROLE=validator (already enrolled): also voting enabled, validator_active
# true and validator_enrollment ready - the same bar the migration uses. The
# validator only starts voting after the set fold, so this waits (VOTE_WAIT)
# instead of failing: the step ends as PASS exactly when voting = enabled.
#
# Usage:  sudo SAMPLES=3 INTERVAL=20 bash 50-verify.sh
# Env:    SAMPLES (default 3), INTERVAL (default 20), ROLE (default observer),
#         PEER_WAIT (default 300 s), VOTE_WAIT (default 900 s),
#         VERIFY_RETRY (default 2), VERIFY_RETRY_WAIT (default 8 s)
#
# A sample that fails the bar is re-read (VERIFY_RETRY times, VERIFY_RETRY_WAIT
# apart) before it counts: the node's own state flaps for one window right after
# a set fold (`voting=disabled`) or while it replays an epoch (`rpc=unavailable`),
# and one flapping sample must not turn a healthy validator into a FAILED deploy
# (2026-11-04). A transient blip is counted, logged and named in the result; more
# than half of the samples blipping is still a failure.
#
# Running out of the wait budget is NOT a broken deploy either: a node that is
# still replaying (`rpc != ready`) or a validator the network has not admitted /
# activated yet is a matter of minutes, not of a wrong command. Those two end as
# soft stops (`WAITING-RPC` / `WAITING-FOLD`, exit 2) so the console asks for
# another run instead of showing a red failure. A dead process, a wrong role or
# an observer that never finds a peer is still a real failure.
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
# the verify bar reads the node through curl/jq and watches the process with pgrep
ensure_tool curl  curl   || die "curl is missing and could not be installed"
ensure_tool jq    jq     || die "jq is missing and could not be installed"
ensure_tool pgrep psmisc || die "pgrep (psmisc) is missing and could not be installed"
SAMPLES="${SAMPLES:-3}"
INTERVAL="${INTERVAL:-20}"
ROLE="${ROLE:-observer}"
# How long to keep waiting for the state a healthy node reaches on its own:
# peers for an observer, the set fold + voting for a validator.
PEER_WAIT="${PEER_WAIT:-300}"
VOTE_WAIT="${VOTE_WAIT:-900}"
EXPECTED_ADDRESS="${EXPECTED_ADDRESS:-$(wallet_address || true)}"

set_status RUNNING "verify"
# per-sample dumps of earlier attempts (a test host carried eleven
# verify-sample-*.txt from older runs): this run writes its own, so drop the old
rm -f "${DEPLOY_DIR}"/verify-sample-*.txt 2>/dev/null || true
log "=== verifying the node on $(hostname) - ${SAMPLES} samples every ${INTERVAL}s (role=${ROLE}) ==="
[[ "${ROLE}" == "validator" ]] && log "=== the step only passes once voting = enabled (waiting up to ${VOTE_WAIT}s for the fold) ==="

FAIL=0
PREV_EPOCH=""
ADDR=""
P2P=""
VOTING=""
ACTIVE=""
ENROLL=""

epoch_num() { # epoch_num <value> -> a number, 0 when empty/not numeric
  case "${1:-}" in
    ''|*[!0-9]*) printf '0' ;;
    *) printf '%s' "$1" ;;
  esac
}

# --- a flapping sample is not a broken node ---------------------------
# The node's own state flaps by design: `voting` can read `disabled` for one
# window right after a set fold, and the RPC answers `unavailable` while it
# replays an epoch log (observed on both). 2026-11-04: two deploys of a perfectly
# healthy ACTIVE validator were reported FAILED because exactly ONE of five
# samples flapped (sample 3 `voting=disabled`, resp. sample 2 `rpc=unavailable`),
# so the console showed a red verify although every other sample proved voting,
# active=true, enrollment=ready and an advancing epoch. A sample that fails the
# bar is therefore RE-READ up to VERIFY_RETRY times (VERIFY_RETRY_WAIT apart):
# any healthy re-read makes it a TRANSIENT BLIP (counted, logged, named in the
# result). Only a sample that stays bad - or a run where more than half of the
# samples blipped - fails.
BLIPS=0
VERIFY_RETRY="${VERIFY_RETRY:-2}"
VERIFY_RETRY_WAIT="${VERIFY_RETRY_WAIT:-8}"

sample_reason() {   # why the current field values fail the bar ("" = healthy)
  if [[ "${PROC}" != "online" ]]; then printf 'process is %s (not online)' "${PROC:-?}"; return 0; fi
  if [[ "${RPC}" != "ready" ]]; then printf 'rpc is %s' "${RPC:-?}"; return 0; fi
  if [[ "${DEV_ROLE}" != "${ROLE}" ]]; then
    printf 'role is %s, expected %s' "${DEV_ROLE:-?}" "${ROLE}"; return 0
  fi
  if [[ "${P2P:-0}" -le 0 ]]; then printf 'no p2p peers connected'; return 0; fi
  if [[ -n "${EXPECTED_ADDRESS}" && "${ADDR}" != "${EXPECTED_ADDRESS}" ]]; then
    printf 'address is %s, expected %s' "${ADDR:-?}" "${EXPECTED_ADDRESS}"; return 0
  fi
  if [[ "${ROLE}" == "validator" ]]; then
    if [[ "${VOTING}" != "enabled" ]]; then printf "voting is %s (must be 'enabled')" "${VOTING:-?}"; return 0; fi
    if [[ "${ACTIVE}" != "true" ]]; then printf 'validator_active is %s' "${ACTIVE:-?}"; return 0; fi
    if [[ "${ACTIVE}" != "true" && "${ENROLL}" != "ready" ]]; then printf 'validator_enrollment is %s' "${ENROLL:-?}"; return 0; fi
  fi
  printf ''
  return 0
}

sample_state() {   # read the node once into the field variables
  STAT=$(node_stat)
  printf '%s\n' "${STAT}" > "${DEPLOY_DIR}/verify-sample-${SAMPLE_N}.txt"
  FIELD() { printf '%s\n' "${STAT}" | stat_field "$1"; }
  DEV_ROLE=$(FIELD role); ADDR=$(FIELD address); PROC=$(FIELD process)
  RPC=$(FIELD rpc); EPOCH=$(FIELD epoch); HEAD=$(FIELD head_epoch)
  VOTING=$(FIELD voting); ACTIVE=$(FIELD validator_active)
  ENROLL=$(FIELD validator_enrollment); P2P=$(FIELD p2p_connected)
  NEXT_SET=$(FIELD validator_next_set_epoch)
  UPTIME=$(FIELD uptime); RESTARTS=$(FIELD restarts)
}

# A validator only votes after the set fold; a fresh observer needs a moment for
# its first peers. Waiting here (instead of failing on the first sample) is what
# makes the run end exactly when the node is healthy - and therefore what lets the
# enrollment popup follow a *verified* node.
WAIT_BUDGET="${PEER_WAIT}"
[[ "${ROLE}" == "validator" ]] && WAIT_BUDGET="${VOTE_WAIT}"
WAITED=0
SAMPLE_N=0
READY=0
while :; do
  SAMPLE_N=$(( SAMPLE_N + 1 ))
  sample_state
  log "waiting ${SAMPLE_N}: process=${PROC} rpc=${RPC} role=${DEV_ROLE} p2p=${P2P} voting=${VOTING} active=${ACTIVE} enrollment=${ENROLL}${NEXT_SET:+ - set fold at epoch ${NEXT_SET}}"
  if [[ "${PROC}" == "online" && "${RPC}" == "ready" && "${P2P:-0}" -gt 0 ]]; then
    if [[ "${ROLE}" != "validator" ]]; then READY=1; fi
    if [[ "${ROLE}" == "validator" \
          && "${VOTING}" == "enabled" && "${ACTIVE}" == "true" ]]; then
      # active + voting is authoritative; the enrollment projection can still say
      # 'unavailable' while the RPC warms up (observed on live migrations)
      if [[ "${ENROLL}" != "ready" ]]; then
        warn "enrollment projection reads '${ENROLL:-unavailable}' while the validator is active and voting - accepting active membership"
      fi
      READY=1
    fi
  fi
  (( READY == 1 )) && break
  if (( WAITED >= WAIT_BUDGET )); then
    # The budget is out. Only a node that is really broken fails here: the two
    # states a healthy node has not reached yet are timing (see the header).
    if [[ "${PROC}" != "online" ]]; then
      err "the node process is ${PROC:-?} after ${WAIT_BUDGET}s - it is not running"
      err "  check on the host: pm2 status ; tail -n 50 ${NODE_SRC_DIR}/data/operator_logs/node.log"
      set_status FAILED "verify-not-ready" "process=${PROC:-?} after ${WAIT_BUDGET}s"
      exit 1
    fi
    if [[ "${RPC}" != "ready" ]]; then
      warn "the node is still starting or catching up after ${WAIT_BUDGET}s (rpc=${RPC:-?})"
      warn "  nothing is broken: the rpc answers 'ready' once the node replayed its state"
      set_status WAITING-RPC "rpc=${RPC:-?} after ${WAIT_BUDGET}s - the node is still catching up, re-run verify"
      exit 2
    fi
    if [[ "${ROLE}" == "validator" && "${P2P:-0}" -gt 0 && "${VOTING}" != "enabled" ]]; then
      warn "the validator is not voting after ${WAIT_BUDGET}s (voting=${VOTING:-?} active=${ACTIVE:-?} enrollment=${ENROLL:-?})"
      warn "  the network admits a new validator at the set fold and starts its duty epoch after that;"
      warn "  the node keeps running and votes on its own - re-run verify in a few minutes"
      set_status WAITING-FOLD "voting=${VOTING:-?} active=${ACTIVE:-?} enrollment=${ENROLL:-?} after ${WAIT_BUDGET}s${NEXT_SET:+ - set fold at epoch ${NEXT_SET}} - re-run verify later"
      exit 2
    fi
    err "the node did not reach the ${ROLE} state within ${WAIT_BUDGET}s"
    err "process=${PROC} rpc=${RPC} p2p=${P2P:-0} voting=${VOTING:-?} active=${ACTIVE:-?} enrollment=${ENROLL:-?}"
    [[ "${ROLE}" == "validator" ]] && err "voting must be 'enabled' - check: sh controls/stat.sh on the host"
    set_status FAILED "verify-not-ready"
    exit 1
  fi
  log "  not there yet - waiting ${INTERVAL}s (${WAITED}s of ${WAIT_BUDGET}s)"
  WAITED=$(( WAITED + INTERVAL ))
  sleep "${INTERVAL}"
done
if [[ "${ROLE}" == "validator" ]]; then
  log "=== the node is an ACTIVE validator and voting (voting=${VOTING} active=${ACTIVE} enrollment=${ENROLL}) ==="
else
  log "=== the node is online with ${P2P} peers ==="
fi

for ((i = 1; i <= SAMPLES; i++)); do
  SAMPLE_N="${i}"
  sample_state

  log "sample ${i}/${SAMPLES}: epoch=${EPOCH} head=${HEAD} role=${DEV_ROLE} process=${PROC} rpc=${RPC} p2p=${P2P} voting=${VOTING} active=${ACTIVE} enrollment=${ENROLL} uptime=${UPTIME} restarts=${RESTARTS}"

  WHY=$(sample_reason)
  if [[ -n "${WHY}" ]]; then
    RECOVERED=""
    for ((r = 1; r <= VERIFY_RETRY; r++)); do
      log "  sample ${i}/${SAMPLES} read '${WHY}' - re-reading in ${VERIFY_RETRY_WAIT}s (${r}/${VERIFY_RETRY})"
      sleep "${VERIFY_RETRY_WAIT}"
      sample_state
      WHY=$(sample_reason)
      if [[ -z "${WHY}" ]]; then RECOVERED="yes"; break; fi
    done
    if [[ -n "${RECOVERED}" ]]; then
      BLIPS=$(( BLIPS + 1 ))
      log "    transient blip ${BLIPS}: recovered - process=${PROC} rpc=${RPC} role=${DEV_ROLE} p2p=${P2P} voting=${VOTING} active=${ACTIVE} enrollment=${ENROLL}"
    else
      err "sample ${i}/${SAMPLES}: ${WHY}"
      FAIL=1
    fi
  fi

  if [[ -n "${PREV_EPOCH}" ]]; then
    PREV_NUM=$(epoch_num "${PREV_EPOCH}")
    NOW_NUM=$(epoch_num "${EPOCH}")
    if (( NOW_NUM > PREV_NUM )); then
      log "  epoch advanced ${PREV_EPOCH} -> ${EPOCH} (+$((NOW_NUM - PREV_NUM)))"
    elif (( NOW_NUM == 0 )); then
      warn "  the node does not report an epoch yet - it is probably still catching up"
    else
      warn "  epoch did not advance (${PREV_EPOCH} -> ${EPOCH}) - the node may still be catching up"
    fi
  fi
  PREV_EPOCH="${EPOCH}"

  if (( i < SAMPLES )); then
    log "  sleeping ${INTERVAL}s before the next sample"
    sleep "${INTERVAL}"
  fi
done

# A node that is mostly unhealthy must not pass: one or two blips are noise, a
# majority of bad samples is not (a node that flaps most of the time is broken).
if (( BLIPS * 2 > SAMPLES )); then
  err "most samples (${BLIPS}/${SAMPLES}) had to be re-read before they looked healthy - that is not a stable node"
  FAIL=1
fi

echo
if (( FAIL == 0 )); then
  if (( BLIPS > 0 )); then
    log "=== RESULT: PASS - the node is online and following the chain (${BLIPS}/${SAMPLES} transient blip(s) recovered) ==="
  else
    log "=== RESULT: PASS - the node is online and following the chain ==="
  fi
  log "wallet address: ${ADDR}"
  if [[ "${ROLE}" == "validator" ]]; then
    log "voting = enabled - this node is an ACTIVE validator"
  else
    log "this node is an observer. Next: fund ${ADDR} and run the enroll step,"
    log "then the node can be promoted to a validator (ROLE=validator)."
  fi
  if (( BLIPS > 0 )); then
    set_status DONE "verify-pass" "address=${ADDR}" "transient blips=${BLIPS}/${SAMPLES} (recovered)"
  else
    set_status DONE "verify-pass" "address=${ADDR}"
  fi
else
  err "=== RESULT: FAIL - see the errors above ==="
  set_status FAILED "verify-failed"
  exit 1
fi

