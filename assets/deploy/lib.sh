#!/usr/bin/env bash
# ===================================================================
# scripts/deploy/lib.sh - shared helpers for the DEPLOY toolkit
#
# Sourced by every script in scripts/deploy/. It mirrors scripts/migrate/lib.sh
# (paths, logging, status markers) but keeps its own state directory, so the two
# programs never read the files of the other on the host:
#
#   /root/deploy/          this program       (/root/migration/ = migration)
#
# The long children (toolchain build, node build + 38 GB sync) run as systemd
# units and write an exit code to a file, so a dropped SSH never kills them and a
# re-run picks the finished result up.
# ===================================================================
set -euo pipefail

# Node paths: reuse the pushed config.sh (/root/config.sh) when present so both
# programs agree, and fall back to the same absolute defaults otherwise.
CONFIG_FILE="${CONFIG_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../config.sh}"
if [[ -f "${CONFIG_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${CONFIG_FILE}"
fi

# Tool policy (check -> install -> continue) lives in config.sh, which is pushed
# to /root/config.sh next to these scripts. A host that still has an OLD config.sh
# gets a loud warning instead of a "command not found" ten minutes later.
if ! declare -F ensure_tool >/dev/null 2>&1; then
  echo "[warn]   ${CONFIG_FILE} has no ensure_tool (old copy on the host) - pushing the scripts again fixes it" >&2
  ensure_tool() {
    command -v "$1" >/dev/null 2>&1 || die "tool $1 is missing and ${CONFIG_FILE} cannot install it (push the scripts again)"
  }
fi

DEPLOY_DIR="${DEPLOY_DIR:-/root/deploy}"
DEPLOY_LOG="${DEPLOY_LOG:-${DEPLOY_DIR}/deploy.log}"
DEPLOY_STATUS="${DEPLOY_STATUS:-${DEPLOY_DIR}/status}"
DEPLOY_HOST_ENV="${DEPLOY_HOST_ENV:-${DEPLOY_DIR}/host.env}"

NODE_SRC_DIR="${NODE_SRC_DIR:-/opt/octra/libv_litecore}"
NODE_DATA_ROOT="${NODE_DATA_ROOT:-/var/lib/octra}"
NODE_DATA_DIR="${NODE_DATA_DIR:-${NODE_DATA_ROOT}/devnet}"
NODE_SYNC_STAGE="${NODE_SYNC_STAGE:-${NODE_DATA_ROOT}/devnet.state_sync}"
NODE_ENV="${NODE_ENV:-${NODE_SRC_DIR}/.keys/validator/node.env}"
NODE_WALLET="${NODE_WALLET:-${NODE_SRC_DIR}/.keys/validator/wallet.json}"
NODE_USER="${NODE_USER:-octra}"
API_PORT="${API_PORT:-8080}"
CONSENSUS_PORT="${CONSENSUS_PORT:-19000}"
P2P_PORT="${P2P_PORT:-9000}"
NODE_PM2_NAME="${NODE_PM2_NAME:-octra-node-1}"
# the node's own operator log: the enroll/promote steps quote it when the
# network refuses a readiness post (the real reason a fold wait is slow).
# Defined AFTER NODE_SRC_DIR: with `set -u` the other order dies on a host whose
# /root/config.sh is missing (2026-11-04).
NODE_LOG="${NODE_LOG:-${NODE_SRC_DIR}/data/operator_logs/node.log}"
# how often a waiting step re-prints its progress line (and the network hint).
# Overridable so the wait path is testable without a 2-minute test.
ENROLL_PROGRESS_SEC="${ENROLL_PROGRESS_SEC:-60}"

mkdir -p "${DEPLOY_DIR}"

# The host keeps this log across runs (a redeploy appends to it): rotate it
# instead of letting it grow forever - a full deploy writes well under 1 MB.
log_bytes=$(stat -c%s "${DEPLOY_LOG}" 2>/dev/null || echo 0)
if [[ "${log_bytes}" =~ ^[0-9]+$ ]] && (( log_bytes > 5242880 )); then
  mv -f "${DEPLOY_LOG}" "${DEPLOY_LOG}.1" 2>/dev/null || true
fi

log()  { echo -e "[deploy] $*" | tee -a "${DEPLOY_LOG}"; }
warn() { echo -e "[warn]   $*" | tee -a "${DEPLOY_LOG}" >&2; }
err()  { echo -e "[err]    $*" | tee -a "${DEPLOY_LOG}" >&2; }

set_status() {  # set_status <STATE> [detail...] - read by the Windows orchestrator
  # every argument after the state is the detail: several steps used to pass the
  # label and the interesting part as two arguments (set_status DONE "enroll"
  # "${ADDR}") and the third one was silently dropped, so the console showed
  # "enroll" instead of the result.
  local state="$1" detail
  shift || true
  detail="$*"
  printf '%s %s %s\n' "${state}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${detail}" > "${DEPLOY_STATUS}"
  log "status = ${state} ${detail}"
}

die() { err "$*"; set_status FAILED "$*"; exit 1; }

require_root() { [[ $EUID -eq 0 ]] || die "run as root"; }

# --- a step must never die leaving status = RUNNING -------------------
# These scripts run detached (systemd unit) and the Windows orchestrator follows
# /root/deploy/status. A script that died from an unexpected error - a helper that
# no longer exists (2026-11-02: heal_opam_link), an unset variable with `set -u`, a
# full disk - wrote nothing, so the status stayed RUNNING and the console followed
# it until the 2-hour timeout instead of showing the error. This trap turns that
# class of failure into an immediate, readable FAILED with the failing line.
_deploy_on_err() {
  local rc="$1" line="$2" cmd="$3" state
  state=$(awk 'NR==1 {print $1}' "${DEPLOY_STATUS}" 2>/dev/null || true)
  case "${state}" in
    DONE|FAILED|WAITING-*) return 0 ;;        # the script already decided
  esac
  err "unexpected failure (exit ${rc}) at line ${line}: ${cmd}"
  set_status FAILED "line ${line}: ${cmd} (exit ${rc})"
}
trap '_deploy_on_err "$?" "$LINENO" "$BASH_COMMAND"' ERR

# --- node process/status helpers (same conventions as the migration lib) ---
# pgrep/pkill -f would match the shell running the check itself; [o]ctra avoids it
NODE_PROC_RE='[o]ctra_node\.exe|[o]ctra_pvac_worker\.exe'
node_processes() { ps -eo pid,args --no-headers 2>/dev/null | grep -E "${NODE_PROC_RE}" || true; }
as_octra() { su - "${NODE_USER}" -c "$*"; }
node_stat() { as_octra "cd ${NODE_SRC_DIR} && sh controls/stat.sh 2>/dev/null" || true; }
# ends with `sed`: the node prints Python's `None` for a field it cannot read
# (e.g. `validator_bond = None`), which used to be logged verbatim (`bond=None`)
# and compared as if it were a value. An unset field is an EMPTY value, so every
# `${BOND:-0}` default works as intended.
stat_field() {
  awk -F' = ' -v k="$1" '$1==k { v=$2; if (v=="None" || v=="null") v=""; print v; exit }'
}

# The node publishes its readiness through its own duty loop; when the public
# RPC refuses that post the set fold never schedules us and the enroll/promote
# waits look stalled. This quotes the last refusal so the operator sees the
# real reason ("validator ready head has expired", "invalid nonce", HTTP 429).
#
# 2026-11-04 (real incident): the helper was called as `HINT=$(post_hint)` and
# returned the status of its own pipeline. With `set -o pipefail`, `grep` finds
# nothing on a HEALTHY node (no `set_post_failed` line yet) and exits 1 - so the
# assignment failed, `set -e` fired and the step died as
#   `unexpected failure (exit 1) at line 62: HINT=$(post_hint)`
# before the fold wait could ever finish: the promote step kept dying at its
# 2-minute progress line and the node stayed an observer. A helper that only
# produces OPTIONAL text must never return non-zero - the callers rely on it.
post_hint() {
  local line=""
  [[ -f "${NODE_LOG}" ]] || return 0
  line=$(tail -n 400 "${NODE_LOG}" 2>/dev/null | grep -a "set_post_failed" | tail -1 || true)
  if [[ -n "${line}" ]]; then
    printf '%s' "${line##*reason = }"
  fi
  return 0
}

api_get() {  # api_get <path> - node REST API on localhost
  curl -fsS --max-time 8 "http://127.0.0.1:${API_PORT}$1" 2>/dev/null || true
}

wallet_address() {
  if [[ -f "${NODE_WALLET}" ]] && command -v jq >/dev/null 2>&1; then
    jq -r '.address // empty' "${NODE_WALLET}" 2>/dev/null || true
  fi
}

# --- the node repository: what is really checked out? ------------------
# The clone belongs to the node user, so `git` run as root refuses with
# "fatal: detected dubious ownership in repository" and every probe came back
# empty - the toolchain step then logged `repository: unknown` although the
# checkout was right there (2026-11-04). Ask as the node user, then retry as root
# with an explicit safe.directory, then read the ref out of .git directly, and
# report what git said when everything fails: the log line is never a bare
# "unknown" (a name, a date and a path are what an operator can act on).
repo_commit_from_dotgit() {   # the ref the checkout points at, read by hand
  local head ref sha=""
  head="${NODE_SRC_DIR}/.git/HEAD"
  [[ -f "${head}" ]] || return 0
  read -r ref < "${head}" 2>/dev/null || ref=""
  case "${ref}" in
    "ref: "*)
      ref="${ref#ref: }"
      sha=$(head -c 64 "${NODE_SRC_DIR}/.git/${ref}" 2>/dev/null | tr -d '[:space:]' || true)
      if [[ ! "${sha}" =~ ^[0-9a-f]{40}$ ]]; then
        sha=$(awk -v r="${ref}" '$2 == r { print $1; exit }' \
              "${NODE_SRC_DIR}/.git/packed-refs" 2>/dev/null || true)
      fi
      ;;
    *) sha="${ref}" ;;
  esac
  [[ "${sha}" =~ ^[0-9a-f]{7,40}$ ]] || return 0
  printf '%s' "${sha:0:8}"
}

