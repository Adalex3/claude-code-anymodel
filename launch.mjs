#!/usr/bin/env node
// launch.mjs — Interactive terminal launcher for Claude Code Smart Proxy
// Usage:  node launch.mjs   (or ./launch.mjs if chmod +x)

import http  from 'http';
import fs    from 'fs';
import path  from 'path';
import os    from 'os';
import { spawnSync, execFileSync } from 'child_process';
import { fileURLToPath }           from 'url';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

// ── ANSI ──────────────────────────────────────────────────────────────────────

const C = {
  rst: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m',
  blu: '\x1b[34m', mag: '\x1b[35m', cyn: '\x1b[36m',
  gray: '\x1b[90m',
  bred: '\x1b[91m', bgrn: '\x1b[92m', byel: '\x1b[93m',
  bblu: '\x1b[94m', bmag: '\x1b[95m', bcyn: '\x1b[96m', bwht: '\x1b[97m',
  hide: '\x1b[?25l', show: '\x1b[?25h',
  alt:  '\x1b[?1049h', norm: '\x1b[?1049l',
  home: '\x1b[H',  cls:  '\x1b[2J',  eline: '\x1b[K',
};

// Strip ANSI codes to measure true visible width
const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const vlen      = s => [...stripAnsi(s)].length;

function rpad(s, w) {
  const n = vlen(s);
  return n < w ? s + ' '.repeat(w - n) : s;
}

