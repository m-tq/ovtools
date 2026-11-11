#!/usr/bin/env bash
# ===================================================================
# extract-data.sh — collect validator node data into a JSON file
#
# Gathers all critical files needed for migration to a new machine:
#   - wallet.json     (validator wallet + keys)
#   - node.env        (node configuration)
#   - network.env     (network parameters)
#   - SOURCE_COMMIT   (exact build commit)
#   - node status     (consensus head, sync state, peer count)
#   - system info     (hostname, IP, OS, kernel, uptime)
#
# Output: /tmp/octra-node-data.json (also printed to stdout)
#
# Usage:  sudo bash extract-data.sh
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/config.sh"

if [[ $EUID -ne 0 ]]; then
  err "Run as root:  sudo bash $0"
  exit 1
fi

# --- Collect file contents -----------------------------------------
get_file() {
  local f="$1"
  if [[ -f "$f" ]]; then
    cat "$f" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

# Helper: base64-encode a file (for binary or sensitive content)
get_file_b64() {
  local f="$1"
  if [[ -f "$f" ]]; then
    base64 -w0 "$f" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

# --- Gather node status (best-effort, may fail if node not running) -
STAT_OUTPUT=""
STAT_LOGS=""
if su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/stat.sh" >/tmp/octra_stat.txt 2>&1; then
  STAT_OUTPUT=$(cat /tmp/octra_stat.txt)
else
  STAT_OUTPUT="$(cat /tmp/octra_stat.txt 2>/dev/null || echo 'node not running')"
fi

# --- Gather system info --------------------------------------------
HOSTNAME=$(hostname)
PUBLIC_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo "")
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "")
OS_INFO=$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}" || echo "unknown")
KERNEL=$(uname -r)
UPTIME=$(uptime -p 2>/dev/null || echo "")
CPU_COUNT=$(nproc 2>/dev/null || echo 0)
MEM_TOTAL=$(free -h 2>/dev/null | awk '/^Mem:/ {print $2}' || echo "")
DISK_USAGE=$(df -h "${NODE_DATA_ROOT}" 2>/dev/null | tail -1 | awk '{print $3 "/" $2 " (" $5 " used)"}' || echo "")

# --- Gather storage info -------------------------------------------
STORAGE_INFO=""
if su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/storage.sh" >/tmp/octra_storage.txt 2>&1; then
  STORAGE_INFO=$(cat /tmp/octra_storage.txt)
fi

# --- Gather enroll status -----------------------------------------
ENROLL_STATUS=""
if su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/enroll.sh status" >/tmp/octra_enroll.txt 2>&1; then
  ENROLL_STATUS=$(cat /tmp/octra_enroll.txt)
fi

# --- Source commit -------------------------------------------------
SOURCE_COMMIT=$(get_file "${NODE_SRC_DIR}/SOURCE_COMMIT")

# --- Wallet (base64-encoded for safe transport) --------------------
WALLET_PATH="${NODE_SRC_DIR}/.keys/validator/wallet.json"
if [[ ! -f "${WALLET_PATH}" ]]; then
  WALLET_PATH="${NODE_DATA_DIR}/wallet.json"
fi
WALLET_B64=$(get_file_b64 "${WALLET_PATH}")

# --- node.env (base64-encoded) ------------------------------------
NODE_ENV_PATH="${NODE_SRC_DIR}/.keys/validator/node.env"
if [[ ! -f "${NODE_ENV_PATH}" ]]; then
  NODE_ENV_PATH="${NODE_SRC_DIR}/config/node.env"
fi
NODE_ENV_B64=$(get_file_b64 "${NODE_ENV_PATH}")

# --- network.env (base64-encoded) --------------------------------
NETWORK_ENV_PATH="${NODE_SRC_DIR}/config/network.env"
NETWORK_ENV_B64=$(get_file_b64 "${NETWORK_ENV_PATH}")

# --- network.env.sha256 -------------------------------------------
NETWORK_SHA256=$(get_file "${NETWORK_ENV_PATH}.sha256")

