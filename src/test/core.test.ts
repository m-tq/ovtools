process.env.OVTOOLS_HOME = require('path').join(require('os').tmpdir(), `ovtools-test-${process.pid}`);

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('cleanLine strips ANSI codes and normalizes box drawing', async () => {
  const { cleanLine } = await import('../utils/helpers');
  assert.equal(cleanLine('\x1b[31mhello\x1b[0m'), 'hello');
  assert.equal(cleanLine('a ─ b ═ c'), 'a - b = c');
  assert.equal(cleanLine('x\u2192y'), 'x->y');
});

test('formatDuration and formatBytes', async () => {
  const { formatDuration, formatBytes } = await import('../utils/helpers');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(125), '2m');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB');
});

test('settings are normalized with safe defaults', async () => {
  const { normalizeSettings } = await import('../api/jobs');
  const s = normalizeSettings({ swapGB: 999, dataMinGB: 1, dataDevice: '  ', dashboardDomain: 'Node.Example.COM' } as any);
  assert.equal(s.swapGB, 8);
  assert.equal(s.dataMinGB, 1000);
  assert.equal(s.dataDevice, '/dev/sdb');
  assert.equal(s.dashboardDomain, 'node.example.com');
});

test('phase catalogue exposes all three programs', async () => {
  const constants = await import('../constants');
  for (const id of ['deploy', 'migrate', 'manage']) {
    assert.ok(constants.PROGRAMS.some(p => p.id === id), id);
  }
  assert.equal(constants.phaseMeta('deploy', 'deploy')?.risk, 'critical');
  assert.equal(constants.phaseMeta('manage', 'storage')?.confirm, 'PRUNE');
  assert.equal(constants.phaseMeta('migrate', 'nope'), undefined);
});

test('state manager persists completed steps', async () => {
  const os = await import('os');
  const path = await import('path');
  const fs = await import('fs/promises');
  const { StateManager } = await import('../utils/state');
  const file = path.join(os.tmpdir(), `ovtools-state-${process.pid}.json`);
  await fs.rm(file, { force: true });
  const manager = new StateManager(file);
  assert.equal(await manager.isStepDone('pair', 'prep'), false);
  await manager.markStepDone('pair', 'prep');
  assert.equal(await manager.isStepDone('pair', 'prep'), true);
  await manager.reset('pair');
  assert.equal(await manager.isStepDone('pair', 'prep'), false);
  await fs.rm(file, { force: true });
});

test('web API: ping, config, static UI, approval gate, settings', async () => {
  const { startWebServer } = await import('../api/server');
  const server = await startWebServer(0, '127.0.0.1');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${(address as any).port}`;
  try {
    const ping = await (await fetch(`${base}/api/ping`)).json() as any;
    assert.equal(ping.status, 'ok');

    const config = await (await fetch(`${base}/api/config`)).json() as any;
    assert.equal(config.ok, true);
    assert.equal(config.programs.length, 3);
    assert.equal(config.dashboardPresent, true);

    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /Octra Validator Tools/);
    assert.match(html, /assets\/v2\.2\/css\/synteq-ui-v2\.css/);
    assert.match(html, /Deploy Dashboard Monitor/);
    assert.match(html, /mc-nodeactions__wide/);

    const pick = await fetch(`${base}/api/pickdir`, { method: 'POST' });
    assert.equal(pick.status, 400);

    const run = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ program: 'deploy', phase: 'deploy', newIp: '1.2.3.4' }),
    });
    assert.equal(run.status, 400);
    assert.match(((await run.json()) as any).error, /approval/);

    const saved = await (await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ swapGB: 16 }),
    })).json() as any;
    assert.equal(saved.settings.swapGB, 16);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('job validation rejects missing credentials and unknown phases', async () => {
  const { jobs } = await import('../api/jobs');
  await assert.rejects(
    () => jobs.start({ program: 'deploy', phase: 'deploy', newIp: '1.2.3.4', approved: true, newPassword: '' } as any),
    /no password/
  );
  await assert.rejects(
    () => jobs.start({ program: 'deploy', phase: 'nope', newIp: '1.2.3.4', approved: true, newPassword: 'x' } as any),
    /unknown deploy phase/
  );
  await assert.rejects(
    () => jobs.start({ program: 'manage', phase: 'bond', newIp: '1.2.3.4', newPassword: 'x', amount: '0.5', approved: true } as any),
    /min 1/
  );
});

test('assets manifest lists every file the tasks need', async () => {
  const fs = await import('fs/promises');
  const path = await import('path');
  const { PROJECT_ROOT } = await import('../constants');
  const manifestPath = path.join(PROJECT_ROOT, 'assets', 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  for (const name of ['common', 'deploy', 'migrate', 'manage', 'upgrade', 'dashboard_monitor']) {
    const task = manifest.tasks[name];
    assert.ok(task, `missing task ${name}`);
    assert.ok(Array.isArray(task.files) && task.files.length > 0, `empty task ${name}`);
    for (const rel of task.files) {
      await fs.access(path.join(PROJECT_ROOT, task.source, rel));
    }
  }
  assert.equal(manifest.tasks.common.target, '/root');
  assert.equal(manifest.tasks.deploy.target, '/root/deploy');
  assert.equal(manifest.tasks.dashboard_monitor.target, '/root/dashboard');
  assert.equal(manifest.tasks.deploy.dependsOn[0], 'common');
});

test('version comparison handles releases and prereleases', async () => {
  const { compareVersions } = await import('../utils/update');
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(compareVersions('1.0.1', '1.0.0') > 0);
  assert.ok(compareVersions('v1.2.3', '1.2.4') < 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-beta') > 0);
  assert.ok(compareVersions('1.0.0-beta', '1.0.0') < 0);
});

test('tar writer produces a gzip ustar archive with the expected entries', async () => {
  const zlib = await import('zlib');
  const { createTarGz } = await import('../utils/tar');
  const data = Buffer.from('echo hello\n', 'utf8');
  const archive = createTarGz([
    { name: 'scripts/config.sh', data, mode: 0o755 },
    { name: 'dashboard/index.html', data: Buffer.from('<html></html>'), mode: 0o644 },
  ]);
  assert.equal(archive[0], 0x1f);
  assert.equal(archive[1], 0x8b);
  const raw = zlib.gunzipSync(archive);
  const text = raw.toString('latin1');
  assert.match(text, /scripts\/config\.sh/);
  assert.match(text, /dashboard\/index\.html/);
  assert.match(text, /ustar/);
  assert.ok(raw.includes(data));
});

test('grouping helper keeps repeated lines visible through the log buffer', async () => {
  const { Logger } = await import('../utils/helpers');
  const os = await import('os');
  const path = await import('path');
  const logger = new Logger(path.join(os.tmpdir(), `ovtools-log-${process.pid}.log`), false);
  logger.log('one', 'info');
  logger.log('two', 'ok');
  const rows = logger.entriesSince(0);
  assert.deepEqual(rows.map(r => r.line), ['one', 'two']);
  assert.equal(rows[1].seq, 2);
});
