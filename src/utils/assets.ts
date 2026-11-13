import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import type { SSHClient } from '../ssh/client';
import { shellQuote } from '../ssh/client';
import { COMMON_ASSETS_DIR, DASHBOARD_DIR, DEFAULT_ASSETS_REPO, OVTOOLS_HOME, PROJECT_ROOT, SETTINGS_FILE, TASK_ASSET_DIRS, TMP_DIR } from '../constants';
import type { Settings } from '../types';
import { ensureDir, readJSON } from './helpers';
import { createTarGz, TarEntry } from './tar';

export interface AssetLogger {
  log(message: string, level?: 'info' | 'ok' | 'warn' | 'error' | 'step' | 'remote' | 'data', meta?: { host?: string; program?: string }): void;
}

const SCRIPT_DIRS = Object.keys(TASK_ASSET_DIRS) as Array<keyof typeof TASK_ASSET_DIRS>;
const ASSET_REPO = path.join(OVTOOLS_HOME, 'assets', 'repo');
const REMOTE_BARE = '/root/.ovtools/assets.git';
const REMOTE_BUNDLE = '/root/.ovtools/assets.bundle';
const REMOTE_TAR = '/root/.ovtools/assets.tar.gz';
const REMOTE_CLONE = '/root/.ovtools/repo';
const TEXT_EXT = new Set(['.sh', '.conf', '.service', '.timer', '.cron', '.py', '.html', '.css', '.js', '.json', '.md', '.svg']);

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd?: string, timeout = 120000): Promise<GitResult> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

let gitLocal: boolean | null = null;

async function hasLocalGit(): Promise<boolean> {
  if (gitLocal !== null) return gitLocal;
  const res = await git(['--version'], undefined, 15000);
  gitLocal = res.code === 0;
  return gitLocal;
}

function dashboardFilter(source: string): boolean {
  const rel = path.relative(DASHBOARD_DIR, source).split(path.sep).join('/');
  if (!rel) return true;
  const first = rel.split('/')[0];
  return first !== 'dev' && first !== '__pycache__' && first !== '.git' && first !== 'node_modules';
}

function normalizeRepoUrl(value: string): string {
  let url = String(value || '').trim();
  if (url.startsWith('git+')) url = url.slice(4);
  if (!url) return '';
  if (!/^(https?:\/\/|ssh:\/\/|git:\/\/|git@)/i.test(url)) {
    throw new Error('assetsRepo must be an https, ssh or git@ URL');
  }
  return url;
}

async function repoConfig(): Promise<{ url: string; ref: string }> {
  let settings: Partial<Settings> = {};
  try {
    settings = (await readJSON<Settings>(SETTINGS_FILE)) || {};
  } catch {
    settings = {};
  }
  let url = process.env.OVTOOLS_ASSETS_REPO || settings.assetsRepo || '';
  if (!url) {
    try {
      await fs.access(path.join(PROJECT_ROOT, '.git'));
      const local = await git(['-C', PROJECT_ROOT, 'remote', 'get-url', 'origin'], undefined, 15000);
      if (local.code === 0) url = local.stdout.trim();
    } catch {
      // not a standalone checkout: fall back to settings/env/package
    }
  }
  if (!url) {
    try {
      const pkg = await readJSON<any>(path.join(PROJECT_ROOT, 'package.json'));
      url = pkg?.repository?.url || '';
    } catch {
      url = '';
    }
  }
  if (!url) url = DEFAULT_ASSETS_REPO;
  const ref = process.env.OVTOOLS_ASSETS_REF || settings.assetsRef || 'main';
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) throw new Error(`invalid assets ref: ${ref}`);
  return { url: normalizeRepoUrl(url), ref };
}

