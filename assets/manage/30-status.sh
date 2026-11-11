#!/usr/bin/env bash
# ===================================================================
# 30-status.sh - read-only overview of the ACTIVE node
#
# Prints what the console shows for the manage program: identity, membership,
# bond, wallet balance, the saved bond-increase record and the validator
# pointer. It signs nothing, restarts nothing.
#
# Usage:  sudo bash 30-status.sh
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
set_status RUNNING "status"

ensure_tool jq jq || die "jq is missing and could not be installed"
ensure_tool curl curl || die "curl is missing and could not be installed"

read_state
ADDR=$(wallet_address || echo unknown)
PORT=$(node_env_value OCTRA_API_PORT)
PORT="${PORT:-8080}"

rpc() {  # rpc <method> <params-json>
  timeout 20 curl -s -X POST -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" \
    "http://127.0.0.1:${PORT}/rpc" 2>/dev/null || true
}

BALANCE_RAW=$(rpc octra_balance "[\"${ADDR}\"]" | jq -r '.result.balance // empty' 2>/dev/null || true)
[[ "${BALANCE_RAW}" =~ ^[0-9]+$ ]] || BALANCE_RAW=0

log "=== active node: $(hostname) ==="
log "wallet        : ${ADDR}"
log "role          : ${ROLE:-?}   process: ${PROCESS:-?}   rpc: ${RPC:-?}   voting: ${VOTING:-?}"
log "epoch         : ${EPOCH:-?}"
log "membership    : active=${ACTIVE:-?} scheduled=${SCHED:-?} enrollment=${ENROLL:-?}"
log "bond          : $(raw_to_oct "${BOND:-0}") OCT"
log "wallet balance: $(raw_to_oct "${BALANCE_RAW}") OCT"

PATH_SAVED=$(saved_increase_path)
if [[ -n "${PATH_SAVED}" ]]; then
  log "saved increase:"
  jq -r '"    amount = \(.amount) raw, stage = \(.stage), tx = \(.tx_hash)"' "${PATH_SAVED}" 2>/dev/null | sed 's/^/  /' || true
  log "  a further increase needs --new (the console adds it automatically)"
else
  log "saved increase: none (the next increase is the first one, no --new)"
fi

log "--- enroll.sh status ---"
node_script 120 "sh controls/enroll.sh status" | grep -E '^(event = (membership|committed_enrollment|enrollment_tx|validator_pointer))' | sed 's/^/    /' || true

# an exit leaves the withdrawal to the host timer: say where it stands, so the
# operator never has to re-run a phase (or read a systemd unit) to find out
EXIT_WATCH=$(exit_watch_status || true)
if [[ -n "${EXIT_WATCH}" ]]; then
  log "--- withdrawal ---"
  log "    ${EXIT_WATCH}"
  log "    retried every 15 minutes by ${EXIT_WATCH_UNIT}.timer (also after a reboot)"
fi

set_status DONE "role=${ROLE:-?} active=${ACTIVE:-?} bond=$(raw_to_oct "${BOND:-0}") OCT balance=$(raw_to_oct "${BALANCE_RAW}") OCT"
