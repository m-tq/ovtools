#!/usr/bin/env bash
# ===================================================================
# install-deps.sh — install system build dependencies for Octra lite_node
#
# Installs: git, ca-certificates, build-essential, GMP, SQLite3, libev,
#           Rust toolchain, OCaml/opam (via install.sh --source-build).
#
# Usage:  sudo bash install-deps.sh
# Idempotent — apt skips packages already installed.
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/config.sh"

if [[ $EUID -ne 0 ]]; then
  err "Run as root:  sudo bash $0"
  exit 1
fi

log "Updating package lists…"
apt-get update -qq

log "Installing base packages…"
apt-get install -y -qq \
  ca-certificates \
  git \
  curl \
  wget \
  build-essential \
  pkg-config \
  libgmp-dev \
  libsqlite3-dev \
  libev-dev \
  cmake \
  jq \
  htop \
  > /dev/null

log "Base packages installed"

# NOTE: Do NOT install Rust separately. The official install.sh
# --source-build installs a pinned Rust 1.88.0 toolchain into
# runtime_data/toolchains/ for the octra user. A separate rustup
# install in /root/.cargo causes permission conflicts.

# --- Create the octra system user --------------------------------
if ! id "${NODE_USER}" &>/dev/null; then
  log "Creating system user '${NODE_USER}'…"
  useradd -r -m -d "/home/${NODE_USER}" -s /bin/bash "${NODE_USER}"
  log "User '${NODE_USER}' created"
else
  log "User '${NODE_USER}' already exists"
fi

# --- Create the node source directory ------------------------------
log "Creating ${NODE_SRC_DIR}…"
mkdir -p "$(dirname "${NODE_SRC_DIR}")"
chown -R "${NODE_USER}:${NODE_USER}" "$(dirname "${NODE_SRC_DIR}")"

# --- Clone the lite_node repo (if not already present) ------------
if [[ ! -d "${NODE_SRC_DIR}/.git" ]]; then
  log "Cloning lite_node repository…"
  git clone --branch "${NODE_BRANCH}" --single-branch "${NODE_REPO}" "${NODE_SRC_DIR}"
  chown -R "${NODE_USER}:${NODE_USER}" "${NODE_SRC_DIR}"
  log "Repository cloned"
else
  log "Repository already present at ${NODE_SRC_DIR}"
fi

# --- Run the official install.sh --source-build -------------------
# install.sh calls `opam switch link` itself, and opam 2.3 wipes the switch when
# <repo>/_opam already exists (see config.sh) - so clear the link first.
unlink_ocaml_switch_link "install.sh runs opam switch link next"
# This installs OCaml, Dune, builds all dependencies from source
log "Running official install.sh --source-build (this compiles OCaml + deps)…"
log "This may take 15–30 minutes on a 4-core VPS…"

cd "${NODE_SRC_DIR}"
export OCTRA_OPERATOR_USER="${NODE_USER}"
export OCTRA_DATA_ROOT="${NODE_DATA_ROOT}"

sh controls/install.sh --source-build

# --- Verify the build ---------------------------------------------
log "Running check.sh to verify the build…"
if su - "${NODE_USER}" -c "cd ${NODE_SRC_DIR} && sh controls/check.sh"; then
  log "Build verification passed"
else
  warn "check.sh reported issues — review the output above"
fi

echo
log "Dependencies installed. Next: run node-setup.sh to configure the node."
