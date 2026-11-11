#!/usr/bin/env bash
# ===================================================================
# 20-upgrade.sh - update the node with the OFFICIAL tool
#
# The upstream README ("How to update (if you are already a validator)") names one
# command that monitors the repo, checks the packages, builds a fresh binary,
# restarts the node and waits until it is guaranteed to be operational:
#
#   sh controls/upgrade.sh            # test the mechanics, changes nothing
#   sh controls/upgrade.sh --apply    # do it
#
# This step runs the test first (the README recommends checking first), then the
# apply, and reads the verdict from what the tool prints:
#
#   validator_active | observer_synced  -> the node is online, the binary is the
#                                          one just built, the head is caught up
#   pending                             -> do NOT restart, the chain/build is not
#                                          ready yet: soft stop, re-run later
#   refused                             -> the reason is in the output (FAILED)
#
# It NEVER runs `--sync`, never touches config/network.env and never re-enrolls.
#
# Usage:  sudo bash 20-upgrade.sh
# Env:    UPGRADE_APPLY (1) - 0 = only the test run
#         UPGRADE_WAIT_SECONDS (900) - passed to --wait-seconds
#         UPGRADE_EXTRA - extra flags for the tool, e.g.
#                         "--public-commit <sha> --source-commit <sha>", or
#                         "--unit octra-node.service" / "--user-unit"
#         UPGRADE_TEST_TIMEOUT (1800) / UPGRADE_TIMEOUT (5400)
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
set_status RUNNING "upgrade"

APPLY="${UPGRADE_APPLY:-1}"
WAIT="${UPGRADE_WAIT_SECONDS:-900}"
EXTRA="${UPGRADE_EXTRA:-}"
TOOL_OUT="${UPGRADE_DIR}/upgrade-tool.out"

[[ -f "${UPGRADE_SH}" ]] || die "controls/upgrade.sh is missing on this node - use the manual update (fallback phase)"

ensure_tool git git || die "git is missing and could not be installed"
read_state
[[ "${PROCESS}" == "online" || -z "${PROCESS}" ]] || warn "the node process is ${PROCESS} - the tool will start/restart it"

BEFORE_COMMIT=$(source_commit)
BEFORE_HEAD=$(git_head)
log "=== update with the official tool: controls/upgrade.sh${EXTRA:+ ${EXTRA}} --wait-seconds ${WAIT} ==="
log "before : SOURCE_COMMIT=${BEFORE_COMMIT:-unknown} git HEAD=${BEFORE_HEAD:-unknown} role=${ROLE:-?} rpc=${RPC:-?}"
log "repository: $(git_remote)"
log "the node is NOT re-synced and NOT re-enrolled (upstream rule)"

: > "${TOOL_OUT}"

run_tool() {  # run_tool <timeout> <command...> -> streams into the console + the log, returns the tool's rc
  local limit="$1" rc=0
  shift
  set +e
  timeout "${limit}" su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && $*" 2>&1 \
    | tee -a "${TOOL_OUT}" | sed 's/^/    /'
  rc=${PIPESTATUS[0]}
  set -e
  return "${rc}"
}

# --- 1. the test run (changes nothing) ---------------------------------
log "--- test run: sh controls/upgrade.sh (nothing is rebuilt or restarted) ---"
TEST_RC=0
run_tool "${UPGRADE_TEST_TIMEOUT:-1800}" "sh controls/upgrade.sh" || TEST_RC=$?
TEST_VERDICT=$(upgrade_verdict "${TOOL_OUT}")
if (( TEST_RC != 0 )); then
  REASON=$(upgrade_reason "${TOOL_OUT}")
  if [[ "${TEST_VERDICT}" == "pending" ]]; then
    warn "the tool reports 'pending'${REASON:+ - ${REASON}}"
    warn "do NOT restart the node manually: re-run this phase once the tool can finish"
    set_status WAITING-UPGRADE "the test run is pending${REASON:+ - ${REASON}} - re-run the update later"
    exit 2
  fi
  die "the test run refused (exit ${TEST_RC})${REASON:+: ${REASON}} - nothing was changed; see the output above"
fi
log "the test run passed${TEST_VERDICT:+ (${TEST_VERDICT})}"

if [[ "${APPLY}" != "1" ]]; then
  log "UPGRADE_APPLY=0: test only - the node is untouched"
  set_status DONE "test-only (SOURCE_COMMIT=${BEFORE_COMMIT:-unknown})"
  exit 0
fi

# --- 2. apply -----------------------------------------------------------
# shellcheck disable=SC2086
ARGS="--apply --wait-seconds ${WAIT} ${EXTRA}"
log "--- apply: sh controls/upgrade.sh ${ARGS} (pull + build + restart + wait) ---"
APPLY_RC=0
run_tool "${UPGRADE_TIMEOUT:-5400}" "sh controls/upgrade.sh ${ARGS}" || APPLY_RC=$?
VERDICT=$(upgrade_verdict "${TOOL_OUT}")
REASON=$(upgrade_reason "${TOOL_OUT}")

case "${VERDICT}" in
  pending)
    warn "the tool reports 'pending'${REASON:+ - ${REASON}}"
    warn "do NOT restart the node manually (upstream) - re-run this phase later"
    set_status WAITING-UPGRADE "status pending${REASON:+ - ${REASON}} - re-run the update later"
    exit 2
    ;;
  refused)
    die "the tool refused the update${REASON:+: ${REASON}} - see the output above"
    ;;
esac

# --- 3. verify what is running now -------------------------------------
AFTER_COMMIT=$(source_commit)
AFTER_HEAD=$(git_head)
read_state
log "after  : SOURCE_COMMIT=${AFTER_COMMIT:-unknown} git HEAD=${AFTER_HEAD:-unknown} role=${ROLE:-?} process=${PROCESS:-?} rpc=${RPC:-?} voting=${VOTING:-?} epoch=${EPOCH:-?}"
log "binary : ${BINARY:-unknown}${PVAC:+ pvac ${PVAC}}"

if [[ "${PROCESS}" != "online" || "${RPC}" != "ready" ]]; then
  warn "the node is not back yet (process=${PROCESS:-?} rpc=${RPC:-?})"
  warn "check it with: su - ${NODE_USER} -c 'cd ${NODE_SRC_DIR} && sh controls/stat.sh --logs'"
  set_status WAITING-UPGRADE "the update ran but the node is not ready yet (process=${PROCESS:-?} rpc=${RPC:-?}) - re-run the update or read stat.sh --logs"
  exit 2
fi

if (( APPLY_RC != 0 )); then
  warn "the tool exited ${APPLY_RC} but the node is online as ${ROLE:-?}${VERDICT:+ (verdict ${VERDICT})}"
fi
if [[ -n "${AFTER_COMMIT}" && -n "${AFTER_HEAD}" && "${AFTER_COMMIT}" != "${AFTER_HEAD}" ]]; then
  warn "SOURCE_COMMIT (${AFTER_COMMIT}) does not match git HEAD (${AFTER_HEAD}) - check the checkout"
fi

if [[ -z "${VERDICT}" ]]; then
  if [[ "${ACTIVE}" == "true" ]]; then VERDICT="validator_active"; else VERDICT="observer_synced"; fi
fi
if [[ "${ACTIVE}" == "true" ]]; then
  log "=== the node is an ACTIVE validator again, running the binary it just built ==="
else
  log "=== the node is online and synced (observer) with the freshly built binary ==="
fi
set_status DONE "verdict=${VERDICT} commit=${AFTER_HEAD:-unknown} role=${ROLE:-?} active=${ACTIVE:-?} epoch=${EPOCH:-?}"
