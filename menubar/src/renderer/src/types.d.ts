// Global type augmentation for the IPC bridge exposed via contextBridge.

export {};

interface ProxyStatusPayload {
  status: string;
  model:  string | null;
  port:   number | null;
}

type Unsub = () => void;

declare global {
  interface Window {
    electronAPI: {
      terminal: {
        start:  (cwd?: string) => void;
        send:   (data: string) => void;
        resize: (cols: number, rows: number) => void;
        onData: (cb: (data: string) => void) => Unsub;
        onExit: (cb: (code: number) => void) => Unsub;
      };
      proxy: {
        start:     (config: Record<string, string>) => void;
        stop:      () => void;
        getStatus: () => Promise<ProxyStatusPayload>;
        onStatus:  (cb: (s: ProxyStatusPayload) => void) => Unsub;
        onLog:     (cb: (text: string) => void) => Unsub;
      };
      stats: {
        onUpdate: (cb: (stats: unknown) => void) => Unsub;
      };
      window: {
        toggleExpand: () => void;
        close:        () => void;
        onExpanded:   (cb: (expanded: boolean) => void) => Unsub;
      };
    };
  }
}
