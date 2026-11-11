#!/usr/bin/env bash
# ===================================================================
# config.sh — shared configuration for Octra lite_node scripts
# Source this file from other scripts:  source "$(dirname "$0")/config.sh"
# ===================================================================

set -euo pipefail

# --- Node identity -------------------------------------------------
NODE_REPO="https://github.com/octra-labs/lite_node.git"
NODE_BRANCH="main"
NODE_SRC_DIR="/opt/octra/libv_litecore"
NODE_DATA_ROOT="/var/lib/octra"
NODE_DATA_DIR="${NODE_DATA_ROOT}/devnet"
NODE_SYNC_STAGE="${NODE_DATA_ROOT}/devnet.state_sync"
NODE_USER="octra"

# --- Network / API ports (from official config_val.sh defaults) ---
API_PORT="8080"          # REST API (dashboard reads from here)
CONSENSUS_PORT="19000"   # consensus
P2P_PORT="9000"          # peer-to-peer

# --- Disk / swap ---------------------------------------------------
SWAP_FILE="/swapfile"
# Swap size in GB. This kit is deployed for several projects, so the operator
# sets it in Project settings (console) or with SWAP_GB=<n> bash pre-run.sh.
SWAP_GB="${SWAP_GB:-8}"
SWAP_SIZE="${SWAP_SIZE:-${SWAP_GB}G}"     # 8 GB swap by default
MOUNT_POINT="${NODE_DATA_ROOT}"

# Node data store: the chain lives here (~40 GB today, grows over time), so the
# target wants ~1 TB. pre-run.sh is fully automatic:
#   * /dev/sdb (or BLOCK_DEVICE) when present and not the system disk
#   * otherwise the largest non-system whole disk >= DATA_MIN_GB
#   * otherwise the largest filesystem >= DATA_MIN_GB (main disk, no formatting)
BLOCK_DEVICE="${BLOCK_DEVICE:-/dev/sdb}"
DATA_MIN_GB="${DATA_MIN_GB:-1000}"
DATA_LABEL="${DATA_LABEL:-octra-data}"
DATA_MARKER="${DATA_MARKER:-.octra-data-volume}"

# --- Build profile ---
BUILD_PROFILE="release"

# --- Helpers -------------------------------------------------------
log()  { echo -e "\033[1;32m[octra]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m  $*"; }
err()  { echo -e "\033[1;31m[err]\033[0m   $*" >&2; }

# --- tools on the host: check -> install -> continue ------------------
# A VPS that was just re-installed is a bare image: `jq`, `rsync` or even
# `curl` may simply not be there yet, and a step that calls them dies half way
# through with "command not found". Every step therefore asks for the tool it
# needs instead of assuming it: the check is free, apt only runs when something
# is really missing, and a retry after a dropped SSH does not re-run a full
# `apt-get update`/install for tools that are already present.
OCTRA_APT_STAMP="${OCTRA_APT_STAMP:-/root/.octra-apt-update}"
OCTRA_APT_TTL="${OCTRA_APT_TTL:-900}"        # seconds an apt-get update stays fresh

octra_have() { command -v "$1" >/dev/null 2>&1; }

octra_pkg_installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'
}

# apt-get update at most once per OCTRA_APT_TTL seconds (checkpoint: a retry of a
# failed step must not re-sync the package lists).
apt_refresh() {
  local now last
  now=$(date +%s)
  last=0
  if [[ -f "${OCTRA_APT_STAMP}" ]]; then
    last=$(tr -dc '0-9' < "${OCTRA_APT_STAMP}" 2>/dev/null || true)
  fi
  last="${last:-0}"
  if (( now - last < OCTRA_APT_TTL )); then
    log "apt lists are $(( now - last ))s old - skipping apt-get update"
    return 0
  fi
  log "apt-get update"
  if DEBIAN_FRONTEND=noninteractive apt-get update; then
    echo "${now}" > "${OCTRA_APT_STAMP}" 2>/dev/null || true
    return 0
  fi
  warn "apt-get update failed - trying once more in 10s"
  sleep 10
  DEBIAN_FRONTEND=noninteractive apt-get update || { err "apt-get update failed (network or mirror)"; return 1; }
  echo "${now}" > "${OCTRA_APT_STAMP}" 2>/dev/null || true
}

