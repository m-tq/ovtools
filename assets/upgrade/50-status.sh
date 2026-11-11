#!/usr/bin/env bash
# ===================================================================
# 50-status.sh - versions + storage of the running node (read-only)
#
# Prints what the console shows for the update program: the commit the checkout
# says it is (SOURCE_COMMIT), the git HEAD/branch (and whether the tree is dirty),
# the hashes of the BINARY that is actually running (stat.sh) and the storage
# report of the node's own tool. Nothing is pulled, built or restarted.
#
# Usage:  sudo bash 50-status.sh
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
set_status RUNNING "status"

ensure_tool git git || die "git is missing and could not be installed"
ensure_tool jq  jq  || warn "jq is missing - the wallet address cannot be read"

COMMIT=$(source_commit)
HEAD=$(git_head)
BRANCH=$(git_branch)
DIRTY=$(git_dirty)
REMOTE=$(git_remote)
read_state
ADDR=$(wallet_address || echo unknown)

log "=== update status: $(hostname) ==="
log "wallet    : ${ADDR}"
log "repository: ${REMOTE}"
log "checkout  : SOURCE_COMMIT=${COMMIT:-unknown} git HEAD=${HEAD:-unknown}${BRANCH:+ on ${BRANCH}}${DIRTY:+ (dirty working tree)}"
if [[ -n "${COMMIT}" && -n "${HEAD}" && "${COMMIT}" != "${HEAD}" ]]; then
  log "            SOURCE_COMMIT and git HEAD differ - the checkout was rebuilt from another commit"
fi
log "running   : role=${ROLE:-?} process=${PROCESS:-?} rpc=${RPC:-?} voting=${VOTING:-?} epoch=${EPOCH:-?} uptime=${PROCESS_UP:-?}"
log "binary    : ${BINARY:-unknown}"
log "pvac      : ${PVAC:-unknown}"
log "membership: active=${ACTIVE:-?} scheduled=${SCHED:-?} enrollment=${ENROLL:-?}"

if [[ -f "${STORAGE_SH}" ]]; then
  log "--- controls/storage.sh ---"
  STORE=$(storage_report)
  printf '%s\n' "${STORE}" | sed 's/^/    /'
  STORAGE_LINE=$(storage_fields)
else
  warn "controls/storage.sh is missing - this node version has no storage tool"
  STORAGE_LINE=""
fi

if [[ -f "${UPGRADE_SH}" ]]; then
  log "official tool: controls/upgrade.sh present (sh controls/upgrade.sh / --apply)"
else
  warn "controls/upgrade.sh is missing - use the manual update (fallback)"
fi

set_status DONE "commit=${HEAD:-unknown}${BRANCH:+ on ${BRANCH}} role=${ROLE:-?} active=${ACTIVE:-?}${STORAGE_LINE:+ - ${STORAGE_LINE}}"
