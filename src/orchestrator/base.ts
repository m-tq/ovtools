import { SSHClient, createSSHClient, shellQuote } from '../ssh/client';
import { StateManager } from '../utils/state';
import { Logger } from '../utils/helpers';
import { ScriptManager, createScriptManager } from '../utils/scripts';
import { isHostKeyError, trustHostKey } from '../api/hostkeys';
import type { SSHConfig, PhaseState, RemoteResult } from '../types';
import { RETRY_PAUSE, REMOTE } from '../constants';

export interface PrerunState {
  dev: string;
  mount: string;
  action: string;
  dataSet: boolean;
  chain: boolean;
  force: boolean;
}

const HOST_TOOL_PACKAGES: Record<string, string> = {
  bash: 'bash', sed: 'sed', grep: 'grep', awk: 'gawk', tar: 'tar', gzip: 'gzip',
  curl: 'curl', git: 'git', rsync: 'rsync', jq: 'jq', pgrep: 'psmisc', pkill: 'psmisc',
  nproc: 'coreutils', lsblk: 'util-linux', findmnt: 'util-linux', blkid: 'util-linux',
  wipefs: 'util-linux', 'mkfs.ext4': 'e2fsprogs', 'systemd-run': 'systemd',
  nginx: 'nginx', certbot: 'certbot', python3: 'python3', make: 'build-essential',
  'g++': 'build-essential', opam: 'opam', du: 'coreutils',
};

export abstract class BaseOrchestrator {
  protected client: SSHClient | null = null;
  protected stateManager: StateManager;
  protected logger: Logger;
  protected scriptManager: ScriptManager | null = null;
  protected phases: PhaseState[] = [];
  protected aborted = false;
  protected program = 'deploy';

  constructor(stateManager: StateManager, logger: Logger) {
    this.stateManager = stateManager;
    this.logger = logger;
  }

  protected log(message: string, level: 'info' | 'ok' | 'warn' | 'error' | 'step' | 'remote' | 'data' = 'info', host?: string): void {
    this.logger.log(message, level, { host, program: this.program });
  }

  protected async connectSSH(config: SSHConfig, label?: string): Promise<SSHClient> {
    this.log(`Connecting to ${label || config.host}...`, 'info', config.host);
    try {
      const client = await createSSHClient(config);
      this.log(`Connected to ${label || config.host}`, 'ok', config.host);
      return client;
    } catch (err) {
      if (!isHostKeyError((err as Error).message)) throw err;
      // A reinstalled VPS presents a new key. Accept this handshake's key (the
      // same auto-trust the Check does) and retry once; the pin is persisted so
      // every later phase matches it too.
      this.log(`host key changed on ${config.host} (typical after a VPS reinstall) - auto-trusting the key it presents now`, 'warn', config.host);
      const trust = await trustHostKey(config.host, config.auth);
      if (!trust.ok) {
        throw new Error(`host key for ${config.host} is not trusted and auto-trust failed: ${trust.detail}`);
      }
      this.log(`host key auto-trusted: ${trust.fingerprint || 'new key'} (${trust.detail})`, 'warn', config.host);
      const client = await createSSHClient(config);
      this.log(`Connected to ${label || config.host}`, 'ok', config.host);
      return client;
    }
  }

  protected async disconnectSSH(client: SSHClient | null): Promise<void> {
    if (client && client.isConnected()) await client.disconnect();
  }

  protected startPhase(name: string): void {
    this.phases.push({ phase: name, started: new Date() });
    this.log(`=== Phase: ${name} ===`, 'step');
  }

  protected completePhase(success: boolean, error?: string): void {
    const current = this.phases[this.phases.length - 1];
    if (!current) return;
    current.completed = new Date();
    current.success = success;
    current.error = error;
    const seconds = Math.round((current.completed.getTime() - current.started.getTime()) / 1000);
    this.log(`Phase ${current.phase} ${success ? 'completed' : 'failed'} in ${seconds}s`, success ? 'ok' : 'error');
  }

  protected async execRemote(
    client: SSHClient,
    command: string,
    label?: string,
    options: { timeout?: number; stream?: boolean; host?: string; allowFailure?: boolean } = {}
  ): Promise<RemoteResult> {
    const host = options.host || client.host;
    if (label) this.log(`--> [${host}] ${label}`, 'step', host);
    const result = await client.exec(command, {
      timeout: options.timeout,
      onLine: line => {
        if (options.stream && line.trim()) this.log(`    ${line}`, 'remote', host);
      },
    });
    if (result.exitCode !== 0 && !options.allowFailure) {
      if (result.stderr.trim()) this.log(result.stderr.trim().slice(0, 2000), 'error', host);
      this.log(`Command failed with exit code ${result.exitCode}`, 'warn', host);
    }
    return result;
  }

  protected async pushScripts(client: SSHClient, dirs: string[]): Promise<void> {
    const manager = createScriptManager(client, this.logger);
    this.log(`--> [${client.host}] sync scripts (${dirs.join(', ')})`, 'step', client.host);
    const result = await manager.pushScripts(dirs);
    if (result.skipped) {
      this.log(`scripts on ${client.host} are up to date (${result.transport} ${result.manifest.slice(0, 12)}) - transfer skipped`, 'ok', client.host);
    } else {
      this.log(`${result.files} script file(s) synced to ${client.host} via ${result.transport}`, 'ok', client.host);
    }
  }

