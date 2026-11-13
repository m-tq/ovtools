import { BaseOrchestrator } from './base';
import { SSHClient, shellQuote } from '../ssh/client';
import { StateManager } from '../utils/state';
import { Logger } from '../utils/helpers';

import type { MigrateConfig, SSHConfig } from '../types';
import { STATE_FILES, VERIFY_SAMPLES, VERIFY_INTERVAL, BACKUP_DIR } from '../constants';
import { ensureDir } from '../utils/helpers';
import * as path from 'path';

// Tools the migration itself runs on the SOURCE host (snapshot, rsync serve,
// authorized_keys, stop). The target needs the full host-tool set.
const MIGRATE_SOURCE_TOOLS = [
  'bash', 'sed', 'grep', 'awk', 'tar', 'gzip', 'curl', 'git', 'rsync',
  'jq', 'pgrep', 'pkill', 'nproc', 'du', 'python3',
];

export class MigrateOrchestrator extends BaseOrchestrator {
  private config: MigrateConfig;
  private statePair: string;
  private oldClient: SSHClient | null = null;
  private newClient: SSHClient | null = null;
  softStop: { state: string; detail: string } | null = null;
  activationPending = false;

  constructor(config: MigrateConfig, logger: Logger) {
    super(new StateManager(STATE_FILES.migrate), logger);
    this.config = config;
    this.statePair = `${config.oldIp}->${config.newIp}`;
    this.program = 'migrate';
  }

