#!/usr/bin/env python3
"""
Octra Lite Node - Live Monitoring Backend (v2)
==============================================
Single-file, dependency-free HTTP backend that serves the dashboard and
aggregates live node telemetry from:

  * the node JSON-RPC API      (127.0.0.1:<OCTRA_API_PORT>)
  * /proc                      (cpu, memory, network, load, uptime)
  * pm2                        (process state + log files)
  * node.env / SOURCE_COMMIT   (identity + build)

Endpoints
---------
  GET /api/status   -> full snapshot (node, consensus, peers, system, wallet, history)
  GET /api/logs     -> parsed log tail (?lines=120&level=WARN,ERR)
  GET /api/wallet   -> wallet / stake / reward block only
  GET /api/ping     -> minimal liveness probe used by the frontend

The process is intentionally read-only: it never restarts or mutates the node.
Its only side effect is the wallet reward index under /var/lib/octra/dashboard/
(balance baseline + reward counters folded from the node's operator log).
"""

import argparse
import base64
import calendar
import json
import os
import re
import socket
import subprocess
import threading
import time
import unicodedata
import urllib.request
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# -- Constants ------------------------------------------------------
DASHBOARD_DIR  = Path(__file__).resolve().parent
NODE_SRC_DIR   = Path("/opt/octra/libv_litecore")
NODE_DATA_ROOT = Path("/var/lib/octra")
NODE_ENV_PATH  = NODE_SRC_DIR / ".keys" / "validator" / "node.env"
if not NODE_ENV_PATH.exists():
    NODE_ENV_PATH = NODE_SRC_DIR / "config" / "node.env"

DEFAULT_PORT  = 9090
MAX_HISTORY   = 240        # 20 min @ 5 s samples
MAX_LOG_LINES = 400
SYSTEM_TTL    = 1.5        # seconds - sample cache shared by all clients
STALE_PEER_S  = 600        # peer record older than this is considered stale
FRESH_PEER_S  = 120        # records younger than this drive the lag statistics

# -- Wallet / reward tracking ---------------------------------------
TOKEN_DECIMALS   = 6       # ledger units: 1 OCTRA = 1_000_000 raw
TOKEN_UNIT       = 10 ** TOKEN_DECIMALS
LOG_ADDR_PREFIX  = 12      # the operator log prints addresses as 12 chars + ".."
WALLET_RPC_TTL   = 8.0     # seconds - balance/enrollment cache shared by clients
WALLET_DEEP_TTL  = 300.0   # seconds - octra_account detail is slow, so cache it long
WALLET_DEEP_RETRY = 30.0   # seconds between retries when the detail query fails
WALLET_SCAN_TTL  = 10.0    # seconds between log-index passes when caught up
WALLET_CATCHUP   = 1.0     # faster passes while the log index is still behind
WALLET_SCAN_BYTES = 8 * 1024 * 1024   # bounded work per pass
WALLET_RECENT_MAX = 16     # epoch reward rows kept for the table
WALLET_STATE_ENV = "OCTRA_WALLET_STATE"
WALLET_STATE_DIRS = (
    Path("/var/lib/octra/dashboard"),
    DASHBOARD_DIR / "state",
    Path("/tmp"),
)

# -- In-memory ring buffers -----------------------------------------
_cpu_history  = deque(maxlen=MAX_HISTORY)
_net_history  = deque(maxlen=MAX_HISTORY)
_epoch_history = deque(maxlen=MAX_HISTORY)   # [ts, head_epoch]
_avail_history = deque(maxlen=2000)          # 1 = healthy sample, 0 = not

_prev_cpu   = None
_prev_net   = None
_prev_diskio = None
_prev_time  = None
_last_system = {"ts": 0.0, "data": None}
_log_cache  = {"ts": 0.0, "lines": 0, "data": []}
_wallet_rpc = {"ts": 0.0, "address": "", "data": None}
_wallet_deep = {"ts": 0.0, "attempt": 0.0, "address": "", "data": None, "running": False}
_wallet_scanning = False
_wallet_state_file = {"path": None}

_start_time = time.time()
_lock = threading.Lock()


# -- Small helpers --------------------------------------------------
def parse_env(path):
    result = {}
    if not Path(path).is_file():
        return result
    try:
        text = Path(path).read_text()
    except Exception:
        return result
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        result[k.strip()] = v.strip().strip('"')
    return result


def get_api_port():
    port = os.environ.get("OCTRA_API_PORT")
    if port:
        try:
            return int(port)
        except ValueError:
            pass
    env = parse_env(NODE_ENV_PATH)
    try:
        return int(env.get("OCTRA_API_PORT", "8080"))
    except ValueError:
        return 8080


def os_release():
    try:
        with open("/etc/os-release") as f:
            for line in f:
                if line.startswith("PRETTY_NAME="):
                    return line.split("=", 1)[1].strip().strip('"')
    except Exception:
        pass
    return "unknown"


def human_age(seconds):
    seconds = max(0, int(seconds))
    d, rem = divmod(seconds, 86400)
    h, rem = divmod(rem, 3600)
    m, s = divmod(rem, 60)
    if d:
        return f"{d}d {h}h"
    if h:
        return f"{h}h {m}m"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def _num(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _int(value, default=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


# -- Text hygiene ---------------------------------------------------
# Everything that reaches the browser passes through ascii_text(): the node
# abbreviates a peer id with U+2026, an HTTP/proxy layer can re-encode it, and
# the address then showed up in the peer table as "octEQAFbEs<mojibake>pniHXQ"
# (2026-11-06). The monitor repairs the double-encoding, transliterates the
# glyph and drops what is left, so no /api/* string can carry a character
# outside ASCII - independent of how many layers mangled it on the way in.
_ASCII_GLYPHS = {
    0x2014: "-", 0x2013: "-", 0x2012: "-", 0x2015: "-", 0x2212: "-",
    0x2026: "...", 0x00B7: "-", 0x2022: "*", 0x2027: "*",
    0x2192: "->", 0x2190: "<-", 0x2191: "^", 0x2193: "v",
    0x2196: "up", 0x2197: "up", 0x2198: "down", 0x2199: "down",
    0x21C4: "<->", 0x21D2: "=>",
    0x2018: "'", 0x2019: "'", 0x201C: '"', 0x201D: '"',
    0x00AB: '"', 0x00BB: '"', 0x2039: "'", 0x203A: "'",
    0x2248: "~", 0x2261: "=", 0x2260: "!=", 0x2265: ">=", 0x2264: "<=",
    0x00D7: "x", 0x00F7: "/", 0x2044: "/",
    0x0394: "delta", 0x2206: "delta",
    0x2713: "ok", 0x2714: "ok", 0x2717: "x", 0x2718: "x",
    0x25B2: "^", 0x25BC: "v", 0x25C0: "<", 0x25B6: ">",
    0x25CF: "*", 0x25CB: "o", 0x25A0: "*", 0x25A1: "o",
    0x26A0: "!", 0x00A0: " ", 0x200B: "", 0xFEFF: "",
}
for _box in range(0x2500, 0x2580):          # box drawing
    _ASCII_GLYPHS.setdefault(_box, "|" if _box in (0x2502, 0x2503) else "-")
del _box


def _cp1252_bytes(text):
    """The bytes a mojibake string came from, or None when that is hopeless."""
    try:
        return text.encode("cp1252")
    except UnicodeEncodeError:
        pass
    out = bytearray()
    for ch in text:
        try:
            out += ch.encode("cp1252")
        except UnicodeEncodeError:
            return None
    return bytes(out)


def _non_ascii(text):
    return sum(1 for ch in text if ord(ch) > 127)


def unmojibake(text, rounds=4):
    """Undo 'UTF-8 decoded as cp1252', once per round, while it actually helps."""
    for _ in range(rounds):
        before = _non_ascii(text)
        if before == 0:
            break
        raw = _cp1252_bytes(text)
        if raw is None:
            break
        try:
            fixed = raw.decode("utf-8")
        except UnicodeDecodeError:
            break
        if _non_ascii(fixed) >= before:
            break
        text = fixed
    return text


def ascii_text(value, repair=True):
    """A plain-ASCII view of a string that came from the node or a log file."""
    if value is None:
        return ""
    text = value if isinstance(value, str) else str(value)
    if repair:
        text = unmojibake(text)
    out = []
    for ch in text:
        code = ord(ch)
        if code < 128:
            out.append(ch)
            continue
        mapped = _ASCII_GLYPHS.get(code)
        if mapped is None:
            mapped = unicodedata.normalize("NFKD", ch).encode("ascii", "ignore").decode("ascii")
        out.append(mapped)
    return "".join(out)


def ascii_deep(value):
    """ascii_text() applied to every string of a JSON-shaped object."""
    if isinstance(value, str):
        return ascii_text(value)
    if isinstance(value, dict):
        return dict((ascii_text(k), ascii_deep(v)) for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return [ascii_deep(v) for v in value]
    return value


def peer_label(value):
    """Display form of a peer id, whatever corruption reached us.

    A node id is base58, so every non-alphanumeric run is damage: "octEQAFbEs
    <mojibake>pniHXQ" becomes "octEQAFbEs...pniHXQ" instead of a string full of
    lookalike letters. A clean id is abbreviated head + "..." + tail as before.
    """
    text = unmojibake(value if isinstance(value, str) else str(value or ""))
    if "..." in text:                       # the node already abbreviated it
        return ascii_text(text)
    parts = re.findall(r"[A-Za-z0-9]+", text)
    if not parts:
        return ""
    if len(parts) > 1:
        return parts[0][:10] + "..." + parts[-1][-6:]
    joined = parts[0]
    return (joined[:10] + "..." + joined[-6:]) if len(joined) > 20 else joined


# -- Node RPC ------------------------------------------------------
def rpc_get_status(api_port, timeout=3):
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{api_port}/status",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None


def rpc_call_method(api_port, method, params=None, timeout=4):
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}
    ).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{api_port}/rpc",
        data=body,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read()).get("result")
    except Exception:
        return None


