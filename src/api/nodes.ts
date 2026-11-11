import type { NodeSummary } from '../types';
import { NODE_API_PORT, PROBE_TTL_MS, TOKEN_UNIT } from '../constants';

interface Probe {
  ip: string;
  reachable: boolean;
  error?: string | null;
  chain?: any;
  validator?: any;
  ts: number;
}

const cache = new Map<string, { ts: number; probe: Probe }>();

async function httpJson(url: string, init: RequestInit = {}, timeoutMs = 4000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function rpc(ip: string, method: string, params: unknown[] = []): Promise<any> {
  return httpJson(`http://${ip}:${NODE_API_PORT}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

export async function probeNode(ip: string): Promise<Probe> {
  const cached = cache.get(ip);
  if (cached && Date.now() - cached.ts < PROBE_TTL_MS) return cached.probe;
  const probe: Probe = { ip, reachable: false, ts: Date.now() };
  try {
    const status = await httpJson(`http://${ip}:${NODE_API_PORT}/status`);
    probe.reachable = true;
    probe.chain = {
      epoch: status.current_epoch,
      head_epoch: status.head_epoch,
      txid_hi: status.txid_hi,
      accounts: status.total_accounts,
      network: status.network_version,
      state_root: status.state_root,
    };
  } catch (err) {
    probe.error = (err as Error).message.slice(0, 180);
  }
  if (probe.reachable) {
    try {
      const enroll = await rpc(ip, 'octra_validatorEnrollment');
      const result = enroll?.result || enroll || {};
      const member = result.membership || {};
      const committed = result.committed_enrollment || result.enrollment || {};
      probe.validator = {
        address: result.address,
        state: result.state,
        bond: result.bond,
        head_epoch: result.head_epoch,
        active: Boolean(member.active),
        scheduled: Boolean(member.scheduled),
        next_set_epoch: member.next_set_epoch,
        activate_epoch: member.activate_epoch,
        duty_automatic: Boolean(result.duty?.automatic),
        exit_epoch: committed.exit_epoch ?? result.exit_epoch,
        withdraw_epoch: committed.withdraw_epoch ?? result.withdraw_epoch,
        remaining_epochs: committed.remaining_epochs ?? result.remaining_epochs,
        raw: result,
      };
    } catch (err) {
      (probe as any).validator_error = (err as Error).message.slice(0, 180);
    }
  }
  cache.set(ip, { ts: probe.ts, probe });
  return probe;
}

export function tokenAmount(raw: unknown): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value / TOKEN_UNIT;
}

export function nodeSummaryFromProbe(probe: Probe): NodeSummary {
  const chain = probe.chain || {};
  const validator = probe.validator || {};
  let state = 'unreachable';
  if (probe.reachable) {
    if (validator.active) state = 'validator';
    else if (validator.scheduled) state = 'scheduled';
    else if (validator.state === 'ready') state = 'ready-idle';
    else state = 'observer';
  }
  return {
    ip: probe.ip,
    state,
    reachable: probe.reachable,
    error: probe.error || null,
    epoch: chain.epoch ?? null,
    head_epoch: chain.head_epoch ?? null,
    accounts: chain.accounts ?? null,
    network: chain.network ?? null,
    address: validator.address ?? null,
    bond: validator.bond ?? null,
    bondOct: tokenAmount(validator.bond),
    enrollment: validator.state ?? null,
    active: Boolean(validator.active),
    scheduled: Boolean(validator.scheduled),
    next_set_epoch: validator.next_set_epoch ?? null,
    duty_automatic: Boolean(validator.duty_automatic),
    ts: probe.ts,
  };
}

export async function nodeSummary(ip: string): Promise<NodeSummary> {
  return nodeSummaryFromProbe(await probeNode(ip));
}

export async function getEnrollment(ip: string): Promise<any | null> {
  const probe = await probeNode(ip);
  return probe.validator?.raw || probe.validator || null;
}
