#!/usr/bin/env bash
# ===================================================================
# 03-pull-state.sh — copy the whole validator from OLD VPS to this one
#
#   pull 1 (initial) : while the old node is STILL RUNNING
#                      → whole-file mode (-W), fastest for a cold copy
#   pull 2 (final)   : after 04-stop-source.sh has stopped the old node
#                      → rolling-checksum delta, so only appended bytes
#                        of the live store suffixes are sent
#
# Usage (on the NEW vps):
#   OLD_HOST=203.0.113.27 bash 03-pull-state.sh            # initial
#   OLD_HOST=203.0.113.27 bash 03-pull-state.sh --final    # delta
#
# Copies:
#   /opt/octra/libv_litecore/   (source tree, toolchain, binaries, .keys)
#   /var/lib/octra/devnet/      (chain state, 39 GB)
#   /var/lib/octra/devnet.state_sync/
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
require_old_host
require_cmd rsync

MODE="initial"
[[ "${1:-}" == "--final" ]] && MODE="final"

RSYNC_OPTS=(-aH --numeric-ids --info=progress2 --stats --no-inc-recursive)
if [[ "${MODE}" == "initial" ]]; then
  RSYNC_OPTS+=(-W)
else
  # delta mode: list everything so appended store bytes are found quickly
  RSYNC_OPTS=(-aH --numeric-ids --info=progress2 --stats --delete --delete-delay)
fi

FREE_GB=$(df -BG --output=avail "${NODE_DATA_ROOT}" | tail -1 | tr -dc '0-9')
[[ "${FREE_GB}" -ge 60 ]] || die "not enough free space on ${NODE_DATA_ROOT} (${FREE_GB}G)"

# While the source node is RUNNING its logs/WAL/receipt files vanish under
# rsync's feet, which makes rsync exit 23/24. That is expected: the final
# delta pass (run with the source stopped) reconciles whatever moved.
RSYNC_TOLERANT=(23 24)
run_rsync() {  # run_rsync <label> <src> <dst>
  local label="$1" src="$2" dst="$3" rc=0
  log "--- ${label} ---"
  # rsync 3.5 prints one progress line per parallel transfer thread, which
  # produced multi-megabyte single-line log entries. Collapse each update to
  # its last "bytes  N%  rate" field and keep byte totals / warnings, so the
  # log stays readable while the orchestrator can still poll the percentage.
  # set +e / PIPESTATUS: grep returns 1 when nothing matches, and we must not
  # lose rsync's own exit code.
  set +e
  rsync "${RSYNC_OPTS[@]}" \
    -e "ssh ${SSH_OPTS[*]} -o Compression=no" \
    "${src}" "${dst}" 2>&1 \
    | tr '\r' '\n' \
    | grep -a --line-buffered -E '[0-9]+%|^sent |^total size|^rsync' \
    | sed -u -E 's/^.* ([0-9,]+ +[0-9]+% +[0-9.]+[kMG]?B\/s).*$/\1/'
  rc=${PIPESTATUS[0]}
  set -e
  if (( rc == 0 )); then
    return 0
  fi
  local tolerated=0
  for code in "${RSYNC_TOLERANT[@]}"; do
    [[ "${rc}" -eq "${code}" ]] && tolerated=1
  done
  if (( tolerated == 1 )); then
    warn "${label}: rsync exit ${rc} (files changed during the copy) — tolerated on a live node; the --final pass fixes it"
    return 0
  fi
  die "${label}: rsync failed with exit ${rc}"
}

set_status RUNNING "pull-${MODE}"
START=$(date +%s)
log "=== pull (${MODE}) from ${OLD_USER}@${OLD_HOST} ==="

run_rsync "1/3 source tree ${NODE_SRC_DIR}" \
  "${OLD_USER}@${OLD_HOST}:${NODE_SRC_DIR}/" "${NODE_SRC_DIR}/"

mkdir -p "${NODE_DATA_DIR}"
run_rsync "2/3 chain state ${NODE_DATA_DIR}" \
  "${OLD_USER}@${OLD_HOST}:${NODE_DATA_DIR}/" "${NODE_DATA_DIR}/"

mkdir -p "${NODE_SYNC_STAGE}"
if on_old "test -d ${NODE_SYNC_STAGE}"; then
  run_rsync "3/3 state-sync stage ${NODE_SYNC_STAGE}" \
    "${OLD_USER}@${OLD_HOST}:${NODE_SYNC_STAGE}/" "${NODE_SYNC_STAGE}/"
else
  warn "state-sync stage does not exist on the source — skipped"
fi

ELAPSED=$(( $(date +%s) - START ))
log "=== pull (${MODE}) finished in $((ELAPSED / 60))m$((ELAPSED % 60))s ==="
log "Local size: src $(du -sh "${NODE_SRC_DIR}" | awk '{print $1}'), data $(du -sh "${NODE_DATA_DIR}" | awk '{print $1}')"
log "Source size: $(on_old "du -sh ${NODE_SRC_DIR} ${NODE_DATA_DIR} 2>/dev/null | tr '\n' ' '")"

set_status DONE "pull-${MODE}" "${ELAPSED}s"
