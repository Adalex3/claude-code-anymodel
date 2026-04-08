// preload/index.ts — Secure IPC bridge between main process and renderer.
// All channel names are explicit; no raw ipcRenderer is exposed.

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

type Unsub = () => void;
type CB<T = unknown> = (value: T) => void;

function on<T>(channel: string, cb: CB<T>): Unsub {
  const handler = (_e: IpcRendererEvent, v: T): void => cb(v);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('electronAPI', {
  terminal: {
    start:  (cwd?: string)                          => ipcRenderer.send('terminal:start', cwd),
    send:   (data: string)                          => ipcRenderer.send('terminal:input', data),
    resize: (cols: number, rows: number)            => ipcRenderer.send('terminal:resize', { cols, rows }),
    onData: (cb: CB<string>): Unsub                 => on('terminal:data', cb),
    onExit: (cb: CB<number>): Unsub                 => on('terminal:exit', cb),
  },

  proxy: {
    start:     (cfg: Record<string, string>)        => ipcRenderer.send('proxy:start', cfg),
    stop:      ()                                   => ipcRenderer.send('proxy:stop'),
    getStatus: ()                                   => ipcRenderer.invoke('proxy:status') as Promise<ProxyStatusPayload>,
    onStatus:  (cb: CB<ProxyStatusPayload>): Unsub  => on('proxy:status', cb),
    onLog:     (cb: CB<string>): Unsub              => on('proxy:log', cb),
  },

  stats: {
    onUpdate: (cb: CB<unknown>): Unsub              => on('stats:update', cb),
  },

  window: {
    toggleExpand: ()                                => ipcRenderer.send('window:toggle-expand'),
    close:        ()                                => ipcRenderer.send('window:close'),
    onExpanded:   (cb: CB<boolean>): Unsub          => on('window:expanded', cb),
  },
});

interface ProxyStatusPayload {
  status: string;
  model:  string | null;
  port:   number | null;
}
