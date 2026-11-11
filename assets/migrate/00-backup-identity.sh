#!/usr/bin/env bash
# ===================================================================
# 00-backup-identity.sh — snapshot everything that cannot be recreated
#
# Run this on a node BEFORE anything destructive (migration switch, VM
# reinstall, disk swap). The archive is a few KB but it holds the only
# copy of the validator key that the bond is attached to.
#
# Contents:
#   .keys/validator/{wallet.json,enrollment.json,node.env,network.env}
#   devnet/{ready_to_vote.json,HEAD.json}
#   a stat.sh snapshot (context at backup time)
#
# Usage:
#   sudo bash 00-backup-identity.sh                 # → /root/migration/backups/
#   sudo bash 00-backup-identity.sh /root/safe      # custom destination
#
# Restore (on a freshly copied tree, same absolute paths):
#   tar xzf octra-identity-*.tar.gz -C /
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root

DEST="${1:-${MIG_DIR}/backups}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
HOST=$(hostname)
OUT="${DEST}/octra-identity-${HOST}-${STAMP}.tar.gz"

mkdir -p "${DEST}"

KEY_DIR="${NODE_SRC_DIR}/.keys/validator"
[[ -f "${KEY_DIR}/wallet.json" ]] || die "wallet.json not found at ${KEY_DIR} — is this the node host?"

REL=()
for f in wallet.json enrollment.json node.env network.env node.env.pre-migration.bak; do
  [[ -f "${KEY_DIR}/${f}" ]] && REL+=("${KEY_DIR#/}/${f}")
done
for f in ready_to_vote.json HEAD.json validator-control/last.json; do
  [[ -f "${NODE_DATA_DIR}/${f}" ]] && REL+=("${NODE_DATA_DIR#/}/${f}")
done
(( ${#REL[@]} > 0 )) || die "no identity files found to archive"

# context snapshot (node may be stopped — node_stat tolerates that)
node_stat > "${DEST}/stat-${HOST}-${STAMP}.txt" 2>/dev/null || true
if [[ -f "${KEY_DIR}/wallet.json" ]]; then
  {
    echo "host = ${HOST}"
    echo "taken_at = ${STAMP}"
    echo "address = $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["address"])' "${KEY_DIR}/wallet.json" 2>/dev/null || echo unknown)"
    echo "wallet_sha256 = $(sha256sum "${KEY_DIR}/wallet.json" | awk '{print $1}')"
  } > "${DEST}/identity-${HOST}-${STAMP}.txt"
fi

( cd / && tar czf "${OUT}" "${REL[@]}" )
chmod 600 "${OUT}"
sha256sum "${OUT}" | tee "${OUT}.sha256" >/dev/null

log "=== identity backup written ==="
log "archive : ${OUT} ($(du -h "${OUT}" | cut -f1))"
log "sha256  : $(awk '{print $1}' "${OUT}.sha256")"
log "files   :"
tar tzf "${OUT}" | sed 's/^/    /'

set_status DONE "backup-identity" "${OUT}"
