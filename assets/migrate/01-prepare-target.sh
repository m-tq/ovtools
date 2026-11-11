#!/usr/bin/env bash
# ===================================================================
# 01-prepare-target.sh — prepare the NEW VPS for the data pull
#
#   * installs the tools needed by the migration (rsync, jq, git, ...)
#   * creates the `octra` system user (same as scripts/install-deps.sh)
#   * creates the node directories on the 1 TB volume
#   * generates an SSH key for root so it can pull from the OLD VPS
#
# Run on the NEW VPS AFTER scripts/pre-run.sh:
#   sudo bash 01-prepare-target.sh
# Optional:
#   FORCE=1         keep an existing data set (resumable copy of this migration)
#   RESET_TARGET=1  drop a stale/foreign node state and start clean
#
# Idempotent - safe to re-run.
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
set_status RUNNING "prepare-target"
rm -f "${MIG_DIR}/prep.blocked"

# --- Freshness guard -------------------------------------------------
# Never prepare over an existing node: a second copy of the same wallet is
# exactly what must not happen.
#
# A provider block volume SURVIVES an OS re-install, so "I just reinstalled the
# VPS" does not guarantee an empty chain state. pre-run.sh formats any volume
# that does not carry an Octra data set (automatic, no checkbox) and records
# what it did in /root/migration/prerun.env. The orchestrator reads that file and
# passes the matching flag, so this script never contradicts pre-run.sh:
#
#   (nothing)          fresh target - nothing to protect
#   FORCE=1            the data set is a resumable copy of THIS migration -
#                      keep it and prepare anyway
#   RESET_TARGET=1     the data set is stale/foreign - drop the node state
#                      (chain state, sync stage, source tree + keys) and start
#                      clean; the pull copies the source's state right after
#   WIPE_VOLUME=1      ... bash /root/pre-run.sh  (reformat the volume instead)
FRESH=1
if [[ -f "${NODE_SRC_DIR}/.keys/validator/wallet.json" ]]; then
  FRESH=0
fi
if [[ -f "${NODE_DATA_DIR}/HEAD.json" ]]; then
  FRESH=0
fi

reset_target_state() {
  local path
  warn "RESET_TARGET=1 - dropping the stale node state on $(hostname):"
  for path in "${NODE_DATA_DIR}" "${NODE_SYNC_STAGE}" "${NODE_SRC_DIR}"; do
    [[ -e "${path}" ]] || continue
    warn "  rm -rf ${path}"
    rm -rf "${path}"
  done
  log "node state cleared - the pull will copy the source state next"
}

if [[ "${RESET_TARGET:-0}" == "1" ]]; then
  if [[ -n "$(node_processes)" ]]; then
    die "RESET_TARGET=1 refused: a node is already running on this host ($(node_processes | awk '{print $1}' | head -1)) - stop it first, this host would be a live validator"
  fi
  if (( FRESH == 0 )); then
    reset_target_state
  else
    log "RESET_TARGET=1 requested, but the target is already fresh - nothing to clear"
  fi
elif [[ "${FORCE:-0}" == "1" ]]; then
  if (( FRESH == 0 )); then
    warn "FORCE=1 - keeping the existing data set on this host (resuming the same migration)"
  fi
elif (( FRESH == 0 )); then
  if [[ -f "${NODE_SRC_DIR}/.keys/validator/wallet.json" ]]; then
    FOUND="${NODE_SRC_DIR}/.keys/validator/wallet.json"
  else
    FOUND="${NODE_DATA_DIR}/HEAD.json"
  fi
  # Machine-readable marker: the orchestrator turns it into a self-heal
  # (reformat the volume, or RESET_TARGET=1) instead of retrying the same call.
  printf 'target-not-fresh %s\n' "${FOUND}" > "${MIG_DIR}/prep.blocked"
  die "${FOUND} already exists - the target still holds a node (nothing of this migration has been copied yet): pre-run.sh with WIPE_VOLUME=1 reformats the volume, RESET_TARGET=1 drops just the node state, FORCE=1 keeps it (resume)"
