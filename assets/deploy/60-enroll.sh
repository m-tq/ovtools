#!/usr/bin/env bash
# ===================================================================
# 60-enroll.sh - join the validator set (needs a funded wallet)
#
#   * refuses to enroll unless the node RPC is ready (a node that is still
#     syncing cannot commit the join)
#   * calls the node's own controls/enroll.sh join --amount <raw>
#   * when the wallet is not funded yet it exits 2 with state WAITING-FUNDING and
#     prints the address to fund - that is not a failure, it is the next step
#
# Usage:  sudo bash 60-enroll.sh [amount_raw]
#         sudo bash 60-enroll.sh status
# Env:    BOND_AMOUNT (default 1000000 raw = the protocol minimum)
#         ENROLL_WAIT (600 s) - how long to follow the join before the soft stop
#         ENROLL_PROGRESS_SEC (60) / STATUS_POLL (10) - progress line + poll interval
#         JOIN_ATTEMPTS (3) / JOIN_RETRY_WAIT (10 s) - the node can answer a join
#             with "bond submission unresolved; signed transaction retained; retry
#             same command", so the same command is retried before anything is
#             reported (2026-11-05)
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
ensure_tool curl curl || die "curl is missing and could not be installed"
ensure_tool jq   jq   || die "jq is missing and could not be installed"
ACTION="${1:-join}"
BOND_AMOUNT="${2:-${BOND_AMOUNT:-1000000}}"

if [[ "${ACTION}" == "status" ]]; then
  set_status RUNNING "enroll-status"
  as_octra "cd ${NODE_SRC_DIR} && sh controls/enroll.sh status" 2>&1 | sed 's/^/    /' || true
  set_status DONE "enroll-status"
  exit 0
fi

if [[ "${ACTION}" != "join" ]]; then
  die "unknown action '${ACTION}' (join|status)"
fi

set_status RUNNING "enroll"

ENROLL_HELPER="${ENROLL_HELPER:-/root/node-enroll.sh}"
[[ -f "${NODE_WALLET}" ]] || die "wallet.json is missing - run the setup step first"
[[ -f "${ENROLL_HELPER}" ]] || die "node-enroll.sh is missing at ${ENROLL_HELPER} - push the scripts first"

ADDR=$(wallet_address || echo unknown)
log "=== enroll: ${ADDR} with amount ${BOND_AMOUNT} (raw) ==="

# 2026-11-03 (real incident): the bond transaction was confirmed in the explorer
# while this step sat on `controls/enroll.sh join` for 33 minutes with NO output -
# the old code captured the join in $(...) and had no timeout. The join is the
# node's whole enrollment (bond -> readiness via its duty loop -> wait for the
# set fold -> activation commit -> ROLE=validator + restart), and the public RPC
# kept refusing the readiness post. So:
#   * the join runs in its OWN unit and is streamed, so it neither looks stuck
#     nor dies when this step stops,
#   * the state on the host/chain decides the verdict, not the exit code,
#   * a membership that is already on chain never gets a second join,
#   * the reason the network gives ("validator ready head has expired", "invalid
#     nonce", HTTP 429) is quoted from the node log.
STATE_TIMEOUT="${STATE_TIMEOUT:-120}"       # stat.sh is read-only and must not hang

read_state() {  # fills SNAP/RPC/ACTIVE/SCHED/ENROLL/BOND/EPOCH/NEXT_SET/ACT_EPOCH
  SNAP=$(timeout "${STATE_TIMEOUT}" su - "${NODE_USER}" -c \
    "cd ${NODE_SRC_DIR} && sh controls/stat.sh" 2>/dev/null || true)
  RPC=$(printf '%s\n' "${SNAP}" | stat_field rpc)
  ACTIVE=$(printf '%s\n' "${SNAP}" | stat_field validator_active)
  SCHED=$(printf '%s\n' "${SNAP}" | stat_field validator_scheduled)
  ENROLL=$(printf '%s\n' "${SNAP}" | stat_field validator_enrollment)
  BOND=$(printf '%s\n' "${SNAP}" | stat_field validator_bond)
  EPOCH=$(printf '%s\n' "${SNAP}" | stat_field epoch)
  # the chain tells us WHEN the validator is admitted (the set fold) and when it
  # was activated - these two epochs are what the operator needs to read instead
  # of a red error (2026-11-05)
  NEXT_SET=$(printf '%s\n' "${SNAP}" | stat_field validator_next_set_epoch)
  ACT_EPOCH=$(printf '%s\n' "${SNAP}" | stat_field validator_activation_epoch)
}

