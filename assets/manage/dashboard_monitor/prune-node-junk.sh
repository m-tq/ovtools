#!/usr/bin/env bash
# ===================================================================
# octra-node-prune — daily cleanup of node-generated junk
#
# Installed as /usr/local/sbin/octra-node-prune by
# dashboard/deploy-dashboard.sh and scheduled once a day (cron, or a
# systemd timer on hosts without cron).
#
# What it prunes (safe, node-scoped):
#   • the pm2 operator log  <node>/data/operator_logs/node.log
#     (rotated with copy-truncate once it exceeds OCTRA_NODE_LOG_MAX_MB;
#      the node keeps its file handle, the dashboard re-indexes itself)
#   • rotated copies older than OCTRA_PRUNE_KEEP_DAYS
#   • the pm2 daemon log, core dumps, dashboard __pycache__ / stale *.tmp
#   • old systemd journal entries (kept OCTRA_PRUNE_JOURNAL_DAYS days)
#   • the preserved states of the previous epochs:
#       node/controls/storage.sh --prune-prior --yes
#     (the upstream README's "Remove preserved states"; the node keeps the current
#      state and rebuilds what a lagging peer needs, so this only frees disk)
#   • its own log file (trimmed to the last 2000 lines)
#
# What it NEVER touches: irmin_store, chaindata, pvac, vote_log,
# commit_journal.log, finality/state-sync data, .keys, node.env.
#
# Usage
#   octra-node-prune                # prune now
#   octra-node-prune --dry-run      # report only, change nothing
#   octra-node-prune --status       # show the schedule + last runs
# ===================================================================
set -uo pipefail

VERSION="1.0"
NODE_HOME="${OCTRA_NODE_HOME:-/opt/octra/libv_litecore}"
NODE_LOG="${OCTRA_NODE_LOG:-$NODE_HOME/data/operator_logs/node.log}"
NODE_LOG_DIR="$(dirname "$NODE_LOG")"
NODE_LOG_MAX_MB="${OCTRA_NODE_LOG_MAX_MB:-200}"
KEEP_DAYS="${OCTRA_PRUNE_KEEP_DAYS:-7}"
KEEP_ROTATIONS="${OCTRA_PRUNE_KEEP_ROTATIONS:-2}"
JOURNAL_DAYS="${OCTRA_PRUNE_JOURNAL_DAYS:-7}"
DASH_DIR="${OCTRA_DASH_DIR:-/opt/octra/dashboard}"
PM2_LOG="${OCTRA_PM2_LOG:-/home/octra/.pm2/pm2.log}"
PM2_LOG_MAX_MB="${OCTRA_PM2_LOG_MAX_MB:-20}"
PRUNE_LOG="${OCTRA_PRUNE_LOG:-/var/log/octra-node-prune.log}"
LOCK_FILE="${OCTRA_PRUNE_LOCK:-/run/octra-node-prune.lock}"
DATA_ROOT="${OCTRA_DATA_ROOT:-/var/lib/octra}"
CRON_FILE="/etc/cron.d/octra-node-prune"
TIMER_FILE="/etc/systemd/system/octra-node-prune.timer"

DRY_RUN=0
STATUS_ONLY=0
QUIET=0
# the node's own storage tool (upstream README: "Remove preserved states")
STORAGE_TOOL="${OCTRA_STORAGE_TOOL:-$NODE_HOME/controls/storage.sh}"
STORAGE_TIMEOUT="${OCTRA_STORAGE_TIMEOUT:-900}"
NODE_USER="${OCTRA_NODE_USER:-octra}"

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --status)  STATUS_ONLY=1 ;;
    -q|--quiet) QUIET=1 ;;
    -h|--help) usage ;;
    -V|--version) echo "octra-node-prune $VERSION"; exit 0 ;;
    *) echo "octra-node-prune: unknown argument '$arg' (try --help)" >&2; exit 2 ;;
  esac
done

say() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  if [ -w "$(dirname "$PRUNE_LOG")" ] 2>/dev/null; then
    printf '%s\n' "$line" >>"$PRUNE_LOG" 2>/dev/null || true
  fi
  [ "$QUIET" -eq 1 ] || printf '%s\n' "$line"
}

