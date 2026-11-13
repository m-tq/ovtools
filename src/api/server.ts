import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import type { CheckEnvelope, JobRequest, Settings } from '../types';
import {
  BACKUP_DIR,
  CERTS_DIR,
  KEYS_DIR,
  NODE_API_PORT,
  OVTOOLS_HOME,
  PUBLIC_DIR,
  SETTINGS_FILE,
  MIGRATE_PHASES,
  PROGRAMS,
  DEFAULT_ASSETS_REPO,
  DEFAULT_ROLE,
  DASHBOARD_DOMAIN_SUFFIX,
} from '../constants';
import { ensureDir, writeJSON } from '../utils/helpers';
import { jobs, loadSettings, normalizeSettings } from './jobs';
import { runCheck } from './checks';
import { nodeSummary } from './nodes';
import { loadHostkeys, trustHostKey } from './hostkeys';
import { acceptWebSocket } from '../utils/websocket';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

let lastCheck: CheckEnvelope | null = null;
let token = process.env.OVTOOLS_TOKEN || '';

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, payload: unknown, code = 200): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function fail(res: http.ServerResponse, code: number, message: string): void {
  sendJson(res, { ok: false, error: message }, code);
}

function authorized(req: http.IncomingMessage, url: URL): boolean {
  if (!token) return true;
  const header = String(req.headers['x-auth-token'] || '');
  if (header === token) return true;
  if (url.searchParams.get('token') === token) return true;
  const cookies = String(req.headers.cookie || '');
  return cookies.split(';').some(part => {
    const [name, ...rest] = part.trim().split('=');
    return name === 'ovtools_token' && decodeURIComponent(rest.join('=')) === token;
  });
}

async function listArchives(): Promise<Array<{ name: string; dir: string; bytes: number; mtime: number }>> {
  try {
    const entries = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^octra-identity-.*\.tar\.gz$/.test(entry.name)) continue;
      const info = await fs.stat(path.join(BACKUP_DIR, entry.name));
      items.push({ name: entry.name, dir: 'backups', bytes: info.size, mtime: Math.floor(info.mtimeMs / 1000) });
    }
    items.sort((a, b) => b.mtime - a.mtime);
    return items.slice(0, 10);
  } catch {
    return [];
  }
}

function phaseJson(phases: typeof MIGRATE_PHASES) {
  return phases.map(p => ({ id: p.id, label: p.label, desc: p.desc, risk: p.risk, confirm: p.confirm }));
}