# What the chain says will happen next, in one line the console can read back:
#   SCHEDULE next_set_epoch=1798156 activation_epoch=1798156 bond=24000000
schedule_line() {
  printf 'SCHEDULE next_set_epoch=%s activation_epoch=%s bond=%s epoch=%s' \
    "${NEXT_SET:--}" "${ACT_EPOCH:--}" "${BOND:--}" "${EPOCH:--}"
}

# The enrollment state is the authority: `bonded`/`ready` means the wallet is in
# the protocol's enrollment table, and `exiting` means it is still in it on its way
# out - signing another join in any of those is a SECOND bond. `validator_bond` is
# a number when the node can read it and EMPTY when it cannot (`stat_field` maps
# the node's Python `None` to an empty value): the old test compared the literal
# string "None" and counted it as a bond, so a missing bond looked like a bond.
enrolled_on_chain() {
  case "${ENROLL:-}" in
    bonded|ready|exiting) return 0 ;;
  esac
  [[ "${BOND:-0}" =~ ^[0-9]+$ && "${BOND:-0}" != "0" ]]
}

read_state
log "node: rpc=${RPC:-?} epoch=${EPOCH:-?}"
log "membership: active=${ACTIVE:-?} scheduled=${SCHED:-?} enrollment=${ENROLL:-?} bond=${BOND:--}"

if [[ "${ACTIVE}" == "true" ]]; then
  log "this wallet is already an active validator - nothing to enroll"
  set_status DONE "already active (bond ${BOND:-?})"
  exit 0
fi
if [[ "${SCHED}" == "true" ]]; then
  log "this wallet is already scheduled for the next set - nothing to enroll"
  set_status DONE "already scheduled (bond ${BOND:-?})"
  exit 0
fi
if enrolled_on_chain; then
  log "this wallet is already enrolled on chain (bond ${BOND:--}, enrollment ${ENROLL})"
  if [[ "${ENROLL}" == "ready" ]]; then
    log "readiness is committed - the set fold admits it on its own (the promote step waits for that)"
  else
    log "the bond is committed; the node publishes readiness from its duty loop"
    log "re-run -Phase enroll to follow it, or -Phase promote once the node reports scheduled"
  fi
  set_status DONE "already enrolled (bond ${BOND:--}, enrollment ${ENROLL})"
  exit 0
fi

if [[ "${RPC}" != "ready" ]]; then
  die "the node rpc is not ready (${RPC:-unknown}) - start the node and wait for sync first"
fi

# --- submit the join in its OWN transient unit -------------------------
# `controls/enroll.sh join` is the whole enrollment: bond -> (the node's duty
# loop publishes readiness) -> wait for the set fold -> wait for the activation
# commit -> write ROLE=validator + CONSENSUS_MODE=bft and restart the node.
# 2026-11-03 that took ~33 minutes because the public RPC kept refusing the
# readiness post ("validator ready head has expired", "invalid nonce", HTTP 429).
# So the join runs as its own unit: this step can report progress and stop
# WITHOUT killing the work the node is doing. post_hint() (lib.sh) quotes the
# last refusal.
JOIN_UNIT="${JOIN_UNIT:-octra-enroll-join}"
JOIN_OUT="${DEPLOY_DIR}/enroll-join.out"
ENROLL_WAIT="${ENROLL_WAIT:-900}"

join_active() { systemctl is-active --quiet "${JOIN_UNIT}" 2>/dev/null; }

start_join() {
  : > "${JOIN_OUT}"
  systemctl reset-failed "${JOIN_UNIT}" 2>/dev/null || true
  systemd-run --unit="${JOIN_UNIT}" --collect --no-block --working-directory=/root \
    --setenv=TERM=dumb --setenv=DEBIAN_FRONTEND=noninteractive \
    bash -c "su - ${NODE_USER} -c 'cd ${NODE_SRC_DIR} && sh controls/enroll.sh join --amount ${BOND_AMOUNT}' >> '${JOIN_OUT}' 2>&1" \
    || die "could not start the enroll join unit ${JOIN_UNIT}"
}

