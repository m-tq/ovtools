#!/usr/bin/env bash
# ===================================================================
# 70-promote.sh - switch an enrolled node from observer to validator
#
# The network admits a new validator only after the set fold (observed: ~64
# duty epochs). This step waits (bounded) for validator_active/validator_scheduled
# and then for the first duty epoch that actually activates the validator, and it
# applies the validator config and restarts the node when the node's own join has
# not done that already:
#
#   ROLE=validator node-setup.sh   (patches OCTRA_OPERATOR_ROLE / CONSENSUS_MODE)
#   node-start.sh                  (pm2 start)
#
# Usage:  sudo bash 70-promote.sh
# Env:    PROMOTE_WAIT_SEC (default 3600)         - wait for the set fold
#         PROMOTE_ACTIVE_WAIT_SEC (default 900)   - wait for validator_active=true
#         PROMOTE_PROGRESS_SEC (120) / STATUS_POLL (20) - progress line + poll interval
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
set_status RUNNING "promote"

ensure_tool curl  curl   || die "curl is missing and could not be installed"
ensure_tool jq    jq     || die "jq is missing and could not be installed"
ensure_tool pgrep psmisc || die "pgrep (psmisc) is missing and could not be installed"

[[ -f "${NODE_ENV}" ]] || die "node.env is missing - run the setup step first"
# both helpers live at /root when the toolkit pushed them; overridable so the
# step is testable without writing to /root
NODE_SETUP_SH="${NODE_SETUP_SH:-/root/node-setup.sh}"
NODE_START_SH="${NODE_START_SH:-/root/node-start.sh}"
[[ -f "${NODE_SETUP_SH}" && -f "${NODE_START_SH}" ]] || die "node-setup.sh/node-start.sh missing at /root"

JOIN_UNIT="${JOIN_UNIT:-octra-enroll-join}"
# how often the wait re-prints its progress line (and the network hint)
PROMOTE_PROGRESS_SEC="${PROMOTE_PROGRESS_SEC:-120}"

SNAP=$(node_stat)
ACTIVE=$(printf '%s\n' "${SNAP}" | stat_field validator_active)
SCHED=$(printf '%s\n' "${SNAP}" | stat_field validator_scheduled)
ENROLL=$(printf '%s\n' "${SNAP}" | stat_field validator_enrollment)
# the chain announces WHEN the validator is admitted and when it activated: the
# operator gets those epochs instead of a red error (2026-11-05)
NEXT_SET=$(printf '%s\n' "${SNAP}" | stat_field validator_next_set_epoch)
ACT_EPOCH=$(printf '%s\n' "${SNAP}" | stat_field validator_activation_epoch)

if [[ "${ACTIVE}" == "true" ]]; then
  log "this node is already an active validator (enrollment=${ENROLL}${ACT_EPOCH:+, activation epoch ${ACT_EPOCH}})"