function clip(s, w) {
  if (vlen(s) <= w) return s;
  let vis = 0, out = '';
  for (const m of s.matchAll(/(\x1b\[[0-9;?]*[A-Za-z])|([\s\S])/g)) {
    if (m[1]) { out += m[1]; continue; }
    if (vis >= w - 1) { out += '…'; break; }
    out += m[2]; vis++;
  }
  return out + C.rst;
}

// ── Tier helpers ──────────────────────────────────────────────────────────────

const TIER_C = {
  tiny: C.gray, fast: C.cyn, balanced: C.grn, powerful: C.yel, reasoning: C.mag,
};
const TIER_PATS = [
  [/deepseek-r1|qwq|:r1\b/i,              'reasoning'],
  [/671b|70b|72b/i,                        'powerful'],
  [/30b|32b|33b|34b/i,                     'powerful'],
  [/14b|15b|13b|12b|11b/i,                 'balanced'],
  [/coder.*(6|7|8)b|(6|7|8)b.*coder/i,    'fast'],
  [/[^.\d](6|7|8|9)b/i,                   'fast'],
  [/[^.\d](3|4)b\b|3\.8b|phi3/i,          'tiny'],
  [/[^.\d](1|2)b\b|smol/i,               'tiny'],
];
function tierOf(n) { for (const [p, t] of TIER_PATS) if (p.test(n)) return t; return 'balanced'; }

// ── Provider catalogue ────────────────────────────────────────────────────────

const PROVIDERS = [
  {
    id: 'ollama', name: 'Ollama', col: C.grn, port: 11434,
    desc: [
      'Most popular local inference engine.',
      'Manages model downloads, GPU setup, and serving',
      'automatically. Best all-round default choice.',
    ],
    pro: [
      'Best tool/function-call reliability for Claude Code',
      'Simple management: ollama pull <model-name>',
      'Automatic Metal GPU acceleration on Mac',
      'Thousands of models — all sizes and types',
    ],
    con: ['Slower than MLX on Apple Silicon (same model)'],
    suggest: [
      ['ollama pull qwen2.5-coder:14b',  'balanced    9.0 GB  ← fills your current gap'],
      ['ollama pull deepseek-r1:7b',     'reasoning   4.7 GB'],
      ['ollama pull llama3.2:3b',        'tiny        2.0 GB  (very fast for quick tasks)'],
      ['ollama pull deepseek-r1:32b',    'powerful   20.0 GB  (needs ≥ 32 GB unified RAM)'],
    ],
    install: 'brew install ollama  —or—  https://ollama.com',
    flag: '--start-ollama',
  },
  {
    id: 'mlx', name: 'MLX', col: C.cyn, port: 8080,
    needsModel: true,
    desc: [
      "Apple's ML framework with native Metal GPU.",
      '2–3× faster than Ollama on M-series chips.',
      'Best choice for your fast/tiny/balanced tiers.',
    ],
    pro: [
      '2–3× faster than Ollama on Apple Silicon',
      'Runs natively on Metal — lowest possible latency',
      'Ideal for haiku-tier (quick response) requests',
      'Models from mlx-community on HuggingFace',
    ],
    con: [
      'Apple Silicon only (M1/M2/M3/M4)',
      'Loads one model at a time',
      'First run downloads model from HuggingFace (~mins)',
    ],
    install: 'pip install mlx-lm',
    flag: '--start-mlx',
    models: [
      { id: 'mlx-community/Qwen2.5-Coder-7B-Instruct-8bit',    t: 'fast',      gb: 4.5, info: 'Fast coder · best default' },
      { id: 'mlx-community/Qwen2.5-14B-Instruct-4bit',         t: 'balanced',  gb: 8.0, info: 'Balanced general + code' },
      { id: 'mlx-community/Qwen2.5-Coder-14B-Instruct-8bit',   t: 'balanced',  gb: 9.0, info: 'Balanced coder' },
      { id: 'mlx-community/DeepSeek-R1-Distill-Qwen-14B-4bit', t: 'reasoning', gb: 8.0, info: 'Plan mode · fast reasoning' },
      { id: 'mlx-community/Llama-3.2-3B-Instruct-4bit',        t: 'tiny',      gb: 1.8, info: 'Ultra-fast tiny tasks' },
      { id: 'mlx-community/Qwen3-8B-4bit',                     t: 'fast',      gb: 5.0, info: 'Latest Qwen3, fast' },
    ],
  },
  {
    id: 'lmstudio', name: 'LM Studio', col: C.mag, port: 1234,
    app: 'LM Studio',
    desc: [
      'Desktop app with HuggingFace model browser.',
      'Load a model in the GUI — its OpenAI-compatible',
      'API is ready instantly. No CLI needed.',
    ],
    pro: [
      'GUI browser — search HuggingFace inside the app',
      'Easiest way to download and compare GGUF models',
      'API auto-starts when the app opens',
    ],
    con: [
      'Must load a model in GUI before API responds',
      'One active model at a time',
    ],
    install: 'https://lmstudio.ai  (free .dmg download)',
    flag: '--open-lmstudio',
  },
  {
    id: 'jan', name: 'Jan', col: C.bblu, port: 1337,
    app: 'Jan',
    desc: [
      'Lightweight desktop app (jan.ai) that keeps',
      'an API server running in the background.',
      'Good for an always-on model with low overhead.',
    ],
    pro: [
      'Runs quietly in the background',
      'API server auto-starts with the app',
      'Straightforward model library',
    ],
    con: [
      'Smaller model selection than LM Studio',
      'Must load a model in the GUI first',
    ],
    install: 'https://jan.ai  (free .dmg download)',
    flag: '--open-jan',
  },
  {
    id: 'llamacpp', name: 'llama.cpp', col: C.yel, port: 8082,
    needsPath: true,
    desc: [
      'Raw llama-server binary. Maximum control:',
      'set the exact GPU layer count to handle models',
      'larger than your VRAM with CPU offloading.',
    ],
    pro: [
      'Precise GPU/CPU layer split (--n-gpu-layers N)',
      'Works with any GGUF file you have locally',
      'CPU-only mode for models that exceed VRAM',
      'No extra abstraction — raw performance',
    ],
    con: [
      'You provide the GGUF file path manually',
      'No built-in model downloads or management',
    ],
    install: 'brew install llama.cpp',
    flag: '--start-llamacpp',
    scanDirs: [
      path.join(HOME, 'models'),
      path.join(HOME, '.cache', 'lm-studio', 'models'),
      path.join(HOME, 'Downloads'),
    ],
  },
  {
    id: 'openrouter', name: 'OpenRouter', col: C.byel, port: null,
    noToggle: true,
    desc: [
      'Cloud API gateway used as automatic fallback',
      'when no local model covers a tier. Free tier',
      'available. Add OPENROUTER_API_KEY to .env.',
    ],
    pro: [
      'Ensures no tier is ever empty (automatic fallback)',
      'Access to Gemini 2.5 Pro, DeepSeek R1, GPT-4o…',
      'Free tier on many models',
    ],
    con: [
      'Requires internet connection + API key',
      'Sends your prompts to OpenRouter servers',
    ],
    install: 'Get key: https://openrouter.ai/keys\nAdd to .env: OPENROUTER_API_KEY=sk-or-...',
  },
];

// ── State ─────────────────────────────────────────────────────────────────────

const S = {
  focus:   'left',   // 'left' | 'right'
  cursor:  0,        // selected provider index (left panel)
  rcursor: 0,        // cursor within right-panel list

  auto: Object.fromEntries(
    PROVIDERS.filter(p => !p.noToggle).map(p => [p.id, false])
  ),

  mlxModel:  '',     // chosen MLX model id; '' = first in list
  llamaPath: '',     // absolute path to chosen GGUF file
  llamaGpu:  0,      // GPU layers: -1=all GPU, 0=CPU only, N=N layers

  keepSrv:  false,
  backend:  'smart', // 'smart' | 'ollama' | 'anthropic'

  live: Object.fromEntries(
    PROVIDERS.map(p => [p.id, { run: false, ok: false, models: [], key: false }])
  ),

  ggufFiles: [],
  ready:     false,
};

// ── Discovery ─────────────────────────────────────────────────────────────────

function httpGet(url, ms = 1500) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: ms }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ ok: true, st: res.statusCode, body: d }));
    });
    req.on('error',   () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
  });
}

