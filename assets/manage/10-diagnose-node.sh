#!/usr/bin/env bash
# ===================================================================
# 10-diagnose-node.sh - WHY is this node not voting? (read-only)
#
# The state an operator reports as "ready / outside set" can mean four very
# different things, and they need different actions:
#
#   rpc_slow        the node answers /rpc but /status times out -> every tool that
#                   reads /status reports "rpc unavailable" (stat.sh, enroll.sh)
#   frozen          head_epoch does not move: catch-up cannot fetch ranges
#                   (`range_http_unavailable ... state_sync_range_busy`) and the
#                   consensus ignores every vote (`unresolved_validator_set`)
#   behind          head_epoch moves, but the node is still far from the network
#   pm2_mismatch    rejoin.sh refuses: "data directory is used outside PM2" - the
#                   running process and the pm2 entry disagree about who owns the
#                   data directory, so the node's own recovery tools refuse to run
#   outside_set     in sync and healthy, but not admitted by the set (ready/bonded,
#                   scheduled=false) -> it needs a fold, not a repair
#   active          fine
#   recovery        the local store failed its checkpoint check -> recover.sh
#
# Nothing here changes anything: it signs nothing, restarts nothing, moves no
# file. It prints the evidence and one machine line the console reads:
#
#   NODE_DIAG state=<class> head=<n> network=<n> behind=<n> rpc=<ready|slow|down>
#
# Usage:  sudo bash 10-diagnose-node.sh
# Env:    HEAD_SAMPLE_SEC=<sec>  how long the head is watched for movement (20)
#         SYNC_LAG_MAX=<n>       epochs behind that still count as "in sync" (5)
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
set_status RUNNING "diagnose-node"

ensure_tool jq jq || die "jq is missing and could not be installed"
ensure_tool curl curl || die "curl is missing and could not be installed"
[[ -f "${NODE_ENV}" ]] || die "node.env is missing (${NODE_ENV}) - is this the validator host?"

SAMPLE="${HEAD_SAMPLE_SEC:-20}"
LAG_MAX="${SYNC_LAG_MAX:-5}"

WALLET=$(wallet_address || echo unknown)
log "=== diagnose ${WALLET} on $(hostname) ==="

# --- 1. the process ------------------------------------------------------
PS=$(pm2_state)
log "pm2           : ${PS:-<no entry for $(pm2_name)>}"
PROC_STATUS=$(printf '%s' "${PS}" | awk '{print $2}')
case "${PROC_STATUS}" in
  online) : ;;
  "")     warn "pm2 has no entry named '$(pm2_name)' - the node is not supervised" ;;
  *)      warn "pm2 reports '${PROC_STATUS}' for $(pm2_name)" ;;
esac

# --- 2. RPC: the small call vs the big snapshot --------------------------
RPC_STATE="down"
ENROLL=$(rpc_field octra_validatorEnrollment '[]' state)
HEAD=$(head_epoch)
CODE=$(status_code)
if [[ "${HEAD}" =~ ^[0-9]+$ ]]; then
  RPC_STATE="ready"
  [[ "${CODE}" == "200" ]] || RPC_STATE="slow"
fi
log "rpc           : /rpc=${RPC_STATE} (/status HTTP ${CODE:-000})"
[[ "${RPC_STATE}" == "slow" ]] && warn "the /status snapshot times out, so stat.sh and enroll.sh status read 'RPC unavailable' even though the node answers /rpc"
log "enrollment    : state=${ENROLL:-?} head_epoch=${HEAD:-?}"
BOND_RAW=$(rpc_field octra_validatorEnrollment '[]' bond)
[[ -n "${BOND_RAW}" ]] && log "bond          : $(raw_to_oct "${BOND_RAW}") OCT"

# --- 3. is head moving? --------------------------------------------------
HEAD2="${HEAD}"
if [[ "${HEAD}" =~ ^[0-9]+$ ]] && (( SAMPLE > 0 )); then
  sleep "${SAMPLE}"
  HEAD2=$(head_epoch)
fi
NET_EPOCH=$(network_epoch)
BEHIND=""
if [[ "${HEAD2}" =~ ^[0-9]+$ && "${NET_EPOCH}" =~ ^[0-9]+$ ]]; then
  BEHIND=$(( NET_EPOCH - HEAD2 ))
  (( BEHIND < 0 )) && BEHIND=0
fi
MOVED=$(( ${HEAD2:-0} - ${HEAD:-0} ))
log "head          : ${HEAD:-?} -> ${HEAD2:-?} in ${SAMPLE}s (network epoch ${NET_EPOCH:-?}, behind ${BEHIND:-?})"

# --- 4. what the node itself says about the set / catch-up ---------------
REASON=$(catchup_reason)
[[ -n "${REASON}" ]] && log "catch-up      : ${REASON}"
POSTFAIL=$(post_hint)
[[ -n "${POSTFAIL}" ]] && log "duty post     : ${POSTFAIL}"

