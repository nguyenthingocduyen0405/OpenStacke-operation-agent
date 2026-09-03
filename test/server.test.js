const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const WEB_PORT = 32109;
const OLLAMA_PORT = 32110;
let mockOllama;
let app;

test.before(async () => {
  mockOllama = http.createServer(async (req, res) => {
    if (req.url === '/api/version') return json(res, { version: '0.30.0-test' });
    if (req.url === '/api/tags') return json(res, { models: [{ name: 'kanana-chat:latest', size: 123 }] });
    if (req.url === '/api/chat') {
      let requestBody = '';
      for await (const chunk of req) requestBody += chunk;
      const parsed = JSON.parse(requestBody);
      assert.equal(parsed.model, 'kanana-chat:latest');
      if (parsed.stream === false) {
        return json(res, { message: { role: 'assistant', content: 'Hello!' }, done: true });
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'Xin ' }, done: false })}\n`);
      res.end(`${JSON.stringify({ message: { role: 'assistant', content: 'chào!' }, done: true })}\n`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => mockOllama.listen(OLLAMA_PORT, '127.0.0.1', resolve));

  app = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(WEB_PORT),
      OLLAMA_URL: `http://127.0.0.1:${OLLAMA_PORT}`,
      JCLOUD_API_KEY: 'test-key'
    },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server khởi động quá lâu.')), 5000);
    app.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
    app.once('exit', (code) => reject(new Error(`Server dừng với mã ${code}.`)));
  });
});

test.after(async () => {
  app?.kill();
  await new Promise((resolve) => mockOllama.close(resolve));
});

test('phục vụ giao diện và trạng thái Ollama', async () => {
  const home = await fetch(`http://127.0.0.1:${WEB_PORT}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Kanana Local Chat/);

  const health = await fetch(`http://127.0.0.1:${WEB_PORT}/api/health`);
  assert.deepEqual(await health.json(), { ok: true, version: '0.30.0-test', defaultModel: 'kanana-chat' });
});

test('chuyển tiếp phản hồi chat dạng streaming', async () => {
  const response = await fetch(`http://127.0.0.1:${WEB_PORT}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kanana-chat:latest',
      messages: [{ role: 'user', content: 'Xin chào' }]
    })
  });
  assert.equal(response.status, 200);
  const chunks = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(chunks.map((chunk) => chunk.message.content).join(''), 'Xin chào!');
});

test('bảo vệ và liệt kê model qua OpenAI API', async () => {
  const unauthorized = await fetch(`http://127.0.0.1:${WEB_PORT}/v1/models`);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`http://127.0.0.1:${WEB_PORT}/v1/models`, {
    headers: { Authorization: 'Bearer test-key' }
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.object, 'list');
  assert.equal(result.data[0].id, 'kanana-chat');
});

test('trả lời OpenAI chat completion không streaming', async () => {
  const response = await openAIChat(false);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.object, 'chat.completion');
  assert.equal(result.choices[0].message.content, 'Hello!');
});

test('trả lời OpenAI chat completion dạng SSE', async () => {
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
      model: 'kanana-chat:latest',
      stream,
      messages: [{ role: 'user', content: 'Xin chào' }]
    })
  });
}

function json(res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