log "the node publishes readiness itself, then waits for the set fold - this can take 10-40 min"
JOIN_ATTEMPTS="${JOIN_ATTEMPTS:-3}"     # "retry same command" is the node's own advice
JOIN_RETRY_WAIT="${JOIN_RETRY_WAIT:-10}"

# The node can answer a join with
#   status = refused reason = bond submission unresolved; signed transaction
#   retained; retry same command; tx = d8cad812...
# The bond WAS signed and kept - only the submission did not go through in that
# window. 2026-11-05 (.231) this was reported FAILED while a plain retry landed the
# bond seconds later, so the statement "retry same command" is followed here.
join_retry_reason() {
  { grep -aoE 'bond submission unresolved[^"]{0,80}' "${JOIN_OUT}" 2>/dev/null | tail -1 || true; }
}

join_tx() {
  { grep -aoE 'tx = [0-9a-fA-F]{8,}' "${JOIN_OUT}" 2>/dev/null | tail -1 | awk '{print $3}' || true; }
}

# run the join once and follow it -> VERDICT (membership|ready|join-gone|wait)
run_join_once() {
  log "submitting the join in unit ${JOIN_UNIT} (controls/enroll.sh join --amount ${BOND_AMOUNT})"
  start_join
  sleep 3
  tail -n +1 -F "${JOIN_OUT}" 2>/dev/null &
  TAIL_PID=$!

  START=$(date +%s)
  LAST=${START}
  VERDICT=""
  POLL="${STATUS_POLL:-10}"          # how often the state is re-read (tests shrink it)
  while :; do
    read_state
    if [[ "${ACTIVE}" == "true" || "${SCHED}" == "true" ]]; then VERDICT="membership"; break; fi
    if [[ "${ENROLL}" == "ready" ]]; then VERDICT="ready"; break; fi
    if ! join_active; then VERDICT="join-gone"; break; fi
    NOW=$(date +%s)
    if (( NOW - START >= ENROLL_WAIT )); then VERDICT="wait"; break; fi
    if (( NOW - LAST >= ENROLL_PROGRESS_SEC )); then
      HINT=$(post_hint)
      log "  enrolling: $(( NOW - START ))s of ${ENROLL_WAIT}s - enrollment=${ENROLL:-?} scheduled=${SCHED:-?}${NEXT_SET:+ set fold at epoch ${NEXT_SET}}${HINT:+ (network said: ${HINT})}"
      LAST=${NOW}
    fi
    sleep "${POLL}"
  done
  kill "${TAIL_PID}" 2>/dev/null || true
  wait "${TAIL_PID}" 2>/dev/null || true
}

ATTEMPT=0
while :; do
  ATTEMPT=$(( ATTEMPT + 1 ))
  run_join_once
  if [[ "${VERDICT}" == "join-gone" && -n "$(join_retry_reason)" ]]; then
    read_state
    if ! enrolled_on_chain && (( ATTEMPT < JOIN_ATTEMPTS )); then
      warn "the node retained the signed bond and asks for a retry (attempt ${ATTEMPT}/${JOIN_ATTEMPTS}, tx $(join_tx))"
      sleep "${JOIN_RETRY_WAIT}"
      continue
    fi
  fi
  break
done

# the join restarts the node as validator when it is done: give it a moment
# before the state is read for the verdict
SETTLE_SEC="${SETTLE_SEC:-120}"
if [[ "${VERDICT}" == "join-gone" ]]; then
  SETTLE_START=$(date +%s)
  while (( $(date +%s) - SETTLE_START < SETTLE_SEC )); do
    read_state
    [[ "${ACTIVE}" == "true" || "${SCHED}" == "true" || "${ENROLL}" == "ready" ]] && break
    sleep 5
  done
fi

read_state
ROLE_NOW=$(printf '%s\n' "${SNAP}" | stat_field role)
log "after the join: role=${ROLE_NOW:-?} active=${ACTIVE:-?} scheduled=${SCHED:-?} enrollment=${ENROLL:-?} bond=${BOND:--}"
# The chain says WHEN this validator is admitted (the set fold) and when it was
# activated: that sentence is what the operator needs instead of a red error.
if [[ -n "${NEXT_SET}" ]]; then
  log "$(schedule_line)"
  log "the set fold admits this validator at epoch ${NEXT_SET} (now ${EPOCH:-?}) - it activates itself and starts voting"
