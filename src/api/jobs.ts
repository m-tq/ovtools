import * as fs from 'fs/promises';
import * as path from 'path';
import type { DiskPlan, JobRequest, JobState, LogEntry, Settings } from '../types';
import { createLogger, Logger, readJSON } from '../utils/helpers';
import { COMMON_ASSETS_DIR, DEFAULT_ROLE, SETTINGS_FILE, phaseMeta } from '../constants';
import { createSSHClient, shellQuote } from '../ssh/client';
import { DeployOrchestrator } from '../orchestrator/deploy';
import { MigrateOrchestrator } from '../orchestrator/migrate';
import { ManageOrchestrator } from '../orchestrator/manage';
import { getEnrollment, probeNode } from './nodes';
import { isHostKeyError, trustHostKey } from './hostkeys';
import { buildStepPlan } from '../steps';

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

  /**
   * Read-only look at the target disk before deploy/migrate touches it.
   * Runs pre-run.sh with SCAN_ONLY=1, so nothing is mounted rw, wiped or
   * formatted. The console uses this to ask for an explicit destructive-action
   * confirmation when the selected device would be erased.
   */
  async scanDisk(request: JobRequest): Promise<DiskPlan> {
    const program = request.program;
    if (program !== 'deploy' && program !== 'migrate') {
      throw new Error('disk scan is available for deploy and migrate only');
    }
    const settings = await loadSettings();
    const auth = this.auth(request, 'new');
    const ip = String(request.newIp || '').trim();
    if (!IP_RE.test(ip)) throw new Error('the target address is required');
    await this.validateAuth(auth, 'target', ip);

    const config = { host: ip, port: 22, username: 'root', auth };
    let client;
    try {
      client = await createSSHClient(config);
    } catch (err) {
      if (!isHostKeyError((err as Error).message)) throw err;
      const trust = await trustHostKey(ip, auth);
      if (!trust.ok) throw new Error(`host key for ${ip} is not trusted and auto-trust failed: ${trust.detail}`);
      client = await createSSHClient(config);
    }
    const dir = '/tmp/ovtools-disk-scan';
    try {
      // SFTP upload opens a channel per file and is slow on high-latency VPS
      // links (~7s for a 27KB script). A base64 exec keeps the pre-run scan
      // feeling immediate instead of looking like a dead button.
      const scanScript = (await fs.readFile(path.join(COMMON_ASSETS_DIR, 'pre-run.sh'))).toString('base64');
      const scanConfig = (await fs.readFile(path.join(COMMON_ASSETS_DIR, 'config.sh'))).toString('base64');
      await client.exec(`rm -rf ${dir} && mkdir -p ${dir}`, { timeout: 60000 });
      await client.exec(
        `printf %s ${shellQuote(scanScript)} | base64 -d > ${dir}/pre-run.sh && printf %s ${shellQuote(scanConfig)} | base64 -d > ${dir}/config.sh`,
        { timeout: 60000 }
      );
      const env = ['SCAN_ONLY=1'];
      if (program === 'deploy') {
        env.push(
          `SWAP_GB=${Number(settings.swapGB) || 8}`,
          `BLOCK_DEVICE=${shellQuote(settings.dataDevice)}`,
          `DATA_MIN_GB=${Number(settings.dataMinGB) || 1000}`,
          `WIPE_VOLUME=${request.keepData ? '0' : '1'}`
        );
      } else {
        env.push(`WIPE_VOLUME=${request.wipeTargetVolume ? '1' : '0'}`);
      }
      const result = await client.exec(`${env.join(' ')} bash ${dir}/pre-run.sh`, { timeout: 180000 });
      if (result.exitCode !== 0) {
        throw new Error((result.stderr || result.stdout || 'the disk scan failed').trim().slice(0, 600));
      }
      const fields = new Map<string, string>();
      for (const line of result.stdout.split('\n')) {
        const match = /^(SCAN_[A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (match) fields.set(match[1], match[2]);
      }
      const action = fields.get('SCAN_ACTION') || 'none';
      const lsblkB64 = fields.get('SCAN_LSBLK_B64') || '';
      const lsblk = lsblkB64 ? Buffer.from(lsblkB64, 'base64').toString('utf8') : '';
      return {
        action: (['format', 'keep', 'fallback', 'none'].includes(action) ? action : 'none') as DiskPlan['action'],
        program,
        ip,
        device: fields.get('SCAN_DEVICE') || null,
        disk: fields.get('SCAN_DISK') || null,
        sizeGB: Number.isFinite(Number(fields.get('SCAN_SIZE_GB'))) ? Number(fields.get('SCAN_SIZE_GB')) : null,
        fstype: fields.get('SCAN_FSTYPE') || null,
        label: fields.get('SCAN_LABEL') || null,
        mountpoint: fields.get('SCAN_MOUNT') || null,
        systemDisk: fields.get('SCAN_SYSTEM') === 'yes',
        hasDataset: fields.get('SCAN_DATASET') === 'yes',
        hasChain: fields.get('SCAN_CHAIN') === 'yes',
        model: fields.get('SCAN_MODEL') || null,
        reason: fields.get('SCAN_REASON') || '',
        lsblk,
      };
    } finally {
      await client.exec(`rm -rf ${dir}`, { timeout: 30000 }).catch(() => undefined);
      await client.disconnect();
    }
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
    const role = request.role === 'observer' ? 'observer' : DEFAULT_ROLE;
    const bondRaw = this.rawBond(request);
    const stepPlan = buildStepPlan(program, phase, {
      role,
      bond: bondRaw,
      dashboard: Boolean(request.domain || settings.dashboardDomain),
    });
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
      stepInfo: stepPlan ? { ...stepPlan, index: 0, status: 'running' } : null,
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
      if (program === 'deploy') {
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
            allowFormat: typeof request.allowFormat === 'boolean' ? request.allowFormat : undefined,
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
            allowFormat: typeof request.allowFormat === 'boolean' ? request.allowFormat : undefined,
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
          this.focusStep('enroll');
        }
        if (deploy.dashboardUrl) this.state.domain = deploy.dashboardUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const shouldWatch = deploy.awaitingEnroll === null
          && ['deploy', 'all', 'enroll', 'promote', 'verify'].includes(phase);
        if (shouldWatch) this.startActivationWatch(this.state.newIp!, phase, true);
        else this.state.watching = null;
      } else if (program === 'migrate') {
        const migrate = orch as MigrateOrchestrator;
        await migrate.run();
        if (phase === 'all' || phase === 'auto' || phase === 'verify' || migrate.activationPending) {
          this.startActivationWatch(this.state.newIp!, phase, true);
        } else {
          this.state.watching = null;
        }
      } else {
        await orch.run();
        const manage = orch as ManageOrchestrator;
        if (manage.dashboardUrl) this.state.domain = manage.dashboardUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        if (phase === 'exit') this.startExitWatch(this.state.newIp!);
        else if (manage.softStop) {
          // A manage task can finish with WAITING-FOLD/WAITING-SYNC/WAITING-RPC.
          // Follow the node in the background and close the modal only when the
          // tool's own wait resolves (recover waits for activation; the others
          // are confirmed by a healthy probe).
          this.startActivationWatch(this.state.newIp!, phase, phase === 'recover');
        } else {
          this.state.watching = null;
        }
      }
      if (this.state.stepInfo) {
        if (this.state.awaiting || this.state.watching || this.state.exitWatching) {
          this.state.stepInfo.status = 'waiting';
        } else {
          this.completeStep();
        }
      }
      this.state.exitCode = 0;
    } catch (err) {
      this.state.exitCode = 1;
      this.state.watching = null;
      if (this.state.stepInfo) this.state.stepInfo.status = 'failed';
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

  private advanceStep(id: string): void {
    const info = this.state.stepInfo;
    if (!info) return;
    const index = info.steps.findIndex(step => step.id === id);
    if (index < 0) return;
    if (index > info.index) info.index = index;
    if (info.status !== 'done' && info.status !== 'failed') info.status = 'running';
  }

  private focusStep(id: string): void {
    const info = this.state.stepInfo;
    if (!info) return;
    const index = info.steps.findIndex(step => step.id === id);
    if (index >= 0) info.index = index;
  }

  private completeStep(): void {
    const info = this.state.stepInfo;
    if (!info) return;
    info.index = Math.max(0, info.steps.length - 1);
    info.status = 'done';
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

    // Long finalizations announce themselves in the log before the run ends
    // ("waiting for rpc", "still waiting: ...", "waiting for the set fold").
    // Surface them as a live waiting popup while the phase keeps running; the
    // post-run watcher takes over the same state when the process exits.
    const phaseMatch = /===\s*Phase:\s*([A-Za-z0-9_-]+)\s*===/i.exec(entry.line);
    if (phaseMatch) this.advanceStep(phaseMatch[1]);

    const waitLine = /still waiting:|waiting for rpc|waiting for the process|validator is online but not a member|waiting for the set fold|waiting for the fold|catch-up:|waiting for (activation|confirmation)/i.test(entry.line);
    const waitingStatus = statusMatch ? /^WAITING-/i.test(statusMatch[1]) : false;
    if ((waitLine || waitingStatus) && this.state.running && this.state.newIp) {
      const prior = this.state.watching;
      const same = Boolean(prior && prior.ip === this.state.newIp);
      const detail = entry.line.replace(/^.*?\[(migrate|deploy|manage)\]\s*/i, '').trim().slice(0, 220);
      this.state.watching = {
        ip: this.state.newIp,
        since: same && prior ? prior.since : Date.now(),
        phase: [this.state.program, this.state.phase].filter(Boolean).join(' / '),
        activation: prior ? prior.activation : true,
        state: 'WAITING-CONFIRMATION',
        detail: detail || entry.line.slice(0, 220),
        checkedAt: Date.now(),
      };
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

  private startActivationWatch(ip: string, phase?: string, followActivation = true): void {
    if (!ip) return;
    this.clearActivation();
    const previous = this.state.watching;
    const since = previous && previous.ip === ip ? previous.since : Date.now();
    const initial = this.state.status;
    const phaseLabel = [this.state.program, phase].filter(Boolean).join(' / ') || phase;
    this.state.watching = {
      ip,
      since,
      phase: phaseLabel,
      activation: followActivation,
      state: initial?.state || previous?.state,
      detail: initial?.detail || previous?.detail,
      checkedAt: 0,
      active: false,
      scheduled: false,
    };
    this.logger?.log(
      `waiting for ${followActivation ? 'activation' : 'confirmation'} on ${ip} - the console follows up in the background every 60s`,
      'warn',
      { program: this.state.program, host: ip }
    );

    const deadline = since + (followActivation ? 6 * 3600 * 1000 : 30 * 60 * 1000);
    let lastHead: number | null = null;
    let lastMove = Date.now();
    let misses = 0;
    let healthy = 0;
    let lastProblem: string | null = null;

    const tick = async () => {
      if (Date.now() > deadline) {
        this.state.watching = null;
        if (this.state.stepInfo) this.state.stepInfo.status = 'failed';
        this.clearActivation();
        return;
      }
      try {
        const probe = await probeNode(ip);
        const validator = probe.validator || {};
        const chain = probe.chain || {};
        const headValue = chain.head_epoch ?? validator.head_epoch;
        const head = Number.isFinite(Number(headValue)) ? Number(headValue) : null;
        const epochValue = chain.epoch;
        const epoch = Number.isFinite(Number(epochValue)) ? Number(epochValue) : null;
        const active = Boolean(validator.active);
        const scheduled = Boolean(validator.scheduled);
        if (head !== null) {
          if (lastHead === null) {
            lastHead = head;
            lastMove = Date.now();
          } else if (head !== lastHead) {
            lastHead = head;
            lastMove = Date.now();
          }
        }
        misses = 0;
        let problem: string | null = null;
        if (!probe.reachable) {
          problem = `node did not answer the status probe${probe.error ? ` (${probe.error})` : ''}`;
        } else if (head !== null && Date.now() - lastMove > 10 * 60 * 1000) {
          problem = `head_epoch ${head} has not moved for ${Math.floor((Date.now() - lastMove) / 60000)} minutes`;
        }
        if (problem && problem !== lastProblem) {
          this.logger?.log(`follow-up: ${problem}`, 'warn', { program: this.state.program, host: ip });
        }
        lastProblem = problem;
        const status = this.state.status;
        this.state.watching = {
          ip,
          since,
          phase: phaseLabel,
          activation: followActivation,
          state: status?.state,
          detail: status?.detail,
          checkedAt: Date.now(),
          reachable: probe.reachable,
          epoch,
          headEpoch: head,
          enrollment: validator.state ?? null,
          active,
          scheduled,
          problem,
        };
        if (followActivation && active) {
          this.state.activation = {
            id: `${ip}:${validator.activate_epoch || validator.head_epoch || Date.now()}`,
            ip,
            epoch: Number(validator.activate_epoch || validator.head_epoch) || undefined,
            bond: Number(validator.bond) || undefined,
          };
          this.state.watching = null;
          this.completeStep();
          this.clearActivation();
          this.logger?.log(`validator on ${ip} is active - confirmation received`, 'ok', { program: this.state.program, host: ip });
          return;
        }
        if (!followActivation) {
          if (probe.reachable && !problem) healthy += 1;
          else healthy = 0;
          if (healthy >= 2) {
            this.logger?.log(`follow-up confirmed: ${ip} is responding - no blocker found`, 'ok', { program: this.state.program, host: ip });
            this.state.watching = null;
            this.completeStep();
            this.clearActivation();
          }
        }
      } catch (err) {
        misses += 1;
        healthy = 0;
        const message = err instanceof Error ? err.message : String(err);
        const problem = misses >= 2 ? `follow-up probe failed: ${message}` : lastProblem;
        if (misses >= 2 && problem !== lastProblem) {
          this.logger?.log(`follow-up: ${problem}`, 'warn', { program: this.state.program, host: ip });
        }
        lastProblem = problem;
        const current = this.state.watching;
        this.state.watching = {
          ...(current || { ip, since, phase: phaseLabel, activation: followActivation }),
          ip,
          since,
          phase: phaseLabel,
          activation: followActivation,
          checkedAt: Date.now(),
          reachable: false,
          problem,
        };
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
          this.completeStep();
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
