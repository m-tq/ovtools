#!/usr/bin/env bash
# ===================================================================
# 04-stop-source.sh — stop the validator on the OLD VPS (decommission)
#
# A validator wallet must NEVER be active on two machines at once
# (double-signing / equivocation). This step:
#   1. records the last status of the old node
#   2. stops it via the node's own controls/stop.sh (pm2)
#   3. proves no octra_node process is left
#   4. disables the pm2 boot unit so it cannot resurrect after a reboot
#   5. drops a decommission note in the old node's home
#
# Usage (on the NEW vps):
#   OLD_HOST=203.0.113.27 bash 04-stop-source.sh
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
require_old_host
set_status RUNNING "stop-source"
log "=== stopping node on ${OLD_HOST} ==="

# --- 1. record final status of the source node ----------------------
# Keep the first (running) snapshot: on a re-run the node is already down
# and the status no longer carries the live epoch/voting fields.
if [[ ! -s "${MIG_DIR}/source-final-stat.txt" ]] || ! grep -q '^address = ' "${MIG_DIR}/source-final-stat.txt"; then
  log "Capturing final status of the old node..."
  on_old "su - ${NODE_USER} -c 'cd ${NODE_SRC_DIR} && sh controls/stat.sh' 2>&1" \
    | tee "${MIG_DIR}/source-final-stat.txt" | grep -E '^(role|address|epoch|head_epoch|voting|validator_active) =' || true
else
  log "Keeping existing source status snapshot ($(grep -m1 '^address = ' "${MIG_DIR}/source-final-stat.txt"))"
fi

WALLET_ADDRESS=$(grep -m1 '^address = ' "${MIG_DIR}/source-final-stat.txt" | awk -F' = ' '{print $2}' || true)
[[ -n "${WALLET_ADDRESS}" ]] || warn "could not read wallet address from source status"
log "Source wallet: ${WALLET_ADDRESS:-unknown}"

# --- 2. graceful stop ----------------------------------------------
log "Running controls/stop.sh on the source..."
on_old "su - ${NODE_USER} -c 'cd ${NODE_SRC_DIR} && sh controls/stop.sh' 2>&1" | tee -a "${MIG_LOG}"

# --- 3. verify nothing is left running -----------------------------
LEFT=$(on_old_node_processes)
for i in {1..20}; do
  [[ -z "${LEFT}" ]] && break
  sleep 1
  LEFT=$(on_old_node_processes)
done

if [[ -n "${LEFT}" ]]; then
  warn "node processes still alive after stop — sending SIGTERM"
  on_old "pkill -TERM -f '${NODE_PROC_RE}' || true"
  sleep 5
  LEFT=$(on_old_node_processes)
fi
if [[ -n "${LEFT}" ]]; then
  die "could not stop the source node — DO NOT start the new node (wallet would be double-active)"
fi
log "Source node processes are gone (none left)"

# --- 4. make sure it cannot come back on reboot ---------------------
if on_old "systemctl is-enabled --quiet pm2-${NODE_USER} 2>/dev/null"; then
  on_old "systemctl disable pm2-${NODE_USER} 2>/dev/null || true"
  log "Disabled pm2-${NODE_USER} boot unit on the source"
else
  log "pm2 boot unit on the source already disabled"
fi
on_old "su - ${NODE_USER} -c 'pm2 save --force' >/dev/null 2>&1 || true"

# --- 5. decommission note ------------------------------------------
on_old "cat > /root/MIGRATED-AWAY.txt <<'EOF'
This VPS no longer runs the Octra validator.
The validator (wallet ${WALLET_ADDRESS:-unknown}) was migrated on $(date -u +%Y-%m-%dT%H:%M:%SZ).
New host: $(hostname) / see the operator's records.
DO NOT start the node here again while the new host is live: the same wallet
would be active twice and the validator would equivocate.
EOF"
log "Decommission note written to ${OLD_HOST}:/root/MIGRATED-AWAY.txt"

log "=== source stopped — safe to run the final delta pull ==="
date -u +%Y-%m-%dT%H:%M:%SZ > "${MIG_DIR}/downtime-start.txt"
log "downtime clock started: $(cat "${MIG_DIR}/downtime-start.txt")"
set_status DONE "stop-source"
