#!/usr/bin/env bash
# ===================================================================
# 10-preflight.sh - is this host a node we may update, and what is on it?
#
# Read-only. Nothing is pulled, built or restarted here: the step reports the
# checkout (commit/branch/dirty), the running binary, the chain role and the disk
# head-room, and refuses clearly when this is not an Octra node at all.
#
# Upstream rules this step reminds the operator of (README, "How to update"):
# never run `--sync` again, never change config/network.env, never re-enroll.
#
# Usage:  sudo bash 10-preflight.sh
# Env:    MIN_FREE_GB (20) - warn below that much free space on the data volume
#         STATE_TIMEOUT (60)
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
set_status RUNNING "preflight"

MIN_FREE_GB="${MIN_FREE_GB:-20}"
WARNINGS=0

[[ -d "${NODE_SRC_DIR}" ]] || die "no node at ${NODE_SRC_DIR} - this host does not run an Octra node"
[[ -d "${NODE_SRC_DIR}/.git" ]] || die "${NODE_SRC_DIR} is not a git checkout - the node cannot be updated from the source tree"
[[ -f "${NODE_WALLET}" ]] || die "wallet.json is missing (${NODE_WALLET}) - this is not the validator host"
[[ -f "${NODE_ENV}" ]] || die "node.env is missing (${NODE_ENV}) - the node has no configuration to update"
[[ -d "${NODE_DATA_DIR}" ]] || die "the data directory is missing (${NODE_DATA_DIR}) - nothing to keep in sync"

for tool in git make opam; do
  if command -v "${tool}" >/dev/null 2>&1; then
    log "tool ${tool}: present ($(command -v "${tool}"))"
  else
    warn "tool ${tool}: MISSING - the update needs it (the Apply step installs it via apt)"
    WARNINGS=$(( WARNINGS + 1 ))
  fi
done

# --- what the checkout says -------------------------------------------
COMMIT=$(source_commit)
HEAD=$(git_head)
BRANCH=$(git_branch)
DIRTY=$(git_dirty)
REMOTE=$(git_remote)
log "repository: ${REMOTE}"
log "checkout  : SOURCE_COMMIT=${COMMIT:-unknown} git HEAD=${HEAD:-unknown}${BRANCH:+ on ${BRANCH}}"
if [[ -n "${DIRTY}" ]]; then
  warn "the working tree has local changes - the official tool refuses to update a dirty checkout"
  WARNINGS=$(( WARNINGS + 1 ))
fi

# --- the control scripts the update needs -----------------------------
[[ -f "${CHECK_SH}" ]] || warn "controls/check.sh is missing (the package cannot be verified)"
if [[ -f "${UPGRADE_SH}" ]]; then
  log "official tool: controls/upgrade.sh present"
else
  warn "controls/upgrade.sh is missing - use the manual update (fallback) on this node version"
  WARNINGS=$(( WARNINGS + 1 ))
fi
if [[ -f "${STORAGE_SH}" ]]; then
  log "storage tool : controls/storage.sh present"
else
  warn "controls/storage.sh is missing - 'Remove preserved states' is not available on this node"
  WARNINGS=$(( WARNINGS + 1 ))
fi
[[ -f "${STOP_SH}" && -f "${RUN_SH}" ]] || warn "controls/stop.sh or controls/run.sh is missing - the restart may fail"

# --- the running node --------------------------------------------------
read_state
log "node      : role=${ROLE:-?} process=${PROCESS:-?} rpc=${RPC:-?} voting=${VOTING:-?} epoch=${EPOCH:-?} uptime=${PROCESS_UP:-?}"
log "membership: active=${ACTIVE:-?} scheduled=${SCHED:-?} enrollment=${ENROLL:-?}"
log "binary    : ${BINARY:-unknown}${PVAC:+ pvac ${PVAC}}"
if [[ "${PROCESS}" != "online" ]]; then
  warn "the node process is ${PROCESS:-unknown} - the update restarts it (controls/run.sh)"
  WARNINGS=$(( WARNINGS + 1 ))
fi
if [[ "${RPC}" != "ready" ]]; then
  warn "the node rpc is ${RPC:-unknown} - the upgrade tool waits for it, so the update may take longer"
  WARNINGS=$(( WARNINGS + 1 ))
fi

# a join is running: the upgrade restarts the node and could interrupt it
if systemctl is-active --quiet octra-enroll-join 2>/dev/null; then
  warn "an enrollment join is running (unit octra-enroll-join) - finish the enrollment before updating"
  WARNINGS=$(( WARNINGS + 1 ))
fi
if [[ -f "${NODE_DATA_DIR}/validator-control/bond-increase.json" ]]; then
  warn "a signed bond increase is stored on this host - make sure it is confirmed before restarting the node"
fi

# --- disk head-room (a build + a state sync need room) -----------------
FREE_GB=""
if command -v df >/dev/null 2>&1; then
  FREE_GB=$(df -B1 --output=avail "${NODE_DATA_ROOT}" 2>/dev/null | tail -1 | tr -d ' ' || true)
  if [[ "${FREE_GB}" =~ ^[0-9]+$ ]]; then
    FREE_H=$(awk -v b="${FREE_GB}" 'BEGIN { printf "%.1f GiB", b / 1073741824 }')
    log "data volume: ${FREE_H} free on ${NODE_DATA_ROOT}"
    if (( FREE_GB < MIN_FREE_GB * 1073741824 )); then
      warn "less than ${MIN_FREE_GB} GiB free - free space before updating (controls/storage.sh --prune-prior --yes)"
      WARNINGS=$(( WARNINGS + 1 ))
    fi
  fi
fi
if command -v du >/dev/null 2>&1; then
  USED=$(du -sh "${NODE_DATA_DIR}" 2>/dev/null | cut -f1 || true)
  [[ -n "${USED}" ]] && log "data store : ${USED} in ${NODE_DATA_DIR}"
fi

if [[ -f "${STORAGE_SH}" ]]; then
  SUMMARY=$(storage_summary)
  [[ -n "${SUMMARY}" ]] && log "storage    : ${SUMMARY}"
fi

log "upstream rules: do NOT run --sync again, do NOT change config/network.env, do NOT re-enroll"
if (( WARNINGS > 0 )); then
  log "${WARNINGS} warning(s) above - the update can still run"
fi
set_status DONE "commit=${HEAD:-unknown}${BRANCH:+ on ${BRANCH}} running=${ROLE:-?} active=${ACTIVE:-?} warnings=${WARNINGS}"
