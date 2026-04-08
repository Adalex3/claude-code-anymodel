// StatusBar.tsx — Compact stats strip with expandable details + proxy log viewer.

import { useState, useEffect, useRef } from 'react';
import type { Stats } from '../hooks/useSystemStats';

const STATUS_COLOR: Record<string, string> = {
  running:  '#4ade80',
  starting: '#fbbf24',
  stopped:  '#6b6b80',
  error:    '#f87171',
};

interface Props {
  stats:       Stats | null;
  proxyStatus: { status: string; model: string | null; port: number | null };
  proxyLog:    string[];
}

export default function StatusBar({ stats, proxyStatus, proxyLog }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-open and auto-scroll when an error arrives
  useEffect(() => {
    if (proxyStatus.status === 'error') setOpen(true);
  }, [proxyStatus.status]);

  useEffect(() => {
    if (open && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [proxyLog, open]);

  const color    = STATUS_COLOR[proxyStatus.status] ?? '#6b6b80';
  const model    = proxyStatus.model ?? stats?.proxy.model ?? null;
  const ramUsed  = stats?.ram.usedGB;
  const ramTotal = stats?.ram.totalGB;
  const cpu      = stats?.cpu.load;
  const isError  = proxyStatus.status === 'error';
  const showLog  = open && proxyLog.length > 0;

  return (
    <div className="status-bar">
      {/* ── Compact strip ── */}
      <div className="status-strip" onClick={() => setOpen((v) => !v)}>
        <span className="status-dot" style={{ background: color }} />
        <span className="status-word" style={{ color }}>{proxyStatus.status}</span>

        {model && (
          <>
            <span className="status-pipe">|</span>
            <span className="status-model" title={model}>{model}</span>
          </>
        )}

        {ramUsed != null && ramTotal != null && (
          <>
            <span className="status-pipe">|</span>
            <span className="status-metric">RAM {ramUsed}/{ramTotal} GB</span>
          </>
        )}

        {cpu != null && (
          <>
            <span className="status-pipe">|</span>
            <span className="status-metric">CPU {cpu}%</span>
          </>
        )}

        {isError && <span className="status-error-hint">▸ click for details</span>}
        <span className="status-toggle">{open ? '▲' : '▼'}</span>
      </div>

      {/* ── Expanded panel ── */}
      {open && (
        <div className="status-details">
          {/* Stats rows */}
          <Row label="Proxy"  value={`${proxyStatus.status}${proxyStatus.port ? `  :${proxyStatus.port}` : ''}`} color={color} />
          {model             && <Row label="Model"      value={model} />}
          {ramUsed  != null  && <Row label="System RAM" value={`${ramUsed} / ${ramTotal} GB  (${stats?.ram.freeGB} GB free)`} />}
          {stats?.ram.claudeMB != null && stats.ram.claudeMB > 0 &&
                                 <Row label="Claude RAM" value={`${stats.ram.claudeMB} MB`} />}
          {cpu      != null  && <Row label="CPU load"   value={`${cpu}%`} />}
          {stats?.gpu        && <Row label="GPU"        value={gpuLabel(stats.gpu)} />}

          {/* Proxy log — shown when there's output (always for errors, on demand otherwise) */}
          {showLog && (
            <div className={`proxy-log${isError ? ' proxy-log-error' : ''}`} ref={logRef}>
              {proxyLog.map((line, i) => (
                <div key={i} className={`log-line${isErrorLine(line) ? ' log-line-err' : ''}`}>
                  {line}
                </div>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="status-actions">
            {proxyStatus.status === 'running' && (
              <button
                className="btn-stop-proxy"
                onClick={(e) => { e.stopPropagation(); window.electronAPI.proxy.stop(); }}
              >
                ■ &nbsp;Stop Proxy
              </button>
            )}
            {isError && (
              <button
                className="btn-retry-proxy"
                onClick={(e) => { e.stopPropagation(); window.electronAPI.proxy.stop(); }}
              >
                ↺ &nbsp;Dismiss &amp; Retry
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }): JSX.Element {
  return (
    <div className="detail-row">
      <span className="detail-label">{label}</span>
      <span className="detail-value" style={color ? { color } : undefined}>{value}</span>
    </div>
  );
}

function gpuLabel(gpu: { model: string; vramMB: number | null }): string {
  return gpu.model + (gpu.vramMB ? `  (${Math.round(gpu.vramMB / 1024)} GB VRAM)` : '');
}

function isErrorLine(line: string): boolean {
  return /error|fail|exception|cannot|enoent|eacces/i.test(line);
}
