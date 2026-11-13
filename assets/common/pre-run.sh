#!/usr/bin/env bash
# ===================================================================
# pre-run.sh - prepare a fresh VPS before installing Octra lite_node
#
#   0. Harden the host (mandatory): net.mptcp.enabled = 0
#   1. Add 8 GB swap (idempotent - skips if swap is already present)
#   2. Give the node a data store and mount it on ${NODE_DATA_ROOT}
#      - /dev/sdb when it exists and is not the system disk
#      - otherwise the largest non-system disk >= DATA_MIN_GB (1 TB)
#      - otherwise the largest filesystem >= DATA_MIN_GB (main disk)
#      Formatting + mounting is AUTOMATIC (no checkbox): an Octra data set that
#      is already there is kept, anything else on that dedicated volume is
#      formatted, so a retried migration never loses the copy it just made.
#      WIPE_VOLUME=1 overrides that and reformats - including a volume that is
#      already mounted on ${NODE_DATA_ROOT}, which used to be skipped.
#   3. Create every directory the node/migration needs
#   4. Record what was decided in /root/migration/prerun.env, so the migration
#      orchestrator can adapt (keep the data set, format it, or reset the state)
#      instead of contradicting this script and retrying blindly.
#
# Usage:  sudo bash pre-run.sh
# Optional: WIPE_VOLUME=1 ...   force a reformat even of an Octra data set
#           DATA_MIN_GB=800 ... lower the size requirement
#           BLOCK_DEVICE=/dev/nvme1n1 ... prefer another device
#           FORMAT_APPROVED=0 ... refuse to format unless the console approved it
#           PRERUN_STATE=<file> ... where the decision is recorded
# Safe to re-run - each step checks current state before acting.
# ===================================================================

set -euo pipefail
source "$(dirname "$0")/config.sh"

# Must be root
if [[ $EUID -ne 0 ]]; then
  err "Run as root:  sudo bash $0"
  exit 1
fi

# --- tools this script needs: check -> install -> continue ----------
# A bare image may come without e2fsprogs (mkfs.ext4), psmisc or rsync, and
# failing on `mkfs.ext4: command not found` AFTER the wipe is exactly the kind
# of half-done state this toolkit must not produce. Check before touching a disk.
ensure_tool lsblk util-linux || { err "lsblk (util-linux) is required"; exit 1; }
ensure_tool findmnt util-linux || { err "findmnt (util-linux) is required"; exit 1; }
if [[ "${SCAN_ONLY:-0}" != "1" ]]; then
  ensure_tool mkfs.ext4 e2fsprogs || { err "mkfs.ext4 (e2fsprogs) is required to format the data volume"; exit 1; }
  ensure_tool wipefs util-linux || { err "wipefs (util-linux) is required"; exit 1; }
fi

# -------------------------------------------------------------------
# Data-store decision (recorded for the migration orchestrator)
# -------------------------------------------------------------------
# The migration's prep step must not demand a fresh data store that this script
# deliberately kept. So every decision lands in a small file the orchestrator
# reads right after pre-run.sh:
#
#   PRERUN_ACTION = formatted | kept | mounted | fallback
#   PRERUN_DATASET= yes | no      an Octra data set is on the store
#   PRERUN_CHAIN  = yes | no      that data set holds real chain state (HEAD.json)
#
# With those two facts the orchestrator can choose FORCE=1 (keep a resumable
# copy of the same migration), WIPE_VOLUME=1 (reformat a stale copy) or
# RESET_TARGET=1 (no volume to format - drop the stale node state).
PRERUN_STATE="${PRERUN_STATE:-/root/migration/prerun.env}"
PRERUN_DEV=""
PRERUN_ACTION=""
PRERUN_DATASET="no"
PRERUN_CHAIN="no"
PRERUN_FORCE="${WIPE_VOLUME:-${FORCE_FORMAT:-0}}"

