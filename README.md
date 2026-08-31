# Kanana Local Chat

Chatbot web tối giản, chạy hoàn toàn trên máy cá nhân với Ollama và **Kanana 1.5 2.1B Instruct Q4_K_M**.

## Yêu cầu

- Windows 10/11, macOS hoặc Linux
- Node.js 18.17 trở lên
- Ollama 0.30 trở lên (khuyến nghị để có độ tương thích GGUF tốt)
- Khoảng 2 GB dung lượng trống; RAM 4 GB trở lên (khuyến nghị 8 GB)

## Cài đặt nhanh trên Windows

1. Tải và cài [Ollama](https://ollama.com/download), sau đó mở lại PowerShell.
2. Trong thư mục dự án, tải và tạo model:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\setup-model.ps1
   ```

3. Khởi động web:

   ```powershell
   npm install
   node server.js
   ```

4. Mở <http://127.0.0.1:3000>.

## Cài model thủ công

Tải model và tạo cấu hình bằng Ollama:

```powershell
ollama pull hf.co/joey51/kanana-1.5-2.1b-instruct-2505-Q4_K_M-GGUF:latest
ollama create kanana-chat -f Modelfile
ollama run kanana-chat
```

Nhấn `Ctrl+C` sau khi thử model, rồi chạy `node server.js`. Ứng dụng sẽ gọi Ollama tại `http://127.0.0.1:11434`.

## Cấu hình tùy chọn

```powershell
$env:PORT = '8080'
$env:OLLAMA_URL = 'http://127.0.0.1:11434'
$env:OLLAMA_MODEL = 'kanana-chat'
node server.js
```

## RAG với PostgreSQL/pgvector

Ứng dụng tự bật RAG khi có `DATABASE_URL`. Model chat Kanana chỉ tạo câu trả lời; `embeddinggemma` được dùng riêng để tạo và tìm vector đa ngôn ngữ.

```powershell
ollama pull embeddinggemma
$env:DATABASE_URL = 'postgresql://kanana_app:password@127.0.0.1:5432/kanana_rag'
$env:OLLAMA_EMBED_MODEL = 'embeddinggemma'
npm run rag:ingest -- .\rag-chunks.jsonl
npm run rag:query -- 'JCloud에서 인스턴스를 만드는 방법'
node server.js
```

Truy hồi kết hợp cosine distance của pgvector với full-text keyword score. Nếu database hoặc embedding tạm thời lỗi, chat vẫn hoạt động nhưng bỏ qua ngữ cảnh RAG. Các câu hỏi về trạng thái VM, quota, IP và tài nguyên hiện tại phải lấy từ OpenStack API thay vì corpus.

## Cấu trúc

- `server.js`: máy chủ web và proxy streaming tới Ollama
- `rag.js`: embedding và truy hồi lai từ PostgreSQL/pgvector
- `scripts/ingest-rag.js`: import JSONL vào vector database
- `scripts/query-rag.js`: kiểm tra kết quả retrieval từ dòng lệnh
- `public/`: giao diện chatbot responsive
- `Modelfile`: cấu hình Kanana cho Ollama
- `setup-model.ps1`: tải GGUF và tạo model tự động trên Windows

Lưu ý: Kanana chủ yếu được huấn luyện cho tiếng Hàn và tiếng Anh. Model vẫn có thể trả lời tiếng Việt, nhưng chất lượng tiếng Việt có thể không bằng các model đa ngôn ngữ chuyên biệt.

## Triển khai trên VM

Thư mục `deploy` chứa service `systemd` và cấu hình Caddy mẫu. Ollama và ứng dụng Node.js chỉ lắng nghe trên localhost; Caddy là điểm truy cập HTTPS công khai.

Do cổng 80/443 của OpenStack đang bị chặn, triển khai hiện dùng Cloudflare Quick Tunnel. `vercel.json` chuyển tiếp URL Vercel tới tunnel HTTPS đang hoạt động. Quick Tunnel phù hợp cho thử nghiệm; production nên chuyển sang Cloudflare Named Tunnel có tên miền ổn định.