function hasBin(cmd) {
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
}
function hasApp(name) { return fs.existsSync(`/Applications/${name}.app`); }

function scanGgufs(dirs) {
  const out = [];
  function walk(dir, depth) {
    if (depth > 2 || !fs.existsSync(dir)) return;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isFile() && e.name.endsWith('.gguf')) out.push(p);
        else if (e.isDirectory() && depth < 2) walk(p, depth + 1);
      }
    } catch {}
  }
  dirs.forEach(d => walk(d, 0));
  return out.sort();
}

function readOrKey() {
  try {
    const env = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    for (const l of env.split('\n')) {
      const m = l.match(/^OPENROUTER_API_KEY\s*=\s*(.+)/);
      if (m) return m[1].trim();
    }
  } catch {}
  return process.env.OPENROUTER_API_KEY || '';
}

async function discover() {
  // Ollama
  const r0 = await httpGet('http://localhost:11434/api/tags');
  let om = [];
  if (r0.ok && r0.st === 200) {
    try {
      om = JSON.parse(r0.body).models.map(m => ({
        id: m.name, t: tierOf(m.name),
        gb: m.size ? +(m.size / 1e9).toFixed(1) : null,
        params: m.details?.parameter_size || '',
      }));
    } catch {}
  }
  S.live.ollama = { run: r0.ok && r0.st === 200, ok: hasBin('ollama'), models: om };

  // MLX
  const r1 = await httpGet('http://localhost:8080/v1/models');
  let mm = [];
  if (r1.ok && r1.st === 200) {
    try { mm = JSON.parse(r1.body).data.map(m => ({ id: m.id, t: tierOf(m.id) })); } catch {}
  }
  S.live.mlx = { run: r1.ok && r1.st === 200, ok: hasBin('mlx_lm.server'), models: mm };

  // OpenAI-compat providers
  for (const [id, url, appName, bin] of [
    ['lmstudio', 'http://localhost:1234', 'LM Studio', null],
    ['jan',      'http://localhost:1337', 'Jan',       null],
    ['llamacpp', 'http://localhost:8082', null,        'llama-server'],
  ]) {
    const r = await httpGet(`${url}/v1/models`);
    let ms = [];
    if (r.ok && r.st === 200) {
      try { ms = JSON.parse(r.body).data.map(m => ({ id: m.id, t: tierOf(m.id) })); } catch {}
    }
    const ok = appName ? hasApp(appName) : hasBin(bin);
    S.live[id] = { run: r.ok && r.st === 200, ok, models: ms };
  }

  // OpenRouter (no network check — just detect the key)
  S.live.openrouter = { run: false, ok: true, models: [], key: !!readOrKey() };

  // llama.cpp GGUF file scan
  const llp = PROVIDERS.find(p => p.id === 'llamacpp');
  S.ggufFiles = scanGgufs(llp.scanDirs);

  S.ready = true;
  render();
}

// ── Layout constants ──────────────────────────────────────────────────────────

const LEFT_W = 30;  // visible width of left panel

// ── Header ────────────────────────────────────────────────────────────────────

