#!/usr/bin/env bash
# ===================================================================
# 02-authorize-pull.sh — run ON THE OLD VPS
#
# Appends the NEW VPS root public key to root's authorized_keys so the
# target can rsync the node state directly from the source machine.
#
# Usage (on the OLD vps):
#   bash 02-authorize-pull.sh "ssh-ed25519 AAAA... octra-migration@onode"
#   bash 02-authorize-pull.sh /root/migration/target_ssh_key.pub
#
# Idempotent — the key is only added once.
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root

KEY_INPUT="${1:-${MIG_DIR}/target_ssh_key.pub}"
[[ -n "${KEY_INPUT}" ]] || die "usage: $0 <pubkey-line|pubkey-file>"

if [[ -f "${KEY_INPUT}" ]]; then
  PUBKEY=$(tr -d '\r\n' < "${KEY_INPUT}")
else
  PUBKEY=$(printf '%s' "${KEY_INPUT}" | tr -d '\r\n')
fi

[[ "${PUBKEY}" == ssh-* ]] || die "not a public key: ${PUBKEY:0:40}..."

install -d -m 700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

if grep -qxF "${PUBKEY}" /root/.ssh/authorized_keys; then
  log "Key already authorized — nothing to do"
else
  printf '%s\n' "${PUBKEY}" >> /root/.ssh/authorized_keys
  log "Key authorized for root"
fi

log "authorized_keys now holds $(wc -l < /root/.ssh/authorized_keys) key(s)"
set_status DONE "authorize-pull"
