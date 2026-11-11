#!/usr/bin/env bash
# ===================================================================
# promote-validator.sh — auto-promote observer node to validator
#
# Polls stat.sh every 30 seconds. Once validator_scheduled or
# validator_active = true, it:
#   1. Stops the node
#   2. Reconfigures node.env with --role validator
#   3. Restarts the node
#   4. Updates nodes_data.json (runs extract-data.sh)
#
# Usage:
#   sudo bash promote-validator.sh                        # run in foreground
#   sudo nohup bash promote-validator.sh > /root/promote.log 2>&1 &   # background
#
# The script exits once promotion is complete (success or fatal error).
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/config.sh"

if [[ $EUID -ne 0 ]]; then
  err "Run as root:  sudo bash $0"
  exit 1
fi

PUBLIC_HOST="${PUBLIC_HOST:-$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')}"
NODE_NAME="${NODE_NAME:-octra-validator-01}"

log "Promotion watcher started — polling every 30s"
log "Node: ${NODE_NAME} @ ${PUBLIC_HOST}"

while true; do
  STATUS=$(su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/stat.sh 2>/dev/null" 2>/dev/null || true)

  ACTIVE=$(echo    "${STATUS}" | grep '^validator_active'    | awk -F' = ' '{print $2}')
  SCHEDULED=$(echo "${STATUS}" | grep '^validator_scheduled' | awk -F' = ' '{print $2}')
  HEAD=$(echo      "${STATUS}" | grep '^head_epoch'          | awk -F' = ' '{print $2}')
  ENROLL=$(echo    "${STATUS}" | grep '^validator_enrollment' | awk -F' = ' '{print $2}')

  log "epoch=${HEAD}  enrollment=${ENROLL}  active=${ACTIVE:-?}  scheduled=${SCHEDULED:-?}"

  if [[ "${ACTIVE}" == "true" || "${SCHEDULED}" == "true" ]]; then
    log "Membership ready! Promoting to validator…"

    # Get network sha before stopping the node
    NETWORK_SHA=$(awk '{print $1}' "${NODE_SRC_DIR}/config/network.env.sha256")

    # Stop the node gracefully
    log "Stopping node…"
    su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/stop.sh" 2>&1 || true
    sleep 3

    # Reconfigure node.env to validator role
    # NOTE: We bypass config_val.py's RPC membership check by editing node.env directly,
    # since the RPC is unavailable after stopping. The key changes are:
    #   OCTRA_OPERATOR_ROLE: observer → validator
    #   OCTRA_CONSENSUS_MODE: observer → bft
    log "Reconfiguring node.env — role=validator…"

    NODE_ENV="${NODE_SRC_DIR}/.keys/validator/node.env"
    if [[ ! -f "${NODE_ENV}" ]]; then
      err "node.env not found at ${NODE_ENV}"
      su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/run.sh" 2>&1 || true
      exit 1
    fi

    # Backup the current node.env
    cp "${NODE_ENV}" "${NODE_ENV}.observer.bak"
    log "Backed up observer config to ${NODE_ENV}.observer.bak"

    # Patch the two role-related fields
    sed -i 's/^OCTRA_OPERATOR_ROLE=.*/OCTRA_OPERATOR_ROLE=validator/' "${NODE_ENV}"
    sed -i 's/^OCTRA_CONSENSUS_MODE=.*/OCTRA_CONSENSUS_MODE=bft/' "${NODE_ENV}"

    # Verify the patch
    ROLE_AFTER=$(grep '^OCTRA_OPERATOR_ROLE=' "${NODE_ENV}" | cut -d= -f2)
    MODE_AFTER=$(grep '^OCTRA_CONSENSUS_MODE=' "${NODE_ENV}" | cut -d= -f2)
    log "node.env updated: ROLE=${ROLE_AFTER} MODE=${MODE_AFTER}"

    if [[ "${ROLE_AFTER}" != "validator" ]]; then
      err "Failed to patch node.env — restoring backup"
      cp "${NODE_ENV}.observer.bak" "${NODE_ENV}"
      su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/run.sh" 2>&1 || true
      exit 1
    fi

    log "Config updated. Starting node as validator…"
    su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/run.sh" 2>&1

    sleep 5
    log "Node status after restart:"
    su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/stat.sh 2>/dev/null" 2>/dev/null | \
      grep -E '^(role|process|uptime|rpc|voting|validator_active)' || true

    log "Running extract-data.sh to update nodes_data.json…"
    bash "$(dirname "$0")/extract-data.sh" 2>&1 || warn "extract-data.sh failed — run manually"

    log "DONE — node is now running as validator"
    exit 0
  fi

  sleep 30
done
