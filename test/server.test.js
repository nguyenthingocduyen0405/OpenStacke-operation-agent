const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const WEB_PORT = 32109;
const LLM_PORT = 32110;
let mockLlm;
let app;

test.before(async () => {
  mockLlm = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      return json(res, {
        proxy: 'ok',
        backend: 'ok',
        ready_workers: 1,
        queue: { queued: 0, queue_max: 10, inflight: { local: 0 } }
      });
    }

    assert.equal(req.headers.authorization, 'Bearer upstream-test-key');
    if (req.url === '/v1/models') {
      return json(res, {
        object: 'list',
        data: [{ id: 'qwen3.8-27b', object: 'model', created: 0, owned_by: 'test' }]
      });
    }

    if (req.url === '/v1/chat/completions') {
      let requestBody = '';
      for await (const chunk of req) requestBody += chunk;
      const parsed = JSON.parse(requestBody);
      assert.equal(parsed.model, 'qwen3.8-27b');
      assert.equal(parsed.profile, 'ko-direct');
      assert.equal(parsed.messages[0].role, 'system');

      if (parsed.stream === false) {
        return json(res, {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          model: 'qwen3.8-27b',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }]
        });
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Xin ' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'chào!' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => mockLlm.listen(LLM_PORT, '127.0.0.1', resolve));

  app = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(WEB_PORT),
      DATABASE_URL: '',
      LLM_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
      LLM_HEALTH_URL: `http://127.0.0.1:${LLM_PORT}/health`,
      LLM_API_KEY: 'upstream-test-key',
      LLM_MODEL: 'qwen3.8-27b',
      LLM_PROFILE: 'ko-direct',
      LLM_MAX_RETRIES: '0',
      JCLOUD_API_KEY: 'test-key'
    },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timed out.')), 5000);
    app.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
    app.once('exit', (code) => reject(new Error(`Server exited with code ${code}.`)));
  });
});

test.after(async () => {
  app?.kill();
  await new Promise((resolve) => mockLlm.close(resolve));
});

test('serves the Qwen interface and upstream health', async () => {
  const home = await fetch(`http://127.0.0.1:${WEB_PORT}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /JCloud Qwen Chat/);

  const health = await fetch(`http://127.0.0.1:${WEB_PORT}/api/health`);
  assert.deepEqual(await health.json(), {
    ok: true,
    backend: 'ok',
    readyWorkers: 1,
    defaultModel: 'qwen3.8-27b'
  });
});

test('converts Qwen SSE to legacy NDJSON chat streaming', async () => {
  const response = await fetch(`http://127.0.0.1:${WEB_PORT}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3.8-27b',
      messages: [{ role: 'user', content: 'Xin chào' }]
    })
  });
  assert.equal(response.status, 200);
  const chunks = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(chunks.map((chunk) => chunk.message.content).join(''), 'Xin chào!');
  assert.equal(chunks.at(-1).done, true);
});

test('protects and proxies the OpenAI models endpoint', async () => {
  const unauthorized = await fetch(`http://127.0.0.1:${WEB_PORT}/v1/models`);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`http://127.0.0.1:${WEB_PORT}/v1/models`, {
    headers: { Authorization: 'Bearer test-key' }
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.object, 'list');
  assert.equal(result.data[0].id, 'qwen3.8-27b');
});

test('returns a non-streaming OpenAI chat completion', async () => {
  const response = await openAIChat(false);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.object, 'chat.completion');
  assert.equal(result.choices[0].message.content, 'Hello!');
});

test('returns an OpenAI-compatible SSE chat completion', async () => {
  const response = await openAIChat(true);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = (await response.text()).trim().split('\n\n');
  assert.equal(events.at(-1), 'data: [DONE]');
  const chunks = events.slice(0, -1).map((event) => JSON.parse(event.slice(6)));
  const content = chunks.map((chunk) => chunk.choices[0].delta.content || '').join('');
  assert.equal(content, 'Xin chào!');
});

function openAIChat(stream) {
  return fetch(`http://127.0.0.1:${WEB_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'qwen3.8-27b',
      stream,
      messages: [{ role: 'user', content: 'Xin chào' }]
    })
  });
}

function json(res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
