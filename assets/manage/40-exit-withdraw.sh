#!/usr/bin/env bash
# ===================================================================
# 40-exit-withdraw.sh - finish an exit: withdraw the stake when the chain allows it
#
# Installed by 20-exit-validator.sh as `octra-exit-withdraw.timer` (every 15
# minutes, also after a reboot). The chain only signs the withdrawal once the
# unbonding period is over AND the validator is out of the set - which can be
# weeks after the exit itself, far too long for a console step, and nobody
# should have to re-run anything by hand. So this job runs on the host:
#
#   * not yet allowed      -> one line in exit-watch.log, the next run retries
#   * the chain allows it  -> `controls/enroll.sh withdraw`, wait for
#                             validator_bond = 0, then disarm its own timer
#
# It never writes /root/manage/status: that file is the verdict of a step the
# console follows, and a timer must not overwrite it.
#
# Usage:  sudo bash 40-exit-withdraw.sh     (the timer runs this for you)
# Env:    WITHDRAW_TIMEOUT=<sec>  bound for enroll.sh withdraw (default 900)
#         BOND_WAIT=<sec>         wait for validator_bond = 0 (default 600)
# ===================================================================
set -uo pipefail
source "$(dirname "$0")/lib.sh"

# a timer job must never touch a step's verdict, and it must survive a command it
# is *expecting* to fail (the chain refuses a withdrawal that is too early):
# lib.sh turns `set -e` on, so it is turned off here again.
trap - ERR
set +e
WATCH_STATUS="${EXIT_WATCH_STATUS:-${MANAGE_DIR}/exit-watch.status}"
WATCH_LOG="${EXIT_WATCH_LOG:-${MANAGE_DIR}/exit-watch.log}"
WITHDRAW_TIMEOUT="${WITHDRAW_TIMEOUT:-900}"
BOND_WAIT="${BOND_WAIT:-600}"

