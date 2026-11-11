import type { CheckResult, CheckRow, HostAuth } from '../types';
import { createSSHClient } from '../ssh/client';
import { isHostKeyError, trustHostKey } from './hostkeys';
import { probeNode } from './nodes';

interface HostFacts {
  ip: string;
  reachable: boolean;
  error?: string;
  wallet: string | null;
  role: string | null;
  git: boolean;
  toolsMissing: string[];
  freeGB: number | null;
  node: any;
  needsTrust: boolean;
  hostkeyIssue: boolean;
  fingerprint: string | null;
}

function authFrom(body: any, side: 'old' | 'new'): HostAuth {
  const method = String((side === 'old' ? body.oldAuth : body.newAuth) || 'password') === 'key' ? 'key' : 'password';
  return {
    method,
    password: side === 'old' ? body.oldPassword : body.newPassword,
    keyPath: side === 'old' ? body.oldKey : body.newKey,
  };
}

async function gatherHost(ip: string, auth: HostAuth): Promise<HostFacts> {
  const facts: HostFacts = {
    ip,
    reachable: false,
    wallet: null,
    role: null,
    git: false,
    toolsMissing: [],
    freeGB: null,
    node: null,
    needsTrust: false,
    hostkeyIssue: false,
    fingerprint: null,
  };
  try {
    const client = await createSSHClient({ host: ip, port: 22, username: 'root', auth });
    facts.reachable = true;
    const probe = await client.exec(
      [
        'echo "WALLET=$(cat /opt/octra/libv_litecore/.keys/validator/wallet.json 2>/dev/null | jq -r ".address // empty" 2>/dev/null || true)"',
        'echo "ROLE=$(grep -m1 \'^OCTRA_OPERATOR_ROLE=\' /opt/octra/libv_litecore/.keys/validator/node.env 2>/dev/null | cut -d= -f2 || true)"',
        'echo "GIT=$(test -d /opt/octra/libv_litecore/.git && echo yes || echo no)"',
        'M=""; for t in curl jq rsync git tar systemd-run; do command -v "$t" >/dev/null 2>&1 || M="$M $t"; done; echo "TOOLS=${M# }"',
        'echo "FREE=$(df -BG --output=avail /var/lib/octra 2>/dev/null | tail -1 | tr -dc "0-9" || true)"',
      ].join('; '),
      { timeout: 120000 }
    );
    for (const line of probe.stdout.split('\n')) {
      if (line.startsWith('WALLET=')) facts.wallet = line.slice(7).trim() || null;
      else if (line.startsWith('ROLE=')) facts.role = line.slice(5).trim() || null;
      else if (line.startsWith('GIT=')) facts.git = line.slice(4).trim() === 'yes';
      else if (line.startsWith('TOOLS=')) facts.toolsMissing = line.slice(6).trim().split(/\s+/).filter(Boolean);
      else if (line.startsWith('FREE=')) {
        const raw = line.slice(5).trim();
        const n = Number(raw);
        facts.freeGB = raw !== '' && Number.isFinite(n) ? n : null;
      }
    }
    await client.disconnect();
  } catch (err) {
    facts.error = (err as Error).message;
    facts.hostkeyIssue = isHostKeyError(facts.error);
    facts.needsTrust = facts.hostkeyIssue;
    facts.fingerprint = (err as any)?.hostFingerprint || null;
  }
  try {
    facts.node = await probeNode(ip);
  } catch {
    facts.node = null;
  }
  return facts;
}

function row(items: CheckRow[], id: string, label: string, status: CheckRow['status'], detail?: string): void {
  items.push({ id, label, status, detail });
}

