#!/usr/bin/env bash
# ===================================================================
# node-stop.sh — stop the Octra lite_node gracefully
#
# Usage:  sudo bash node-stop.sh
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/config.sh"

if [[ $EUID -ne 0 ]]; then
  err "Run as root:  sudo bash $0"
  exit 1
fi

log "Stopping Octra lite_node…"
su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/stop.sh"
log "Node stopped."
