#!/usr/bin/env bash
# ===================================================================
# 05-finalize-target.sh — make the copied tree bootable on this host
#
#   1. back up node.env and point OCTRA_ADVERTISE_ENDPOINT at this VPS
#   2. verify the binary hashes still match node.env (integrity gate)
#   3. fix ownership (the copy may carry the source's numeric uid)
#   4. run controls/install.sh (runtime libs + nodejs + pm2 + boot unit)
#   5. run controls/lib/validator_config.py --check-runtime
#
# Nothing here touches config/network.env, the chain data or the wallet:
# a migrated validator must NOT re-sync and must NOT re-enroll.
#
# Usage (on the NEW vps):
#   NEW_HOST=203.0.113.133 bash 05-finalize-target.sh
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
NEW_HOST="${NEW_HOST:-${1:-}}"
[[ -n "${NEW_HOST}" ]] || NEW_HOST=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

[[ -f "${NODE_ENV}" ]] || die "node.env missing at ${NODE_ENV} — did the pull complete?"
[[ -f "${NODE_SRC_DIR}/.keys/validator/wallet.json" ]] || die "wallet.json missing"
set_status RUNNING "finalize-target"

# --- 1. advertise endpoint (the only host-specific field) -----------
log "=== finalize (advertise → ${NEW_HOST}:${CONSENSUS_PORT}) ==="
CURRENT_ADV=$(grep -m1 '^OCTRA_ADVERTISE_ENDPOINT=' "${NODE_ENV}" | cut -d= -f2-)
log "current advertise: ${CURRENT_ADV}"

if [[ "${CURRENT_ADV}" == "${NEW_HOST}:${CONSENSUS_PORT}" ]]; then
  log "advertise already correct"
else
  cp -a "${NODE_ENV}" "${NODE_ENV}.pre-migration.bak"
  sed -i "s|^OCTRA_ADVERTISE_ENDPOINT=.*|OCTRA_ADVERTISE_ENDPOINT=${NEW_HOST}:${CONSENSUS_PORT}|" "${NODE_ENV}"
  log "advertise updated: $(grep -m1 '^OCTRA_ADVERTISE_ENDPOINT=' "${NODE_ENV}")"
  log "backup kept at ${NODE_ENV}.pre-migration.bak"
fi

# --- 2. integrity gate: binaries must still match node.env ---------
log "Verifying binary hashes against node.env..."
check_hash() {  # check_hash <env_key> <file>
  local key="$1" file="$2" want got
  want=$(grep -m1 "^${key}=" "${NODE_ENV}" | cut -d= -f2-)
  got=$(sha256sum "${file}" | awk '{print $1}')
  if [[ "${want}" != "${got}" ]]; then
    die "${key} mismatch: env=${want} file=${got} (${file})"
  fi
  log "  ${key} OK"
}
check_hash OCTRA_BINARY_HASH                "${NODE_SRC_DIR}/_build/default/bin/octra_node.exe"
check_hash OCTRA_PVAC_VERIFY_WORKER_HASH    "${NODE_SRC_DIR}/_build/default/bin/octra_pvac_worker.exe"
check_hash OCTRA_OPERATOR_SYNC_BINARY_HASH  "${NODE_SRC_DIR}/_build/default/bin/octra_state_sync_client.exe"
check_hash OCTRA_OPERATOR_CONTROL_BINARY_HASH "${NODE_SRC_DIR}/_build/default/bin/bft_control_tx.exe"

NET_WANT=$(grep -m1 '^OCTRA_OPERATOR_NETWORK_SHA256=' "${NODE_ENV}" | cut -d= -f2-)
for f in "${NODE_SRC_DIR}/.keys/validator/network.env" "${NODE_SRC_DIR}/config/network.env"; do
  [[ "$(sha256sum "$f" | awk '{print $1}')" == "${NET_WANT}" ]] || die "network bundle hash mismatch: $f"
done
log "  network bundle OK ($(grep -m1 '^OCTRA_CHAIN_ID=' "${NODE_ENV}"))"

# --- 3. ownership ---------------------------------------------------
log "Fixing ownership (${NODE_USER})..."
chown -R "${NODE_USER}:${NODE_USER}" "${NODE_SRC_DIR}" "${NODE_DATA_ROOT}"
chmod 700 "${NODE_SRC_DIR}/.keys/validator" "${NODE_DATA_DIR}" 2>/dev/null || true
chmod 600 "${NODE_SRC_DIR}/.keys/validator/"*.json "${NODE_ENV}" 2>/dev/null || true