# --- Gather file list in data dir (for inventory) -----------------
DATA_DIR_FILES=""
if [[ -d "${NODE_DATA_DIR}" ]]; then
  # NOTE: `| head -50` would SIGPIPE the find under `set -o pipefail` (rc 141)
  # as soon as the data dir holds more than 50 files, so use sed instead.
  DATA_DIR_FILES=$(find "${NODE_DATA_DIR}" -maxdepth 2 -type f 2>/dev/null | sed -n '1,50p' | while read -r f; do
    SIZE=$(stat -c%s "$f" 2>/dev/null || echo 0)
    echo "$(basename "$f"):${SIZE}"
  done | tr '\n' ',' | sed 's/,$//')
fi

# --- Build the JSON ------------------------------------------------
# Using jq for proper JSON construction
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

jq -n \
  --arg timestamp "$TIMESTAMP" \
  --arg hostname "$HOSTNAME" \
  --arg public_ip "$PUBLIC_IP" \
  --arg local_ip "$LOCAL_IP" \
  --arg os "$OS_INFO" \
  --arg kernel "$KERNEL" \
  --arg uptime "$UPTIME" \
  --arg cpu "$CPU_COUNT" \
  --arg mem "$MEM_TOTAL" \
  --arg disk "$DISK_USAGE" \
  --arg source_commit "$SOURCE_COMMIT" \
  --arg wallet_b64 "$WALLET_B64" \
  --arg node_env_b64 "$NODE_ENV_B64" \
  --arg network_env_b64 "$NETWORK_ENV_B64" \
  --arg network_sha256 "$NETWORK_SHA256" \
  --arg stat_output "$STAT_OUTPUT" \
  --arg storage_info "$STORAGE_INFO" \
  --arg enroll_status "$ENROLL_STATUS" \
  --arg data_dir "$NODE_DATA_DIR" \
  --arg src_dir "$NODE_SRC_DIR" \
  --arg api_port "$API_PORT" \
  --arg consensus_port "$CONSENSUS_PORT" \
  --arg p2p_port "$P2P_PORT" \
  --arg data_files "$DATA_DIR_FILES" \
  '{
    meta: {
      extracted_at: $timestamp,
      script_version: "1.0"
    },
    system: {
      hostname: $hostname,
      public_ip: $public_ip,
      local_ip: $local_ip,
      os: $os,
      kernel: $kernel,
      uptime: $uptime,
      cpu_cores: ($cpu | tonumber),
      memory_total: $mem,
      disk_usage: $disk
    },
    node: {
      source_dir: $src_dir,
      source_commit: $source_commit,
      data_dir: $data_dir,
      ports: {
        api: ($api_port | tonumber),
        consensus: ($consensus_port | tonumber),
        p2p: ($p2p_port | tonumber)
      },
      status_raw: $stat_output,
      storage_raw: $storage_info,
      enroll_status_raw: $enroll_status
    },
    migration_data: {
      wallet_json_b64: $wallet_b64,
      node_env_b64: $node_env_b64,
      network_env_b64: $network_env_b64,
      network_env_sha256: $network_sha256
    },
    data_files: ($data_files | split(",") | map(split(":") | {(.[0]): (.[1] | tonumber)}) | add // {})
  }' > /tmp/octra-node-data.json

# Print summary
echo
log "Data extracted to /tmp/octra-node-data.json"
log "Summary:"
jq '{
  hostname: .system.hostname,
  public_ip: .system.public_ip,
  source_commit: .node.source_commit,
  has_wallet: (.migration_data.wallet_json_b64 | length > 0),
  has_node_env: (.migration_data.node_env_b64 | length > 0),
  has_network_env: (.migration_data.network_env_b64 | length > 0)
}' /tmp/octra-node-data.json

# Also copy to the source dir for easy access
cp /tmp/octra-node-data.json "${NODE_SRC_DIR}/config/node-data.json" 2>/dev/null || true
chown "${NODE_USER}:${NODE_USER}" "${NODE_SRC_DIR}/config/node-data.json" 2>/dev/null || true

log "Done. Copy it locally with scp if needed."
