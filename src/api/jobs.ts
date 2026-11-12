import * as fs from 'fs/promises';
import * as path from 'path';
import type { JobRequest, JobState, LogEntry, Settings } from '../types';
import { createLogger, Logger, readJSON } from '../utils/helpers';
import { DEFAULT_ROLE, SETTINGS_FILE, phaseMeta } from '../constants';
import { DeployOrchestrator } from '../orchestrator/deploy';
import { MigrateOrchestrator } from '../orchestrator/migrate';
import { ManageOrchestrator } from '../orchestrator/manage';
import { getEnrollment, probeNode } from './nodes';

const IP_RE = /^[0-9a-fA-F.:]{3,45}$/;
const DEFAULT_SETTINGS: Settings = {
  swapGB: 8,
  dataDevice: '/dev/sdb',
  dataMinGB: 1000,
  dashboardDomain: '',
};

export function normalizeSettings(raw: Partial<Settings> | null | undefined): Settings {
  const input = raw || {};
  const swap = Number(input.swapGB);
  const min = Number(input.dataMinGB);
  return {
    swapGB: Number.isFinite(swap) && swap >= 1 && swap <= 256 ? Math.round(swap) : DEFAULT_SETTINGS.swapGB,
    dataDevice: typeof input.dataDevice === 'string' && input.dataDevice.trim() ? input.dataDevice.trim() : DEFAULT_SETTINGS.dataDevice,
    dataMinGB: Number.isFinite(min) && min >= 10 ? Math.round(min) : DEFAULT_SETTINGS.dataMinGB,
    dashboardDomain: typeof input.dashboardDomain === 'string' ? input.dashboardDomain.trim().toLowerCase() : '',
    assetsRepo: typeof input.assetsRepo === 'string' ? input.assetsRepo.trim() : '',
    assetsRef: typeof input.assetsRef === 'string' && input.assetsRef.trim() ? input.assetsRef.trim() : 'main',
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    return normalizeSettings((await readJSON<Settings>(SETTINGS_FILE)) || undefined);
  } catch {
    return normalizeSettings(undefined);
  }
}