human() {
  awk -v b="${1:-0}" 'BEGIN{
    split("B KB MB GB TB", unit, " ");
    i = 1;
    while (b >= 1024 && i < 5) { b = b / 1024; i++ }
    printf "%.1f %s", b, unit[i]
  }'
}

size_of() { stat -c %s "$1" 2>/dev/null || echo 0; }

free_bytes() {
  df -B1 --output=avail "$NODE_LOG_DIR" 2>/dev/null | tail -1 | tr -d ' ' || echo 0
}

rotate_log() {
  local path="$1" max_mb="$2" label="$3"
  [ -f "$path" ] || return 0
  local bytes mb stamp rotated
  bytes=$(size_of "$path")
  mb=$(( bytes / 1024 / 1024 ))
  if [ "$mb" -lt "$max_mb" ]; then
    say "keep     $label: $(human "$bytes") (limit ${max_mb} MB)"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    say "would rotate $label: $(human "$bytes") >= ${max_mb} MB"
    return 0
  fi
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  rotated="$path.$stamp"
  # copy-truncate: the node (via pm2) holds this file open in append mode, so
  # the content is copied aside and the live file is truncated in place - the
  # writer keeps working and the dashboard notices the truncation and
  # re-indexes by itself.
  if cp --reflink=auto --sparse=never "$path" "$rotated" 2>/dev/null || cp "$path" "$rotated" 2>/dev/null; then
    if : > "$path"; then
      local gz="${rotated}.gz" gz_size
      gzip -1 -f "$rotated" 2>/dev/null || true
      if [ -f "$gz" ]; then
        gz_size=$(size_of "$gz")
        RECLAIMED=$((RECLAIMED + bytes - gz_size))
        say "rotated  $label: $(human "$bytes") -> $(basename "$rotated").gz ($(human "$gz_size"))"
      else
        say "rotated  $label: $(human "$bytes") -> $(basename "$rotated") (left uncompressed)"
      fi
    else
      say "FAILED   $label: copy kept, live file not truncated (left as is)"
    fi
  else
    say "FAILED   $label: could not copy the log, nothing changed"
  fi
}

prune_rotations() {
  local pattern="$1" label="$2" days="$3"
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    if [ "$DRY_RUN" -eq 1 ]; then
      say "would drop $label rotation: $(basename "$old") ($(human "$(size_of "$old")"))"
    else
      local sz
      sz=$(size_of "$old")
      rm -f -- "$old" && RECLAIMED=$((RECLAIMED + sz)) && \
        say "dropped  $label rotation: $(basename "$old") ($(human "$sz"))"
    fi
  done < <(find "$NODE_LOG_DIR" -maxdepth 1 -type f -name "$pattern" -mtime +"$days" 2>/dev/null)

  # Keep at most KEEP_ROTATIONS newest copies. Sort by mtime: a timestamped
  # name ("node.log.20261031T0727Z.gz") sorts *below* "node.log.500.gz", so a
  # plain name sort would drop the freshest rotation instead of the oldest.
  local extra
  extra=$(find "$NODE_LOG_DIR" -maxdepth 1 -type f -name "$pattern" -printf '%T@ %p\n' 2>/dev/null \
          | sort -rn | tail -n +"$((KEEP_ROTATIONS + 1))" | cut -d' ' -f2-)
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    if [ "$DRY_RUN" -eq 1 ]; then
      say "would drop $label rotation beyond ${KEEP_ROTATIONS}: $(basename "$old")"
    else
      local sz
      sz=$(size_of "$old")
      rm -f -- "$old" && RECLAIMED=$((RECLAIMED + sz)) && \
        say "dropped  $label rotation beyond ${KEEP_ROTATIONS}: $(basename "$old")"
    fi
  done <<<"$extra"
}

trim_in_place() {
  local path="$1" max_mb="$2" label="$3"
  [ -f "$path" ] || return 0
  local mb
  mb=$(( $(size_of "$path") / 1024 / 1024 ))
  [ "$mb" -ge "$max_mb" ] || return 0
  if [ "$DRY_RUN" -eq 1 ]; then
    say "would truncate $label (${mb} MB >= ${max_mb} MB)"
    return 0
  fi
  if : > "$path"; then
    say "truncated $label (${mb} MB)"
  else
    say "FAILED   $label: not writable"
  fi
}