else
  WAIT="${PROMOTE_WAIT_SEC:-3600}"
  DEADLINE=$(( $(date +%s) + WAIT ))
  START=$(date +%s)
  LAST=$START
  FIRST_EPOCH=""
  POLL="${STATUS_POLL:-20}"          # how often the state is re-read (tests shrink it)
  log "waiting for the set fold (active/scheduled) up to ${WAIT}s - enrollment=${ENROLL:-unknown}${NEXT_SET:+ - the chain schedules it for epoch ${NEXT_SET}}"
  if systemctl is-active --quiet "${JOIN_UNIT}" 2>/dev/null; then
    log "the node's own enrollment join is still running (unit ${JOIN_UNIT}) - it applies ROLE=validator itself"
    log "follow it with: journalctl -u ${JOIN_UNIT} -f"
  fi
  while (( $(date +%s) < DEADLINE )); do
    SNAP=$(node_stat)
    ACTIVE=$(printf '%s\n' "${SNAP}" | stat_field validator_active)
    SCHED=$(printf '%s\n' "${SNAP}" | stat_field validator_scheduled)
    EPOCH=$(printf '%s\n' "${SNAP}" | stat_field epoch)
    NEXT_SET=$(printf '%s\n' "${SNAP}" | stat_field validator_next_set_epoch)
    [[ -z "${FIRST_EPOCH}" && -n "${EPOCH}" ]] && FIRST_EPOCH="${EPOCH}"
    if [[ "${ACTIVE}" == "true" || "${SCHED}" == "true" ]]; then
      log "membership ready: active=${ACTIVE} scheduled=${SCHED} at epoch ${EPOCH}${NEXT_SET:+ (set fold epoch ${NEXT_SET})}"
      break
    fi
    if (( $(date +%s) - LAST >= PROMOTE_PROGRESS_SEC )); then
      # the fold is gated by the node's readiness post: say why when the
      # network refused it (that is what made a 2026-11-03 wait look endless)
      HINT=$(post_hint)
      log "  still waiting: $(( ($(date +%s) - START) / 60 ))m of $(( WAIT / 60 ))m, epoch +$(( ${EPOCH:-0} - ${FIRST_EPOCH:-0} )) since the wait began (enrollment=${ENROLL:-unknown}${NEXT_SET:+ - set fold at epoch ${NEXT_SET}})${HINT:+ - network said: ${HINT}}"
      LAST=$(date +%s)
    fi
    sleep "${POLL}"
  done
  if [[ "${ACTIVE}" != "true" && "${SCHED}" != "true" ]]; then
    HINT=$(post_hint)
    log "the fold has not admitted this validator yet${NEXT_SET:+ (the chain schedules it for epoch ${NEXT_SET})}${HINT:+ (the network refused the readiness post: ${HINT})} - it will on its own;"
    log "re-run this step (or leave it to the next console run) when the node is scheduled"
    set_status WAITING-FOLD "enrollment=${ENROLL:-unknown}${NEXT_SET:+ - set fold at epoch ${NEXT_SET}}${HINT:+ - ${HINT}} - re-run promote later"
    exit 2
  fi

  # The fold only SCHEDULES the validator: it starts voting in its first duty
  # epoch after that (2026-11-05: node .27 read scheduled=true at 00:12 and
  # validator_active=true at 00:17). Waiting for the activation here means the
  # verify that follows PASSes on its first sample instead of waiting for the
  # epoch itself - bounded, and a timeout is still a soft "run me again".
  if [[ "${ACTIVE}" != "true" ]]; then
    AW="${PROMOTE_ACTIVE_WAIT_SEC:-900}"
    if (( AW > 0 )); then
      log "waiting up to ${AW}s for the first duty epoch to activate the validator (validator_active=true)"
      ASTART=$(date +%s)
      ALAST=$ASTART
      while (( $(date +%s) - ASTART < AW )); do
        SNAP=$(node_stat)
        ACTIVE=$(printf '%s\n' "${SNAP}" | stat_field validator_active)
        SCHED=$(printf '%s\n' "${SNAP}" | stat_field validator_scheduled)
        VOTE_NOW=$(printf '%s\n' "${SNAP}" | stat_field voting)
        if [[ "${ACTIVE}" == "true" ]]; then
          log "the validator is ACTIVE (validator_active=true, voting=${VOTE_NOW:-?})"
          break
        fi
        if (( $(date +%s) - ALAST >= PROMOTE_PROGRESS_SEC )); then
          log "  still waiting for activation: $(( ($(date +%s) - ASTART) / 60 ))m of $(( AW / 60 ))m (active=${ACTIVE:-?} voting=${VOTE_NOW:-?})"
          ALAST=$(date +%s)
        fi
        sleep "${POLL}"
      done
    fi
  fi
fi

# The node's own `controls/enroll.sh join` switches the role as its last step
# (ROLE=validator, CONSENSUS_MODE=bft, controls/run.sh). Re-configuring here
# would restart a node that is already correct, so check before touching it.
ROLE_NOW=$(printf '%s\n' "$(node_stat)" | stat_field role)
MODE_NOW=$(grep -m1 '^OCTRA_CONSENSUS_MODE=' "${NODE_ENV}" 2>/dev/null | cut -d= -f2)
if [[ "${ROLE_NOW}" == "validator" && "${MODE_NOW}" == "bft" ]]; then
  log "role=${ROLE_NOW} and consensus mode=${MODE_NOW} are already set - nothing to reconfigure"
  # Say which of the three real states this is - "already validator" while
  # active=false was a false claim the console repeated (2026-11-05).
  if [[ "${ACTIVE}" == "true" ]]; then
    set_status DONE "active validator (validator_active=true scheduled=${SCHED:-?})"
  elif [[ "${SCHED}" == "true" ]]; then
    set_status DONE "scheduled for the set fold (validator_active=false) - verify waits for the duty epoch"
  else
    set_status DONE "role=validator configured (membership not active yet)"
  fi
  exit 0
fi

log "=== applying the validator configuration (role=${ROLE_NOW:-?} mode=${MODE_NOW:-?}) ==="
log "stopping the node (the role change must not race the running process)"
as_octra "cd ${NODE_SRC_DIR} && sh controls/stop.sh" 2>&1 | sed 's/^/    /' || warn "stop.sh reported an error"
sleep 3

ROLE=validator bash "${NODE_SETUP_SH}" 2>&1 | sed 's/^/    /' || die "node-setup.sh ROLE=validator failed"

log "starting the node as validator"
bash "${NODE_START_SH}" 2>&1 | sed 's/^/    /' || die "node-start.sh failed after the role change"

log "role now: $(grep -m1 '^OCTRA_OPERATOR_ROLE=' "${NODE_ENV}" | cut -d= -f2) / $(grep -m1 '^OCTRA_CONSENSUS_MODE=' "${NODE_ENV}" | cut -d= -f2)"
set_status DONE "promote"
