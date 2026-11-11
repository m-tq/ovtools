import * as fs from 'fs/promises';
import * as path from 'path';
import type { LogEntry, LogLevel } from '../types';
import { LOGS_DIR } from '../constants';

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readJSON<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeJSON(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const body = JSON.stringify(data, null, 2) + '\n';
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, body, 'utf8');
  try {
    await fs.rename(tmp, filePath);
  } catch (err: any) {
    if (err && (err.code === 'EEXIST' || err.code === 'EPERM')) {
      await fs.rm(filePath, { force: true });
      await fs.rename(tmp, filePath);
    } else {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }
}

export function cleanLine(line: string): string {
  let clean = String(line).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  clean = clean.replace(/[─│┌┐└┘├┤┬┴┼]/g, '-');
  clean = clean.replace(/[═║╔╗╚╝╠╣╦╩╬]/g, '=');
  clean = clean.replace(/…/g, '...');
  clean = clean.replace(/[\u2013\u2014\u2015\u2212\u00b7]/g, '-');
  clean = clean.replace(/\u2192/g, '->');
  clean = clean.replace(/[^\x09\x20-\x7E]/g, '');
  clean = clean.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '');
  return clean.replace(/\r$/, '').trimEnd();
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function timestamp(): string {
  return new Date().toISOString();
}

export type LogListener = (entry: LogEntry) => void;

const LEVEL_TAG: Record<LogLevel, string> = {
  info: 'INFO',
  ok: 'OK',
  warn: 'WARN',
  error: 'ERROR',
  step: 'STEP',
  remote: 'REMO',
  data: 'DATA',
};

const CONSOLE_COLOR: Record<LogLevel, string> = {
  info: '\x1b[36m',
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  step: '\x1b[1;35m',
  remote: '\x1b[90m',
  data: '\x1b[37m',
};

export class Logger {
  private logFile: string;
  private buffer: LogEntry[] = [];
  private listeners = new Set<LogListener>();
  private seq = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private echo: boolean;

  constructor(logFile: string, echo = true) {
    this.logFile = logFile;
    this.echo = echo;
  }

  log(message: string, level: LogLevel = 'info', meta: { host?: string; program?: string } = {}): void {
    const line = cleanLine(message);
    if (!line && level !== 'data') return;
    const entry: LogEntry = {
      seq: ++this.seq,
      ts: Date.now() / 1000,
      level,
      line,
      host: meta.host,
      program: meta.program,
    };
    this.buffer.push(entry);
    if (this.buffer.length > 6000) this.buffer.splice(0, this.buffer.length - 6000);

    if (this.echo) {
      const color = process.stdout.isTTY ? (CONSOLE_COLOR[level] || '') : '';
      const reset = color ? '\x1b[0m' : '';
      process.stdout.write(`${color}[${LEVEL_TAG[level]}]${reset} ${line}\n`);
    }
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // a broken subscriber must never break the run
      }
    }
    this.appendFile(entry);
  }

  private appendFile(entry: LogEntry): void {
    const text = `[${new Date(entry.ts * 1000).toISOString()}] [${LEVEL_TAG[entry.level]}] ${entry.line}\n`;
    this.writeChain = this.writeChain
      .then(async () => {
        await ensureDir(path.dirname(this.logFile));
        await fs.appendFile(this.logFile, text, 'utf8');
      })
      .catch(() => undefined);
  }

  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  entriesSince(sinceSeq = 0, limit = 3000): LogEntry[] {
    const rows = this.buffer.filter(e => e.seq > sinceSeq);
    return rows.slice(Math.max(0, rows.length - limit));
  }

  lastSeq(): number {
    return this.seq;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }
}

export function createLogger(name: string, echo = true): Logger {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return new Logger(path.join(LOGS_DIR, `${name}-${stamp}.log`), echo);
}