node_repo_commit() {   # short commit of the node repository ("" when unreadable)
  local out=""
  if id "${NODE_USER}" >/dev/null 2>&1; then
    out=$(as_octra "cd ${NODE_SRC_DIR} && git rev-parse --short HEAD 2>/dev/null" 2>/dev/null || true)
  fi
  if [[ -z "${out}" ]]; then
    out=$(git -c safe.directory="${NODE_SRC_DIR}" -C "${NODE_SRC_DIR}" \
          rev-parse --short HEAD 2>/dev/null || true)
  fi
  if [[ -z "${out}" ]]; then
    # git unusable (no binary / ownership rules / no safe.directory on git 2.35):
    # .git/HEAD still names the commit
    out=$(repo_commit_from_dotgit)
  fi
  printf '%s' "${out}"
}

node_repo_branch() {   # branch of the checkout ("" when detached / unknown)
  local out=""
  out=$(git -c safe.directory="${NODE_SRC_DIR}" -C "${NODE_SRC_DIR}" \
        rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  [[ "${out}" == "HEAD" ]] && out=""
  if [[ -z "${out}" && -f "${NODE_SRC_DIR}/.git/HEAD" ]]; then
    read -r out < "${NODE_SRC_DIR}/.git/HEAD" 2>/dev/null || out=""
    case "${out}" in
      "ref: refs/heads/"*) out="${out#ref: refs/heads/}" ;;
      *) out="" ;;
    esac
  fi
  printf '%s' "${out}"
}