# -- /proc readers -------------------------------------------------
def read_cpu():
    with open("/proc/stat") as f:
        line = f.readline()
    vals = [int(x) for x in line.split()[1:]]
    total = sum(vals)
    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
    return total, idle


def read_meminfo():
    result = {}
    with open("/proc/meminfo") as f:
        for line in f:
            if ":" not in line:
                continue
            key, rest = line.split(":", 1)
            parts = rest.strip().split()
            if not parts:
                continue
            val = int(parts[0])
            if len(parts) > 1 and parts[1] == "kB":
                val *= 1024
            result[key] = val
    return result


def read_netdev():
    rx = tx = 0
    with open("/proc/net/dev") as f:
        for line in f:
            if ":" not in line:
                continue
            iface, rest = line.split(":", 1)
            name = iface.strip()
            if name == "lo" or name.startswith(("veth", "docker", "br-", "tailscale")):
                continue
            p = rest.split()
            if len(p) < 9:
                continue
            rx += int(p[0])
            tx += int(p[8])
    return rx, tx


def read_diskio():
    """Summed sector read/write counters across physical block devices."""
    read_s = write_s = 0
    try:
        with open("/proc/diskstats") as f:
            for line in f:
                p = line.split()
                if len(p) < 10:
                    continue
                name = p[2]
                if name.startswith(("loop", "ram", "dm-", "sr")):
                    continue
                # skip partitions (sda1, nvme0n1p1 ...) but keep sda / nvme0n1
                if re.match(r"^(sd[a-z]|vd[a-z]|hd[a-z]|nvme\d+n\d+|mmcblk\d+)p?\d+$", name):
                    continue
                read_s += int(p[5])
                write_s += int(p[9])
    except Exception:
        pass
    return read_s * 512, write_s * 512


def read_loadavg():
    try:
        with open("/proc/loadavg") as f:
            p = f.read().split()
        return [float(p[0]), float(p[1]), float(p[2])]
    except Exception:
        return [0.0, 0.0, 0.0]


def read_uptime_secs():
    try:
        with open("/proc/uptime") as f:
            return float(f.read().split()[0])
    except Exception:
        return 0.0


def disk_usage(path):
    st = os.statvfs(str(path))
    b = st.f_frsize
    used = (st.f_blocks - st.f_bfree) * b
    free = st.f_bavail * b
    # Report the filesystem the way `df` does for a non-root view:
    # reserved blocks are not part of the usable capacity.
    return used + free, used, free


# -- System metrics ------------------------------------------------
def system_info():
    """Sampled system telemetry, cached for SYSTEM_TTL seconds so several
    dashboard clients never corrupt the rate calculations."""
    now = time.time()
    with _lock:
        if _last_system["data"] and (now - _last_system["ts"]) < SYSTEM_TTL:
            return dict(_last_system["data"])

    global _prev_cpu, _prev_net, _prev_diskio, _prev_time

    cpu_total, cpu_idle = read_cpu()
    rx_bytes, tx_bytes = read_netdev()
    disk_rb, disk_wb = read_diskio()
    load = read_loadavg()

    with _lock:
        if _prev_cpu is not None and _prev_time is not None:
            dt = now - _prev_time
            d_total = cpu_total - _prev_cpu[0]
            d_idle = cpu_idle - _prev_cpu[1]
            cpu_pct = (1.0 - d_idle / d_total) * 100.0 if d_total > 0 else 0.0
            if dt > 0:
                in_mbps = (rx_bytes - _prev_net[0]) * 8 / dt / 1_000_000
                out_mbps = (tx_bytes - _prev_net[1]) * 8 / dt / 1_000_000
                disk_r = (disk_rb - _prev_diskio[0]) / dt / 1_048_576
                disk_w = (disk_wb - _prev_diskio[1]) / dt / 1_048_576
            else:
                in_mbps = out_mbps = disk_r = disk_w = 0.0
        else:
            cpu_pct = in_mbps = out_mbps = disk_r = disk_w = 0.0

        # The very first sample only establishes a baseline - do not chart it.
        if _prev_cpu is not None:
            _cpu_history.append(round(cpu_pct, 1))
            _net_history.append([round(max(0.0, in_mbps), 2), round(max(0.0, out_mbps), 2)])
        _prev_cpu = (cpu_total, cpu_idle)
        _prev_net = (rx_bytes, tx_bytes)
        _prev_diskio = (disk_rb, disk_wb)
        _prev_time = now

        cpu_hist = list(_cpu_history)
        net_hist = list(_net_history)

    mem = read_meminfo()
    mem_total = mem.get("MemTotal", 0)
    mem_avail = mem.get("MemAvailable", mem_total - mem.get("MemFree", 0))
    mem_used = mem_total - mem_avail
    swap_total = mem.get("SwapTotal", 0)
    swap_used = swap_total - mem.get("SwapFree", 0)

    try:
        data_total, data_used, data_free = disk_usage(NODE_DATA_ROOT)
    except Exception:
        data_total = data_used = data_free = 0

    try:
        root_total, root_used, _ = disk_usage("/")
    except Exception:
        root_total = root_used = 0

    cores = os.cpu_count() or 1
    uptime_secs = read_uptime_secs()

    info = {
        "hostname": socket.gethostname(),
        "os": os_release(),
        "kernel": os.uname().release,
        "arch": os.uname().machine,
        "cpu_cores": cores,
        "cpu_percent": round(cpu_pct, 1),
        "cpu_history": cpu_hist,
        "load_avg": load,
        "load_percent": round(min(999.0, load[0] / cores * 100), 1),
        "mem_total_gb": round(mem_total / 1e9, 1),
        "mem_used_gb": round(mem_used / 1e9, 1),
        "mem_avail_gb": round(mem_avail / 1e9, 1),
        "mem_percent": round((mem_used / mem_total * 100) if mem_total else 0, 1),
        "swap_total_gb": round(swap_total / 1e9, 1),
        "swap_used_gb": round(swap_used / 1e9, 1),
        "swap_percent": round((swap_used / swap_total * 100) if swap_total else 0, 1),
        "disk_total_gb": round(data_total / 1e9, 1),
        "disk_used_gb": round(data_used / 1e9, 1),
        "disk_free_gb": round(data_free / 1e9, 1),
        "disk_percent": round((data_used / data_total * 100) if data_total else 0, 1),
        "disk_root_total_gb": round(root_total / 1e9, 1),
        "disk_root_used_gb": round(root_used / 1e9, 1),
        "disk_root_percent": round((root_used / root_total * 100) if root_total else 0, 1),
        "disk_read_mbps": round(max(0.0, disk_r), 2),
        "disk_write_mbps": round(max(0.0, disk_w), 2),
        "net_in_mbps": round(max(0.0, in_mbps), 2),
        "net_out_mbps": round(max(0.0, out_mbps), 2),
        "net_history": net_hist,
        "uptime_secs": int(uptime_secs),
        "uptime": human_age(uptime_secs),
    }

    with _lock:
        _last_system["ts"] = now
        _last_system["data"] = info
    return dict(info)


