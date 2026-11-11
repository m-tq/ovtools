#!/usr/bin/env node
import { createLogger, readJSON, writeJSON } from './utils/helpers';
import { createDeployOrchestrator } from './orchestrator/deploy';
import { createMigrateOrchestrator } from './orchestrator/migrate';
import { createManageOrchestrator } from './orchestrator/manage';
import { startWebServer } from './api/server';
import { openBrowser } from './utils/browser';
import { checkForUpdate, updateNotice } from './utils/update';
import { DEFAULT_ASSETS_REPO, DEFAULT_ROLE, SETTINGS_FILE } from './constants';
import { normalizeSettings } from './api/jobs';
import type { DeployConfig, HostAuth, ManageConfig, ManagePhase, MigrateConfig, Settings } from './types';

interface Parsed {
  _: string[];
  [key: string]: string | boolean | string[] | undefined;
}

function parse(argv: string[]): Parsed {
  const out: Parsed = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      (out._ as string[]).push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[body] = next;
      i++;
    } else {
      out[body] = true;
    }
  }
  return out;
}

function str(p: Parsed, key: string): string | undefined {
  const value = p[key];
  return typeof value === 'string' ? value : undefined;
}

function num(p: Parsed, key: string): number | undefined {
  const value = str(p, key);
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function bool(p: Parsed, key: string): boolean {
  return p[key] === true || p[key] === 'true' || p[key] === '1';
}

function auth(p: Parsed, passwordKey: string, keyKey: string): HostAuth {
  const keyPath = str(p, keyKey);
  if (keyPath) return { method: 'key', keyPath };
  return { method: 'password', password: str(p, passwordKey) };
}

function requireOption(p: Parsed, key: string, hint: string): string {
  const value = str(p, key);
  if (!value) throw new Error(`${hint} (--${key})`);
  return value;
}

function printHelp(): void {
  process.stdout.write(`
ovtools - Octra Validator Tools

Usage:
  ovtools                         start the web console and open the browser
  ovtools deploy  --ip <ip> [--password <pass> | --key <path>] [options]
  ovtools migrate --old-ip <ip> --new-ip <ip> [credentials] [options]
  ovtools manage  --ip <ip> --phase <phase> [options]
  ovtools upgrade --ip <ip> --phase <status|upgrade|manual|storage> [options]
  ovtools web     [--port 9091] [--host 127.0.0.1] [--no-open]
  ovtools config  [--assets-repo <git-url>] [--assets-ref <branch>]

Config:
  --assets-repo <url>   GitHub/Git URL the VPS clones assets from
  --assets-ref <ref>    branch, tag or commit (default main)
  (no flags: print the current settings)

Deploy options:
  --phase <deploy|prep|toolchain|setup|start|verify|enroll|promote|dashboard|status>
  --role <validator|observer>   --bond <raw units>   --bond-oct <OCT>
  --node-name <name>  --domain <host>  --swap <GB>  --data-device </dev/sdb>
  --data-min <GB>  --reset  --wipe  --keep-data  --skip-dashboard

Migrate options:
  --phase <all|backup|prep|pull|switch|finalize|verify|rollback|status>
  --samples <n>  --interval <sec>  --reset  --wipe-target  --keep-target-data

Manage options:
  --phase <status|bond|exit|dashboard|diagnose|recover|upgrade|manual|storage>
  --amount <OCT>  --domain <host>  --ssl-mode <auto|cloudflare|certbot>
  --cert-dir <path>  --email <addr>  --test-only  --no-restart  --reset
  --wait <sec>  --extra "<flags>"

Environment:
  OVTOOLS_HOME             state directory (default ~/.ovtools)
  OVTOOLS_TOKEN            require this token for the web API
  OVTOOLS_ASSETS_REPO      override the assets Git URL
  OVTOOLS_ASSETS_REF       override the assets branch/tag/commit
  OVTOOLS_ASSET_TRANSPORT  auto (default), clone, git bundle, or tar
  OVTOOLS_NO_BROWSER       set to 1 to start the console without opening a browser
  OVTOOLS_NO_UPDATE_CHECK  set to 1 to skip the npm update notice
`);
}

async function runConfig(p: Parsed): Promise<void> {
  const current = (await readJSON<Settings>(SETTINGS_FILE)) || {};
  const repo = str(p, 'assets-repo');
  const ref = str(p, 'assets-ref');
  if (repo === undefined && ref === undefined) {
    const settings = normalizeSettings(current);
    process.stdout.write(`settings : ${SETTINGS_FILE}\n`);
    process.stdout.write(`assetsRepo: ${process.env.OVTOOLS_ASSETS_REPO || settings.assetsRepo || DEFAULT_ASSETS_REPO}${settings.assetsRepo ? '' : ' (default)'}\n`);
    process.stdout.write(`assetsRef : ${settings.assetsRef || 'main'}\n`);
    process.stdout.write(`transport : ${process.env.OVTOOLS_ASSET_TRANSPORT || 'auto'}\n`);
    return;
  }
  const next = normalizeSettings({
    ...current,
    ...(repo !== undefined ? { assetsRepo: repo } : {}),
    ...(ref !== undefined ? { assetsRef: ref } : {}),
  });
  await writeJSON(SETTINGS_FILE, next);
  process.stdout.write(`saved ${SETTINGS_FILE}\n`);
  process.stdout.write(`assetsRepo: ${next.assetsRepo || DEFAULT_ASSETS_REPO}${next.assetsRepo ? '' : ' (default)'}\n`);
  process.stdout.write(`assetsRef : ${next.assetsRef || 'main'}\n`);
}

async function runDeploy(p: Parsed): Promise<void> {
  const rawBond = num(p, 'bond') ?? (num(p, 'bond-oct') !== undefined ? Math.round(num(p, 'bond-oct')! * 1_000_000) : 0);
  const config: DeployConfig = {
    ip: requireOption(p, 'ip', 'the target IP is required'),
    auth: auth(p, 'password', 'key'),
    role: str(p, 'role') === 'observer' ? 'observer' : DEFAULT_ROLE,
    bond: rawBond,
    nodeName: str(p, 'node-name'),
    domain: str(p, 'domain'),
    swapGB: num(p, 'swap') ?? 8,
    dataDevice: str(p, 'data-device') || '/dev/sdb',
    dataMinGB: num(p, 'data-min') ?? 1000,
    phase: str(p, 'phase') || 'deploy',
    reset: bool(p, 'reset'),
    wipeVolume: bool(p, 'wipe'),
    keepData: bool(p, 'keep-data'),
    skipDashboard: bool(p, 'skip-dashboard'),
  };
  const logger = createLogger('deploy', true);
  const orchestrator = createDeployOrchestrator(config, logger);
  await orchestrator.run();
  await logger.flush();
}

async function runMigrate(p: Parsed): Promise<void> {
  const config: MigrateConfig = {
    oldIp: requireOption(p, 'old-ip', 'the source IP is required'),
    newIp: requireOption(p, 'new-ip', 'the target IP is required'),
    oldAuth: auth(p, 'old-password', 'old-key'),
    newAuth: auth(p, 'new-password', 'new-key'),
    wipeTargetVolume: bool(p, 'wipe-target'),
    keepTargetData: bool(p, 'keep-target-data'),
    phase: str(p, 'phase') || 'all',
    samples: num(p, 'samples') ?? 3,
    interval: num(p, 'interval') ?? 30,
    reset: bool(p, 'reset'),
  };
  const logger = createLogger('migrate', true);
  const orchestrator = createMigrateOrchestrator(config, logger);
  await orchestrator.run();
  await logger.flush();
}

async function runManage(p: Parsed, defaultPhase?: ManagePhase): Promise<void> {
  const phase = (str(p, 'phase') || defaultPhase || 'status') as ManagePhase;
  const config: ManageConfig = {
    ip: requireOption(p, 'ip', 'the node IP is required'),
    auth: auth(p, 'password', 'key'),
    phase,
    amount: str(p, 'amount'),
    newBond: bool(p, 'new-bond'),
    domain: str(p, 'domain'),
    sslMode: (str(p, 'ssl-mode') as ManageConfig['sslMode']) || 'auto',
    certDir: str(p, 'cert-dir'),
    email: str(p, 'email'),
    testOnly: bool(p, 'test-only'),
    noRestart: bool(p, 'no-restart'),
    reset: bool(p, 'reset'),
    waitSeconds: num(p, 'wait') ?? 900,
    extra: str(p, 'extra'),
  };
  const logger = createLogger(phase === 'upgrade' || phase === 'manual' || phase === 'storage' ? 'upgrade' : 'manage', true);
  const orchestrator = createManageOrchestrator(config, logger);
  await orchestrator.run();
  await logger.flush();
}

async function launchConsole(port: number, host: string, autoPort: boolean, open: boolean): Promise<number> {
  let server: Awaited<ReturnType<typeof startWebServer>> | null = null;
  let chosen = port;
  const attempts = autoPort ? 10 : 1;
  for (let i = 0; i < attempts; i++) {
    try {
      server = await startWebServer(chosen, host);
      break;
    } catch (err: any) {
      if (autoPort && err && (err.code === 'EADDRINUSE' || /EADDRINUSE/.test(String(err.message)))) {
        chosen++;
        continue;
      }
      throw err;
    }
  }
  if (!server) {
    throw new Error(`could not find a free port starting at ${port}`);
  }
  if (autoPort && chosen !== port) {
    process.stdout.write(`port ${port} is busy - using ${chosen}\n`);
  }
  const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  let url = `http://${browserHost}:${chosen}/`;
  if (process.env.OVTOOLS_TOKEN) url += `?token=${encodeURIComponent(process.env.OVTOOLS_TOKEN)}`;
  process.stdout.write(`Opening ${url}\n`);
  if (open) openBrowser(url);
  await new Promise<void>(resolve => {
    const stop = () => server!.close(() => resolve());
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return 0;
  }
  if (argv[0] === 'version' || argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write('ovtools 1.0.0\n');
    return 0;
  }
  if (!argv.length) {
    if (process.env.OVTOOLS_NO_UPDATE_CHECK !== '1' && process.env.OVTOOLS_NO_UPDATE_CHECK !== 'true') {
      try {
        const update = await checkForUpdate();
        if (update) {
          process.stdout.write(updateNotice(update));
          return 0;
        }
      } catch {
        // update checks never block the console
      }
    }
    return launchConsole(9091, '127.0.0.1', true, true);
  }
  const command = argv[0];
  const parsed = parse(argv.slice(1));
  try {
    switch (command) {
      case 'deploy':
        await runDeploy(parsed);
        return 0;
      case 'migrate':
        await runMigrate(parsed);
        return 0;
      case 'manage':
        await runManage(parsed);
        return 0;
      case 'upgrade':
        await runManage(parsed, 'upgrade');
        return 0;
      case 'config':
        await runConfig(parsed);
        return 0;
      case 'web': {
        const explicitPort = num(parsed, 'port');
        const port = explicitPort ?? 9091;
        const host = str(parsed, 'host') || '127.0.0.1';
        const open = !bool(parsed, 'no-open');
        return launchConsole(port, host, explicitPort === undefined, open);
      }
      default:
        process.stderr.write(`unknown command: ${command}\n\n`);
        printHelp();
        return 1;
    }
  } catch (err) {
    process.stderr.write(`\nERROR: ${(err as Error).message}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then(code => {
    process.exitCode = code;
  }).catch(err => {
    process.stderr.write(`ERROR: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
}