function buildHeader(cols) {
  const title  = ` ${C.b}${C.bwht}◆  CLAUDE CODE SMART LAUNCHER${C.rst}`;
  const hint   = ` ${C.dim}↑↓ navigate   L launch   Q quit ${C.rst}`;
  const tlen   = vlen(title), hlen = vlen(hint);
  if (tlen + hlen >= cols) return rpad(title, cols);
  return title + ' '.repeat(cols - tlen - hlen) + hint;
}

// ── Divider ───────────────────────────────────────────────────────────────────

function buildDivider(cols, chr = '─', junc = '┬') {
  return C.dim + chr.repeat(LEFT_W) + junc + chr.repeat(cols - LEFT_W - 1) + C.rst;
}

// ── Footer ────────────────────────────────────────────────────────────────────

function buildFooter(cols) {
  const p = PROVIDERS[S.cursor];
  let keys;
  if (S.focus === 'right') {
    const extra = p?.needsPath ? `   ${C.dim}+/- GPU layers${C.rst}` : '';
    keys = `${C.dim}↑↓ move   Enter select   Esc back${extra}${C.rst}`;
  } else {
    const canConf = p?.needsModel || (p?.needsPath && S.ggufFiles.length > 0);
    const conf    = canConf ? `   ${C.bwht}Enter${C.dim} configure` : '';
    keys = `${C.dim}↑↓ move   Space enable/disable${conf}   B backend   K keep-servers   L launch   Q quit${C.rst}`;
  }
  return rpad(` ${keys}`, cols);
}

// ── Left panel ────────────────────────────────────────────────────────────────

function buildLeft() {
  const lines = [];
  const push  = (s = '') => lines.push(s);

  push(`  ${C.b}${C.dim}PROVIDERS${C.rst}`);
  push('');

  PROVIDERS.forEach((p, i) => {
    const sel  = i === S.cursor && S.focus === 'left';
    const lv   = S.live[p.id];
    const auto = S.auto[p.id];

    const arrow = sel ? `${C.bwht}▶${C.rst}` : ' ';

    let tog;
    if (p.noToggle)  tog = '   ';
    else if (auto)   tog = `${C.bgrn}[✓]${C.rst}`;
    else             tog = `${C.dim}[ ]${C.rst}`;

    let dot;
    if (lv.run)     dot = `${C.bgrn}●${C.rst}`;
    else if (lv.ok) dot = `${C.yel}○${C.rst}`;
    else            dot = `${C.red}✗${C.rst}`;

    const name = `${sel ? C.b : ''}${p.col}${p.name}${C.rst}`;

    let ann = '';
    if (p.id === 'openrouter') {
      ann = lv.key ? `${C.grn}key ✓${C.rst}` : `${C.dim}no key${C.rst}`;
    } else if (lv.run && lv.models.length) {
      ann = `${C.dim}${lv.models.length} model${lv.models.length !== 1 ? 's' : ''}${C.rst}`;
    } else if (lv.run) {
      ann = `${C.dim}ready${C.rst}`;
    } else if (!lv.ok) {
      ann = `${C.red}not installed${C.rst}`;
    }

    push(` ${arrow} ${tog} ${dot} ${name}  ${ann}`);
  });

  push('');
  push(`  ${C.b}${C.dim}OPTIONS${C.rst}`);
  push('');

  const bc = { smart: C.cyn, ollama: C.grn, anthropic: C.bblu }[S.backend] || C.bwht;
  push(` ${C.dim}Backend :${C.rst}  ${bc}${S.backend}${C.rst} ${C.dim}(B)${C.rst}`);
  push(` ${C.dim}Keep srv:${C.rst}  ${S.keepSrv ? C.bgrn + 'yes' : C.dim + 'no '}${C.rst} ${C.dim}(K)${C.rst}`);

  if (S.auto.mlx) {
    const mid   = S.mlxModel || PROVIDERS.find(p => p.id === 'mlx')?.models?.[0]?.id || '';
    const short = mid.replace('mlx-community/', '');
    push('');
    push(` ${C.dim}MLX model:${C.rst}`);
    push(clip(`  ${C.cyn}${short}${C.rst}`, LEFT_W - 1));
  }

  if (S.auto.llamacpp && S.llamaPath) {
    const gl = S.llamaGpu === -1 ? 'all GPU' : S.llamaGpu === 0 ? 'CPU only' : `${S.llamaGpu} layers`;
    push('');
    push(` ${C.dim}GGUF:${C.rst}`);
    push(clip(`  ${C.yel}${path.basename(S.llamaPath)}${C.rst}`, LEFT_W - 1));
    push(` ${C.dim} gpu: ${C.rst}${C.yel}${gl}${C.rst}`);
  }

  push('');
  if (!S.ready) {
    push(` ${C.dim}discovering models…${C.rst}`);
  } else {
    // Summary of which tiers are covered across all running providers
    const allModels = Object.values(S.live).flatMap(l => l.models || []);
    const covered   = new Set(allModels.map(m => m.t));
    push(`  ${C.dim}${C.b}TIER COVERAGE${C.rst}`);
    for (const [t, label] of [['tiny','tiny'],['fast','fast'],['balanced','balanced'],['powerful','powerful'],['reasoning','reasoning']]) {
      const ok = covered.has(t);
      const tc = ok ? (TIER_C[t] || C.dim) : C.dim;
      const mark = ok ? `${C.bgrn}✓${C.rst}` : `${C.dim}—${C.rst}`;
      push(`  ${mark} ${tc}${label}${C.rst}`);
    }
  }

  return lines;
}

