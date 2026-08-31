const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const rag = require('./rag');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'kanana-chat';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('요청 크기가 너무 큽니다.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function ollamaJson(endpoint, options = {}) {
  const response = await fetch(`${OLLAMA_URL}${endpoint}`, {
    ...options,
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Ollama 오류 ${response.status}.`);
  return response.json();
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') {
    try {
      const data = await ollamaJson('/api/version');
      return sendJson(res, 200, { ok: true, version: data.version, defaultModel: DEFAULT_MODEL });
    } catch (error) {
      return sendJson(res, 503, { ok: false, error: `${OLLAMA_URL}의 Ollama에 연결할 수 없습니다.` });
    }
  }

  if (req.method === 'GET' && pathname === '/api/models') {
    try {
      const data = await ollamaJson('/api/tags');
      return sendJson(res, 200, {
        models: (data.models || []).map(({ name, size, modified_at }) => ({ name, size, modified_at })),
        defaultModel: DEFAULT_MODEL
      });
    } catch (error) {
      return sendJson(res, 503, { error: `모델 목록을 가져올 수 없습니다: ${error.message}` });
    }
  }

  if (req.method === 'POST' && pathname === '/api/chat') {
    try {
      const body = await readJson(req);
      const messages = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
      const valid = messages.length && messages.every((message) =>
        ['user', 'assistant'].includes(message?.role) &&
        typeof message.content === 'string' &&
        message.content.trim() && message.content.length <= 20000
      );
      if (!valid) return sendJson(res, 400, { error: '대화 내용이 올바르지 않습니다.' });

      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      let ragContext = '';
      try {
        const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
        if (lastUserMessage) ragContext = rag.buildContext(await rag.retrieve(lastUserMessage.content));
      } catch (error) {
        console.error(`RAG retrieval skipped: ${error.message}`);
      }

      const systemContent = [
        '당신은 JCloud와 OpenStack 사용자를 돕는 AI 어시스턴트입니다. 기본적으로 모든 답변을 자연스럽고 명확한 한국어로 작성하세요. 사용자가 다른 언어를 명시적으로 요청한 경우에만 해당 언어를 사용하세요.',
        '검색된 문맥이 있으면 그 내용에 근거해 답하고, 사용한 정보 뒤에 [1], [2]처럼 출처 번호를 표시하세요. 문맥에 없는 사실은 추측하지 마세요. 현재 quota, VM 상태, IP, volume, image, flavor, security rule 같은 실시간 데이터는 이 지식 자료로 단정하지 말고 OpenStack API 확인이 필요하다고 안내하세요.',
        ragContext ? `다음은 내부 지식 자료에서 검색한 문맥입니다:\n\n${ragContext}` : '이번 요청과 관련해 검색된 내부 지식 자료가 없습니다.'
      ].join('\n\n');

      const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: typeof body.model === 'string' && body.model ? body.model : DEFAULT_MODEL,
          messages: [
            {
              role: 'system',
              content: systemContent
            },
            ...messages
          ],
          stream: true,
          options: { temperature: 0.7, num_ctx: 4096 }
        }),
        signal: controller.signal
      });

      if (!upstream.ok) {
        const detail = await upstream.text();
        return sendJson(res, upstream.status, { error: detail || `Ollama 오류 ${upstream.status}.` });
      }

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      for await (const chunk of upstream.body) res.write(chunk);
      return res.end();
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (!res.headersSent) return sendJson(res, 502, { error: error.message });
      return res.end();
    }
  }

  return sendJson(res, 404, { error: 'API를 찾을 수 없습니다.' });
}

function serveStatic(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return sendJson(res, 403, { error: '접근이 거부되었습니다.' });
  fs.readFile(filePath, (error, data) => {
    if (error) return sendJson(res, error.code === 'ENOENT' ? 404 : 500, { error: '페이지를 찾을 수 없습니다.' });
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url.pathname);
    if (req.method !== 'GET') return sendJson(res, 405, { error: '지원하지 않는 요청 방식입니다.' });
    return serveStatic(res, decodeURIComponent(url.pathname));
  } catch (error) {
    if (!res.headersSent) return sendJson(res, 400, { error: '올바르지 않은 요청입니다.' });
    return res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Kanana Chat 실행 중: http://${HOST}:${PORT}`);
  console.log(`Ollama API: ${OLLAMA_URL} | 기본 모델: ${DEFAULT_MODEL}`);
});
