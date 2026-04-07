// smart-proxy.mjs — Intelligent multi-provider routing proxy for Claude Code
//
// Auto-discovers models from Ollama and LM Studio, uses OpenRouter as optional
// cloud fallback, and routes each request to the best model for the task tier.
//
// Tier mapping (auto-detected from model name requested by Claude Code):
//   tiny      < 4B params   — simple terminal/bash queries (fast, cheap)
//   fast      7–9B params   — haiku-class quick tasks
//   balanced  14–30B        — sonnet-class general coding (default)
//   powerful  30B+          — opus-class complex tasks & large refactors
//   reasoning thinking-tuned — explicit thinking / planning mode
//
// Providers supported:
//   Ollama      local HTTP API  (default: http://localhost:11434)
//   LM Studio   OpenAI-compat  (default: http://localhost:1234)
//   OpenRouter  Anthropic-compat cloud fallback (needs OPENROUTER_API_KEY)
//
// Usage:
//   node smart-proxy.mjs
//   ANTHROPIC_BASE_URL=http://localhost:9090 node cli.js
//
// Env vars:
//   PROXY_PORT          Listen port            (default: 9090)
//   PROXY_LOG           Log file path          (default: /tmp/claude-smart-proxy.log)
//   OLLAMA_HOST         Ollama base URL        (default: http://localhost:11434)
//   LM_STUDIO_HOST      LM Studio base URL     (default: http://localhost:1234)
//   OPENROUTER_API_KEY  Optional cloud API key
//   TINY_MODEL          Override tiny tier     e.g. "ollama:llama3.2:3b" or bare "llama3.2:3b"
//   FAST_MODEL          Override fast tier
//   BALANCED_MODEL      Override balanced tier
//   POWERFUL_MODEL      Override powerful tier
//   REASONING_MODEL     Override reasoning tier

import http from 'http';
import https from 'https';
import fs from 'fs';

// ── Config ───────────────────────────────────────────────────────────────────

