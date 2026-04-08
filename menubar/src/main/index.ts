// menubar/src/main/index.ts — Electron main process
// Creates a macOS menu bar tray app with a frameless popup window.

import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';
import { deflateSync } from 'zlib';
import { is } from '@electron-toolkit/utils';
import { ProxyManager } from './proxy-manager';
import si from 'systeminformation';
import pty from 'node-pty';
import os from 'os';

// Hide from macOS dock — pure menu bar app
if (process.platform === 'darwin') {
  app.dock?.hide();
}

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let ptyProcess: pty.IPty | null = null;
let proxyManager: ProxyManager | null = null;
let statsInterval: NodeJS.Timeout | null = null;
let isExpanded = false;

const COMPACT  = { w: 420, h: 560 };
const EXPANDED = { w: 860, h: 660 };

// ── Tray icon ─────────────────────────────────────────────────────────────────
// Tries resources/tray-icon.png first, then generates a ◆ diamond PNG inline.
// The generated PNG is a proper 18×18 RGBA image — no external deps needed.

function crc32(buf: Buffer): number {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = t[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const tb = Buffer.from(type, 'ascii');
  const lb = Buffer.allocUnsafe(4); lb.writeUInt32BE(data.length);
  const cb = Buffer.allocUnsafe(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([lb, tb, data, cb]);
}

/** Generates an 18×18 RGBA PNG of a ◆ diamond for the macOS menu bar. */
function makeDefaultIcon(): Buffer {
  const S = 18, cx = 8.5, cy = 8.5, r = 6.8;
  const rows: Buffer[] = [];
  for (let y = 0; y < S; y++) {
    const row = Buffer.alloc(1 + S * 4); // filter byte + 4 channels
    for (let x = 0; x < S; x++) {
      row[1 + x * 4 + 3] = Math.abs(x - cx) + Math.abs(y - cy) <= r ? 255 : 0;
    }
    rows.push(row);
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildTrayIcon(): Electron.NativeImage {
  const iconPath = join(__dirname, '../../resources/tray-icon.png');
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) { img.setTemplateImage(true); return img; }
  } catch { /* fall through to generated icon */ }
  const img = nativeImage.createFromBuffer(makeDefaultIcon(), { scaleFactor: 1 });
  img.setTemplateImage(true);
  return img;
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: COMPACT.w,
    height: COMPACT.h,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#0d0d14',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needed for node-pty IPC
    },
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

function positionNearTray(): void {
  if (!mainWindow || !tray) return;
  const tb = tray.getBounds();
  const wb = mainWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y });
  const x = Math.max(
    display.bounds.x + 4,
    Math.min(
      Math.round(tb.x + tb.width / 2 - wb.width / 2),
      display.bounds.x + display.bounds.width - wb.width - 4,
    ),
  );
  const onBottom = tb.y < display.bounds.y + display.bounds.height / 2;
  const y = onBottom
    ? tb.y + tb.height + 4
    : tb.y - wb.height - 4;
  mainWindow.setPosition(x, y, false);
}

function toggleWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    positionNearTray();
    mainWindow.show();
    mainWindow.focus();
  }
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray(): void {
  const icon = buildTrayIcon();
  console.log('[tray] icon size:', icon.getSize(), 'isEmpty:', icon.isEmpty());
  tray = new Tray(icon);
  tray.setToolTip('Claude Code');
  tray.on('click', toggleWindow);
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Toggle', click: toggleWindow },
      { type: 'separator' },
      { label: 'Quit Claude Menubar', click: () => app.quit() },
    ]);
    tray!.popUpContextMenu(menu);
  });
}

// ── PTY ───────────────────────────────────────────────────────────────────────

function resolveShell(): string {
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'];
  for (const s of candidates) {
    if (s && existsSync(s)) return s;
  }
  return '/bin/sh';
}

function cleanEnv(): Record<string, string> {
  // node-pty requires all env values to be strings — filter out undefined/null
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  env.TERM      = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

function spawnPty(cwd?: string): void {
  if (ptyProcess) {
    try { ptyProcess.kill(); } catch { /* already dead */ }
    ptyProcess = null;
  }

  const shell   = resolveShell();
  const workdir = cwd && existsSync(cwd) ? cwd : os.homedir();

  console.log(`[pty] spawn shell=${shell} cwd=${workdir}`);

  try {
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 34,
      cwd: workdir,
      env: cleanEnv(),
    });
  } catch (err) {
    console.error('[pty] spawn failed:', err);
    mainWindow?.webContents.send('terminal:data',
      `\r\n\x1b[31m[PTY error] ${(err as Error).message}\x1b[0m\r\n`);
    return;
  }

  ptyProcess.onData((data) => mainWindow?.webContents.send('terminal:data', data));
  ptyProcess.onExit(({ exitCode }) => {
    mainWindow?.webContents.send('terminal:exit', exitCode);
    ptyProcess = null;
  });
}