# -- PM2 process info ----------------------------------------------
def pm2_info():
    node_env = parse_env(NODE_ENV_PATH)
    pm2_name = node_env.get("OCTRA_OPERATOR_PM2_NAME", "octra-validator-01")

    def _parse(stdout):
        try:
            entries = json.loads(stdout)
            entry = next((e for e in entries if e.get("name") == pm2_name), None)
            if not entry:
                entry = next(
                    (e for e in entries if "octra" in (e.get("name") or "").lower()),
                    None,
                )
            if not entry:
                return {"status": "offline", "name": pm2_name}
            env = entry.get("pm2_env", {}) or {}
            mon = entry.get("monit", {}) or {}
            started_ms = env.get("pm_uptime") or 0
            uptime_secs = int((time.time() * 1000 - started_ms) / 1000) if started_ms else 0
            return {
                "status": env.get("status", "unknown"),
                "name": entry.get("name", pm2_name),
                "pid": entry.get("pid", 0),
                "uptime": human_age(uptime_secs) if uptime_secs else "unknown",
                "uptime_secs": uptime_secs,
                "restarts": env.get("restart_time", 0),
                "cpu": round(_num(mon.get("cpu")), 1),
                "memory_mb": round(_num(mon.get("memory")) / (1024 * 1024), 1),
                "exec_mode": env.get("exec_mode", ""),
                "instances": env.get("instances", 1),
                "node_version": env.get("node_version") or env.get("exec_interpreter") or "",
            }
        except Exception:
            return None

    for cmd in (
        ["su", "-", "octra", "-c", "pm2 jlist --silent"],
        ["pm2", "jlist", "--silent"],
    ):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            result = _parse(r.stdout)
            if result:
                return result
        except Exception:
            pass

    return {"status": "unavailable", "name": pm2_name}


# -- Log tail + parsing --------------------------------------------
LOG_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}T\S+)\s+"
    r"(?P<level>TRACE|DEBUG|INFO|WARN|WARNING|ERROR|ERR|FATAL)\b\s*(?P<rest>.*)$"
)
FIELD_RE = re.compile(r"(\w+)\s*=\s*([^\s]+)")

LEVEL_MAP = {
    "TRACE": "trace",
    "DEBUG": "debug",
    "INFO": "info",
    "WARN": "warn",
    "WARNING": "warn",
    "ERROR": "error",
    "ERR": "error",
    "FATAL": "fatal",
}


def parse_log_line(line, src="stdout"):
    line = line.rstrip("\n")
    entry = {
        "src": src,
        "msg": line,
        "level": "info",
        "ts": "",
        "component": "",
        "event": "",
        "detail": line,
        "fields": {},
    }
    m = LOG_RE.match(line)
    if m:
        entry["ts"] = m.group("ts")
        entry["level"] = LEVEL_MAP.get(m.group("level"), "info")
        rest = m.group("rest")
        fields = {}
        for k, v in FIELD_RE.findall(rest):
            fields[k] = v
        entry["fields"] = fields
        entry["component"] = fields.get("component", "")
        entry["event"] = fields.get("event", "")
        entry["detail"] = rest
        # Facts worth surfacing directly in the UI
        for key in ("epoch", "height", "round", "conn", "peer_class", "reason", "vote_epoch"):
            if key in fields:
                entry[key] = fields[key]
    else:
        low = line.lower()
        if "error" in low or "fatal" in low:
            entry["level"] = "error"
        elif "warn" in low:
            entry["level"] = "warn"
    return entry


def pm2_log_paths():
    node_env = parse_env(NODE_ENV_PATH)
    pm2_name = node_env.get("OCTRA_OPERATOR_PM2_NAME", "octra-validator-01")
    return [
        Path(f"/root/.pm2/logs/{pm2_name}-out.log"),
        Path(f"/home/octra/.pm2/logs/{pm2_name}-out.log"),
        Path(f"/root/.pm2/logs/{pm2_name}-error.log"),
        Path(f"/home/octra/.pm2/logs/{pm2_name}-error.log"),
    ]


def pm2_log_tail(lines=MAX_LOG_LINES):
    """Return the last N parsed log lines (oldest -> newest)."""
    collected = []
    for log_path in pm2_log_paths():
        if not log_path.is_file():
            continue
        try:
            r = subprocess.run(
                ["tail", "-n", str(lines), str(log_path)],
                capture_output=True,
                text=True,
                timeout=4,
            )
            src = "stderr" if "error" in log_path.name else "stdout"
            raw = [ln for ln in r.stdout.splitlines() if ln.strip()]
            collected = [parse_log_line(ln, src=src) for ln in raw]
        except Exception:
            pass
        if collected:
            break

    if not collected:
        node_env = parse_env(NODE_ENV_PATH)
        pm2_name = node_env.get("OCTRA_OPERATOR_PM2_NAME", "octra-validator-01")
        try:
            r = subprocess.run(
                ["su", "-", "octra", "-c",
                 f"pm2 logs {pm2_name} --lines {lines} --nostream --raw 2>&1"],
                capture_output=True, text=True, timeout=8,
            )
            raw = [ln for ln in r.stdout.splitlines() if ln.strip()]
            collected = [parse_log_line(ln, src="pm2") for ln in raw[-lines:]]
        except Exception:
            pass

    return collected[-lines:]


def pm2_log_tail_cached(lines=200):
    """Log tail shared by /api/status and /api/logs (2 s cache)."""
    now = time.time()
    with _lock:
        if _log_cache["data"] and (now - _log_cache["ts"]) < 2.0 and _log_cache["lines"] >= lines:
            return _log_cache["data"][-lines:]
    size = max(lines, 200)
    data = pm2_log_tail(size)
    with _lock:
        _log_cache.update({"ts": now, "lines": size, "data": data})
    return data[-lines:]


def log_summary(entries):
    """Counts per level + the newest notable event for the health panel."""
    counts = {"trace": 0, "debug": 0, "info": 0, "warn": 0, "error": 0, "fatal": 0}
    last_warn = None
    last_error = None
    for e in entries:                      # oldest -> newest
        lvl = e.get("level", "info")
        counts[lvl] = counts.get(lvl, 0) + 1
        if lvl == "warn":
            last_warn = e
        elif lvl in ("error", "fatal"):
            last_error = e
    return {
        "counts": counts,
        "total": len(entries),
        "last_warn": last_warn,
        "last_error": last_error,
    }


# -- Derived: consensus / peers / epoch rate -----------------------
def _vote_block(votes):
    """Normalise one prevote/precommit bucket into comparable numbers."""
    voters = 0
    weight = 0
    proposals = 0
    rows = []
    if isinstance(votes, list):
        for v in votes:
            if not isinstance(v, dict):
                continue
            voters += _int(v.get("voters"))
            weight += _int(v.get("weight"))
            proposals += 1
            rows.append({
                "proposal_id": str(v.get("proposal_id") or ""),
                "voters": _int(v.get("voters")),
                "weight": _int(v.get("weight")),
            })
    rows.sort(key=lambda r: r["weight"], reverse=True)
    return {"voters": voters, "weight": weight, "proposals": proposals, "rows": rows}


