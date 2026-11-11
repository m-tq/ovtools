#!/usr/bin/env bash
# ===================================================================
# 08-rollback.sh — abort the migration and hand the validator back
#
# Only valid while the NEW node is fenced: the target node is stopped
# first, and only then is the source node started again. Both nodes
# must never run at the same time (same wallet = equivocation).
#
# Usage (on the NEW vps):
#   OLD_HOST=203.0.113.27 bash 08-rollback.sh
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
require_old_host
set_status RUNNING "rollback"

log "=== ROLLBACK — stopping the new node first ==="
if [[ -f "${NODE_ENV}" ]] && [[ -n "$(node_processes)" ]]; then
  as_octra "cd ${NODE_SRC_DIR} && sh controls/stop.sh" 2>&1 | tee -a "${MIG_LOG}" || true
fi

LEFT=$(node_processes)
for i in {1..20}; do
  [[ -z "${LEFT}" ]] && break
  sleep 1
  LEFT=$(node_processes)
done
if [[ -n "${LEFT}" ]]; then
  warn "target processes still alive — SIGTERM"
  pkill -TERM -f "${NODE_PROC_RE}" || true
  sleep 5
  LEFT=$(node_processes)
fi
[[ -z "${LEFT}" ]] || die "cannot stop the target node — aborting rollback (source stays down)"
log "Target node stopped."

log "=== restarting the node on the old host ${OLD_HOST} ==="
if on_old "systemctl is-enabled --quiet pm2-${NODE_USER} 2>/dev/null"; then
  log "pm2 boot unit already enabled on the source"
else
  on_old "systemctl enable pm2-${NODE_USER} >/dev/null 2>&1 || true"
  log "pm2 boot unit re-enabled on the source"
fi
on_old "su - ${NODE_USER} -c 'cd ${NODE_SRC_DIR} && sh controls/run.sh'" 2>&1 | tee -a "${MIG_LOG}"

sleep 10
log "=== source status after rollback ==="
on_old "su - ${NODE_USER} -c 'cd ${NODE_SRC_DIR} && sh controls/stat.sh'" 2>&1 | \
  grep -E '^(role|process|epoch|voting|validator_active) =' || true

set_status DONE "rollback"
