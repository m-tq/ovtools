#!/bin/sh
set -eu

ROOT=$(pwd -P)
exec python3 -B - "$ROOT" "$@" <<'PY'
import sys
from pathlib import Path

ROOT = Path(sys.argv.pop(1)).resolve()
modules = ROOT / "controls/lib"
for name in ("validator_common", "validator_rpc", "validator_enroll", "validator_exit"):
    if not (modules / (name + ".py")).is_file():
        print("event = bond_inc status = refused reason = run_from_node_directory", file = sys.stderr)
        raise SystemExit(1)
sys.path.insert(0, str(modules))


# sp import if (not sure btw, will check later)
import base64
import hashlib
import json
import math
import re

from nacl.signing import VerifyKey

from validator_common import ValidatorError
from validator_exit import BOND_ESCROW, valid_hash

FEE = 1000
FIELDS = ("from", "to_", "amount", "nonce", "ou", "timestamp", "op_type")

def amount_raw(text):
    if not isinstance(text, str) or len(text) > 40 or not re.fullmatch(
        r"[0-9]+(?:\.[0-9]{1,6})?", text
    ):
        raise ValidatorError("amount must be OCT with at most six decimal places")
    whole, _, fraction = text.partition(".")
    value = int(whole) * 1000000 + int(fraction.ljust(6, "0"))
    if value < 1000000:
        raise ValidatorError("bond increase must be at least 1 OCT")
    return value

def wire(fields, stamp):
    encoded = json.dumps(fields, separators = (",", ":"), ensure_ascii = True)
    return re.sub(r'"timestamp":[0-9.eE+\-]+', '"timestamp":' + stamp,
        encoded, count = 1).encode()

def payment(record, wallet, chain, amount):
    tx = record.get("tx")
    stamp = record.get("stamp")
    if not isinstance(tx, dict) or not isinstance(stamp, str) or not re.fullmatch(
        r"[0-9]+(?:\.[0-9]+)?(?:[eE][+\-]?[0-9]+)?", stamp
    ):
        raise ValidatorError("saved bond payment is incomplete")
    expected = {"from": wallet["address"], "to_": BOND_ESCROW,
        "public_key": wallet["pub"], "op_type": "validator_bond",
        "amount": str(amount), "ou": str(FEE)}

    if any(tx.get(key) != value for key, value in expected.items()) or (
        tx.get("encrypted_data") is not None
        or set(tx) - set(FIELDS) - {"public_key", "signature", "message", "encrypted_data"}
        or type(tx.get("nonce")) is not int or tx["nonce"] < 1
        or type(tx.get("timestamp")) not in (int, float)
        or not math.isfinite(tx["timestamp"]) or tx["timestamp"] <= 0
        or float(stamp) != tx["timestamp"] or not valid_hash(record.get("tx_hash"))
    ):
        raise ValidatorError("saved bond payment differs")
    try:




        public = base64.b64decode(wallet["pub"], validate = True)
        key = VerifyKey(public)
        signed = {name: tx[name] for name in FIELDS}
        signed["message"] = tx["message"]


        key.verify(wire(signed, stamp), base64.b64decode(tx["signature"], validate = True))
        proof = json.loads(tx["message"])



        # as a temporary solution - ok (will remember to include it in git after the release but it's better to do ring approval , so pls check 12 id before!!!!
        if set(proof) != {"consensus_pubkey", "proof"} or proof["consensus_pubkey"] != wallet["pub"]:
            raise ValueError("bond key differs")
        parts = [b"octra:validator_bond:v1", chain.encode(), wallet["address"].encode(),
            str(amount).encode(), str(tx["nonce"]).encode(), public]


            # !!!!!!! here also
        message = b"".join(str(len(part)).encode() + b":" + part for part in parts)
        key.verify(message, base64.b64decode(proof["proof"], validate = True))
    except Exception as error:
        raise ValidatorError("bond payment signature or network proof is invalid") from error
    fields = {name: tx[name] for name in FIELDS[:-1]}
    fields.update({"signature": tx["signature"], "op_type": tx["op_type"],
        "public_key": tx["public_key"], "message": tx["message"], "encrypted_data": None})
    if hashlib.sha256(wire(fields, stamp)).hexdigest() != record["tx_hash"]:
        raise ValidatorError("bond transaction hash differs")
    return tx

def receipt(value, record, head):
    tx = record["tx"]
    fields = {"tx_hash": record["tx_hash"], "from": tx["from"], "to": tx["to_"],
        "amount_raw": tx["amount"], "nonce": tx["nonce"], "op_type": tx["op_type"]}
    if not isinstance(value, dict) or any(
        type(value.get(key)) is not type(expected) or value[key] != expected
        for key, expected in fields.items()
    ):
        raise ValidatorError("bond transaction receipt differs")
    status = value.get("status")
    if status == "confirmed" and (
        type(value.get("epoch")) is not int or not record["head"] <= value["epoch"] <= head
    ):
        raise ValidatorError("bond confirmation epoch differs")
    if status not in {"confirmed", "pending", "staging", "rejected", "dropped"}:
        raise ValidatorError("bond transaction status is invalid")
    return status

