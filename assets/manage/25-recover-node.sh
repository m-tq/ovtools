#!/usr/bin/env bash
# ===================================================================
# 25-recover-node.sh - the solved path for a node stuck "ready / outside set"
#
# Every action is one the node's own tooling recommends; nothing is forced:
#
#   1. diagnose (the same evidence 10-diagnose-node.sh prints),
#   2. clean restart when the node is frozen or /status times out
#      (`pm2 save` + `pm2 restart`) - a fresh session re-handshakes peers and asks
#      the state-sync source for a new range, which is what unblocks catch-up,
#   3. `pm2 save` + `pm2 kill` + `pm2 resurrect` when the node's own tool refuses
#      with "data directory is used outside PM2" (the pm2 entry and the running
#      process disagree about the owner, so rejoin.sh cannot run at all),
#   4. wait (bounded) for head_epoch to move and the lag to shrink. If the
#      state-sync source keeps answering `503 state_sync_range_busy` the step
#      reports WAITING-SYNC with the quoted reason - it never "fixes" it by hand,
#   5. once in sync: `rejoin.sh --check`, then `--meet-stage` only when the tool
#      itself says the round is behind (`round_lagging`/`not_ready_to_vote`),
#   6. re-publish readiness (`enroll.sh join`, idempotent: the bond already exists)
#      when enrollment is ready/bonded but the set has not picked it up,
#   7. verdict: DONE active / DONE scheduled / WAITING-FOLD (with the epoch) /
#      WAITING-SYNC / FAILED (the tool's own words).
#
# Nothing here signs a new bond, exits, or replaces the store: `recover.sh
# --replace-state` is only ever *reported* as the next step when the tool asks.
#
# Usage:  sudo bash 25-recover-node.sh
# Env:    SYNC_WAIT=<sec>       how long catch-up may take before WAITING-SYNC (900)
#         SYNC_MIN=<epochs>     head must advance at least this much (3)
#         SYNC_LAG_MAX=<epochs> lag that counts as "in sync" (5)
#         FOLD_WAIT=<sec>       wait for scheduled/active after the rejoin (300)
#         PROGRESS_SEC=<sec>    progress line interval (60)
#         ALLOW_RESTART=0       report what would be done, restart nothing
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
set_status RUNNING "recover-node"

ensure_tool jq jq || die "jq is missing and could not be installed"
ensure_tool curl curl || die "curl is missing and could not be installed"
[[ -f "${NODE_ENV}" ]] || die "node.env is missing (${NODE_ENV}) - is this the validator host?"
[[ -f "${NODE_WALLET}" ]] || die "wallet.json is missing (${NODE_WALLET})"

SYNC_WAIT="${SYNC_WAIT:-900}"
SYNC_MIN="${SYNC_MIN:-3}"
LAG_MAX="${SYNC_LAG_MAX:-5}"
FOLD_WAIT="${FOLD_WAIT:-300}"
ALLOW_RESTART="${ALLOW_RESTART:-1}"
POLL="${STATUS_POLL:-20}"

WALLET=$(wallet_address || echo unknown)
log "=== recover ${WALLET} on $(hostname) ==="

# --- helpers ------------------------------------------------------------
rpc_up() { [[ "$(head_epoch)" =~ ^[0-9]+$ ]]; }

wait_rpc() {  # wait_rpc <seconds>
  local limit="$1" start now
  start=$(date +%s)
  while :; do
    rpc_up && return 0
    now=$(date +%s)
    (( now - start >= limit )) && return 1
    sleep 5
  done
}

pm2_as() { su - "${NODE_USER}" -c "pm2 $*" 2>&1 | sed 's/^/    /'; }

busy_join() { pgrep -af "enroll.sh[ ]join" >/dev/null 2>&1; }

# --- 0. never fight another enrollment ---------------------------------
if busy_join; then
  warn "a join is running right now - not touching the node"
  set_status WAITING-BUSY "a join/enroll is already running; re-run when it finishes"
  exit 2
fi

