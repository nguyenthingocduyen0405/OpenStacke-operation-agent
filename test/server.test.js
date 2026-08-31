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
      OLLAMA_URL: `http://127.0.0.1:${OLLAMA_PORT}`
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

function json(res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