try {
  const env = fs.readFileSync(new URL('.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) {
      const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch {}

const PORT        = parseInt(process.env.PROXY_PORT) || 9090;
const LOG_FILE    = process.env.PROXY_LOG || '/tmp/claude-smart-proxy.log';
const OLLAMA_HOST = process.env.OLLAMA_HOST    || 'http://localhost:11434';
const LM_HOST     = process.env.LM_STUDIO_HOST || 'http://localhost:1234';
const OR_KEY      = process.env.OPENROUTER_API_KEY || '';

const OVERRIDES = {
  tiny:      process.env.TINY_MODEL,
  fast:      process.env.FAST_MODEL,
  balanced:  process.env.BALANCED_MODEL,
  powerful:  process.env.POWERFUL_MODEL,
  reasoning: process.env.REASONING_MODEL,
};

// ── Logging ──────────────────────────────────────────────────────────────────

fs.writeFileSync(LOG_FILE, `--- smart-proxy started ${new Date().toISOString()} ---\n`);

const C = {
  reset: '\x1b[0m', green: '\x1b[32m', cyan: '\x1b[36m',
  yellow: '\x1b[33m', magenta: '\x1b[35m', red: '\x1b[31m', dim: '\x1b[2m',
};

function log(color, tag, msg) {
  const line = `[${tag}] ${msg}`;
  console.log(`${color}${line}${C.reset}`);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ── Tier inference from model name ────────────────────────────────────────────

// Ordered — first match wins
const TIER_PATTERNS = [
  [/deepseek-r1|qwq|:r1\b|thinking/i,             'reasoning'],
  [/671b|70b|72b|llama3\.3|llama-3\.3/i,           'powerful'],
  [/30b|32b|33b|34b|qwen3-coder:30/i,              'powerful'],
  [/14b|15b|13b|12b|11b|nemo/i,                    'balanced'],
  [/coder.*(6|7|8)b|(6|7|8)b.*coder/i,             'fast'],
  [/6b|7b|8b|9b/i,                                 'fast'],
  [/3b|3\.8b|4b|phi3|gemma.?2b/i,                  'tiny'],
  [/1b|2b/i,                                        'tiny'],
];

function tierFromName(name) {
  for (const [pat, tier] of TIER_PATTERNS) {
    if (pat.test(name)) return tier;
  }
  return 'balanced';
}

// ── Provider discovery ────────────────────────────────────────────────────────

async function httpGet(url) {
  return new Promise((resolve, reject) => {
    (url.startsWith('https') ? https : http)
      .get(url, res => {
        const c = [];
        res.on('data', d => c.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
      })
      .on('error', reject);
  });
}

async function discoverOllama() {
  try {
    const { status, body } = await httpGet(`${OLLAMA_HOST}/api/tags`);
    if (status !== 200) return [];
    const { models = [] } = JSON.parse(body);
    return models.map(m => ({
      provider: 'ollama',
      id: m.name,
      label: m.name,
      tier: tierFromName(m.name),
      sizeGB: m.size ? +(m.size / 1e9).toFixed(1) : null,
    }));
  } catch { return []; }
}

async function discoverLMStudio() {
  try {
    const { status, body } = await httpGet(`${LM_HOST}/v1/models`);
    if (status !== 200) return [];
    const { data = [] } = JSON.parse(body);
    return data.map(m => ({
      provider: 'lmstudio',
      id: m.id,
      label: m.id,
      tier: tierFromName(m.id),
      sizeGB: null,
    }));
  } catch { return []; }
}

// Curated OpenRouter fallback models — good defaults for each tier
const OR_FALLBACKS = {
  tiny:      'meta-llama/llama-3.2-3b-instruct:free',
  fast:      'meta-llama/llama-3.1-8b-instruct:free',
  balanced:  'google/gemini-2.0-flash-001',
  powerful:  'google/gemini-2.5-pro-preview',
  reasoning: 'deepseek/deepseek-r1',
};

// ── Model registry ────────────────────────────────────────────────────────────

const TIERS = ['tiny', 'fast', 'balanced', 'powerful', 'reasoning'];
const TIER_FALLBACK_CHAIN = {
  tiny:      ['tiny', 'fast', 'balanced', 'powerful', 'reasoning'],
  fast:      ['fast', 'tiny', 'balanced', 'powerful', 'reasoning'],
  balanced:  ['balanced', 'fast', 'powerful', 'tiny', 'reasoning'],
  powerful:  ['powerful', 'balanced', 'reasoning', 'fast', 'tiny'],
  reasoning: ['reasoning', 'powerful', 'balanced', 'fast', 'tiny'],
};

let registry = Object.fromEntries(TIERS.map(t => [t, []]));
let discoveryDone = false;

async function rebuildRegistry() {
  const [ollamaModels, lmModels] = await Promise.all([discoverOllama(), discoverLMStudio()]);
  const newReg = Object.fromEntries(TIERS.map(t => [t, []]));

  for (const m of [...ollamaModels, ...lmModels]) {
    newReg[m.tier].push(m);
  }

  // OpenRouter as cloud fallback for each tier (only if key present)
  if (OR_KEY) {
    for (const tier of TIERS) {
      newReg[tier].push({
        provider: 'openrouter',
        id: OR_FALLBACKS[tier],
        label: `openrouter/${OR_FALLBACKS[tier]}`,
        tier,
        isFallback: true,
      });
    }
  }

  // Manual overrides go to front of each tier's list
  for (const [tier, override] of Object.entries(OVERRIDES)) {
    if (!override) continue;
    let provider = 'ollama', id = override;
    if (override.startsWith('openrouter:')) { provider = 'openrouter'; id = override.slice(11); }
    else if (override.startsWith('lmstudio:'))  { provider = 'lmstudio';   id = override.slice(9); }
    else if (override.startsWith('ollama:'))    { provider = 'ollama';     id = override.slice(7); }
    newReg[tier].unshift({ provider, id, label: `${provider}:${id}`, tier, isOverride: true });
  }

  registry = newReg;
  discoveryDone = true;

  log(C.cyan, 'REGISTRY', 'Model assignments:');
  for (const tier of TIERS) {
    if (registry[tier].length === 0) {
      log(C.dim, 'REGISTRY', `  ${tier.padEnd(10)} — none`);
    } else {
      for (const m of registry[tier]) {
        const sz  = m.sizeGB ? ` (${m.sizeGB}GB)` : '';
        const tag = m.isOverride ? ' [override]' : m.isFallback ? ' [cloud fallback]' : '';
        log(C.dim, 'REGISTRY', `  ${tier.padEnd(10)} → ${m.label}${sz}${tag}`);
      }
    }
  }
}

function bestModel(tier) {
  for (const t of TIER_FALLBACK_CHAIN[tier] || [tier]) {
    if (registry[t]?.length > 0) return registry[t][0];
  }
  return null;
}

// ── Request classification ────────────────────────────────────────────────────
//
// Claude Code signals the intended tier through its model field:
//   claude-haiku-*  → fast/tiny intent
//   claude-sonnet-* → balanced intent
//   claude-opus-*   → powerful intent
//   thinking: {type:"enabled"} → reasoning intent (plan mode)
//
// We also apply lightweight content heuristics for further differentiation.

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => b.text || '').join(' ');
  return '';
}

function classify(body) {
  const model = (body.model || '').toLowerCase();

  // Explicit thinking request → reasoning (plan mode / complex reasoning)
  if (body.thinking?.type === 'enabled' || body.thinking?.type === 'auto') return 'reasoning';

  // Claude Code's model tier signals
  if (model.includes('opus'))   return 'powerful';
  if (model.includes('sonnet')) return 'balanced';
  if (model.includes('haiku'))  return 'fast';

  // Content heuristics
  const sysText   = extractText(body.system);
  const firstUser = (body.messages || []).find(m => m.role === 'user');
  const userText  = extractText(firstUser?.content);
  const combined  = (sysText + ' ' + userText).toLowerCase();

  // Planning / architecture / large restructuring → powerful
  if (/\b(plan|architect|restructur|design system|high.level|migration|system overview|strategy)\b/.test(combined)) return 'powerful';

  // Simple one-shot shell commands → tiny (no reasoning needed)
  if (/^(ls|cd|pwd|git status|git log|echo|cat|which|ps|df|du|mkdir|touch|rm )\b/.test(userText.trim())) return 'tiny';

  // Very short requests with no tools → fast
  if (userText.length < 200 && (body.tools || []).length === 0) return 'fast';

  return 'balanced';
}

// ── Format translation: Anthropic → Ollama ────────────────────────────────────

function toOllama(body, modelId) {
  const messages = [];

  if (body.system) {
    const t = extractText(body.system);
    if (t) messages.push({ role: 'system', content: t });
  }

  for (const msg of (body.messages || [])) {
    if (typeof msg.content === 'string') {
      if (msg.content) messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const toolResults = msg.content.filter(b => b.type === 'tool_result');
    const textBlocks  = msg.content.filter(b => b.type === 'text');
    const toolUse     = msg.content.filter(b => b.type === 'tool_use');

    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        const c = typeof tr.content === 'string' ? tr.content
          : Array.isArray(tr.content) ? tr.content.map(b => b.text || '').join('\n')
          : JSON.stringify(tr.content ?? '');
        messages.push({ role: 'tool', content: c });
      }
      const txt = textBlocks.map(b => b.text || '').join('\n');
      if (txt) messages.push({ role: 'user', content: txt });
    } else if (toolUse.length > 0) {
      messages.push({
        role: 'assistant',
        content: textBlocks.map(b => b.text || '').join('\n') || '',
        tool_calls: toolUse.map(tu => ({ function: { name: tu.name, arguments: tu.input } })),
      });
    } else {
      const text = textBlocks.map(b => b.text || '').join('\n');
      if (text) messages.push({ role: msg.role, content: text });
    }
  }

  const tools = (body.tools || []).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));

  const out = {
    model: modelId,
    messages,
    stream: false,  // force non-streaming; response converted to Anthropic JSON
    options: { num_predict: body.max_tokens || 4096 },
  };
  if (tools.length > 0) out.tools = tools;
  return out;
}