def consensus_block(peers_result):
    """Consensus round details derived from octra_consensusPeerStates."""
    if not peers_result:
        return {
            "available": False,
            "voting": "unavailable",
            "voting_reason": "",
            "step": "unknown",
            "round": None,
            "epoch": None,
            "agreed": None,
            "participants": {"total": 0, "propose": 0, "prevote": 0, "precommit": 0, "newest_age_sec": None},
            "quorum": {"prevotes": 0, "precommits": 0, "quorum": 0,
                       "prevote_pct": 0.0, "precommit_pct": 0.0,
                       "prevote_weight_pct": 0.0, "precommit_weight_pct": 0.0,
                       "quorum_weight": 0},
            "proposals": [],
        }

    round_state = peers_result.get("round_state") or {}
    votes = peers_result.get("round_votes") or {}
    quorum = _int(votes.get("quorum"))
    quorum_weight = _int(votes.get("quorum_weight"))

    prevotes = _vote_block(votes.get("prevotes"))
    precommits = _vote_block(votes.get("precommits"))

    participants = peers_result.get("round_peers") or []
    steps = {"propose": 0, "prevote": 0, "precommit": 0}
    newest_age = None
    if isinstance(participants, list):
        for p in participants:
            if not isinstance(p, dict):
                continue
            step = str(p.get("step") or "").lower()
            if step in steps:
                steps[step] += 1
            age = _num(p.get("age_sec"), -1)
            if age >= 0 and (newest_age is None or age < newest_age):
                newest_age = age

    voting = peers_result.get("voting")
    if voting is True:
        voting_state = "enabled"
    elif voting is False:
        voting_state = "disabled"
    else:
        voting_state = "unknown"

    def pct(value, total):
        return round(min(100.0, value / total * 100), 1) if total else 0.0

    return {
        "available": True,
        "voting": voting_state,
        "voting_reason": peers_result.get("voting_reason") or "",
        "step": str(round_state.get("step") or "unknown"),
        "round": _int(round_state.get("round"), -1),
        "epoch": _int(round_state.get("epoch_id")),
        "agreed": peers_result.get("round_agreed"),
        "participants": {
            "total": len(participants) if isinstance(participants, list) else 0,
            "propose": steps["propose"],
            "prevote": steps["prevote"],
            "precommit": steps["precommit"],
            "newest_age_sec": round(newest_age, 1) if newest_age is not None else None,
        },
        "quorum": {
            "prevotes": prevotes["voters"],
            "precommits": precommits["voters"],
            "prevote_proposals": prevotes["proposals"],
            "quorum": quorum,
            "quorum_weight": quorum_weight,
            "prevote_weight": prevotes["weight"],
            "precommit_weight": precommits["weight"],
            "prevote_pct": pct(prevotes["voters"], quorum),
            "precommit_pct": pct(precommits["voters"], quorum),
            "prevote_weight_pct": pct(prevotes["weight"], quorum_weight),
            "precommit_weight_pct": pct(precommits["weight"], quorum_weight),
        },
        "proposals": prevotes["rows"][:8],
    }


def peers_block(peers_result, local_head, epoch_interval=None):
    """Peer mesh health: lag vs record age (drift), stale records, bans."""
    interval = epoch_interval if isinstance(epoch_interval, (int, float)) and epoch_interval > 0 else 0.0
    block = {
        "available": bool(peers_result),
        "connected": 0,
        "known": 0,
        "public_sources": 0,
        "consensus_peers": 0,
        "network_head": local_head,
        "lag_max": 0,
        "drift_max": 0,
        "drift_median": 0,
        "behind_count": 0,
        "synced_count": 0,
        "ahead_count": 0,
        "stale_count": 0,
        "banned_count": 0,
        "paused_count": 0,
        "top": [],
    }
    if not peers_result:
        return block

    diag = peers_result.get("p2p_diagnostics") or {}
    records = peers_result.get("peers") or []
    scores = peers_result.get("scores") or []

    block["connected"] = _int(diag.get("connected"))
    block["known"] = _int(diag.get("known"))
    block["public_sources"] = _int(diag.get("public_sources"))
    block["consensus_peers"] = len(records) if isinstance(records, list) else 0

    fresh_lags = []
    heads = []
    stale = 0
    rows = []

    for rec in records if isinstance(records, list) else []:
        if not isinstance(rec, dict):
            continue
        head = _int(rec.get("head_epoch"))
        if head <= 0:
            continue
        age = _num(rec.get("age_sec"), 0.0)
        lag = max(0, local_head - head)
        heads.append(head)

        rec_stale = age > STALE_PEER_S
        recent = age <= FRESH_PEER_S
        expected = (age / interval) if interval else 0.0
        drift = max(0, int(round(lag - expected)))
        if rec_stale:
            stale += 1
        elif recent:
            fresh_lags.append(drift)
            if drift > 3:
                block["behind_count"] += 1
            elif drift <= 1:
                block["synced_count"] += 1

        if head > local_head:
            block["ahead_count"] += 1

        raw_addr = str(rec.get("responder_addr") or "")
        rows.append({
            "addr": ascii_text(raw_addr),
            "short": peer_label(raw_addr),
            "head_epoch": head,
            "lag": lag,
            "drift": drift,
            "age_sec": round(age, 1),
            "stale": rec_stale,
            "recent": recent,
            "source": ascii_text(rec.get("source") or ""),
        })

    block["stale_count"] = stale
    block["network_head"] = max(heads) if heads else local_head
    block["lag_max"] = max(0, local_head - block["network_head"])
    if fresh_lags:
        ordered = sorted(fresh_lags)
        mid = len(ordered) // 2
        block["drift_max"] = ordered[-1]
        block["drift_median"] = (
            ordered[mid] if len(ordered) % 2 else round((ordered[mid - 1] + ordered[mid]) / 2, 1)
        )

    banned = paused = 0
    for sc in scores if isinstance(scores, list) else []:
        if not isinstance(sc, dict):
            continue
        if _num(sc.get("ban_remaining_sec")) > 0:
            banned += 1
        if _num(sc.get("pause_remaining_sec")) > 0:
            paused += 1
    block["banned_count"] = banned
    block["paused_count"] = paused

    # Early-warning view: recent records with the biggest lag first, then stale
    rows.sort(key=lambda r: (0 if r["recent"] else (2 if r["stale"] else 1), -r["lag"], r["age_sec"]))
    block["top"] = rows[:8]
    return block


def epoch_block(local_head):
    """Epoch progress rate, average epoch interval and stall detection."""
    now = time.time()
    with _lock:
        if not _epoch_history or _epoch_history[-1][1] != local_head:
            _epoch_history.append([round(now, 3), local_head])
        all_points = list(_epoch_history)

    points = [p for p in all_points if now - p[0] <= 300]
    rate = 0.0
    interval = None
    if len(points) >= 2:
        dt = points[-1][0] - points[0][0]
        d_epoch = points[-1][1] - points[0][1]
        if dt > 0:
            rate = round(d_epoch / dt * 60, 2)
        if d_epoch > 0:
            interval = round(dt / d_epoch, 1)

    last_change_age = round(max(0.0, now - all_points[-1][0]), 1) if all_points else 0.0
    stalled = bool(all_points) and last_change_age > max(60.0, (interval or 20.0) * 4)

    return {
        "rate_per_min": rate,
        "interval_sec": interval,
        "last_change_age_sec": last_change_age,
        "stalled": stalled,
        "window_sec": 300,
        "history": [[round(p[0], 1), p[1]] for p in all_points[-120:]],
    }


def availability_block():
    with _lock:
        samples = list(_avail_history)
    ok = sum(samples)
    pct = round(ok / len(samples) * 100, 1) if samples else 100.0
    return {"samples": len(samples), "healthy": ok, "availability_pct": pct}


# -- Wallet: balance, stake and reward attribution -----------------
#
# Rewards are credited to the ledger balance at every epoch, so a plain
# "balance now - balance at setup" delta also moves when the operator sends
# transactions. The dashboard therefore keeps an additive index instead:
# every `component = epoch event = reward` line in the node's operator log
# carries the epoch pot (`each` for a validator, `proposer_total` for the
# proposer) and the proposer address prefix. Folding those lines gives exact
# per-epoch attribution plus a local proposer counter, independent of any
# wallet transfers. The balance baseline captured at setup remains available
# as a cross-check (and covers epochs that already rotated out of the log).
def token_amount(raw):
    """Ledger raw units -> OCTRA amount (6 decimals)."""
    try:
        return round(int(raw) / TOKEN_UNIT, TOKEN_DECIMALS)
    except (TypeError, ValueError):
        return 0.0


def iso_utc(ts):
    try:
        ts = float(ts)
    except (TypeError, ValueError):
        return ""
    if ts <= 0:
        return ""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def epoch_seconds(iso):
    """`2026-10-29T07:23:37.123Z` -> seconds since the epoch (0 when invalid)."""
    text = str(iso or "").strip()
    if len(text) < 19:
        return 0.0
    try:
        return float(calendar.timegm(time.strptime(text[:19], "%Y-%m-%dT%H:%M:%S")))
    except (ValueError, TypeError):
        return 0.0


