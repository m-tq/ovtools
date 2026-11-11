#!/usr/bin/env bash
# ===================================================================
# 20-exit-validator.sh - leave the validator set and get the stake back
#
# The node's own controls do the signing; this step drives the whole sequence:
#
#   1. `controls/enroll.sh exit`       -> exit intent + exit transaction
#      (state becomes `exiting`, the duty loop stops publishing readiness)
#   2. report WHEN the money comes back: the exit epoch the chain recorded and
#      the epoch the bond unlocks (`withdraw_epoch`), converted to a duration
#      with the measured epoch cadence - the two numbers the operator asks for
#   3. if the unbonding is already over: `controls/enroll.sh withdraw` and wait
#      until `validator_bond` is 0 (the stake is back in the wallet)
#   4. otherwise: arm octra-exit-withdraw.timer on the host. The timer retries
#      the withdrawal every 15 minutes - also after a reboot and with the
#      console closed - and disarms itself once the bond is gone. Nothing has to
#      be re-run by hand, and no week-long wait happens inside a step.
#
# Usage:  sudo bash 20-exit-validator.sh
# Env:    EXIT_WAIT=<sec>          wait for the set fold (default 900)
#         WITHDRAW_WAIT=<sec>      wait for the stake after the withdraw (default 900)
#         STATUS_POLL=<sec>        poll interval (default 20)
#         EXIT_PROGRESS_SEC=<sec>  progress line interval (default 120)
#         EPOCH_SECONDS=<sec>      epoch cadence (default: measured from the chain)
# Idempotent: a second run resumes wherever the first one stopped.
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
set_status RUNNING "exit-validator"

EXIT_WAIT="${EXIT_WAIT:-900}"
WITHDRAW_WAIT="${WITHDRAW_WAIT:-900}"
POLL="${STATUS_POLL:-20}"

ensure_tool jq jq || die "jq is missing and could not be installed"
[[ -f "${NODE_WALLET}" ]] || die "wallet.json is missing (${NODE_WALLET}) - is this the validator host?"
[[ -f "${NODE_ENV}" ]] || die "node.env is missing (${NODE_ENV})"

read_state
ADDR=$(wallet_address || echo unknown)
log "=== exit validator: ${ADDR} ==="
log "node: role=${ROLE:-?} process=${PROCESS:-?} rpc=${RPC:-?} voting=${VOTING:-?} epoch=${EPOCH:-?}"
log "membership: active=${ACTIVE:-?} scheduled=${SCHED:-?} enrollment=${ENROLL:-?} bond=$(raw_to_oct "${BOND:-0}") OCT"

# Already gone? (a previous run finished, or another host did it)
if [[ "${BOND:-0}" == "0" && "${ENROLL:-}" != "bonded" && "${ENROLL:-}" != "ready" && "${ENROLL:-}" != "exiting" ]]; then
  log "this wallet holds no bond on chain (enrollment=${ENROLL:-absent}) - nothing to exit"
  exit_watch_disarm
  echo "EXIT_DONE bond=0 state=${ENROLL:-absent}"
  set_status DONE "already exited (enrollment=${ENROLL:-absent}, bond 0)"
  exit 0
fi

status_events() { node_script 120 "sh controls/enroll.sh status" || true; }

# one line: state=exiting exit_epoch=123 withdraw_epoch=456 head=789 remaining=8000
enrollment_summary() {
  local events state exit_ep withdraw_ep head remaining
  events=$(status_events)
  state=$(printf '%s\n' "${events}" | grep -oE 'committed_enrollment state = [a-z]+' | awk '{print $4}' | tail -1 || true)
  exit_ep=$(printf '%s\n' "${events}" | grep -oE 'exit_epoch = [0-9]+' | awk '{print $3}' | tail -1 || true)
  withdraw_ep=$(printf '%s\n' "${events}" | grep -oE 'withdraw_epoch = [0-9]+' | awk '{print $3}' | tail -1 || true)
  head=$(printf '%s\n' "${events}" | grep -oE 'head_epoch = [0-9]+' | awk '{print $3}' | tail -1 || true)
  remaining=$(printf '%s\n' "${events}" | grep -oE 'remaining_epochs = [0-9]+' | awk '{print $3}' | tail -1 || true)
  printf 'state=%s exit_epoch=%s withdraw_epoch=%s head=%s remaining=%s\n' \
    "${state:-unknown}" "${exit_ep:-none}" "${withdraw_ep:-none}" "${head:-0}" "${remaining:-none}"
}

summary_value() { printf '%s' "$1" | sed -n "s/.*$2=\([^ ]*\).*/\1/p"; }

