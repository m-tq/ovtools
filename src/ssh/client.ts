import { Client, ConnectConfig, SFTPWrapper } from 'ssh2';
import { readFile, readdir } from 'fs/promises';
import * as path from 'path';
import type { SSHConfig, RemoteResult } from '../types';
import { SSH_CONNECT_TIMEOUT, SSH_EXEC_TIMEOUT, SSH_HEARTBEAT, HOST_KEYS_FILE } from '../constants';
import { ensureDir, readJSON, writeJSON } from '../utils/helpers';

const TEXT_EXT = new Set([
  '.sh', '.conf', '.service', '.timer', '.cron', '.py', '.html', '.css', '.js',
  '.svg', '.md', '.json', '.txt', '.env', '.toml', '.yml', '.yaml',
]);

function normalizeFingerprint(value: string): string {
  return String(value || '').trim().replace(/^SHA256:/i, '').replace(/=+$/, '');
}

async function loadHostKeys(): Promise<Record<string, string>> {
  return (await readJSON<Record<string, string>>(HOST_KEYS_FILE)) || {};
}

export class SSHClient {
  private client: Client | null = null;
  private config: SSHConfig;
  private fingerprint: string | null = null;
  private connected = false;

  constructor(config: SSHConfig) {
    this.config = config;
  }

  get host(): string {
    return this.config.host;
  }

  get hostFingerprint(): string | null {
    return this.fingerprint;
  }

  async connect(): Promise<void> {
    const stored = await loadHostKeys();
    const pinned = normalizeFingerprint(
      this.config.ignorePinnedHostKey
        ? (this.config.hostKeyFingerprint || '')
        : (this.config.hostKeyFingerprint || stored[this.config.host] || '')
    );
    const host = this.config.host;

    return new Promise((resolve, reject) => {
      const client = new Client();
      this.client = client;
      const connectConfig: ConnectConfig = {
        host,
        port: this.config.port || 22,
        username: this.config.username || 'root',
        readyTimeout: SSH_CONNECT_TIMEOUT,
        keepaliveInterval: SSH_HEARTBEAT,
        keepaliveCountMax: 3,
        hostHash: 'sha256',
        hostVerifier: (keyHash: string) => {
          const presented = normalizeFingerprint(keyHash);
          this.fingerprint = presented;
          if (pinned && pinned.length > 0) {
            return presented === pinned;
          }
          // accept-new: remember the first key the host presents
          void loadHostKeys().then((map: Record<string, string>) => {
            if (!map[host]) {
              map[host] = presented;
              return writeJSON(HOST_KEYS_FILE, map);
            }
            return undefined;
          }).catch(() => undefined);
          return true;
        },
      };

      const finish = (err?: Error) => {
        client.removeAllListeners('ready');
        if (err) {
          // the hostVerifier already saw the key: callers use this to re-pin a
          // reinstalled VPS even when the login itself fails afterwards
          (err as any).hostFingerprint = this.fingerprint;
          reject(err);
        } else {
          resolve();
        }
      };

      client.once('ready', () => {
        this.connected = true;
        finish();
      });
      client.once('error', (err: Error) => {
        this.connected = false;
        finish(err);
      });
      // ssh2 can emit further 'error'/'close' events after a failed handshake;
      // an unhandled 'error' event would take the whole process down.
      client.on('error', () => {
        this.connected = false;
      });

      const authenticate = () => {
        if (this.config.auth.method === 'key' && this.config.auth.keyPath) {
          readFile(this.config.auth.keyPath, 'utf8')
            .then(privateKey => {
              connectConfig.privateKey = privateKey;
              client.connect(connectConfig);
            })
            .catch((err: Error) => finish(err));
          return;
        }
        if (this.config.auth.method === 'password') {
          connectConfig.password = this.config.auth.password || '';
        }
        client.connect(connectConfig);
      };

      authenticate();
    });
  }

