#!/usr/bin/env bash
# ===================================================================
# 40-start-node.sh - start the node and wait until its RPC answers
#
# The first start has to open the whole chain store and replay the epoch log, so
# "started" is not enough: this step waits for `rpc = ready` (bounded) and prints
# one status line a minute while it waits.
#
# Usage:  sudo bash 40-start-node.sh
# Env:    WAIT_SEC (default 1800)
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
set_status RUNNING "start-node"

# tools this step calls (node_stat -> controls/stat.sh, pm2, curl, jq)
ensure_tool curl  curl   || die "curl is missing and could not be installed"
ensure_tool jq    jq     || die "jq is missing and could not be installed"
ensure_tool pgrep psmisc || die "pgrep (psmisc) is missing and could not be installed"

[[ -f "${NODE_ENV}" ]] || die "node.env is missing - run the setup step first"
[[ -f /root/node-start.sh ]] || die "node-start.sh is missing at /root - push the scripts first"

if [[ -n "$(node_processes)" ]]; then
  log "node already running - not restarting"
else
  log "=== starting the node ($(wallet_address || echo 'no wallet yet')) ==="
  # node-start.sh verifies pm2 itself and fails fast with the node's own log when
  # the process does not come up (waiting 30 min for rpc would tell nobody why)
  bash /root/node-start.sh ||
    die "the node did not start - see the node log above (pm2 list, ${NODE_SRC_DIR}/data/node.log)"
fi

WAIT_SEC="${WAIT_SEC:-3600}"         # 2-core hosts need 30-40 min (4-core ~7-9 min)
DEADLINE=$(( $(date +%s) + WAIT_SEC ))
START=$(date +%s)
LAST=$START
RPC=""
# read the real pm2 process name the node registered itself under (OCTRA_OPERATOR_PM2_NAME
# in node.env); the lib.sh default (octra-node-1) is a fallback and often differs
REAL_PM2=$(grep -m1 '^OCTRA_OPERATOR_PM2_NAME=' "${NODE_ENV:-${NODE_SRC_DIR}/.keys/validator/node.env}" 2>/dev/null | cut -d= -f2- || true)
REAL_PM2="${REAL_PM2:-${NODE_PM2_NAME}}"
log "waiting for rpc = ready (up to $(elapsed_minutes "${WAIT_SEC}")) - the first start replays the epoch log..."
while (( $(date +%s) < DEADLINE )); do
  SNAP=$(node_stat)
  RPC=$(printf '%s\n' "${SNAP}" | stat_field rpc)
  PROC=$(printf '%s\n' "${SNAP}" | stat_field process)
  HEAD=$(printf '%s\n' "${SNAP}" | stat_field head_epoch)
  if [[ "${RPC}" == "ready" ]]; then
    log "rpc is ready after $(( $(date +%s) - START ))s (process=${PROC} head_epoch=${HEAD})"
    break
  fi
  if (( $(date +%s) - LAST >= 60 )); then
    log "  waiting for rpc: $(elapsed_minutes $(( $(date +%s) - START ))) of $(elapsed_minutes "${WAIT_SEC}") (rpc=${RPC:-?} process=${PROC:-?} head=${HEAD:-?})"
    LAST=$(date +%s)
  fi
  sleep 5
done

if [[ "${RPC}" != "ready" ]]; then
  warn "rpc did not become ready in $(elapsed_minutes "${WAIT_SEC}") - pm2 log (process: ${REAL_PM2}):"
  as_octra "pm2 logs ${REAL_PM2} --lines 15 --nostream" 2>/dev/null | sed 's/^/    /' || true
  die "node rpc is not ready after ${WAIT_SEC}s (set WAIT_SEC=7200 in the env to double the limit)"
fi

log "--- pm2 ---"
as_octra "pm2 list" 2>/dev/null | sed 's/^/    /' || warn "pm2 list failed"
log "--- status ---"
node_stat | tee "${DEPLOY_DIR}/start-stat.txt" | \
  grep -E '^(node|role|address|process|pid|rpc|epoch|head_epoch|voting|p2p_connected|validator_active|validator_enrollment) =' || true

set_status DONE "start-node"
