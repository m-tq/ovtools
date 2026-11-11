#!/usr/bin/env bash
# ===================================================================
# harden-host.sh - mandatory baseline hardening for an Octra node host
#
#   net.mptcp.enabled = 0
#
# MPTCP is not used by the node, the dashboard or the SSH pull, and a host that
# answers on the MPTCP stack is an avoidable vector of attack on a public VPS.
# Disabling it is part of this project's baseline, so every program that
# prepares a machine applies it:
#
#   * scripts/pre-run.sh        (both programs, via disable_mptcp)
#   * deploy/migrate/manage phases (every run, so a resumed run repairs the host)
#   * migrate target, before anything is copied
#
# The three operator steps are the ones documented in the runbook:
#
#   sudo sysctl -w net.mptcp.enabled=0
#   echo "net.mptcp.enabled = 0" | sudo tee /etc/sysctl.d/99-disable-mptcp.conf
#   sudo sysctl --system
#   sysctl net.mptcp.enabled            -> net.mptcp.enabled = 0
#
# Idempotent. Exits 1 when the kernel offers the knob but it stays enabled.
#
# Usage:  sudo bash harden-host.sh
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/config.sh"

if [[ $EUID -ne 0 ]]; then
  err "run as root:  sudo bash $0"
  exit 1
fi

log "=== hardening $(hostname) (MPTCP off) ==="
disable_mptcp