# The one line the console reads: state, both epochs, epochs left and the
# duration that follows from the measured cadence. Printed as soon as the chain
# has recorded the exit, i.e. before any wait - the operator learns the answer
# at once instead of watching a spinner for a week.
announce_schedule() {
  local summary="$1" state exit_ep withdraw_ep head remaining left rate secs eta
  state=$(summary_value "${summary}" state)
  exit_ep=$(summary_value "${summary}" exit_epoch)
  withdraw_ep=$(summary_value "${summary}" withdraw_epoch)
  head=$(summary_value "${summary}" head)
  remaining=$(summary_value "${summary}" remaining)
  rate=""
  secs=""
  eta=""
  if [[ "${state}" == "exiting" && "${withdraw_ep}" =~ ^[0-9]+$ ]]; then
    [[ "${remaining}" =~ ^[0-9]+$ ]] || remaining=$(( withdraw_ep - ${head:-0} ))
    (( remaining < 0 )) && remaining=0
    left="${remaining}"
    rate=$(epoch_seconds || true)
    if [[ -n "${rate}" ]]; then
      secs=$(epoch_eta "${left}" "${rate}" || true)
      [[ -n "${secs}" ]] && eta=$(fmt_duration "${secs}")
    fi
    log "the chain recorded the exit at epoch ${exit_ep}"
    if (( remaining == 0 )); then
      log "the unbonding period is over (unlock epoch ${withdraw_ep}, head ${head}) - the stake can be withdrawn"
    else
      log "the stake unlocks at epoch ${withdraw_ep}: ${remaining} epoch(s) from head ${head}${eta:+ - about ${eta} at ${rate}s per epoch}"
    fi
  fi
  printf 'EXIT_SCHEDULE state=%s exit_epoch=%s withdraw_epoch=%s head=%s remaining=%s rate=%s eta_seconds=%s\n' \
    "${state}" "${exit_ep}" "${withdraw_ep}" "${head:-0}" "${left:-none}" "${rate:-none}" "${secs:-none}"
  SCHED_STATE="${state}"     # the next caller can skip a second measurement
}

# --- 1. submit the exit ----------------------------------------------
SUMMARY=$(enrollment_summary)
log "enrollment: ${SUMMARY}"
if [[ "${SUMMARY}" == *"state=exiting"* ]]; then
  log "the exit is already committed - not signing another one"
else
  log "submitting the exit (controls/enroll.sh exit) - this pauses the validator duty"
  set +e
  OUT=$(node_script 600 "sh controls/enroll.sh exit")
  RC=$?
  set -e
  printf '%s\n' "${OUT}" | sed 's/^/    /'
  if (( RC != 0 )); then
    if printf '%s' "${OUT}" | grep -q "already committed"; then
      log "the exit was already committed on chain - continuing"
    elif printf '%s' "${OUT}" | grep -qE "refused|retry same command|retained"; then
      # the node keeps the signed transaction: the same command resumes it and the
      # exit lands at the next fold. That is a schedule, not an error.
      warn "the node kept the signed exit transaction: $(printf '%s' "${OUT}" | grep -oE 'reason = .*' | tail -1)"
      warn "the exit lands at the next set fold - nothing else has to be signed"
    elif printf '%s' "${OUT}" | grep -q "bond"; then
      warn "controls/enroll.sh exit reports nothing to exit (or it is already exiting)"
    else
      die "controls/enroll.sh exit failed (exit ${RC}) - see the output above"
    fi
  fi
fi

read_state
SUMMARY=$(enrollment_summary)
announce_schedule "${SUMMARY}"

# --- 2. wait (bounded) until the set released us and the unbonding is over --
START=$(date +%s)
LAST=${START}
VERDICT=""
while :; do
  read_state
  SUMMARY=$(enrollment_summary)
  STATE=$(summary_value "${SUMMARY}" state)
  WITHDRAW_EP=$(summary_value "${SUMMARY}" withdraw_epoch)
  HEAD=$(summary_value "${SUMMARY}" head)
  NOW=$(date +%s)

  if [[ "${STATE}" == "absent" && "${BOND:-0}" == "0" ]]; then
    log "the wallet is out of the set and holds no bond any more"
    exit_watch_disarm
    echo "EXIT_DONE bond=0 state=absent"
    set_status DONE "exited (enrollment absent, bond 0)"
    exit 0
  fi

  # withdrawable: exiting + not in the set + unbonding epoch reached
  if [[ "${STATE}" == "exiting" && "${ACTIVE:-false}" != "true" && "${SCHED:-false}" != "true" ]] \
     && { [[ -z "${WITHDRAW_EP}" || "${WITHDRAW_EP}" == "none" ]] \
          || { [[ "${HEAD:-0}" =~ ^[0-9]+$ ]] && [[ "${WITHDRAW_EP}" =~ ^[0-9]+$ ]] && (( HEAD >= WITHDRAW_EP )); }; }; then
    VERDICT="withdrawable"
    break
  fi

  # The exit is committed and the set already released this validator, but the
  # unbonding period is still running (weeks). There is NOTHING to wait for here:
  # the host timer retries until the unlock epoch arrives, so the step reports the
  # schedule and stops instead of sleeping for 15 minutes and saying "waiting for
  # the set" while the set has long released it (2026-11-06, seen on .231).
  if [[ "${STATE}" == "exiting" && "${ACTIVE:-false}" != "true" && "${SCHED:-false}" != "true" ]]; then
    VERDICT="unbonding"
    break
  fi

  if (( NOW - START >= EXIT_WAIT )); then
    VERDICT="pending"
    break
  fi
  if (( NOW - LAST >= EXIT_PROGRESS_SEC )); then
    HINT=$(post_hint)
    REASON="the set has not released this validator yet"
    [[ "${STATE}" == "exiting" ]] && REASON="the set is still folding the exit out"
    log "  waiting: ${REASON} (${SUMMARY}) active=${ACTIVE:-?} scheduled=${SCHED:-?}${HINT:+ (network: ${HINT})}"
    LAST=${NOW}
  fi
  sleep "${POLL}"