# --- 4. runtime packages + process manager --------------------------
# `install.sh` runs apt-get + npm, which can take minutes. Holding a single SSH
# session open for that long is what killed the 2026-10-30 run ("Network error:
# Software caused connection abort" mid-apt), so it runs detached in a systemd
# unit and this script only polls a status file. A dropped SSH is then harmless:
# re-running this step picks up the finished install.
if command -v pm2 >/dev/null 2>&1 &&    dpkg -s libev4 libgmp10 liblmdb0 nodejs npm >/dev/null 2>&1; then
  log "Runtime packages + pm2 already installed - skipping install.sh"
else
  INSTALL_UNIT="octra-finalize-install"
  INSTALL_LOG="${MIG_DIR}/install-target.log"
  INSTALL_STATUS="${MIG_DIR}/install-target.status"
  INSTALL_TIMEOUT="${INSTALL_TIMEOUT:-1800}"
  rm -f "${INSTALL_LOG}" "${INSTALL_STATUS}"
  systemctl reset-failed "${INSTALL_UNIT}" 2>/dev/null || true

  log "Running controls/install.sh detached (runtime libs, nodejs, pm2, boot unit)..."
  systemd-run --unit="${INSTALL_UNIT}" --collect --no-block \
    --working-directory="${NODE_SRC_DIR}" \
    --setenv=OCTRA_OPERATOR_USER="${NODE_USER}" \
    --setenv=OCTRA_DATA_ROOT="${NODE_DATA_ROOT}" \
    --setenv=DEBIAN_FRONTEND=noninteractive \
    --setenv=TERM=dumb \
    bash -c "sh controls/install.sh > '${INSTALL_LOG}' 2>&1; echo \$? > '${INSTALL_STATUS}'"

  log "install.sh runs as systemd unit ${INSTALL_UNIT} - polling (SSH may drop safely)"
  START_TS=$(date +%s)
  LAST_LOG=$START_TS
  while [[ ! -s "${INSTALL_STATUS}" ]]; do
    ELAPSED=$(( $(date +%s) - START_TS ))
    if (( ELAPSED > INSTALL_TIMEOUT )); then
      die "install.sh did not finish in ${INSTALL_TIMEOUT}s (see ${INSTALL_LOG})"
    fi
    # One line every 30 s: a \r progress line becomes its own row in the console,
    # so a 5-minute apt run used to print ~30 near-identical rows.
    if (( $(date +%s) - LAST_LOG >= 30 )); then
      log "  install.sh still running... ${ELAPSED}s of ${INSTALL_TIMEOUT}s (unit ${INSTALL_UNIT})"
      LAST_LOG=$(date +%s)
    fi
    sleep 10
  done
  log "install.sh finished in $(( $(date +%s) - START_TS ))s"

  INSTALL_RC=$(tr -dc '0-9' < "${INSTALL_STATUS}")
  tail -n 8 "${INSTALL_LOG}" 2>/dev/null | sed 's/^/    /' || true
  [[ "${INSTALL_RC}" == "0" ]] || die "install.sh failed (exit ${INSTALL_RC}) - log: ${INSTALL_LOG}"
fi
command -v pm2 >/dev/null || die "pm2 was not installed by install.sh"
log "pm2: $(pm2 -v)"

# --- 5. runtime binding check --------------------------------------
log "Checking runtime binding (--check-runtime)..."
as_octra "cd ${NODE_SRC_DIR} && python3 controls/lib/validator_config.py --check-runtime --config ${NODE_ENV}" \
  || die "runtime binding check failed"
log "runtime binding OK"

ADDRESS=$(jq -r '.address' "${NODE_SRC_DIR}/.keys/validator/wallet.json")
log "wallet address on target: ${ADDRESS}"
if [[ -f "${MIG_DIR}/source-final-stat.txt" ]]; then
  SRC_ADDR=$(grep -m1 '^address = ' "${MIG_DIR}/source-final-stat.txt" | awk -F' = ' '{print $2}' || true)
  if [[ -n "${SRC_ADDR}" && "${SRC_ADDR}" != "${ADDRESS}" ]]; then
    die "wallet mismatch! source=${SRC_ADDR} target=${ADDRESS}"
  fi
  log "wallet matches the source validator: ${SRC_ADDR:-unknown}"
fi
# recorded for 07-verify.sh (and for the runbook)
printf '%s\n' "${ADDRESS}" > "${MIG_DIR}/source-address.txt"

log "=== finalize done — target is ready to start ==="
set_status DONE "finalize-target" "${ADDRESS}"
