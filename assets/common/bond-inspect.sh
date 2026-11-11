#!/usr/bin/env bash
# ===================================================================
# bond-inspect.sh - explain a bond_inc.sh refusal without signing anything
#
# bond_inc.sh keeps exactly ONE signed increase in
#     $OCTRA_DATA_DIR/validator-control/bond-increase.json
# Every later run compares that record with the arguments and the live
# registry; anything that differs is refused with
#     event = bond_inc status = refused reason = "saved increase differs;
#       inspect before requesting another increase"
# This script is read-only (no key is used, no transaction is submitted). It
# prints the saved record, the live registry view and a field-by-field verdict
# so the next command can be chosen on purpose.
#
# Usage:
#   sudo bash bond-inspect.sh                # inspect the saved increase as-is
#   sudo bash bond-inspect.sh -a 20          # ... and compare with a planned +20 OCT
#   sudo bash bond-inspect.sh -a 20 -w /opt/octra/libv_litecore/.keys/validator/wallet.json
#
# Options:
#   -a, --amount <oct>   the amount you would pass to `bond_inc.sh -a`
#   -w, --wallet <path>  wallet.json (default: <config dir>/wallet.json)
#       --config <path>  node.env (default: $NODE_SRC_DIR/.keys/validator/node.env)
# ===================================================================
set -euo pipefail
source "$(dirname "$0")/config.sh"

if [[ $EUID -ne 0 ]]; then
  err "Run as root:  sudo bash $0"
  exit 1
fi

AMOUNT=""
CONFIG="${NODE_SRC_DIR}/.keys/validator/node.env"
WALLET="${NODE_SRC_DIR}/.keys/validator/wallet.json"

while (( $# )); do
  case "$1" in
    -a|--amount) AMOUNT="${2:-}"; shift 2 ;;
    -w|--wallet) WALLET="${2:-}"; shift 2 ;;
    --config)    CONFIG="${2:-}"; shift 2 ;;
    -h|--help)   sed -n '3,23p' "$0"; exit 0 ;;
    *)           err "Unknown argument: $1"; exit 1 ;;
  esac
done

[[ -f "$CONFIG" ]] || { err "node.env not found: $CONFIG"; exit 1; }
[[ -f "$WALLET" ]] || { err "wallet not found: $WALLET"; exit 1; }

TMP=$(mktemp /tmp/bond-inspect.XXXXXX.py)
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

cat > "$TMP" <<'PY'
# Read-only inspection of a saved bond increase. Mirrors the guards of
# controls/lib (validator_enroll.committed_enrollment, bond_inc.identity,
# bond_inc.receipt) instead of importing them: the node modules are re-checked
# by bond_inc.sh itself when the real payment is signed.
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

FEE = 1000
STAGES = {"prepared", "sent", "accepted"}

def say(text = ""):
    print("[bond] " + text if text else "[bond] ")

def fail(text):
    print("[bond] ERROR: " + text, file = sys.stderr)
    raise SystemExit(1)

def oct_from_raw(raw):
    if type(raw) is not int or raw < 0:
        return "?"
    whole, fraction = divmod(raw, 1000000)
    return (f"{whole}.{fraction:06d}".rstrip("0").rstrip(".") or "0")

def parse_env(path):
    values = {}
    for line in path.read_text(encoding = "utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values

def call(url, method, params, *, missing = False, timeout = 10):
    body = json.dumps({"jsonrpc": "2.0", "id": int(time.time() * 1000) % 1000000,
        "method": method, "params": params}).encode("utf-8")
    request = urllib.request.Request(url, data = body, method = "POST", headers = {
        "Accept": "application/json", "Content-Type": "application/json",
        "User-Agent": "octra-validator-controls/1"})
    try:
        with urllib.request.urlopen(request, timeout = timeout) as response:
            payload = json.loads(response.read())
    except Exception as error:
        fail("the local node RPC is unreachable at " + url + " (" + str(error) + ")")
    if not isinstance(payload, dict):
        fail("invalid RPC response from " + url)
    if payload.get("error") is not None:
        error = payload["error"]
        if missing and isinstance(error, dict) and type(error.get("code")) is int and error["code"] == 112:
            return None
        fail("RPC " + method + " rejected: " + json.dumps(error, separators = (",", ":")))
    if "result" not in payload:
        fail("RPC " + method + " returned no result")
    if missing and payload["result"] is None:
        return None
    return payload["result"]

def raw_amount(text):
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]{1,6})?", text):
        fail("amount must be OCT with at most six decimal places")
    whole, _, fraction = text.partition(".")
    return int(whole) * 1000000 + int((fraction or "").ljust(6, "0"))