write_prerun_state() {
  mkdir -p "$(dirname "${PRERUN_STATE}")"
  {
    echo "PRERUN_DEV=${PRERUN_DEV}"
    echo "PRERUN_MOUNT=${MOUNT_POINT}"
    echo "PRERUN_ACTION=${PRERUN_ACTION}"
    echo "PRERUN_DATASET=${PRERUN_DATASET}"
    echo "PRERUN_CHAIN=${PRERUN_CHAIN}"
    echo "PRERUN_FORCE=${PRERUN_FORCE}"
    echo "PRERUN_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "${PRERUN_STATE}"
  log "data store decision: action=${PRERUN_ACTION} data-set=${PRERUN_DATASET} chain-state=${PRERUN_CHAIN}"
  log "  recorded in ${PRERUN_STATE}"
}

# Does a (mounted) data store still hold an Octra data set / chain state?
# The marker alone is NOT enough: pre-run.sh writes it on every run, including a
# freshly formatted volume. Only the node layout proves there is data here.
detect_dataset() {  # detect_dataset <mountpoint>
  local dir="$1"
  if [[ -d "${dir}/devnet" ]] || [[ -d "${dir}/validator-control" ]]; then
    PRERUN_DATASET="yes"
  fi
  if [[ -f "${dir}/devnet/HEAD.json" ]]; then
    PRERUN_CHAIN="yes"
  fi
}

# -------------------------------------------------------------------
# 0. Data-store helpers (auto detect / format / mount)
# -------------------------------------------------------------------
# Disks that carry the running system (/, /boot, /boot/efi): never format those.
system_disks() {
  local mnt src disk
  for mnt in / /boot /boot/efi; do
    src=$(findmnt -n -o SOURCE "${mnt}" 2>/dev/null || true)
    [[ -n "${src}" ]] || continue
    disk=$(lsblk -no PKNAME "${src}" 2>/dev/null | head -1 || true)
    [[ -n "${disk}" ]] || disk=$(basename "${src}")
    echo "${disk}"
  done | sort -u
}

is_system_disk() {  # is_system_disk <device>  (whole disk or partition)
  local dev="$1" disk
  disk=$(lsblk -no PKNAME "${dev}" 2>/dev/null | head -1 || true)
  [[ -n "${disk}" ]] || disk=$(basename "${dev}")
  system_disks | grep -qx "${disk}"
}

# Whole disks that are not the system disk, biggest first: "<name> <gb>"
list_data_disks() {
  lsblk -ln -b -d -o NAME,SIZE,TYPE 2>/dev/null \
    | awk '$3=="disk" {printf "%s %.0f\n", $1, $2/1000000000}' \
    | while read -r name gb; do
        case "${name}" in
          loop*|sr*|ram*|fd*|dm-*|md*) continue ;;
        esac
        if (( gb < 1 )); then
          continue
        fi
        if is_system_disk "/dev/${name}"; then
          continue
        fi
        echo "${name} ${gb}"
      done | sort -k2 -nr
}

# The device to format: its single partition when it has exactly one, otherwise
# the whole disk (a fresh provider volume usually has no partition table).
device_for() {
  local disk="$1" parts count
  parts=$(lsblk -ln -o NAME,TYPE "${disk}" 2>/dev/null | awk '$2=="part" {print $1}')
  count=$(printf '%s\n' "${parts}" | grep -c . || true)
  if [[ "${count}" == "1" ]]; then
    echo "/dev/${parts}"
  else
    if [[ "${count}" -gt 1 ]]; then
      warn "${disk} holds ${count} partitions - the whole disk will be formatted"
    fi
    echo "${disk}"
  fi
}