# --- 1. diagnose -------------------------------------------------------
ENROLL=$(rpc_field octra_validatorEnrollment '[]' state)
HEAD=$(head_epoch)
CODE=$(status_code)
log "before        : enrollment=${ENROLL:-?} head=${HEAD:-?} /status=HTTP ${CODE:-000} pm2=$(pm2_state)"

REJOIN=$(node_script 180 "sh controls/rejoin.sh --check" || true)
REJOIN_LINE=$(printf '%s\n' "${REJOIN}" | grep -aE '^status = ' | tail -1 || true)
log "rejoin        : ${REJOIN_LINE:-<no status line>}"
if printf '%s' "${REJOIN_LINE}" | grep -qi "recovery_required"; then
  die "the local store failed its checkpoint check - run: sh controls/recover.sh --replace-state (nothing was changed here)"
fi

MISMATCH=0
printf '%s' "${REJOIN_LINE}" | grep -qi "used outside PM2" && MISMATCH=1
# The tool could not even produce a verdict (the RPC is down): re-creating the pm2
# session is the safest single action then - it re-applies the env from the dump and
# gives the node a fresh start, which is also what the "outside PM2" case needs.
if [[ -z "${REJOIN_LINE}" ]] && ! rpc_up; then
  MISMATCH=1
  warn "rejoin.sh could not reach a verdict (the node does not answer its RPC) - re-creating the pm2 session"
fi

# already fine?
if printf '%s' "${REJOIN_LINE}" | grep -q "validator_active"; then
  log "this node is already the ACTIVE validator - nothing to recover"
  set_status DONE "already active (nothing to do)"
  echo "RECOVER state=active head=${HEAD:-none}"
  exit 0

# --- 2/3. the two things that actually need a restart -------------------
RESTARTED=0
if (( MISMATCH )); then
  if (( ALLOW_RESTART )); then
    warn "the data directory is 'used outside PM2' (or the RPC is gone): the pm2 session has to be re-created"
    # `pm2 kill` is NOT used here: it kills the daemon that systemd supervises, so
    # pm2-octra.service ends up 'failed' while the (hung) node keeps running - that
    # is exactly what happened on .99 (2026-11-06). systemd does stop/start, and a
    # node that ignores SIGTERM is reaped by exact process name.
    log "re-creating the pm2 session through systemd (stop -> reap -> start); the node restarts from its own dump"
    systemctl stop pm2-octra 2>/dev/null || true
    systemctl reset-failed pm2-octra 2>/dev/null || true
    sleep 3
    for p in $(pgrep -x octra_node.exe 2>/dev/null || true); do
      warn "the previous node (pid ${p}) survived the stop - sending SIGKILL"
      kill -9 "${p}" 2>/dev/null || true
    done
    sleep 3
    systemctl start pm2-octra 2>/dev/null || warn "systemctl start pm2-octra failed - check: systemctl status pm2-octra"
    sleep 5
    log "pm2-octra     : $(systemctl is-active pm2-octra 2>/dev/null || echo unknown)"
    RESTARTED=1
  else
    warn "would re-create the pm2 session (ALLOW_RESTART=0) - the node's own tools cannot run until it is done"
  fi
elif [[ "${CODE}" != "200" || -z "${HEAD:-}" ]]; then
  if (( ALLOW_RESTART )); then
    warn "the node is not answering its own RPC properly (/status HTTP ${CODE:-000}) - one clean restart"
    pm2_as save >/dev/null 2>&1 || true
    pm2_as restart "$(pm2_name)" || true
    RESTARTED=1
  fi
fi