def integer(value):
    if type(value) is int:
        return value
    if isinstance(value, str) and value.isascii() and value.isdecimal():
        return int(value)
    return None

def main():
    config = Path(sys.argv[1])
    requested_text = (sys.argv[2] or "").strip()
    wallet_path = Path(sys.argv[3])
    node_dir = Path(sys.argv[4]).expanduser() if len(sys.argv) > 4 else Path("/opt/octra/libv_litecore")
    values = parse_env(config)
    if "OCTRA_DATA_DIR" not in values:
        fail("OCTRA_DATA_DIR is missing from " + str(config))
    port = values.get("OCTRA_API_PORT", "8080")
    chain = values.get("OCTRA_CHAIN_ID", "")
    data = Path(values["OCTRA_DATA_DIR"])
    control = data / "validator-control"
    url = "http://127.0.0.1:" + port + "/rpc"
    try:
        wallet = json.loads(wallet_path.read_text(encoding = "utf-8"))
        address, public = wallet["address"], wallet["pub"]
    except (OSError, ValueError, KeyError, TypeError):
        fail("invalid wallet file: " + str(wallet_path))
    requested = raw_amount(requested_text) if requested_text else None
    if requested is not None and requested < 1000000:
        fail("bond increase must be at least 1 OCT")

    say("config      : " + str(config))
    say("control dir : " + str(control))
    say("rpc         : " + url)

    runtime = call(url, "octra_runtimeVersion", [])
    enrollment = call(url, "octra_validatorEnrollment", [])
    balance = call(url, "octra_balance", [address])
    if not isinstance(runtime, dict) or not isinstance(enrollment, dict) or not isinstance(balance, dict):
        fail("the local node returned an unexpected RPC shape")
    head = integer(enrollment.get("head_epoch"))
    bond = integer(enrollment.get("bond"))
    bonded = integer(enrollment.get("bonded_epoch"))
    ready = integer(enrollment.get("ready_epoch"))
    nonce = integer(balance.get("nonce"))
    pending = integer(balance.get("pending_nonce"))
    funds = integer(balance.get("balance_raw"))

    say("chain       : " + str(chain) + ("  (local node matches)"
        if runtime.get("chain_id") == chain else "  (local node chain DIFFERS: " + str(runtime.get("chain_id")) + ")"))
    say("validator   : " + address + ("  (local node matches)" if runtime.get("validator") == address
        else "  (local node serves " + str(runtime.get("validator")) + ")"))
    say(f"registry    : state={enrollment.get('state')} head={head} bond={oct_from_raw(bond)} OCT "
        f"({bond}) bonded_epoch={bonded} ready_epoch={ready}")
    say(f"nonces      : nonce={nonce} pending_nonce={pending}"
        + ("" if nonce == pending else "  <- a transaction of this wallet is still pending"))
    say(f"balance     : {oct_from_raw(funds)} OCT ({funds})")

    path = control / "bond-increase.json"
    archives = sorted(control.glob("bond-increase-*.json")) if control.is_dir() else []
    record = None
    if path.is_file():
        try:
            record = json.loads(path.read_text(encoding = "utf-8"))
        except (OSError, ValueError) as error:
            fail("the saved increase is not valid JSON: " + str(path) + " (" + str(error) + ")")
        if not isinstance(record, dict):
            fail("the saved increase is not a JSON object: " + str(path))
        say("saved       : " + str(path))
    else:
        say("saved       : none (" + str(path) + ")")
        for archive in archives:
            say("              leftover archive: " + archive.name)
        if archives:
            fail("bond_inc.sh refuses with \"saved increase missing; restore control records\" "
                "while an archive exists and bond-increase.json does not")

    user = values.get("NODE_USER", "octra")
    command = "su - " + user + " -c \"cd '" + str(node_dir) + "' && sh ./bond_inc.sh"
    if record is None:
        amount_hint = oct_from_raw(requested) if requested is not None else "<OCT>"
        say("")
        say("verdict     : no saved increase yet - the next run signs a fresh payment")
        if nonce is not None and pending is not None and nonce != pending:
            say("blocked     : the mempool still holds a transaction of this wallet "
                f"(nonce {nonce} vs pending {pending}); nothing can be signed")
        if requested is not None and type(funds) is int and funds < requested + FEE:
            say(f"blocked     : balance {oct_from_raw(funds)} OCT does not cover "
                f"{oct_from_raw(requested)} OCT + {oct_from_raw(FEE)} OCT fee")
        say("next        : " + command + " -a " + amount_hint + " -w '" + str(wallet_path) + "'\"")
        return


    saved = integer(record.get("amount"))
    tx = record.get("tx") if isinstance(record.get("tx"), dict) else {}
    say(f"record      : amount={oct_from_raw(saved)} OCT ({saved}) stage={record.get('stage')} "
        f"before={oct_from_raw(record.get('before'))} OCT head={record.get('head')} "
        f"bonded={record.get('bonded')} ready={record.get('ready')}")
    say(f"record tx   : {record.get('tx_hash')} nonce={tx.get('nonce')} ou={tx.get('ou')} "
        f"timestamp={tx.get('timestamp')}")

    state = None
    observed = call(url, "octra_transaction", [record["tx_hash"]], missing = True) \
        if isinstance(record.get("tx_hash"), str) else None
    if isinstance(observed, dict):
        state = observed.get("status")
        differ = [name for name, want in (("tx_hash", record.get("tx_hash")),
                ("from", tx.get("from")), ("amount_raw", tx.get("amount")),
                ("nonce", tx.get("nonce")), ("op_type", tx.get("op_type")))
            if observed.get(name) != want]
        if observed.get("to_", observed.get("to")) != tx.get("to_"):
            differ.append("to")
        say("receipt     : status=" + str(state)
            + ("  fields match" if not differ else "  fields DIFFER: " + ",".join(differ))
            + ("  epoch=" + str(observed.get("epoch")) if observed.get("epoch") is not None else ""))
        if "to_" not in observed:
            say("note        : this node returns the field `to`, while bond_inc.sh receipt() reads")
            say("              `to_`, so a re-run or --new refuses with \"bond transaction")
            say("              receipt differs\" once the identity checks pass")
    else:
        say("receipt     : not on chain (the payment was never accepted)")

    def rows_for(target):
        rows = []
        for key, want in (("chain", chain), ("address", address), ("pubkey", public),
                          ("amount", target), ("bonded", bonded), ("ready", ready)):
            actual = record.get(key)
            rows.append((type(actual) is type(want) and actual == want, key, actual, want))
        before = record.get("before")
        rows.append((type(before) is int and before >= 1, "before", before, "int >= 1"))
        saved_head = record.get("head")
        rows.append((type(saved_head) is int and type(head) is int and 0 <= saved_head <= head,
            "head", saved_head, "<= " + str(head)))
        rows.append((record.get("stage") in STAGES, "stage", record.get("stage"),
            "prepared|sent|accepted"))
        return rows

    def report(rows, label):
        bad = [row for row in rows if not row[0]]
        if not bad:
            say(label + ": all " + str(len(rows)) + " identity checks match")
            return True
        say(label + ": " + str(len(bad)) + "/" + str(len(rows)) + " identity checks differ")
        for _, key, actual, want in bad:
            if key == "amount":
                say(f"    amount: saved {oct_from_raw(actual)} OCT ({actual}) != "
                    f"wanted {oct_from_raw(want)} OCT ({want})")
            else:
                say(f"    {key}: saved {actual!r} != registry/argument {want!r}")
        return False

    target = requested if requested is not None else saved
    plain_rows = rows_for(target)
    plain = report(plain_rows, "plain run")
    plain_bad = {row[1] for row in plain_rows if not row[0]}
    if requested is not None and requested != saved:
        new = report(rows_for(saved), "--new run")
    else:
        new = plain
    say("")

    if plain and state == "confirmed":
        say("verdict     : the saved increase is already confirmed (bond "
            + oct_from_raw(bond) + " OCT on chain); nothing was signed and nothing changed")
        say("next        : to add MORE bond you must use --new:")
        say("              " + command + " -a "
            + (oct_from_raw(requested) if requested is not None else "<OCT>")
            + " -w '" + str(wallet_path) + "' --new\"")
        return
    if plain and state in {"pending", "staging"}:
        say("verdict     : the saved payment is " + str(state) + " - it is already in flight, never sign again")
        say("next        : wait for tx " + str(record.get("tx_hash")) + " to reach status confirmed")
        return
    if plain and state in {"rejected", "dropped"}:
        say("verdict     : the saved payment was " + str(state) + " on chain, nothing was added")
        say("next        : archive the record OUTSIDE the control dir and sign a fresh payment:")
        say("              install -d -m 700 " + str(data) + ".bond-archive")
        say("              mv '" + str(path) + "' " + str(data) + ".bond-archive/bond-increase."
            + str(int(time.time())) + ".json")
        say("              then: " + command + " -a "
            + (oct_from_raw(requested) if requested is not None else oct_from_raw(saved))
            + " -w '" + str(wallet_path) + "'\"")
        return
    elif plain and record.get("stage") != "prepared":
        say("verdict     : the saved payment was submitted but its outcome is unknown")
        say("next        : " + command + " -a " + oct_from_raw(saved) + " -w '" + str(wallet_path)
            + "' --retry\"   (resubmits the SAME transaction)")
        return
    elif plain and record.get("stage") == "prepared":
        say("verdict     : the saved payment was signed but never submitted")
        say("next        : " + command + " -a " + oct_from_raw(saved) + " -w '" + str(wallet_path)
            + "'\"   (submits the saved payment)")
        return

    if new and state != "confirmed":
        say("verdict     : the previous increase is NOT confirmed yet (receipt "
            + str(state or "absent") + "), so --new refuses until it is")
        say("next        : wait - watch `sh controls/stat.sh | grep validator_bond` and the receipt of")
        say("              " + str(record.get("tx_hash")))
    elif new:
        if type(funds) is int and requested is not None and funds < requested + FEE:
            say(f"verdict     : ready for --new, but the balance {oct_from_raw(funds)} OCT does not cover "
                f"{oct_from_raw(requested)} OCT + fee")
        elif nonce is not None and pending is not None and nonce != pending:
            say("verdict     : ready for --new, but the mempool still holds a transaction "
                f"(nonce {nonce} vs pending {pending}); wait for it to land")
        else:
            say("verdict     : the previous increase is confirmed - a new one can be signed")
            say("next        : " + command + " -a "
                + (oct_from_raw(requested) if requested is not None else "<OCT>")
                + " -w '" + str(wallet_path) + "' --new\"")
            if isinstance(observed, dict) and "to_" not in observed:
                say("warning     : --new still goes through receipt(), which reads `to_`; if it is")
                say("              refused with \"bond transaction receipt differs\", archive the saved")
                say("              record outside the control dir and sign a fresh increase instead")
    else:
        if plain_bad == {"amount"}:
            say("verdict     : the saved payment is for " + oct_from_raw(saved) + " OCT and the amount")
            say("              passed is different - bond_inc.sh treats it as the SAME operation")
            say("              (a different amount needs --new once the saved tx is confirmed)")
        else:
            say("verdict     : the saved record no longer matches this node/registry (see the")
            say("              differing fields above), so it cannot be replayed")
        if state in {"pending", "staging"}:
            say("next        : keep the file, wait for tx " + str(record.get("tx_hash")))
        elif state == "confirmed":
            say("next        : the saved payment is confirmed, so the file can be archived OUTSIDE the")
            say("              control dir (a bond-increase-*.json left behind makes bond_inc.sh refuse")
            say("              with \"saved increase missing; restore control records\"):")
            say("              install -d -m 700 " + str(data) + ".bond-archive")
            say("              mv '" + str(path) + "' " + str(data) + ".bond-archive/bond-increase."
                + str(int(time.time())) + ".json")
            say("              then re-run bond_inc.sh for the new amount (no --new needed)")
        else:
            say("next        : do NOT delete the file yet - check the tx first: "
                + str(record.get("tx_hash")))

if __name__ == "__main__":
    try:
        main()
    except (OSError, KeyError, ValueError, TypeError) as error:
        fail(str(error))
PY

python3 -B "$TMP" "$CONFIG" "$AMOUNT" "$WALLET" "$NODE_SRC_DIR"

