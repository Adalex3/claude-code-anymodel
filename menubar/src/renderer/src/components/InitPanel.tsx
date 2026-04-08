// InitPanel.tsx — Provider selection & configuration, mirroring launch.mjs UI.

import { useState } from 'react';

interface Provider {
  id:    string;
  name:  string;
  port:  number | null;
  desc:  string;
  color: string;
}

const PROVIDERS: Provider[] = [
  {
    id: 'ollama', name: 'Ollama', port: 11434, color: '#4ade80',
    desc: 'Most popular local engine. Best tool-call reliability. ollama pull <model>.',
  },
  {
    id: 'mlx', name: 'MLX', port: 8080, color: '#22d3ee',
    desc: "Apple's native ML framework. 2–3× faster than Ollama on Apple Silicon.",
  },
  {
    id: 'lmstudio', name: 'LM Studio', port: 1234, color: '#c084fc',
    desc: 'Desktop app with HuggingFace browser. Load a model in the GUI to activate.',
  },
  {
    id: 'jan', name: 'Jan', port: 1337, color: '#60a5fa',
    desc: 'Lightweight background API server (jan.ai). Good for always-on models.',
  },
  {
    id: 'llamacpp', name: 'llama.cpp', port: 8082, color: '#fbbf24',
    desc: 'Raw llama-server. Precise GPU/CPU layer control. Bring your own GGUF file.',
  },
  {
    id: 'openrouter', name: 'OpenRouter', port: null, color: '#fb923c',
    desc: 'Cloud API gateway — automatic fallback when no local model covers a tier.',
  },
];

type Tier = 'tiny' | 'fast' | 'balanced' | 'powerful' | 'reasoning';
const TIERS: Tier[] = ['tiny', 'fast', 'balanced', 'powerful', 'reasoning'];

interface Props {
  onStart: (config: Record<string, string>) => void;
}

export default function InitPanel({ onStart }: Props): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set(['ollama']));
  const [tiers, setTiers]       = useState<Record<Tier, string>>({
    tiny: '', fast: '', balanced: '', powerful: '', reasoning: '',
  });
  const [port,       setPort]       = useState('9090');
  const [orKey,      setOrKey]      = useState('');

  const toggle = (id: string): void => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const launch = (): void => {
    const cfg: Record<string, string> = { PROXY_PORT: port };
    if (orKey) cfg.OPENROUTER_API_KEY = orKey;
    TIERS.forEach((t) => { if (tiers[t]) cfg[`${t.toUpperCase()}_MODEL`] = tiers[t]; });
    onStart(cfg);
  };

  return (
    <div className="init-panel">
      {/* ── Providers ── */}
      <div className="section-label">INFERENCE PROVIDERS</div>
      <div className="providers-grid">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            className={`provider-card${selected.has(p.id) ? ' selected' : ''}`}
            style={{ '--accent': p.color } as React.CSSProperties}
            onClick={() => toggle(p.id)}
          >
            <div className="provider-header">
              <span className="provider-name">{p.name}</span>
              {p.port && <span className="provider-port">:{p.port}</span>}
              {selected.has(p.id) && <span className="provider-check">✓</span>}
            </div>
            <div className="provider-desc">{p.desc}</div>
          </button>
        ))}
      </div>

      {/* ── Model tier overrides ── */}
      <div className="section-label">
        MODEL TIER OVERRIDES <span className="label-hint">optional — format: provider:model-id</span>
      </div>
      <div className="tiers-list">
        {TIERS.map((tier) => (
          <div key={tier} className="tier-row">
            <span className={`tier-badge tier-${tier}`}>{tier}</span>
            <input
              className="text-input"
              placeholder="e.g. ollama:qwen2.5-coder:14b"
              value={tiers[tier]}
              onChange={(e) => setTiers({ ...tiers, [tier]: e.target.value })}
            />
          </div>
        ))}
      </div>

      {/* ── Options ── */}
      <div className="section-label">OPTIONS</div>
      <div className="options-grid">
        <div className="option-field">
          <label className="option-label">Proxy port</label>
          <input
            className="text-input text-input-sm"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
        <div className="option-field">
          <label className="option-label">OpenRouter API key <span className="label-hint">cloud fallback</span></label>
          <input
            className="text-input"
            type="password"
            placeholder="sk-or-…"
            value={orKey}
            onChange={(e) => setOrKey(e.target.value)}
          />
        </div>
      </div>

      <button className="btn-launch" onClick={launch}>
        ▶ &nbsp; Launch Smart Proxy
      </button>
    </div>
  );
}
