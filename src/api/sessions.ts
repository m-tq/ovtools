import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { OVTOOLS_HOME } from '../constants';
import type { HostAuth } from '../types';

/**
 * Small local credential vault for reusable VM sessions.
 *
 * The file is AES-256-GCM encrypted with a key derived from this machine and
 * the current OS user. It is not a substitute for an OS keychain, but it keeps
 * the password out of settings.json / browser storage and makes the file
 * useless when copied to another machine or user account.
 */
export interface SessionMeta {
  ip: string;
  username: string;
  method: 'password' | 'key';
  hasPassword: boolean;
  keyPath?: string;
  updatedAt: number;
}

interface StoredSession extends SessionMeta {
  auth: HostAuth;
}

interface VaultFile {
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

const VAULT_FILE = path.join(OVTOOLS_HOME, 'sessions.json');
let memory: Map<string, StoredSession> | null = null;

function keyForSalt(salt: Buffer): Buffer {
  const seed = `${os.hostname()}|${os.userInfo().username}|${OVTOOLS_HOME}`;
  return crypto.scryptSync(seed, salt, 32);
}

async function loadVault(): Promise<Map<string, StoredSession>> {
  if (memory) return memory;
  memory = new Map();
  try {
    const raw = JSON.parse(await fs.readFile(VAULT_FILE, 'utf8')) as VaultFile;
    if (!raw || raw.version !== 1 || !raw.salt || !raw.iv || !raw.tag || !raw.data) return memory;
    const salt = Buffer.from(raw.salt, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyForSalt(salt), Buffer.from(raw.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]).toString('utf8');
    const rows = JSON.parse(plain) as StoredSession[];
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row && row.ip && row.auth) memory.set(row.ip, row);
      }
    }
  } catch {
    // Missing/corrupt vault or a different machine/user: start empty.
  }
  return memory;
}

async function persistVault(vault: Map<string, StoredSession>): Promise<void> {
  await fs.mkdir(OVTOOLS_HOME, { recursive: true });
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyForSalt(salt), iv);
  const plain = JSON.stringify(Array.from(vault.values()));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const payload: VaultFile = {
    version: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
  const tmp = `${VAULT_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await fs.rename(tmp, VAULT_FILE);
  try {
    await fs.chmod(VAULT_FILE, 0o600);
  } catch {
    // Windows: best effort.
  }
}

function metaOf(row: StoredSession): SessionMeta {
  return {
    ip: row.ip,
    username: row.username,
    method: row.method,
    hasPassword: Boolean(row.auth.password),
    keyPath: row.auth.keyPath,
    updatedAt: row.updatedAt,
  };
}

export async function listSessions(): Promise<SessionMeta[]> {
  const vault = await loadVault();
  return Array.from(vault.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(metaOf);
}

export async function getSession(ip: string): Promise<HostAuth | null> {
  const vault = await loadVault();
  const row = vault.get(String(ip || '').trim());
  return row ? { ...row.auth } : null;
}

export async function saveSession(ip: string, username: string, auth: HostAuth): Promise<void> {
  const host = String(ip || '').trim();
  if (!host) return;
  if (auth.method === 'password' && !auth.password) return;
  if (auth.method === 'key' && !auth.keyPath) return;
  const vault = await loadVault();
  vault.set(host, {
    ip: host,
    username: username || 'root',
    method: auth.method,
    hasPassword: Boolean(auth.password),
    keyPath: auth.keyPath,
    updatedAt: Date.now(),
    auth: { method: auth.method, password: auth.password, keyPath: auth.keyPath },
  });
  await persistVault(vault);
}

export async function forgetSession(ip: string): Promise<void> {
  const vault = await loadVault();
  if (vault.delete(String(ip || '').trim())) await persistVault(vault);
}