  protected async ensureHostTools(client: SSHClient, tools?: string[], label = 'host tools'): Promise<void> {
    const want = tools && tools.length ? tools : Object.keys(HOST_TOOL_PACKAGES);
    const missing = await this.missingTools(client, want);
    if (!missing.length) {
      this.log(`${label}: all ${want.length} present on ${client.host}`, 'ok', client.host);
      return;
    }
    const packages = Array.from(new Set(missing.map(t => HOST_TOOL_PACKAGES[t]).filter(Boolean))).sort();
    this.log(`${label} missing on ${client.host}: ${missing.join(', ')} - installing ${packages.join(', ')}`, 'warn', client.host);
    const result = await this.execRemote(
      client,
      `export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get install -y ${packages.map(shellQuote).join(' ')}`,
      `install ${packages.join(', ')}`,
      { timeout: 900000, stream: true }
    );
    if (result.exitCode !== 0) throw new Error(`could not install host tools on ${client.host}: ${result.stderr || result.stdout}`);
    const still = await this.missingTools(client, want);
    if (still.length) throw new Error(`${label} still missing on ${client.host}: ${still.join(', ')}`);
    this.log(`${label}: installed and verified`, 'ok', client.host);
  }

  private async missingTools(client: SSHClient, tools: string[]): Promise<string[]> {
    const probe = `missing=""; for t in ${tools.map(shellQuote).join(' ')}; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done; echo "MISSING=\${missing# }"`;
    const result = await this.execRemote(client, probe, undefined, { timeout: 180000 });
    const line = result.stdout.split('\n').filter(l => l.startsWith('MISSING=')).pop();
    if (!line) throw new Error(`could not read the tool list of ${client.host}`);
    return line.slice('MISSING='.length).trim().split(/\s+/).filter(Boolean);
  }

  protected async preflight(client: SSHClient): Promise<void> {
    await this.execRemote(
      client,
      'hostname; date -u; nproc; free -h; lsblk -ln -d -o NAME,SIZE 2>/dev/null; df -h / /var/lib/octra 2>/dev/null | tail -2; true',
      'preflight',
      { timeout: 600000, stream: true }
    );
  }

  protected async harden(client: SSHClient): Promise<void> {
    await this.execRemote(client, 'bash /root/harden-host.sh', 'harden-host.sh (net.mptcp.enabled = 0)', {
      timeout: 300000,
      stream: true,
    });
    this.log('host hardening applied: net.mptcp.enabled = 0', 'ok', client.host);
  }

  protected async getPrerunState(client: SSHClient, file = '/root/migration/prerun.env'): Promise<PrerunState> {
    const text = await client.readRemoteFile(file);
    const state: PrerunState = { dev: '', mount: '', action: 'unknown', dataSet: false, chain: false, force: false };
    for (const raw of (text || '').split('\n')) {
      const line = raw.trim();
      const m = /^(PRERUN_[A-Z_]+)=(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1];
      const value = m[2];
      if (key === 'PRERUN_DEV') state.dev = value;
      else if (key === 'PRERUN_MOUNT') state.mount = value;
      else if (key === 'PRERUN_ACTION') state.action = value;
      else if (key === 'PRERUN_DATASET') state.dataSet = value === 'yes';
      else if (key === 'PRERUN_CHAIN') state.chain = value === 'yes';
      else if (key === 'PRERUN_FORCE') state.force = value === '1';
    }
    return state;
  }

  protected prepMode(state: PrerunState, alreadyPulled: boolean, allowWipe: boolean): 'plain' | 'force' | 'wipe' | 'reset' {
    if (alreadyPulled) return 'force';
    if (!state.dataSet) return 'plain';
    if (!state.chain) return 'force';
    if (!allowWipe) return 'force';
    if (state.action === 'fallback') return 'reset';
    return 'wipe';
  }

  protected async targetNodeRunning(client: SSHClient): Promise<boolean> {
    const result = await client.exec(
      "ps -eo args --no-headers 2>/dev/null | grep -E '[o]ctra_node\\.exe|[o]ctra_pvac_worker\\.exe' | head -1 || true",
      { timeout: 60000 }
    );
    return /octra_(node|pvac_worker)\.exe/.test(result.stdout);
  }

  protected async remoteStatus(client: SSHClient, program: 'deploy' | 'migrate' | 'manage' | 'upgrade'): Promise<{ state: string; detail: string }> {
    const file = `${REMOTE[program]}/status`;
    const result = await client.exec(`cat ${shellQuote(file)} 2>/dev/null || echo UNKNOWN`, { timeout: 60000 });
    const line = result.stdout.split('\n').filter(l => l.trim()).pop() || 'UNKNOWN';
    const parts = line.trim().split(/\s+/);
    return { state: (parts.shift() || 'UNKNOWN').toUpperCase(), detail: parts.join(' ') };
  }

  protected async walletAddress(client: SSHClient): Promise<string> {
    const result = await client.exec(
      "cat /opt/octra/libv_litecore/.keys/validator/wallet.json 2>/dev/null | jq -r '.address // empty' 2>/dev/null || echo unknown",
      { timeout: 60000 }
    );
    return result.stdout.split('\n').filter(Boolean).pop()?.trim() || 'unknown';
  }

  protected async retryStep<T>(fn: () => Promise<T>, label: string, maxRetries = 3): Promise<T> {
    let lastError: Error | null = null;
    for (let i = 0; i < maxRetries; i++) {
      if (this.aborted) throw new Error('Operation aborted');
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.log(`${label} failed (attempt ${i + 1}/${maxRetries}): ${lastError.message}`, 'warn');
        if (i < maxRetries - 1) {
          const delay = RETRY_PAUSE * (i + 1);
          this.log(`Retrying in ${delay}s...`, 'info');
          await new Promise(resolve => setTimeout(resolve, delay * 1000));
        }
      }
    }
    throw lastError || new Error(`${label} failed after ${maxRetries} attempts`);
  }

  abort(): void {
    this.aborted = true;
    this.log('Orchestrator aborting...', 'warn');
  }

  getPhases(): PhaseState[] {
    return [...this.phases];
  }

  abstract run(): Promise<void>;
}
