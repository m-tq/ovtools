import { HOST_KEYS_FILE } from '../constants';
import { readJSON, writeJSON } from '../utils/helpers';
import { createSSHClient } from '../ssh/client';
import type { HostAuth } from '../types';

export async function loadHostkeys(): Promise<Record<string, string>> {
  return (await readJSON<Record<string, string>>(HOST_KEYS_FILE)) || {};
}

export async function trustHostKey(ip: string, auth: HostAuth): Promise<{ ok: boolean; detail: string; fingerprint?: string }> {
  let fingerprint = '';
  try {
    const client = await createSSHClient({
      host: ip,
      port: 22,
      username: 'root',
      auth,
      ignorePinnedHostKey: true,
    });
    fingerprint = client.hostFingerprint || '';
    await client.disconnect();
    if (!fingerprint) return { ok: false, detail: 'the host did not present a key' };
    const map = await loadHostkeys();
    map[ip] = fingerprint;
    await writeJSON(HOST_KEYS_FILE, map);
    return { ok: true, detail: `host key for ${ip} pinned`, fingerprint };
  } catch (err) {
    // The handshake (and therefore the host key) happens before password/key
    // auth. A wrong password still gives us the presented key, so pin it: the
    // credential error is reported separately and must not block a re-check.
    fingerprint = (err as any)?.hostFingerprint || fingerprint;
    if (fingerprint) {
      const map = await loadHostkeys();
      map[ip] = fingerprint;
      await writeJSON(HOST_KEYS_FILE, map);
      return {
        ok: true,
        detail: `host key accepted but the login still fails: ${(err as Error).message}`,
        fingerprint,
      };
    }
    return { ok: false, detail: (err as Error).message };
  }
}

export async function removeHostKey(ip: string): Promise<void> {
  const map = await loadHostkeys();
  delete map[ip];
  await writeJSON(HOST_KEYS_FILE, map);
}

export function isHostKeyError(message: string): boolean {
  return /host denied|verification failed|host key|fingerprint/i.test(message);
}
