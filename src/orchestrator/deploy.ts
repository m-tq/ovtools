import { BaseOrchestrator } from './base';
import { StateManager } from '../utils/state';
import { Logger } from '../utils/helpers';
import { createScriptManager, ScriptManager } from '../utils/scripts';
import { deployDashboard } from '../utils/dashboard';
import type { DeployConfig, SSHConfig } from '../types';
import { STATE_FILES, VERIFY_SAMPLES, VERIFY_INTERVAL } from '../constants';

export class DeployOrchestrator extends BaseOrchestrator {
  private config: DeployConfig;
  private statePair: string;
  private managers: ScriptManager | null = null;
  awaitingEnroll: { address: string; bond: number } | null = null;
  softStop: { state: string; detail: string } | null = null;
  dashboardUrl: string | null = null;

  constructor(config: DeployConfig, logger: Logger) {
    super(new StateManager(STATE_FILES.deploy), logger);
    this.config = config;
    this.statePair = config.ip;
    this.program = 'deploy';
  }

  async run(): Promise<void> {
    const sshConfig: SSHConfig = {
      host: this.config.ip,
      port: 22,
      username: 'root',
      auth: this.config.auth,
    };
    try {
      this.client = await this.connectSSH(sshConfig, `target ${this.config.ip}`);
      this.managers = createScriptManager(this.client);

      if (this.config.reset) {
        await this.stateManager.reset(this.statePair);
        this.log('resume state cleared', 'info');
      }

      const phase = this.config.phase || 'deploy';
      if (phase === 'status') {
        const st = await this.remoteStatus(this.client, 'deploy');
        this.log(`target ${this.config.ip}: ${st.state} ${st.detail}`, 'info');
        return;
      }

      await this.preflight(this.client);
      // Install the tools before the asset sync so a bare host does not fall
      // back to a bundle/tar just because git is missing.
      await this.ensureHostTools(this.client, undefined, 'deploy host tools');
      await this.pushScripts(this.client, ['deploy']);
      await this.harden(this.client);

      if (phase === 'deploy' || phase === 'all') {
        await this.runAll();
      } else {
        await this.runSingle(phase);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Deploy failed: ${msg}`, 'error');
      throw err;
    } finally {
      await this.disconnectSSH(this.client);
    }
  }

  private async runAll(): Promise<void> {
    await this.ensure('prep', () => this.stepPrep());
    await this.ensure('toolchain', () => this.stepToolchain());
    await this.ensure('setup', () => this.stepSetup());
    await this.ensure('start', () => this.stepStart());
    await this.ensure('verify', () => this.stepVerify());
    if (this.config.role === 'validator' && this.config.bond > 0) {
      await this.ensure('enroll', () => this.stepEnroll());
      if (!this.awaitingEnroll) {
        await this.ensure('promote', () => this.stepPromote());
      } else {
        this.log('enrollment is waiting for funding - promote starts after the wallet is funded', 'warn');
      }
    } else if (this.config.role === 'validator') {
      const address = await this.walletAddress(this.client!);
      this.log(`no bond given: the node stays an observer - fund ${address} and enroll when ready`, 'warn');
      this.awaitingEnroll = { address, bond: 1_000_000 };
    }
    if (this.config.domain && !this.config.skipDashboard) {
      await this.ensure('dashboard', () => this.stepDashboard());
    }
    this.log('=== DEPLOY COMPLETE: node ready on ' + this.config.ip + ' ===', 'ok');
    if (!this.config.bond || this.config.role !== 'validator') {
      const address = await this.walletAddress(this.client!);
      this.log(`node address: ${address}`, 'info');
    }
  }

  private async runSingle(phase: string): Promise<void> {
    switch (phase) {
      case 'prep': await this.stepPrep(); break;
      case 'toolchain': await this.stepToolchain(); break;
      case 'setup': await this.stepSetup(); break;
      case 'start': await this.stepStart(); break;
      case 'verify': await this.stepVerify(); break;
      case 'enroll': await this.stepEnroll(); break;
      case 'promote': await this.stepPromote(); break;
      case 'dashboard': await this.stepDashboard(); break;
      default: throw new Error(`unknown deploy phase: ${phase}`);
    }
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

  private async runStep(options: {
    script: string;
    unit: string;
    label: string;
    env?: Record<string, string>;
    timeoutSec: number;
    phase: string;
  }): Promise<{ state: string; detail: string; soft: boolean }> {
    this.startPhase(options.phase);
    this.log(`--> [${this.config.ip}] ${options.label} (detached unit ${options.unit})`, 'step', this.config.ip);
    try {
      const result = await this.managers!.waitForScript({
        program: 'deploy',
        script: options.script,
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
        this.completePhase(true);
        this.softStop = { state: result.state, detail: result.detail };
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

  private async stepPrep(): Promise<void> {
    // Deploy is for a fresh node: an existing wallet means migrate instead.
    const pre = await this.getPrerunState(this.client!, '/root/deploy/prerun.env');
    const walletProbe = await this.client!.exec('test -f /opt/octra/libv_litecore/.keys/validator/wallet.json && echo WALLET=yes || echo WALLET=no', { timeout: 60000 });
    const hasWallet = walletProbe.stdout.includes('WALLET=yes');
    if (hasWallet && !this.config.wipeVolume) {
      throw new Error('this host already has a node identity (wallet.json). Deploy is for a FRESH node - use Migrate, or pass wipeVolume to start over');
    }
    if (pre.dataSet && !hasWallet && !this.config.keepData) {
      this.log('chain data found on the data volume - keeping it: the node opens it instead of syncing 38 GB', 'warn');
    }
    const wipe = this.config.keepData ? '' : 'WIPE_VOLUME=1';
    if (!this.config.keepData) {
      this.log('the data volume will be wiped and formatted (fresh node) - keepData reuses an existing chain', 'warn');
    }
    const result = await this.runStep({
      script: '/root/deploy/10-prepare-host.sh',
      unit: 'octra-deploy-prepare-host',
      label: 'prepare host (swap + data store + tooling)',
      env: {
        ...(wipe ? { WIPE_VOLUME: '1' } : {}),
        SWAP_GB: String(this.config.swapGB),
        BLOCK_DEVICE: this.config.dataDevice,
        DATA_MIN_GB: String(this.config.dataMinGB),
        ...(typeof this.config.allowFormat === 'boolean'
          ? { FORMAT_APPROVED: this.config.allowFormat ? '1' : '0' }
          : {}),
      },
      timeoutSec: 1800,
      phase: 'prep',
    });
    if (result.soft) return;
    const after = await this.getPrerunState(this.client!, '/root/deploy/prerun.env');
    if (after.dev) {
      this.log(`data store: ${after.dev} -> ${after.mount} (${after.action}${after.dataSet ? ', data set kept' : ''})`, 'ok');
    }
  }

  private async stepToolchain(): Promise<void> {
    const result = await this.runStep({
      script: '/root/deploy/20-install-toolchain.sh',
      unit: 'octra-deploy-install-toolchain',
      label: 'build the runtime (apt + OCaml/dune)',
      timeoutSec: 7200,
      phase: 'toolchain',
    });
    if (result.soft) throw new Error(`the OCaml toolchain is not usable yet: ${result.detail}`);
  }

  private async stepSetup(): Promise<void> {
    const result = await this.runStep({
      script: '/root/deploy/30-setup-node.sh',
      unit: 'octra-deploy-setup-node',
      label: 'configure the node (identity + build + sync)',
      env: this.config.nodeName ? { NODE_NAME: this.config.nodeName } : {},
      timeoutSec: 7200,
      phase: 'setup',
    });
    if (result.soft) throw new Error(`node setup cannot run yet: ${result.detail}`);
  }

  private async stepStart(): Promise<void> {
    await this.runStep({
      script: '/root/deploy/40-start-node.sh',
      unit: 'octra-deploy-start-node',
      label: 'start the node (wait for rpc = ready)',
      timeoutSec: 2400,
      phase: 'start',
    });
  }

  private async stepVerify(): Promise<void> {
    const samples = this.config.samples || VERIFY_SAMPLES;
    const interval = this.config.interval || VERIFY_INTERVAL;
    const peerWait = this.config.peerWaitSec || 300;
    const voteWait = this.config.voteWaitSec || 900;
    // A validator without a bond is an observer until the enroll popup runs.
    // Verifying it as a validator would sit in the fold wait for 15 minutes.
    const role = this.config.role === 'validator' && this.config.bond <= 0 ? 'observer' : this.config.role;
    const waitBudget = role === 'validator' ? voteWait : peerWait;
    const ceiling = 600 + waitBudget + Math.max(1, samples) * Math.max(5, interval);
    await this.runStep({
      script: '/root/deploy/50-verify.sh',
      unit: 'octra-deploy-verify',
      label: `verify (role=${role})`,
      env: {
        SAMPLES: String(samples),
        INTERVAL: String(interval),
        ROLE: role,
        PEER_WAIT: String(peerWait),
        VOTE_WAIT: String(voteWait),
      },
      timeoutSec: ceiling,
      phase: 'verify',
    });
  }

  private async stepEnroll(): Promise<void> {
    if (this.config.bond <= 0) {
      const address = await this.walletAddress(this.client!);
      this.log(`no bond given: leaving the node as an observer (fund ${address})`, 'info');
      this.awaitingEnroll = { address, bond: 1_000_000 };
      return;
    }
    const result = await this.runStep({
      script: '/root/deploy/60-enroll.sh',
      unit: 'octra-deploy-enroll',
      label: `enroll with bond ${this.config.bond}`,
      env: { BOND_AMOUNT: String(this.config.bond) },
      timeoutSec: 1200,
      phase: 'enroll',
    });
    if (result.soft) {
      if (result.state === 'WAITING-FUNDING') {
        this.log(`enrollment needs funding: ${result.detail}`, 'warn');
        this.awaitingEnroll = { address: result.detail, bond: this.config.bond };
      } else {
        this.log(`enrollment is waiting for the chain: ${result.state} ${result.detail}`, 'warn');
      }
    }
  }

  private async stepPromote(): Promise<void> {
    const result = await this.runStep({
      script: '/root/deploy/70-promote.sh',
      unit: 'octra-deploy-promote',
      label: 'wait for the fold, then switch to validator',
      timeoutSec: 5100,
      phase: 'promote',
    });
    if (result.soft) this.log(`waiting for the set fold: ${result.state} ${result.detail}`, 'warn');
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
          sslMode: 'auto',
          reset: false,
        },
        'deploy'
      );
      this.dashboardUrl = result.url;
      this.completePhase(true);
    } catch (err) {
      this.completePhase(false, (err as Error).message);
      throw err;
    }
  }
}

export function createDeployOrchestrator(config: DeployConfig, logger: Logger): DeployOrchestrator {
  return new DeployOrchestrator(config, logger);
}