fi

log "Checking the migration tooling (rsync, jq, git, curl, psmisc)..."
export DEBIAN_FRONTEND=noninteractive
export TERM="${TERM:-dumb}"
# check -> install -> continue: a fresh VPS may have none of these, and a retry
# must not re-run a full apt install for tools that are already there
ensure_package ca-certificates || die "cannot install ca-certificates"
ensure_tool rsync rsync || die "rsync is missing and could not be installed"
ensure_tool jq    jq    || die "jq is missing and could not be installed"
ensure_tool git   git   || die "git is missing and could not be installed"
ensure_tool curl  curl  || die "curl is missing and could not be installed"
ensure_tool wget  wget  || die "wget is missing and could not be installed"
ensure_tool pgrep psmisc || die "pgrep (psmisc) is missing and could not be installed"
ensure_tool pkill psmisc || die "pkill (psmisc) is missing and could not be installed"
ensure_package procps   || die "cannot install procps"
log "Packages ready: $(rsync --version | head -1)"

# --- octra user (same convention as scripts/install-deps.sh) --------
if ! id "${NODE_USER}" &>/dev/null; then
  log "Creating system user '${NODE_USER}'..."
  useradd -r -m -d "/home/${NODE_USER}" -s /bin/bash "${NODE_USER}"
else
  log "User '${NODE_USER}' already exists ($(id -u "${NODE_USER}"))"
fi

# --- Data store must exist before we write anything -----------------
# pre-run.sh has already mounted a 1 TB volume, or (no volume attached) created
# the directory on the largest filesystem. Either way the path must exist and be
# writable, and every sub-directory is created here when missing.
ensure_dirs
if ! mountpoint -q "${NODE_DATA_ROOT}" 2>/dev/null; then
  warn "${NODE_DATA_ROOT} is not a separate mount point - the node data lives on the root filesystem"
fi
FREE_GB=$(df -BG --output=avail "${NODE_DATA_ROOT}" 2>/dev/null | tail -1 | tr -dc '0-9')
if [[ -n "${FREE_GB}" ]] && (( FREE_GB < 60 )); then
  die "not enough free space on ${NODE_DATA_ROOT} (${FREE_GB}G free, ~41 GB is copied)"
fi
log "Data root: ${NODE_DATA_ROOT} ($(df -h "${NODE_DATA_ROOT}" | tail -1 | awk '{print $2}' ) total, $(df -h "${NODE_DATA_ROOT}" | tail -1 | awk '{print $4}') free)"

# --- Root SSH key used to pull data from the OLD VPS ----------------
# NOTE: we deliberately do NOT touch sshd_config. Password login is the
# operator's out-of-band access path; pubkey auth is already enabled by
# default on Debian, which is all the pull needs.
install -d -m 700 /root/.ssh
if [[ ! -f /root/.ssh/id_ed25519 ]]; then
  log "Generating root SSH key for the data pull..."
  ssh-keygen -t ed25519 -N "" -C "octra-migration@$(hostname)" -f /root/.ssh/id_ed25519 >/dev/null
fi

cp /root/.ssh/id_ed25519.pub "${MIG_DIR}/target_ssh_key.pub"
chmod 644 "${MIG_DIR}/target_ssh_key.pub"

log "Target prepared."
log "Disk: $(df -h "${NODE_DATA_ROOT}" | tail -1 | awk '{print $2" total, "$4" free"}')"
log "Swap: $(free -h | awk '/^Swap:/ {print $2}')"
echo
log "PUBLIC KEY (must be appended to ${OLD_USER}@${OLD_HOST:-<old-vps>}:~/.ssh/authorized_keys):"
cat "${MIG_DIR}/target_ssh_key.pub"

set_status DONE "prepare-target"
