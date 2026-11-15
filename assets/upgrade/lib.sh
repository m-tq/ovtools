#!/usr/bin/env bash
# ===================================================================
# scripts/upgrade/lib.sh - shared helpers for the UPDATE-NODE actions
#
# The update actions of the console's "Manage active node" block (they are not a
# tab of their own since 2026-11-05): they do not create, move or operate the
# validator - they UPDATE the node that is already running, exactly as the
# upstream README describes ("How to update (if you are already a validator)"):
#
#   * the official tool:   controls/upgrade.sh            (test, changes nothing)
#                          controls/upgrade.sh --apply    (pull, build, restart,
#                                                         wait, verify)
#   * the manual fallback: git pull --ff-only -> controls/check.sh -> make -C mcl
#                          -> dune build -> controls/stop.sh -> controls/run.sh
#                          --rebind-runtime -> controls/stat.sh
#   * housekeeping:        controls/storage.sh [--prune-prior --yes]
#                          ("Remove preserved states")
#
# NEVER (upstream, in capitals): do not run `--sync` again, do not change
# config/network.env, do not re-enroll the node. Every step here only pulls,
# builds, restarts and reads.
#
#   /root/upgrade/          this program   (/root/deploy, /root/migration, /root/manage)
# ===================================================================
set -euo pipefail

