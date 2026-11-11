#!/usr/bin/env bash
# ===================================================================
# 30-manual-upgrade.sh - the documented MANUAL update (fallback)
#
# Upstream README, "Manual update (when the tool cannot run)":
#
#   sudo -iu octra
#   cd /opt/octra/libv_litecore
#   git pull --ff-only
#   cat SOURCE_COMMIT
#   sh controls/check.sh
#   SWITCH="$PWD/runtime_data/toolchains/ocaml"
#   make -C mcl MCL_FP_BIT=256 MCL_FR_BIT=256 lib/libmcl.a
#   opam exec --switch "$SWITCH" -- dune build --profile release \
#     bin/octra_node.exe bin/octra_pvac_worker.exe \
#     bin/octra_state_sync_client.exe bin/octra_state_sync_manifest.exe \
#     bin/bft_control_tx.exe
#   sh controls/stop.sh
#   sh controls/run.sh --rebind-runtime
#   sh controls/stat.sh
#
# Every command runs as the node user from the node directory (the checkout and
# the opam switch belong to it). This step NEVER runs `--sync`, never edits
# config/network.env and never re-enrolls - the node keeps its identity and its
# data, only the binary is replaced and the process restarted.
#
# Usage:  sudo bash 30-manual-upgrade.sh
# Env:    MANUAL_APPLY (1) - 0 = pull + check + build only (no stop/run)
#         PULL_TIMEOUT (600) / CHECK_TIMEOUT (300) / MAKE_TIMEOUT (1800)
#         BUILD_TIMEOUT (5400) / STOP_TIMEOUT (180) / RUN_TIMEOUT (900)
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
set_status RUNNING "manual-upgrade"

APPLY="${MANUAL_APPLY:-1}"
BUILD_LOG="${UPGRADE_DIR}/manual-build.out"

[[ -d "${NODE_SRC_DIR}/.git" ]] || die "${NODE_SRC_DIR} is not a git checkout - cannot pull"
[[ -f "${NODE_ENV}" ]] || die "node.env is missing (${NODE_ENV}) - this is not the node host"

ensure_build_tools

# the opam switch the toolchain step built (upstream: $PWD/runtime_data/toolchains/ocaml)
SWITCH="$(ocaml_switch_root 2>/dev/null || printf '%s' "${NODE_SRC_DIR}/runtime_data/toolchains/ocaml")"
[[ -d "${SWITCH}/_opam/.opam-switch" ]] || die "the opam switch is not built (${SWITCH}/_opam/.opam-switch missing) - run the toolchain step (scripts/deploy/20-install-toolchain.sh) first"

BEFORE_COMMIT=$(source_commit)
BEFORE_HEAD=$(git_head)
log "=== manual update on $(hostname) ==="
log "before : SOURCE_COMMIT=${BEFORE_COMMIT:-unknown} git HEAD=${BEFORE_HEAD:-unknown}"
log "opam switch: ${SWITCH}"
log "the node is NOT re-synced and NOT re-enrolled (upstream rule)"

run_as_node() {  # run_as_node <timeout> <label> <command...>
  local limit="$1" label="$2" rc=0
  shift 2
  log "--- ${label} ---"
  set +e
  timeout "${limit}" su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && $*" 2>&1 \
    | tee -a "${BUILD_LOG}" | sed 's/^/    /'
  rc=${PIPESTATUS[0]}
  set -e
  return "${rc}"
}

: > "${BUILD_LOG}"


# --- 1. pull + verify --------------------------------------------------
run_as_node "${PULL_TIMEOUT:-600}" "git pull --ff-only" "git pull --ff-only" \
  || die "git pull failed - see the output above (a dirty tree or a diverged branch stops here)"

AFTER_COMMIT=$(source_commit)
AFTER_HEAD=$(git_head)
log "after the pull: SOURCE_COMMIT=${AFTER_COMMIT:-unknown} git HEAD=${AFTER_HEAD:-unknown}"

if [[ -f "${CHECK_SH}" ]]; then
  run_as_node "${CHECK_TIMEOUT:-300}" "controls/check.sh (verify the package)" "sh controls/check.sh" \
    || die "controls/check.sh reported a problem - fix it before building"
else
  warn "controls/check.sh is missing - skipping the package verification"
fi

# --- 2. build ----------------------------------------------------------
run_as_node "${MAKE_TIMEOUT:-1800}" "make -C mcl (MCL_FP_BIT=256 MCL_FR_BIT=256)" \
  "make -C mcl MCL_FP_BIT=256 MCL_FR_BIT=256 lib/libmcl.a" \
  || die "the mcl library did not build - see the output above"

run_as_node "${BUILD_TIMEOUT:-5400}" "dune build --profile release (node + pvac + sync + bft)" \
  "opam exec --switch '${SWITCH}' -- dune build --profile release bin/octra_node.exe bin/octra_pvac_worker.exe bin/octra_state_sync_client.exe bin/octra_state_sync_manifest.exe bin/bft_control_tx.exe" \
  || die "the dune build failed - see the output above (the running node is untouched so far)"

log "the build finished - the node is still running the old binary"

if [[ "${APPLY}" != "1" ]]; then
  log "MANUAL_APPLY=0: build only - the node was not restarted"
  set_status DONE "build-only commit=${AFTER_HEAD:-unknown} (node still on the old binary)"
  exit 0
fi

# --- 3. restart on the fresh binary ------------------------------------
run_as_node "${STOP_TIMEOUT:-180}" "controls/stop.sh" "sh controls/stop.sh" \
  || die "controls/stop.sh failed - the node may still be running; check it before retrying"

run_as_node "${RUN_TIMEOUT:-900}" "controls/run.sh --rebind-runtime" "sh controls/run.sh --rebind-runtime" \
  || warn "controls/run.sh reported an error - checking the node state anyway"

read_state
log "node after the restart: role=${ROLE:-?} process=${PROCESS:-?} rpc=${RPC:-?} voting=${VOTING:-?} epoch=${EPOCH:-?}"
log "binary : ${BINARY:-unknown}${PVAC:+ pvac ${PVAC}}"

if [[ "${PROCESS}" != "online" ]]; then
  warn "the node process is ${PROCESS:-unknown} - the restart did not come up"
  warn "read the log: su - ${NODE_USER} -c 'cd ${NODE_SRC_DIR} && sh controls/stat.sh --logs'"
  set_status WAITING-UPGRADE "the manual build finished but the node is ${PROCESS:-unknown} - check stat.sh --logs"
  exit 2
fi
if [[ "${RPC}" != "ready" ]]; then
  warn "the node is online but its rpc is ${RPC:-unknown} - it is probably replaying; re-run to re-check"
  set_status WAITING-RPC "the node is online again but rpc=${RPC:-unknown} - re-run the manual update to re-check"
  exit 2
fi

log "=== the node is back on the freshly built binary ==="
set_status DONE "manual-upgrade commit=${AFTER_HEAD:-unknown} role=${ROLE:-?} active=${ACTIVE:-?} epoch=${EPOCH:-?}"