function normalizedBytes(file: string, data: Buffer): Buffer {
  if (!TEXT_EXT.has(path.extname(file).toLowerCase())) return data;
  let text = data.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return Buffer.from(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
}

async function localAssetFiles(kind: AssetKind, tasks: string[]): Promise<Array<{ rel: string; abs: string }>> {
  const files: Array<{ rel: string; abs: string }> = [];
  if (kind === 'scripts') {
    const addFlat = async (dir: string, prefix: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.sh')) continue;
        files.push({ rel: `${prefix}${entry.name}`, abs: path.join(dir, entry.name) });
      }
    };
    await addFlat(COMMON_ASSETS_DIR, 'common/');
    for (const task of tasks) {
      const dir = TASK_ASSET_DIRS[task as keyof typeof TASK_ASSET_DIRS];
      if (dir) await addFlat(dir, `${task}/`);
    }
  } else {
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (!dashboardFilter(abs)) continue;
        if (entry.isDirectory()) await walk(abs);
        else if (entry.isFile()) {
          files.push({
            rel: `manage/dashboard_monitor/${path.relative(DASHBOARD_DIR, abs).split(path.sep).join('/')}`,
            abs,
          });
        }
      }
    };
    await walk(DASHBOARD_DIR);
  }
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

async function localAssetHash(kind: AssetKind, tasks: string[]): Promise<string> {
  const files = await localAssetFiles(kind, tasks);
  const lines: string[] = [];
  for (const file of files) {
    const data = normalizedBytes(file.abs, await fs.readFile(file.abs));
    lines.push(`${crypto.createHash('sha256').update(data).digest('hex')}  ${file.rel}\n`);
  }
  return crypto.createHash('sha256').update(lines.join('')).digest('hex');
}

function remoteFindExpression(kind: AssetKind, tasks: string[]): string {
  if (kind === 'dashboard') return 'find manage/dashboard_monitor -type f -print0';
  const parts = ['find common -type f -print0'];
  for (const task of tasks) {
    if (task === 'manage') parts.push('find manage -maxdepth 1 -type f -name "*.sh" -print0');
    else if (TASK_ASSET_DIRS[task as keyof typeof TASK_ASSET_DIRS]) parts.push(`find ${task} -type f -print0`);
  }
  return `{ ${parts.join('; ')}; }`;
}

async function remoteAssetHash(client: SSHClient, kind: AssetKind, tasks: string[]): Promise<string> {
  const cmd = `cd ${shellQuote(REMOTE_CLONE + '/assets')} && ${remoteFindExpression(kind, tasks)} | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum | cut -d' ' -f1`;
  const res = await client.exec(cmd, { timeout: 120000 });
  if (res.exitCode !== 0) throw new Error(res.stderr || res.stdout || 'could not hash the cloned assets');
  return res.stdout.trim().split('\n').pop() || '';
}

async function cloneAssets(client: SSHClient, url: string, ref: string): Promise<void> {
  const repo = shellQuote(REMOTE_CLONE);
  const cmd = [
    'set -e',
    'mkdir -p /root/.ovtools',
    `if [ -d ${repo}/.git ]; then`,
    `  git -C ${repo} remote set-url origin ${shellQuote(url)}`,
    `  if ! GIT_TERMINAL_PROMPT=0 git -C ${repo} fetch --depth=1 origin ${shellQuote(ref)}; then`,
    `    GIT_TERMINAL_PROMPT=0 git -C ${repo} fetch origin ${shellQuote(ref)}`,
    '  fi',
    `  git -C ${repo} reset --hard FETCH_HEAD`,
    'else',
    `  rm -rf ${repo}`,
    `  if ! GIT_TERMINAL_PROMPT=0 git clone --depth=1 --branch ${shellQuote(ref)} ${shellQuote(url)} ${repo}; then`,
    `    rm -rf ${repo}`,
    `    GIT_TERMINAL_PROMPT=0 git clone ${shellQuote(url)} ${repo}`,
    `    if ! GIT_TERMINAL_PROMPT=0 git -C ${repo} fetch --depth=1 origin ${shellQuote(ref)}; then`,
    `      GIT_TERMINAL_PROMPT=0 git -C ${repo} fetch origin ${shellQuote(ref)}`,
    '    fi',
    `    git -C ${repo} reset --hard FETCH_HEAD`,
    '  fi',
    'fi',
  ].join('\n');
  const res = await client.exec(cmd, { timeout: 300000 });
  if (res.exitCode !== 0) throw new Error(`git clone/fetch failed: ${res.stderr || res.stdout}`);
}

