'use strict';

const BASE_URL = (process.env.LLM_BASE_URL || 'http://114.70.193.174:9000/v1').replace(/\/$/, '');
const HEALTH_URL = process.env.LLM_HEALTH_URL || BASE_URL.replace(/\/v1$/, '') + '/health';
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'qwen3.8-27b';
const PROFILE = process.env.LLM_PROFILE || 'ko-direct';
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 300000);
const MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES || 3);
const RETRYABLE_STATUS = new Set([429, 502, 503]);

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
  });
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get('retry-after'));
  return Number.isFinite(retryAfter) && retryAfter >= 0
    ? retryAfter * 1000
    : 1000 * (2 ** attempt);
}

async function request(url, options = {}, { timeout = TIMEOUT_MS, retries = MAX_RETRIES } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    try {
      const timeoutSignal = AbortSignal.timeout(timeout);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;
      response = await fetch(url, { ...options, signal });
      if (response.ok) return response;

      const detail = await response.text();
      const error = new Error(`LLM API error ${response.status}: ${detail || response.statusText}`);
      error.status = response.status;
      if (!RETRYABLE_STATUS.has(response.status) || attempt === retries) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw error;
      if (error.status && !RETRYABLE_STATUS.has(error.status)) throw error;
      if (attempt === retries) throw error;
    }
    await delay(retryDelay(response, attempt), options.signal);
  }
  throw lastError;
}

function authHeaders(headers = {}) {
  if (!API_KEY) throw new Error('LLM_API_KEY is not configured.');
  return { ...headers, Authorization: `Bearer ${API_KEY}` };
}

async function health() {
  const response = await request(HEALTH_URL, { method: 'GET' }, { timeout: 30000, retries: 1 });
  return response.json();
}

async function models() {
  const response = await request(`${BASE_URL}/models`, {
    method: 'GET',
    headers: authHeaders()
  }, { timeout: 30000, retries: 1 });
  return response.json();
}

async function chat(messages, options = {}) {
  const body = {
    model: options.model || MODEL,
    profile: options.profile || PROFILE,
    messages,
    stream: options.stream !== false
  };
  for (const key of ['max_tokens', 'temperature', 'top_p', 'top_k', 'repetition_penalty']) {
    if (options[key] !== undefined) body[key] = options[key];
  }
  return request(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: options.signal
  });
}

async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    const events = buffer.split('\n\n');
    buffer = events.pop();
    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data) yield data;
      }
    }
  }
  buffer += decoder.decode();
  for (const line of buffer.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data) yield data;
  }
}

module.exports = {
  BASE_URL,
  HEALTH_URL,
  MODEL,
  PROFILE,
  chat,
  health,
  models,
  request,
  sseEvents
};