node_repo_url() {      # the clone URL this toolkit installs (config.sh)
  printf '%s' "${NODE_REPO:-}"
}

node_repo_error() {    # why the probes failed (diagnostics only, may be empty)
  local as_user="" as_root=""
  if id "${NODE_USER}" >/dev/null 2>&1; then
    as_user=$(as_octra "cd ${NODE_SRC_DIR} && git rev-parse --short HEAD 2>&1 >/dev/null" 2>/dev/null \
              | head -1 || true)
  fi
  as_root=$(git -c safe.directory="${NODE_SRC_DIR}" -C "${NODE_SRC_DIR}" \
            rev-parse --short HEAD 2>&1 >/dev/null | head -1 || true)
  if [[ -n "${as_user}" && "${as_user}" != "${as_root}" ]]; then
    printf '%s; %s' "${as_user}" "${as_root}"
  else
    printf '%s' "${as_root:-${as_user}}"
  fi
}

ensure_dirs() {
  local dir
  for dir in "${DEPLOY_DIR}" "${NODE_SRC_DIR}" "$(dirname "${NODE_SRC_DIR}")" \
             "${NODE_DATA_ROOT}" "${NODE_DATA_DIR}" "${NODE_SYNC_STAGE}"; do
    mkdir -p "${dir}"
  done
  if id "${NODE_USER}" >/dev/null 2>&1; then
    chown "${NODE_USER}:${NODE_USER}" "${NODE_DATA_DIR}" "${NODE_SYNC_STAGE}" 2>/dev/null || true
  fi
}