async function materializeAssets(client: SSHClient, kind: AssetKind, tasks: string[]): Promise<number> {
  const base = `${REMOTE_CLONE}/assets`;
  if (kind === 'dashboard') {
    const cmd = `rm -rf /root/dashboard; mkdir -p /root/dashboard; cp -a ${shellQuote(base + '/manage/dashboard_monitor/.')} /root/dashboard/`;
    const res = await client.exec(cmd, { timeout: 120000 });
    if (res.exitCode !== 0) throw new Error(res.stderr || res.stdout);
    const files = await localAssetFiles(kind, tasks);
    return files.length;
  }
  const parts = [`cp -a ${shellQuote(base + '/common/.')} /root/`];
  for (const task of tasks) {
    if (!TASK_ASSET_DIRS[task as keyof typeof TASK_ASSET_DIRS]) continue;
    parts.push(`mkdir -p /root/${task}`);
    if (task === 'manage') parts.push(`cp -a ${shellQuote(base + '/manage')}/*.sh /root/manage/`);
    else parts.push(`cp -a ${shellQuote(base + '/' + task)}/. /root/${task}/`);
  }
  const res = await client.exec(`set -e; ${parts.join('; ')}`, { timeout: 120000 });
  if (res.exitCode !== 0) throw new Error(res.stderr || res.stdout);
  const files = await localAssetFiles(kind, tasks);
  return files.length;
}

async function resetWorktree(): Promise<void> {
  const entries = await fs.readdir(ASSET_REPO, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    await fs.rm(path.join(ASSET_REPO, entry.name), { recursive: true, force: true });
  }
}

async function stageAssets(): Promise<{ scripts: number; dashboard: number }> {
  await ensureDir(path.join(ASSET_REPO, 'scripts'));
  let scripts = 0;
  const copyFlatScripts = async (sourceDir: string, targetDir: string): Promise<number> => {
    let count = 0;
    await ensureDir(targetDir);
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.sh')) continue;
      await fs.copyFile(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
      count++;
    }
    return count;
  };

  scripts += await copyFlatScripts(COMMON_ASSETS_DIR, path.join(ASSET_REPO, 'scripts'));
  for (const dir of SCRIPT_DIRS) {
    const source = TASK_ASSET_DIRS[dir];
    let exists = true;
    try {
      await fs.access(source);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    scripts += await copyFlatScripts(source, path.join(ASSET_REPO, 'scripts', dir));
  }

  let dashboard = 0;
  try {
    await fs.access(DASHBOARD_DIR);
  } catch {
    throw new Error(`the bundled dashboard folder is missing: ${DASHBOARD_DIR}`);
  }
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (!dashboardFilter(abs)) continue;
      const rel = path.relative(DASHBOARD_DIR, abs);
      const dest = path.join(ASSET_REPO, 'dashboard', rel);
      if (entry.isDirectory()) {
        await ensureDir(dest);
        await walk(abs);
      } else if (entry.isFile()) {
        await ensureDir(path.dirname(dest));
        await fs.copyFile(abs, dest);
        dashboard++;
      }
    }
  };
  await walk(DASHBOARD_DIR);
  return { scripts, dashboard };
}

interface PreparedRepo {
  head: string;
  counts: { scripts: number; dashboard: number };
}

async function prepareRepo(): Promise<PreparedRepo> {
  await ensureDir(ASSET_REPO);
  let hasGit = true;
  try {
    await fs.access(path.join(ASSET_REPO, '.git'));
  } catch {
    hasGit = false;
  }
  if (!hasGit) {
    let init = await git(['init', '-b', 'main'], ASSET_REPO);
    if (init.code !== 0) {
      await git(['init'], ASSET_REPO);
      await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], ASSET_REPO);
    }
    await git(['config', 'user.name', 'ovtools'], ASSET_REPO);
    await git(['config', 'user.email', 'ovtools@localhost'], ASSET_REPO);
  }
  await resetWorktree();
  const counts = await stageAssets();
  await git(['add', '-A'], ASSET_REPO);
  const staged = await git(['diff', '--cached', '--quiet'], ASSET_REPO);
  if (staged.code !== 0) {
    const commit = await git(['commit', '-m', `assets ${new Date().toISOString()}`], ASSET_REPO);
    if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  }
  const head = await git(['rev-parse', 'HEAD'], ASSET_REPO);
  if (head.code !== 0) throw new Error(`git rev-parse failed: ${head.stderr || head.stdout}`);
  return { head: head.stdout.trim(), counts };
}

