#!/usr/bin/env bash
# ===================================================================
# 40-storage-prune.sh - "Remove preserved states" (upstream README)
#
#   sh controls/storage.sh                        # report
#   sh controls/storage.sh --prune-prior --yes    # drop the previous states
#   sh controls/storage.sh                        # report again
#
# A node keeps the states of the previous epochs ("prior"/preserved states) so it
# can serve peers that lag behind; they grow until the store is oversized. The
# documented maintenance is to drop them from time to time - which is also what
# the daily prune job on this host now does (dashboard/prune-node-junk.sh).
#
# Read-only when PRUNE_APPLY=0. Nothing else on the node is touched: no sync, no
# re-enroll, the node keeps running.
#
# Usage:  sudo bash 40-storage-prune.sh
# Env:    PRUNE_APPLY (1) - 0 = report only
#         PRUNE_TIMEOUT (900) / STORAGE_TIMEOUT (180)
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
set_status RUNNING "storage-prune"

APPLY="${PRUNE_APPLY:-1}"
[[ -f "${STORAGE_SH}" ]] || die "controls/storage.sh is missing on this node - update the node first (the tool does not exist on this version)"

log "=== preserved states on $(hostname) ==="
log "--- storage before ---"
BEFORE=$(storage_report)
printf '%s\n' "${BEFORE}" | sed 's/^/    /'
BEFORE_LINE=$(printf '%s\n' "${BEFORE}" | grep -iE 'preserved|reclaim|prior' | tail -1 || true)

if [[ "${APPLY}" != "1" ]]; then
  log "PRUNE_APPLY=0: report only - nothing was pruned"
  set_status DONE "report-only${BEFORE_LINE:+ - ${BEFORE_LINE}}"
  exit 0
fi

read_state
log "node while pruning: process=${PROCESS:-?} rpc=${RPC:-?} role=${ROLE:-?} epoch=${EPOCH:-?}"

log "--- storage.sh --prune-prior --yes ---"
RC=0
OUT=$(prune_states) || RC=$?
printf '%s\n' "${OUT}" | sed 's/^/    /'
if (( RC != 0 )); then
  REASON=$(printf '%s\n' "${OUT}" | grep -aiE 'error|refus|denied|not |missing|failed' | tail -1 || true)
  die "controls/storage.sh --prune-prior refused (exit ${RC})${REASON:+: ${REASON}}"
fi

log "--- storage after ---"
AFTER=$(storage_report)
printf '%s\n' "${AFTER}" | sed 's/^/    /'
AFTER_LINE=$(printf '%s\n' "${AFTER}" | grep -iE 'preserved|reclaim|prior' | tail -1 || true)

read_state
log "node after pruning: process=${PROCESS:-?} rpc=${RPC:-?} role=${ROLE:-?} epoch=${EPOCH:-?}"
[[ "${PROCESS}" == "online" ]] || warn "the node process is ${PROCESS:-unknown} - check it with stat.sh --logs"

log "=== preserved states pruned ==="
set_status DONE "${AFTER_LINE:-pruned}${BEFORE_LINE:+ (before: ${BEFORE_LINE})}"