export class JobManager {
  private state: JobState = {
    running: false,
    exitCode: null,
    lastSeq: 0,
  };
  private logger: Logger | null = null;
  private listeners = new Set<(entry: LogEntry) => void>();
  private orchestrator: DeployOrchestrator | MigrateOrchestrator | ManageOrchestrator | null = null;
  private lastLogAt = Date.now();
  private activationTimer: NodeJS.Timeout | null = null;
  private exitTimer: NodeJS.Timeout | null = null;

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): JobState {
    const now = Date.now();
    const running = this.state.running;
    return {
      ...this.state,
      idleSec: running ? Math.max(0, Math.round((now - this.lastLogAt) / 1000)) : undefined,
      elapsedSec: this.state.startedAt ? Math.max(0, Math.round(now / 1000 - this.state.startedAt)) : undefined,
      lastSeq: this.logger?.lastSeq() ?? this.state.lastSeq ?? 0,
    };
  }

  lines(since: number): LogEntry[] {
    return this.logger ? this.logger.entriesSince(since) : [];
  }

  getLogger(): Logger | null {
    return this.logger;
  }

  async start(request: JobRequest): Promise<JobState> {
    if (this.state.running) throw new Error('a phase is already running - wait for it to finish');
    const program = request.program;
    if (!['deploy', 'migrate', 'manage'].includes(program)) throw new Error(`unknown program: ${program}`);
    const phase = String(request.phase || '').trim();
    const meta = phaseMeta(program, phase);
    if (!meta) throw new Error(`unknown ${program} phase: ${phase}`);
    if (meta.confirm && !request.approved && String(request.confirm || '').toUpperCase() !== meta.confirm.toUpperCase()) {
      throw new Error(`this phase needs approval (approved=true or confirm=${meta.confirm})`);
    }

    const settings = await loadSettings();
    const oldAuth = this.auth(request, 'old');
    const newAuth = this.auth(request, 'new');
    if (request.sameAuth && program === 'migrate') {
      newAuth.method = oldAuth.method;
      newAuth.password = oldAuth.password;
      newAuth.keyPath = oldAuth.keyPath;
    }

    const oldIp = String(request.oldIp || '').trim();
    const newIp = String(request.newIp || '').trim();
    if (program === 'migrate') {
      if (!IP_RE.test(oldIp)) throw new Error('a source address is required');
      if (phase !== 'backup' && !IP_RE.test(newIp)) throw new Error('a target address is required');
      if (newIp && oldIp === newIp) throw new Error('source and target must differ');
      await this.validateAuth(oldAuth, 'source', oldIp);
      if (phase !== 'backup') await this.validateAuth(newAuth, 'target', newIp);
    } else {
      if (!IP_RE.test(newIp)) throw new Error('the node address is required');
      await this.validateAuth(newAuth, program === 'deploy' ? 'target' : 'node', newIp);
    }

    if (program === 'manage') {
      if (phase === 'bond') {
        const amount = String(request.amount || '').trim();
        if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(amount) || Number(amount) < 1) {
          throw new Error('type the amount to add in OCT (min 1, e.g. 100 or 12.5)');
        }
      }
      if (phase === 'dashboard') {
        const sslMode = String(request.sslMode || 'auto').toLowerCase();
        if (!['auto', 'cloudflare', 'certbot'].includes(sslMode)) {
          throw new Error('sslMode must be auto, cloudflare or certbot');
        }
        if (sslMode === 'cloudflare') {
          if (!request.certDir) throw new Error('choose the folder that holds fullchain.pem and privkey.pem');
          await this.validateCertDir(request.certDir);
        }
        if (sslMode === 'certbot' && !request.domain) {
          throw new Error("Let's Encrypt needs the domain (it must already point at the node)");
        }
      }
    }
    this.clearWatchers();
    this.state = {
      running: true,
      program,
      phase,
      step: meta.label,
      exitCode: null,
      startedAt: Date.now() / 1000,
      newIp,
      oldIp,
      domain: (request.domain || settings.dashboardDomain || '').toLowerCase() || undefined,
      awaiting: null,
      activation: null,
      watching: null,
      exitWatching: null,
      progress: null,
      status: null,
      label: null,
      lastSeq: 0,
    };
    this.lastLogAt = Date.now();

    const logger = createLogger(`${program}-${phase}`, false);
    logger.subscribe(entry => this.onEntry(entry));
    this.logger = logger;

    try {
      const role = request.role === 'observer' ? 'observer' : DEFAULT_ROLE;
      if (program === 'deploy') {
        const bondRaw = this.rawBond(request);
        this.orchestrator = new DeployOrchestrator(
          {
            ip: newIp,
            auth: newAuth,
            nodeName: request.nodeName,
            role: role === 'observer' ? 'observer' : 'validator',
            bond: bondRaw,
            domain: request.domain || settings.dashboardDomain || undefined,
            swapGB: settings.swapGB,
            dataDevice: settings.dataDevice,
            dataMinGB: settings.dataMinGB,
            skipDashboard: true,
            samples: 3,
            interval: 20,
            reset: Boolean(request.reset),
            wipeVolume: Boolean(request.wipeVolume),
            keepData: Boolean(request.keepData),
            phase,
          },
          logger
        );
      } else if (program === 'migrate') {
        this.orchestrator = new MigrateOrchestrator(
          {
            oldIp,
            oldAuth,
            newIp,
            newAuth,
            wipeTargetVolume: Boolean(request.wipeTargetVolume),
            keepTargetData: Boolean(request.keepTargetData),
            phase,
            samples: 3,
            interval: 30,
            reset: Boolean(request.reset),
          },
          logger
        );
      } else {
        this.orchestrator = new ManageOrchestrator(
          {
            ip: newIp,
            auth: newAuth,
            phase: phase as any,
            amount: request.amount,
            newBond: Boolean(request.newBond),
            domain: request.domain || undefined,
            sslMode: (request.sslMode as any) || 'auto',
            certDir: request.certDir,
            email: request.email,
            testOnly: Boolean(request.testOnly),
            noRestart: Boolean(request.noRestart),
            reset: Boolean(request.reset),
            waitSeconds: request.waitSeconds ? Number(request.waitSeconds) : 900,
            extra: request.extra,
          },
          logger
        );
      }

      void this.execute();
      return this.snapshot();
    } catch (err) {
      this.state.running = false;
      this.state.exitCode = 1;
      throw err;
    }
  }

  private async execute(): Promise<void> {
    const orch = this.orchestrator!;
    const program = this.state.program!;
    const phase = this.state.phase!;
    try {
      if (program === 'deploy') {
        const deploy = orch as DeployOrchestrator;
        await deploy.run();
        if (deploy.awaitingEnroll) {
          this.state.awaiting = {
            action: 'enroll',
            ip: this.state.newIp!,
            address: deploy.awaitingEnroll.address,
            bond: deploy.awaitingEnroll.bond,
          };
        }
        if (deploy.dashboardUrl) this.state.domain = deploy.dashboardUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const shouldWatch = deploy.awaitingEnroll === null
          && ['deploy', 'all', 'enroll', 'promote', 'verify'].includes(phase);
        if (shouldWatch) this.startActivationWatch(this.state.newIp!);
      } else if (program === 'migrate') {
        const migrate = orch as MigrateOrchestrator;
        await migrate.run();
        if (phase === 'all' || phase === 'auto' || phase === 'verify' || migrate.activationPending) {
          this.startActivationWatch(this.state.newIp!);
        }
      } else {
        await orch.run();
        const manage = orch as ManageOrchestrator;
        if (manage.dashboardUrl) this.state.domain = manage.dashboardUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        if (phase === 'exit') this.startExitWatch(this.state.newIp!);
      }
      this.state.exitCode = 0;
    } catch (err) {
      this.state.exitCode = 1;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.log(`run failed: ${msg}`, 'error', { program });
    } finally {
      this.state.running = false;
      this.lastLogAt = Date.now();
    }
  }

  cancel(): boolean {
    if (!this.state.running || !this.orchestrator) return false;
    this.orchestrator.abort();
    this.logger?.log('cancel requested - the current phase will stop at the next safe point', 'warn', { program: this.state.program });
    return true;
  }

  dispose(): void {
    this.clearWatchers();
  }

  private auth(request: JobRequest, side: 'old' | 'new'): { method: 'password' | 'key'; password?: string; keyPath?: string } {
    const method = (side === 'old' ? request.oldAuth : request.newAuth) === 'key' ? 'key' : 'password';
    return {
      method,
      password: side === 'old' ? request.oldPassword : request.newPassword,
      keyPath: side === 'old' ? request.oldKey : request.newKey,
    };
  }

  private async validateAuth(auth: { method: 'password' | 'key'; password?: string; keyPath?: string }, label: string, ip: string): Promise<void> {
    if (auth.method === 'key') {
      if (!auth.keyPath) throw new Error(`no SSH key selected for ${label} ${ip}`);
      try {
        await fs.access(auth.keyPath);
      } catch {
        throw new Error(`the SSH key for ${label} ${ip} does not exist: ${auth.keyPath}`);
      }
      return;
    }
    if (!auth.password) throw new Error(`no password typed for ${label} ${ip}`);
  }

  private async validateCertDir(dir: string): Promise<void> {
    for (const name of ['fullchain.pem', 'privkey.pem']) {
      try {
        await fs.access(path.join(dir, name));
      } catch {
        throw new Error(`${name} is missing in ${dir}`);
      }
    }
  }

  private rawBond(request: JobRequest): number {
    const oct = Number(request.bondOct);
    if (Number.isFinite(oct) && oct > 0) return Math.round(oct * 1_000_000);
    const raw = Number(request.bond);
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
  }

  private onEntry(entry: LogEntry): void {
    this.lastLogAt = Date.now();
    this.state.lastSeq = entry.seq;

    const labelMatch = /^--> \[([^\]]+)\]\s+(.+?)(?:\s+\(detached.*\))?$/.exec(entry.line);
    if (labelMatch) {
      this.state.label = { ip: labelMatch[1], label: labelMatch[2] };
      this.state.step = labelMatch[2];
    }

    const statusMatch = /^status\s*=\s*(RUNNING|DONE|FAILED|WAITING-[A-Z-]+)\s*(.*)$/i.exec(entry.line);
    if (statusMatch) {
      this.state.status = { state: statusMatch[1].toUpperCase(), detail: statusMatch[2].trim() };
    }

    const progress = /([\d,]+)\s+(\d+)%\s+([\d.]+\s*[kKMG]?B\/s)/.exec(entry.line);
    if (progress) {
      this.state.progress = { pct: Number(progress[2]), bytes: progress[1].replace(/,/g, ''), rate: progress[3].trim() };
    }

    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // ignore
      }
    }
  }

  private startActivationWatch(ip: string): void {
    if (!ip) return;
    this.clearActivation();
    this.state.watching = { ip };
    const deadline = Date.now() + 6 * 3600 * 1000;
    const tick = async () => {
      if (Date.now() > deadline) {
        this.state.watching = null;
        this.clearActivation();
        return;
      }
      try {
        const summary = await probeNode(ip);
        const validator = summary.validator || {};
        if (validator.active) {
          this.state.activation = {
            id: `${ip}:${validator.activate_epoch || validator.head_epoch || Date.now()}`,
            ip,
            epoch: Number(validator.activate_epoch || validator.head_epoch) || undefined,
            bond: Number(validator.bond) || undefined,
          };
          this.state.watching = null;
          this.clearActivation();
        }
      } catch {
        // node not reachable yet: keep watching
      }
    };
    void tick();
    this.activationTimer = setInterval(() => void tick(), 60000);
    this.activationTimer.unref?.();
  }

  private startExitWatch(ip: string): void {
    if (!ip) return;
    this.clearExit();
    this.state.exitWatching = { ip };
    const deadline = Date.now() + 30 * 24 * 3600 * 1000;
    const tick = async () => {
      if (Date.now() > deadline) {
        this.state.exitWatching = null;
        this.clearExit();
        return;
      }
      try {
        const result = await getEnrollment(ip);
        if (!result) return;
        const bond = Number(result.bond) || 0;
        const member = result.membership || {};
        const state = String(result.state || '');
        const done = bond === 0 && !['bonded', 'ready', 'exiting'].includes(state);
        const remaining = result.remaining_epochs === undefined || result.remaining_epochs === null
          ? null
          : Number(result.remaining_epochs);
        const id = `${ip}:${done ? 'done' : 'pending'}:${result.withdraw_epoch || result.exit_epoch || ''}:${remaining ?? ''}`;
        this.state.exitInfo = {
          id,
          ip,
          done,
          exit_epoch: result.exit_epoch !== undefined && result.exit_epoch !== null ? String(result.exit_epoch) : undefined,
          withdraw_epoch: result.withdraw_epoch !== undefined && result.withdraw_epoch !== null ? String(result.withdraw_epoch) : undefined,
          remaining,
          eta: undefined,
          active: Boolean(member.active),
          scheduled: Boolean(member.scheduled),
        };
        if (done) {
          this.state.exitWatching = null;
          this.clearExit();
        }
      } catch {
        // keep following
      }
    };
    void tick();
    this.exitTimer = setInterval(() => void tick(), 120000);
    this.exitTimer.unref?.();
  }

  private clearActivation(): void {
    if (this.activationTimer) {
      clearInterval(this.activationTimer);
      this.activationTimer = null;
    }
  }

  private clearExit(): void {
    if (this.exitTimer) {
      clearInterval(this.exitTimer);
      this.exitTimer = null;
    }
  }

  private clearWatchers(): void {
    this.clearActivation();
    this.clearExit();
    this.state.watching = null;
    this.state.exitWatching = null;
    this.state.activation = null;
    this.state.exitInfo = null;
  }
}

export const jobs = new JobManager();