# Does this device already carry an Octra data set?
#   * our marker file (.octra-data-volume), or
#   * the node layout itself (devnet/ or validator-control/) - volumes created by
#     an older pre-run.sh have no marker, and reformatting them would destroy a
#     migrated chain state.
volume_is_octra() {
  local dev="$1" tmp rc=1
  tmp=$(mktemp -d)
  if mount -o ro "${dev}" "${tmp}" 2>/dev/null; then
    if [[ -f "${tmp}/${DATA_MARKER}" ]]; then
      rc=0
    elif [[ -d "${tmp}/devnet" ]] || [[ -d "${tmp}/validator-control" ]]; then
      rc=0
    fi
    umount "${tmp}" 2>/dev/null || true
  fi
  rmdir "${tmp}" 2>/dev/null || true
  return ${rc}
}

add_fstab() {  # add_fstab <device> <mountpoint>
  local dev="$1" target="$2" uuid
  uuid=$(blkid -s UUID -o value "${dev}" 2>/dev/null || true)
  sed -i "\|^[^#]*[[:space:]]${target}[[:space:]]|d" /etc/fstab
  if [[ -n "${uuid}" ]]; then
    # nofail: a missing volume must never block the boot of a validator host
    echo "UUID=${uuid} ${target} ext4 defaults,noatime,nofail 0 2" >> /etc/fstab
    log "fstab entry refreshed (UUID=${uuid} -> ${target})"
  else
    warn "no UUID for ${dev} - /etc/fstab was not updated"
  fi
  systemctl daemon-reload 2>/dev/null || true
}

size_gb_of() {  # size_gb_of <device> -> integer GB
  local bytes
  bytes=$(blockdev --getsize64 "$1" 2>/dev/null || echo 0)
  echo $(( ${bytes:-0} / 1000000000 ))
}

# Leave NOTHING behind. A test volume can still hold a previous node's cache, a
# foreign filesystem or a stale partition table, and the deploy program must
# start from an empty store. wipefs on the disk AND its partitions removes every
# signature the kernel could still pick up, zeroing the first and last 16 MiB
# kills the backup superblocks/GPT leftovers, and mkfs writes a clean ext4.
# No full-disk overwrite: this stays a few seconds even on 1 TB.
wipe_device() {  # wipe_device <device>
  local dev="$1" size_mb=0 last_seek=0 part
  log "wiping every signature on ${dev} (partitions, filesystems, first/last 16 MiB)"
  for part in $(lsblk -ln -o NAME "${dev}" 2>/dev/null | awk 'NR>1 {print "/dev/"$1}'); do
    umount "${part}" 2>/dev/null || true
    wipefs -a "${part}" >/dev/null 2>&1 || true
  done
  umount "${dev}" 2>/dev/null || true
  wipefs -a "${dev}" >/dev/null 2>&1 || true
  size_mb=$(blockdev --getsize64 "${dev}" 2>/dev/null | awk '{printf "%d", $1/1048576}')
  [[ -n "${size_mb}" ]] || size_mb=0
  dd if=/dev/zero of="${dev}" bs=1M count=16 conv=fsync 2>/dev/null || true
  if (( size_mb > 32 )); then
    last_seek=$(( size_mb - 16 ))
    dd if=/dev/zero of="${dev}" bs=1M count=16 seek="${last_seek}" conv=fsync 2>/dev/null || true
  fi
  partprobe "${dev}" 2>/dev/null || true
  udevadm settle 2>/dev/null || true
  log "  ${dev} is empty now ($(size_gb_of "${dev}") GB)"
}