# install_packages <pkg> ... - only the missing ones, with an apt-lock retry
# (unattended-upgrades holds the dpkg lock on a freshly booted VPS).
install_packages() {
  local pkg missing=() attempt out
  for pkg in "$@"; do
    octra_pkg_installed "${pkg}" || missing+=("${pkg}")
  done
  if (( ${#missing[@]} == 0 )); then
    return 0
  fi
  log "apt-get install: ${missing[*]}"
  apt_refresh || return 1
  for attempt in 1 2 3; do
    if out=$(DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}" 2>&1); then
      printf '%s\n' "${out}"
      return 0
    fi
    printf '%s\n' "${out}"
    if [[ "${out}" == *"Could not get lock"* || "${out}" == *"dpkg frontend lock"* ]]; then
      warn "dpkg is locked (another apt run) - retrying in $(( attempt * 10 ))s"
      sleep $(( attempt * 10 ))
      continue
    fi
    break
  done
  err "could not install: ${missing[*]}"
  return 1
}

# ensure_package <pkg> - present, or installed now
ensure_package() {
  local pkg="$1"
  if octra_pkg_installed "${pkg}"; then
    log "package ${pkg}: present"
    return 0
  fi
  log "package ${pkg}: missing - installing"
  install_packages "${pkg}" || return 1
  octra_pkg_installed "${pkg}" && log "package ${pkg}: installed"
}

# ensure_tool <binary> [package] - check -> install -> continue
#   returns 0 when the binary answers, 1 when it still does not exist
ensure_tool() {
  local bin="$1" pkg="${2:-$1}"
  if octra_have "${bin}"; then
    log "tool ${bin}: present ($(command -v "${bin}"))"
    return 0
  fi
  log "tool ${bin}: missing - installing package ${pkg}"
  install_packages "${pkg}" || return 1
  if octra_have "${bin}"; then
    log "tool ${bin}: installed"
    return 0
  fi
  err "tool ${bin} is still missing after installing ${pkg}"
  return 1
}

# ensure_tools <bin[:package]> ... - the whole set or a non-zero return
ensure_tools() {
  local spec bin pkg rc=0
  for spec in "$@"; do
    bin="${spec%%:*}"
    pkg="${spec#*:}"
    [[ "${pkg}" == "${bin}" ]] && pkg="${bin}"
    ensure_tool "${bin}" "${pkg}" || rc=1
  done
  return "${rc}"
}

# --- Host hardening (MANDATORY, both programs) ----------------------
# MPTCP is dead weight on a node host and pure attack surface: the node, the
# dashboard and the SSH pull all speak plain TCP, nothing ever negotiates
# multipath. So every machine this toolkit prepares must come up with the knob
# off, persisted for the reboot:
#
#   net.mptcp.enabled = 0     -> /etc/sysctl.d/99-disable-mptcp.conf
#
# Idempotent, and harmless on a kernel without MPTCP (the knob is absent and
# there is nothing to disable). Verify with:  sysctl net.mptcp.enabled
# Both paths are overridable so the dev harness can drive every branch.
MPTCP_KNOB="${MPTCP_KNOB:-/proc/sys/net/mptcp/enabled}"
MPTCP_CONF="${MPTCP_CONF:-/etc/sysctl.d/99-disable-mptcp.conf}"

disable_mptcp() {
  if [[ ! -e "${MPTCP_KNOB}" ]]; then
    log "this kernel has no net.mptcp.enabled knob - MPTCP is not built in (nothing to disable)"
    return 0
  fi
  printf 'net.mptcp.enabled = 0\n' > "${MPTCP_CONF}"
  chmod 644 "${MPTCP_CONF}"
  log "wrote ${MPTCP_CONF} (net.mptcp.enabled = 0)"
  # immediate value first, then reload every drop-in so the running kernel and
  # the files on disk agree (a stale 50-*.conf would otherwise win)
  sysctl -w net.mptcp.enabled=0 >/dev/null 2>&1 || true
  sysctl --system >/dev/null 2>&1 || warn "sysctl --system reported an error - the value below decides"
  local value
  value=$(sysctl -n net.mptcp.enabled 2>/dev/null || echo unknown)
  if [[ "${value}" == "0" ]]; then
    log "MPTCP disabled: $(sysctl net.mptcp.enabled 2>/dev/null || echo 'net.mptcp.enabled = 0')"
    return 0
  fi
  err "net.mptcp.enabled is '${value}' - disabling MPTCP is mandatory on a node host"
  return 1
}

# --- the node repo's local OCaml switch ------------------------------
# controls/install.sh --source-build builds the switch INSIDE the repo
#   <repo>/runtime_data/toolchains/ocaml/_opam     (holds .opam-switch)
# and links it as
#   <repo>/_opam -> runtime_data/toolchains/ocaml/_opam
#
# opam 2.3 (Debian 13) CANNOT re-create that link: `opam switch link` calls
# rmdir(2) on the existing symlink, dies with
#   «"rmdir" failed on <repo>/_opam: Not a directory»
# and the failed call leaves the switch prefix EMPTY - it throws away a 15-30
# minute build. Proven on 2026-11-02 with a throw-away switch: the first
# `switch link` creates the link, the second one destroys the switch.
#
# Both scripts of the node repo call `opam switch link` (controls/install.sh and
# controls/config_val.sh), so this kit unlinks <repo>/_opam first and lets them
# re-create it.
OCAML_SWITCH_REL="runtime_data/toolchains/ocaml"

ocaml_switch_root() { printf '%s/%s\n' "${NODE_SRC_DIR}" "${OCAML_SWITCH_REL}"; }

ocaml_switch_built() { [[ -d "$(ocaml_switch_root)/_opam/.opam-switch" ]]; }

unlink_ocaml_switch_link() {  # unlink_ocaml_switch_link [<why>]
  local link="${NODE_SRC_DIR}/_opam"
  if [[ -L "${link}" ]]; then
    log "unlinking ${link} (${1:-opam 2.3 cannot relink an existing _opam})"
    rm -f "${link}"
  elif [[ -d "${link}" ]]; then
    if rmdir "${link}" 2>/dev/null; then
      log "removed the empty ${link} directory (${1:-opam needs a free path})"
    else
      warn "${link} is a non-empty directory, not a link - leaving it as it is"
    fi
  fi
  return 0
}

# A cached "<unit>.rc == 0" is NOT proof the toolchain is usable: the failed
# `opam switch link` above empties the switch prefix and leaves the exit code
# untouched. Drop what is left, so the next run rebuilds instead of reporting a
# cached success.
drop_broken_ocaml_switch() {  # drop_broken_ocaml_switch [<rc file to forget>]
  local root rc="${1:-}"
  if ocaml_switch_built; then
    return 0                       # never touch a real switch
  fi
  unlink_ocaml_switch_link "the switch has to be rebuilt"
  root=$(ocaml_switch_root)
  if [[ -d "${root}" ]]; then
    warn "dropping the incomplete switch prefix ${root} (no .opam-switch)"
    rm -rf "${root}"
  fi
  if [[ -n "${rc}" ]]; then
    rm -f "${rc}"
  fi
  return 0
}

# Run a command as the octra user
as_octra() {
  sudo -iu "${NODE_USER}" "$@"
}

# Run a command inside the node source directory as octra
in_src() {
  sudo -iu "${NODE_USER}" bash -c "cd '${NODE_SRC_DIR}' && $*"
}