if (( RESTARTED )); then
  # opening a 38 GB store takes minutes: 180 s was too optimistic on .99
  if wait_rpc "${RPC_WAIT:-600}"; then
    log "the node answers again: head=$(head_epoch) (pid $(pm2_state | awk '{print $3}'))"
  else
    warn "the RPC did not come back within ${RPC_WAIT:-600}s after the restart"
    MEM_TOTAL=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
    NODE_PID=$(pgrep -x octra_node.exe 2>/dev/null | head -1 || true)
    NODE_RSS=""
    [[ -n "${NODE_PID}" ]] && NODE_RSS=$(awk '/VmRSS/ {printf "%d", $2/1024}' "/proc/${NODE_PID}/status" 2>/dev/null || true)
    warn "the process is up (pid ${NODE_PID:-none}, ${NODE_RSS:-?} MB RSS) on a ${MEM_TOTAL:-?} MB VM"
    if (( ${MEM_TOTAL:-0} > 0 && MEM_TOTAL < 7600 )); then
      warn "the store needs ~8 GB of RAM (16 comfortable): on this VM the node cannot finish opening it -"
      warn "raise the RAM and start it again, or move the node with the Migrate node program"
      set_status WAITING-STARTUP "the node cannot finish starting on a ${MEM_TOTAL} MB VM (needs ~8 GB) - raise the RAM or migrate"
    else
      warn "opening the store can take longer on a slow disk - re-run this step in a few minutes"
      set_status WAITING-RPC "restarted, the local RPC is still silent - it may still be opening the store"
    fi
    echo "RECOVER state=restarted_no_rpc head=none"
    exit 2
  fi
fi

# --- 4. catch-up: the real gate ----------------------------------------
START=$(date +%s)
LAST=${START}
FIRST=$(head_epoch)
FIRST="${FIRST:-0}"
BEST_LAG=""
VERDICT=""
while :; do
  NOW_HEAD=$(head_epoch)
  NET=$(network_epoch)
  LAG=""
  if [[ "${NOW_HEAD}" =~ ^[0-9]+$ && "${NET}" =~ ^[0-9]+$ ]]; then
    LAG=$(( NET - NOW_HEAD ))
    (( LAG < 0 )) && LAG=0
    BEST_LAG="${LAG}"
  fi
  MOVED=$(( ${NOW_HEAD:-0} - FIRST ))
  # in sync = head moved at least SYNC_MIN epochs and the lag is within LAG_MAX
  if (( MOVED >= SYNC_MIN )) && [[ -n "${LAG}" ]] && (( LAG <= LAG_MAX )); then
    VERDICT="synced"
    break
  fi
  ELAPSED=$(( $(date +%s) - START ))
  if (( ELAPSED >= SYNC_WAIT )); then
    VERDICT="sync-timeout"
    break
  fi
  if (( $(date +%s) - LAST >= PROGRESS_SEC )); then
    REASON=$(catchup_reason)
    log "  catch-up: head ${NOW_HEAD:-?} -> network ${NET:-?} (lag ${LAG:-?}, moved ${MOVED}/${SYNC_MIN})$([[ -n "${REASON}" ]] && echo " - ${REASON}")"
    LAST=$(date +%s)
  fi
  sleep "${POLL}"
done

if [[ "${VERDICT}" == "sync-timeout" ]]; then
  REASON=$(catchup_reason)
  warn "the node is still behind after ${SYNC_WAIT}s (head ${NOW_HEAD:-?}, network ${NET:-?}, lag ${LAG:-?})"
  [[ -n "${REASON}" ]] && warn "the last catch-up attempt said: ${REASON}"
  warn "the node retries by itself - nothing was forced; re-run this step later"
  set_status WAITING-SYNC "catch-up did not finish in ${SYNC_WAIT}s (lag ${LAG:-?}${REASON:+; ${REASON}})"
  echo "RECOVER state=syncing head=${NOW_HEAD:-none} behind=${LAG:-none}"
  exit 2
fi
log "in sync: head ${NOW_HEAD:-?} (lag ${BEST_LAG:-?}) - the set logic can run now"


# --- 5. the node's own rejoin path -------------------------------------
REJOIN=$(node_script 300 "sh controls/rejoin.sh --check" || true)
REJOIN_LINE=$(printf '%s\n' "${REJOIN}" | grep -aE '^status = ' | tail -1 || true)
log "rejoin        : ${REJOIN_LINE:-<no status line>}"
REJOIN_STATE=$(printf '%s' "${REJOIN_LINE}" | sed -n 's/^status = \([a-z_]*\).*/\1/p')