# --- is the OCaml switch usable? -------------------------------------
# `controls/install.sh --source-build` builds the switch inside
# runtime_data/toolchains/ocaml (a real switch root holds `.opam-switch`) and links
# it as <repo>/_opam. The danger is the follow-up `opam switch link` call: on
# opam 2.3 (Debian 13) a second call on the existing link dies with
# «"rmdir" failed on <repo>/_opam: Not a directory» AND empties the switch prefix,
# i.e. it silently throws the build away (proven 2026-11-02). config.sh therefore
# unlinks <repo>/_opam before every `switch link` call, and this check decides
# whether a build is really usable.
assert_opam_switch() {
  local root link
  root=$(ocaml_switch_root)
  link="${NODE_SRC_DIR}/_opam"
  if ocaml_switch_built; then
    return 0
  fi
  warn "the OCaml switch does not look built: ${root}/_opam/.opam-switch is missing"
  if [[ -L "${link}" ]]; then
    warn "  ${link} -> $(readlink "${link}") (a link, not a switch)"
  else
    warn "  ${link} does not exist"
  fi
  warn "  the toolchain step reported success but left no switch - the leftovers are dropped"
  warn "  automatically, so pressing Start deploy again rebuilds the runtime:"
  warn "    rm -f ${DEPLOY_DIR}/octra-deploy-toolchain.rc && bash ${DEPLOY_DIR}/20-install-toolchain.sh"
  warn "  for a closer look at the node's own installer:"
  warn "    su - ${NODE_USER} -c 'opam switch list' ; opam --version ; ls -la ${root}/_opam"
  warn "  (opam 2.3 'switch link' empties the switch when <repo>/_opam already exists -"
  warn "   config.sh unlinks that link before every switch link call since 2026-11-02)"
  return 1
}

# --- long children as systemd units ---------------------------------
# install-deps.sh (toolchain, 15-30 min) and node-setup.sh (build + 38 GB sync)
# must survive a dropped SSH and be resumable: they run detached, write their
# log, and leave the exit code in a <unit>.rc file that the next run reads.
unit_start() {  # unit_start <unit> <workdir> [K=V ...] -- <command>
  local unit="$1" workdir="$2"
  shift 2
  local envs=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do envs+=("--setenv=$1"); shift; done
  [[ "${1:-}" == "--" ]] && shift
  local logfile="${DEPLOY_DIR}/${unit}.log" rcfile="${DEPLOY_DIR}/${unit}.rc"
  rm -f "${logfile}" "${rcfile}"
  systemctl reset-failed "${unit}" 2>/dev/null || true
  systemd-run --unit="${unit}" --collect --no-block --working-directory="${workdir}" \
    "${envs[@]}" bash -c "$* > '${logfile}' 2>&1; echo \$? > '${rcfile}'"
  log "started unit ${unit} - log ${logfile}"
}

unit_active() { systemctl is-active --quiet "$1" && echo yes || echo no; }
unit_done()   { [[ -s "${DEPLOY_DIR}/$1.rc" ]]; }
unit_rc()     { tr -dc '0-9' < "${DEPLOY_DIR}/$1.rc" 2>/dev/null || echo 1; }
unit_tail()   { tail -n "${2:-8}" "${DEPLOY_DIR}/$1.log" 2>/dev/null | sed 's/^/    /' || true; }