def _pick_state_path():
    override = os.environ.get(WALLET_STATE_ENV)
    if override:
        return Path(override)
    for folder in WALLET_STATE_DIRS:
        try:
            folder.mkdir(parents=True, exist_ok=True)
            if os.access(str(folder), os.W_OK):
                return folder / "wallet_state.json"
        except OSError:
            continue
    return DASHBOARD_DIR / "wallet_state.json"


def wallet_state_path():
    if _wallet_state_file["path"] is None:
        _wallet_state_file["path"] = _pick_state_path()
    return _wallet_state_file["path"]


def empty_tracking():
    return {
        "log_path": "",
        "offset": 0,
        "tail": "",
        "pending_epoch": 0,
        "log_size": 0,
        "first_epoch": 0,
        "last_epoch": 0,
        "proposals": 0,
        "reward_cursor": 0,
        "reward_raw": 0,
        "reward_epochs": 0,
        "proposer_raw": 0,
        "validator_raw": 0,
        "last_reward_epoch": 0,
        "last_reward_raw": 0,
        "last_reward_at": "",
        "last_reward_proposer": False,
        "first_reward_at": "",
        "started_ts": 0.0,
        "updated_ts": 0.0,
        "recent": [],
    }


def wallet_state_load():
    try:
        state = json.loads(wallet_state_path().read_text())
    except Exception:
        return {}
    return state if isinstance(state, dict) else {}


def wallet_state_save(state):
    path = wallet_state_path()
    tmp = path.with_name(path.name + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(state, indent=2, sort_keys=True))
        os.replace(str(tmp), str(path))
        return True
    except OSError:
        return False


def wallet_state_init(address, account, epoch, source="setup", force=False):
    """Capture the balance baseline. Returns (state, created).

    `force` re-snapshots the balance but keeps the existing log index, so the
    proposer counter and reward totals survive a manual re-baseline.
    """
    state = wallet_state_load()
    same_wallet = state.get("address") == address
    baseline = state.get("baseline") or {}
    if same_wallet and baseline.get("balance_raw") is not None and not force:
        return state, False

    balance_raw = _int((account or {}).get("balance_raw"))
    tracking = state.get("tracking") if same_wallet else None
    fresh = {
        "version": 1,
        "address": address,
        "baseline": {
            "balance_raw": balance_raw,
            "balance": token_amount(balance_raw),
            "nonce": _int((account or {}).get("nonce")),
            "epoch": _int(epoch),
            "ts": round(time.time(), 3),
            "source": source,
        },
        "tracking": tracking if isinstance(tracking, dict) and tracking else empty_tracking(),
    }
    wallet_state_save(fresh)
    return fresh, True


def node_log_path():
    """Locate the node's operator log (pm2 writes the node output there)."""
    override = os.environ.get("OCTRA_NODE_LOG")
    candidates = []
    if override:
        candidates.append(Path(override))
    name = parse_env(NODE_ENV_PATH).get("OCTRA_OPERATOR_PM2_NAME", "octra-validator-01")
    candidates.extend([
        NODE_SRC_DIR / "data" / "operator_logs" / "node.log",
        Path(f"/home/octra/.pm2/logs/{name}-out.log"),
        Path(f"/root/.pm2/logs/{name}-out.log"),
    ])
    for path in candidates:
        try:
            if path.is_file():
                return path
        except OSError:
            continue
    return None


LOG_FIELD_RE = re.compile(r"(\w+) = (\S+)")


def fold_log_block(text, tracking, address, eligible_from=0):
    """Fold a block of operator-log lines into `tracking` (in place).

    Only `component = epoch` lines are inspected:

      * `component = epoch proposer ... epoch = N addr = ...`  -> epoch window + cursor
      * `component = epoch event = reward ... proposer = ...`  -> reward attribution

    The node truncates addresses to 12 chars + "..", which is enough to
    recognise the local validator. Rewards are attributed as
    `proposer_total + each` when the local wallet proposed the epoch (the
    proposer also receives its validator share) and `each` otherwise.
    """
    prefix = address[:LOG_ADDR_PREFIX]
    cursor = _int(tracking.get("reward_cursor"))
    pending = _int(tracking.get("pending_epoch"))
    first = _int(tracking.get("first_epoch"))
    last = _int(tracking.get("last_epoch"))
    recent = list(tracking.get("recent") or [])
    first_at = str(tracking.get("first_reward_at") or "")
    changed = False

    for line in text.splitlines():
        if "component = epoch" not in line:
            continue
        fields = dict(LOG_FIELD_RE.findall(line))
        epoch = _int(fields.get("epoch"), -1)
        if epoch > 0:
            pending = epoch
            changed = True

        if fields.get("event") != "reward":
            continue
        if pending <= 0 or pending <= cursor:
            continue
        cursor = pending
        if eligible_from and pending < eligible_from:
            continue
        if _int(fields.get("validators")) <= 0:
            continue
        each = _int(fields.get("each"))
        proposer_total = _int(fields.get("proposer_total"))
        # The node prints addresses truncated as "<12 chars>.." - trailing dots
        # carry no meaning for a full address, so drop them before comparing.
        is_proposer = str(fields.get("proposer") or "").rstrip(".") == prefix
        amount = (proposer_total + each) if is_proposer else each
        if amount <= 0:
            continue

        tracking["reward_raw"] = _int(tracking.get("reward_raw")) + amount
        tracking["reward_epochs"] = _int(tracking.get("reward_epochs")) + 1
        if is_proposer:
            tracking["proposals"] = _int(tracking.get("proposals")) + 1
            tracking["proposer_raw"] = _int(tracking.get("proposer_raw")) + amount
        else:
            tracking["validator_raw"] = _int(tracking.get("validator_raw")) + amount
        tracking["last_reward_epoch"] = pending
        tracking["last_reward_raw"] = amount
        tracking["last_reward_at"] = line[:24]
        tracking["last_reward_proposer"] = is_proposer
        if not first_at:
            first_at = line[:24]
            tracking["first_reward_at"] = first_at
        if first <= 0:
            first = pending
        if pending > last:
            last = pending
        recent.append([pending, "proposer" if is_proposer else "validator", amount, line[:24]])
        if len(recent) > WALLET_RECENT_MAX:
            recent = recent[-WALLET_RECENT_MAX:]
        changed = True

    if changed:
        tracking["pending_epoch"] = pending
        tracking["reward_cursor"] = cursor
        tracking["first_epoch"] = first
        tracking["last_epoch"] = last
        tracking["recent"] = recent
    return changed


def wallet_scan_log(address, eligible_from=0):
    """Index one bounded slice of the operator log. Returns True when it ran."""
    global _wallet_scanning
    path = node_log_path()
    if path is None:
        return False
    with _lock:
        if _wallet_scanning:
            return False
        _wallet_scanning = True
    try:
        tracking = dict(wallet_state_load().get("tracking") or empty_tracking())
        try:
            size = path.stat().st_size
        except OSError:
            return False
        offset = _int(tracking.get("offset"))
        # A small overshoot is normal: the node appends between stat and read.
        if offset > 0 and size + 4096 < offset:
            offset = 0                      # log rotated or truncated -> re-index
        elif offset > 0:
            # Guard against pm2 rotating the log behind our back: compare the
            # bytes we already consumed with what is on disk now.
            try:
                expected = base64.b64decode(str(tracking.get("tail") or ""))
            except (ValueError, TypeError):
                expected = b""
            if expected:
                try:
                    with open(path, "rb") as handle:
                        handle.seek(max(0, offset - len(expected)))
                        actual = handle.read(len(expected))
                    if actual != expected:
                        offset = 0
                except OSError:
                    return False
        now = time.time()
        if size <= offset:
            tracking["log_path"] = str(path)
            tracking["log_size"] = max(size, offset)
            tracking["updated_ts"] = round(now, 3)
            tracking["started_ts"] = tracking.get("started_ts") or round(now, 3)
            state = wallet_state_load()
            state["tracking"] = tracking
            wallet_state_save(state)
            return True

        try:
            with open(path, "rb") as handle:
                handle.seek(offset)
                chunk = handle.read(WALLET_SCAN_BYTES)
        except OSError:
            return False
        cut = chunk.rfind(b"\n")
        if cut < 0:
            return False                    # no complete line yet
        block = chunk[: cut + 1]

        fold_log_block(block.decode("utf-8", "replace"), tracking, address, eligible_from)

        with _lock:
            state = wallet_state_load()
            merged = state.get("tracking")
            if not isinstance(merged, dict):
                merged = empty_tracking()
            for key in ("pending_epoch", "first_epoch", "last_epoch", "proposals",
                        "reward_cursor", "reward_raw", "reward_epochs", "proposer_raw",
                        "validator_raw", "last_reward_epoch", "last_reward_raw",
                        "last_reward_at", "last_reward_proposer", "first_reward_at"):
                merged[key] = tracking.get(key, merged.get(key))
            merged["recent"] = tracking.get("recent") or merged.get("recent") or []
            merged["offset"] = offset + len(block)
            merged["tail"] = base64.b64encode(block[-32:]).decode("ascii")
            merged["log_path"] = str(path)
            merged["log_size"] = max(size, offset + len(block))
            merged["updated_ts"] = round(time.time(), 3)
            if not merged.get("started_ts"):
                merged["started_ts"] = round(time.time(), 3)
            state["tracking"] = merged
            wallet_state_save(state)
        return True
    finally:
        with _lock:
            _wallet_scanning = False