  async run(): Promise<void> {
    const phase = this.config.phase || 'all';
    try {
      this.oldClient = await this.connectSSH(this.baseSSH(this.config.oldIp, this.config.oldAuth), `source ${this.config.oldIp}`);

      if (this.config.oldIp === this.config.newIp) throw new Error('source and target are the same host');
      if (phase !== 'backup') {
        this.newClient = await this.connectSSH(this.baseSSH(this.config.newIp, this.config.newAuth), `target ${this.config.newIp}`);
      }

      if (this.config.reset) {
        await this.stateManager.reset(this.statePair);
        this.log('resume state cleared', 'info');
      }

      if (phase === 'status') {
        await this.showStatus();
        return;
      }

      await this.preflight(this.oldClient);
      // Tools first: the asset sync must use the real transport (git clone)
      // instead of silently falling back to a bundle/tar on a bare host.
      await this.ensureHostTools(this.oldClient, MIGRATE_SOURCE_TOOLS, 'source host tools');
      await this.pushScripts(this.oldClient, ['migrate']);

      if (this.newClient) {
        await this.preflight(this.newClient);
        await this.ensureHostTools(this.newClient, undefined, 'target host tools');
        await this.pushScripts(this.newClient, ['migrate']);
      }

      if (phase === 'backup') {
        await this.stepBackup();
        this.log('identity backup finished - archive is in the local backups folder', 'ok');
        return;
      }
      if (!this.newClient) throw new Error('a target host is required for this phase');

      // Mandatory hardening on EVERY phase that touches the target.
      await this.harden(this.newClient);

      if (phase === 'rollback') {
        await this.stepRollback();
        return;
      }

      if (phase === 'all' || phase === 'auto') {
        await this.ensure('backup', () => this.stepBackup());
        await this.ensure('prep', () => this.stepPrep());
        await this.ensure('pull', () => this.stepPull());
        await this.ensure('switch', () => this.stepSwitch());
        await this.ensure('finalize', () => this.stepFinalize());
        await this.ensure('verify', () => this.stepVerify());
        this.log('=== MIGRATION COMPLETE: the validator now runs on ' + this.config.newIp + ' ===', 'ok');
        this.log(`keep ${this.config.oldIp} powered off / fenced: its pm2 boot unit is disabled`, 'warn');
      } else {
        switch (phase) {
          case 'prep': await this.stepPrep(); break;
          case 'pull': await this.stepPull(); break;
          case 'switch': await this.stepSwitch(); break;
          case 'finalize': await this.stepFinalize(); break;
          case 'verify': await this.stepVerify(); break;
          default: throw new Error(`unknown migrate phase: ${phase}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Migration failed: ${msg}`, 'error');
      throw err;
    } finally {
      await this.disconnectSSH(this.oldClient);
      await this.disconnectSSH(this.newClient);
    }
  }

  private baseSSH(host: string, auth: MigrateConfig['oldAuth']): SSHConfig {
    return { host, port: 22, username: 'root', auth };
  }

  private async ensure(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.aborted) throw new Error('operation aborted');
    if (await this.stateManager.isStepDone(this.statePair, name)) {
      this.log(`${name} already completed - skipping`, 'info');
      return;
    }
    await fn();
    await this.stateManager.markStepDone(this.statePair, name);
  }

  private async showStatus(): Promise<void> {
    const cmd =
      "cat /root/migration/status 2>/dev/null || echo 'no migration status'; " +
      "su - octra -c 'cd /opt/octra/libv_litecore && sh controls/stat.sh' 2>/dev/null | grep -E '^(node|role|address|process|uptime|rpc|epoch|head_epoch|voting|validator_active|validator_enrollment|round_peers|p2p_connected) =' || echo 'node not installed here'";
    for (const [label, client] of [['OLD', this.oldClient], ['NEW', this.newClient]] as const) {
      if (!client) continue;
      this.log(`--- ${label} node status (${client.host}) ---`, 'step', client.host);
      const result = await client.exec(cmd, { timeout: 120000 });
      for (const line of result.stdout.split('\n')) if (line.trim()) this.log(`    ${line}`, 'data', client.host);
    }
  }

  private async runDirect(
    client: SSHClient,
    command: string,
    label: string,
    timeoutSec: number,
    options: { allowFailure?: boolean; env?: Record<string, string>; host?: string } = {}
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const host = options.host || client.host;
    this.log(`--> [${host}] ${label}`, 'step', host);
    const env = Object.entries(options.env || {}).map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ');
    const full = env ? `${env} ${command}` : command;
    const result = await client.exec(full, {
      timeout: timeoutSec * 1000,
      onLine: line => {
        if (line.trim()) this.log(`    ${line}`, 'remote', host);
      },
    });
    if (result.exitCode !== 0 && !options.allowFailure) {
      throw new Error(`${label} failed (exit ${result.exitCode})${result.stderr ? `: ${result.stderr.slice(0, 800)}` : ''}`);
    }
    return result;
  }

  private async runDetached(
    client: SSHClient,
    unit: string,
    command: string,
    label: string,
    timeoutSec: number,
    env: Record<string, string> = {}
  ): Promise<{ state: string; detail: string; soft: boolean; exitCode: number }> {
    const outFile = `/root/migration/${unit}.console.log`;
    this.log(`--> [${client.host}] ${label} (detached unit ${unit})`, 'step', client.host);
    return this.followDetached(client, unit, command, label, timeoutSec, env, outFile);
  }

  private async followDetached(
    client: SSHClient,
    unit: string,
    command: string,
    label: string,
    timeoutSec: number,
    env: Record<string, string>,
    outFile: string
  ): Promise<{ state: string; detail: string; soft: boolean; exitCode: number }> {
    const envStr = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ');
    const inner = `${envStr ? envStr + ' ' : ''}${command} > ${shellQuote(outFile)} 2>&1`;
    await client.exec(`systemctl stop ${shellQuote(unit)} 2>/dev/null || true; systemctl reset-failed ${shellQuote(unit)} 2>/dev/null || true; rm -f /root/migration/status ${shellQuote(outFile)} 2>/dev/null || true`, { timeout: 120000 });
    const launch = `systemd-run --unit=${unit} --collect --no-block --working-directory=/root/migrate bash -c ${shellQuote(inner)}`;
    const launched = await client.exec(launch, { timeout: 120000 });
    if (launched.exitCode !== 0) throw new Error(`could not launch ${unit}: ${launched.stderr || launched.stdout}`);
    this.log(`    ${label} runs as unit ${unit} - following /root/migration/status`, 'info', client.host);

    const started = Date.now();
    let lastSize = 0;
    let deadPolls = 0;
    while (Date.now() - started < timeoutSec * 1000) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const probe = await client.exec(
        `echo "STATUS:$(head -1 /root/migration/status 2>/dev/null || echo RUNNING)"; echo "ACTIVE:$(systemctl is-active ${shellQuote(unit)} 2>/dev/null || true)"; echo "SIZE:$(stat -c %s ${shellQuote(outFile)} 2>/dev/null || echo 0)"`,
        { timeout: 60000 }
      );
      const get = (prefix: string) => probe.stdout.split('\n').find(l => l.startsWith(prefix))?.slice(prefix.length).trim() || '';
      const statusLine = get('STATUS:');
      const active = get('ACTIVE:');
      const size = Number(get('SIZE:') || 0);
      if (size > lastSize) {
        const tail = await client.exec(`tail -c +${lastSize + 1} ${shellQuote(outFile)} 2>/dev/null`, { timeout: 60000 });
        for (const line of tail.stdout.split('\n')) if (line.trim()) this.log(`    ${line}`, 'remote', client.host);
        lastSize = size;
      }
      const parts = statusLine.split(/\s+/);
      const state = (parts.shift() || 'RUNNING').toUpperCase();
      const detail = parts.join(' ');
      if (state === 'DONE') return { state, detail, soft: false, exitCode: 0 };
      if (state === 'FAILED') return { state, detail, soft: false, exitCode: 1 };
      if (state.startsWith('WAITING-')) return { state, detail, soft: true, exitCode: 2 };
      // A single empty `systemctl is-active` read (SSH hiccup, systemd busy)
      // must not kill a long rsync. Require repeated dead probes.
      if (!/^(active|activating|reloading|deactivating)$/.test(active)) {
        if (Date.now() - started > 15000) {
          deadPolls++;
          if (deadPolls >= 3) {
            const tail = await client.exec(`tail -n 20 ${shellQuote(outFile)} 2>/dev/null`, { timeout: 60000 });
            for (const line of tail.stdout.split('\n')) if (line.trim()) this.log(`    ${line}`, 'remote', client.host);
            return { state: 'FAILED', detail: `unit ${unit} died without a verdict (see ${outFile})`, soft: false, exitCode: 1 };
          }
        }
      } else {
        deadPolls = 0;
      }
    }
    return { state: 'TIMEOUT', detail: `${label} did not finish in ${timeoutSec}s`, soft: false, exitCode: 1 };
  }

