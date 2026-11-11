#!/usr/bin/env bash
# ===================================================================
# node-setup.sh — configure the Octra lite_node
#
# Two-step validator setup (by design — Octra protocol requirement):
#
#   STEP 1 (first run):  --role observer
#     Run this on a fresh node. Builds binary, syncs 38 GB state,
#     generates wallet.json + node.env.
#     Then start the node, fund the wallet, and call node-enroll.sh.
#
#   STEP 2 (after bond is ready): --role validator
#     Once enrollment state = "ready" (validator_scheduled or
#     validator_active = true via stat.sh), run this script again
#     with ROLE=validator to reconfigure node.env, then restart.
#     The promote-validator.sh watcher handles this automatically.
#
# Usage:
#   sudo bash node-setup.sh                      # interactive (asks role)
#   sudo ROLE=observer   PUBLIC_HOST=1.2.3.4 NODE_NAME=mynode bash node-setup.sh
#   sudo ROLE=validator  PUBLIC_HOST=1.2.3.4 NODE_NAME=mynode bash node-setup.sh
#
# ROLE defaults to 'observer' for first-time setup.
# Set ROLE=validator only after enrollment state = ready.
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/config.sh"

if [[ $EUID -ne 0 ]]; then
  err "Run as root:  sudo bash $0"
  exit 1
fi

# --- Gather inputs -------------------------------------------------
PUBLIC_HOST="${PUBLIC_HOST:-}"
NODE_NAME="${NODE_NAME:-}"
ROLE="${ROLE:-observer}"

if [[ -z "${PUBLIC_HOST}" ]]; then
  PUBLIC_HOST=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  warn "PUBLIC_HOST not set — auto-detected: ${PUBLIC_HOST}"
fi

if [[ -z "${NODE_NAME}" ]]; then
  NODE_NAME="octra-node-$(hostname)"
  warn "NODE_NAME not set — using: ${NODE_NAME}"
fi

if [[ "${ROLE}" != "observer" && "${ROLE}" != "validator" ]]; then
  err "ROLE must be 'observer' or 'validator', got: ${ROLE}"
  exit 1
fi

# --- Warn if switching to validator before membership is ready -----
if [[ "${ROLE}" == "validator" ]]; then
  log "Checking validator membership before reconfiguring…"
  MEMBERSHIP=$(su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/stat.sh 2>/dev/null" 2>/dev/null | \
    grep -E '^(validator_active|validator_scheduled|validator_enrollment)' || true)
  ACTIVE=$(echo "${MEMBERSHIP}"    | grep '^validator_active'    | awk -F' = ' '{print $2}')
  SCHEDULED=$(echo "${MEMBERSHIP}" | grep '^validator_scheduled' | awk -F' = ' '{print $2}')
  ENROLL=$(echo "${MEMBERSHIP}"    | grep '^validator_enrollment' | awk -F' = ' '{print $2}')

  if [[ "${ACTIVE}" != "true" && "${SCHEDULED}" != "true" ]]; then
    err "Cannot set ROLE=validator: membership not yet active or scheduled"
    warn "Current enrollment: ${ENROLL:-unknown}"
    warn "Run 'sh controls/stat.sh' and wait until validator_active or validator_scheduled = true"
    exit 1
  fi
  log "Membership confirmed (active=${ACTIVE} scheduled=${SCHEDULED}) — proceeding with validator config"
fi

log "Configuring node:"
echo "  Role:       ${ROLE}"
echo "  Host:       ${PUBLIC_HOST}"
echo "  Name:       ${NODE_NAME}"
echo "  API port:   ${API_PORT}"
echo "  Consensus:  ${CONSENSUS_PORT}"
echo "  P2P:        ${P2P_PORT}"
echo "  Data dir:   ${NODE_DATA_DIR}"

# --- Ensure data directories exist --------------------------------
mkdir -p "${NODE_DATA_DIR}" "${NODE_SYNC_STAGE}"
chown -R "${NODE_USER}:${NODE_USER}" "${NODE_DATA_ROOT}"

# --- Verify network.env sha256 ------------------------------------
(cd "${NODE_SRC_DIR}" && sha256sum -c config/network.env.sha256)
NETWORK_SHA=$(awk '{print $1}' "${NODE_SRC_DIR}/config/network.env.sha256")

# config_val.sh runs `opam switch link <switch> <repo>` and opam 2.3 cannot
# re-create an existing <repo>/_opam: it dies with «"rmdir" failed ... Not a
# directory» AND the failed call empties the switch prefix, which throws away the
# whole build (seen 2026-11-02). install.sh already created that link, so drop it
# here and let config_val.sh create it again - the switch itself is untouched.
unlink_ocaml_switch_link "config_val.sh runs opam switch link next"
# --- Run config_val.sh -------------------------------------------
log "Running config_val.sh (role=${ROLE})…"

# For observer (first run): include --build and --sync
# For validator (re-config): skip both — binary + data already present
if [[ "${ROLE}" == "observer" ]]; then
  su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && \
    sh controls/config_val.sh \
      --role observer \
      --name '${NODE_NAME}' \
      --advertise '${PUBLIC_HOST}:${CONSENSUS_PORT}' \
      --api-port ${API_PORT} \
      --consensus-port ${CONSENSUS_PORT} \
      --p2p-port ${P2P_PORT} \
      --data-dir ${NODE_DATA_DIR} \
      --sync-stage ${NODE_SYNC_STAGE} \
      --network config/network.env \
      --network-sha '${NETWORK_SHA}' \
      --build \
      --sync \
      --yes"
else
  # Validator re-config — node must be STOPPED before running this.
  # We patch node.env directly (bypasses config_val.py's RPC membership check
  # which fails when the node is stopped). Only two fields change:
  #   OCTRA_OPERATOR_ROLE:   observer → validator
  #   OCTRA_CONSENSUS_MODE:  observer → bft
  NODE_ENV="${NODE_SRC_DIR}/.keys/validator/node.env"
  if [[ ! -f "${NODE_ENV}" ]]; then
    err "node.env not found — run observer setup first"
    exit 1
  fi
  cp "${NODE_ENV}" "${NODE_ENV}.observer.bak"
  sed -i "s/^OCTRA_OPERATOR_ROLE=.*/OCTRA_OPERATOR_ROLE=validator/" "${NODE_ENV}"
  sed -i "s/^OCTRA_CONSENSUS_MODE=.*/OCTRA_CONSENSUS_MODE=bft/" "${NODE_ENV}"
  log "node.env patched: ROLE=$(grep '^OCTRA_OPERATOR_ROLE=' "${NODE_ENV}" | cut -d= -f2)"
fi

log "Node configured as ${ROLE}."
echo "  ${NODE_SRC_DIR}/.keys/validator/node.env     — node config"
echo "  ${NODE_SRC_DIR}/.keys/validator/wallet.json  — validator wallet"
echo "  ${NODE_DATA_DIR}/                             — blockchain data"
echo

if [[ "${ROLE}" == "observer" ]]; then
  log "Next steps:"
  echo "  1. Start node:    bash node-start.sh"
  echo "  2. Fund wallet:   topup address in wallet.json"
  echo "  3. Enroll:        bash node-enroll.sh join 1000000"
  echo "  4. Wait for:      validator_scheduled = true (check: sh controls/stat.sh)"
  echo "  5. Promote:       sudo ROLE=validator bash node-setup.sh && bash node-start.sh"
else
  log "Validator config applied. Restart the node to activate:"
  echo "  bash node-start.sh"
fi
