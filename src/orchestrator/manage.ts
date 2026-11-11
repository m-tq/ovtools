import { BaseOrchestrator } from './base';
import { StateManager } from '../utils/state';
import { Logger } from '../utils/helpers';
import { createScriptManager, ScriptManager } from '../utils/scripts';
import { deployDashboard } from '../utils/dashboard';
import type { ManageConfig, SSHConfig } from '../types';
import { STATE_FILES } from '../constants';

export class ManageOrchestrator extends BaseOrchestrator {
  private config: ManageConfig;
  private statePair: string;
  private managers: ScriptManager | null = null;
  softStop: { state: string; detail: string } | null = null;
  dashboardUrl: string | null = null;

  constructor(config: ManageConfig, logger: Logger) {
    const stateFile = config.phase === 'upgrade' || config.phase === 'manual' || config.phase === 'storage'
      ? STATE_FILES.upgrade
      : STATE_FILES.manage;
    super(new StateManager(stateFile), logger);
    this.config = config;
    this.statePair = config.ip;
    this.program = 'manage';
  }

  async run(): Promise<void> {
    const sshConfig: SSHConfig = {
      host: this.config.ip,
      port: 22,
      username: 'root',
      auth: this.config.auth,
    };
    try {
      this.client = await this.connectSSH(sshConfig, `node ${this.config.ip}`);
      this.managers = createScriptManager(this.client);

      if (this.config.reset) {
        await this.stateManager.reset(this.statePair);
        this.log('resume state cleared', 'info');
      }

      const phase = this.config.phase;
      const isUpgrade = phase === 'upgrade' || phase === 'manual' || phase === 'storage';
      await this.preflight(this.client);
      await this.pushScripts(this.client, isUpgrade ? ['upgrade'] : ['manage']);
      if (isUpgrade) {
        await this.ensureHostTools(
          this.client,
          ['bash', 'sed', 'grep', 'awk', 'tar', 'curl', 'git', 'rsync', 'jq', 'pgrep', 'nproc', 'make', 'g++', 'opam', 'du'],
          'update host tools'
        );
      } else {
        await this.ensureHostTools(this.client, undefined, 'manage host tools');
      }

      switch (phase) {
        case 'status': await this.stepStatus(); break;
        case 'bond': await this.stepBond(); break;
        case 'exit': await this.stepExit(); break;
        case 'dashboard': await this.stepDashboard(); break;
        case 'diagnose': await this.stepDiagnose(); break;
        case 'recover': await this.stepRecover(); break;
        case 'upgrade':
          await this.stepPreflightUpgrade();
          await this.stepUpgrade();
          break;
        case 'manual': await this.stepManual(); break;
        case 'storage': await this.stepStorage(); break;
        default: throw new Error(`unknown manage phase: ${phase}`);
      }

      if (phase !== 'dashboard') {
        const st = await this.remoteStatus(this.client, isUpgrade ? 'upgrade' : 'manage').catch(() => ({ state: 'UNKNOWN', detail: '' }));
        this.log(`node ${this.config.ip}: ${st.state} ${st.detail}`, 'info');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Manage ${this.config.phase} failed: ${msg}`, 'error');
      throw err;
    } finally {
      await this.disconnectSSH(this.client);
    }
  }

  private async runStep(options: {
    program: 'manage' | 'upgrade';
    script: string;
    unit: string;
    label: string;
    env?: Record<string, string>;
    timeoutSec: number;
    phase: string;
  }): Promise<{ state: string; detail: string; soft: boolean }> {
    this.startPhase(options.phase);
    const dir = options.program === 'upgrade' ? 'upgrade' : 'manage';
    await this.log(`--> [${this.config.ip}] ${options.label}`, 'step', this.config.ip);
    try {
      const result = await this.managers!.waitForScript({
        program: options.program,
        script: `/root/${dir}/${options.script}`,
        unit: options.unit,
        env: options.env,
        timeoutSec: options.timeoutSec,
        onLine: line => this.log(`    ${line}`, 'remote', this.config.ip),
      });
      if (result.state === 'DONE') {
        this.log(`${options.label} finished${result.detail ? ` (${result.detail})` : ''}`, 'ok', this.config.ip);
        this.completePhase(true);
        return result;
      }
      if (result.state.startsWith('WAITING-')) {
        this.log(`${options.label} stopped: ${result.state} ${result.detail}`, 'warn', this.config.ip);
        this.softStop = result;
        this.completePhase(true);
        return result;
      }
      this.log(`${options.label} failed: ${result.detail}`, 'error', this.config.ip);
      this.completePhase(false, result.detail);
      throw new Error(`${options.label} failed: ${result.detail}`);
    } catch (err) {
      this.completePhase(false, (err as Error).message);
      throw err;
    }
  }

  private async stepStatus(): Promise<void> {
    await this.runStep({
      program: 'manage',
      script: '30-status.sh',
      unit: 'octra-manage-status',
      label: 'read the active node',
      timeoutSec: 300,
      phase: 'status',
    });
  }

  private async stepBond(): Promise<void> {
    const amount = (this.config.amount || '').trim();
    if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(amount) || Number(amount) < 1) {
      throw new Error('type the amount to add in OCT (min 1, e.g. 100 or 12.5)');
    }
    const result = await this.runStep({
      program: 'manage',
      script: '10-bond-increase.sh',
      unit: 'octra-manage-bond-increase',
      label: `increase bond by ${amount} OCT`,
      env: { BOND_OCT: amount, ...(this.config.newBond ? { BOND_NEW: '1' } : {}) },
      timeoutSec: 1200,
      phase: 'bond',
    });
    if (result.soft) this.log(`the increase is not confirmed yet (${result.detail})`, 'warn');
  }

  private async stepExit(): Promise<void> {
    const result = await this.runStep({
      program: 'manage',
      script: '20-exit-validator.sh',
      unit: 'octra-manage-exit-validator',
      label: 'exit the validator set',
      timeoutSec: 3600,
      phase: 'exit',
    });
    if (result.soft) {
      this.log('=== exit accepted: the stake comes back on its own (unlock epoch above) ===', 'ok');
    }
  }

  private async stepDiagnose(): Promise<void> {
    await this.runStep({
      program: 'manage',
      script: '10-diagnose-node.sh',
      unit: 'octra-manage-diagnose-node',
      label: 'diagnose the node',
      timeoutSec: 600,
      phase: 'diagnose',
    });
  }

  private async stepRecover(): Promise<void> {
    const result = await this.runStep({
      program: 'manage',
      script: '25-recover-node.sh',
      unit: 'octra-manage-recover-node',
      label: 'repair the stuck node',
      env: { ALLOW_RESTART: this.config.noRestart ? '0' : '1' },
      timeoutSec: 2700,
      phase: 'recover',
    });
    if (result.soft) this.log(`recovery is waiting: ${result.state} ${result.detail}`, 'warn');
  }

  private async stepPreflightUpgrade(): Promise<void> {
    await this.runStep({
      program: 'upgrade',
      script: '10-preflight.sh',
      unit: 'octra-upgrade-preflight',
      label: 'preflight (what is on this host)',
      timeoutSec: 600,
      phase: 'preflight',
    });
  }

  private async stepUpgrade(): Promise<void> {
    const env: Record<string, string> = { UPGRADE_WAIT_SECONDS: String(this.config.waitSeconds || 900) };
    if (this.config.testOnly) env.UPGRADE_APPLY = '0';
    if (this.config.extra) env.UPGRADE_EXTRA = this.config.extra;
    const result = await this.runStep({
      program: 'upgrade',
      script: '20-upgrade.sh',
      unit: 'octra-upgrade-upgrade',
      label: 'update the node (official tool)',
      env,
      timeoutSec: 7500,
      phase: 'upgrade',
    });
    if (result.soft) this.log('the tool asked to wait (do NOT restart the node by hand) - run the update again later', 'warn');
  }

  private async stepManual(): Promise<void> {
    const result = await this.runStep({
      program: 'upgrade',
      script: '30-manual-upgrade.sh',
      unit: 'octra-upgrade-manual-upgrade',
      label: 'update the node (manual fallback)',
      timeoutSec: 8400,
      phase: 'manual',
    });
    if (result.soft) this.log('the manual update is not finished - re-run later', 'warn');
  }

  private async stepStorage(): Promise<void> {
    const result = await this.runStep({
      program: 'upgrade',
      script: '40-storage-prune.sh',
      unit: 'octra-upgrade-storage-prune',
      label: 'remove preserved states',
      env: this.config.testOnly ? { PRUNE_APPLY: '0' } : {},
      timeoutSec: 1500,
      phase: 'storage',
    });
    if (result.soft) this.log('the prune stopped - re-run later', 'warn');
  }

  private async stepDashboard(): Promise<void> {
    this.startPhase('dashboard');
    try {
      const result = await deployDashboard(
        this.client!,
        this.logger,
        {
          ip: this.config.ip,
          domain: this.config.domain,
          sslMode: this.config.sslMode || 'auto',
          certDir: this.config.certDir,
          email: this.config.email,
          reset: this.config.reset,
        },
        'manage'
      );
      this.dashboardUrl = result.url;
      this.completePhase(true);
    } catch (err) {
      this.completePhase(false, (err as Error).message);
      throw err;
    }
  }
}

export function createManageOrchestrator(config: ManageConfig, logger: Logger): ManageOrchestrator {
  return new ManageOrchestrator(config, logger);
}
