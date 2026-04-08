import { useState, useEffect, useCallback } from 'react';
import Header from './components/Header';
import InitPanel from './components/InitPanel';
import TerminalPanel from './components/TerminalPanel';
import PromptBar from './components/PromptBar';
import StatusBar from './components/StatusBar';
import type { Stats } from './hooks/useSystemStats';

type AppState = 'init' | 'starting' | 'running';

interface ProxyStatus {
  status: string;
  model:  string | null;
  port:   number | null;
}

const MAX_LOG = 200;

function appendLog(prev: string[], raw: string): string[] {
  // Strip ANSI codes for cleaner display, split into lines
  const clean = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const lines = clean.split('\n').filter((l) => l.trim());
  return [...prev, ...lines].slice(-MAX_LOG);
}

export default function App(): JSX.Element {
  const [appState,    setAppState]    = useState<AppState>('init');
  const [isExpanded,  setIsExpanded]  = useState(false);
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus>({ status: 'stopped', model: null, port: 9090 });
  const [stats,       setStats]       = useState<Stats | null>(null);
  const [proxyLog,    setProxyLog]    = useState<string[]>([]);

  useEffect(() => {
    const api = window.electronAPI;

    const unsubProxy = api.proxy.onStatus((s) => {
      setProxyStatus(s);
      if (s.status === 'running') {
        setAppState('running');
        // TerminalPanel starts the PTY itself on mount — no call needed here
      } else if (s.status === 'stopped') {
        setAppState('init');
      }
      // 'error': stay on current view so the log is visible; user clicks retry
    });

    const unsubLog    = api.proxy.onLog((text) => setProxyLog((p) => appendLog(p, text)));
    const unsubStats  = api.stats.onUpdate((s)  => setStats(s as Stats));
    const unsubExpand = api.window.onExpanded((v) => setIsExpanded(v));

    // Sync with existing proxy state on mount
    api.proxy.getStatus().then((s) => {
      setProxyStatus(s);
      if (s.status === 'running') setAppState('running');
    });

    return () => { unsubProxy(); unsubLog(); unsubStats(); unsubExpand(); };
  }, []);

  const handleStart = useCallback((config: Record<string, string>) => {
    setProxyLog([]);    // clear old log on each attempt
    setAppState('starting');
    window.electronAPI.proxy.start(config);
    // Terminal is started by the proxy:onStatus handler once status === 'running'
  }, []);

  const handlePrompt = useCallback((text: string) => {
    window.electronAPI.terminal.send(text + '\r');
  }, []);

  return (
    <div className="app" data-expanded={isExpanded}>
      <Header
        isExpanded={isExpanded}
        onToggleExpand={() => window.electronAPI.window.toggleExpand()}
        onClose={() => window.electronAPI.window.close()}
      />

      <main className="app-content">
        {appState === 'init' && <InitPanel onStart={handleStart} />}

        {appState === 'starting' && (
          <div className="loading-screen">
            <div className="spinner" />
            <p className="loading-text">Starting proxy…</p>
          </div>
        )}

        {appState === 'running' && (
          <>
            <TerminalPanel isExpanded={isExpanded} />
            <PromptBar onSubmit={handlePrompt} />
          </>
        )}
      </main>

      <StatusBar stats={stats} proxyStatus={proxyStatus} proxyLog={proxyLog} />
    </div>
  );
}