export async function runCheck(body: any): Promise<{ key: string; result: CheckResult }> {
  const started = Date.now();
  const program = String(body.program || 'migrate').toLowerCase();
  const oldIp = String(body.oldIp || '').trim();
  const newIp = String(body.newIp || '').trim();
  const oldAuth = authFrom(body, 'old');
  const newAuth = authFrom(body, 'new');
  const items: CheckRow[] = [];
  const needsTrust: string[] = [];

  if (program === 'migrate') {
    if (!oldIp || !newIp) throw new Error('both source and target addresses are required');
    if (oldIp === newIp) throw new Error('source and target must differ');
  } else if (!newIp) {
    throw new Error('the node address is required');
  }

  const [initialOldFacts, initialNewFacts] = await Promise.all([
    program === 'migrate' ? gatherHost(oldIp, oldAuth) : Promise.resolve(null),
    gatherHost(newIp, newAuth),
  ]);
  let oldFacts: HostFacts | null = initialOldFacts;
  let newFacts: HostFacts | null = initialNewFacts;

  // A reinstalled VPS legitimately presents a new host key. Check accepts the
  // key this handshake just saw and re-probes, so the operator is never blocked
  // on a button; the button stays as the fallback when no key could be read.
  const autoTrust = async (
    facts: HostFacts | null,
    auth: HostAuth,
    role: 'source' | 'target' | 'node'
  ): Promise<HostFacts | null> => {
    if (!facts || !facts.hostkeyIssue) return facts;
    const trust = await trustHostKey(facts.ip, auth);
    if (!trust.ok) {
      if (!needsTrust.includes(facts.ip)) needsTrust.push(facts.ip);
      row(items, `hostkey-${role}`, `${role === 'node' ? 'Node' : role[0].toUpperCase() + role.slice(1)} host key changed`, 'fail',
        `server presents ${facts.fingerprint || 'a new key'} - auto-trust failed (${trust.detail}): press 'Trust host key for ${facts.ip}'`);
      return facts;
    }
    row(items, `hostkey-${role}`, `${role === 'node' ? 'Node' : role[0].toUpperCase() + role.slice(1)} host key auto-trusted`, 'warn',
      `reinstalled VPS - new key accepted automatically: ${trust.fingerprint || facts.fingerprint || '?'} (${trust.detail})`);
    return gatherHost(facts.ip, auth);
  };

  oldFacts = await autoTrust(oldFacts, oldAuth, 'source');
  newFacts = await autoTrust(newFacts, newAuth, program === 'migrate' ? 'target' : 'node');
  if (!newFacts) throw new Error('the node did not answer the SSH probe');

  const addFacts = (facts: HostFacts, role: 'source' | 'target' | 'node') => {
    const tag = role === 'node' ? 'node' : role;
    row(items, `${role}-reach`, `${tag} reachable (${facts.ip})`, facts.reachable ? 'ok' : 'fail', facts.reachable ? 'SSH login works' : (facts.error || 'no SSH connection'));
    if (facts.needsTrust && !needsTrust.includes(facts.ip)) needsTrust.push(facts.ip);
    if (!facts.reachable) return;
    row(items, `${role}-tools`, `${tag} host tools`, facts.toolsMissing.length ? 'warn' : 'ok', facts.toolsMissing.length ? `missing: ${facts.toolsMissing.join(', ')} (the deploy installs them)` : 'curl, jq, rsync, git, tar, systemd-run present');
    row(items, `${role}-wallet`, `${tag} wallet identity`, facts.wallet ? 'ok' : (role === 'source' ? 'fail' : 'ok'), facts.wallet || (role === 'source' ? 'wallet.json not found - this host is not the running node' : 'no wallet yet (fresh host)'));
    row(items, `${role}-disk`, `${tag} data volume space`, facts.freeGB === null ? 'warn' : facts.freeGB >= 60 ? 'ok' : 'fail', facts.freeGB === null ? 'data volume not prepared yet - prep runs pre-run.sh' : `${facts.freeGB} GB free on /var/lib/octra`);
    if (facts.node && facts.node.reachable) {
      const validator = facts.node.validator || {};
      const active = Boolean(validator.active);
      row(items, `${role}-api`, `${tag} node API`, 'ok', `reachable, role=${active ? 'validator' : (validator.state || 'observer')}`);
    } else {
      row(items, `${role}-api`, `${tag} node API`, facts.wallet ? 'warn' : 'ok', facts.wallet ? 'the node does not answer :8080/status' : 'no node yet (fresh host)');
    }
  };

  if (oldFacts) {
    addFacts(oldFacts, 'source');
    if (oldFacts.node && oldFacts.node.reachable) {
      const active = Boolean(oldFacts.node.validator?.active);
      row(items, 'source-active', 'source is the active validator', active ? 'ok' : 'warn', active ? 'validator is active' : 'the source does not report validator_active=true');
    }
  }
  addFacts(newFacts, program === 'migrate' ? 'target' : 'node');

  if (program === 'migrate') {
    const targetHasIdentity = Boolean(newFacts.wallet);
    row(items, 'target-fresh', 'target has no competing identity', targetHasIdentity ? 'warn' : 'ok', targetHasIdentity ? 'the target already has a wallet - prep will refuse unless it is this migration copy' : 'fresh target');
  }
  if (program === 'deploy' && newFacts.wallet) {
    row(items, 'target-fresh', 'target is fresh', 'fail', 'this host already has a node identity (wallet.json) - use Migrate, or wipe the volume explicitly');
  }

  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const item of items) counts[item.status]++;
  const ready = counts.fail === 0;
  const readyManage = program !== 'manage' || (newFacts.reachable && Boolean(newFacts.node?.validator?.active));
  const readyUpgrade = program !== 'manage' || (newFacts.reachable && Boolean(newFacts.wallet) && newFacts.git);

  const result: CheckResult = {
    ready,
    readyManage,
    readyUpgrade,
    program,
    sourceIp: oldIp || undefined,
    targetIp: newIp,
    items,
    counts,
    durationMs: Date.now() - started,
    checkedAt: Date.now(),
    needsTrust: needsTrust.length ? needsTrust : undefined,
  };
  const key = program === 'migrate' ? `${oldIp}|${newIp}` : `${program}|${newIp}`;
  return { key, result };
}
