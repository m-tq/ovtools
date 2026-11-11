#!/usr/bin/env bash
# ===================================================================
# node-enroll.sh — join the Octra network as a validator
#
# Steps:
#   1. Join the active set (stake OCTRA tokens)
#   2. Check enrollment status
#   3. Show node status
#
# Usage:
#   sudo bash node-enroll.sh               # default stake (1000000)
#   sudo bash node-enroll.sh 500000         # custom stake amount
#   sudo bash node-enroll.sh exit          # leave active set
#   sudo bash node-enroll.sh withdraw       # withdraw stake
#
# IMPORTANT: The node must be fully synced before enrolling.
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/config.sh"

if [[ $EUID -ne 0 ]]; then
  err "Run as root:  sudo bash $0"
  exit 1
fi

ACTION="${1:-join}"
STAKE_AMOUNT="${2:-1000000}"

case "${ACTION}" in
  join)
    log "Joining the network with stake ${STAKE_AMOUNT}…"
    su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/enroll.sh join --amount ${STAKE_AMOUNT}"
    log "Checking enrollment status…"
    su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/enroll.sh status"
    echo
    log "Node status:"
    su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/stat.sh"
    ;;

  status)
    log "Enrollment status:"
    su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/enroll.sh status"
    ;;

  exit)
    warn "Leaving the active validator set…"
    su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/enroll.sh exit"
    su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/enroll.sh status"
    log "Exited active set."
    ;;

  withdraw)
    warn "Withdrawing stake…"
    su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/enroll.sh withdraw"
    su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/enroll.sh status"
    log "Stake withdrawn."
    ;;

  *)
    err "Unknown action: ${ACTION}"
    echo "Usage: sudo bash node-enroll.sh [join|status|exit|withdraw] [amount]"
    exit 1
    ;;
esac