async function remoteHead(client: SSHClient): Promise<string> {
  const res = await client.exec(
    `git --git-dir=${shellQuote(REMOTE_BARE)} rev-parse --verify refs/heads/main 2>/dev/null || echo none`,
    { timeout: 60000 }
  );
  return res.stdout.trim().split('\n').pop() || 'none';
}

type AssetKind = 'scripts' | 'dashboard';

export interface AssetSyncResult {
  transport: 'git' | 'tar' | 'clone';
  skipped: boolean;
  head: string;
  files: number;
}

export class AssetSync {
  private client: SSHClient;
  private logger: AssetLogger;
  private program: string;

  constructor(client: SSHClient, logger: AssetLogger, program = 'assets') {
    this.client = client;
    this.logger = logger;
    this.program = program;
  }

  async syncScripts(tasks: string[] = SCRIPT_DIRS): Promise<AssetSyncResult> {
    let result = await this.sync('scripts', false, tasks);
    try {
      await this.verifyScripts(tasks);
    } catch (err) {
      if (!result.skipped) throw err;
      // checkpoint said intact but a script is missing or broken: force a copy
      result = await this.sync('scripts', true, tasks);
      await this.verifyScripts(tasks);
    }
    return result;
  }

  async syncDashboard(force = false): Promise<AssetSyncResult> {
    return this.sync('dashboard', force);
  }

  private async sync(kind: AssetKind, force = false, tasks: string[] = SCRIPT_DIRS): Promise<AssetSyncResult> {
    const mode = (process.env.OVTOOLS_ASSET_TRANSPORT || 'auto').toLowerCase();

    if (mode !== 'tar') {
      try {
        const cfg = await repoConfig();
        if (cfg.url) {
          const cloned = await this.cloneTransfer(kind, tasks, force, cfg.url, cfg.ref);
          if (cloned) return cloned;
        }
      } catch (err) {
        this.logger.log(`GitHub asset clone not usable (${(err as Error).message}) - using the local bundle/archive instead. Push the assets to the repository to use clone mode.`, 'warn', { host: this.client.host, program: this.program });
      }
    }

    const repo = await prepareRepo();
    const probe = kind === 'scripts'
      ? `test -f /root/config.sh${tasks.map(t => ` && test -d /root/${t}`).join('')}`
      : 'test -f /root/dashboard/server.py && test -f /root/dashboard/index.html';
    const intact = (await this.client.exec(probe, { timeout: 60000 })).exitCode === 0;
    const remote = await remoteHead(this.client);
    const files = repo.counts[kind];
    if (!force && remote === repo.head && intact) {
      return { transport: 'git', skipped: true, head: repo.head, files };
    }

    const remoteGit = (await this.client.exec('command -v git >/dev/null 2>&1 && echo yes || echo no', { timeout: 60000 })).stdout.includes('yes');
    if (mode !== 'tar' && remoteGit && await hasLocalGit()) {
      try {
        await this.gitTransfer(kind, repo.head, remote);
        return { transport: 'git', skipped: false, head: repo.head, files };
      } catch (err) {
        this.logger.log(`git asset sync failed (${(err as Error).message}) - falling back to a single archive stream`, 'warn', { host: this.client.host, program: this.program });
      }
    }
    await this.tarTransfer(kind);
    return { transport: 'tar', skipped: false, head: repo.head, files };
  }

