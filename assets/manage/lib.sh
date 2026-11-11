#!/usr/bin/env bash
# ===================================================================
# scripts/manage/lib.sh - shared helpers for the MANAGE-ACTIVE-NODE program
#
# The third program of the console: it does not create or move a node, it
# operates the validator that is already running (increase the bond, exit it and
# take the stake back). Everything here runs on the node host as root and calls
# the node's own controls as the `octra` user, exactly like the other two
# programs - same status markers, same ERR trap, same tool policy.
#
#   /root/manage/          this program      (/root/deploy, /root/migration = the others)
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

MANAGE_DIR="${MANAGE_DIR:-/root/manage}"
MANAGE_LOG="${MANAGE_LOG:-${MANAGE_DIR}/manage.log}"
MANAGE_STATUS="${MANAGE_STATUS:-${MANAGE_DIR}/status}"

NODE_SRC_DIR="${NODE_SRC_DIR:-/opt/octra/libv_litecore}"
NODE_DATA_ROOT="${NODE_DATA_ROOT:-/var/lib/octra}"
NODE_DATA_DIR="${NODE_DATA_DIR:-${NODE_DATA_ROOT}/devnet}"
NODE_WALLET="${NODE_WALLET:-${NODE_SRC_DIR}/.keys/validator/wallet.json}"
NODE_ENV="${NODE_ENV:-${NODE_SRC_DIR}/.keys/validator/node.env}"
NODE_USER="${NODE_USER:-octra}"
NODE_LOG="${NODE_LOG:-${NODE_SRC_DIR}/data/operator_logs/node.log}"
TOKEN_DECIMALS=6
TOKEN_UNIT=1000000

mkdir -p "${MANAGE_DIR}"

log()  { echo -e "[manage] $*" | tee -a "${MANAGE_LOG}"; }
warn() { echo -e "[warn]   $*" | tee -a "${MANAGE_LOG}" >&2; }
err()  { echo -e "[err]    $*" | tee -a "${MANAGE_LOG}" >&2; }

set_status() {  # set_status <STATE> [detail...] - read by the Windows console
  local state="$1" detail
  shift || true
  detail="$*"
  printf '%s %s %s\n' "${state}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${detail}" > "${MANAGE_STATUS}"
  log "status = ${state} ${detail}"
}

die() { err "$*"; set_status FAILED "$*"; exit 1; }

require_root() { [[ $EUID -eq 0 ]] || die "run as root"; }

# A step must never die leaving status = RUNNING: the console follows this file.
_manage_on_err() {
  local rc="$1" line="$2" cmd="$3" state
  state=$(awk 'NR==1 {print $1}' "${MANAGE_STATUS}" 2>/dev/null || true)
  case "${state}" in
    DONE|FAILED|WAITING-*) return 0 ;;
  esac
  err "unexpected failure (exit ${rc}) at line ${line}: ${cmd}"
  set_status FAILED "line ${line}: ${cmd} (exit ${rc})"
}
trap '_manage_on_err "$?" "$LINENO" "$BASH_COMMAND"' ERR

# --- the node's own controls (always as the octra user) ---------------
as_octra() { su - "${NODE_USER}" -c "$*"; }

# node_script <timeout> <command...>: run one of the node's control scripts from
# the node directory as the node user, bounded (a control script that waits on
# the chain must never freeze a step).
node_script() {
  local limit="$1"
  shift
  timeout "${limit}" su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && $*" 2>&1
}

stat_raw() { node_script "${STATE_TIMEOUT:-60}" "sh controls/stat.sh" || true; }
stat_field() {  # an unreadable field is EMPTY, not the string "None" (see deploy/lib.sh)
  awk -F' = ' -v k="$1" '$1==k { v=$2; if (v=="None" || v=="null") v=""; print v; exit }'
}

# fill SNAP/ROLE/RPC/ACTIVE/SCHED/ENROLL/BOND/EPOCH/VOTING/PROCESS from the node
read_state() {
  SNAP=$(stat_raw)
  ROLE=$(printf '%s\n' "${SNAP}" | stat_field role)
  RPC=$(printf '%s\n' "${SNAP}" | stat_field rpc)
  ACTIVE=$(printf '%s\n' "${SNAP}" | stat_field validator_active)
  SCHED=$(printf '%s\n' "${SNAP}" | stat_field validator_scheduled)
  ENROLL=$(printf '%s\n' "${SNAP}" | stat_field validator_enrollment)
  BOND=$(printf '%s\n' "${SNAP}" | stat_field validator_bond)
  EPOCH=$(printf '%s\n' "${SNAP}" | stat_field epoch)
  VOTING=$(printf '%s\n' "${SNAP}" | stat_field voting)
  PROCESS=$(printf '%s\n' "${SNAP}" | stat_field process)
}