show_status() {
  echo "octra-node-prune $VERSION"
  local self
  self=$(command -v octra-node-prune 2>/dev/null || echo "$0")
  echo "  program : $self"
  if [ -f "$CRON_FILE" ]; then
    echo "  schedule: cron ($CRON_FILE)"
    grep -vE '^[[:space:]]*(#|$)' "$CRON_FILE" 2>/dev/null | sed 's/^/            /'
    if command -v systemctl >/dev/null 2>&1; then
      echo "  cron    : $(systemctl is-active cron 2>/dev/null || echo unknown)"
    fi
  elif [ -f "$TIMER_FILE" ]; then
    echo "  schedule: systemd timer ($TIMER_FILE)"
    command -v systemctl >/dev/null 2>&1 && systemctl list-timers octra-node-prune.timer --no-pager 2>/dev/null | sed 's/^/            /'
  else
    echo "  schedule: NOT INSTALLED (run dashboard/deploy-dashboard.sh)"
  fi
  echo "  node log: $NODE_LOG ($(human "$(size_of "$NODE_LOG")"))"
  echo "  limits  : rotate > ${NODE_LOG_MAX_MB} MB, keep ${KEEP_ROTATIONS} copies / ${KEEP_DAYS} days"
  if [ -f "$STORAGE_TOOL" ]; then
    echo "  preserved: prune-prior --yes each run ($STORAGE_TOOL)"
  else
    echo "  preserved: controls/storage.sh not found - the step is skipped"
  fi
  echo "  log     : $PRUNE_LOG"
  if [ -s "$PRUNE_LOG" ]; then
    echo "  last runs:"
    grep -E 'prune start|prune done' "$PRUNE_LOG" | tail -4 | sed 's/^/            /'
  fi
}


if [ "$STATUS_ONLY" -eq 1 ]; then
  show_status
  exit 0
fi

# ── single instance ────────────────────────────────────────────────
if [ -n "$LOCK_FILE" ] && command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE" 2>/dev/null || true
  if ! flock -n 9; then
    say "prune skip: another run is still active"
    exit 0
  fi
fi

start_free=$(free_bytes)
RECLAIMED=0
say "prune start (dry-run=${DRY_RUN} max=${NODE_LOG_MAX_MB}MB keep=${KEEP_ROTATIONS}/${KEEP_DAYS}d)"

# ── operator log (the big one) ────────────────────────────────────
rotate_log "$NODE_LOG" "$NODE_LOG_MAX_MB" "operator log"
prune_rotations "$(basename "$NODE_LOG").*.gz" "operator log" "$KEEP_DAYS"

# ── pm2 daemon log ────────────────────────────────────────────────
trim_in_place "$PM2_LOG" "$PM2_LOG_MAX_MB" "pm2 daemon log"

# ── core dumps (kept 1 day in case someone wants to inspect them) ──
for dir in "$NODE_HOME" "$DATA_ROOT" /tmp; do
  [ -d "$dir" ] || continue
  while IFS= read -r dump; do
    [ -n "$dump" ] || continue
    if [ "$DRY_RUN" -eq 1 ]; then
      say "would drop core dump: $dump ($(human "$(size_of "$dump")"))"
    else
      rm -f -- "$dump" && say "dropped  core dump: $dump ($(human "$(size_of "$dump")"))"
    fi
  done < <(find "$dir" -maxdepth 3 -type f \( -name 'core' -o -name 'core.*' -o -name '*.core' \) -mtime +1 2>/dev/null | head -20)
done