fi

if [[ "${ACTIVE}" == "true" || "${SCHED}" == "true" ]]; then
  log "the node is in the set (active=${ACTIVE} scheduled=${SCHED} role=${ROLE_NOW:-?}${ACT_EPOCH:+, activation epoch ${ACT_EPOCH}})"
  set_status DONE "membership active=${ACTIVE} scheduled=${SCHED} role=${ROLE_NOW:-?}"
  exit 0
fi
if [[ "${ENROLL}" == "ready" ]]; then
  log "readiness is committed on chain (validator_enrollment = ready)"
  log "the set fold schedules it next and the node switches its own role - the promote step waits for that"
  set_status DONE "enrollment ready (bond ${BOND}) - set fold at epoch ${NEXT_SET:-unknown}"
  exit 0
fi

HINT=$(post_hint)
# A bond that is already on chain is NOT a failure: the chain admits the validator
# at the set fold and the node promotes itself. Report the epoch instead.
if enrolled_on_chain; then
  if [[ -n "${NEXT_SET}" ]]; then
    log "the bond is on chain (bond ${BOND:--}, enrollment ${ENROLL}) - set fold at epoch ${NEXT_SET}"
  else
    log "the bond is on chain (bond ${BOND:--}, enrollment ${ENROLL}) - the node publishes readiness from its duty loop"
  fi
  if [[ -n "$(join_retry_reason)" ]]; then
    # the tx is signed and kept, only the submission did not go through
    set_status WAITING-CONFIRM "bond ${BOND:--} on chain, signed tx $(join_tx) still unresolved - re-run enroll to submit it again"
    exit 2
  fi
  set_status WAITING-FOLD "bond ${BOND:--} on chain - scheduled for set epoch ${NEXT_SET:-unknown}; re-run enroll or promote later"
  exit 2
fi

if [[ "${VERDICT}" == "wait" ]]; then
  warn "enrollment is still pending after ${ENROLL_WAIT}s${HINT:+ - the network refused the readiness post: ${HINT}}"
  warn "the node's own join keeps running in unit ${JOIN_UNIT} (follow: tail -f ${JOIN_OUT})"
  warn "this is not a failure: the node waits for the set fold${NEXT_SET:+ at epoch ${NEXT_SET}}"
  warn "re-run this step (Start deploy again / -Phase enroll), or -Phase promote once it reports ready"
  set_status WAITING-FOLD "enrollment=${ENROLL:-unknown} pending after ${ENROLL_WAIT}s${NEXT_SET:+ - set fold at epoch ${NEXT_SET}}${HINT:+ - ${HINT}} - the join keeps running"
  exit 2
fi

# The node kept the signed transaction: the same command submits it again. Never
# report this as a failure (2026-11-05: the bond landed on the retry).
if [[ -n "$(join_retry_reason)" ]]; then
  warn "the node retained a signed bond transaction but the submission stayed unresolved"
  warn "re-run this step (Start deploy again / -Phase enroll): the same command submits the retained tx"
  set_status WAITING-CONFIRM "signed bond tx $(join_tx) retained after ${JOIN_ATTEMPTS} attempt(s) - re-run enroll to submit it"
  exit 2
fi

if grep -qiE 'insufficient|not enough|balance|fund|stake|amount' "${JOIN_OUT}" 2>/dev/null; then
  log "--- the wallet is not funded yet ---"
  log "send OCTRA to: ${ADDR}"
  log "then re-run this step (the console: Start deploy again / -Phase enroll)"
  set_status WAITING-FUNDING "${ADDR} needs ${BOND_AMOUNT} raw - fund it and re-run enroll"
  exit 2
fi
if grep -qi 'selection status = pending' "${JOIN_OUT}" 2>/dev/null; then
  warn "the network has not selected this validator yet${HINT:+ (last refusal: ${HINT})}"
  warn "re-run -Phase enroll later, or -Phase promote once the node reports scheduled"
  set_status WAITING-FOLD "not selected yet${NEXT_SET:+ - set fold at epoch ${NEXT_SET}}${HINT:+ - ${HINT}}"
  exit 2
fi

warn "--- last join output ---"
tail -n 20 "${JOIN_OUT}" 2>/dev/null | sed 's/^/    /' || true
die "controls/enroll.sh join ended without a membership${HINT:+ (last network refusal: ${HINT})}"