# how often a waiting step re-prints its progress line
EXIT_PROGRESS_SEC="${EXIT_PROGRESS_SEC:-120}"

# --- "when will the stake be back?" -----------------------------------
# An exit is a chain event, not a command: the set releases the validator at a
# fold, then the bond unlocks at `withdraw_epoch` (weeks away on this network).
# The console and the operator need two numbers for that - the epoch and a
# duration - so the cadence is measured from the chain itself (two head_epoch
# samples), never hard-coded: a testnet that speeds up changes the answer.
EPOCH_SAMPLE_SEC="${EPOCH_SAMPLE_SEC:-60}"

# fmt_duration <seconds> -> "1 day 18 h" | "3 h 05 min" | "42 min" | "45 s"
fmt_duration() {
  local secs="${1:-}"
  [[ "${secs}" =~ ^[0-9]+$ ]] || { printf 'unknown'; return 0; }
  if (( secs >= 86400 )); then
    local days=$(( secs / 86400 )) hours=$(( (secs % 86400) / 3600 ))
    printf '%d day%s %d h' "${days}" "$([[ ${days} -eq 1 ]] && printf '' || printf 's')" "${hours}"
  elif (( secs >= 3600 )); then
    printf '%d h %02d min' $(( secs / 3600 )) $(( (secs % 3600) / 60 ))
  elif (( secs >= 60 )); then
    printf '%d min' $(( secs / 60 ))
  else
    printf '%d s' "${secs}"
  fi
  return 0
}