mount_data_volume() {  # mount_data_volume <device>
  local dev="$1" fs_exists=0 force="${WIPE_VOLUME:-${FORCE_FORMAT:-0}}" has_dataset=0
  if is_system_disk "${dev}"; then
    err "refusing to format ${dev}: it carries the running system"
    return 1
  fi

  # free anything mounted from this device (a previous node, a stale mount)
  while read -r target; do
    if [[ -z "${target}" ]]; then
      continue
    fi
    if [[ "${target}" == "${MOUNT_POINT}" ]]; then
      continue
    fi
    warn "unmounting ${target} (belongs to ${dev})"
    umount "${target}" 2>/dev/null || true
  done < <(findmnt -ln -o TARGET -S "${dev}" 2>/dev/null || true)

  if [[ -n "$(blkid -o value -s TYPE "${dev}" 2>/dev/null || true)" ]]; then
    fs_exists=1
  fi

  if (( fs_exists == 1 )) && volume_is_octra "${dev}"; then
    has_dataset=1
  fi

  if (( fs_exists == 1 )) && [[ "${force}" != "1" ]] && (( has_dataset == 1 )); then
    log "${dev} already holds an Octra data set - keeping it (no format)"
    PRERUN_ACTION="kept"
  else
    if (( fs_exists == 1 )); then
      if [[ "${force}" == "1" ]]; then
        warn "WIPE_VOLUME=1 - reformatting ${dev} even though it holds an Octra data set"
        PRERUN_ACTION="formatted"
      else
        warn "${dev} carries a filesystem but no Octra marker - formatting it now"
        warn "  (dedicated node volume: its content is not needed by the node)"
        PRERUN_ACTION="formatted"
      fi
    else
      log "No filesystem on ${dev} - formatting it now"
      PRERUN_ACTION="formatted"
    fi
    # Hard safety gate: the console always sends FORMAT_APPROVED=0/1. An explicit
    # 0 means the operator did not approve erasing this device; an unset value
    # keeps the legacy CLI behaviour.
    if [[ "${FORMAT_APPROVED:-}" == "0" ]]; then
      err "refusing to format ${dev}: formatting was not approved in the console"
      err "rerun the task and tick 'Allow format' in the disk confirmation modal"
      return 1
    fi
    wipe_device "${dev}"
    log "Formatting ${dev} as ext4 (label ${DATA_LABEL})..."
    # -q: mkfs prints a megabytes-sized "Discarding device blocks" progress line
    # that arrives as one unreadable log row; discard stays enabled.
    mkfs.ext4 -F -q -L "${DATA_LABEL}" "${dev}"
  fi

  mkdir -p "${MOUNT_POINT}"
  if ! mountpoint -q "${MOUNT_POINT}" 2>/dev/null; then
    log "Mounting ${dev} -> ${MOUNT_POINT}..."
    mount "${dev}" "${MOUNT_POINT}"
  fi
  # a freshly formatted ext4 only has lost+found; anything else would be a
  # leftover the operator asked us to remove (dot entries are left alone: they
  # are bookkeeping, not node data)
  if [[ "${PRERUN_ACTION}" == "formatted" ]]; then
    find "${MOUNT_POINT}" -mindepth 1 -maxdepth 1 ! -name 'lost+found' ! -name '.*' \
      -exec rm -rf {} + 2>/dev/null || true
  fi
  touch "${MOUNT_POINT}/${DATA_MARKER}"
  add_fstab "${dev}" "${MOUNT_POINT}"

  PRERUN_DEV="${dev}"
  # has_dataset was measured BEFORE the format, so it only describes what is
  # still there when the volume was kept
  if [[ "${PRERUN_ACTION}" == "kept" ]] && (( has_dataset == 1 )); then
    PRERUN_DATASET="yes"
  fi
  # what is really on the mounted volume now (a fresh format carries nothing)
  detect_dataset "${MOUNT_POINT}"

  log "Data volume ready: ${dev} -> ${MOUNT_POINT} ($(df -h "${MOUNT_POINT}" | tail -1 | awk '{print $2}') total)"
}