def wallet_rpc_snapshot(api_port, address):
    """Account + validator enrollment, shared by all clients for a few seconds.

    Only the two cheap reads are synchronous: `octra_balance` (~0.1 s) and
    `octra_validatorEnrollment` (~0.1 s). `octra_account` costs 10-20 s on a
    busy node because it walks the tx history, so its extra fields (tx count,
    encrypted-balance flag) come from a background thread instead - see
    `wallet_deep_account`.
    """
    now = time.time()
    with _lock:
        cached = _wallet_rpc["data"]
        if cached and _wallet_rpc["address"] == address and (now - _wallet_rpc["ts"]) < WALLET_RPC_TTL:
            return cached
    balance = rpc_call_method(api_port, "octra_balance", [address], timeout=6)
    enrollment = rpc_call_method(api_port, "octra_validatorEnrollment", [address], timeout=6)
    detail = wallet_deep_account(api_port, address)
    data = {
        "balance": balance if isinstance(balance, dict) else None,
        "enrollment": enrollment if isinstance(enrollment, dict) else None,
        "detail": detail if isinstance(detail, dict) else None,
        "ts": round(time.time(), 3),
    }
    with _lock:
        _wallet_rpc.update({"ts": now, "address": address, "data": data})
    return data


def wallet_deep_account(api_port, address):
    """`octra_account` detail, fetched in the background with a long TTL.

    Returns the last good sample (or None while the first one is still being
    collected) so a poll never blocks on the slow history query.
    """
    now = time.time()
    with _lock:
        same = _wallet_deep["address"] == address
        data = _wallet_deep["data"] if same else None
        if data is not None and (now - _wallet_deep["ts"]) < WALLET_DEEP_TTL:
            return data
        if _wallet_deep["running"] or (now - _wallet_deep["attempt"]) < WALLET_DEEP_RETRY:
            return data
        _wallet_deep["address"] = address
        _wallet_deep["attempt"] = now
        _wallet_deep["running"] = True

    def worker():
        result = rpc_call_method(api_port, "octra_account", [address], timeout=60)
        with _lock:
            if isinstance(result, dict):
                _wallet_deep["data"] = result
                _wallet_deep["ts"] = time.time()
            _wallet_deep["running"] = False

    threading.Thread(target=worker, name="wallet-account", daemon=True).start()
    return data



def wallet_scan_due(tracking):
    caught_up = (_int(tracking.get("log_size")) > 0 and
                 _int(tracking.get("offset")) >= _int(tracking.get("log_size")))
    ttl = WALLET_SCAN_TTL if caught_up else WALLET_CATCHUP
    return (time.time() - _num(tracking.get("updated_ts"))) >= ttl


def wallet_skeleton(address=""):
    """Full payload shaped up front so the UI never guards for missing keys."""
    return {
        "available": False,
        "address": address,
        "reason": "Wallet address is not configured on this node",
        "balance": 0.0,
        "balance_raw": "0",
        "holdings": 0.0,
        "nonce": 0,
        "pending_nonce": 0,
        "tx_count": 0,
        "tx_count_known": False,
        "detail_known": False,
        "has_public_key": False,
        "encrypted_balance": False,
        "bond": 0.0,
        "bond_raw": "0",
        "state": "unknown",
        "bonded_epoch": 0,
        "ready_epoch": 0,
        "exit_epoch": 0,
        "epochs_in_set": 0,
        "membership": {"active": False, "scheduled": False,
                       "activate_epoch": 0, "next_set_epoch": 0},
        "duty": {"automatic": False, "required_span": 0, "max_gap": 0, "last_pulse": None},
        "rewards": {
            "total": 0.0, "total_raw": "0", "epochs": 0,
            "proposer": 0.0, "proposer_raw": "0", "proposer_epochs": 0,
            "validator": 0.0, "validator_raw": "0",
            "avg_per_epoch": 0.0, "est_per_day": 0.0, "epochs_per_day": 0.0,
            "share_pct": 0.0,
            "last_epoch": 0, "last_amount": 0.0, "last_role": "",
            "last_at": "", "epochs_since": None, "recent": [],
        },
        "baseline": {
            "balance": 0.0, "balance_raw": "0", "epoch": 0,
            "at": "", "age_sec": None, "source": "",
            "delta": 0.0, "delta_raw": "0",
        },
        "tracking": {
            "log_path": "", "state_file": "", "indexed_bytes": 0, "log_size": 0,
            "progress_pct": 100.0, "first_epoch": 0, "last_epoch": 0,
            "span_epochs": 0, "since": "", "updated": "",
        },
    }


def wallet_block(api_port, node):
    """Balance, stake, proposer count and reward attribution for the wallet."""
    address = node.get("address") or ""
    head_epoch = _int(node.get("head_epoch"))
    block = wallet_skeleton("" if address == "unknown" else address)
    if not address or address == "unknown":
        return block

    snap = wallet_rpc_snapshot(api_port, address)
    account = snap.get("balance") or {}
    enrollment = snap.get("enrollment") or {}
    detail = snap.get("detail") or {}
    if not account and not enrollment:
        block["reason"] = "node RPC did not answer octra_balance / octra_validatorEnrollment"
        return block

    balance_raw = _int(account.get("balance_raw"))
    bond_raw = _int(enrollment.get("bond"))
    bonded_epoch = _int(enrollment.get("bonded_epoch"))
    membership = enrollment.get("membership") or {}
    duty = enrollment.get("duty") or {}

    state = wallet_state_load()
    if state.get("address") != address or not state.get("baseline"):
        state, _ = wallet_state_init(address, account, head_epoch,
                                     source="first dashboard observation")
    tracking = dict(state.get("tracking") or empty_tracking())
    if wallet_scan_due(tracking) and wallet_scan_log(address, bonded_epoch):
        state = wallet_state_load()
        tracking = dict(state.get("tracking") or empty_tracking())

    baseline = state.get("baseline") or {}
    baseline_raw = _int(baseline.get("balance_raw"))

    reward_raw = _int(tracking.get("reward_raw"))
    reward_epochs = _int(tracking.get("reward_epochs"))
    proposals = _int(tracking.get("proposals"))
    first_epoch = _int(tracking.get("first_epoch"))
    last_epoch = _int(tracking.get("last_epoch"))
    last_reward_epoch = _int(tracking.get("last_reward_epoch"))
    span = (last_epoch - first_epoch + 1) if first_epoch and last_epoch >= first_epoch else 0
    interval = _num((node.get("epochs") or {}).get("interval_sec"))
    avg_raw = (reward_raw / reward_epochs) if reward_epochs else 0.0
    # Prefer the measured rate of the indexed window (robust right after a
    # deploy); fall back to the live epoch interval once that is known.
    epochs_per_day = 0.0
    first_ts = epoch_seconds(tracking.get("first_reward_at"))
    last_ts = epoch_seconds(tracking.get("last_reward_at"))
    if reward_epochs > 1 and last_ts > first_ts + 300:
        epochs_per_day = (reward_epochs - 1) / (last_ts - first_ts) * 86400.0
    if epochs_per_day <= 0 and interval > 0:
        epochs_per_day = 86400.0 / interval
    per_day_raw = avg_raw * epochs_per_day if epochs_per_day else 0.0
    offset = _int(tracking.get("offset"))
    log_size = _int(tracking.get("log_size"))

    block.update({
        "available": True,
        "reason": "",
        "balance": token_amount(balance_raw),
        "balance_raw": str(balance_raw),
        "holdings": token_amount(balance_raw + bond_raw),
        "nonce": _int(account.get("nonce")),
        "pending_nonce": _int(account.get("pending_nonce")),
        "tx_count": _int(detail.get("tx_count")),
        "tx_count_known": bool(detail),
        "has_public_key": bool(account.get("has_public_key")),
        "encrypted_balance": bool(detail.get("has_encrypted_balance")),
        "detail_known": bool(detail),
        "bond": token_amount(bond_raw),
        "bond_raw": str(bond_raw),
        "state": str(enrollment.get("state") or "unknown"),
        "bonded_epoch": bonded_epoch,
        "ready_epoch": _int(enrollment.get("ready_epoch")),
        "exit_epoch": _int(enrollment.get("exit_epoch")),
        "epochs_in_set": max(0, head_epoch - bonded_epoch) if bonded_epoch else 0,
        "membership": {
            "active": bool(membership.get("active")),
            "scheduled": bool(membership.get("scheduled")),
            "activate_epoch": _int(membership.get("activate_epoch")),
            "next_set_epoch": _int(membership.get("next_set_epoch")),
        },
        "duty": {
            "automatic": bool(duty.get("automatic")),
            "required_span": _int(duty.get("required_span")),
            "max_gap": _int(duty.get("max_gap")),
            "last_pulse": duty.get("last_pulse"),
        },
    })
    return _wallet_reward_block(block, tracking, baseline, baseline_raw, balance_raw,
                                head_epoch, span, avg_raw, per_day_raw, offset, log_size,
                                epochs_per_day)


