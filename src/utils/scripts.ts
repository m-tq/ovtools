import { SSHClient, shellQuote } from '../ssh/client';
import { REMOTE } from '../constants';
import { AssetSync, AssetLogger } from './assets';

export interface PushResult {
  manifest: string;
  skipped: boolean;
  files: number;
  transport: 'git' | 'tar' | 'clone';
}

export class ScriptManager {
  private client: SSHClient;
  private logger: AssetLogger;

  constructor(client: SSHClient, logger?: AssetLogger) {
    this.client = client;
    this.logger = logger || { log: () => undefined };
  }

  async pushScripts(dirs: string[] = ['deploy']): Promise<PushResult> {
    const sync = new AssetSync(this.client, this.logger, 'scripts');
    const tasks = dirs.filter(d => ['deploy', 'migrate', 'manage', 'upgrade'].includes(d));
    const result = await sync.syncScripts(tasks.length ? tasks : undefined);
    return {
      manifest: result.head,
      skipped: result.skipped,
      files: result.files,
      transport: result.transport,
    };
  }

  async runDetached(options: {
    program: 'deploy' | 'migrate' | 'manage' | 'upgrade';
    unit: string;
    script: string;
    workDir?: string;
    env?: Record<string, string>;
    outFile?: string;
    statusFile?: string;
    label?: string;
    onLog?: (line: string) => void;
  }): Promise<string> {
    const stateDir = REMOTE[options.program];
    const unit = options.unit;
    const workDir = options.workDir || '/root';
    const outFile = options.outFile || `${stateDir}/${unit}.out`;
    const statusFile = options.statusFile || `${stateDir}/status`;
    const env = Object.entries(options.env || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${shellQuote(String(v))}`)
      .join(' ');

    const pre = [
      `systemctl stop ${shellQuote(unit)} 2>/dev/null || true`,
      `systemctl reset-failed ${shellQuote(unit)} 2>/dev/null || true`,
      `rm -f ${shellQuote(statusFile)} ${shellQuote(outFile)} 2>/dev/null || true`,
    ].join('; ');
    await this.client.exec(pre, { timeout: 120000 });

    const inner = `${env ? env + ' ' : ''}bash ${shellQuote(options.script)} > ${shellQuote(outFile)} 2>&1`;
    const launch = `systemd-run --unit=${unit} --collect --no-block --working-directory=${shellQuote(workDir)} bash -c ${shellQuote(inner)}`;
    const result = await this.client.exec(launch, { timeout: 120000 });
    if (result.exitCode !== 0) {
      throw new Error(`could not launch unit ${unit}: ${result.stderr || result.stdout}`);
    }
    if (options.onLog) options.onLog(`started unit ${unit} (log ${outFile})`);
    return unit;
  }

  async followStatus(options: {
    program: 'deploy' | 'migrate' | 'manage' | 'upgrade';
    unit: string;
    timeoutSec: number;
    outFile?: string;
    statusFile?: string;
    onLine?: (line: string) => void;
    progressRe?: RegExp;
    pollSec?: number;
  }): Promise<{ state: string; detail: string; soft: boolean }> {
    const stateDir = REMOTE[options.program];
    const outFile = options.outFile || `${stateDir}/${options.unit}.out`;
    const statusFile = options.statusFile || `${stateDir}/status`;
    const started = Date.now();
    const deadline = started + options.timeoutSec * 1000;
    const poll = options.pollSec ?? 4;
    let lastSize = 0;
    let lastPrinted = '';
    let lastNoteAt = 0;
    let deadPolls = 0;
    let consecutiveErrors = 0;

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, poll * 1000));
      let probe: { stdout: string };
      try {
        probe = await this.client.exec(
          [
            `S=$(head -1 ${shellQuote(statusFile)} 2>/dev/null || echo RUNNING)`,
            `echo "STATUS:$S"`,
            `echo "ACTIVE:$(systemctl is-active ${shellQuote(options.unit)} 2>/dev/null || true)"`,
            `SIZE=$(stat -c %s ${shellQuote(outFile)} 2>/dev/null || echo 0)`,
            `echo "SIZE:$SIZE"`,
          ].join('; '),
          { timeout: 60000 }
        );
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors++;
        options.onLine?.(`SSH hiccup while following ${options.unit} (${consecutiveErrors}/10): ${(err as Error).message}`);
        if (consecutiveErrors >= 10) {
          return { state: 'FAILED', detail: `lost the SSH connection while following ${options.unit}`, soft: false };
        }
        try {
          await this.client.ensureConnected();
          options.onLine?.(`reconnected to ${this.client.host}; ${options.unit} keeps running`);
        } catch (reconnectErr) {
          options.onLine?.(`reconnect failed: ${(reconnectErr as Error).message}`);
        }
        continue;
      }
      const statusLine = probe.stdout.split('\n').find(l => l.startsWith('STATUS:'))?.slice(7).trim() || '';
      const active = probe.stdout.split('\n').find(l => l.startsWith('ACTIVE:'))?.slice(7).trim() || '';
      const size = Number(probe.stdout.split('\n').find(l => l.startsWith('SIZE:'))?.slice(5).trim() || 0);

      if (size > lastSize && options.onLine) {
        try {
          const tail = await this.client.exec(`tail -c +${lastSize + 1} ${shellQuote(outFile)} 2>/dev/null`, { timeout: 60000 });
          for (const line of tail.stdout.split('\n')) {
            if (line.trim()) options.onLine(line.replace(/\r$/, ''));
          }
          lastSize = size;
        } catch (err) {
          options.onLine?.(`could not read new output yet: ${(err as Error).message}`);
        }
      } else if (lastSize === 0 && options.onLine) {
        try {
          const tail = await this.client.exec(`tail -n 20 ${shellQuote(outFile)} 2>/dev/null`, { timeout: 60000 });
          for (const line of tail.stdout.split('\n')) {
            if (line.trim()) options.onLine(line.replace(/\r$/, ''));
          }
          lastSize = size;
        } catch (err) {
          options.onLine?.(`could not read the log yet: ${(err as Error).message}`);
        }
      }

      const parts = statusLine.split(/\s+/);
      const state = (parts.shift() || 'RUNNING').toUpperCase();
      const detail = parts.join(' ');
      if (state !== lastPrinted) {
        lastPrinted = state;
        options.onLine?.(`status = ${state} ${detail}`.trim());
        lastNoteAt = Date.now();
      } else if (Date.now() - lastNoteAt > 300000) {
        lastNoteAt = Date.now();
        options.onLine?.(`... still running (${Math.round((Date.now() - started) / 60000)} min elapsed, status ${state})`);
      }

      if (state === 'DONE') return { state, detail, soft: false };
      if (state === 'FAILED') return { state, detail, soft: false };
      if (state.startsWith('WAITING-')) return { state, detail, soft: true };

      if (!/^(active|activating|reloading|deactivating)$/.test(active)) {
        deadPolls++;
        if (deadPolls >= 2 && Date.now() - started > 15000) {
          const tail = await this.client.exec(`tail -n 15 ${shellQuote(outFile)} 2>/dev/null`, { timeout: 60000 });
          if (options.onLine) {
            for (const line of tail.stdout.split('\n')) if (line.trim()) options.onLine(line);
          }
          return { state: 'FAILED', detail: `unit ${options.unit} vanished without a verdict - see ${outFile}`, soft: false };
        }
      } else {
        deadPolls = 0;
      }
    }
    return { state: 'TIMEOUT', detail: `${options.unit} did not finish in ${options.timeoutSec}s - check the unit and ${outFile}`, soft: false };
  }

  async waitForScript(options: {
    program: 'deploy' | 'migrate' | 'manage' | 'upgrade';
    script: string;
    unit: string;
    env?: Record<string, string>;
    timeoutSec: number;
    workDir?: string;
    outFile?: string;
    statusFile?: string;
    onLine?: (line: string) => void;
  }): Promise<{ state: string; detail: string; soft: boolean }> {
    await this.runDetached(options);
    return this.followStatus(options);
  }

  async remoteStatus(program: 'deploy' | 'migrate' | 'manage' | 'upgrade'): Promise<{ state: string; detail: string }> {
    const file = `${REMOTE[program]}/status`;
    const result = await this.client.exec(`cat ${shellQuote(file)} 2>/dev/null || echo UNKNOWN`, { timeout: 60000 });
    const line = result.stdout.split('\n').filter(l => l.trim()).pop() || 'UNKNOWN';
    const parts = line.trim().split(/\s+/);
    const state = (parts.shift() || 'UNKNOWN').toUpperCase();
    return { state, detail: parts.join(' ') };
  }
}

export function createScriptManager(client: SSHClient, logger?: AssetLogger): ScriptManager {
  return new ScriptManager(client, logger);
}