// ── Format translation: Anthropic → OpenAI (LM Studio) ───────────────────────

function toOpenAI(body, modelId) {
  const messages = [];

  if (body.system) {
    const t = extractText(body.system);
    if (t) messages.push({ role: 'system', content: t });
  }

  for (const msg of (body.messages || [])) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const toolResults = msg.content.filter(b => b.type === 'tool_result');
    const textBlocks  = msg.content.filter(b => b.type === 'text');
    const toolUse     = msg.content.filter(b => b.type === 'tool_use');

    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        const c = typeof tr.content === 'string' ? tr.content
          : Array.isArray(tr.content) ? tr.content.map(b => b.text || '').join('\n')
          : JSON.stringify(tr.content ?? '');
        // Reuse Anthropic tool_use_id as OpenAI tool_call_id (format is not enforced)
        messages.push({ role: 'tool', tool_call_id: tr.tool_use_id || 'unknown', content: c });
      }
      const txt = textBlocks.map(b => b.text || '').join('\n');
      if (txt) messages.push({ role: 'user', content: txt });
    } else if (toolUse.length > 0) {
      messages.push({
        role: 'assistant',
        content: textBlocks.map(b => b.text || '').join('\n') || null,
        tool_calls: toolUse.map(tu => ({
          id: tu.id,  // pass through Anthropic ID — OpenAI doesn't enforce format
          type: 'function',
          function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
        })),
      });
    } else {
      const text = textBlocks.map(b => b.text || '').join('\n');
      if (text) messages.push({ role: msg.role, content: text });
    }
  }

  const tools = (body.tools || []).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));

  const out = {
    model: modelId,
    messages,
    max_tokens: body.max_tokens || 4096,
    stream: false,
  };
  if (tools.length > 0) { out.tools = tools; out.tool_choice = 'auto'; }
  return out;
}