# No dedicated volume: keep the data on the biggest filesystem (usually /).
mount_data_fallback() {
  local src size avail target best_src="" best_size=0 best_avail=0 best_target=""
  while read -r src size avail target; do
    [[ -z "${src}" ]] && continue
    case "${src}" in
      tmpfs|devtmpfs|overlay|none|udev|shm) continue ;;
    esac
    (( size >= DATA_MIN_GB )) || continue
    if (( avail > best_avail )); then
      best_src="${src}"; best_size="${size}"; best_avail="${avail}"; best_target="${target}"
    fi
  done < <(df -B1G --output=source,size,avail,target 2>/dev/null | tail -n +2 || true)

  if [[ -z "${best_src}" ]]; then
    err "no disk large enough for the node data store (need >= ${DATA_MIN_GB} GB)"
    warn "Attach a 1 TB block volume (pre-run.sh picks it up automatically), or lower"
    warn "the requirement with:  DATA_MIN_GB=<gb> bash pre-run.sh"
    lsblk || true
    exit 1
  fi

  warn "no dedicated data volume found - the node data will live on ${best_src} (${best_target})"
  log "  filesystem: ${best_size} GB total, ${best_avail} GB free (nothing is formatted)"
  mkdir -p "${MOUNT_POINT}"
  PRERUN_DEV="${best_src}"
  PRERUN_ACTION="fallback"
  detect_dataset "${MOUNT_POINT}"
}

# -------------------------------------------------------------------
# Pick the data store, format/mount it and record the decision
# -------------------------------------------------------------------
# Split out of the main body so the test harness can drive every branch
# (mounted / mounted+force / dedicated volume / fallback) without touching a
# real disk: migrate-ui/dev/test-prerun.sh stubs lsblk/findmnt/mount/mkfs.
prepare_data_store() {
  if mountpoint -q "${MOUNT_POINT}" 2>/dev/null; then
    local current_dev
    current_dev=$(findmnt -n -o SOURCE "${MOUNT_POINT}" 2>/dev/null || echo "${MOUNT_POINT}")
    PRERUN_DEV="${current_dev}"
    PRERUN_ACTION="mounted"
    if [[ "${PRERUN_FORCE}" == "1" ]]; then
      # A force that silently does nothing is worse than no force at all. On a
      # retry the volume is already mounted, and the old code only touched the
      # marker here - so WIPE_VOLUME=1 was ignored and the stale chain state
      # survived every run.
      if is_system_disk "${current_dev}"; then
        warn "WIPE_VOLUME=1 refused: ${MOUNT_POINT} lives on the system disk (${current_dev})"
        detect_dataset "${MOUNT_POINT}"
      else
        warn "WIPE_VOLUME=1 - reformatting the mounted data volume ${current_dev}"
        if ! umount "${MOUNT_POINT}"; then
          err "could not unmount ${MOUNT_POINT} - a process is still using it (lsof ${MOUNT_POINT})"
          return 1
        fi
        mount_data_volume "${current_dev}"
        return $?
      fi
    else
      log "${MOUNT_POINT} is already a mount point (${current_dev}) - keeping it"
      detect_dataset "${MOUNT_POINT}"
      touch "${MOUNT_POINT}/${DATA_MARKER}"
    fi
    return 0
  fi

  local data_dev="" data_gb=0

  # 1) the preferred volume (/dev/sdb by default)
  if lsblk "${BLOCK_DEVICE}" >/dev/null 2>&1; then
    if is_system_disk "${BLOCK_DEVICE}"; then
      warn "${BLOCK_DEVICE} carries the running system - not usable as the data volume"
    else
      data_dev=$(device_for "${BLOCK_DEVICE}")
      data_gb=$(size_gb_of "${data_dev}")
      if (( data_gb < DATA_MIN_GB )); then
        warn "${data_dev} is ${data_gb} GB - below the recommended ${DATA_MIN_GB} GB for the node data store"
      fi
      log "preferred data volume: ${BLOCK_DEVICE} -> ${data_dev} (${data_gb} GB)"
    fi
  else
    warn "${BLOCK_DEVICE} not present - looking for another disk"
  fi

  # 2) the largest non-system disk >= DATA_MIN_GB
  if [[ -z "${data_dev}" ]]; then
    local disk_name disk_gb
    while read -r disk_name disk_gb; do
      if (( disk_gb < DATA_MIN_GB )); then
        continue
      fi
      data_dev=$(device_for "/dev/${disk_name}")
      log "using the largest free disk: /dev/${disk_name} (${disk_gb} GB)"
      break
    done < <(list_data_disks)
  fi

  # 3) mount (formatting only when there is no Octra data set on it)
  if [[ -n "${data_dev}" ]]; then
    mount_data_volume "${data_dev}"
  else
    warn "no dedicated volume >= ${DATA_MIN_GB} GB found"
    mount_data_fallback
  fi
}


