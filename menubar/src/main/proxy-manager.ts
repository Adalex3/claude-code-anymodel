// proxy-manager.ts — Spawns and monitors smart-proxy.mjs as a child process.

import { BrowserWindow } from 'electron';
import { spawn, execSync, ChildProcess } from 'child_process';
import { join } from 'path';
import { is } from '@electron-toolkit/utils';

export type ProxyStatus = 'stopped' | 'starting' | 'running' | 'error';

export class ProxyManager {
  private status: ProxyStatus = 'stopped';
  private proc: ChildProcess | null = null;
  private model: string | null = null;
  private port = 9090;
  private readonly win: BrowserWindow;

  constructor(win: BrowserWindow) {
    this.win = win;
  }

  getStatus(): ProxyStatus    { return this.status; }
  getActiveModel(): string | null { return this.model; }
  getPort(): number           { return this.port; }

  /** Kill any existing process already listening on the target port. */
  private killPortSquatter(port: number): void {
    try {
      const out = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' }).trim();
      if (out) {
        out.split('\n').forEach((pid) => {
          try { execSync(`kill -9 ${pid.trim()}`); } catch { /* already gone */ }
        });
        console.log(`[proxy] cleared port ${port} (pid(s): ${out.replace(/\n/g, ', ')})`);
      }
    } catch { /* lsof returns non-zero when no process found — that's fine */ }
  }

  start(config: Record<string, string> = {}): void {
    if (this.proc) this.stop();
    this.killPortSquatter(parseInt(config.PROXY_PORT ?? '9090', 10));

    // In dev mode reference sibling mjs directly; in prod use bundled resource
    const proxyPath = is.dev
      ? join(__dirname, '../../../smart-proxy.mjs')
      : join(process.resourcesPath, 'smart-proxy.mjs');

    this.port   = parseInt(config.PROXY_PORT ?? '9090', 10);
    this.status = 'starting';
    this.emit();

    this.proc = spawn('node', [proxyPath], {
      env: { ...process.env, ...config, PROXY_PORT: String(this.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onChunk = (chunk: Buffer): void => {
      const text = chunk.toString();
      // Strip ANSI codes for pattern matching (smart-proxy wraps parts in color codes)
      const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

      // Detect ready: smart-proxy prints "◆ Smart Model Proxy on :PORT"
      if (this.status === 'starting' && /Smart Model Proxy/i.test(plain)) {
        this.status = 'running';
        this.emit();
      }

      // Detect routed model: "[ROUTE] <model> → tier=X → <label>"
      const routeMatch = plain.match(/\[ROUTE\]\s+\S+\s+[^\s]+\s+tier=\S+\s+[^\s]+\s+(\S+)/i)
        ?? plain.match(/\[ROUTE\].*?→\s*(\S+)\s*$/im);
      if (routeMatch) {
        this.model = routeMatch[1];
        this.emit();
      }

      this.win.webContents.send('proxy:log', text);
    };

    this.proc.stdout?.on('data', onChunk);
    this.proc.stderr?.on('data', onChunk);

    this.proc.on('exit', (code) => {
      this.status = code === 0 ? 'stopped' : 'error';
      this.model  = null;
      this.proc   = null;
      this.emit();
    });
  }

  stop(): void {
    this.proc?.kill('SIGTERM');
    this.proc   = null;
    this.status = 'stopped';
    this.model  = null;
    this.emit();
  }

  private emit(): void {
    this.win.webContents.send('proxy:status', {
      status: this.status,
      model:  this.model,
      port:   this.port,
    });
  }
}
