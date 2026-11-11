#!/usr/bin/env bash
# ===================================================================
# 10-bond-increase.sh - add OCT to the bond of the ACTIVE validator
#
# Runs the node's own `bond_inc.sh` as the `octra` user, from the node
# directory, and verifies the registry afterwards:
#
#   bash bond_inc.sh -a <OCT> -w <wallet.json>            (first increase)
#   bash bond_inc.sh -a <OCT> -w <wallet.json> --new      (every later one)
#
# `bond_inc.sh` keeps ONE signed increase in
# $OCTRA_DATA_DIR/validator-control/bond-increase.json:
#   * no record                  -> plain run (the first increase)
#   * record, tx confirmed       -> `--new` is required, otherwise the call is a
#                                   silent no-op (it just reports "confirmed")
#   * record, tx pending/staging -> nothing new may be signed, wait instead
# This step therefore decides `--new` from the record itself; the operator only
# types the amount.
#
# Usage:  BOND_OCT=100 sudo bash 10-bond-increase.sh
# Env:    BOND_OCT=<OCT>    additional amount, e.g. 100 or 12.5 (min 1)
#         BOND_NEW=1        force --new (the console sets it when it knows better)
#         BOND_WAIT=<sec>   how long to wait for the registry (default 300)
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
set_status RUNNING "bond-increase"

BOND_OCT="${BOND_OCT:-}"
[[ -n "${BOND_OCT}" ]] || die "BOND_OCT is empty - type the amount to add (e.g. 100 for +100 OCT)"
AMOUNT_RAW=$(oct_to_raw "${BOND_OCT}")
(( AMOUNT_RAW >= TOKEN_UNIT )) || die "the protocol minimum is 1 OCT (got ${BOND_OCT})"
FORCE_NEW="${BOND_NEW:-0}"
WAIT="${BOND_WAIT:-300}"

ensure_tool jq jq || die "jq is missing and could not be installed"
ensure_tool python3 python3 || die "python3 is missing and could not be installed"

[[ -f "${NODE_WALLET}" ]] || die "wallet.json is missing (${NODE_WALLET}) - is this the validator host?"
[[ -f "${NODE_ENV}" ]] || die "node.env is missing (${NODE_ENV})"

read_state
ADDR=$(wallet_address || echo unknown)
log "=== increase bond: +${BOND_OCT} OCT (${AMOUNT_RAW} raw) on ${ADDR} ==="
log "node: role=${ROLE:-?} process=${PROCESS:-?} rpc=${RPC:-?} epoch=${EPOCH:-?}"
log "membership: active=${ACTIVE:-?} scheduled=${SCHED:-?} enrollment=${ENROLL:-?} bond=$(raw_to_oct "${BOND:-0}") OCT"

# The bond of a validator can only be raised on the host that runs it, and only
# while it is in the active set - `bond_inc.sh` refuses otherwise with
# "active ready validator required".
[[ "${ACTIVE}" == "true" ]] || die "this host is not an active validator (active=${ACTIVE:-?}, scheduled=${SCHED:-?}) - increase the bond on the host that votes"
[[ "${RPC}" == "ready" ]] || die "the node rpc is not ready (${RPC:-unknown}) - wait for the sync, then try again"

BEFORE="${BOND:-0}"
[[ "${BEFORE}" =~ ^[0-9]+$ ]] || BEFORE=0

install_bond_inc
show_saved_increase
SAVED=$(saved_increase_path)

NEW_FLAG=""
if [[ -n "${SAVED}" ]]; then
  # a signed increase is stored: only `--new` may sign another one, and
  # bond_inc.sh checks that the previous one is confirmed before it does
  NEW_FLAG="--new"
  log "a saved increase exists - running with --new (the previous one must be confirmed)"
elif [[ "${FORCE_NEW}" == "1" ]]; then
  NEW_FLAG="--new"
  log "the console asked for --new"
fi