# -------------------------------------------------------------------
# READ-ONLY SCAN (SCAN_ONLY=1)
# Reports exactly which device prepare_data_store() would use and whether it
# would erase it. It never mounts rw, wipes or reformats. The console calls this
# before a deploy/migrate run and shows the result in the destructive-action
# confirmation modal.
# -------------------------------------------------------------------
scan_data_store() {
  local action="none" dev="" disk="" size=0 fstype="" label="" mount="" reason=""
  local system="no" has_dataset="no" chain="no" model="" current=""
  local disk_name disk_gb src size_gb avail target tmp
  local best_src="" best_target="" best_size=0 best_avail=0

  if mountpoint -q "${MOUNT_POINT}" 2>/dev/null; then
    dev=$(findmnt -n -o SOURCE "${MOUNT_POINT}" 2>/dev/null || echo "${MOUNT_POINT}")
    current=$(lsblk -no PKNAME "${dev}" 2>/dev/null | head -1 || true)
    disk=$([[ -n "${current}" ]] && echo "/dev/${current}" || echo "${dev}")
    size=$(size_gb_of "${dev}")
    fstype=$(blkid -o value -s TYPE "${dev}" 2>/dev/null || true)
    label=$(blkid -o value -s LABEL "${dev}" 2>/dev/null || true)
    mount="${MOUNT_POINT}"
    is_system_disk "${dev}" && system="yes" || system="no"
    detect_dataset "${MOUNT_POINT}"
    has_dataset="${PRERUN_DATASET}"
    chain="${PRERUN_CHAIN}"
    if [[ "${PRERUN_FORCE}" == "1" && "${system}" != "yes" ]]; then
      action="format"
      reason="WIPE_VOLUME=1 on the mounted data volume"
    else
      action="keep"
      if [[ "${PRERUN_FORCE}" == "1" ]]; then
        reason="WIPE_VOLUME=1 refused: the mount lives on the system disk"
      else
        reason="already mounted - no format"
      fi
    fi
  else
    if lsblk "${BLOCK_DEVICE}" >/dev/null 2>&1 && ! is_system_disk "${BLOCK_DEVICE}"; then
      dev=$(device_for "${BLOCK_DEVICE}")
    fi
    if [[ -z "${dev}" ]]; then
      while read -r disk_name disk_gb; do
        (( disk_gb < DATA_MIN_GB )) && continue
        dev=$(device_for "/dev/${disk_name}")
        break
      done < <(list_data_disks)
    fi

    if [[ -n "${dev}" ]]; then
      current=$(lsblk -no PKNAME "${dev}" 2>/dev/null | head -1 || true)
      disk=$([[ -n "${current}" ]] && echo "/dev/${current}" || echo "${dev}")
      size=$(size_gb_of "${dev}")
      fstype=$(blkid -o value -s TYPE "${dev}" 2>/dev/null || true)
      label=$(blkid -o value -s LABEL "${dev}" 2>/dev/null || true)
      model=$(lsblk -no MODEL "${disk}" 2>/dev/null | head -1 | xargs 2>/dev/null || true)
      is_system_disk "${dev}" && system="yes" || system="no"
      if [[ -n "${fstype}" ]] && volume_is_octra "${dev}"; then
        has_dataset="yes"
        tmp=$(mktemp -d)
        if mount -o ro "${dev}" "${tmp}" 2>/dev/null; then
          [[ -f "${tmp}/devnet/HEAD.json" ]] && chain="yes"
          umount "${tmp}" 2>/dev/null || true
        fi
        rmdir "${tmp}" 2>/dev/null || true
      fi
      if [[ "${system}" == "yes" ]]; then
        action="keep"
        reason="the selected device carries the running system - pre-run refuses to format it"
      elif [[ -n "${fstype}" && "${PRERUN_FORCE}" != "1" && "${has_dataset}" == "yes" ]]; then
        action="keep"
        reason="an Octra data set is present - pre-run keeps it"
      elif [[ -n "${fstype}" && "${PRERUN_FORCE}" == "1" ]]; then
        action="format"
        if [[ "${has_dataset}" == "yes" ]]; then
          reason="WIPE_VOLUME=1 forces a reformat even though an Octra data set is present"
        else
          reason="WIPE_VOLUME=1 forces a reformat of the ${fstype} filesystem"
        fi
      elif [[ -n "${fstype}" ]]; then
        action="format"
        reason="filesystem ${fstype} but no Octra data set - pre-run formats it"
      else
        action="format"
        reason="no filesystem - pre-run formats it"
      fi
    else
      while read -r src size_gb avail target; do
        [[ -z "${src}" ]] && continue
        case "${src}" in
          tmpfs|devtmpfs|overlay|none|udev|shm) continue ;;
        esac
        (( size_gb >= DATA_MIN_GB )) || continue
        if (( avail > best_avail )); then
          best_src="${src}"; best_size="${size_gb}"; best_avail="${avail}"; best_target="${target}"
        fi
      done < <(df -B1G --output=source,size,avail,target 2>/dev/null | tail -n +2 || true)
      if [[ -n "${best_src}" ]]; then
        dev="${best_src}"
        disk="${best_src}"
        size="${best_size}"
        mount="${best_target}"
        action="fallback"
        reason="no dedicated volume; the node data stays on ${best_src} (${best_target}) - nothing is formatted"
      else
        reason="no disk large enough for the data store"
      fi
    fi
  fi

  echo "SCAN_ACTION=${action}"
  echo "SCAN_DEVICE=${dev}"
  echo "SCAN_DISK=${disk}"
  echo "SCAN_SIZE_GB=${size}"
  echo "SCAN_FSTYPE=${fstype}"
  echo "SCAN_LABEL=${label}"
  echo "SCAN_MOUNT=${mount}"
  echo "SCAN_SYSTEM=${system}"
  echo "SCAN_DATASET=${has_dataset}"
  echo "SCAN_CHAIN=${chain}"
  echo "SCAN_MODEL=${model}"
  echo "SCAN_REASON=${reason}"
  echo "SCAN_LSBLK_B64=$(lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL 2>/dev/null | base64 -w0 2>/dev/null || lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL 2>/dev/null | base64 | tr -d '\n')"
}