  async exec(
    command: string,
    options: { timeout?: number; onLine?: (line: string, stream: 'stdout' | 'stderr') => void; signal?: AbortSignal } = {}
  ): Promise<RemoteResult> {
    if (!this.client || !this.connected) throw new Error('SSH client not connected');
    return new Promise((resolve, reject) => {
      const timeout = options.timeout || SSH_EXEC_TIMEOUT;
      let stdout = '';
      let stderr = '';
      let stdoutBuf = '';
      let stderrBuf = '';
      const lines: string[] = [];
      let settled = false;
      let channel: any = null;

      const emitLines = (buf: string, stream: 'stdout' | 'stderr') => {
        const parts = buf.split('\n');
        const rest = parts.pop() ?? '';
        for (const raw of parts) {
          const line = raw.replace(/\r$/, '');
          lines.push(line);
          if (options.onLine) options.onLine(line, stream);
        }
        return rest;
      };

      const finish = (code: number | null, timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stdoutBuf) {
          const line = stdoutBuf.replace(/\r$/, '');
          lines.push(line);
          if (options.onLine) options.onLine(line, 'stdout');
        }
        if (stderrBuf) {
          const line = stderrBuf.replace(/\r$/, '');
          lines.push(line);
          if (options.onLine) options.onLine(line, 'stderr');
        }
        resolve({
          exitCode: timedOut ? 124 : (code ?? 0),
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
          lines,
          timedOut,
        });
      };

      const timer = setTimeout(() => {
        try {
          channel?.close();
        } catch {
          // ignore
        }
        finish(null, true);
      }, timeout);

      if (options.signal) {
        if (options.signal.aborted) {
          clearTimeout(timer);
          reject(new Error('aborted'));
          return;
        }
        options.signal.addEventListener('abort', () => {
          try {
            channel?.close();
          } catch {
            // ignore
          }
          finish(null, true);
        }, { once: true });
      }

      this.client!.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          reject(err);
          return;
        }
        channel = stream;
        stream.on('data', (data: Buffer) => {
          const text = data.toString('utf8');
          stdout += text;
          stdoutBuf += text;
          stdoutBuf = emitLines(stdoutBuf, 'stdout');
        });
        stream.stderr.on('data', (data: Buffer) => {
          const text = data.toString('utf8');
          stderr += text;
          stderrBuf += text;
          stderrBuf = emitLines(stderrBuf, 'stderr');
        });
        // A channel that closes without an exit status (dropped connection,
        // sshd killed the child) must never look like a successful command.
        stream.on('close', (code: number | null) => finish(code === null || code === undefined ? 255 : code, false));
        stream.on('error', (streamErr: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(streamErr);
        });
      });
    });
  }

  private sftp(): Promise<SFTPWrapper> {
    if (!this.client || !this.connected) return Promise.reject(new Error('SSH client not connected'));
    return new Promise((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) reject(err);
        else resolve(sftp);
      });
    });
  }

  private async ensureRemoteDir(sftp: SFTPWrapper, remoteDir: string): Promise<void> {
    const parts = remoteDir.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      await new Promise<void>((resolve) => {
        sftp.mkdir(current, () => resolve());
      });
    }
  }

  private async prepareUpload(localPath: string, normalizeLf: boolean): Promise<Buffer> {
    const ext = path.extname(localPath).toLowerCase();
    if (normalizeLf && TEXT_EXT.has(ext)) {
      let text = await readFile(localPath, 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      return Buffer.from(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
    }
    return readFile(localPath);
  }

  async uploadBatch(items: Array<{ localPath: string; remotePath: string; normalizeLf?: boolean }>): Promise<void> {
    if (!items.length) return;
    const sftp = await this.sftp();
    try {
      let lastDir = '';
      const made = new Set<string>();
      for (const item of items) {
        const remoteDir = path.posix.dirname(item.remotePath);
        if (remoteDir !== lastDir && !made.has(remoteDir)) {
          await this.ensureRemoteDir(sftp, remoteDir);
          made.add(remoteDir);
          lastDir = remoteDir;
        }
        const data = await this.prepareUpload(item.localPath, item.normalizeLf !== false);
        await new Promise<void>((resolve, reject) => {
          sftp.writeFile(item.remotePath, data, { mode: 0o644 }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
    } finally {
      sftp.end();
    }
  }

  async uploadFile(localPath: string, remotePath: string, normalizeLf = true): Promise<void> {
    await this.uploadBatch([{ localPath, remotePath, normalizeLf }]);
  }

  async uploadDir(localDir: string, remoteDir: string, filter?: (rel: string) => boolean): Promise<number> {
    const items: Array<{ localPath: string; remotePath: string; normalizeLf?: boolean }> = [];
    const walk = async (dir: string, relBase: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (filter && !filter(rel)) continue;
        const local = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(local, rel);
        } else if (entry.isFile()) {
          items.push({ localPath: local, remotePath: path.posix.join(remoteDir, rel), normalizeLf: true });
        }
      }
    };
    await walk(localDir, '');
    await this.uploadBatch(items);
    return items.length;
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const sftp = await this.sftp();
    await ensureDir(path.dirname(localPath));
    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) => {
        sftp.end();
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async readRemoteFile(remotePath: string): Promise<string | null> {
    const result = await this.exec(`cat ${shellQuote(remotePath)} 2>/dev/null || true`, { timeout: 60000 });
    if (result.exitCode !== 0) return null;
    return result.stdout;
  }

  async ensureConnected(): Promise<void> {
    if (this.connected && this.client) {
      try {
        await this.exec('echo CONNECTED', { timeout: 15000 });
        return;
      } catch {
        // fall through to a fresh connection
      }
    }
    this.connected = false;
    if (this.client) {
      try {
        this.client.end();
      } catch {
        // ignore
      }
      this.client = null;
    }
    await this.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        this.client.end();
      } catch {
        // ignore
      }
      this.client = null;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}

export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export async function createSSHClient(config: SSHConfig): Promise<SSHClient> {
  const client = new SSHClient(config);
  await client.connect();
  return client;
}

export async function execWithRetry(
  client: SSHClient,
  command: string,
  options: { retries?: number; timeout?: number; onLine?: (line: string) => void } = {}
): Promise<RemoteResult> {
  const maxRetries = options.retries ?? 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await client.exec(command, options);
    } catch (err) {
      lastError = err;
      const msg = String(err);
      if (!/connection|timeout|reset|broken pipe|closed|ECONN|ETIMEDOUT/i.test(msg) || attempt === maxRetries - 1) {
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('SSH retry failed');
}
