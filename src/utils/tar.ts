import * as zlib from 'zlib';

export interface TarEntry {
  name: string;
  data: Buffer;
  mode?: number;
}

function octal(value: number, length: number): Buffer {
  const text = value.toString(8).padStart(length - 1, '0') + '\0';
  return Buffer.from(text, 'ascii');
}

function header(name: string, size: number, mode: number, mtime: number, type: '0' | '5'): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar entry name too long: ${name}`);
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  octal(mode, 8).copy(h, 100);
  octal(0, 8).copy(h, 108);          // uid
  octal(0, 8).copy(h, 116);          // gid
  octal(size, 12).copy(h, 124);
  octal(mtime, 12).copy(h, 136);
  h.fill(0x20, 148, 156);            // checksum placeholder
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  const check = sum.toString(8).padStart(6, '0') + '\0 ';
  h.write(check, 148, 8, 'ascii');
  return h;
}

/**
 * Minimal POSIX ustar writer. Keeping this in-process means the operator never
 * needs the host `tar`/`bsdtar`; the VPS unpacks the single uploaded archive.
 */
export function createTarGz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  const dirs = new Set<string>();
  const mtime = Math.floor(Date.now() / 1000);

  for (const entry of entries) {
    const parts = entry.name.split('/');
    let dir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      dir = dir ? `${dir}/${parts[i]}` : parts[i];
      dirs.add(dir);
    }
  }
  const orderedDirs = Array.from(dirs).sort();
  for (const dir of orderedDirs) {
    blocks.push(header(`${dir}/`, 0, 0o755, mtime, '5'));
  }
  for (const entry of entries) {
    blocks.push(header(entry.name, entry.data.length, entry.mode ?? 0o644, mtime, '0'));
    blocks.push(entry.data);
    const pad = (512 - (entry.data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
}
