const messagesEl = document.querySelector('#messages');
const welcomeEl = document.querySelector('#welcome');
const form = document.querySelector('#chat-form');
const promptEl = document.querySelector('#prompt');
const sendButton = document.querySelector('#send');
const stopButton = document.querySelector('#stop');
const modelSelect = document.querySelector('#model-select');
const connectionEl = document.querySelector('#connection');
const mobileStatus = document.querySelector('#mobile-status');

let messages = [];
let controller = null;

function setConnection(state, text) {
  connectionEl.className = `connection ${state}`;
  connectionEl.querySelector('span').textContent = text;
  mobileStatus.className = `status-dot ${state}`;
  mobileStatus.title = text;
}

function setBusy(busy) {
  sendButton.classList.toggle('hidden', busy);
  stopButton.classList.toggle('hidden', !busy);
  promptEl.disabled = busy;
  modelSelect.disabled = busy;
}

function resizeTextarea() {
  promptEl.style.height = 'auto';
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 160)}px`;
}

function addMessage(role, content = '', extraClass = '') {
  welcomeEl?.classList.add('hidden');
  const article = document.createElement('article');
  article.className = `message ${role} ${extraClass}`.trim();
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? '나' : 'K';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content;
  article.append(avatar, bubble);
  messagesEl.append(article);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { article, bubble };
}

async function loadStatus() {
  try {
    const [healthResponse, modelsResponse] = await Promise.all([fetch('/api/health'), fetch('/api/models')]);
    const health = await healthResponse.json();
    if (!healthResponse.ok) throw new Error(health.error);
    setConnection('online', `Ollama ${health.version} 실행 중`);

    if (modelsResponse.ok) {
      const data = await modelsResponse.json();
      modelSelect.replaceChildren();
      const names = data.models.map((model) => model.name);
      if (!names.length) names.push(data.defaultModel);
      for (const name of names) {
        const option = document.createElement('option');
        option.value = option.textContent = name;
        modelSelect.append(option);
      }
      const exactDefault = names.find((name) => name === data.defaultModel || name.startsWith(`${data.defaultModel}:`));
      if (exactDefault) modelSelect.value = exactDefault;
    }
  } catch (error) {
    setConnection('offline', 'Ollama가 준비되지 않았습니다');
  }
}

async function sendMessage(text) {
  const content = text.trim();
  if (!content || controller) return;
  addMessage('user', content);
  messages.push({ role: 'user', content });
  promptEl.value = '';
  resizeTextarea();

  const responseMessage = addMessage('assistant', '', 'thinking');
  controller = new AbortController();
  setBusy(true);
  let assistantText = '';

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelSelect.value, messages }),
      signal: controller.signal
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Lỗi máy chủ (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = done ? '' : lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const data = JSON.parse(line);
        if (data.error) throw new Error(data.error);
        if (data.message?.content) {
          assistantText += data.message.content;
          assistantText = assistantText.replace(/<\|(?:eot_id|end_of_text)\|>/g, '');
          responseMessage.bubble.textContent = assistantText;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      }
      if (done) break;
    }
    if (!assistantText) throw new Error('모델이 응답을 반환하지 않았습니다.');
    messages.push({ role: 'assistant', content: assistantText });
  } catch (error) {
    if (error.name === 'AbortError') {
      responseMessage.bubble.textContent = assistantText || '답변 생성을 중지했습니다.';
      if (assistantText) messages.push({ role: 'assistant', content: assistantText });
    } else {
      responseMessage.article.classList.add('error');
      responseMessage.bubble.textContent = `응답할 수 없습니다: ${error.message}`;
      setConnection('offline', 'Ollama 호출 중 오류 발생');
    }
  } finally {
    responseMessage.article.classList.remove('thinking');
    controller = null;
    setBusy(false);
    promptEl.focus();
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage(promptEl.value);
});
promptEl.addEventListener('input', resizeTextarea);
promptEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});
stopButton.addEventListener('click', () => controller?.abort());
document.querySelector('#new-chat').addEventListener('click', () => {
  controller?.abort();
  messages = [];
  messagesEl.querySelectorAll('.message').forEach((element) => element.remove());
  welcomeEl.classList.remove('hidden');
  promptEl.focus();
});
document.querySelectorAll('[data-prompt]').forEach((button) => {
  button.addEventListener('click', () => sendMessage(button.dataset.prompt));
});

loadStatus();
promptEl.focus();