async function configPayload(): Promise<any> {
  const settings = await loadSettings();
  return {
    ok: true,
    programs: PROGRAMS.map(p => ({
      id: p.id,
      label: p.label,
      desc: p.desc,
      hosts: p.hosts,
      orchestrator: 'ovtools',
      orchestratorPresent: true,
      phases: phaseJson(p.phases as any),
    })),
    defaultProgram: 'deploy',
    phases: phaseJson(MIGRATE_PHASES),
    projectRoot: OVTOOLS_HOME,
    orchestrator: 'ovtools',
    orchestratorPresent: true,
    deployOrchestrator: 'ovtools',
    deployOrchestratorPresent: true,
    manageOrchestrator: 'ovtools',
    manageOrchestratorPresent: true,
    upgradeOrchestrator: 'ovtools',
    upgradeOrchestratorPresent: true,
    bondIncreaseTool: 'built-in',
    bondIncreasePresent: true,
    dashboardScript: 'built-in',
    dashboardPresent: true,
    autoPhase: 'auto',
    deployPhase: 'deploy',
    authMethods: ['password', 'key'],
    sshExe: 'ssh2 (native)',
    sshExePresent: true,
    nodeApiPort: NODE_API_PORT,
    defaults: { samples: 3, interval: 20 },
    platform: {
      os: process.platform,
      node: process.version,
      label: process.platform === 'win32' ? 'windows' : process.platform,
      tools: {},
    },
    defaultRole: DEFAULT_ROLE,
    domainSuffix: DASHBOARD_DOMAIN_SUFFIX,
    dashboardPhase: 'dashboard',
    assetsRepo: settings.assetsRepo || DEFAULT_ASSETS_REPO,
    assetsRef: settings.assetsRef || 'main',
    archives: await listArchives(),
    hostkeys: await loadHostkeys(),
  };
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (method === 'GET' && pathname === '/api/ping') return sendJson(res, { ok: true, status: 'ok', timestamp: new Date().toISOString() });
  if (method === 'GET' && pathname === '/api/config') return sendJson(res, await configPayload());

  if (method === 'POST' && pathname === '/api/open-data') {
    try {
      await ensureDir(OVTOOLS_HOME);
      const opener = process.platform === 'win32' ? 'explorer.exe'
        : process.platform === 'darwin' ? 'open' : 'xdg-open';
      await new Promise<void>((resolve, reject) => {
        const child = spawn(opener, [OVTOOLS_HOME], { detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
      return sendJson(res, { ok: true, path: OVTOOLS_HOME });
    } catch (err) {
      return fail(res, 500, `could not open the data folder: ${(err as Error).message}`);
    }
  }

  if (pathname === '/api/settings') {
    const saved = await loadSettings();
    if (method === 'GET') return sendJson(res, { ok: true, settings: saved, defaults: normalizeSettings(undefined) });
    if (method === 'POST') {
      const body = await readBody(req);
      const merge = { ...saved, ...body };
      const settings = normalizeSettings(merge as Settings);
      await writeJSON(SETTINGS_FILE, settings);
      return sendJson(res, { ok: true, settings });
    }
  }

  if (method === 'GET' && pathname === '/api/state') {
    return sendJson(res, { ok: true, state: jobs.snapshot(), check: lastCheck });
  }

  if (method === 'GET' && pathname === '/api/check') {
    return sendJson(res, { ok: true, check: lastCheck });
  }

  if (method === 'POST' && pathname === '/api/check') {
    if (jobs.snapshot().running) return fail(res, 409, 'a phase is running - check again when it finishes');
    const body = await readBody(req);
    try {
      const { key, result } = await runCheck(body);
      lastCheck = { key, ts: result.checkedAt, age: 0, result };
      return sendJson(res, { ok: true, check: lastCheck });
    } catch (err) {
      return fail(res, 400, (err as Error).message);
    }
  }

  if (method === 'GET' && pathname === '/api/nodes') {
    const ips = [url.searchParams.get('old'), url.searchParams.get('new')].filter((v): v is string => Boolean(v));
    const nodes = await Promise.all(ips.map(ip => nodeSummary(ip)));
    return sendJson(res, { ok: true, nodes });
  }

  if (method === 'GET' && pathname === '/api/log') {
    const since = Number(url.searchParams.get('since') || 0);
    return sendJson(res, { ok: true, lines: jobs.lines(since) });
  }

  if (method === 'GET' && pathname === '/api/log/stream') {
    return streamLogs(req, res, url);
  }

  if (method === 'POST' && pathname === '/api/disk-plan') {
    const body = await readBody(req) as JobRequest;
    try {
      const plan = await jobs.scanDisk(body);
      return sendJson(res, { ok: true, plan });
    } catch (err) {
      return fail(res, 400, (err as Error).message);
    }
  }

  if (method === 'POST' && pathname === '/api/run') {
    const body = await readBody(req) as JobRequest & { domain?: string };
    try {
      if (body.domain) {
        const saved = await loadSettings();
        if (saved.dashboardDomain !== body.domain) {
          saved.dashboardDomain = String(body.domain).toLowerCase();
          await writeJSON(SETTINGS_FILE, saved);
        }
      }
      const state = await jobs.start(body);
      return sendJson(res, { ok: true, state });
    } catch (err) {
      return fail(res, 400, (err as Error).message);
    }
  }

  if (method === 'POST' && pathname === '/api/cancel') {
    return sendJson(res, { ok: true, cancelled: jobs.cancel() });
  }

  if (method === 'POST' && pathname === '/api/trust') {
    const body = await readBody(req);
    const ip = String(body.ip || '').trim();
    if (!ip) return fail(res, 400, 'ip is required');
    const auth = {
      method: String(body.auth || 'password') === 'key' ? 'key' as const : 'password' as const,
      password: body.password,
      keyPath: body.key,
    };
    const result = await trustHostKey(ip, auth);
    return sendJson(res, { ok: result.ok, detail: result.detail, fingerprint: result.fingerprint }, result.ok ? 200 : 400);
  }

  if (method === 'POST' && pathname === '/api/keyfile') {
    const body = await readBody(req);
    const text = String(body.text || '');
    if (!text.trim()) return fail(res, 400, 'paste the private key text first');
    if (text.length > 20000) return fail(res, 400, 'that does not look like a private key (too long)');
    if (!text.includes('-----BEGIN') || !text.includes('PRIVATE KEY-----')) {
      return fail(res, 400, 'that is not a private key (a public key cannot log in)');
    }
    await ensureDir(KEYS_DIR);
    const file = path.join(KEYS_DIR, `id_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
    await fs.writeFile(file, text.endsWith('\n') ? text : text + '\n', { encoding: 'utf8', mode: 0o600 });
    return sendJson(res, { ok: true, path: file });
  }

  if (method === 'POST' && pathname === '/api/certfiles') {
    const body = await readBody(req);
    const folder = String(body.folder || 'certs').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'certs';
    const fullchain = String(body.fullchain || '');
    const privkey = String(body.privkey || '');
    if (!fullchain.includes('CERTIFICATE') || !privkey.includes('PRIVATE KEY')) {
      return fail(res, 400, 'both fullchain.pem and privkey.pem must be PEM files');
    }
    const dir = path.join(CERTS_DIR, folder);
    await ensureDir(dir);
    await fs.writeFile(path.join(dir, 'fullchain.pem'), fullchain, { encoding: 'utf8', mode: 0o644 });
    await fs.writeFile(path.join(dir, 'privkey.pem'), privkey, { encoding: 'utf8', mode: 0o600 });
    return sendJson(res, { ok: true, path: dir });
  }

  if ((method === 'POST' || method === 'GET') && (pathname === '/api/pickkey' || pathname === '/api/pickdir')) {
    return fail(res, 400, 'the native file picker is not available in the Node console - use the browser picker');
  }

  return fail(res, 404, 'unknown endpoint');
}

function streamLogs(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const since = Number(url.searchParams.get('since') || 0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (entry: unknown) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };
  for (const entry of jobs.lines(since)) send(entry);
  const unsubscribe = jobs.subscribe(send);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // ignore
    }
  }, 15000);
  heartbeat.unref?.();
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
    try {
      res.end();
    } catch {
      // ignore
    }
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
}

async function serveStatic(_req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const target = path.resolve(PUBLIC_DIR, '.' + pathname);
  if (!target.startsWith(PUBLIC_DIR)) return fail(res, 403, 'forbidden');
  try {
    const info = await fs.stat(target);
    if (!info.isFile()) return fail(res, 404, `not found: ${pathname}`);
    const body = await fs.readFile(target);
    const headers: Record<string, string | number> = {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    };
    if (token && pathname === '/index.html' && url.searchParams.get('token') === token) {
      headers['Set-Cookie'] = `ovtools_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`;
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    return fail(res, 404, `not found: ${pathname}`);
  }
}

export async function startWebServer(port: number, host: string): Promise<http.Server> {
  await ensureDir(PUBLIC_DIR);
  await ensureDir(OVTOOLS_HOME);
  if (process.env.OVTOOLS_TOKEN) token = process.env.OVTOOLS_TOKEN;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req, url)) return fail(res, 401, 'invalid or missing token');
        return await handleApi(req, res, url);
      }
      return await serveStatic(req, res, url);
    } catch (err) {
      const msg = (err as Error).message || 'internal error';
      if (!res.headersSent) fail(res, 500, msg);
      else res.end();
    }
  });

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws/log') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    if (!authorized(req, url)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const connection = acceptWebSocket(req, socket, head);
    if (!connection) return;
    const since = Number(url.searchParams.get('since') || 0);
    for (const entry of jobs.lines(since)) connection.sendText(JSON.stringify(entry));
    const unsubscribe = jobs.subscribe(entry => connection.sendText(JSON.stringify(entry)));
    const heartbeat = setInterval(() => connection.sendText(JSON.stringify({ type: 'ping', ts: Date.now() / 1000 })), 15000);
    heartbeat.unref?.();
    connection.onText(text => {
      // a client may ask for a replay from a given sequence without reconnecting
      try {
        const msg = JSON.parse(text);
        if (msg && msg.type === 'since' && Number.isFinite(Number(msg.since))) {
          for (const entry of jobs.lines(Number(msg.since))) connection.sendText(JSON.stringify(entry));
        }
      } catch {
        // ignore malformed client frames
      }
    });
    connection.onClose(() => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  process.stdout.write(`\nOctra Validator Tools console: http://${host}:${port}\n`);
  if (token) process.stdout.write('API token required (OVTOOLS_TOKEN)\n');
  process.stdout.write('Press Ctrl+C to stop\n\n');
  return server;
}