// ── System stats polling ──────────────────────────────────────────────────────

async function collectStats(): Promise<Record<string, unknown>> {
  const [memR, loadR, graphicsR, procsR] = await Promise.allSettled([
    si.mem(),
    si.currentLoad(),
    si.graphics(),
    si.processes(),
  ]);

  const mem      = memR.status      === 'fulfilled' ? memR.value      : null;
  const load     = loadR.status     === 'fulfilled' ? loadR.value     : null;
  const graphics = graphicsR.status === 'fulfilled' ? graphicsR.value : null;
  const procs    = procsR.status    === 'fulfilled' ? procsR.value    : null;

  const claudeProcs = procs?.list?.filter((p) =>
    /claude|smart-proxy|node.*proxy/i.test(p.command ?? p.name ?? ''),
  ) ?? [];
  const claudeMB = Math.round(
    claudeProcs.reduce((s, p) => s + (p.memRss ?? 0) / 1024, 0),
  );

  return {
    ram: {
      usedGB:   mem ? +(mem.active / 1e9).toFixed(1) : null,
      totalGB:  mem ? +(mem.total  / 1e9).toFixed(1) : null,
      freeGB:   mem ? +(mem.available / 1e9).toFixed(1) : null,
      claudeMB,
    },
    cpu: { load: load ? Math.round(load.currentLoad) : null },
    gpu: graphics?.controllers?.[0]
      ? {
          model:  graphics.controllers[0].model,
          vramMB: graphics.controllers[0].vram ?? null,
        }
      : null,
    proxy: {
      status: proxyManager?.getStatus() ?? 'stopped',
      model:  proxyManager?.getActiveModel() ?? null,
      port:   proxyManager?.getPort() ?? null,
    },
  };
}

function startStatsPolling(): void {
  if (statsInterval) clearInterval(statsInterval);
  const tick = async (): Promise<void> => {
    try {
      mainWindow?.webContents.send('stats:update', await collectStats());
    } catch { /* skip */ }
  };
  tick();
  statsInterval = setInterval(tick, 3000);
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

function setupIPC(): void {
  // Terminal
  ipcMain.on('terminal:start',  (_e, cwd?: string) => spawnPty(cwd));
  ipcMain.on('terminal:input',  (_e, data: string) => ptyProcess?.write(data));
  ipcMain.on('terminal:resize', (_e, { cols, rows }: { cols: number; rows: number }) =>
    ptyProcess?.resize(cols, rows),
  );

  // Proxy
  ipcMain.on('proxy:start', (_e, config: Record<string, string>) =>
    proxyManager?.start(config),
  );
  ipcMain.on('proxy:stop', () => proxyManager?.stop());
  ipcMain.handle('proxy:status', () => ({
    status: proxyManager?.getStatus() ?? 'stopped',
    model:  proxyManager?.getActiveModel() ?? null,
    port:   proxyManager?.getPort() ?? null,
  }));

  // Window expand/collapse
  ipcMain.on('window:toggle-expand', () => {
    if (!mainWindow) return;
    isExpanded = !isExpanded;
    const { w, h } = isExpanded ? EXPANDED : COMPACT;
    mainWindow.setResizable(true);
    mainWindow.setSize(w, h, true);
    mainWindow.setResizable(false);
    positionNearTray();
    mainWindow.webContents.send('window:expanded', isExpanded);
  });

  ipcMain.on('window:close', () => mainWindow?.hide());
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  app.setName('Claude Code');
  createTray();
  mainWindow = createWindow();
  proxyManager = new ProxyManager(mainWindow);
  setupIPC();
  startStatsPolling();

  // Hide when window loses focus (click outside)
  mainWindow.on('blur', () => {
    if (!mainWindow?.webContents.isDevToolsOpened()) {
      mainWindow?.hide();
    }
  });
});

app.on('before-quit', () => {
  proxyManager?.stop();
  ptyProcess?.kill();
  if (statsInterval) clearInterval(statsInterval);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