def _wallet_reward_block(block, tracking, baseline, baseline_raw, balance_raw,
                         head_epoch, span, avg_raw, per_day_raw, offset=0, log_size=0,
                         epochs_per_day=0.0, bonded_epoch=0, nonce=0):
    """Reward attribution + baseline cross-check for `wallet_block`.

    The headline total is the balance delta since the setup snapshot, because
    the log is only a partial view. That delta is exact only while nothing else
    moved the wallet; a bond that started before the snapshot or a transaction
    signed after it both blur the number, so the block says so (`est` + `note`)
    and keeps the gross log fold next to it as a cross-check.
    """
    reward_raw = _int(tracking.get("reward_raw"))
    reward_epochs = _int(tracking.get("reward_epochs"))
    proposals = _int(tracking.get("proposals"))
    last_reward_epoch = _int(tracking.get("last_reward_epoch"))

    gross_raw = reward_raw                       # the log fold, independent view
    baseline_epoch = _int(baseline.get("epoch"))
    has_baseline = bool(baseline) and baseline_raw > 0
    if has_baseline:
        total_raw = balance_raw - baseline_raw
        method = "balance-delta"
        covered = max(0, head_epoch - baseline_epoch)
    else:
        total_raw = gross_raw
        method = "log-fold"
        covered = reward_epochs

    base_bond = _int(baseline.get("bonded_epoch")) or _int(bonded_epoch)
    bond_at = _int(bonded_epoch)                 # the bond epoch the node reports
    base_nonce = _int(baseline.get("nonce"))
    signed_since = max(0, _int(nonce) - base_nonce) if base_nonce else 0

    reasons = []
    if not has_baseline:
        reasons.append("no baseline snapshot yet, showing the log fold")
    if has_baseline and bond_at and baseline_epoch and bond_at < baseline_epoch:
        reasons.append("the bond started at epoch %d" % bond_at)
    if signed_since:
        reasons.append("signed %d tx after the snapshot" % signed_since)
    est = bool(reasons)
    note = ("; ".join(reasons) + " - estimate from the balance delta") if reasons \
        else "exact: balance delta with no other movement"

    # Split follows the gross proportion, then lands exactly on the total.
    proposer_raw = _int(tracking.get("proposer_raw"))
    validator_raw = _int(tracking.get("validator_raw"))
    if gross_raw and total_raw != gross_raw:
        proposer_raw = int(round(proposer_raw * total_raw / gross_raw))
        validator_raw = max(0, total_raw - proposer_raw)
    avg_value = (total_raw / covered) if covered else 0.0

    block["rewards"] = {
        "total": token_amount(total_raw),
        "total_raw": str(total_raw),
        "epochs": covered,
        "est": est,
        "method": method,
        "note": note,
        "log_total": token_amount(gross_raw),
        "log_total_raw": str(gross_raw),
        "log_ratio_pct": round(total_raw / gross_raw * 100, 1) if gross_raw else 0.0,
        "proposer": token_amount(proposer_raw),
        "proposer_raw": str(proposer_raw),
        "proposer_epochs": proposals,
        "validator": token_amount(validator_raw),
        "validator_raw": str(validator_raw),
        "avg_per_epoch": round(avg_value / TOKEN_UNIT, TOKEN_DECIMALS),
        "est_per_day": round(avg_value / TOKEN_UNIT * epochs_per_day, TOKEN_DECIMALS),
        "epochs_per_day": round(epochs_per_day, 1),
        "share_pct": round(proposals / span * 100, 1) if span else 0.0,
        "last_epoch": last_reward_epoch,
        "last_amount": token_amount(_int(tracking.get("last_reward_raw"))),
        "last_role": ("proposer" if tracking.get("last_reward_proposer") else "validator")
        if last_reward_epoch else "",
        "last_at": str(tracking.get("last_reward_at") or ""),
        "epochs_since": max(0, head_epoch - last_reward_epoch) if last_reward_epoch else None,
        "recent": [
            {"epoch": _int(row[0]), "role": str(row[1]),
             "amount": token_amount(_int(row[2])),
             "at": str(row[3]) if len(row) > 3 else ""}
            for row in list(tracking.get("recent") or [])[::-1]
        ],
    }

    age = (time.time() - _num(baseline.get("ts"))) if baseline.get("ts") else None
    block["baseline"] = {
        "balance": token_amount(baseline_raw),
        "balance_raw": str(baseline_raw),
        "epoch": baseline_epoch,
        "bonded_epoch": base_bond,
        "nonce": base_nonce,
        "signed_since": signed_since,
        "at": iso_utc(baseline.get("ts")),
        "age_sec": round(age, 1) if age is not None and age >= 0 else None,
        "source": str(baseline.get("source") or ""),
        "delta": token_amount(balance_raw - baseline_raw),
        "delta_raw": str(balance_raw - baseline_raw),
    }
    block["tracking"] = {
        "log_path": str(tracking.get("log_path") or ""),
        "state_file": str(wallet_state_path()),
        "indexed_bytes": offset,
        "log_size": log_size,
        "progress_pct": round(min(100.0, offset / log_size * 100), 1) if log_size else 100.0,
        "first_epoch": _int(tracking.get("first_epoch")),
        "last_epoch": _int(tracking.get("last_epoch")),
        "span_epochs": span,
        "since": iso_utc(tracking.get("started_ts")),
        "updated": iso_utc(tracking.get("updated_ts")),
    }
    return block


def init_wallet_state(reset=False):
    """CLI: capture (or re-capture) the wallet baseline. Returns an exit code."""
    api_port = get_api_port()
    status = rpc_get_status(api_port) or {}
    address = status.get("validator") or ""
    if not address:
        try:
            address = json.loads(
                (NODE_SRC_DIR / ".keys" / "validator" / "wallet.json").read_text()
            ).get("address", "")
        except Exception:
            address = ""
    if not address:
        print("wallet: validator address unknown (RPC and wallet.json unavailable)")
        return 1

    account = rpc_call_method(api_port, "octra_balance", [address], timeout=6) or {}
    epoch = _int(status.get("head_epoch") or status.get("current_epoch"))
    state, created = wallet_state_init(
        address, account, epoch,
        source="dashboard deploy" if not reset else "manual reset",
        force=reset,
    )
    baseline = state.get("baseline") or {}
    tracking = state.get("tracking") or {}
    verb = "captured" if created else "already captured"
    print(f"wallet: baseline {verb} for {address}")
    print(f"        balance   : {baseline.get('balance')} OCTRA "
          f"({baseline.get('balance_raw')} raw @ epoch {baseline.get('epoch')})")
    print(f"        state file: {wallet_state_path()}")
    print(f"        log index : {tracking.get('offset', 0)} bytes @ "
          f"{iso_utc(tracking.get('updated_ts')) or 'not started'}")
    return 0







