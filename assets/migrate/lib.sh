#!/usr/bin/env bash
# ===================================================================
# lib.sh — shared helpers for the Octra node migration toolkit
#
# Sourced by every script in scripts/migrate/.
# ===================================================================

set -euo pipefail

# --- Paths ---------------------------------------------------------
MIG_DIR="${MIG_DIR:-/root/migration}"
MIG_LOG="${MIG_LOG:-${MIG_DIR}/migrate.log}"
MIG_STATUS="${MIG_STATUS:-${MIG_DIR}/status}"

# --- Node paths (must match scripts/config.sh) ----------------------
NODE_SRC_DIR="${NODE_SRC_DIR:-/opt/octra/libv_litecore}"
NODE_DATA_ROOT="${NODE_DATA_ROOT:-/var/lib/octra}"
NODE_DATA_DIR="${NODE_DATA_DIR:-${NODE_DATA_ROOT}/devnet}"
NODE_SYNC_STAGE="${NODE_SYNC_STAGE:-${NODE_DATA_ROOT}/devnet.state_sync}"
NODE_ENV="${NODE_ENV:-${NODE_SRC_DIR}/.keys/validator/node.env}"
NODE_USER="${NODE_USER:-octra}"
CONSENSUS_PORT="${CONSENSUS_PORT:-19000}"

mkdir -p "${MIG_DIR}"

# --- Tool policy: check -> install -> continue ----------------------
# The shared implementation lives in scripts/config.sh, which the push puts at
# /root/config.sh on BOTH hosts. A host that still carries an old copy gets a
# loud warning instead of a bare "command not found" half way through a pull.
# Sourced BEFORE the logging helpers below, so migrate/log/err keep tee-ing into
# /root/migration/migrate.log.
if [[ -f /root/config.sh ]]; then
  # shellcheck disable=SC1091
  source /root/config.sh
fi

# --- Logging -------------------------------------------------------
log()  { echo -e "\033[1;32m[migrate]\033[0m $*" | tee -a "${MIG_LOG}"; }
warn() { echo -e "\033[1;33m[warn]\033[0m    $*" | tee -a "${MIG_LOG}" >&2; }
err()  { echo -e "\033[1;31m[err]\033[0m     $*" | tee -a "${MIG_LOG}" >&2; }

if ! declare -F ensure_tool >/dev/null 2>&1; then
  warn "/root/config.sh has no ensure_tool (old copy on the host) - pushing the scripts again fixes it"
  ensure_tool() {
    command -v "$1" >/dev/null 2>&1 || die "tool $1 is missing and /root/config.sh cannot install it (push the scripts again)"
  }
fi

die() { err "$*"; set_status FAILED "$*"; exit 1; }

# --- Status markers (read by the Windows orchestrator) -------------
set_status() {  # set_status <STATE> [detail...]
  # all arguments after the state form the detail (a 3rd argument used to be
  # dropped, which is why the console showed the step label instead of the result)
  local state="$1" detail
  shift || true
  detail="$*"
  printf '%s %s %s\n' "${state}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${detail}" > "${MIG_STATUS}"
  log "status = ${state} ${detail}"
}

require_root() {
  [[ $EUID -eq 0 ]] || die "run as root"
}

# --- a step must never die leaving status = RUNNING -------------------
# The migration orchestrator follows /root/migration/status (Wait-RemoteState).
# A script that died from an unexpected error - a helper that no longer exists, an
# unset variable with `set -u`, a full disk - used to leave that file at RUNNING,
# so the step looked hung until its timeout. This trap writes FAILED immediately.
_migrate_on_err() {
  local rc="$1" line="$2" cmd="$3" state
  state=$(awk 'NR==1 {print $1}' "${MIG_STATUS}" 2>/dev/null || true)
  case "${state}" in
    DONE|FAILED|WAITING-*) return 0 ;;        # the script already decided
  esac
  err "unexpected failure (exit ${rc}) at line ${line}: ${cmd}"
  set_status FAILED "line ${line}: ${cmd} (exit ${rc})"
}
trap '_migrate_on_err "$?" "$LINENO" "$BASH_COMMAND"' ERR

# Create every directory the node and the migration write into. A fresh host
# has none of them, and "no such file or directory" half-way through a pull is
# exactly the kind of failure this toolkit must not have.
ensure_dirs() {
  local dir
  for dir in "${MIG_DIR}" "${MIG_DIR}/backups" "${NODE_SRC_DIR}" \
             "${NODE_DATA_ROOT}" "${NODE_DATA_DIR}" "${NODE_SYNC_STAGE}" \
             "${NODE_DATA_ROOT}/validator-control"; do
    mkdir -p "${dir}"
  done
  if id "${NODE_USER}" >/dev/null 2>&1; then
    chown "${NODE_USER}:${NODE_USER}" "${NODE_DATA_DIR}" "${NODE_SYNC_STAGE}" 2>/dev/null || true
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

# --- Node helpers --------------------------------------------------
as_octra() { su - "${NODE_USER}" -c "$*"; }

node_stat() {
  as_octra "cd ${NODE_SRC_DIR} && sh controls/stat.sh 2>/dev/null" || true
}

stat_field() {  # stat_field <name>  (reads node_stat from stdin when piped)
  # the node prints Python's `None` for a field it cannot read: that is an EMPTY
  # value, not a value (see scripts/deploy/lib.sh for the incident)
  awk -F' = ' -v k="$1" '$1==k { v=$2; if (v=="None" || v=="null") v=""; print v; exit }'
}

countdown() {  # countdown <seconds> <message>
  local n="$1" msg="${2:-waiting}"
  while (( n > 0 )); do
    printf '\r%s %ds   ' "${msg}" "${n}"
    sleep 1
    n=$((n - 1))
  done
  printf '\r%s done\n' "${msg}"
}

# --- Remote (source VPS) helpers ----------------------------------
OLD_HOST="${OLD_HOST:-}"
OLD_USER="${OLD_USER:-root}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

require_old_host() {
  [[ -n "${OLD_HOST}" ]] || die "OLD_HOST is not set (export OLD_HOST=<old-vps-ip>)"
  ssh "${SSH_OPTS[@]}" "${OLD_USER}@${OLD_HOST}" "echo ok" >/dev/null 2>&1 \
    || die "cannot ssh ${OLD_USER}@${OLD_HOST} as root (key not installed?)"
}

on_old() { ssh "${SSH_OPTS[@]}" "${OLD_USER}@${OLD_HOST}" "$*"; }

# --- Node process detection ----------------------------------------
# IMPORTANT: pgrep/pkill -f patterns would also match the shell that runs
# the check itself (its command line contains the pattern), which makes a
# dead node look alive. The bracket trick ([o]ctra_node) avoids that.
NODE_PROC_RE='[o]ctra_node\.exe|[o]ctra_pvac_worker\.exe'

node_processes() {  # processes of the node on THIS host
  ps -eo pid,args --no-headers 2>/dev/null | grep -E "${NODE_PROC_RE}" || true
}

on_old_node_processes() {  # processes of the node on the SOURCE host
  on_old "ps -eo pid,args --no-headers 2>/dev/null | grep -E '${NODE_PROC_RE}' || true"
}