done

# --- 3. not yet: hand the long part to the host timer ----------------
# `pending` (the set has not released us yet) and `unbonding` (it did, the epoch
# has not arrived) end the same way: report the schedule, arm the timer, stop.
if [[ "${VERDICT}" != "withdrawable" ]]; then
  # the schedule was already printed right after the exit committed: do not print
  # (and measure) it twice - only when the state really changed since then
  if [[ "${SCHED_STATE:-}" != "$(summary_value "${SUMMARY}" state)" ]]; then
    announce_schedule "${SUMMARY}"
  fi
  exit_watch_install
  if [[ "${STATE}" == "exiting" ]]; then
    set_status WAITING-WITHDRAW "exited at epoch $(summary_value "${SUMMARY}" exit_epoch); the stake unlocks at epoch $(summary_value "${SUMMARY}" withdraw_epoch) ($(summary_value "${SUMMARY}" remaining) epoch(s) left) - the host withdraws it automatically"
  else
    set_status WAITING-EXIT "exit submitted; the set releases this validator at the next fold, then the stake unlocks at epoch $(summary_value "${SUMMARY}" withdraw_epoch) - the host withdraws it automatically"
  fi
  log "nothing else to do now: the console keeps following the unbonding, and this host retries the"
  log "withdrawal every 15 minutes (systemd timer ${EXIT_WATCH_UNIT}.timer) - re-running this phase is safe"
  exit 2
fi

log "unbonding finished (${SUMMARY}) - withdrawing the stake"
set +e
OUT=$(node_script 900 "sh controls/enroll.sh withdraw")
RC=$?
set -e
printf '%s\n' "${OUT}" | sed 's/^/    /'
if (( RC != 0 )); then
  if printf '%s' "${OUT}" | grep -qE "unbonding period incomplete|withdraw_epoch|waits for removal"; then
    warn "the chain is not ready for the withdrawal yet - the host timer keeps retrying"
    exit_watch_install
    set_status WAITING-WITHDRAW "withdrawal not signed yet (network) - the host retries it automatically"
    exit 2
  fi
  if printf '%s' "${OUT}" | grep -qE "already|previously_confirmed"; then
    log "the withdrawal was already submitted"
  else
    die "controls/enroll.sh withdraw failed (exit ${RC}) - see the output above"
  fi
fi

# --- 5. wait until the bond is back in the wallet ---------------------
START=$(date +%s)
LAST=${START}
while :; do
  read_state
  NOW=$(date +%s)
  if [[ "${BOND:-0}" == "0" ]]; then
    SUMMARY=$(enrollment_summary)
    log "stake returned: validator_bond = 0 (${SUMMARY})"
    exit_watch_disarm
    echo "EXIT_DONE bond=0 state=$(summary_value "${SUMMARY}" state)"
    set_status DONE "exited and withdrawn (bond 0, exit epoch $(summary_value "${SUMMARY}" exit_epoch))"
    exit 0
  fi
  if (( NOW - START >= WITHDRAW_WAIT )); then
    warn "the registry still shows a bond of $(raw_to_oct "${BOND:-0}") OCT after ${WITHDRAW_WAIT}s"
    warn "the withdrawal transaction is on chain - the host timer keeps checking, this phase can be re-run"
    exit_watch_install
    set_status WAITING-WITHDRAW "withdraw submitted - bond still $(raw_to_oct "${BOND:-0}") OCT; the host keeps checking"
    exit 2
  fi
  if (( NOW - LAST >= 60 )); then
    log "  waiting for the stake: bond $(raw_to_oct "${BOND:-0}") OCT ($(( NOW - START ))s of ${WITHDRAW_WAIT}s)"
    LAST=${NOW}
  fi
  sleep "${POLL}"
done