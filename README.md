# JCloud Qwen Agent

Chatbot hỗ trợ JCloud/OpenStack, sử dụng **Qwen3.8-27B qua API của phòng lab** để tạo câu trả lời. Dự án vẫn giữ Ollama cục bộ, nhưng chỉ dùng model `embeddinggemma` để tạo embedding cho RAG vì Qwen API hiện không cung cấp endpoint `/v1/embeddings`.

## Kiến trúc

```text
Browser / Open WebUI
        |
        v
Node.js JCloud Agent  --->  Qwen Chat API (114.70.193.174:9000)
        |
        +---> PostgreSQL + pgvector
        |
        +---> Ollama / embeddinggemma (chỉ embedding RAG)
```

Node.js agent cung cấp hai giao diện:

- `/api/chat`: NDJSON streaming cho giao diện web có sẵn.
- `/v1/chat/completions`: OpenAI-compatible API cho Open WebUI.

Agent tự thêm system prompt JCloud/OpenStack và ngữ cảnh lấy từ pgvector trước khi gửi yêu cầu tới Qwen. Các lỗi tạm thời `429`, `502`, `503` được retry với exponential backoff.

## Yêu cầu

- Docker Engine và Docker Compose.
- Máy chạy stack phải thuộc dải IP đã được máy chủ LLM cho phép.
- API key do quản trị viên cấp.

## Khởi động bằng Docker Compose

Sao chép cấu hình mẫu:

```bash
cp .env.example .env
```

Mở `.env` và thay ít nhất các giá trị sau:

```dotenv
LLM_API_KEY=your-issued-key
JCLOUD_API_KEY=your-private-open-webui-key
POSTGRES_PASSWORD=your-database-password
WEBUI_SECRET_KEY=your-webui-secret
```

Không đưa `.env` hoặc API key thật lên Git. Sau đó chạy:

```bash
docker compose up -d --build
docker compose ps
```

Mở Open WebUI tại <http://127.0.0.1:8080>. Lần chạy đầu tiên có thể lâu hơn vì Ollama cần tải `embeddinggemma`.

Nếu muốn Ollama dùng GPU cho phần embedding:

```bash
docker compose -f compose.yaml -f compose.gpu.yaml up -d --build
```

Qwen chat đã chạy trên GPU của máy chủ phòng lab; máy local không cần tải hoặc chạy Qwen.

## Chạy Node.js trực tiếp

Yêu cầu Node.js 20 trở lên. Thiết lập biến môi trường rồi chạy:

```powershell
$env:LLM_API_KEY = 'your-issued-key'
$env:LLM_BASE_URL = 'http://114.70.193.174:9000/v1'
$env:LLM_MODEL = 'qwen3.8-27b'
$env:LLM_PROFILE = 'ko-direct'
npm install
npm start
```

Mặc định ứng dụng mở tại <http://127.0.0.1:3000>. Không có `DATABASE_URL` thì chat vẫn hoạt động, chỉ bỏ qua RAG.

## Kiểm tra kết nối

Health endpoint của máy chủ không cần API key:

```bash
curl http://114.70.193.174:9000/health
```

Kiểm tra agent:

```bash
curl http://127.0.0.1:3000/api/health
```

Nếu bị timeout, kiểm tra mạng/IP whitelist. Nếu nhận `401`, kiểm tra `LLM_API_KEY`.

## RAG

Dữ liệu nguồn nằm trong `data/`. Sau khi stack đã chạy:

```bash
docker compose exec jcloud-agent npm run rag:ingest
```

Kiểm tra truy vấn:

```bash
docker compose exec jcloud-agent npm run rag:query -- "OpenStack instance"
```

## Biến môi trường chính

| Biến | Mặc định | Mục đích |
|---|---|---|
| `LLM_BASE_URL` | `http://114.70.193.174:9000/v1` | Base URL Qwen API |
| `LLM_API_KEY` | bắt buộc | Key gọi Qwen API |
| `LLM_MODEL` | `qwen3.8-27b` | Model chat |
| `LLM_PROFILE` | `ko-direct` | Profile tiếng Hàn, tắt thinking |
| `LLM_TIMEOUT_MS` | `300000` | Timeout cho request chat |
| `LLM_MAX_RETRIES` | `3` | Số lần retry lỗi tạm thời |
| `JCLOUD_API_KEY` | cấu hình riêng | Key giữa Open WebUI và Node.js agent |
| `OLLAMA_URL` | `http://ollama:11434` | Ollama dùng cho embedding |
| `OLLAMA_EMBED_MODEL` | `embeddinggemma` | Model embedding RAG |

`LLM_API_KEY` và `JCLOUD_API_KEY` có hai mục đích khác nhau và không nên dùng chung.

## Kiểm thử

```bash
npm test
npm run check
docker compose config
```

Bộ test dùng mock Qwen server, không gửi dữ liệu thật và không cần API key của phòng lab.

## Tệp quan trọng

- `llm.js`: Qwen API client, timeout, retry và parser SSE.
- `server.js`: web server, RAG prompt và adapter OpenAI/NDJSON.
- `rag.js`: pgvector retrieval và Ollama embedding.
- `compose.yaml`: Qwen agent, Open WebUI, pgvector và Ollama embedding.
- `.env.example`: cấu hình mẫu không chứa secret.

`Modelfile`, `setup-model.ps1` và một số tệp trong `deploy/` là quy trình Kanana cũ; chúng không được `compose.yaml` hiện tại sử dụng cho chat.