# ── dashboard junk ────────────────────────────────────────────────
if [ -d "$DASH_DIR" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    pyc=$(find "$DASH_DIR" -name '__pycache__' -type d 2>/dev/null | wc -l)
    tmp=$(find "$DASH_DIR" -maxdepth 1 -name '*.tmp' -mtime +1 2>/dev/null | wc -l)
    say "would drop dashboard junk: ${pyc} __pycache__ dir(s), ${tmp} stale .tmp file(s)"
  else
    find "$DASH_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null
    find "$DASH_DIR" -maxdepth 1 -name '*.tmp' -mtime +1 -delete 2>/dev/null
    say "cleaned  dashboard __pycache__ / stale .tmp"
  fi
fi

# ── systemd journal (system hygiene, bounded) ─────────────────────
if [ "${OCTRA_PRUNE_SKIP_JOURNAL:-0}" != "1" ] && command -v journalctl >/dev/null 2>&1; then
  if [ "$DRY_RUN" -eq 1 ]; then
    say "would vacuum systemd journal beyond ${JOURNAL_DAYS}d"
  else
    before=$(du -sk /var/log/journal 2>/dev/null | cut -f1)
    journalctl --vacuum-time="${JOURNAL_DAYS}d" --quiet >/dev/null 2>&1 || true
    after=$(du -sk /var/log/journal 2>/dev/null | cut -f1)
    if [ -n "${before:-}" ] && [ -n "${after:-}" ] && [ "$before" -gt "$after" ]; then
      say "journal  vacuumed ${JOURNAL_DAYS}d: $(( (before - after) / 1024 )) MB freed"
    else
      say "journal  within ${JOURNAL_DAYS}d, nothing to vacuum"
    fi
  fi
fi

# ── preserved states (the node's own storage tool) ────────────────
# Upstream README: "Remove preserved states"
#   sh controls/storage.sh
#   sh controls/storage.sh --prune-prior --yes
# A node keeps the states of the previous epochs so it can serve peers that lag
# behind; they grow until the store is oversized. This is the documented
# maintenance and it only frees disk - the current state is untouched.
if [ "${OCTRA_PRUNE_SKIP_STORAGE:-0}" = "1" ]; then
  say "storage  preserved states: skipped (OCTRA_PRUNE_SKIP_STORAGE=1)"
elif [ ! -f "$STORAGE_TOOL" ]; then
  say "storage  preserved states: controls/storage.sh not found (old node version) - skipped"
elif [ "$DRY_RUN" -eq 1 ]; then
  say "would run controls/storage.sh --prune-prior --yes (preserved states)"
else
  before_storage=$(df -B1 --output=avail "$NODE_HOME" 2>/dev/null | tail -1 | tr -d ' ' || echo 0)
  out=$(timeout "$STORAGE_TIMEOUT" su - "$NODE_USER" -c \
        "cd $NODE_HOME && sh controls/storage.sh --prune-prior --yes" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    line=$(printf '%s\n' "$out" | grep -iE 'reclaim|freed|removed|pruned|preserved|prior' | tail -1)
    after_storage=$(df -B1 --output=avail "$NODE_HOME" 2>/dev/null | tail -1 | tr -d ' ' || echo 0)
    freed_disk=0
    if [ -n "${before_storage:-}" ] && [ -n "${after_storage:-}" ] \
       && [ "${after_storage}" -gt "${before_storage}" ] 2>/dev/null; then
      freed_disk=$(( after_storage - before_storage ))
    fi
    say "storage  preserved states pruned${freed_disk:+ : $(human "$freed_disk") freed}${line:+ - $line}"
    RECLAIMED=$(( RECLAIMED + freed_disk ))
  else
    # never fail the whole prune over the node's own tool: report and continue
    say "storage  prune-prior skipped (exit $rc): $(printf '%s\n' "$out" | tail -1)"
  fi
fi

# ── keep our own log small ────────────────────────────────────────
if [ -f "$PRUNE_LOG" ] && [ "$(size_of "$PRUNE_LOG")" -gt 1048576 ] && [ "$DRY_RUN" -eq 0 ]; then
  tail -n 2000 "$PRUNE_LOG" >"$PRUNE_LOG.tmp" 2>/dev/null && mv -f "$PRUNE_LOG.tmp" "$PRUNE_LOG"
fi

end_free=$(free_bytes)
freed=$(( end_free - start_free ))
[ "$freed" -lt 0 ] && freed=0
say "prune done: reclaimed $(human "$RECLAIMED") · operator log now $(human "$(size_of "$NODE_LOG")") · free $(human "$end_free")"
exit 0

