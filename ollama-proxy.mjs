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

  // Messages — handle text, tool_use, and tool_result blocks
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
      // user turn carrying tool results → Ollama "tool" role messages
      for (const tr of toolResults) {
        const content = typeof tr.content === 'string'
          ? tr.content
          : Array.isArray(tr.content)
            ? tr.content.map(b => b.text || '').join('\n')
            : JSON.stringify(tr.content ?? '');
        messages.push({ role: 'tool', content });
      }
      // any accompanying text goes as a separate user turn
      const txt = textBlocks.map(b => b.text || '').join('\n');
      if (txt) messages.push({ role: 'user', content: txt });
    } else if (toolUse.length > 0) {
      // assistant turn that called tools — Ollama expects tool_calls on the message
      const text = textBlocks.map(b => b.text || '').join('\n');
      messages.push({
        role: 'assistant',
        content: text || '',
        tool_calls: toolUse.map(tu => ({
          function: { name: tu.name, arguments: tu.input },
        })),
      });
    } else {
      const text = textBlocks.map(b => b.text || '').join('\n');
      if (text) messages.push({ role: msg.role, content: text });
    }
  }

  // Convert tools from Anthropic format → Ollama function format
  const tools = (body.tools || []).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));

  const result = {
    model: MODEL,
    messages,
    stream: false,
    options: { num_predict: body.max_tokens || 4096 },
  };
  if (tools.length > 0) result.tools = tools;
  return result;
}

let toolCallCounter = 0;

function convertOllamaToAnthropic(ollamaRes, requestModel) {
  const content = [];

  const text = ollamaRes.message?.content || '';
  if (text) content.push({ type: 'text', text });

  const toolCalls = ollamaRes.message?.tool_calls || [];
  for (const tc of toolCalls) {
    let input = tc.function?.arguments ?? {};
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { input = { raw: input }; }
    }
    content.push({
      type: 'tool_use',
      id: `toolu_${Date.now()}_${(++toolCallCounter).toString().padStart(4, '0')}`,
      name: tc.function?.name || 'unknown',
      input,
    });
  }

  return {
    id: 'msg_local_' + Date.now(),
    type: 'message',
    role: 'assistant',
    content,
    model: requestModel || 'claude-opus-4-6',
    stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
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
