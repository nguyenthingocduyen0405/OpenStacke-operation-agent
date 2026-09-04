const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const rag = require('./rag');
const llm = require('./llm');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_MODEL = llm.MODEL;
const OPENAI_API_KEY = process.env.JCLOUD_API_KEY || '';
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

function authorized(req) {
  if (!OPENAI_API_KEY) return true;
  const expected = Buffer.from(`Bearer ${OPENAI_API_KEY}`);
  const actual = Buffer.from(req.headers.authorization || '');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function normalizeMessages(value) {
  const messages = Array.isArray(value) ? value.slice(-30) : [];
  const valid = messages.length && messages.every((message) =>
    ['system', 'user', 'assistant'].includes(message?.role) &&
    typeof message.content === 'string' &&
    message.content.trim() && message.content.length <= 20_000
  );
  if (!valid) throw new Error('Invalid conversation messages.');
  return messages;
}

async function prepareConversation(messages) {
  let ragRows = [];
  let ragContext = '';
  try {
    const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    if (lastUserMessage) {
      ragRows = await rag.retrieve(lastUserMessage.content);
      ragContext = rag.buildContext(ragRows);
    }
  } catch (error) {
    console.error(`RAG retrieval skipped: ${error.message}`);
  }
  const systemContent = [
    '당신은 JCloud와 OpenStack 사용자를 돕는 AI 어시스턴트입니다. 기본적으로 모든 답변을 자연스럽고 명확한 한국어로 작성하세요. 사용자가 다른 언어를 명시적으로 요청한 경우에만 해당 언어를 사용하세요.',
    '검색된 문맥이 있으면 그 내용에 근거해 답하고, 사용한 정보 뒤에 [1], [2]처럼 출처 번호를 표시하세요. 문맥에 없는 사실은 추측하지 마세요. 현재 quota, VM 상태, IP, volume, image, flavor, security rule 같은 실시간 데이터는 이 지식 자료로 단정하지 말고 OpenStack API 확인이 필요하다고 안내하세요.',
    ragContext ? `다음은 내부 지식 자료에서 검색한 문맥입니다:\n\n${ragContext}` : '이번 요청과 관련해 검색된 내부 지식 자료가 없습니다.'
  ].join('\n\n');
  return { ragRows, messages: [{ role: 'system', content: systemContent }, ...messages] };
}

function sourceAppendix(rows) {
  if (!rows.length) return '';
  const sources = rows.map((row, index) => {
    const metadata = row.metadata || {};
    return `[${index + 1}] ${metadata.title || metadata.source_path || '내부 자료'} (${metadata.source_path || 'unknown'})`;
  });
  return `\n\n참고 자료:\n${sources.join('\n')}`;
}

function writeOpenAIChunk(res, id, model, delta, finishReason = null) {
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })}\n\n`);
}

function chatOptions(body, model, stream, signal) {
  return {
    model,
    profile: body.profile,
    stream,
    signal,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    top_k: body.top_k,
    repetition_penalty: body.repetition_penalty
  };
}

async function handleOpenAI(req, res, pathname) {
  if (!authorized(req)) {
    return sendJson(res, 401, {
      error: { message: 'Invalid API key.', type: 'authentication_error' }
    });
  }
  if (req.method === 'GET' && pathname === '/v1/models') {
    try {
      return sendJson(res, 200, await llm.models());
    } catch (error) {
      return sendJson(res, error.status || 502, {
        error: { message: error.message, type: 'upstream_error' }
      });
    }
  }
  if (req.method !== 'POST' || pathname !== '/v1/chat/completions') {
    return sendJson(res, 404, {
      error: { message: 'OpenAI-compatible endpoint not found.', type: 'invalid_request_error' }
    });
  }

  try {
    const body = await readJson(req);
    const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_MODEL;
    const prepared = await prepareConversation(normalizeMessages(body.messages));

    if (body.stream === false) {
      const upstream = await llm.chat(prepared.messages, chatOptions(body, model, false));
      const data = await upstream.json();
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error('LLM API returned an invalid message.');
      return sendJson(res, 200, {
        ...data,
        choices: [{
          ...data.choices[0],
          message: {
            ...message,
            content: `${message.content || ''}${sourceAppendix(prepared.ragRows)}`
          }
        }]
      });
    }

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    const upstream = await llm.chat(
      prepared.messages,
      chatOptions(body, model, true, controller.signal)
    );
    const id = `chatcmpl-${crypto.randomUUID()}`;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    writeOpenAIChunk(res, id, model, { role: 'assistant' });
    let finishReason = 'stop';
    for await (const event of llm.sseEvents(upstream.body)) {
      if (event === '[DONE]') continue;
      const data = JSON.parse(event);
      const choice = data.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (choice.delta && Object.keys(choice.delta).length) {
        writeOpenAIChunk(res, id, model, choice.delta);
      }
    }
    const appendix = sourceAppendix(prepared.ragRows);
    if (appendix) writeOpenAIChunk(res, id, model, { content: appendix });
    writeOpenAIChunk(res, id, model, {}, finishReason);
    res.write('data: [DONE]\n\n');
    return res.end();
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (!res.headersSent) {
      return sendJson(res, error.status || 502, {
        error: { message: error.message, type: 'server_error' }
      });
    }
    return res.end();
  }
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') {
    try {
      const data = await llm.health();
      return sendJson(res, 200, {
        ok: data.proxy === 'ok' && data.backend === 'ok' && data.ready_workers > 0,
        backend: data.backend,
        readyWorkers: data.ready_workers,
        defaultModel: DEFAULT_MODEL
      });
    } catch (error) {
      return sendJson(res, 503, {
        ok: false,
        error: `LLM API에 연결할 수 없습니다: ${error.message}`
      });
    }
  }

  if (req.method === 'GET' && pathname === '/api/models') {
    try {
      const data = await llm.models();
      return sendJson(res, 200, {
        models: (data.data || []).map(({ id, created }) => ({ name: id, created_at: created })),
        defaultModel: DEFAULT_MODEL
      });
    } catch (error) {
      return sendJson(res, 503, { error: `모델 목록을 가져올 수 없습니다: ${error.message}` });
    }
  }

  if (req.method === 'POST' && pathname === '/api/chat') {
    try {
      const body = await readJson(req);
      let messages;
      try {
        messages = normalizeMessages(body.messages);
      } catch {
        return sendJson(res, 400, { error: '대화 내용이 올바르지 않습니다.' });
      }

      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const prepared = await prepareConversation(messages);
      const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_MODEL;
      const upstream = await llm.chat(
        prepared.messages,
        chatOptions(body, model, true, controller.signal)
      );

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      for await (const event of llm.sseEvents(upstream.body)) {
        if (event === '[DONE]') continue;
        const data = JSON.parse(event);
        const content = data.choices?.[0]?.delta?.content;
        if (content) {
          res.write(`${JSON.stringify({
            model,
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content },
            done: false
          })}\n`);
        }
      }
      if (prepared.ragRows.length) {
        res.write(`${JSON.stringify({
          model,
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content: sourceAppendix(prepared.ragRows) },
          done: false
        })}\n`);
      }
      res.write(`${JSON.stringify({
        model,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: '' },
        done: true
      })}\n`);
      return res.end();
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (!res.headersSent) return sendJson(res, error.status || 502, { error: error.message });
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
    if (url.pathname.startsWith('/v1/')) return handleOpenAI(req, res, url.pathname);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url.pathname);
    if (req.method !== 'GET') return sendJson(res, 405, { error: '지원하지 않는 요청 방식입니다.' });
    return serveStatic(res, decodeURIComponent(url.pathname));
  } catch (error) {
    if (!res.headersSent) return sendJson(res, 400, { error: '올바르지 않은 요청입니다.' });
    return res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`JCloud Agent 실행 중: http://${HOST}:${PORT}`);
  console.log(`LLM API: ${llm.BASE_URL} | 기본 모델: ${DEFAULT_MODEL} | profile: ${llm.PROFILE}`);
});