import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time


# !!!!!! checked 
from validator_common import ValidatorError, load_wallet, parse_env, private_mode, sha256_file, write_private_json
from validator_enroll import EnrollmentState, committed_enrollment, local_rpc
from validator_exit import command_lock, control_view, directory, read_outbox, require_prepare, sync_directory
from validator_rpc import call, transaction



# ONLY FOR DEVNET!!!!!!!!!!!!!!!!!!!!!!!!!
CHAIN = "octra-devnet-9871-cluster"
# !!!!!!!!!!!!!!!!!

def number(value, name):
    if type(value) is int and value >= 0:
        return value
    if isinstance(value, str) and value.isascii() and value.isdecimal():
        return int(value)
    raise ValidatorError("invalid " + name)

def view(values, wallet):
    if values.get("OCTRA_CHAIN_ID") != CHAIN:
        raise ValidatorError("this bond tool requires devnet")
    url = local_rpc(values)
    runtime = call(url, "octra_runtimeVersion", [])
    if not isinstance(runtime, dict) or runtime.get("chain_id") != CHAIN or (
        runtime.get("validator") != wallet["address"]
    ):
        raise ValidatorError("local node network or validator differs")
    raw = call(url, "octra_validatorEnrollment", [])
    entry = committed_enrollment(values, wallet, raw)
    if entry.state is not EnrollmentState.READY or entry.membership is None or (
        not entry.membership.active or entry.withdraw_epoch is not None
    ):
        raise ValidatorError("active ready validator required; no join or exit will be sent")
    control = control_view(raw, values, wallet, entry.bonded_epoch)
    if control["exit_requested"]:
        raise ValidatorError("validator exit is requested; nothing signed")
    balance = call(url, "octra_balance", [wallet["address"]])
    if not isinstance(balance, dict) or balance.get("address") != wallet["address"]:
        raise ValidatorError("local balance address differs")
    return {"head": entry.head_epoch, "bond": entry.bond, "bonded": entry.bonded_epoch,
        "ready": entry.ready_epoch, "nonce": number(balance.get("nonce"), "account nonce"),
        "pending": number(balance.get("pending_nonce"), "pending nonce"),
        "balance": number(balance.get("balance_raw"), "account balance")}

def available(current, amount):
    if current["pending"] != current["nonce"]:
        raise ValidatorError("account has pending transactions; nothing signed or submitted")
    if current["balance"] < amount + FEE:
        raise ValidatorError("insufficient public balance for increase plus 0.001 OCT fee")

def save(path, value):
    write_private_json(path, value)
    sync_directory(path.parent)

def prepare(values, wallet, wallet_path, amount, current):
    binary = Path(values["OCTRA_OPERATOR_CONTROL_BINARY"])
    if sha256_file(binary) != values["OCTRA_OPERATOR_CONTROL_BINARY_HASH"]:
        raise ValidatorError("validator control binary hash mismatch")
    require_prepare(binary)
    result = subprocess.run([str(binary), "--wallet", str(wallet_path),
        "--rpc", local_rpc(values), "--chain-id", CHAIN, "--op", "validator_bond",
        "--amount", str(amount), "--nonce", str(current["nonce"] + 1),
        "--ou", str(FEE), "--prepare"], capture_output = True, text = True, timeout = 30)
    if result.returncode != 0:
        raise ValidatorError("bond preparation failed; nothing submitted")
    try:
        prepared = json.loads(result.stdout)
        stamps = re.findall(r'"timestamp"\s*:\s*([0-9.eE+\-]+)', result.stdout)
        if len(stamps) != 1:
            raise ValueError("timestamp missing")
        record = {"chain": CHAIN, "address": wallet["address"], "pubkey": wallet["pub"],
            "amount": amount, "before": current["bond"], "head": current["head"],
            "bonded": current["bonded"], "ready": current["ready"], "stage": "prepared",
            "tx": prepared["tx"], "tx_hash": prepared["tx_hash"], "stamp": stamps[0]}
    except (ValueError, KeyError, TypeError) as error:
        raise ValidatorError("invalid prepared bond transaction; nothing submitted") from error
    tx = payment(record, wallet, CHAIN, amount)
    if tx["nonce"] != current["nonce"] + 1 or abs(time.time() - tx["timestamp"]) > 60:
        raise ValidatorError("prepared bond nonce or timestamp differs; nothing submitted")
    return record