// ── Right panel ───────────────────────────────────────────────────────────────

function buildRight(rw) {
  const p     = PROVIDERS[S.cursor];
  const lv    = S.live[p.id];
  const lines = [];
  const push  = (s = '') => lines.push(s);
  const hr    = ()       => push(` ${C.dim}${'─'.repeat(rw - 2)}${C.rst}`);
  const sec   = title    => { push(''); push(`  ${C.b}${C.dim}${title}${C.rst}`); hr(); };
  const good  = s        => push(`   ${C.bgrn}✓${C.rst}  ${s}`);
  const bad   = s        => push(`   ${C.dim}✗  ${s}${C.rst}`);

  // ── Title ──────────────────────────────────────────────────────────────────
  push('');
  {
    const badge = (!p.noToggle && S.auto[p.id])
      ? `   ${C.bgrn}◆ will auto-start${C.rst}`
      : '';
    push(`  ${C.b}${p.col}${p.name}${C.rst}${badge}`);
  }
  push('');
  for (const line of p.desc) push(`  ${C.dim}${line}${C.rst}`);
  push('');
  hr();

  // ── Status line ────────────────────────────────────────────────────────────
  {
    let st;
    if (lv.run) {
      st = `${C.bgrn}● running${C.rst}`;
      if (lv.models.length) st += `  ${C.dim}· ${lv.models.length} model(s) active${C.rst}`;
    } else if (lv.ok || p.id === 'openrouter') {
      st = `${C.yel}○ not running${C.rst}`;
      if (!p.noToggle) st += `  ${C.dim}→ Space to enable auto-start${C.rst}`;
    } else {
      st = `${C.red}✗ not installed${C.rst}`;
    }
    push(`  Status  ${st}`);
  }

  // ── Ollama ─────────────────────────────────────────────────────────────────
  if (p.id === 'ollama') {
    if (lv.models.length) {
      sec('TIER COVERAGE  (currently loaded)');
      const byTier = {};
      for (const m of lv.models) if (!byTier[m.t]) byTier[m.t] = m;
      for (const t of ['tiny', 'fast', 'balanced', 'powerful', 'reasoning']) {
        const m  = byTier[t];
        const tc = TIER_C[t] || C.dim;
        if (m) {
          const gb = m.gb ? `${m.gb} GB` : '';
          push(` ${tc}  ${t.padEnd(11)}${C.rst}${m.id.padEnd(26)}  ${C.dim}${gb}${C.rst}`);
        } else {
          push(` ${C.dim}  ${t.padEnd(11)}— none${C.rst}`);
        }
      }
    }
    sec('SUGGESTED PULLS');
    for (const [cmd, note] of (p.suggest || [])) {
      push(`   ${C.grn}${cmd}${C.rst}`);
      push(`   ${C.dim}# ${note}${C.rst}`);
      push('');
    }
  }

  // ── MLX ────────────────────────────────────────────────────────────────────
  if (p.id === 'mlx') {
    if (lv.run && lv.models.length) {
      sec('ACTIVE MODEL');
      for (const m of lv.models) {
        push(`   ${C.bgrn}●${C.rst} ${m.id}   ${TIER_C[m.t] || C.dim}${m.t}${C.rst}`);
      }
    }

    const nav = S.focus === 'right'
      ? `  ${C.bwht}← navigating with ↑↓${C.rst}`
      : `  ${C.dim}(Enter to pick)${C.rst}`;
    sec(`MODEL SELECTION${nav}`);

    const opts    = p.models || [];
    const allOpts = [...opts, { id: '[ type a custom mlx-community/* model ]', t: '', gb: null, info: 'Set via FAST_MODEL=mlx:org/model env var' }];
    allOpts.forEach((m, idx) => {
      const sel    = S.focus === 'right' && idx === S.rcursor;
      const chosen = m.id === (S.mlxModel || opts[0]?.id);
      const arrow  = sel    ? `${C.bwht}›${C.rst}` : ' ';
      const check  = chosen ? `${C.bgrn}✓${C.rst}` : ' ';
      const tc     = TIER_C[m.t] || C.dim;
      const tierS  = m.t ? `${tc}${m.t.padEnd(11)}${C.rst}` : ' '.repeat(11);
      const gbS    = m.gb ? `${C.dim}${m.gb} GB${C.rst}` : '';
      push(`  ${arrow} ${check} ${clip(m.id, rw - 22)}  ${tierS}  ${gbS}`);
      if (sel && m.info) push(`         ${C.dim}↳ ${m.info}${C.rst}`);
    });

    if (!lv.ok) {
      push('');
      push(`  ${C.yel}Install:${C.rst}  ${C.dim}pip install mlx-lm${C.rst}`);
    }
  }

  // ── llama.cpp ──────────────────────────────────────────────────────────────
  if (p.id === 'llamacpp') {
    const nav = S.focus === 'right'
      ? `  ${C.bwht}← navigating with ↑↓${C.rst}`
      : `  ${C.dim}(Enter to pick)${C.rst}`;
    sec(`GGUF FILE${nav}`);

    if (S.ggufFiles.length === 0) {
      push(`  ${C.dim}No .gguf files found. Scanned:${C.rst}`);
      for (const d of (p.scanDirs || [])) push(`    ${C.dim}${d}${C.rst}`);
      push('');
      push(`  ${C.dim}Place .gguf files in ~/models/ and relaunch.${C.rst}`);
    } else {
      S.ggufFiles.forEach((f, idx) => {
        const sel    = S.focus === 'right' && idx === S.rcursor;
        const chosen = f === S.llamaPath;
        const arrow  = sel    ? `${C.bwht}›${C.rst}` : ' ';
        const check  = chosen ? `${C.bgrn}✓${C.rst}` : ' ';
        let sz = '';
        try { sz = `${C.dim}${+(fs.statSync(f).size / 1e9).toFixed(1)} GB${C.rst}`; } catch {}
        push(`  ${arrow} ${check} ${clip(path.basename(f), rw - 14)}  ${sz}`);
      });
    }

    if (S.llamaPath) {
      push('');
      const gl    = S.llamaGpu;
      const glStr = gl === -1 ? 'all layers on GPU (fastest if it fits)' : gl === 0 ? '0  —  CPU only' : `${gl} layers on GPU`;
      push(`  ${C.dim}GPU layers: ${C.rst}${C.yel}${glStr}${C.rst}  ${C.dim}(+/- to adjust)${C.rst}`);
      push(`  ${C.dim}-1 = full GPU   0 = CPU only   N = N layers offloaded${C.rst}`);
    }

    if (!lv.ok) {
      push('');
      push(`  ${C.yel}Install:${C.rst}  ${C.dim}brew install llama.cpp${C.rst}`);
    }
  }

  // ── LM Studio / Jan ────────────────────────────────────────────────────────
  if (p.id === 'lmstudio' || p.id === 'jan') {
    push('');
    if (!lv.ok) {
      push(`  ${C.yel}Not installed.${C.rst}`);
      for (const l of p.install.split('\n')) push(`    ${C.dim}${l}${C.rst}`);
    } else if (!lv.run) {
      push(`  ${C.dim}Installed but API not running.${C.rst}`);
      push(`  ${C.dim}Space → toggle auto-open, or launch ${p.app}${C.rst}`);
      push(`  ${C.dim}manually and load a model inside it.${C.rst}`);
    } else {
      push(`  ${C.dim}API is running. Load a model in the ${p.app}${C.rst}`);
      push(`  ${C.dim}GUI and the proxy will use it automatically.${C.rst}`);
      if (lv.models.length) {
        sec('ACTIVE MODELS');
        for (const m of lv.models) {
          const tc = TIER_C[m.t] || C.dim;
          push(`   ${C.bgrn}●${C.rst} ${clip(m.id, rw - 12)}   ${tc}${m.t}${C.rst}`);
        }
      }
    }
  }

  // ── OpenRouter ─────────────────────────────────────────────────────────────
  if (p.id === 'openrouter') {
    push('');
    if (lv.key) {
      push(`  ${C.bgrn}✓ API key detected — cloud fallback active${C.rst}`);
    } else {
      push(`  ${C.red}✗ No API key set${C.rst}`);
      push('');
      push(`  ${C.dim}1. Get a free key at:${C.rst}`);
      push(`       ${C.byel}https://openrouter.ai/keys${C.rst}`);
      push('');
      push(`  ${C.dim}2. Add it to ${path.join(REPO, '.env')}:${C.rst}`);
      push(`       ${C.dim}OPENROUTER_API_KEY=sk-or-...${C.rst}`);
    }

    sec('CLOUD FALLBACK MODELS  (auto-used per tier)');
    for (const [t, m, cost] of [
      ['tiny',      'meta-llama/llama-3.2-3b-instruct:free', 'free'],
      ['fast',      'meta-llama/llama-3.1-8b-instruct:free', 'free'],
      ['balanced',  'google/gemini-2.0-flash-001',           'low cost'],
      ['powerful',  'google/gemini-2.5-pro-preview',         'paid'],
      ['reasoning', 'deepseek/deepseek-r1',                  'low cost'],
    ]) {
      const tc = TIER_C[t] || C.dim;
      push(`  ${tc}${t.padEnd(11)}${C.rst}  ${C.dim}${m}   ${cost}${C.rst}`);
    }
  }

  // ── Strengths / weaknesses (all providers) ─────────────────────────────────
  sec('STRENGTHS & WEAKNESSES');
  for (const s of (p.pro || [])) good(s);
  push('');
  for (const w of (p.con || [])) bad(w);

  if (!lv.ok && p.install && !['openrouter', 'lmstudio', 'jan'].includes(p.id)) {
    sec('HOW TO INSTALL');
    for (const l of p.install.split('\n')) push(`   ${C.dim}${l}${C.rst}`);
  }

  return lines;
}