if [[ "${REJOIN_STATE}" == "validator_active" ]]; then
  set_status DONE "back in the set: validator_active"
  echo "RECOVER state=active head=${NOW_HEAD:-none}"
  exit 0
fi
if [[ "${REJOIN_STATE}" == "validator_scheduled" ]]; then
  set_status WAITING-FOLD "admitted to the next set - waiting for the fold ($(post_hint))"
  echo "RECOVER state=scheduled head=${NOW_HEAD:-none}"
  exit 2
fi
if printf '%s' "${REJOIN_LINE}" | grep -qi "used outside PM2"; then
  die "the node still reports 'data directory is used outside PM2' - pm2 was not re-created (ALLOW_RESTART=${ALLOW_RESTART})"
fi

# the round is behind / readiness is stale: --meet-stage is the tool's own fix and
# it does not stop the node (only --meet-start would, and that needs a stop)
if printf '%s' "${REJOIN_LINE}" | grep -qE "round_lagging|round_unobserved|round_unconfirmed|not_ready_to_vote"; then
  warn "the tool says the round/readiness is stale (${REJOIN_STATE}) - staging a rejoin (rejoin.sh --meet-stage)"
  OUT=$(node_script 600 "sh controls/rejoin.sh --meet-stage" || true)
  printf '%s\n' "${OUT}" | grep -aE '^(status|event|round) = ' | sed 's/^/    /' || true
  STAGE_STATE=$(printf '%s\n' "${OUT}" | grep -aE '^status = ' | tail -1 | sed -n 's/^status = \([a-z_]*\).*/\1/p' || true)
  log "meet-stage    : ${STAGE_STATE:-<no status line>}"
  case "${STAGE_STATE}" in
    "meet_staged")
      log "the rejoin is staged - the node asks for a round when it is ready (no restart, no exit)" ;;
    "refused")
      warn "rejoin refused: $(printf '%s\n' "${OUT}" | grep -aE '^status = ' | tail -1)" ;;
    *) : ;;
  esac
fi

# --- 6. re-publish readiness (idempotent: the bond is already on chain) --
ENROLL=$(rpc_field octra_validatorEnrollment '[]' state)
if [[ "${ENROLL}" == "bonded" ]]; then
  log "enrollment is 'bonded' without readiness - publishing it again (enroll.sh join)"
  OUT=$(node_script 900 "sh controls/enroll.sh join" || true)
  printf '%s\n' "${OUT}" | grep -aE '^(event|status) = ' | tail -6 | sed 's/^/    /' || true
elif [[ "${ENROLL}" == "ready" ]]; then
  log "enrollment is 'ready' - the bond and the readiness are on chain; only the set fold is missing"
fi

# --- 7. wait for the fold ----------------------------------------------
START=$(date +%s)
LAST=${START}
while :; do
  OUT=$(node_script 180 "sh controls/rejoin.sh --check" || true)
  LINE=$(printf '%s\n' "${OUT}" | grep -aE '^status = ' | tail -1 || true)
  STATE=$(printf '%s' "${LINE}" | sed -n 's/^status = \([a-z_]*\).*/\1/p')
  if [[ "${STATE}" == "validator_active" ]]; then
    log "back in the set: $(rpc_field octra_validatorEnrollment '[]' head_epoch)"
    set_status DONE "back in the set: validator_active (rejoin=${STATE})"
    echo "RECOVER state=active head=$(head_epoch)"
    exit 0
  fi
  if (( $(date +%s) - START >= FOLD_WAIT )); then
    warn "the node is in sync but the set has not admitted it yet (${LINE:-no status})"
    warn "this is a chain event now - the console keeps watching and reports the activation"
    set_status WAITING-FOLD "in sync, waiting for the set fold (${STATE:-unknown})"
    echo "RECOVER state=waiting_fold head=$(head_epoch)"
    exit 2
  fi
  if (( $(date +%s) - LAST >= PROGRESS_SEC )); then
    log "  waiting for the fold: ${LINE:-no status} ($(post_hint))"
    LAST=$(date +%s)
  fi
  sleep "${POLL}"
done

fi
