import { spawn } from 'child_process';

export function openBrowser(url: string): void {
  if (process.env.OVTOOLS_NO_BROWSER === '1' || process.env.OVTOOLS_NO_BROWSER === 'true') return;
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return;
    }
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // A headless host or a missing opener must not stop the console.
  }
}