  private async cloneTransfer(
    kind: AssetKind,
    tasks: string[],
    force: boolean,
    url: string,
    ref: string
  ): Promise<AssetSyncResult | null> {
    const localHash = await localAssetHash(kind, tasks);
    const repoExists = (await this.client.exec(
      `test -d ${shellQuote(REMOTE_CLONE + '/.git')} && echo yes || echo no`,
      { timeout: 60000 }
    )).stdout.includes('yes');
    const currentHash = repoExists
      ? await remoteAssetHash(this.client, kind, tasks).catch(() => '')
      : '';
    let remoteHash = currentHash;
    if (!repoExists || currentHash !== localHash) {
      this.logger.log(`--> [${this.client.host}] git clone/pull ${url} (${ref})`, 'step', { host: this.client.host, program: this.program });
      await cloneAssets(this.client, url, ref);
      remoteHash = await remoteAssetHash(this.client, kind, tasks);
    } else {
      this.logger.log(`--> [${this.client.host}] git repo already present and up to date - clone/pull skipped`, 'step', { host: this.client.host, program: this.program });
    }
    if (localHash !== remoteHash) {
      throw new Error(`the repository assets (${ref}) differ from this package - push the latest assets first`);
    }
    const headRes = await this.client.exec(`git -C ${shellQuote(REMOTE_CLONE)} rev-parse --short HEAD`, { timeout: 60000 });
    const head = headRes.stdout.trim() || ref;
    const probe = kind === 'scripts'
      ? `test -f /root/config.sh${tasks.map(t => ` && test -d /root/${t}`).join('')}`
      : 'test -f /root/dashboard/server.py && test -f /root/dashboard/index.html';
    const intact = (await this.client.exec(probe, { timeout: 60000 })).exitCode === 0;
    const files = (await localAssetFiles(kind, tasks)).length;
    if (!force && intact) {
      await this.client.exec(`git -C ${shellQuote(REMOTE_CLONE)} rev-parse HEAD > /root/.ovtools/assets.head`, { timeout: 60000 });
      return { transport: 'clone', skipped: true, head, files };
    }
    const copied = await materializeAssets(this.client, kind, tasks);
    return { transport: 'clone', skipped: false, head, files: copied };
  }


  private async gitTransfer(kind: AssetKind, head: string, remote: string): Promise<void> {
    await this.client.exec(`mkdir -p /root/.ovtools`, { timeout: 60000 });
    await this.client.exec(`git init --bare ${shellQuote(REMOTE_BARE)} >/dev/null 2>&1 || true`, { timeout: 120000 });

    // Same commit but missing/damaged files: re-extract from the bare repo
    // without uploading a bundle.
    if (remote === head) {
      await this.applyArchive(kind);
      return;
    }

    const args = ['bundle', 'create'];
    await ensureDir(TMP_DIR);
    const bundlePath = path.join(TMP_DIR, `assets-${process.pid}-${Date.now()}.bundle`);
    args.push(bundlePath, 'main');
    if (remote !== 'none') {
      const ancestor = await git(['merge-base', '--is-ancestor', remote, 'main'], ASSET_REPO);
      if (ancestor.code === 0) args.push('--not', remote);
    }
    const bundle = await git(args, ASSET_REPO, 300000);
    if (bundle.code !== 0) throw new Error(bundle.stderr || bundle.stdout);

    try {
      await this.client.uploadFile(bundlePath, REMOTE_BUNDLE, false);
    } finally {
      await fs.rm(bundlePath, { force: true });
    }

    const fetch = `git --git-dir=${shellQuote(REMOTE_BARE)} fetch --force ${shellQuote(REMOTE_BUNDLE)} '+refs/heads/*:refs/heads/*'`;
    const applied = await this.client.exec(fetch, {
      timeout: 300000,
      onLine: line => {
        if (line.trim()) this.logger.log(`    ${line}`, 'remote', { host: this.client.host, program: this.program });
      },
    });
    if (applied.exitCode !== 0) throw new Error(applied.stderr || applied.stdout);
    await this.client.exec(`rm -f ${shellQuote(REMOTE_BUNDLE)}`, { timeout: 60000 });
    await this.applyArchive(kind);
  }

  private async applyArchive(kind: AssetKind): Promise<void> {
    const tmp = '/root/.ovtools/assets.extract.tar';
    const archive = (pathspec: string) =>
      `git --git-dir=${shellQuote(REMOTE_BARE)} archive --format=tar --output=${shellQuote(tmp)} main ${pathspec}`;
    if (kind === 'dashboard') {
      const cmd = `rm -rf /root/dashboard; ${archive('dashboard')} && tar -x -C /root -f ${shellQuote(tmp)}; rc=$?; rm -f ${shellQuote(tmp)}; exit $rc`;
      const res = await this.client.exec(cmd, { timeout: 300000 });
      if (res.exitCode !== 0) throw new Error(res.stderr || res.stdout);
      return;
    }
    const cmd = `${archive('scripts')} && tar -x -C /root --strip-components=1 -f ${shellQuote(tmp)}; rc=$?; rm -f ${shellQuote(tmp)}; exit $rc`;
    const res = await this.client.exec(cmd, { timeout: 300000 });
    if (res.exitCode !== 0) throw new Error(res.stderr || res.stdout);
  }

