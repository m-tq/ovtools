#!/usr/bin/env bash
# ===================================================================
# 20-install-toolchain.sh - build the Octra runtime (apt deps + OCaml + dune)
#
# Runs the project's own /root/install-deps.sh DETACHED as a systemd unit:
# it compiles for 15-30 minutes, and a dropped SSH must not kill it. The exit
# code lands in /root/deploy/octra-deploy-toolchain.rc, so re-running this step
# after a reconnect does not repeat a finished build.
#
# Usage:  sudo bash 20-install-toolchain.sh
# Env:    TOOLCHAIN_TIMEOUT (default 5400s)
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"

require_root
set_status RUNNING "install-toolchain"

# tools this step calls itself (install-deps.sh installs its own compiler deps)
ensure_tool git git || die "git is missing and could not be installed"
ensure_tool curl curl || die "curl is missing and could not be installed"
ensure_tool tar tar || die "tar is missing and could not be installed"

UNIT="octra-deploy-toolchain"
RC_FILE="${DEPLOY_DIR}/${UNIT}.rc"

# A cached "exit 0" is NOT proof the toolchain is usable: a failed
# `opam switch link` empties the switch prefix (opam 2.3, see config.sh) and the
# unit still reports success - 2026-11-02 the deploy then reported "toolchain
# ready" and the next step found no switch at all.
if unit_done "${UNIT}" && [[ "$(unit_rc ${UNIT})" == "0" ]]; then
  if ocaml_switch_built; then
    log "toolchain already installed (unit exit 0, OCaml switch present) - nothing to do"
    set_status DONE "install-toolchain" "cached"
    exit 0
  fi
  warn "the toolchain unit exited 0 but the OCaml switch is missing/incomplete"
  warn "  (opam 2.3 empties the switch when 'opam switch link' is called on an existing _opam)"
  drop_broken_ocaml_switch "${RC_FILE}"
  log "the stale result was dropped - rebuilding the runtime"
fi

if ! [[ -f /root/install-deps.sh ]]; then
  die "install-deps.sh is missing at /root/install-deps.sh - push the scripts first"
fi

if [[ "$(unit_active ${UNIT})" == "yes" ]]; then
  log "toolchain build already running (unit ${UNIT}) - re-attaching"
else
  log "=== building the runtime (install-deps.sh, 15-30 min on 4 cores) ==="
  # install.sh itself calls `opam switch link`: opam 2.3 dies on an existing
  # <repo>/_opam and empties the switch prefix, so clear both leftovers first
  # (drop_broken_ocaml_switch keeps a real switch untouched).
  drop_broken_ocaml_switch "${RC_FILE}"
  unlink_ocaml_switch_link "install.sh runs opam switch link next"
  unit_start "${UNIT}" "/root" \
    "DEBIAN_FRONTEND=noninteractive" "TERM=dumb" \
    -- "bash /root/install-deps.sh"
fi

unit_wait "${UNIT}" "${TOOLCHAIN_TIMEOUT:-5400}" "install-deps.sh (toolchain)" \
  "Cloning|Checking out|Building|Compiling|success|error" \
  || die "the toolchain build failed - see ${DEPLOY_DIR}/${UNIT}.log"

# --- proof the build is usable ---------------------------------------
if [[ ! -d "${NODE_SRC_DIR}/.git" ]]; then
  die "the node repository is missing at ${NODE_SRC_DIR}"
fi
if [[ ! -f "${NODE_SRC_DIR}/controls/check.sh" ]]; then
  die "controls/check.sh is missing - the repository looks incomplete"
fi
COMMIT=$(node_repo_commit)
BRANCH=$(node_repo_branch)
REPO_URL=$(node_repo_url)
if [[ -n "${COMMIT}" ]]; then
  log "repository: ${COMMIT}${BRANCH:+ on ${BRANCH}} -> ${NODE_SRC_DIR}${REPO_URL:+ (${REPO_URL})}"
else
  # never print a bare "unknown": name what is wrong and what git said instead
  REPO_ERR=$(node_repo_error)
  warn "repository: no readable commit at ${NODE_SRC_DIR}${REPO_ERR:+ - git said: ${REPO_ERR}}"
fi
# install-deps.sh can exit 0 while leaving no usable OCaml switch behind (the
# opam 2.3 `switch link` wipe). Drop the empty prefix and the cached result, so
# the NEXT run really rebuilds instead of reporting "already installed".
if ! assert_opam_switch; then
  warn "the build did not leave a usable OCaml switch - dropping the leftovers so the next run rebuilds"
  drop_broken_ocaml_switch "${RC_FILE}"
  set_status WAITING-BUILD "no usable OCaml switch - Start deploy again rebuilds the runtime"
  exit 2
fi
log "toolchain ready"
set_status DONE "install-toolchain"