def identity(record, wallet, current, amount):
    expected = {"chain": CHAIN, "address": wallet["address"], "pubkey": wallet["pub"],
        "amount": amount, "bonded": current["bonded"], "ready": current["ready"]}
    if any(type(record.get(key)) is not type(value) or record[key] != value
        for key, value in expected.items()) or (
        type(record.get("before")) is not int or record["before"] < 1
        or type(record.get("head")) is not int or not 0 <= record["head"] <= current["head"]
        or record.get("stage") not in {"prepared", "sent", "accepted"}
    ):
        raise ValidatorError("saved increase differs; inspect before requesting another increase")
    return payment(record, wallet, CHAIN, amount)

def increase(values, wallet, wallet_path, amount, *, new = False, retry = False):
    current = view(values, wallet)
    root = directory(values)
    path = root / "bond-increase.json"
    record = read_outbox(path)
    if record is None and any(root.glob("bond-increase-*.json")):
        raise ValidatorError("saved increase missing; restore control records")
    if record is not None:
        identity(record, wallet, current, record.get("amount") if new else amount)
        observed = transaction(local_rpc(values), record["tx_hash"])
        state = receipt(observed, record, current["head"]) if observed is not None else None
        if state == "confirmed":
            if current["bond"] < record["before"] + record["amount"]:
                raise ValidatorError("confirmed increase is absent from current registry")
            if not new:
                return record["tx_hash"], "confirmed"
        elif new:
            raise ValidatorError("previous increase is not confirmed; nothing new signed")
        elif state in {"pending", "staging"}:
            return record["tx_hash"], state
        elif state in {"rejected", "dropped"}:
            raise ValidatorError("saved increase refused; inspect tx = " + record["tx_hash"])
        elif record["stage"] != "prepared" and not retry:
            raise ValidatorError("submission unresolved; inspect saved tx = " + record["tx_hash"]
                + "; --retry submits only this same transaction")
    elif retry or new:
        raise ValidatorError("no saved increase for --retry or --new")
    available(current, amount)
    if record is None or new:
        prepared = prepare(values, wallet, wallet_path, amount, current)
        if record is not None:
            archive = root / ("bond-increase-" + record["tx_hash"] + ".json")
            prior = read_outbox(archive)
            if prior is not None and prior != record:
                raise ValidatorError("saved increase archive differs")
            save(archive, record)
        save(path, prepared)
        record = prepared
    tx = identity(record, wallet, current, amount)
    fresh = view(values, wallet)
    available(fresh, amount)
    if any(fresh[key] != current[key] for key in ("bond", "bonded", "ready", "nonce")) or (
        tx["nonce"] != fresh["nonce"] + 1 or fresh["bond"] != record["before"]
        or not 0 <= time.time() - tx["timestamp"] <= 300
    ):
        raise ValidatorError("account, registry or transaction time changed; inspect tx = " + record["tx_hash"])
    record = {**record, "stage": "sent"}
    save(path, record)
    try:
        reply = call(local_rpc(values), "octra_submit", [tx], timeout = 30)
    except ValidatorError as error:
        raise ValidatorError("submission unresolved; signed payment retained; tx = " + record["tx_hash"]) from error
    if not isinstance(reply, dict) or reply.get("tx_hash") != record["tx_hash"] or (
        reply.get("status") not in {"accepted", "pending"}
    ):
        raise ValidatorError("submission not acknowledged; inspect tx = " + record["tx_hash"])
    save(path, {**record, "stage": "accepted"})
    return record["tx_hash"], "accepted"

def main():
    parser = argparse.ArgumentParser(prog = "bond_inc.sh",
        description = "Add OCT to an active devnet validator bond")
    parser.add_argument("-a", "--amount", required = True, type = amount_raw,
        help = "Additional OCT, at least 1, at most six decimal places")
    parser.add_argument("-w", "--wallet", required = True, type = Path)
    parser.add_argument("--config", type = Path, default = Path(os.getenv(
        "OCTRA_OPERATOR_CONFIG", str(ROOT / ".keys/validator/node.env"))))
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--new", action = "store_true", help = "Start another increase after confirmed prior payment")
    group.add_argument("--retry", action = "store_true", help = "Resubmit the exact saved payment after an unknown outcome")
    args = parser.parse_args()
    private_mode(args.config)
    values = parse_env(args.config)
    info = args.wallet.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise ValidatorError("wallet must be a regular file owned by the node user")
    wallet = load_wallet(args.wallet)
    local = load_wallet(Path(values["OCTRA_DATA_DIR"]) / "wallet.json")
    if any(wallet[key] != local[key] for key in ("address", "pub")):
        raise ValidatorError("wallet does not belong to the configured validator")
    with command_lock(values):
        tx_hash, status = increase(values, wallet, args.wallet, args.amount, new = args.new, retry = args.retry)
    print(f"event = bond_inc status = {status} amount_raw = {args.amount}", file = sys.stderr)
    print("tx = " + tx_hash)

if __name__ == "__main__":
    try:
        main()
    except (ValidatorError, OSError, KeyError, ValueError, subprocess.SubprocessError) as error:
        print("event = bond_inc status = refused reason = " + json.dumps(str(error)), file = sys.stderr)
        raise SystemExit(1)
PY