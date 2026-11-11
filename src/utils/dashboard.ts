import * as path from 'path';
import * as fs from 'fs/promises';
import { SSHClient, shellQuote } from '../ssh/client';
import { REMOTE } from '../constants';
import { Logger } from '../utils/helpers';
import { AssetSync } from './assets';

const REQUIRED = [
  'server.py', 'index.html', 'app.js', 'styles.css', 'deploy-dashboard.sh',
  'ssl-certbot.sh', 'nginx-octra.conf', 'octra-dashboard.service',
  'prune-node-junk.sh', 'octra-node-prune.cron', 'octra-node-prune.service',
  'octra-node-prune.timer',
];

export interface DashboardOptions {
  ip: string;
  domain?: string;
  sslMode?: 'auto' | 'cloudflare' | 'certbot';
  certDir?: string;
  email?: string;
  reset?: boolean;
}

export async function deployDashboard(
  client: SSHClient,
  logger: Logger,
  options: DashboardOptions,
  program = 'manage'
): Promise<{ healthy: boolean; url: string; host: string }> {
  const log = (msg: string, level: 'info' | 'ok' | 'warn' | 'error' | 'step' | 'remote' = 'info') =>
    logger.log(msg, level, { host: client.host, program });
  const domain = (options.domain || '').trim().toLowerCase();
  if (domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new Error(`invalid domain '${domain}' (expected a host name such as node.example.com)`);
  }
  const sslMode = options.sslMode || 'auto';
  if (sslMode === 'certbot' && !domain) throw new Error("Let's Encrypt needs the domain (it must already point at the node)");
  if (sslMode === 'cloudflare' && !options.certDir) throw new Error('choose the folder that holds fullchain.pem and privkey.pem');

  log('=== Deploy monitoring dashboard ===', 'step');

  // --- TLS material ----------------------------------------------------
  if (sslMode !== 'certbot' && options.certDir) {
    for (const name of ['fullchain.pem', 'privkey.pem']) {
      const file = path.join(options.certDir, name);
      try {
        await fs.access(file);
      } catch {
        throw new Error(`certificate file missing: ${file}`);
      }
    }
    const has = await client.exec('test -s /etc/ssl/octra/fullchain.pem && test -s /etc/ssl/octra/privkey.pem', { timeout: 60000 });
    if (has.exitCode !== 0) {
      log('Installing TLS material to /etc/ssl/octra/', 'step');
      await client.exec('install -d -m 700 /etc/ssl/octra', { timeout: 60000 });
      await client.uploadFile(path.join(options.certDir, 'fullchain.pem'), '/etc/ssl/octra/fullchain.pem', false);
      await client.uploadFile(path.join(options.certDir, 'privkey.pem'), '/etc/ssl/octra/privkey.pem', false);
      await client.exec('chmod 644 /etc/ssl/octra/fullchain.pem; chmod 600 /etc/ssl/octra/privkey.pem', { timeout: 60000 });
      log('TLS material installed', 'ok');
    } else {
      log('TLS material already present on the host - keeping it', 'info');
    }
  }

  // --- sync assets (git bundle, single archive fallback) ---------------
  const assets = new AssetSync(client, logger, 'dashboard');
  log('Syncing dashboard assets...', 'step');
  const sync = await assets.syncDashboard(Boolean(options.reset));
  log(sync.skipped
    ? `dashboard files already up to date (${sync.head.slice(0, 12)}) - transfer skipped`
    : `${sync.files} file(s) synced via ${sync.transport}`, 'ok');

  const probeFiles = async () => client.exec(
    `for f in ${REQUIRED.map(shellQuote).join(' ')}; do test -f ${REMOTE.dashboard}/$f || echo MISSING:$f; done`,
    { timeout: 60000 }
  );
  let probe = await probeFiles();
  if (probe.stdout.includes('MISSING:')) {
    log('dashboard files are incomplete after the checkpoint - forcing a full re-extract', 'warn');
    await assets.syncDashboard(true);
    probe = await probeFiles();
  }
  if (probe.stdout.includes('MISSING:')) {
    throw new Error(`dashboard files are incomplete on ${client.host}: ${probe.stdout.trim()}`);
  }

  // --- force the published host name --------------------------------
  // deploy-dashboard.sh keeps the server_name already live on the host, so a
  // first deploy would stay on the template placeholder without this rewrite.
  if (domain) {
    const rewrite = [
      `f=${REMOTE.dashboard}/nginx-octra.conf`,
      `[ -f "$f" ] || exit 2`,
      `awk -v d=${shellQuote(domain)} '{ if ($0 ~ /^[[:space:]]*server_name[[:space:]]/) sub(/server_name[[:space:]]+[^;]+;/, "server_name " d ";"); print }' "$f" > "$f.tmp" && mv "$f.tmp" "$f"`,
      `grep -qE '^[[:space:]]*server[[:space:]]*\\{' "$f" || exit 3`,
      `s=/etc/nginx/sites-available/octra-dashboard`,
      `if [ -f "$s" ]; then awk -v d=${shellQuote(domain)} '{ if ($0 ~ /^[[:space:]]*server_name[[:space:]]/) sub(/server_name[[:space:]]+[^;]+;/, "server_name " d ";"); print }' "$s" > "$s.tmp" && mv "$s.tmp" "$s"; fi`,
      `sed -i "s|^# Domain  : .*|# Domain  : ${domain}   (edit server_name to your domain)|" "$f" || true`,
    ].join('; ');
    const result = await client.exec(rewrite, { timeout: 120000 });
    if (result.exitCode !== 0) {
      throw new Error(`nginx template rewrite failed for ${domain} (exit ${result.exitCode})`);
    }
    log(`nginx server_name forced to ${domain}`, 'ok');
  }

  // --- Let's Encrypt (helper is on the host now) ----------------------
  if (sslMode === 'certbot') {
    log(`Requesting a Let's Encrypt certificate for ${domain}...`, 'step');
    let cmd = `bash ${REMOTE.dashboard}/ssl-certbot.sh --domain ${shellQuote(domain)}`;
    if (options.email) cmd += ` --email ${shellQuote(options.email)}`;
    const ssl = await client.exec(cmd, { timeout: 900000 });
    if (ssl.exitCode !== 0) {
      throw new Error(`certbot could not issue a certificate for ${domain}: ${ssl.stderr || ssl.stdout}`);
    }
  }

  // --- install / restart ----------------------------------------------
  log('Installing nginx site + systemd backend...', 'step');
  const install = await client.exec(`bash ${REMOTE.dashboard}/deploy-dashboard.sh`, {
    timeout: 900000,
    onLine: line => {
      if (line.trim()) log(`    ${line}`, 'remote');
    },
  });
  if (install.exitCode !== 0) {
    const diag = await client.exec('systemctl status octra-dashboard --no-pager -n 20 || true; journalctl -u octra-dashboard -n 40 --no-pager || true', { timeout: 120000 });
    for (const line of diag.stdout.split('\n')) if (line.trim()) log(`    ${line}`, 'remote');
    throw new Error('deploy-dashboard.sh reported errors - see the lines above');
  }

  // --- health check ----------------------------------------------------
  let healthy = false;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const probe = await client.exec(
      'systemctl is-active --quiet octra-dashboard && curl -fsS -m 5 -o /dev/null http://127.0.0.1:9090/api/ping && echo BACKEND_OK',
      { timeout: 60000 }
    );
    if (probe.exitCode === 0) {
      healthy = true;
      break;
    }
    log(`waiting for octra-dashboard to answer /api/ping (${attempt}/6)...`, 'warn');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  // --- remove the retired manage drop-in/token -------------------------
  if (healthy) {
    await client.exec(
      'changed=0; if [ -f /etc/systemd/system/octra-dashboard.service.d/manage.conf ]; then rm -f /etc/systemd/system/octra-dashboard.service.d/manage.conf; changed=1; fi; ' +
      'if [ -f /opt/octra/dashboard/manage.token ]; then rm -f /opt/octra/dashboard/manage.token; changed=1; fi; ' +
      'if [ "$changed" -eq 1 ]; then systemctl daemon-reload; systemctl restart octra-dashboard; sleep 2; fi; echo MANAGE_CLEANUP=done',
      { timeout: 300000 }
    );
  }

  const host = domain || options.ip;
  const scheme = domain ? 'https' : 'http';
  if (!healthy) {
    const diag = await client.exec('systemctl status octra-dashboard --no-pager -n 30 || true; journalctl -u octra-dashboard -n 40 --no-pager || true', { timeout: 120000 });
    for (const line of diag.stdout.split('\n')) if (line.trim()) log(`    ${line}`, 'remote');
    throw new Error(`the dashboard backend did not answer /api/ping on ${client.host}`);
  }
  log(`monitoring dashboard live: ${scheme}://${host}/`, 'ok');
  log(`API: ${scheme}://${host}/api/status`, 'info');
  return { healthy, url: `${scheme}://${host}/`, host };
}