# epoch_seconds: how long one epoch lasts. EPOCH_SECONDS wins (the console sends
# the cadence it measured, a test pins it); otherwise two stat.sh samples give it.
epoch_seconds() {
  local e1 e2 t1 t2 de dt
  if [[ "${EPOCH_SECONDS:-}" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    printf '%s\n' "${EPOCH_SECONDS}"
    return 0
  fi
  [[ "${EPOCH_SAMPLE_SEC}" =~ ^[0-9]+$ ]] && (( EPOCH_SAMPLE_SEC > 0 )) || return 0
  e1=$(stat_raw | stat_field epoch)
  [[ "${e1}" =~ ^[0-9]+$ ]] || return 0
  t1=$(date +%s)
  sleep "${EPOCH_SAMPLE_SEC}"
  e2=$(stat_raw | stat_field epoch)
  [[ "${e2}" =~ ^[0-9]+$ ]] || return 0
  t2=$(date +%s)
  de=$(( e2 - e1 ))
  dt=$(( t2 - t1 ))
  (( de > 0 && dt > 0 )) || return 0
  awk -v dt="${dt}" -v de="${de}" 'BEGIN { printf "%.2f\n", dt / de }'
  return 0
}

# epoch_eta <epochs-left> <seconds-per-epoch> -> "1 day 18 h" (empty when unknown)
epoch_eta() {
  local left="${1:-}" rate="${2:-}"
  [[ "${left}" =~ ^[0-9]+$ ]] || return 0
  [[ "${rate}" =~ ^[0-9]+([.][0-9]+)?$ ]] || return 0
  awk -v l="${left}" -v r="${rate}" 'BEGIN { printf "%d\n", (l * r) + 0.5 }'
  return 0
}

# --- the withdrawal keeps itself alive on the host ---------------------
# `controls/enroll.sh withdraw` only signs once the chain allows it (unbonding
# over AND the validator out of the set). Waiting for that inside a step would
# block the console for weeks, and only re-running the step by hand would ever
# withdraw the stake - so the step installs a small systemd timer instead. It
# survives reboots and console restarts, and disarms itself when bond = 0.
EXIT_WATCH_UNIT="${EXIT_WATCH_UNIT:-octra-exit-withdraw}"
EXIT_WATCH_SCRIPT="${EXIT_WATCH_SCRIPT:-/root/manage/40-exit-withdraw.sh}"
EXIT_WATCH_STATUS="${EXIT_WATCH_STATUS:-${MANAGE_DIR}/exit-watch.status}"
EXIT_WATCH_LOG="${EXIT_WATCH_LOG:-${MANAGE_DIR}/exit-watch.log}"
SYSTEMD_DIR="${OCTRA_SYSTEMD_DIR:-/etc/systemd/system}"
SYSTEMCTL="${OCTRA_SYSTEMCTL:-systemctl}"

exit_watch_status() {
  [[ -f "${EXIT_WATCH_STATUS}" ]] && head -1 "${EXIT_WATCH_STATUS}"
  return 0
}

exit_watch_install() {
  local service="${SYSTEMD_DIR}/${EXIT_WATCH_UNIT}.service"
  local timer="${SYSTEMD_DIR}/${EXIT_WATCH_UNIT}.timer"
  if [[ ! -f "${EXIT_WATCH_SCRIPT}" ]]; then
    warn "cannot arm the withdrawal timer: ${EXIT_WATCH_SCRIPT} is missing (push the manage scripts again)"
    return 0
  fi
  mkdir -p "${SYSTEMD_DIR}" 2>/dev/null || true
  cat > "${service}" <<UNIT || warn "could not write ${service}"
[Unit]
Description=Octra validator stake withdrawal (retries until the unbonding period is over)

[Service]
Type=oneshot
ExecStart=/bin/bash ${EXIT_WATCH_SCRIPT}
UNIT
  cat > "${timer}" <<UNIT || warn "could not write ${timer}"
[Unit]
Description=Octra validator stake withdrawal retry (every 15 minutes)

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
AccuracySec=1min
Unit=${EXIT_WATCH_UNIT}.service

[Install]
WantedBy=timers.target
UNIT
  if "${SYSTEMCTL}" daemon-reload >/dev/null 2>&1 \
     && "${SYSTEMCTL}" enable --now "${EXIT_WATCH_UNIT}.timer" >/dev/null 2>&1; then
    log "the withdrawal retry is armed: ${EXIT_WATCH_UNIT}.timer (every 15 min, also after a reboot)"
  else
    warn "could not enable ${EXIT_WATCH_UNIT}.timer - the console still follows the unbonding"
  fi
  return 0
}

exit_watch_disarm() {
  if "${SYSTEMCTL}" disable --now "${EXIT_WATCH_UNIT}.timer" >/dev/null 2>&1; then
    log "the withdrawal retry is off (${EXIT_WATCH_UNIT}.timer)"
  fi
  return 0
}

# The node's own operator log explains a slow set fold / refused readiness post.
#
# 2026-11-04: `line=$(... | grep ...)` returned 1 when the log had no
# `set_post_failed` line (a HEALTHY node) and `set -e` + pipefail made the caller
# die as `unexpected failure ... HINT=$(post_hint)`. Optional text must never
# fail - see the same note in scripts/deploy/lib.sh.
post_hint() {
  local line=""
  [[ -f "${NODE_LOG}" ]] || return 0
  line=$(tail -n 400 "${NODE_LOG}" 2>/dev/null | grep -a "set_post_failed" | tail -1 || true)
  if [[ -n "${line}" ]]; then
    printf '%s' "${line##*reason = }"
  fi
  return 0
}

# --- the node's own RPC (fast path when /status is too slow) ------------
# `stat.sh` reads /status, which builds a big snapshot; on a node that is stuck
# in catch-up that call can take longer than the tool timeout and everything
# reads as "rpc unavailable" even though the RPC answers /rpc in milliseconds.
# These helpers ask the small endpoints directly.
api_port() { local p; p=$(node_env_value OCTRA_API_PORT); printf '%s' "${p:-8080}"; }

rpc() {  # rpc <method> [params-json]
  timeout 20 curl -s -X POST -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" \
    "http://127.0.0.1:$(api_port)/rpc" 2>/dev/null || true
}

rpc_field() {  # rpc_field <method> <params-json> <field>
  rpc "$1" "${2:-[]}" | jq -r --arg k "$3" '.result[$k] // empty' 2>/dev/null || true
}

head_epoch() { rpc_field octra_validatorEnrollment '[]' head_epoch; }

status_code() {  # status_code -> the HTTP code of /status (000 = timed out)
  timeout 8 curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$(api_port)/status" 2>/dev/null || true
}

pm2_name() { local n; n=$(node_env_value OCTRA_OPERATOR_PM2_NAME); printf '%s' "${n:-octra-validator-01}"; }

pm2_state() {  # pm2_state -> "<name> <status> <pid>" (empty when pm2 has no such app)
  su - "${NODE_USER}" -c "pm2 jlist" 2>/dev/null \
    | jq -r --arg n "$(pm2_name)" '.[] | select(.name==$n) | "\(.name) \(.pm2_env.status) \(.pid)"' 2>/dev/null \
    | head -1 || true
}

# how far behind the network this node is (epochs), and the network's own idea of
# the current epoch, both from the operator log - the RPC only knows its own head
network_epoch() {
  [[ -f "${NODE_LOG}" ]] || return 0
  tail -n 400 "${NODE_LOG}" 2>/dev/null | grep -aoE 'epoch = [0-9]+' | tail -1 | awk '{print $3}' || true
}

catchup_reason() {  # the last reason catch-up could not fetch a range
  [[ -f "${NODE_LOG}" ]] || return 0
  tail -n 400 "${NODE_LOG}" 2>/dev/null \
    | grep -a 'range_http_unavailable' | tail -1 \
    | sed -n 's/.*error = //p' || true
}

# 1 OCT = 1000000 raw; the console sends OCT as a string (at most six decimals).
oct_to_raw() {
  local value="$1" whole fraction pad
  [[ "${value}" =~ ^[0-9]+(\.[0-9]{1,6})?$ ]] || die "amount must be OCT with at most six decimals (got '${value}')"
  whole="${value%%.*}"
  fraction="000000"
  [[ "${value}" == *.* ]] && fraction="${value#*.}"
  pad="${fraction}000000"
  pad="${pad:0:6}"
  printf '%s\n' "$(( 10#${whole} * TOKEN_UNIT + 10#${pad} ))"
}

raw_to_oct() {
  awk -v raw="${1:-0}" -v unit="${TOKEN_UNIT}" 'BEGIN { printf "%.6f\n", raw / unit }' | sed -e 's/0*$//' -e 's/\.$//'
}

wallet_address() {
  if [[ -f "${NODE_WALLET}" ]]; then
    jq -r '.address // empty' "${NODE_WALLET}" 2>/dev/null || true
  fi
}

node_env_value() {  # node_env_value <KEY>
  [[ -f "${NODE_ENV}" ]] || return 0
  grep -m1 "^$1=" "${NODE_ENV}" 2>/dev/null | cut -d= -f2- || true
}

# --- the bond increase tool (pushed by the console) -------------------
BOND_INC_LOCAL="${BOND_INC_LOCAL:-${MANAGE_DIR}/bond_inc.sh}"
BOND_INC_REMOTE="${BOND_INC_REMOTE:-${NODE_SRC_DIR}/bond_inc.sh}"

install_bond_inc() {
  [[ -f "${BOND_INC_LOCAL}" ]] || die "bond_inc.sh was not pushed to ${BOND_INC_LOCAL} - start the increase again from the console"
  if [[ -f "${BOND_INC_REMOTE}" ]] && cmp -s "${BOND_INC_LOCAL}" "${BOND_INC_REMOTE}"; then
    log "bond_inc.sh in the node directory is up to date"
  else
    log "installing bond_inc.sh into ${NODE_SRC_DIR} (owned by ${NODE_USER})"
    install -m 0700 "${BOND_INC_LOCAL}" "${BOND_INC_REMOTE}" \
      || die "could not write ${BOND_INC_REMOTE}"
    # the tool must be owned by the node user (it reads that wallet as that user)
    chown "${NODE_USER}:${NODE_USER}" "${BOND_INC_REMOTE}" 2>/dev/null \
      || warn "could not chown ${BOND_INC_REMOTE} to ${NODE_USER} - check the owner"
  fi
}

# bond_inc.sh keeps ONE signed increase in validator-control/bond-increase.json
# and compares it with the arguments + the registry on every run:
#   * no record                    -> the first increase, run without --new
#   * a record that is confirmed   -> a further increase needs --new
#   * a record pending/staging     -> nothing new may be signed (wait)
saved_increase_path() {
  local path="${NODE_DATA_DIR}/validator-control/bond-increase.json"
  [[ -f "${path}" ]] && printf '%s\n' "${path}"
  return 0
}

show_saved_increase() {
  local path
  path=$(saved_increase_path)
  [[ -n "${path}" ]] || return 0
  log "a signed bond increase is already stored on this host:"
  jq -r '"    amount = \(.amount) raw, stage = \(.stage), tx = \(.tx_hash)"' "${path}" 2>/dev/null | sed 's/^/  /' || true
}