  private async stepBackup(): Promise<void> {
    this.startPhase('backup');
    try {
      await this.runDirect(this.oldClient!, 'bash /root/migrate/00-backup-identity.sh', '00-backup-identity.sh (source identity snapshot)', 600);
      const listing = await this.oldClient!.exec("ls -t /root/migration/backups/*.tar.gz 2>/dev/null | head -1", { timeout: 60000 });
      const remote = listing.stdout.split('\n').map(l => l.trim()).find(l => l.startsWith('/root/'));
      if (!remote) {
        this.log('no identity archive found on the source', 'warn', this.oldClient!.host);
        this.completePhase(true);
        return;
      }
      await ensureDir(BACKUP_DIR);
      const local = path.join(BACKUP_DIR, path.basename(remote));
      this.log(`downloading ${remote} -> ${local}`, 'step', this.oldClient!.host);
      await this.oldClient!.downloadFile(remote, local);
      this.log(`identity archive copied to ${BACKUP_DIR}`, 'ok');
      this.completePhase(true);
    } catch (err) {
      this.completePhase(false, (err as Error).message);
      throw err;
    }
  }

  private async stepPrep(): Promise<void> {
    this.startPhase('prep');
    try {
      if (this.config.wipeTargetVolume) {
        this.log('forced reformat requested: the data volume will be formatted even if it holds an Octra data set', 'warn');
        await this.stateManager.reset(this.statePair);
      }
      let alreadyPulled = false;
      for (const step of ['pull', 'switch', 'finalize', 'verify']) {
        if (await this.stateManager.isStepDone(this.statePair, step)) alreadyPulled = true;
      }

      const prev = await this.getPrerunState(this.newClient!, '/root/migration/prerun.env');
      let prevMode = this.prepMode(prev, alreadyPulled, !this.config.keepTargetData);
      let preRun = 'bash /root/pre-run.sh';
      if (this.config.wipeTargetVolume) {
        preRun = 'WIPE_VOLUME=1 bash /root/pre-run.sh';
      } else if (prevMode === 'wipe') {
        if (await this.targetNodeRunning(this.newClient!)) {
          throw new Error(`the target data store still holds chain state and a node is running on ${this.config.newIp} - refusing to format it`);
        }
        this.log(`the target still holds a stale Octra data set (${prev.dev}, chain-state=yes) and nothing was pulled yet - reformatting it in this pass`, 'warn');
        preRun = 'WIPE_VOLUME=1 bash /root/pre-run.sh';
      } else if (prevMode === 'force' && alreadyPulled) {
        this.log(`keeping the data set on ${this.config.newIp}: this migration already pulled into it`, 'info');
      }

      await this.runDirect(this.newClient!, preRun, 'pre-run.sh (swap + data store: auto format/mount)', 1800);

      let pre = await this.getPrerunState(this.newClient!, '/root/migration/prerun.env');
      this.log(`target data store: ${pre.dev || 'no dedicated volume'} -> ${pre.mount} (action=${pre.action}, data-set=${pre.dataSet ? 'yes' : 'no'}, chain-state=${pre.chain ? 'yes' : 'no'})`, 'info');

      let mode = this.prepMode(pre, alreadyPulled, !this.config.keepTargetData);
      if (mode === 'wipe') {
        if (await this.targetNodeRunning(this.newClient!)) {
          throw new Error(`the target data store still holds chain state and a node is running on ${this.config.newIp} - refusing to format it`);
        }
        this.log('the target volume still holds a stale Octra data set and nothing was pulled yet - reformatting it now', 'warn');
        try {
          await this.runDirect(this.newClient!, 'WIPE_VOLUME=1 bash /root/pre-run.sh', 'pre-run.sh (WIPE_VOLUME=1: reformat the stale data set)', 1800);
          pre = await this.getPrerunState(this.newClient!, '/root/migration/prerun.env');
          mode = 'plain';
        } catch (err) {
          this.log(`could not reformat the data volume (${(err as Error).message}) - dropping the stale node state instead`, 'warn');
          if (await this.targetNodeRunning(this.newClient!)) {
            throw new Error(`cannot reformat or reset the target data store on ${this.config.newIp} while a node is running there`);
          }
          mode = 'reset';
        }
      } else if (mode === 'reset') {
        this.log(`no dedicated volume to format - the stale node state on ${this.config.newIp} will be dropped (RESET_TARGET=1)`, 'warn');
      } else if (mode === 'force') {
        this.log(`keeping the data set on ${this.config.newIp} (a resumable copy) - preparing with FORCE=1`, 'info');
      }

      const runPrepMode = async (m: string) => {
        const env: Record<string, string> = m === 'force' ? { FORCE: '1' } : m === 'reset' ? { RESET_TARGET: '1' } : {};
        await this.runDirect(this.newClient!, 'bash /root/migrate/01-prepare-target.sh', `01-prepare-target.sh (${m})`, 1800, { env });
      };
      try {
        await runPrepMode(mode);
      } catch (err) {
        if (mode === 'reset' || this.config.keepTargetData) throw err;
        this.log(`prep failed (${(err as Error).message}) - self-healing: dropping the target node state and preparing again`, 'warn');
        if (await this.targetNodeRunning(this.newClient!)) {
          throw new Error(`prep failed and a node is running on ${this.config.newIp} - not touching its data`);
        }
        await runPrepMode('reset');
      }

      const pubkeyResult = await this.newClient!.exec('cat /root/migration/target_ssh_key.pub 2>/dev/null || true', { timeout: 60000 });
      const pubkey = pubkeyResult.stdout.split('\n').map(l => l.trim()).find(l => l.startsWith('ssh-'));
      if (!pubkey) throw new Error(`could not read the pull public key from ${this.config.newIp}`);
      await this.runDirect(this.oldClient!, `bash /root/migrate/02-authorize-pull.sh ${shellQuote(pubkey)}`, '02-authorize-pull.sh', 600);
      await this.runDirect(
        this.newClient!,
        `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new root@${this.config.oldIp} 'echo KEY_AUTH_OK' | grep KEY_AUTH_OK`,
        `verify key auth ${this.config.newIp} -> ${this.config.oldIp}`,
        300
      );
      this.log('prep complete', 'ok');
      this.completePhase(true);
    } catch (err) {
      this.completePhase(false, (err as Error).message);
      throw err;
    }
  }