# Tool policy (check -> install -> continue) lives in scripts/config.sh, which is
# pushed to /root/config.sh next to these scripts.
CONFIG_FILE="${CONFIG_FILE:-/root/config.sh}"
if [[ -f "${CONFIG_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${CONFIG_FILE}"
fi
if ! declare -F ensure_tool >/dev/null 2>&1; then
  ensure_tool() { command -v "$1" >/dev/null 2>&1 || die "tool $1 is missing and ${CONFIG_FILE} cannot install it (push the scripts again)"; }
fi

UPGRADE_DIR="${UPGRADE_DIR:-/root/upgrade}"
UPGRADE_LOG="${UPGRADE_LOG:-${UPGRADE_DIR}/upgrade.log}"
UPGRADE_STATUS="${UPGRADE_STATUS:-${UPGRADE_DIR}/status}"

NODE_SRC_DIR="${NODE_SRC_DIR:-/opt/octra/libv_litecore}"
NODE_DATA_ROOT="${NODE_DATA_ROOT:-/var/lib/octra}"
NODE_DATA_DIR="${NODE_DATA_DIR:-${NODE_DATA_ROOT}/devnet}"
NODE_WALLET="${NODE_WALLET:-${NODE_SRC_DIR}/.keys/validator/wallet.json}"
NODE_ENV="${NODE_ENV:-${NODE_SRC_DIR}/.keys/validator/node.env}"
NODE_USER="${NODE_USER:-octra}"
NODE_LOG="${NODE_LOG:-${NODE_SRC_DIR}/data/operator_logs/node.log}"
# the control scripts the upstream README names
UPGRADE_SH="${UPGRADE_SH:-${NODE_SRC_DIR}/controls/upgrade.sh}"
STORAGE_SH="${STORAGE_SH:-${NODE_SRC_DIR}/controls/storage.sh}"
CHECK_SH="${CHECK_SH:-${NODE_SRC_DIR}/controls/check.sh}"
STOP_SH="${STOP_SH:-${NODE_SRC_DIR}/controls/stop.sh}"
RUN_SH="${RUN_SH:-${NODE_SRC_DIR}/controls/run.sh}"
# where SOURCE_COMMIT lives in the checkout (upstream ships it)
SOURCE_COMMIT_FILE="${SOURCE_COMMIT_FILE:-${NODE_SRC_DIR}/SOURCE_COMMIT}"

mkdir -p "${UPGRADE_DIR}"

log()  { echo -e "[upgrade] $*" | tee -a "${UPGRADE_LOG}"; }
warn() { echo -e "[warn]    $*" | tee -a "${UPGRADE_LOG}" >&2; }
err()  { echo -e "[err]     $*" | tee -a "${UPGRADE_LOG}" >&2; }

set_status() {  # set_status <STATE> [detail...] - read by the Windows console
  local state="$1" detail
  shift || true
  detail="$*"
  printf '%s %s %s\n' "${state}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${detail}" > "${UPGRADE_STATUS}"
  log "status = ${state} ${detail}"
}

die() { err "$*"; set_status FAILED "$*"; exit 1; }

require_root() { [[ $EUID -eq 0 ]] || die "run as root"; }

# A step must never die leaving status = RUNNING: the console follows this file.
_upgrade_on_err() {
  local rc="$1" line="$2" cmd="$3" state
  state=$(awk 'NR==1 {print $1}' "${UPGRADE_STATUS}" 2>/dev/null || true)
  case "${state}" in
    DONE|FAILED|WAITING-*) return 0 ;;
  esac
  err "unexpected failure (exit ${rc}) at line ${line}: ${cmd}"
  set_status FAILED "line ${line}: ${cmd} (exit ${rc})"
}
trap '_upgrade_on_err "$?" "$LINENO" "$BASH_COMMAND"' ERR

# --- the node's own controls (always as the octra user) ---------------
as_octra() { su - "${NODE_USER}" -c "$*"; }

# prepare_upstream_build - make the checkout writable and the OCaml switch
# usable before the official tool or the manual build runs.
#
# Root-run steps can leave .git files owned by root (git pull then fails for
# octra), the generated config/node-data.json makes the tree look dirty, and
# opam 2.3's `switch create <path>` leaves a root _opam symlink that its own
# `switch link` step then refuses to replace. Repair all three up front.
prepare_upstream_build() {
  local switch="${NODE_SRC_DIR}/runtime_data/toolchains/ocaml"
  chown -R "${NODE_USER}:${NODE_USER}" "${NODE_SRC_DIR}" 2>/dev/null || true
  mkdir -p "${NODE_SRC_DIR}/.git/info"
  if ! grep -qx 'config/node-data.json' "${NODE_SRC_DIR}/.git/info/exclude" 2>/dev/null; then
    echo 'config/node-data.json' >> "${NODE_SRC_DIR}/.git/info/exclude"
  fi
  chown "${NODE_USER}:${NODE_USER}" "${NODE_SRC_DIR}/.git/info/exclude" 2>/dev/null || true

  ensure_package libev-dev || die "could not install libev-dev (required by ocaml/irmin)"
  ensure_package libgmp-dev || die "could not install libgmp-dev (required by zarith)"
  ensure_package liblmdb-dev || die "could not install liblmdb-dev (required by irmin-pack)"
  ensure_tool pkg-config pkg-config || die "could not install pkg-config (required by the build)"

  if [[ -d "${switch}/_opam/.opam-switch" ]]; then
    # Valid switch: let `opam switch link` recreate the root link itself.
    rm -f "${NODE_SRC_DIR}/_opam"
  else
    # Stub/incomplete switch from an interrupted build. Removing it makes the
    # official tool create the switch from its own cwd, which then makes
    # `opam switch link` fail on the root _opam symlink (opam 2.3). Create it
    # here from a neutral cwd, then let the tool link it.
    rm -rf "${switch}/_opam" 2>/dev/null || true
    rm -f "${NODE_SRC_DIR}/_opam"
    local tmp
    tmp=$(mktemp -d /tmp/ovtools-opam-create.XXXXXX)
    chown "${NODE_USER}:${NODE_USER}" "${tmp}" 2>/dev/null || true
    log "opam switch is missing/incomplete - recreating ${switch} before the official tool"
    if ! su - "${NODE_USER}" -c "cd '${tmp}' && opam switch create '${switch}' 4.14.2 -y"; then
      warn "could not pre-create the opam switch - the official tool will try its own path"
    fi
    rm -rf "${tmp}"
    rm -f "${NODE_SRC_DIR}/_opam"
  fi
}

# clean_pm2_supervisor_env - PM2 sometimes inherits OCTRA_DATA_DIR from the shell
# that first started it. The official upgrade tool counts every process with that
# variable as a data-directory owner and refuses with:
#   data directory is used by unexpected processes: <daemon>,<node>
# Restart the daemon with a clean environment; the app is restored from dump.pm2.
# Sets PM2_WAS_REPAIRED=1 so the caller can wait for the node to settle.
PM2_WAS_REPAIRED=0
clean_pm2_supervisor_env() {
  local daemon home pm2
  daemon=$(pgrep -u "${NODE_USER}" -f 'PM2 v.*God Daemon' 2>/dev/null | head -1 || true)
  [[ -n "${daemon}" ]] || return 0
  if ! tr '\0' '\n' < "/proc/${daemon}/environ" 2>/dev/null | grep -q '^OCTRA_DATA_DIR='; then
    return 0
  fi
  warn "the PM2 supervisor inherited OCTRA_DATA_DIR - restarting it with a clean environment"
  home=$(getent passwd "${NODE_USER}" | cut -d: -f6)
  pm2=$(su - "${NODE_USER}" -c 'command -v pm2' 2>/dev/null || true)
  [[ -n "${pm2}" ]] || die "pm2 is not on PATH for ${NODE_USER}"
  su - "${NODE_USER}" -c 'pm2 save --force' || true
  su - "${NODE_USER}" -c 'pm2 kill' || true
  sleep 3
  su - "${NODE_USER}" -c "env -i HOME='${home}' USER='${NODE_USER}' LOGNAME='${NODE_USER}' PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin PM2_HOME='${home}/.pm2' '${pm2}' resurrect"
  sleep 5
  su - "${NODE_USER}" -c 'pm2 save --force' || true
  PM2_WAS_REPAIRED=1
  log "PM2 supervisor restarted with a clean environment"
}

# wait_for_node_rpc - after a supervisor repair the node has to reopen its store.
wait_for_node_rpc() {
  local limit="${PM2_REPAIR_WAIT:-3600}" start now
  start=$(date +%s)
  while true; do
    read_state
    if [[ "${PROCESS}" == "online" && "${RPC}" == "ready" ]]; then
      return 0
    fi
    now=$(date +%s)
    if (( now - start >= limit )); then
      warn "node did not reach rpc=ready within ${limit}s (process=${PROCESS:-?} rpc=${RPC:-?})"
      return 1
    fi
    log "waiting for the node to reopen its store after the supervisor repair ($((now - start))s/${limit}s)"
    sleep 20
  done
}

# node_script <timeout> <command...>: run one of the node's control scripts from
# the node directory as the node user, bounded so a control script that waits on
# the chain can never freeze a step. stdout+stderr are merged (what the operator
# needs to read).
node_script() {
  local limit="$1"
  shift
  timeout "${limit}" su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && $*" 2>&1
}

# like node_script, but the caller decides what a non-zero exit means
node_script_rc() {  # node_script_rc <timeout> <command...> -> prints output, returns the rc
  local limit="$1" rc
  shift
  set +e
  timeout "${limit}" su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && $*" 2>&1
  rc=$?
  set -e
  return "${rc}"
}

stat_raw() { node_script "${STATE_TIMEOUT:-60}" "sh controls/stat.sh" || true; }

stat_field() {  # an unreadable field is EMPTY, not the string "None" (see deploy/lib.sh)
  awk -F' = ' -v k="$1" '$1 == k { if ($2 == "None" || $2 == "null") { print ""; exit } print $2; exit }'
}

# read_state: the fields every step here cares about (never writes anything on the
# node - stat.sh is read-only)
read_state() {
  SNAP=$(stat_raw)
  ROLE=$(printf '%s\n' "${SNAP}" | stat_field role)
  PROCESS=$(printf '%s\n' "${SNAP}" | stat_field process)
  RPC=$(printf '%s\n' "${SNAP}" | stat_field rpc)
  VOTING=$(printf '%s\n' "${SNAP}" | stat_field voting)
  EPOCH=$(printf '%s\n' "${SNAP}" | stat_field epoch)
  ACTIVE=$(printf '%s\n' "${SNAP}" | stat_field validator_active)
  SCHED=$(printf '%s\n' "${SNAP}" | stat_field validator_scheduled)
  ENROLL=$(printf '%s\n' "${SNAP}" | stat_field validator_enrollment)
  BINARY=$(printf '%s\n' "${SNAP}" | stat_field binary)
  PVAC=$(printf '%s\n' "${SNAP}" | stat_field pvac_worker)
  PROCESS_UP=$(printf '%s\n' "${SNAP}" | stat_field uptime)
}

# --- the checkout: what is really there -------------------------------
# The clone belongs to the node user, so `git` as root refuses with "dubious
# ownership": ask with an explicit safe.directory (same as deploy/lib.sh).
git_node() {  # git_node <args...>
  git -c safe.directory="${NODE_SRC_DIR}" -C "${NODE_SRC_DIR}" "$@" 2>/dev/null || true
}

source_commit() {     # the commit the checkout SAYS it is (upstream file)
  local out=""
  [[ -f "${SOURCE_COMMIT_FILE}" ]] && out=$(head -c 64 "${SOURCE_COMMIT_FILE}" 2>/dev/null | tr -d '[:space:]' || true)
  printf '%s' "${out}"
}

git_head() { git_node rev-parse --short HEAD | head -1; }
git_branch() {
  local out
  out=$(git_node rev-parse --abbrev-ref HEAD | head -1)
  [[ "${out}" == "HEAD" ]] && out=""
  printf '%s' "${out}"
}
git_dirty() {   # 1 when the working tree has local changes (a build might depend on them)
  local out
  out=$(git_node status --porcelain | head -1)
  [[ -n "${out}" ]] && printf '1'
  return 0
}
git_remote() {
  local out
  out=$(git_node config --get remote.origin.url | head -1)
  printf '%s' "${out:-https://github.com/octra-labs/lite_node.git}"
}

# --- tools the two update paths need ----------------------------------
ensure_build_tools() {
  ensure_tool git   git             || die "git is missing and could not be installed"
  ensure_tool make  make            || die "make is missing and could not be installed"
  ensure_tool opam  opam            || die "opam is missing and could not be installed"
  # the manual build compiles the C++/mcl part and needs a compiler
  if ! command -v g++ >/dev/null 2>&1 && ! command -v c++ >/dev/null 2>&1; then
    ensure_package build-essential || true
  fi
}

# --- storage.sh (preserved states) ------------------------------------
storage_report() {   # read-only: what the store holds right now
  node_script "${STORAGE_TIMEOUT:-180}" "sh controls/storage.sh" || true
}

storage_summary() {  # one line out of the report, for the status detail
  # optional text: a report this version does not match must never fail the caller
  storage_report | grep -iE 'preserved|reclaim|prior|free|used|total' | tail -3 \
    | tr '\n' ' ' | sed 's/  */ /g' || true
  return 0
}

# The report is emitted as `event = storage data_bytes = ... prior_count = ...`
# lines; the status detail only needs the few numbers that matter. Like
# storage_summary this is OPTIONAL text and must never return non-zero.
storage_fields() {
  storage_report | grep -oE '(prior_count|prior_bytes|free_bytes|data_bytes) = [0-9]+' \
    | tr '\n' ' ' | sed -e 's/ = /=/g' -e 's/ *$//' || true
  return 0
}

# the wallet address of the node (read-only)
wallet_address() {
  if [[ -f "${NODE_WALLET}" ]] && command -v jq >/dev/null 2>&1; then
    jq -r '.address // empty' "${NODE_WALLET}" 2>/dev/null || true
  fi
}

prune_states() {     # the documented "Remove preserved states"
  node_script_rc "${PRUNE_TIMEOUT:-900}" "sh controls/storage.sh --prune-prior --yes"
}

# --- what the upgrade tool answered -----------------------------------
# controls/upgrade.sh ends with a status line the README names: validator_active
# or observer_synced = fine, pending = do NOT restart and try later, refused =
# the reason is in the output.
upgrade_verdict() {  # upgrade_verdict <output-file>
  local file="$1"
  [[ -f "${file}" ]] || return 0
  awk '
    /validator_active|observer_synced|status = installed|validator_entry_pending|status = pending|pending|refused/ {
      if ($0 ~ /validator_active/) { print "validator_active"; exit }
      if ($0 ~ /observer_synced/)  { print "observer_synced"; exit }
      if ($0 ~ /status = installed/ || $0 ~ /validator_entry_pending/) { print "installed"; exit }
      if ($0 ~ /pending/)          { print "pending"; exit }
      if ($0 ~ /refused/)          { print "refused"; exit }
    }' "${file}" | tail -1
}

upgrade_reason() {   # the last line that explains why (refused/pending)
  local file="$1" line
  [[ -f "${file}" ]] || return 0
  line=$(grep -aiE 'status = (refused|pending)|reason = |error|denied|not allowed|dirty' "${file}" 2>/dev/null | tail -1 || true)
  printf '%s' "${line##*: }"
}

