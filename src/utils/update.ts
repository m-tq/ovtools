import * as path from 'path';
import { OVTOOLS_HOME, PROJECT_ROOT } from '../constants';
import { ensureDir, readJSON, writeJSON } from './helpers';

const CACHE_FILE = path.join(OVTOOLS_HOME, 'update-check.json');
const REGISTRY_URL = 'https://registry.npmjs.org/ovtools/latest';
const TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;

interface UpdateCache {
  checkedAt: number;
  latest: string | null;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
}

function parseVersion(value: string): { parts: number[]; pre: string } {
  const clean = String(value || '').trim().replace(/^v/i, '').split('+')[0];
  const [base, pre = ''] = clean.split('-');
  const parts = base.split('.').map(p => {
    const n = Number(p);
    return Number.isFinite(n) ? n : 0;
  });
  while (parts.length < 3) parts.push(0);
  return { parts: parts.slice(0, 3), pre };
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;          // 1.0.0 > 1.0.0-beta
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

export async function currentVersion(): Promise<string> {
  try {
    const pkg = await readJSON<{ version?: string }>(path.join(PROJECT_ROOT, 'package.json'));
    return pkg?.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function fetchLatest(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'ovtools-update-check' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const version = await currentVersion();
  let cache: UpdateCache | null = null;
  try {
    cache = await readJSON<UpdateCache>(CACHE_FILE);
  } catch {
    cache = null;
  }

  let latest = cache?.latest ?? null;
  const fresh = cache && Date.now() - cache.checkedAt < TTL_MS;
  if (!fresh) {
    latest = await fetchLatest();
    try {
      await ensureDir(OVTOOLS_HOME);
      await writeJSON(CACHE_FILE, { checkedAt: Date.now(), latest } satisfies UpdateCache);
    } catch {
      // cache is an optimization only
    }
  }
  if (!latest || compareVersions(latest, version) <= 0) return null;
  return { current: version, latest, hasUpdate: true };
}

export function updateNotice(info: UpdateInfo): string {
  return [
    '',
    `Update available: ${info.current} -> ${info.latest}`,
    'Update with: npm install -g ovtools@latest',
    '',
  ].join('\n');
}