// ── Main render ───────────────────────────────────────────────────────────────

function render() {
  const cols  = process.stdout.columns || 110;
  const rows  = process.stdout.rows    || 30;
  const rw    = Math.max(cols - LEFT_W - 1, 20);
  const contH = rows - 4;   // 2 header lines + 2 footer lines

  const LL = buildLeft();
  const RL = buildRight(rw);

  // Build output lines
  const out = [
    buildHeader(cols),
    buildDivider(cols),
  ];

  for (let i = 0; i < contH; i++) {
    const left  = clip(rpad(LL[i] ?? '', LEFT_W), LEFT_W);
    const right = RL[i] ?? '';
    out.push(left + C.dim + '│' + C.rst + right);
  }

  out.push(buildDivider(cols, '─', '┴'));
  out.push(buildFooter(cols));

  // Write: home cursor, content (each line erased), then clear below
  process.stdout.write(
    C.home + out.map(l => l + C.eline).join('\n') + '\n\x1b[J'
  );
}

// ── Input ─────────────────────────────────────────────────────────────────────

function move(dir) {
  if (S.focus === 'left') {
    S.cursor  = Math.max(0, Math.min(PROVIDERS.length - 1, S.cursor + dir));
    S.rcursor = 0;
  } else {
    const p   = PROVIDERS[S.cursor];
    const max = p.needsModel
      ? (p.models?.length ?? 0)                    // +1 custom entry
      : Math.max(0, S.ggufFiles.length - 1);
    S.rcursor = Math.max(0, Math.min(max, S.rcursor + dir));
  }
  render();
}

