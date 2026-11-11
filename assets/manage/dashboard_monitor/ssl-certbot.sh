#!/usr/bin/env bash
# ===================================================================
# ssl-certbot.sh - Let's Encrypt certificate for the live monitor
#
# The nginx site always reads /etc/ssl/octra/{fullchain,privkey}.pem, so the
# Let's Encrypt files are linked there: certbot's own timer renews them and nginx
# keeps working without any config rewrite.
#
# Usage:  bash ssl-certbot.sh --domain node-x.example.com [--email you@x] [--min-days 30]
# Output: SSL_CERTBOT_OK <domain> (issued|reused)   /   SSL_CERTBOT_ERROR <why>
# Idempotent: a certificate that is still valid for --min-days is reused.
# ===================================================================
set -euo pipefail

DOMAIN=""; EMAIL=""; MIN_DAYS=30
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)   DOMAIN="${2:-}"; shift 2 ;;
    --email)    EMAIL="${2:-}"; shift 2 ;;
    --min-days) MIN_DAYS="${2:-30}"; shift 2 ;;
    *) shift ;;
  esac
done

fail() { echo "SSL_CERTBOT_ERROR $*"; exit 1; }

[[ -n "$DOMAIN" ]] || fail "no --domain given"
[[ $EUID -eq 0 ]] || fail "run as root"

LIVE="/etc/ssl/octra"
LE_LIVE="/etc/letsencrypt/live/${DOMAIN}"

# --- certbot present? check -> install -> continue -------------------
if ! command -v certbot >/dev/null 2>&1; then
  echo "installing certbot (apt)..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || fail "apt-get update failed"
  apt-get install -y -qq certbot >/dev/null || fail "could not install certbot"
fi

days_left() {  # days_left <pem>
  local file="$1" end now
  [[ -f "$file" ]] || { echo 0; return 0; }
  command -v openssl >/dev/null 2>&1 || { echo 0; return 0; }
  end=$(openssl x509 -enddate -noout -in "$file" 2>/dev/null | cut -d= -f2- || true)
  [[ -n "$end" ]] || { echo 0; return 0; }
  end=$(date -d "$end" +%s 2>/dev/null || echo 0)
  now=$(date +%s)
  [[ "$end" -gt "$now" ]] && echo $(( (end - now) / 86400 )) || echo 0
}

link_into_place() {
  install -d -m 700 "$LIVE"
  ln -sfn "${LE_LIVE}/fullchain.pem" "${LIVE}/fullchain.pem"
  ln -sfn "${LE_LIVE}/privkey.pem" "${LIVE}/privkey.pem"
  chmod 600 "${LE_LIVE}/privkey.pem" 2>/dev/null || true
}

# --- reuse a healthy certificate -------------------------------------
REUSE=0
if [[ -f "${LE_LIVE}/fullchain.pem" ]]; then
  left=$(days_left "${LE_LIVE}/fullchain.pem")
  if (( left >= MIN_DAYS )); then REUSE=1; fi
fi
if (( REUSE == 0 )); then
  # The standalone challenge needs port 80: stop nginx for the request and bring
  # it back even when certbot fails (a dead nginx would take the monitor down).
  was_active=0
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet nginx; then
    was_active=1
    systemctl stop nginx
  fi
  set +e
  if [[ -n "$EMAIL" ]]; then
    certbot certonly --standalone --non-interactive --agree-tos --expand \
      --keep-until-expiring -d "$DOMAIN" -m "$EMAIL"
    rc=$?
  else
    certbot certonly --standalone --non-interactive --agree-tos --expand \
      --keep-until-expiring -d "$DOMAIN" --register-unsafely-without-email
    rc=$?
  fi
  set -e
  if (( was_active == 1 )); then systemctl start nginx || true; fi
  (( rc == 0 )) || fail "certbot exit ${rc} - is DNS for ${DOMAIN} pointing at this host, and is port 80 open?"
fi

[[ -f "${LE_LIVE}/fullchain.pem" ]] || fail "certbot reported success but ${LE_LIVE}/fullchain.pem is missing"
link_into_place
echo "SSL_CERTBOT_OK ${DOMAIN} $([[ $REUSE -eq 1 ]] && echo reused || echo issued)"