  private async stepPull(): Promise<void> {
    this.startPhase('pull');
    try {
      await this.runDirect(this.oldClient!, 'bash /root/migrate/00-backup-identity.sh', '00-backup-identity.sh (source identity snapshot)', 600);
      const result = await this.runDetached(
        this.newClient!,
        'octra-pull-initial',
        'bash /root/migrate/03-pull-state.sh',
        'initial state pull (node stays online)',
        90 * 60,
        { OLD_HOST: this.config.oldIp }
      );
      if (result.state !== 'DONE') throw new Error(`initial pull ${result.state}: ${result.detail}`);
      this.completePhase(true);
    } catch (err) {
      this.completePhase(false, (err as Error).message);
      throw err;
    }
  }

  private async stepSwitch(): Promise<void> {
    this.startPhase('switch');
    try {
      this.log('STOPPING SOURCE NODE', 'warn');
      await this.runDirect(this.newClient!, 'bash /root/migrate/04-stop-source.sh', '04-stop-source.sh (fence the old wallet)', 900, {
        env: { OLD_HOST: this.config.oldIp },
      });
      const result = await this.runDetached(
        this.newClient!,
        'octra-pull-final',
        'bash /root/migrate/03-pull-state.sh --final',
        'final delta pull (source stopped)',
        60 * 60,
        { OLD_HOST: this.config.oldIp }
      );
      if (result.state !== 'DONE') throw new Error(`final pull ${result.state}: ${result.detail}`);
      this.completePhase(true);
    } catch (err) {
      this.completePhase(false, (err as Error).message);
      throw err;
    }
  }

