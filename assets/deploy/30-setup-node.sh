#!/usr/bin/env bash
# ===================================================================
# 30-setup-node.sh - configure the node: identity, binary, chain state
#
# Runs the project's own /root/node-setup.sh DETACHED (config_val.sh --build
# compiles the node, --sync downloads ~38 GB). Both take a long time, so the
# unit + rc-file pattern is used here too.
#
# Result: /opt/octra/libv_litecore/.keys/validator/{wallet.json,node.env}
#
# Usage:  sudo bash 30-setup-node.sh
# Env:    NODE_NAME (default octra-node-<hostname>)
#         PUBLIC_HOST (default: from host.env, else auto-detected)
#         SETUP_TIMEOUT (default 5400s)
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
set_status RUNNING "setup-node"

# tools used below and by node-setup.sh: check first, install when missing
ensure_tool curl  curl   || die "curl is missing and could not be installed"
ensure_tool jq    jq     || die "jq is missing and could not be installed"
ensure_tool git   git    || die "git is missing and could not be installed"
ensure_tool rsync rsync  || die "rsync is missing and could not be installed"

# host.env from the prep step carries the public address the node advertises
if [[ -f "${DEPLOY_HOST_ENV}" ]]; then
  # shellcheck disable=SC1090
  source "${DEPLOY_HOST_ENV}"
fi
PUBLIC_HOST="${PUBLIC_HOST:-$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')}"
NODE_NAME="${NODE_NAME:-octra-node-$(hostname)}"
UNIT="octra-deploy-setup"

# --- already configured? ---------------------------------------------
if [[ -f "${NODE_ENV}" && -f "${NODE_WALLET}" ]]; then
  log "node is already configured (node.env + wallet.json present)"
  log "  wallet: $(wallet_address || echo unknown)"
  log "  role:   $(grep -m1 '^OCTRA_OPERATOR_ROLE=' "${NODE_ENV}" | cut -d= -f2)"
  set_status DONE "setup-node" "cached"
  exit 0
fi

if [[ ! -f /root/node-setup.sh ]]; then
  die "node-setup.sh is missing at /root/node-setup.sh - push the scripts first"
fi
if [[ ! -d "${NODE_SRC_DIR}/_build" && ! -d "${NODE_SRC_DIR}/runtime_data" ]]; then
  warn "the toolchain does not look installed yet - run the toolchain step first"
fi

if [[ "$(unit_active ${UNIT})" == "yes" ]]; then
  log "node setup already running (unit ${UNIT}) - re-attaching"
else
  log "=== configuring ${NODE_NAME} @ ${PUBLIC_HOST} (build + 38 GB sync, 10-30 min) ==="
  # a missing/broken OCaml switch would fail deep inside config_val.sh: say so
  # here instead (soft stop - the operator can re-run the toolchain step)
  if ! assert_opam_switch; then
    set_status WAITING-BUILD "OCaml switch missing - re-run the toolchain step (see the log)"
    exit 2
  fi
  unit_start "${UNIT}" "/root" \
    "PUBLIC_HOST=${PUBLIC_HOST}" "NODE_NAME=${NODE_NAME}" "ROLE=observer" \
    "DEBIAN_FRONTEND=noninteractive" "TERM=dumb" \
    -- "bash /root/node-setup.sh"
fi

# the sync prints progress percentages; show the last one on the heartbeat
unit_wait "${UNIT}" "${SETUP_TIMEOUT:-5400}" "node-setup.sh (build + sync)" \
  "[0-9]+%|Downloaded|sync|Building|Compiling" \
  || die "node setup failed - see ${DEPLOY_DIR}/${UNIT}.log"

# --- proof the identity exists ---------------------------------------
[[ -f "${NODE_WALLET}" ]] || die "wallet.json was not created (${NODE_WALLET})"
[[ -f "${NODE_ENV}" ]] || die "node.env was not created (${NODE_ENV})"
log "wallet address : $(wallet_address || echo unknown)"
log "role           : $(grep -m1 '^OCTRA_OPERATOR_ROLE=' "${NODE_ENV}" | cut -d= -f2)"
log "data dir       : $(du -sh "${NODE_DATA_DIR}" 2>/dev/null | awk '{print $1}') in ${NODE_DATA_DIR}"
log "advertise      : $(grep -m1 '^OCTRA_ADVERTISE_ENDPOINT=' "${NODE_ENV}" | cut -d= -f2)"
set_status DONE "setup-node"