# -- Status assembly -----------------------------------------------
def build_status():
    api_port = get_api_port()
    node_env = parse_env(NODE_ENV_PATH)

    status = rpc_get_status(api_port)
    peers_result = rpc_call_method(api_port, "octra_consensusPeerStates")

    node = {
        "rpc_ready": status is not None,
        "api_port": api_port,
        "role": node_env.get("OCTRA_OPERATOR_ROLE", "unknown"),
        "name": node_env.get("OCTRA_OPERATOR_PM2_NAME", "unknown"),
        "chain": node_env.get("OCTRA_CHAIN_ID", "unknown"),
        "data_dir": node_env.get("OCTRA_DATA_DIR", str(NODE_DATA_ROOT / "devnet")),
        "address": "unknown",
    }

    if status:
        node.update({
            "current_epoch": _int(status.get("current_epoch")),
            "head_epoch": _int(status.get("head_epoch") or status.get("current_epoch")),
            "state_root": status.get("state_root", ""),
            "irmin_commit": status.get("irmin_commit", ""),
            "txid_hi": str(status.get("txid_hi", "")),
            "accounts": _int(status.get("total_accounts")),
            "active_accounts": _int(status.get("active_accounts")),
            "total_supply": str(status.get("total_supply", "")),
            "circulating_supply": str(status.get("circulating_supply", "")),
            "encrypted_supply": str(status.get("encrypted_supply", "")),
            "network_version": status.get("network_version", ""),
            "storage_backend": status.get("storage_backend", ""),
            "root_count": _int(status.get("root_count")),
        })
        if status.get("validator"):
            node["address"] = status.get("validator")
        node["pending_epochs"] = max(
            0, node.get("current_epoch", 0) - node.get("head_epoch", 0)
        )

    # Wallet address fallback (when the RPC does not report a validator)
    if node["address"] == "unknown":
        for wallet_path in (
            NODE_SRC_DIR / ".keys" / "validator" / "wallet.json",
            Path(str(node.get("data_dir") or "")) / "wallet.json",
        ):
            if wallet_path.is_file():
                try:
                    node["address"] = json.loads(wallet_path.read_text()).get("address", "unknown")
                    break
                except Exception:
                    pass

    commit_path = NODE_SRC_DIR / "SOURCE_COMMIT"
    if commit_path.is_file():
        try:
            node["source_commit"] = commit_path.read_text().strip()[:12]
        except Exception:
            node["source_commit"] = ""
    node.setdefault("source_commit", "")

    consensus = consensus_block(peers_result)
    local_head = node.get("head_epoch", 0)
    node["epochs"] = epoch_block(local_head)
    peers = peers_block(peers_result, local_head, node["epochs"].get("interval_sec"))

    node["quorum_pct"] = consensus["quorum"].get("prevote_pct", 0.0)
    node["peer_max_lag"] = peers["lag_max"]

    node["process"] = pm2_info()
    proc_online = str(node["process"].get("status", "")).lower() == "online"

    if status is not None and consensus.get("voting") == "enabled":
        node["status"] = "validator_active"
    elif status is not None:
        node["status"] = "observer_synced"
    elif proc_online:
        node["status"] = "syncing"
    else:
        node["status"] = "offline"

    healthy = status is not None and proc_online
    with _lock:
        _avail_history.append(1 if healthy else 0)

    logs = log_summary(pm2_log_tail_cached(120))
    backend = availability_block()
    backend.update({
        "version": "2.1",
        "uptime_secs": int(time.time() - _start_time),
        "uptime": human_age(time.time() - _start_time),
    })

    return {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "server_time": round(time.time(), 3),
        "node": node,
        "consensus": consensus,
        "peers": peers,
        "wallet": wallet_block(api_port, node),
        "system": system_info(),
        "logs": logs,
        "backend": backend,
    }


def build_wallet():
    """Wallet block only - cheaper than /api/status for a wallet-only client."""
    api_port = get_api_port()
    status = rpc_get_status(api_port) or {}
    head = _int(status.get("head_epoch") or status.get("current_epoch"))
    node = {
        "address": status.get("validator") or "",
        "head_epoch": head,
        "epochs": epoch_block(head),
    }
    if not node["address"]:
        for wallet_path in (
            NODE_SRC_DIR / ".keys" / "validator" / "wallet.json",
            NODE_DATA_ROOT / "devnet" / "wallet.json",
        ):
            try:
                node["address"] = json.loads(wallet_path.read_text()).get("address", "")
                if node["address"]:
                    break
            except Exception:
                continue
    return {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "wallet": wallet_block(api_port, node)}


# -- HTTP handler --------------------------------------------------
class DashboardHandler(SimpleHTTPRequestHandler):
    server_version = "OctraDashboard/2.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DASHBOARD_DIR), **kwargs)

    # The monitor is read-only. Answer POST with a clear 405 instead of the base
    # class's bare 501, so a stale page (or an old bookmark) tells the operator
    # where the manage actions actually live.
    def do_POST(self):
        self._json(
            {"error": "this monitor is read-only - use the console's 'Manage active node' tab"},
            status=405,
        )

    def do_GET(self):
        parsed = urlparse(self.path)
        route = parsed.path
        try:
            if route == "/api/status":
                self._json(build_status())
            elif route == "/api/wallet":
                self._json(build_wallet())
            elif route == "/api/logs":
                qs = parse_qs(parsed.query)
                try:
                    lines = max(1, min(MAX_LOG_LINES, int(qs.get("lines", ["200"])[0])))
                except ValueError:
                    lines = 200
                levels = qs.get("level", [""])[0]
                entries = pm2_log_tail_cached(lines)
                if levels:
                    wanted = {l.strip().lower() for l in levels.split(",") if l.strip()}
                    entries = [
                        e for e in entries
                        if e.get("level") in wanted
                        or (e.get("level") == "fatal" and "error" in wanted)
                    ]
                self._json({"logs": entries, "summary": log_summary(entries)})
            elif route == "/api/ping":
                self._json({"ok": True, "server_time": round(time.time(), 3)})
            elif route.startswith("/api/"):
                self._json({"error": "unknown endpoint"}, status=404)
            else:
                super().do_GET()
        except BrokenPipeError:
            pass
        except Exception as exc:  # never kill the service on a bad request
            try:
                self._json({"error": str(exc)}, status=500)
            except Exception:
                pass

    def end_headers(self):
        # Static assets: let nginx add caching; the Python dev server stays fresh.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def _json(self, data, status=200):
        try:
            # ascii_deep(): the last line of defence - whatever the node, an RPC
            # error or a log line carried cannot reach the browser as non-ASCII
            body = json.dumps(ascii_deep(data), default=str).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            pass

    def log_message(self, fmt, *args):
        pass  # nginx handles access logging


# -- Main ----------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Octra node dashboard backend")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    # Bind to loopback: nginx (or an SSH tunnel) is the only intended client.
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--init-wallet", action="store_true",
                        help="capture the wallet reward baseline (idempotent) and exit")
    parser.add_argument("--reset-wallet", action="store_true",
                        help="re-capture the wallet balance baseline, keeping the log index")
    args = parser.parse_args()

    if args.init_wallet or args.reset_wallet:
        raise SystemExit(init_wallet_state(reset=args.reset_wallet))

    # Prime the counters so the first request already reports real rates.
    try:
        system_info()
        time.sleep(0.5)
        system_info()
    except Exception:
        pass

    httpd = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    print(f"Octra dashboard -> http://{args.host}:{args.port}")
    print("  /api/status   -> node, consensus, peers, wallet, system snapshot")
    print("  /api/wallet   -> wallet, stake and reward attribution only")
    print("  /api/logs     -> parsed log tail (?lines=N&level=warn,error)")
    print("  /api/ping     -> liveness probe")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