  private async stepFinalize(): Promise<void> {
    this.startPhase('finalize');
    try {
      await this.runDirect(this.newClient!, 'bash /root/migrate/05-finalize-target.sh', '05-finalize-target.sh', 2700, {
        env: { NEW_HOST: this.config.newIp },
      });
      this.completePhase(true);
    } catch (err) {
      this.completePhase(false, (err as Error).message);
      throw err;
    }
  }

  private async stepVerify(): Promise<void> {
    this.startPhase('verify');
    try {
      await this.runDirect(this.newClient!, 'bash /root/migrate/06-start-target.sh', '06-start-target.sh (includes double-sign guard)', 900, {
        env: { OLD_HOST: this.config.oldIp },
      });
      const samples = this.config.samples || VERIFY_SAMPLES;
      const interval = this.config.interval || VERIFY_INTERVAL;
      // rpc wait + set-fold wait + enrollment projection wait + samples + cushion
      const ceiling = 900 + 2700 + 900 + Math.max(1, samples) * Math.max(5, interval) + 600;
      let verify = { exitCode: 1, stdout: '', stderr: '' };
      for (let attempt = 1; attempt <= 2; attempt++) {
        verify = await this.runDirect(
          this.newClient!,
          'bash /root/migrate/07-verify.sh',
          attempt === 1 ? '07-verify.sh (voting check)' : '07-verify.sh (voting check, retry 1/1)',
          ceiling,
          { allowFailure: true, env: { SAMPLES: String(samples), INTERVAL: String(interval) } }
        );
        if (verify.exitCode === 0 || verify.exitCode === 2) break;
        if (attempt === 1) {
          this.log('verify did not pass on the first read - retrying in 30s (the node may still be warming its RPC/enrollment projection)', 'warn');
          await new Promise(resolve => setTimeout(resolve, 30000));
        }
      }
      if (verify.exitCode === 2) {
        this.log('=== verify: the node runs, is in sync and holds the bond - the set has not admitted it yet ===', 'ok');
        this.log('that is the chain schedule (the fold re-admits it); nothing was re-enrolled and nothing has to be re-run', 'info');
        this.softStop = { state: 'WAITING-FOLD', detail: 'migrated and in sync; waiting for the set fold' };
        this.activationPending = true;
        this.completePhase(true);
        return;
      }
      if (verify.exitCode !== 0) {
        this.log(`verification did NOT pass after 2 attempts (exit ${verify.exitCode})`, 'error');
        if (/validator_enrollment is not ready/i.test(verify.stdout)) {
          this.log('the node is running; only the enrollment projection did not settle. Re-run the verify phase (it resumes here) before considering a rollback.', 'warn');
        } else {
          this.log(`the source is stopped - inspect 07-verify.sh output, or bring the old validator back with the rollback phase`, 'warn');
        }
        throw new Error(`07-verify.sh failed (exit ${verify.exitCode})`);
      }
      this.log(`verification passed - validator is live on ${this.config.newIp}`, 'ok');
      this.completePhase(true);
    } catch (err) {
      this.completePhase(false, (err as Error).message);
      throw err;
    }
  }

  private async stepRollback(): Promise<void> {
    this.startPhase('rollback');
    try {
      await this.runDirect(this.newClient!, 'bash /root/migrate/08-rollback.sh', '08-rollback.sh', 900, {
        env: { OLD_HOST: this.config.oldIp },
      });
      this.log(`rollback finished - validator is back on ${this.config.oldIp}`, 'ok');
      this.completePhase(true);
    } catch (err) {
      this.completePhase(false, (err as Error).message);
      throw err;
    }
  }
}

export function createMigrateOrchestrator(config: MigrateConfig, logger: Logger): MigrateOrchestrator {
  return new MigrateOrchestrator(config, logger);
}