if [[ "${SCAN_ONLY:-0}" == "1" ]]; then
  scan_data_store
  exit 0
fi

# -------------------------------------------------------------------
# 0. HOST HARDENING - MPTCP off (mandatory, both programs)
# -------------------------------------------------------------------
# pre-run.sh is the first thing that touches a target machine in BOTH programs
# (deploy: 10-prepare-host.sh; migrate: 01-prepare-target.sh), so the
# baseline hardening lives here as well as in scripts/harden-host.sh.
# MPTCP is unused by the node and must not be listening: it is an avoidable
# vector of attack. disable_mptcp() writes
# /etc/sysctl.d/99-disable-mptcp.conf and verifies the running value.
log "Hardening the host (net.mptcp.enabled = 0)..."
if ! disable_mptcp; then
  err "refusing to continue: MPTCP is still enabled on this host (fixed with sudo sysctl --system)"
  exit 1
fi

# -------------------------------------------------------------------
# 1. SWAP - 8 GB swapfile
# -------------------------------------------------------------------
log "Checking swap configuration…"

CURRENT_SWAP=$(swapon --show --noheadings 2>/dev/null | wc -l)
if (( CURRENT_SWAP > 0 )); then
  log "Swap already active ($(swapon --show | tail -n +2 | awk '{print $1, $3}')) — skipping"
