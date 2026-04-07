// Direct Anthropic-to-Ollama proxy for Claude Code
// Routes /v1/messages → Ollama (format translation)
// Routes everything else → api.anthropic.com (passthrough)
import http from 'http';
import https from 'https';
import fs from 'fs';

const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen3-coder:30b';
const PORT = parseInt(process.env.PROXY_PORT) || 9090;
const LOG_FILE = process.env.OLLAMA_LOG || '/tmp/claude-ollama.log';

// Stats tracked across requests
const stats = { requests: 0, totalTokens: 0, lastLine: '' };

// Clear log on startup, write header
fs.writeFileSync(LOG_FILE, `--- ollama proxy started: ${new Date().toISOString()} model=${MODEL} ---\n`);

function logLine(line) {
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function convertAnthropicToOllama(body) {
  const messages = [];

  // System prompt
  if (body.system) {
    const sysText = typeof body.system === 'string'
      ? body.system
      : body.system.map(b => b.text || '').join('\n');
    messages.push({ role: 'system', content: sysText });
  }

  // Messages
  for (const msg of (body.messages || [])) {
    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map(b => b.text || '').filter(Boolean).join('\n');
    }
    if (content) {
      messages.push({ role: msg.role, content });
    }
  }

  return {
    model: MODEL,
    messages,
    stream: false,
    options: { num_predict: body.max_tokens || 4096 },
  };
}

function convertOllamaToAnthropic(ollamaRes, requestModel) {
  const text = ollamaRes.message?.content || '';
  return {
    id: 'msg_local_' + Date.now(),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: requestModel || 'claude-opus-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: ollamaRes.prompt_eval_count || 0,
      output_tokens: ollamaRes.eval_count || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function proxyToAnthropic(req, res) {
  let body = [];
  req.on('data', c => body.push(c));
  req.on('end', () => {
    const opts = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: 'api.anthropic.com' },
    };
    const pr = https.request(opts, pr2 => {
      res.writeHead(pr2.statusCode, pr2.headers);
      pr2.pipe(res);
    });
    pr.on('error', e => { res.writeHead(502); res.end(e.message); });
    if (body.length) pr.write(Buffer.concat(body));
    pr.end();
  });
}

function handleMessages(req, res) {
  let body = [];
  req.on('data', c => body.push(c));
  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(body).toString());
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }

    const requestModel = parsed.model;
    stats.requests++;
    const reqLine = `[OLLAMA] ${req.method} ${req.url} model=${requestModel} stream=${parsed.stream}`;
    console.log(`\x1b[32m${reqLine}\x1b[0m`);
    logLine(reqLine);

    // Force non-streaming (simpler translation)
    const ollamaBody = convertAnthropicToOllama(parsed);
    const payload = JSON.stringify(ollamaBody);

    const ollamaReq = http.request(
      `${OLLAMA}/api/chat`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      ollamaRes => {
        let data = [];
        ollamaRes.on('data', c => data.push(c));
        ollamaRes.on('end', () => {
          try {
            const ollamaResult = JSON.parse(Buffer.concat(data).toString());
            const anthropicResponse = convertOllamaToAnthropic(ollamaResult, requestModel);
            const respBody = JSON.stringify(anthropicResponse);
            const tokens = ollamaResult.eval_count || 0;
            const secs = ((ollamaResult.total_duration || 0) / 1e9).toFixed(1);
            stats.totalTokens += tokens;
            stats.lastLine = `← ${tokens} tok · ${secs}s · ${stats.requests} req · ${stats.totalTokens} total tok`;
            const statLine = `[OLLAMA] ← ${tokens} tokens, ${secs}s`;
            console.log(`\x1b[32m${statLine}\x1b[0m`);
            logLine(statLine);
            fs.writeFileSync(LOG_FILE + '.status', stats.lastLine);
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(respBody),
            });
            res.end(respBody);
          } catch (e) {
            const errLine = `[OLLAMA] Parse error: ${e.message}`;
            console.error(errLine);
            logLine(errLine);
            res.writeHead(500);
            res.end('Ollama response parse error');
          }
        });
      },
    );
    ollamaReq.on('error', e => {
      const errLine = `[OLLAMA] Connection error: ${e.code} ${e.message || '(no message)'}`;
      console.error(errLine, e);
      logLine(errLine);
      res.writeHead(502);
      res.end('Ollama connection error: ' + (e.message || e.code || String(e)));
    });
    ollamaReq.write(payload);
    ollamaReq.end();
  });
}

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/v1/messages')) {
    handleMessages(req, res);
  } else {
    console.log(`\x1b[33m[ANTHROPIC]\x1b[0m ${req.method} ${req.url}`);
    proxyToAnthropic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`\n🔀 Ollama proxy on :${PORT}`);
  console.log(`   /v1/messages → Ollama ${MODEL} (Anthropic format translation)`);
  console.log(`   everything else → api.anthropic.com\n`);
});
