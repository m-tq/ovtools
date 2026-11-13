#!/usr/bin/env bash
# ===================================================================
# deploy-dashboard.sh — install / refresh the Octra live monitor
#
# Idempotent. Run from the VPS after pushing dashboard files:
#     bash /root/dashboard/deploy-dashboard.sh
#
# Steps
#   1. install nginx + python3 when missing
#   2. sync files into /opt/octra/dashboard
#   3. install + restart the systemd backend (port 9090)
#   4. install the nginx site and reload
#   5. verify /api/ping locally
# ===================================================================
set -euo pipefail

DASH_SRC="${DASH_SRC:-/root/dashboard}"
DASH_DIR="/opt/octra/dashboard"
SERVICE_NAME="octra-dashboard"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NGINX_SITE="/etc/nginx/sites-available/${SERVICE_NAME}"
NGINX_LINK="/etc/nginx/sites-enabled/${SERVICE_NAME}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[dashboard]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
die()  { echo -e "${RED}[err]${NC} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0"

# ── 1. Prerequisites ──────────────────────────────────────────────
log "Checking prerequisites…"
if ! command -v nginx >/dev/null 2>&1; then
  log "Installing nginx…"
  apt-get update -qq && apt-get install -y -qq nginx >/dev/null
fi
if ! command -v python3 >/dev/null 2>&1; then
  log "Installing python3…"
  apt-get update -qq && apt-get install -y -qq python3 >/dev/null
fi
log "nginx: $(nginx -v 2>&1 | cut -d/ -f2) · python: $(python3 --version 2>&1 | cut -d' ' -f2)"

# ── 2. Sync files ─────────────────────────────────────────────────
[[ -d "$DASH_SRC" ]] || die "source folder not found: $DASH_SRC"
log "Syncing $DASH_SRC → $DASH_DIR"
mkdir -p "$DASH_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude 'dev/' --exclude '__pycache__/' "$DASH_SRC"/ "$DASH_DIR"/
else
  find "$DASH_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -r "$DASH_SRC"/. "$DASH_DIR"/
  rm -rf "$DASH_DIR/dev" "$DASH_DIR/__pycache__"
fi

for f in index.html app.js styles.css server.py assets/css/synteq-ui.css assets/js/synteq-ui.js \
         prune-node-junk.sh octra-node-prune.cron octra-node-prune.service octra-node-prune.timer; do
  [[ -f "$DASH_DIR/$f" ]] || die "missing file: $DASH_DIR/$f"
done
log "Files verified"

chown -R root:root "$DASH_DIR"
find "$DASH_DIR" -type d -exec chmod 755 {} +
find "$DASH_DIR" -type f -exec chmod 644 {} +
chmod 755 "$DASH_DIR/server.py" 2>/dev/null || true

# ── 3. Backend service ────────────────────────────────────────────
log "Installing systemd unit ${SERVICE_NAME}…"
install -m 644 "$DASH_DIR/octra-dashboard.service" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"

for _ in $(seq 1 15); do
  if curl -fsS -m 2 http://127.0.0.1:9090/api/ping >/dev/null 2>&1; then break; fi
  sleep 1
done

if ! curl -fsS -m 3 http://127.0.0.1:9090/api/ping >/dev/null 2>&1; then
  warn "backend did not answer /api/ping"
  journalctl -u "$SERVICE_NAME" --no-pager -n 25 || true
  die "backend failed to start"
fi
log "Backend healthy on 127.0.0.1:9090"

# ── 3b. Wallet reward baseline ────────────────────────────────────
# Captured once (at setup) and kept across redeploys: it is the reference
# point for the wallet panel's reward cross-check. The log index itself is
# rebuilt incrementally by the backend, so this only ever runs once.
WALLET_STATE_DIR="/var/lib/octra/dashboard"
install -d -m 755 "$WALLET_STATE_DIR"
if [[ -f "$WALLET_STATE_DIR/wallet_state.json" ]]; then
  log "Wallet baseline already captured — keeping $WALLET_STATE_DIR/wallet_state.json"
else
  log "Capturing wallet reward baseline..."
  if ! python3 "$DASH_DIR/server.py" --init-wallet; then
    warn "wallet baseline not captured (node RPC offline?) — the backend retries on first poll"
  fi
fi

# ── 3c. Daily prune job (node logs & junk) ────────────────────────
# The monitor is the natural owner of this: it already runs on the node, and a
# growing operator log is what eventually starves the box (a 211 MB log with
# the node leaving it open). The program itself is policy-free enough to be
# safe: it only rotates/trims logs and removes junk, never chain data.
PRUNE_BIN="/usr/local/sbin/octra-node-prune"
PRUNE_CRON="/etc/cron.d/octra-node-prune"
PRUNE_LOG="/var/log/octra-node-prune.log"
PRUNE_UNIT="octra-node-prune.service"
PRUNE_TIMER="octra-node-prune.timer"

install -m 755 "$DASH_DIR/prune-node-junk.sh" "$PRUNE_BIN"
touch "$PRUNE_LOG" && chmod 644 "$PRUNE_LOG"
log "Prune program installed: $PRUNE_BIN"

# cron is the requested scheduler; a minimal Debian image may lack the
# package, so install it when apt is available and fall back to a systemd
# timer otherwise (same cadence, no extra package).
have_cron=0
if command -v cron >/dev/null 2>&1 || command -v crond >/dev/null 2>&1; then
  have_cron=1
elif command -v apt-get >/dev/null 2>&1; then
  log "Installing cron (scheduler for the daily prune)..."
  if DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cron >/dev/null 2>&1; then
    have_cron=1
  fi
fi

if [[ "$have_cron" -eq 1 ]]; then
  cron_changed=1
  [[ -f "$PRUNE_CRON" ]] && cmp -s "$DASH_DIR/octra-node-prune.cron" "$PRUNE_CRON" && cron_changed=0
  install -m 644 "$DASH_DIR/octra-node-prune.cron" "$PRUNE_CRON"
  # cron parses this as bytes: a stray CR (Windows checkout) makes it reject
  # the whole file with "bad minute", silently skipping every run.
  sed -i 's/\r$//' "$PRUNE_CRON"
  chown root:root "$PRUNE_CRON"
  chmod 644 "$PRUNE_CRON"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now "$PRUNE_TIMER" >/dev/null 2>&1 || true
    systemctl enable --now cron >/dev/null 2>&1 || systemctl enable --now crond >/dev/null 2>&1 || true
  fi
  rm -f "/etc/systemd/system/$PRUNE_UNIT" "/etc/systemd/system/$PRUNE_TIMER"
  log "Daily prune scheduled via cron: $PRUNE_CRON (03:40)"
  # cron re-reads /etc/cron.d once a minute and logs "bad minute" when a file
  # is malformed (CRLF, non-ASCII, bad fields) - it then ignores the file
  # silently. Prove it was accepted instead of trusting the exit code.
  if [[ "$cron_changed" -eq 1 ]] && command -v journalctl >/dev/null 2>&1; then
    log "Waiting for cron to re-read the schedule (~60s)..."
    sleep 62
    if journalctl -u cron --since '-2 min' --no-pager 2>/dev/null | grep -qi 'bad minute.*octra-node-prune'; then
      warn "cron REJECTED $PRUNE_CRON ('bad minute') - the daily prune will not run"
    else
      log "cron accepted $PRUNE_CRON"
    fi
  fi
else
  install -m 644 "$DASH_DIR/$PRUNE_UNIT" "/etc/systemd/system/$PRUNE_UNIT"
  install -m 644 "$DASH_DIR/$PRUNE_TIMER" "/etc/systemd/system/$PRUNE_TIMER"
  sed -i 's/\r$//' "/etc/systemd/system/$PRUNE_UNIT" "/etc/systemd/system/$PRUNE_TIMER"
  systemctl daemon-reload
  systemctl enable --now "$PRUNE_TIMER" >/dev/null 2>&1 \
    || warn "could not enable $PRUNE_TIMER (run: systemctl enable --now $PRUNE_TIMER)"
  rm -f "$PRUNE_CRON"
  log "Daily prune scheduled via systemd timer: $PRUNE_TIMER (03:40)"
fi

# Prove the program runs on this box before the first scheduled night:
# a dry run only reads and reports.
if "$PRUNE_BIN" --dry-run >/tmp/octra-prune-dryrun.txt 2>&1; then
  log "Prune dry-run OK ($(grep -c . /tmp/octra-prune-dryrun.txt) line(s), see $PRUNE_LOG)"
else
  warn "prune dry-run failed - check 'octra-node-prune --status' (nothing was deleted)"
fi
rm -f /tmp/octra-prune-dryrun.txt
if [[ -x "$PRUNE_BIN" ]]; then
  "$PRUNE_BIN" --status 2>/dev/null | sed -n '1,6p' | sed 's/^/[prune] /'
fi

# ── 4. Nginx ──────────────────────────────────────────────────────
log "Applying nginx site..."
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
rm -f /etc/nginx/sites-enabled/octra-dashboard-old 2>/dev/null || true

# The checked-in site file carries one default server_name, but every VPS is
# published under its own subdomain. Remember the host that is already live
# here, install the fresh file, then point it back at that host and strip CRLF
# (a Windows checkout can leave it behind, which breaks the awk match below).
#
# NOTE: on a FRESH host $NGINX_SITE does not exist yet, so awk exits 2. With
# `set -euo pipefail` that aborted the whole deploy before the site was even
# installed — `|| true` keeps the first-install path working.
existing_name=$(awk '/^[[:space:]]*server_name/ {gsub(/;/,"");print $2; exit}' "$NGINX_SITE" 2>/dev/null | tr -d '\r' || true)
source_name=$(awk '/^[[:space:]]*server_name/ {gsub(/;/,"");print $2; exit}' "$DASH_DIR/nginx-octra.conf" 2>/dev/null | tr -d '\r' || true)

install -m 644 "$DASH_DIR/nginx-octra.conf" "$NGINX_SITE"
sed -i 's/\r$//' "$NGINX_SITE"
ln -sfn "$NGINX_SITE" "$NGINX_LINK"

if [[ -n "$existing_name" && -n "$source_name" && "$existing_name" != "$source_name" ]]; then
  log "Keeping this host's server_name: $existing_name"
  sed -i "s|${source_name}|${existing_name}|g" "$NGINX_SITE"
  sed -i "s|^# Domain  : .*|# Domain  : ${existing_name}   (edit server_name to your domain)|" "$NGINX_SITE"
fi

if ! nginx -t 2>&1; then
  die "nginx config test failed"
fi
systemctl reload nginx
log "nginx reloaded"

# ── 5. Report ──────────────────────────────────────────────────────
# The live host name is what nginx actually serves, not a placeholder: the report
# used to print `https://<server_name>/` as if the deploy had failed to fill it in
# (2026-11-04 operator report).
live_name=$(awk '/^[[:space:]]*server_name/ {gsub(/;/,"");print $2; exit}' "$NGINX_SITE" 2>/dev/null | tr -d '\r' || true)
if [[ -z "$live_name" ]]; then
  live_name="$(hostname 2>/dev/null || echo localhost)"
fi
echo
log "Live monitor deployed"
echo "  UI        : https://${live_name}/"
echo "  API       : https://${live_name}/api/status"
echo "  Backend   : systemctl status ${SERVICE_NAME}"
echo "  Logs      : journalctl -u ${SERVICE_NAME} -f"
echo "  Nginx log : tail -f /var/log/nginx/error.log"
if [[ -f "$PRUNE_CRON" ]]; then
  echo "  Prune     : daily 03:40 via cron ($PRUNE_CRON)"
elif [[ -f "/etc/systemd/system/$PRUNE_TIMER" ]]; then
  echo "  Prune     : daily 03:40 via systemd timer ($PRUNE_TIMER)"
fi
echo "  Prune log : ${PRUNE_LOG}  ·  status: octra-node-prune --status  ·  dry-run: --dry-run"
