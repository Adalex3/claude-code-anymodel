// TerminalPanel.tsx — xterm.js terminal connected to a node-pty PTY via IPC.

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface Props {
  isExpanded: boolean;
}

const THEME = {
  background:    '#0d0d14',
  foreground:    '#e2e2e8',
  cursor:        '#7c6af7',
  cursorAccent:  '#0d0d14',
  selectionBackground: 'rgba(124,106,247,0.25)',
  black:         '#1a1a2e',
  red:           '#f87171',
  green:         '#4ade80',
  yellow:        '#fbbf24',
  blue:          '#60a5fa',
  magenta:       '#c084fc',
  cyan:          '#22d3ee',
  white:         '#e2e2e8',
  brightBlack:   '#6b6b80',
  brightRed:     '#fca5a5',
  brightGreen:   '#86efac',
  brightYellow:  '#fde68a',
  brightBlue:    '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan:    '#67e8f9',
  brightWhite:   '#f8fafc',
};

export default function TerminalPanel({ isExpanded }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef      = useRef<Terminal | null>(null);
  const fitRef       = useRef<FitAddon | null>(null);
  const startedRef   = useRef(false);

  const fit = (): void => {
    if (!fitRef.current || !termRef.current) return;
    fitRef.current.fit();
    const { cols, rows } = termRef.current;
    window.electronAPI.terminal.resize(cols, rows);
  };

  useEffect(() => {
    const term = new Terminal({
      theme: THEME,
      fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", "JetBrains Mono", monospace',
      fontSize: 13,
      lineHeight: 1.45,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 3000,
      allowProposedApi: true,
    });

    const fitAddon      = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    termRef.current = term;
    fitRef.current  = fitAddon;

    if (containerRef.current) {
      term.open(containerRef.current);
      fitAddon.fit();
    }

    // Input → PTY
    term.onData((data) => window.electronAPI.terminal.send(data));

    // PTY output → terminal
    const unsubData = window.electronAPI.terminal.onData((data) => term.write(data));
    const unsubExit = window.electronAPI.terminal.onExit(() => {
      term.write('\r\n\x1b[2m[process exited — press Enter to restart]\x1b[0m\r\n');
    });

    // Start PTY once (avoid double-start in StrictMode)
    if (!startedRef.current) {
      startedRef.current = true;
      window.electronAPI.terminal.start();
    }

    // Initial fit after paint
    requestAnimationFrame(() => fit());

    // Resize observer for container size changes
    const ro = new ResizeObserver(() => fit());
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      unsubData();
      unsubExit();
      ro.disconnect();
      term.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refit after expand/collapse animation (~300ms)
  useEffect(() => {
    const t = setTimeout(fit, 320);
    return () => clearTimeout(t);
  }, [isExpanded]);

  return (
    <div className="terminal-wrapper">
      <div className="terminal-container" ref={containerRef} />
    </div>
  );
}
