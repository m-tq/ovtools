#!/usr/bin/env bash
# ===================================================================
# 10-prepare-host.sh - turn a fresh VPS into a deploy target
#
#   * swap + node data store (delegates to the shared /root/pre-run.sh, which
#     detects the volume, formats it when it holds no Octra data set, mounts it
#     and records its decision in prerun.env)
#   * the small tooling every later step needs (git/curl/jq/rsync/psmisc)
#   * the directory layout, and /root/deploy/host.env with the facts the
#     orchestrator and the GUI display
#
# Usage:  sudo bash 10-prepare-host.sh
# Env:    WIPE_VOLUME=1   reformat the data volume even if it holds a data set
# Idempotent.
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
set_status RUNNING "prepare-host"

log "=== preparing $(hostname) ==="

# --- 1. swap + data store -------------------------------------------
if [[ -f /root/pre-run.sh ]]; then
  log "running /root/pre-run.sh (swap + data store: auto detect/format/mount)"
  # keep this program's state separate: the decision file goes to /root/deploy
  # Project settings decide the swap size and which block device is the data store
  PRERUN_STATE="${DEPLOY_DIR}/prerun.env" \
    WIPE_VOLUME="${WIPE_VOLUME:-0}" \
    SWAP_GB="${SWAP_GB:-8}" \
    BLOCK_DEVICE="${BLOCK_DEVICE:-/dev/sdb}" \
    DATA_MIN_GB="${DATA_MIN_GB:-1000}" \
    FORMAT_APPROVED="${FORMAT_APPROVED:-}" \
    bash /root/pre-run.sh
else
  warn "/root/pre-run.sh is missing - run the deploy step again after the script push"
fi

# --- 2. tooling: check -> install -> continue ------------------------
# A re-installed VPS is a bare image, so nothing here is assumed: every binary
# this and the later steps call is checked first and only installed when it is
# really missing (apt is skipped completely when everything is present, which
# makes a retry after a dropped SSH cheap).
export DEBIAN_FRONTEND=noninteractive
export TERM="${TERM:-dumb}"
log "checking the base tooling (git, curl, wget, rsync, jq, psmisc, procps)"
ensure_package ca-certificates || die "cannot install ca-certificates"
ensure_tool git   git    || die "git is missing and could not be installed"
ensure_tool curl  curl   || die "curl is missing and could not be installed"
ensure_tool wget  wget   || die "wget is missing and could not be installed"
ensure_tool rsync rsync  || die "rsync is missing and could not be installed"
ensure_tool jq    jq     || die "jq is missing and could not be installed"
ensure_tool pgrep psmisc || die "pgrep (psmisc) is missing and could not be installed"
ensure_tool pkill psmisc || die "pkill (psmisc) is missing and could not be installed"
ensure_package procps    || die "cannot install procps"
ensure_package gnupg     || die "cannot install gnupg"
ensure_package lsb-release || die "cannot install lsb-release"

# --- 3. layout + facts ----------------------------------------------
if ! id "${NODE_USER}" >/dev/null 2>&1; then
  log "creating system user '${NODE_USER}'"
  useradd -r -m -d "/home/${NODE_USER}" -s /bin/bash "${NODE_USER}"
else
  log "user '${NODE_USER}' already exists"
fi
ensure_dirs
mkdir -p /root/deploy

PUBLIC_HOST=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || true)
if [[ -z "${PUBLIC_HOST}" ]]; then
  PUBLIC_HOST=$(hostname -I | awk '{print $1}')
fi

STORE_DEV=$(findmnt -n -o SOURCE "${NODE_DATA_ROOT}" 2>/dev/null || echo none)
STORE_FREE_GB=$(df -BG --output=avail "${NODE_DATA_ROOT}" 2>/dev/null | tail -1 | tr -dc '0-9')
STORE_TOTAL_GB=$(df -BG --output=size "${NODE_DATA_ROOT}" 2>/dev/null | tail -1 | tr -dc '0-9')
{
  echo "PUBLIC_HOST=${PUBLIC_HOST}"
  echo "HOSTNAME=$(hostname)"
  echo "CORES=$(nproc)"
  echo "MEM_MB=$(free -m | awk '/^Mem:/{print $2}')"
  echo "SWAP=$(free -h | awk '/^Swap:/{print $2}')"
  echo "STORE_DEV=${STORE_DEV}"
  echo "STORE_TOTAL_GB=${STORE_TOTAL_GB:-0}"
  echo "STORE_FREE_GB=${STORE_FREE_GB:-0}"
  echo "PREPARED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "${DEPLOY_HOST_ENV}"
log "host facts:"
sed 's/^/    /' "${DEPLOY_HOST_ENV}"

if [[ -f "${DEPLOY_DIR}/prerun.env" ]]; then
  log "data store decision:"
  sed 's/^/    /' "${DEPLOY_DIR}/prerun.env"
fi

log "=== host ready: ${PUBLIC_HOST} ($(nproc) cores, ${STORE_FREE_GB:-?} GB free on ${STORE_DEV}) ==="
set_status DONE "prepare-host" "${PUBLIC_HOST}"