run_bond_inc() {  # run_bond_inc [--new]  -> prints the tool output, returns its code
  local extra="${1:-}" rc
  set +e
  # shellcheck disable=SC2086
  ( cd "${NODE_SRC_DIR}" && timeout 300 su - "${NODE_USER}" -c \
      "cd ${NODE_SRC_DIR} && sh ./bond_inc.sh -a ${BOND_OCT} -w ${NODE_WALLET} ${extra}" ) 2>&1
  rc=$?
  set -e
  return "${rc}"
}

log "running bond_inc.sh -a ${BOND_OCT} -w ${NODE_WALLET} ${NEW_FLAG}"

# Poll the registry until the bond really moved. The tool prints "accepted" as
# soon as the RPC took the transaction; the bond is only final after the epoch
# that includes it, so the step (not the tool) decides when the increase landed.
wait_for_registry() {  # wait_for_registry <before_raw> <label>
  local before="$1" label="${2:-bond increase submitted}"
  local target=$(( before + AMOUNT_RAW )) current now start last
  start=$(date +%s)
  last=${start}
  while :; do
    read_state
    current="${BOND:-0}"
    [[ "${current}" =~ ^[0-9]+$ ]] || current=0
    if (( current >= target )); then
      log "bond is now $(raw_to_oct "${current}") OCT (+$(raw_to_oct "$(( current - before ))") OCT) - tx ${TX:-?}"
      set_status DONE "bond $(raw_to_oct "${current}") OCT (added $(raw_to_oct "$(( current - before ))") OCT, tx ${TX:-unknown})"
      exit 0
    fi
    now=$(date +%s)
    if (( now - start >= WAIT )); then
      warn "${label}: the registry still shows $(raw_to_oct "${current}") OCT after ${WAIT}s (expected $(raw_to_oct "${target}"))"
      warn "check the transaction with: su - ${NODE_USER} -c 'cd ${NODE_SRC_DIR} && sh controls/enroll.sh status'"
      set_status WAITING-CONFIRM "tx ${TX:-unknown} pending - bond $(raw_to_oct "${current}") of $(raw_to_oct "${target}") OCT; re-run to re-check"
      exit 2
    fi
    if (( now - last >= 30 )); then
      log "  waiting for the registry: bond $(raw_to_oct "${current}") of $(raw_to_oct "${target}") OCT ($(( now - start ))s of ${WAIT}s)"
      last=${now}
    fi
    sleep 10
  done
}

set +e
OUT=$(run_bond_inc "${NEW_FLAG}")
BOND_RC=$?
set -e
printf '%s\n' "${OUT}" | sed 's/^/    /'
TX=$(printf '%s\n' "${OUT}" | awk '/^tx = /{print $3; exit}')
STATUS_LINE=$(printf '%s\n' "${OUT}" | awk '/event = bond_inc /{print; exit}')

# `saved increase differs` means the stored record no longer matches this wallet
# or the registry: the documented remedy is bond-inspect.sh + --new once the
# previous transaction is confirmed. Never sign blindly a second time.
if printf '%s' "${OUT}" | grep -q "saved increase differs"; then
  log "the stored increase no longer matches the registry - the tool refuses to sign another one"
  log "inspect it with: sudo bash ${MANAGE_DIR}/bond-inspect.sh -a ${BOND_OCT}"
  die "saved increase differs; inspect the stored record before requesting another increase"
fi
if printf '%s' "${OUT}" | grep -q "previous increase is not confirmed"; then
  wait_for_registry "${BEFORE}" "the previous increase is not confirmed yet"
fi
if printf '%s' "${OUT}" | grep -qE "account has pending transactions|submission unresolved|submission not acknowledged"; then
  warn "the submission is unresolved (tx ${TX:-unknown}) - the payment is stored on the host"
  warn "re-run the same amount to resubmit it (bond_inc.sh reuses the saved payment)"
  set_status WAITING-CONFIRM "tx ${TX:-unknown} submitted but not acknowledged - re-run increase ${BOND_OCT} OCT"
  exit 2
fi
if (( BOND_RC != 0 )); then
  die "bond_inc.sh refused (exit ${BOND_RC}): ${STATUS_LINE:-see the output above}"
fi

wait_for_registry "${BEFORE}" "bond increase submitted"