else
  log "Creating ${SWAP_SIZE} swap file at ${SWAP_FILE}…"

  # Remove stale swap file if present
  if [[ -f "${SWAP_FILE}" ]]; then
    warn "${SWAP_FILE} already exists — recreating"
    swapoff "${SWAP_FILE}" 2>/dev/null || true
    rm -f "${SWAP_FILE}"
  fi

  # Create a dense swap file (dd writes real blocks, fallocate can create holes)
  # Try fallocate first (fast), fall back to dd if the filesystem doesn't support it
  if fallocate -l "${SWAP_SIZE}" "${SWAP_FILE}" 2>/dev/null; then
    log "Swap file allocated with fallocate"
  else
    warn "fallocate failed — using dd (slower but reliable)"
    dd if=/dev/zero of="${SWAP_FILE}" bs=1M count=$(( ${SWAP_GB:-8} * 1024 )) status=progress
  fi

  chmod 600 "${SWAP_FILE}"
  mkswap "${SWAP_FILE}"
  swapon "${SWAP_FILE}"

  # Persist in fstab (remove old entry first)
  if ! grep -q "${SWAP_FILE}" /etc/fstab; then
    echo "${SWAP_FILE} none swap sw 0 0" >> /etc/fstab
    log "Swap entry added to /etc/fstab"
  fi

  log "Swap activated: $(free -h | awk '/^Swap:/ {print $2}')"
fi

# -------------------------------------------------------------------
# 2. DATA STORE - automatic detect + format + mount
# -------------------------------------------------------------------
log "Preparing the node data store (${MOUNT_POINT}, needs >= ${DATA_MIN_GB} GB)..."

prepare_data_store || exit 1
write_prerun_state

# --- directories ----------------------------------------------------
# Node + migration paths must exist before anything writes into them; a fresh
# host has none of them, so they are always created here.
for dir in "${MOUNT_POINT}" "${NODE_DATA_DIR}" "${NODE_SYNC_STAGE}" \
           "${MOUNT_POINT}/validator-control" "/root/migration" "/root/migration/backups"; do
  mkdir -p "${dir}"
done
if id "${NODE_USER}" >/dev/null 2>&1; then
  chown "${NODE_USER}:${NODE_USER}" "${NODE_DATA_DIR}" "${NODE_SYNC_STAGE}" 2>/dev/null || true
fi
log "Directories ready: ${NODE_DATA_DIR}, ${NODE_SYNC_STAGE}"

# -------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------

echo
log "Pre-run complete:"
echo "  MPTCP: $(sysctl net.mptcp.enabled 2>/dev/null || echo 'not available on this kernel')"
echo "  Swap:  $(free -h | awk '/^Swap:/ {print $2}')"
STORE_INFO=$(df -h "$MOUNT_POINT" 2>/dev/null | tail -1 | awk '{print $1" "$2", "$4" avail"}')
if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
  STORE_KIND="dedicated volume, marker ${DATA_MARKER}"
else
  STORE_KIND="main disk, no separate volume"
fi
echo "  Store: ${STORE_INFO}"
echo "  Mount: ${MOUNT_POINT} - ${STORE_KIND}"
echo "  Store decision: ${PRERUN_ACTION} (Octra data set: ${PRERUN_DATASET}, chain state: ${PRERUN_CHAIN})"
echo "  Dirs:  ${NODE_DATA_DIR}, ${NODE_SYNC_STAGE}"