# --- 4b. memory and startup progress ------------------------------------
# A node that opens a 38 GB store on a box that is too small spends its time in
# GC/swap and never finishes starting: process up, RPC never listening, and no new
# log line for many minutes (2026-11-06, .99: 5.9 GB RAM, node RSS 4.3 GB).
MEM_TOTAL=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
MEM_AVAIL=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
NODE_PID=$(pgrep -x octra_node.exe 2>/dev/null | head -1 || true)
NODE_RSS=""
[[ -n "${NODE_PID}" ]] && NODE_RSS=$(awk '/VmRSS/ {printf "%d", $2/1024}' "/proc/${NODE_PID}/status" 2>/dev/null || true)
log "memory        : total=${MEM_TOTAL:-?}MB available=${MEM_AVAIL:-?}MB node_rss=${NODE_RSS:-n/a}MB${NODE_PID:+ (pid ${NODE_PID})}"
if (( ${MEM_TOTAL:-0} > 0 && MEM_TOTAL < 7600 )); then
  warn "less than 8 GB of RAM: the store needs ~8 GB (16 comfortable) - GC/swap makes the node slow or unable to finish starting"
fi
LOG_AGE=0
if [[ -f "${NODE_LOG}" ]]; then
  LAST_TS=$(date -r "${NODE_LOG}" +%s 2>/dev/null || echo 0)
  LOG_AGE=$(( $(date +%s) - LAST_TS ))
fi
if [[ -n "${NODE_PID}" && "${RPC_STATE}" != "ready" && ${LOG_AGE} -ge 300 ]]; then
  warn "the node has been up for a while without a new log line (${LOG_AGE}s) and its RPC is not answering: startup is stalled"
fi

# --- 5. the node's own recovery tool (it knows the set rules) ------------
REJOIN=$(node_script 180 "sh controls/rejoin.sh --check" || true)
REJOIN_LINE=$(printf '%s\n' "${REJOIN}" | grep -aE '^status = ' | tail -1 || true)
log "rejoin --check: ${REJOIN_LINE:-<no status line>}"
REJOIN_REFUSED=$(printf '%s' "${REJOIN_LINE}" | sed -n 's/.*reason = //p')
PM2_MISMATCH=0
printf '%s' "${REJOIN_REFUSED}" | grep -qi "used outside PM2" && PM2_MISMATCH=1
RECOVERY=0

# --- 6. classify ---------------------------------------------------------
STATE="unknown"
if (( RECOVERY )); then
  STATE="recovery"
elif [[ -n "${NODE_PID}" && "${RPC_STATE}" != "ready" && ${LOG_AGE} -ge 300 ]]; then
  STATE="startup_stalled"
elif [[ "${RPC_STATE}" == "down" ]]; then
  STATE="rpc_down"
elif (( PM2_MISMATCH )); then
  STATE="pm2_mismatch"
elif [[ "${RPC_STATE}" == "slow" && "${MOVED}" -le 0 ]]; then
  STATE="frozen"
elif [[ -n "${BEHIND}" ]] && (( BEHIND > LAG_MAX )); then
  STATE="behind"
elif (( MOVED <= 0 )); then
  STATE="frozen"
elif printf '%s' "${REJOIN_LINE}" | grep -q "validator_active"; then
  STATE="active"
elif printf '%s' "${REJOIN_LINE}" | grep -q "validator_scheduled"; then
  STATE="scheduled"
elif [[ "${ENROLL}" =~ ^(ready|bonded)$ ]]; then
  STATE="outside_set"
fi

case "${STATE}" in
  active)       log "verdict       : this node is the ACTIVE validator - nothing to fix" ;;
  scheduled)    log "verdict       : it is in the next set - waiting for the fold, nothing to fix" ;;
  "outside_set") log "verdict       : in sync and healthy, but not admitted yet (enrollment=${ENROLL}): it needs a set fold, not a repair" ;;
  frozen)       log "verdict       : head_epoch is not moving, catch-up is blocked (${REASON:-no reason logged}) - a clean restart re-handshakes peers and asks for a fresh range" ;;
  behind)       log "verdict       : still catching up (${BEHIND} epochs behind) - let it finish before touching the set" ;;
  "pm2_mismatch") log "verdict       : the node's own tool refuses to run because the data directory is 'used outside PM2' - the pm2 entry and the running process disagree, so the official rejoin path cannot work" ;;
  "startup_stalled") log "verdict       : the process is up but it stopped logging and its RPC never opened - the node cannot finish opening the store on this VM. Check the RAM line above: the store needs ~8 GB (16 comfortable). With less, GC/swap wins and the node never reaches the network (this is what happened on .99: 5.9 GB box, 4.3 GB node). Options: raise the RAM and start again, or move the node with Migrate node." ;;
  "rpc_down")   log "verdict       : the local RPC does not answer at all" ;;
  recovery)     log "verdict       : the local store failed its checkpoint check - the node's own tool asks for recover.sh" ;;
  *)            log "verdict       : could not be classified from the evidence above" ;;
esac

printf 'NODE_DIAG state=%s head=%s network=%s behind=%s rpc=%s moved=%s enroll=%s rejoin=%s pm2=%s\n' \
  "${STATE}" "${HEAD2:-none}" "${NET_EPOCH:-none}" "${BEHIND:-none}" "${RPC_STATE}" "${MOVED}" \
  "${ENROLL:-none}" "$(printf '%s' "${REJOIN_LINE}" | sed -n 's/^status = \([a-z_]*\).*/\1/p')" \
  "${PROC_STATUS:-none}"

set_status DONE "state=${STATE} head=${HEAD2:-?} behind=${BEHIND:-?} enrollment=${ENROLL:-?} rpc=${RPC_STATE}"

printf '%s' "${REJOIN_LINE}" | grep -qi "recovery_required" && RECOVERY=1
