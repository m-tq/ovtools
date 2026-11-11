#!/usr/bin/env bash
# ===================================================================
# 06-start-target.sh — start the migrated validator on the NEW vps
#
# Uses the node's own controls/run.sh, which performs:
#   --check-runtime → validator_recover → validator_guard →
#   validator_process → pm2 start
#
# Usage (on the NEW vps):
#   bash 06-start-target.sh
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
[[ -f "${NODE_ENV}" ]] || die "node.env missing — run 05-finalize-target.sh first"
set_status RUNNING "start-target"

# --- Double-signing guard -------------------------------------------
# Two live copies of one validator wallet would equivocate. If OLD_HOST is
# given, refuse to start unless the source node is provably stopped.
if [[ -n "${OLD_HOST}" ]]; then
  require_old_host
  if [[ -n "$(on_old_node_processes)" ]]; then
    die "the source node on ${OLD_HOST} is STILL RUNNING — refusing to start a second copy of the wallet"
  fi
  log "source node on ${OLD_HOST} confirmed stopped"
fi

log "=== starting the node on $(hostname) ==="
# Idempotent: never restart a node that is already up. A restart costs a full
# ~38 GB store open plus RPC catch-up, so "start" must mean "ensure running".
# A node that is already online is normal here: controls/install.sh (finalize)
# starts it, and this step only has to prove it is up.
if [[ -n "$(node_processes)" ]]; then
  log "node already running - not restarting: $(node_processes | awk '{print $1, $2}' | head -1)"
else
  as_octra "cd ${NODE_SRC_DIR} && sh controls/run.sh" 2>&1 | tee -a "${MIG_LOG}"
fi

log "Waiting for the process to come up..."
sleep 10

log "--- pm2 ---"
as_octra "pm2 list" 2>/dev/null || warn "pm2 list failed"

log "--- status ---"
node_stat | tee "${MIG_DIR}/target-initial-stat.txt" | \
  grep -E '^(node|role|address|process|pid|rpc|epoch|head_epoch|voting|validator_active|validator_enrollment|p2p_connected) =' || true

if grep -q '^process = online' "${MIG_DIR}/target-initial-stat.txt"; then
  log "=== node is up ==="
  set_status DONE "start-target"
else
  die "node did not reach process = online — check pm2 logs: pm2 logs ${NODE_PM2_NAME:-octra-node-1}"
fi