mkdir -p "${MANAGE_DIR}" 2>/dev/null || true
log() { echo -e "[exit-watch] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "${WATCH_LOG}"; }

record() {  # record <RESULT> <detail...> - read by the console (30-status.sh)
  local result="$1"
  shift
  printf '%s %s %s\n' "${result}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" > "${WATCH_STATUS}"
}

summary_value() { printf '%s' "$1" | sed -n "s/.*$2=\([^ ]*\).*/\1/p"; }

enrollment_summary() {
  local events state exit_ep withdraw_ep head remaining
  events=$(node_script 120 "sh controls/enroll.sh status" || true)
  state=$(printf '%s\n' "${events}" | grep -oE 'committed_enrollment state = [a-z]+' | awk '{print $4}' | tail -1 || true)
  exit_ep=$(printf '%s\n' "${events}" | grep -oE 'exit_epoch = [0-9]+' | awk '{print $3}' | tail -1 || true)
  withdraw_ep=$(printf '%s\n' "${events}" | grep -oE 'withdraw_epoch = [0-9]+' | awk '{print $3}' | tail -1 || true)
  head=$(printf '%s\n' "${events}" | grep -oE 'head_epoch = [0-9]+' | awk '{print $3}' | tail -1 || true)
  remaining=$(printf '%s\n' "${events}" | grep -oE 'remaining_epochs = [0-9]+' | awk '{print $3}' | tail -1 || true)
  printf 'state=%s exit_epoch=%s withdraw_epoch=%s head=%s remaining=%s\n' \
    "${state:-unknown}" "${exit_ep:-none}" "${withdraw_ep:-none}" "${head:-0}" "${remaining:-none}"
}

read_state
ADDR=$(wallet_address || echo unknown)

# --- already finished? -------------------------------------------------
if [[ "${BOND:-0}" == "0" && "${ENROLL:-}" != "bonded" && "${ENROLL:-}" != "ready" && "${ENROLL:-}" != "exiting" ]]; then
  log "${ADDR}: no bond on chain any more (enrollment=${ENROLL:-absent}) - the exit is complete"
  record DONE "bond 0 (enrollment=${ENROLL:-absent}) - nothing left to withdraw"
  exit_watch_disarm
  exit 0
fi


SUMMARY=$(enrollment_summary)
STATE=$(summary_value "${SUMMARY}" state)
WITHDRAW_EP=$(summary_value "${SUMMARY}" withdraw_epoch)
HEAD=$(summary_value "${SUMMARY}" head)
REMAINING=$(summary_value "${SUMMARY}" remaining)

if [[ "${STATE}" != "exiting" ]]; then
  log "${ADDR}: the exit is not committed yet (enrollment=${ENROLL:-?}, state=${STATE:-unknown}) - the console submits it"
  record WAITING "exit not committed yet (state=${STATE:-unknown}, enrollment=${ENROLL:-?})"
  exit 0
fi

if [[ "${REMAINING}" =~ ^[0-9]+$ ]] && (( REMAINING > 0 )); then
  RATE=$(epoch_seconds || true)
  ETA=""
  if [[ -n "${RATE}" ]]; then
    SECS=$(epoch_eta "${REMAINING}" "${RATE}" || true)
    [[ -n "${SECS}" ]] && ETA=$(fmt_duration "${SECS}")
  fi
  log "${ADDR}: unbonding - head ${HEAD} of unlock epoch ${WITHDRAW_EP}, ${REMAINING} epoch(s) left${ETA:+ (about ${ETA})}"
  record WAITING "unbonding: head ${HEAD} of ${WITHDRAW_EP} (${REMAINING} epoch(s) left${ETA:+, about ${ETA}})"
  exit 0
fi

# --- the chain allows the withdrawal now -------------------------------
if [[ "${ACTIVE:-false}" == "true" || "${SCHED:-false}" == "true" ]]; then
  log "${ADDR}: unbonding over, but the validator is still in the set (active=${ACTIVE:-?} scheduled=${SCHED:-?}) - retrying"
  record WAITING "unbonding over, still in the set (active=${ACTIVE:-?} scheduled=${SCHED:-?})"
  exit 0
fi

log "${ADDR}: unbonding over (head ${HEAD}, unlock epoch ${WITHDRAW_EP}) - signing the withdrawal"
# no `|| true` here: the exit status of the signing attempt decides whether this
# run is a WAITING (the chain refuses) or an ERROR (something is wrong)
OUT=$(node_script "${WITHDRAW_TIMEOUT}" "sh controls/enroll.sh withdraw")
RC=$?
printf '%s\n' "${OUT}" | sed 's/^/    /' >> "${WATCH_LOG}"
if (( RC != 0 )) && ! printf '%s' "${OUT}" | grep -qE "already|previously_confirmed"; then
  if printf '%s' "${OUT}" | grep -qE "unbonding period incomplete|waits for removal"; then
    log "the chain still refuses the withdrawal ($(printf '%s' "${OUT}" | grep -oE 'unbonding period incomplete.*|withdrawal waits.*' | tail -1)) - retrying"
    record WAITING "chain refused the withdrawal - retrying every 15 min"
    exit 0
  fi
  log "the withdrawal failed (exit ${RC}) - see the lines above; the next run retries"
  record ERROR "withdraw failed (exit ${RC})"
  exit 1
fi

START=$(date +%s)
while :; do
  read_state
  if [[ "${BOND:-0}" == "0" ]]; then
    log "${ADDR}: stake returned - validator_bond = 0, the exit is complete"
    record DONE "stake returned (bond 0, exit epoch $(summary_value "${SUMMARY}" exit_epoch))"
    exit_watch_disarm
    exit 0
  fi
  if (( $(date +%s) - START >= BOND_WAIT )); then
    log "${ADDR}: withdrawal submitted, the registry still shows $(raw_to_oct "${BOND:-0}") OCT - retrying"
    record WAITING "withdraw submitted, bond still $(raw_to_oct "${BOND:-0}") OCT"
    exit 0
  fi
  sleep 20
done