// ── Sanitize Anthropic body for OpenRouter passthrough ────────────────────────
// OpenRouter's /api/v1/messages is Anthropic-compatible but rejects a few
// Claude-specific extension fields.

function sanitizeForOR(body, modelId) {
  const b = JSON.parse(JSON.stringify(body));
  b.model = modelId;
  for (const k of ['betas', 'metadata', 'speed', 'output_config', 'context_management', 'thinking']) {
    delete b[k];
  }

  const stripCC = blk => {
    if (typeof blk === 'object' && blk?.cache_control) {
      const { cache_control, ...rest } = blk;
      return rest;
    }
    return blk;
  };

  if (Array.isArray(b.system)) b.system = b.system.map(stripCC);
  if (Array.isArray(b.messages)) {
    for (const m of b.messages) {
      if (Array.isArray(m.content)) m.content = m.content.map(stripCC);
    }
  }
  if (Array.isArray(b.tools)) {
    b.tools = b.tools.map(({ cache_control, defer_loading, eager_input_streaming, strict, ...rest }) => rest);
  }
  if (typeof b.tool_choice === 'string') b.tool_choice = { type: b.tool_choice };
  return b;
}

// ── Response translation ──────────────────────────────────────────────────────

let tcCounter = 0;

function fromOllama(res, origModel) {
  const content = [];
  if (res.message?.content) content.push({ type: 'text', text: res.message.content });

  for (const tc of (res.message?.tool_calls || [])) {
    let input = tc.function?.arguments ?? {};
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { input = { raw: input }; }
    }
    content.push({
      type: 'tool_use',
      id: `toolu_${Date.now()}_${(++tcCounter).toString().padStart(4, '0')}`,
      name: tc.function?.name || 'unknown',
      input,
    });
  }

  return {
    id: 'msg_local_' + Date.now(),
    type: 'message',
    role: 'assistant',
    content,
    model: origModel || 'claude-opus-4-6',
    stop_reason: content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: res.prompt_eval_count || 0,
      output_tokens: res.eval_count || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function fromOpenAI(res, origModel) {
  const choice = res.choices?.[0];
  const msg = choice?.message;
  const content = [];

  if (msg?.content) content.push({ type: 'text', text: msg.content });

  for (const tc of (msg?.tool_calls || [])) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = { raw: tc.function?.arguments }; }
    content.push({
      type: 'tool_use',
      id: tc.id || `toolu_${Date.now()}_${(++tcCounter).toString().padStart(4, '0')}`,
      name: tc.function?.name || 'unknown',
      input,
    });
  }

  return {
    id: 'msg_local_' + Date.now(),
    type: 'message',
    role: 'assistant',
    content,
    model: origModel || 'claude-opus-4-6',
    stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens || 0,
      output_tokens: res.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// ── Provider callers ──────────────────────────────────────────────────────────

function postHTTP(url, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const opts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    };
    const req = (isHttps ? https : http).request(opts, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function callOllama(entry, body) {
  const payload = JSON.stringify(toOllama(body, entry.id));
  const { status, body: raw } = await postHTTP(`${OLLAMA_HOST}/api/chat`, payload);
  if (status !== 200) throw new Error(`Ollama HTTP ${status}: ${raw.slice(0, 300)}`);
  const ollamaRes = JSON.parse(raw);
  return {
    anthropic: fromOllama(ollamaRes, body.model),
    tokIn: ollamaRes.prompt_eval_count || 0,
    tokOut: ollamaRes.eval_count || 0,
    durationSec: ((ollamaRes.total_duration || 0) / 1e9).toFixed(1),
  };
}

async function callLMStudio(entry, body) {
  const payload = JSON.stringify(toOpenAI(body, entry.id));
  const { status, body: raw } = await postHTTP(`${LM_HOST}/v1/chat/completions`, payload);
  if (status !== 200) throw new Error(`LM Studio HTTP ${status}: ${raw.slice(0, 300)}`);
  const openAIRes = JSON.parse(raw);
  return {
    anthropic: fromOpenAI(openAIRes, body.model),
    tokIn: openAIRes.usage?.prompt_tokens || 0,
    tokOut: openAIRes.usage?.completion_tokens || 0,
    durationSec: null,
  };
}

// OpenRouter supports the Anthropic Messages API natively, so we pass through
// and pipe the upstream response directly (supports streaming).
function callOpenRouter(entry, body) {
  return new Promise((resolve, reject) => {
    const sanitized = sanitizeForOR(body, entry.id);
    const payload = JSON.stringify(sanitized);
    const req = https.request(
      {
        hostname: 'openrouter.ai',
        port: 443,
        path: '/api/v1/messages',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${OR_KEY}`,
          'anthropic-version': '2023-06-01',
          'content-length': Buffer.byteLength(payload),
          'http-referer': 'https://github.com/claude-code-anymodel',
          'x-title': 'Claude Code Smart Proxy',
        },
      },
      upstream => resolve(upstream),
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────

const stats = { requests: 0, byTier: {}, byProvider: {}, tokIn: 0, tokOut: 0 };

function bumpStats(tier, provider, tokIn, tokOut) {
  stats.requests++;
  stats.byTier[tier]         = (stats.byTier[tier]         || 0) + 1;
  stats.byProvider[provider] = (stats.byProvider[provider] || 0) + 1;
  stats.tokIn  += tokIn;
  stats.tokOut += tokOut;
  const line = `req=${stats.requests} | ${tier} → ${provider} | in=${stats.tokIn} out=${stats.tokOut} tok`;
  try { fs.writeFileSync(LOG_FILE + '.status', line); } catch {}
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

async function handleMessages(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  await new Promise(r => req.on('end', r));

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request', message: 'Invalid JSON' } }));
    return;
  }

  const tier  = classify(body);
  const entry = bestModel(tier);

  log(C.cyan, 'ROUTE', `${body.model} → tier=${tier} → ${entry ? entry.label : 'NO MODEL AVAILABLE'}`);

  if (!entry) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        type: 'service_unavailable',
        message: `No model available for tier '${tier}'. Start Ollama/LM Studio or add OPENROUTER_API_KEY.`,
      },
    }));
    return;
  }

  const t0 = Date.now();
  try {
    if (entry.provider === 'ollama') {
      const { anthropic, tokIn, tokOut, durationSec } = await callOllama(entry, body);
      const elapsed = durationSec ?? ((Date.now() - t0) / 1000).toFixed(1);
      log(C.green, 'OLLAMA', `← ${tokOut} tok out · ${tokIn} tok in · ${elapsed}s`);
      bumpStats(tier, 'ollama', tokIn, tokOut);
      const rb = JSON.stringify(anthropic);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(rb) });
      res.end(rb);

    } else if (entry.provider === 'lmstudio') {
      const { anthropic, tokIn, tokOut } = await callLMStudio(entry, body);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      log(C.magenta, 'LMSTUDIO', `← ${tokOut} tok out · ${tokIn} tok in · ${elapsed}s`);
      bumpStats(tier, 'lmstudio', tokIn, tokOut);
      const rb = JSON.stringify(anthropic);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(rb) });
      res.end(rb);

    } else if (entry.provider === 'openrouter') {
      const upstream = await callOpenRouter(entry, body);
      log(C.yellow, 'OPENROUTER', `← ${upstream.statusCode} (${entry.id})`);
      bumpStats(tier, 'openrouter', 0, 0);
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
    }

  } catch (e) {
    log(C.red, 'ERROR', `${entry.provider} failed: ${e.message}`);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'proxy_error', message: e.message } }));
  }
}

function proxyToAnthropic(req, res) {
  const bufs = [];
  req.on('data', c => bufs.push(c));
  req.on('end', () => {
    const opts = {
      hostname: 'api.anthropic.com', port: 443,
      path: req.url, method: req.method,
      headers: { ...req.headers, host: 'api.anthropic.com' },
    };
    const pr = https.request(opts, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    pr.on('error', e => { res.writeHead(502); res.end(e.message); });
    if (bufs.length) pr.write(Buffer.concat(bufs));
    pr.end();
  });
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/v1/messages')) {
    handleMessages(req, res);
  } else if (req.url === '/proxy/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stats, registry, discoveryDone }, null, 2));
  } else {
    log(C.yellow, 'PASSTHROUGH', `${req.method} ${req.url}`);
    proxyToAnthropic(req, res);
  }
});

server.listen(PORT, async () => {
  console.log(`\n${C.cyan}◆ Smart Model Proxy${C.reset} on :${PORT}`);
  console.log(`  Discovering local models...`);
  await rebuildRegistry();

  const ollamaCount = Object.values(registry).flat().filter(m => m.provider === 'ollama' && !m.isFallback).length;
  const lmCount     = Object.values(registry).flat().filter(m => m.provider === 'lmstudio' && !m.isFallback).length;

  console.log(`\n  ${C.dim}Providers:${C.reset}`);
  console.log(`    Ollama     ${ollamaCount > 0 ? C.green + '✓' : C.red + '✗'}${C.reset}  ${ollamaCount} model(s) at ${OLLAMA_HOST}`);
  console.log(`    LM Studio  ${lmCount > 0     ? C.green + '✓' : C.red + '✗'}${C.reset}  ${lmCount} model(s) at ${LM_HOST}`);
  console.log(`    OpenRouter ${OR_KEY           ? C.green + '✓' : C.red + '✗'}${C.reset}  ${OR_KEY ? 'API key present (cloud fallback)' : 'no key — set OPENROUTER_API_KEY for cloud fallback'}`);

  console.log(`\n  ${C.dim}Routing:${C.reset}`);
  console.log(`    haiku  → fast tier    (7–9B, quick tasks)`);
  console.log(`    sonnet → balanced     (14–30B, general coding)`);
  console.log(`    opus   → powerful     (30B+, complex work)`);
  console.log(`    thinking enabled → reasoning (plan mode)`);

  console.log(`\n  ${C.dim}Status:${C.reset}  GET http://localhost:${PORT}/proxy/status`);
  console.log(`  ${C.dim}Logs:${C.reset}    ${LOG_FILE}`);
  console.log(`\n  ${C.cyan}Run:${C.reset} ANTHROPIC_BASE_URL=http://localhost:${PORT} node cli.js\n`);

  // Refresh model list every 5 minutes (handles models added/removed while running)
  setInterval(rebuildRegistry, 5 * 60 * 1000);
});