function toggleAuto() {
  const p = PROVIDERS[S.cursor];
  if (!p || p.noToggle) return;
  S.auto[p.id] = !S.auto[p.id];
  render();
}

function enterRight() {
  const p = PROVIDERS[S.cursor];
  if (!p) return;
  const hasConf = p.needsModel || (p.needsPath && S.ggufFiles.length > 0);
  if (hasConf) { S.focus = 'right'; S.rcursor = 0; render(); }
}

function selectRight() {
  const p = PROVIDERS[S.cursor];
  if (p.needsModel) {
    const opts = p.models || [];
    if (S.rcursor < opts.length) S.mlxModel = opts[S.rcursor].id;
  } else if (p.needsPath) {
    if (S.ggufFiles[S.rcursor]) S.llamaPath = S.ggufFiles[S.rcursor];
  }
  S.focus = 'left';
  render();
}

function cycleBackend() {
  const order = ['smart', 'ollama', 'anthropic'];
  S.backend = order[(order.indexOf(S.backend) + 1) % order.length];
  render();
}

function adjustGpu(delta) {
  S.llamaGpu = Math.max(-1, Math.min(200, S.llamaGpu + delta));
  render();
}

function onKey(buf) {
  const k = buf.toString();

  if (k === '\x03') { restore(); process.exit(0); }  // Ctrl+C — always

  // Arrow keys (full escape sequence, checked before bare escape)
  if (k === '\x1b[A') { move(-1); return; }
  if (k === '\x1b[B') { move(+1); return; }

  // Bare escape = Esc key
  if (k === '\x1b') {
    if (S.focus === 'right') { S.focus = 'left'; render(); }
    return;
  }

  if (S.focus === 'left') {
    switch (k) {
      case ' ':        toggleAuto();    return;
      case '\r':
      case '\n':       enterRight();    return;
      case 'b': case 'B': cycleBackend(); return;
      case 'k': case 'K': S.keepSrv = !S.keepSrv; render(); return;
      case 'l': case 'L': launch();    return;
      case 'q': case 'Q': restore(); process.exit(0); return;
      case '+': case '=': if (PROVIDERS[S.cursor]?.id === 'llamacpp') adjustGpu(+1); return;
      case '-':           if (PROVIDERS[S.cursor]?.id === 'llamacpp') adjustGpu(-1); return;
    }
  } else {
    switch (k) {
      case '\r':
      case '\n': selectRight(); return;
      case '+': case '=': adjustGpu(+1); return;
      case '-':           adjustGpu(-1); return;
    }
  }
}

