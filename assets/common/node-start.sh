#!/usr/bin/env bash
# ===================================================================
# node-start.sh — start the Octra lite_node and check status
#
# Usage:  sudo bash node-start.sh
# Idempotent — checks if already running before starting.
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/config.sh"

if [[ $EUID -ne 0 ]]; then
  err "Run as root:  sudo bash $0"
  exit 1
fi

log "Starting Octra lite_node…"

# --- is the node really online under pm2? ----------------------------
# `pm2 pid <name>` is NOT a reliable probe: when the name does not exist (or the
# pm2 daemon still has to be spawned) it prints a banner or a table separator
# ("-------------"), and the old check took any non-empty line as a PID - so this
# script reported "Node already running (PID -------------)", never started the
# node, and the deploy waited 30 minutes for an rpc that could never answer
# (2026-11-02). The JSON process list only reports processes that exist, and the
# pid must be a number.
pm2_online_pid() {  # pm2_online_pid [<pm2 name hint>]
  local want="${1:-}" json pid node_env
  # the name the node really uses is in node.env (OCTRA_OPERATOR_PM2_NAME); the
  # hint is only a fallback, and any "octra*" pm2 process counts as our node
  node_env="${NODE_ENV:-${NODE_SRC_DIR}/.keys/validator/node.env}"
  if [[ -f "${node_env}" ]]; then
    want=$(grep -m1 '^OCTRA_OPERATOR_PM2_NAME=' "${node_env}" 2>/dev/null | cut -d= -f2- || true)
    want="${want:-${1:-}}"
  fi
  if command -v jq >/dev/null 2>&1; then
    json=$(su - "${NODE_USER}" -c "pm2 jlist" 2>/dev/null || true)
    pid=$(printf '%s' "${json}" | jq -r --arg want "${want}" \
      '.[]? | select(.pm2_env.status == "online")
           | select($want == "" or (.name | startswith($want)) or (.name | startswith("octra")))
           | .pid' 2>/dev/null | head -1)
    if [[ -n "${pid}" && "${pid}" != "null" ]]; then
      printf '%s\n' "${pid}"
      return 0
    fi
  fi
  # no jq (or pm2 not answering): the node process itself is proof enough
  pgrep -f '[o]ctra_node\.exe' | head -1
  return 0
}

node_log_tail() {  # node_log_tail [<lines>]
  local lines="${1:-20}" logdir
  logdir=$(su - "${NODE_USER}" -c "grep -m1 '^OCTRA_OPERATOR_LOG_DIR=' ${NODE_SRC_DIR}/.keys/validator/node.env" 2>/dev/null \
           | cut -d= -f2- || true)
  logdir="${logdir:-${NODE_SRC_DIR}/data}"
  tail -n "${lines}" "${logdir}/node.log" 2>/dev/null | sed 's/^/    /' || true
}

RUNNING=$(pm2_online_pid "${NODE_PM2_NAME:-octra-node-1}")
if [[ -n "${RUNNING}" ]]; then
  warn "Node already running (PID ${RUNNING}) - not starting it twice"
  su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/stat.sh" || true
  exit 0
fi

# Start the node
su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/run.sh"

sleep 3

# --- the node must really be running now -----------------------------
# Say it HERE, with the node's own log, instead of letting the deploy step wait
# half an hour for an rpc that will never come.
RUNNING=$(pm2_online_pid "${NODE_PM2_NAME:-octra-node-1}")
if [[ -z "${RUNNING}" ]]; then
  err "the node did not come up under pm2 (no online process) - node log:"
  node_log_tail 20
  err "pm2 list:"
  su - "${NODE_USER}" -c "pm2 list" 2>/dev/null | sed 's/^/    /' || true
  exit 1
fi
log "node process online (PID ${RUNNING})"

# Show status
log "Node status:"
su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/stat.sh"

echo
log "Node started. Dashboard API: http://$(curl -s --max-time 3 https://api.ipify.org 2>/dev/null || echo 'localhost'):${API_PORT}/"