# --- human progress ---------------------------------------------------
# The long children print machine events (`event = sync_progress done = ...`)
# and apt bookkeeping. The operator needs one readable line per minute, so:
#   progress_summary: sync event -> "sync 42.1% - 16.0 of 38.0 GiB"
#   elapsed_minutes:  1500s     -> "25 min"
human_gib() {
  awk -v b="${1:-0}" 'BEGIN { if (b <= 0) { printf "?"; exit 0 } printf "%.1f GiB", b / 1073741824 }'
}

progress_summary() {  # progress_summary "<last matching log line>"
  local line="${1:-}"
  if [[ "${line}" =~ pct\ =\ ([0-9.]+) ]]; then
    local pct="${BASH_REMATCH[1]}" done_b="" total_b=""
    [[ "${line}" =~ done\ =\ ([0-9]+) ]] && done_b="${BASH_REMATCH[1]}"
    [[ "${line}" =~ total\ =\ ([0-9]+) ]] && total_b="${BASH_REMATCH[1]}"
    printf 'sync %.1f%% - %s of %s' "${pct}" "$(human_gib "${done_b}")" "$(human_gib "${total_b}")"
    return 0
  fi
  # anything else: keep it short enough for one row
  printf '%s' "${line:0:150}"
}

elapsed_minutes() {  # elapsed_minutes <seconds>
  local sec="${1:-0}"
  if (( sec < 90 )); then
    printf '%ds' "${sec}"
  else
    printf '%d min' "$(( sec / 60 ))"
  fi
}

unit_wait() {  # unit_wait <unit> <timeout_sec> <label> [progress_grep]
  local unit="$1" timeout="$2" label="${3:-$1}" progress_re="${4:-}"
  local start now last rc extra tailpid="" logfile="${DEPLOY_DIR}/${unit}.log"
  local last_note="" last_note_ts=0
  start=$(date +%s)
  last=$start
  # The long child writes its own log. Follow it into THIS script's stdout, so
  # the orchestrator (and the console) sees the real apt/compile/sync output
  # live instead of only a status marker.
  if [[ -f "${logfile}" ]]; then
    tail -n +1 -F "${logfile}" 2>/dev/null &
    tailpid=$!
  fi
  rc=0
  while ! unit_done "${unit}"; do
    now=$(date +%s)
    if (( now - start > timeout )); then
      warn "${label} did not finish in ${timeout}s - the unit may still be running (systemctl status ${unit})"
      rc=1
      break
    fi
    if [[ "$(unit_active "${unit}")" != "yes" ]]; then
      # the unit vanished without an rc file: give systemd a moment, then fail
      sleep 3
      if ! unit_done "${unit}"; then
        warn "${label}: unit ${unit} is gone without a status file - last log lines:"
        unit_tail "${unit}" 12
        rc=1
        break
      fi
    fi
    # One readable line a minute on top of the streamed output - and ONLY when the
    # progress actually changed. Repeating "still running... 240s | Setting up
    # node-es6-error" every minute is what made the log unreadable; when nothing
    # new is in the child log, a quiet reminder appears every 5 minutes instead.
    if (( now - last >= 60 )); then
      extra=""
      if [[ -n "${progress_re}" ]]; then
        extra=$(progress_summary "$(grep -aE "${progress_re}" "${logfile}" 2>/dev/null | tail -1 || true)")
      fi
      if [[ -n "${extra}" && "${extra}" != "${last_note}" ]]; then
        log "  ${label}: ${extra} ($(elapsed_minutes $(( now - start ))) elapsed)"
        last_note="${extra}"
        last_note_ts=${now}
      elif (( now - last_note_ts >= 300 )); then
        log "  ${label} still running - $(elapsed_minutes $(( now - start ))) elapsed, no new output"
        last_note_ts=${now}
      fi
      last=$now
    fi
    sleep 15
  done
  # stop following before the verdict is printed, so the log stays ordered
  if [[ -n "${tailpid}" ]]; then
    kill "${tailpid}" 2>/dev/null || true
    wait "${tailpid}" 2>/dev/null || true
  fi
  if (( rc != 0 )); then
    return 1
  fi
  rc=$(unit_rc "${unit}")
  if [[ "${rc}" != "0" ]]; then
    warn "${label} failed (exit ${rc}) - last log lines:"
    unit_tail "${unit}" 15
    return 1
  fi
  log "${label} finished in $(( $(date +%s) - start ))s"
  return 0
}