// ── Launch ────────────────────────────────────────────────────────────────────

function buildArgs() {
  const args = ['--no-ui'];  // always skip the UI when called from here
  if (S.backend !== 'smart') args.push('--backend', S.backend);
  if (S.auto.ollama)         args.push('--start-ollama');
  if (S.auto.mlx) {
    const m = S.mlxModel || PROVIDERS.find(p => p.id === 'mlx')?.models?.[0]?.id || '';
    if (m) args.push('--start-mlx', m);
  }
  if (S.auto.llamacpp && S.llamaPath) {
    const spec = S.llamaGpu !== 0 ? `${S.llamaPath}:${S.llamaGpu}` : S.llamaPath;
    args.push('--start-llamacpp', spec);
  }
  if (S.auto.lmstudio) args.push('--open-lmstudio');
  if (S.auto.jan)      args.push('--open-jan');
  if (S.keepSrv)       args.push('--keep-servers');
  return args;
}

function launch() {
  restore();
  const args   = buildArgs();
  const script = path.join(REPO, 'claude-local.sh');

  console.log(`\n${C.b}${C.bwht}◆ Claude Code Smart Launcher${C.rst}\n`);

  if (args.length) {
    console.log(`  ${C.dim}Flags:  ${args.join(' ')}${C.rst}`);
  } else {
    console.log(`  ${C.dim}Running with auto-detected providers (no auto-start flags)${C.rst}`);
  }
  console.log();

  spawnSync('bash', [script, ...args], { stdio: 'inherit' });
}

// ── Terminal setup / restore ──────────────────────────────────────────────────

function restore() {
  try { process.stdin.setRawMode(false); } catch {}
  process.stdout.write(C.show + C.norm);
}

function setup() {
  process.stdout.write(C.alt + C.hide + C.cls);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
  process.on('SIGWINCH', render);
  process.on('SIGINT', () => { restore(); process.exit(0); });
}

// ── Entry ─────────────────────────────────────────────────────────────────────

async function main() {
  setup();
  render();          // initial paint (shows "discovering…" badge)
  await discover();  // fills in live data, then calls render() again
}

main().catch(e => { restore(); console.error(e.message); process.exit(1); });
