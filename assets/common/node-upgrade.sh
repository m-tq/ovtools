#!/usr/bin/env bash
# ===================================================================
# node-upgrade.sh — upgrade the Octra lite_node to the latest release
#
# Uses the official upgrade.sh which monitors the repo, builds a
# fresh binary, restarts the node, and verifies it's operational.
#
# Usage:
#   sudo bash node-upgrade.sh             # dry-run (test only, no changes)
#   sudo bash node-upgrade.sh --apply       # apply the upgrade
#
# This is a thin wrapper around controls/upgrade.sh.
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/config.sh"

if [[ $EUID -ne 0 ]]; then
  err "Run as root:  sudo bash $0"
  exit 1
fi

if [[ ! -d "${NODE_SRC_DIR}/.git" ]]; then
  err "Node source not found at ${NODE_SRC_DIR}"
  err "Run install-deps.sh first."
  exit 1
fi

MODE="${1:---dry-run}"

log "Running upgrade (${MODE})…"
log "Pulling latest source…"

# Pull latest code first
su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && git pull --ff-only"

if [[ "${MODE}" == "--apply" ]]; then
  su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/upgrade.sh --apply"
else
  log "Dry-run mode — testing only (no changes applied)"
  su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/upgrade.sh"
  echo
  log "Dry-run complete. If everything looks good, run:"
  echo "  sudo bash node-upgrade.sh --apply"
fi