  private async tarTransfer(kind: AssetKind): Promise<void> {
    const entries: TarEntry[] = [];
    if (kind === 'scripts') {
      const addFlat = async (source: string, namePrefix: string): Promise<void> => {
        let exists = true;
        try {
          await fs.access(source);
        } catch {
          exists = false;
        }
        if (!exists) return;
        const list = await fs.readdir(source, { withFileTypes: true });
        for (const entry of list) {
          if (!entry.isFile() || !entry.name.endsWith('.sh')) continue;
          entries.push({
            name: `${namePrefix}${entry.name}`,
            data: await fs.readFile(path.join(source, entry.name)),
            mode: 0o755,
          });
        }
      };
      await addFlat(COMMON_ASSETS_DIR, 'scripts/');
      for (const dir of SCRIPT_DIRS) {
        await addFlat(TASK_ASSET_DIRS[dir], `scripts/${dir}/`);
      }
    } else {
      const walk = async (dir: string): Promise<void> => {
        const list = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of list) {
          const abs = path.join(dir, entry.name);
          if (!dashboardFilter(abs)) continue;
          const rel = path.relative(DASHBOARD_DIR, abs).split(path.sep).join('/');
          if (entry.isDirectory()) await walk(abs);
          else if (entry.isFile()) {
            entries.push({
              name: `dashboard/${rel}`,
              data: await fs.readFile(abs),
              mode: entry.name.endsWith('.sh') ? 0o755 : 0o644,
            });
          }
        }
      };
      await walk(DASHBOARD_DIR);
    }

    await this.client.exec('mkdir -p /root/.ovtools', { timeout: 60000 });
    const archive = createTarGz(entries);
    const local = path.join(TMP_DIR, `assets-${process.pid}-${Date.now()}.tar.gz`);
    await ensureDir(TMP_DIR);
    await fs.writeFile(local, archive);
    try {
      await this.client.uploadFile(local, REMOTE_TAR, false);
    } finally {
      await fs.rm(local, { force: true });
    }
    const command = kind === 'dashboard'
      ? `rm -rf /root/dashboard; tar -xzf ${shellQuote(REMOTE_TAR)} -C /root dashboard; rc=$?; rm -f ${shellQuote(REMOTE_TAR)}; exit $rc`
      : `tar -xzf ${shellQuote(REMOTE_TAR)} -C /root --strip-components=1 scripts; rc=$?; rm -f ${shellQuote(REMOTE_TAR)}; exit $rc`;
    const res = await this.client.exec(command, { timeout: 300000 });
    if (res.exitCode !== 0) throw new Error(res.stderr || res.stdout);
  }

  private async verifyScripts(tasks: string[]): Promise<void> {
    const files = await localAssetFiles('scripts', tasks);
    const expected = files.map(f => f.rel.startsWith('common/')
      ? `/root/${f.rel.slice('common/'.length)}`
      : `/root/${f.rel}`);
    if (!expected.length) throw new Error('no bundled scripts to verify');
    const quoted = expected.map(shellQuote).join(' ');
    const chmod = await this.client.exec(
      `chmod +x ${quoted} 2>/dev/null || true`,
      { timeout: 120000 }
    );
    if (chmod.exitCode !== 0) throw new Error(`could not mark the scripts executable on ${this.client.host}`);
    const missing = await this.client.exec(
      `missing=""; for f in ${quoted}; do [ -f "$f" ] || missing="$missing $f"; done; printf '%s' "$missing"`,
      { timeout: 120000 }
    );
    const absent = missing.stdout.trim().split(/\s+/).filter(Boolean);
    if (absent.length) {
      throw new Error(`scripts are incomplete on ${this.client.host}: missing ${absent.slice(0, 10).join(', ')}${absent.length > 10 ? ' (+' + (absent.length - 10) + ' more)' : ''}`);
    }
    const syntax = await this.client.exec(
      `bad=0; for f in ${quoted}; do bash -n "$f" >/dev/null 2>&1 || { echo "SYNTAX_ERROR: $f"; bash -n "$f" 2>&1 | head -2; bad=1; }; done; exit $bad`,
      { timeout: 300000 }
    );
    if (syntax.exitCode !== 0) {
      throw new Error(`scripts on ${this.client.host} failed the bash syntax gate:\n${syntax.stdout}\n${syntax.stderr}`.trim());
    }
  }
}
