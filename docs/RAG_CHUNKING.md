# Content-aware RAG chunking

The ingestion script expects an already chunked JSONL corpus. Use the content
builder first when a source document contains multiple Markdown sections.

## Input

Store one source document per line. Every document needs `id`, `content`, and
`metadata.source_path`. Set `metadata.corpus_name` explicitly so every generated
record has the prefix required by the ingestion script.

```json
{"id":"nova-manage-servers","title":"Manage servers","content":"# Create server\nCreate a server from an image.\n\n## Delete server\nDeleting a server is permanent.","metadata":{"corpus_name":"openstack_official","corpus_version":"2026.1","openstack_release":"gazpacho","service":"nova","source_path":"nova/user/manage-servers","source_url":"https://docs.openstack.org/nova/2026.1/"}}
```

## Build and ingest

```powershell
npm run rag:build -- data/raw-documents.jsonl data/rag-chunks.jsonl
npm run rag:ingest -- data/rag-chunks.jsonl
```

With Docker Compose:

```powershell
docker compose exec jcloud-agent npm run rag:build -- /data/raw-documents.jsonl /data/rag-chunks.jsonl
docker compose exec jcloud-agent npm run rag:ingest -- /data/rag-chunks.jsonl
```

The builder splits Markdown at headings and paragraphs, carries the heading
path into every chunk, and falls back to sentence/word boundaries for long
prose. Fenced code blocks remain atomic even if they exceed the preferred
limit. Generated records include a deterministic ID and chunk provenance.

Defaults can be overridden with environment variables:

```dotenv
CHUNK_MAX_CHARS=2800
CHUNK_MIN_CHARS=300
CHUNK_OVERLAP_CHARS=300
```

To keep a short document such as one verified UI operation intact, set:

```json
{"metadata":{"chunk_policy":"preserve"}}
```

Changing chunk settings or source content requires rebuilding the JSONL and
running the normal ingestion again so embeddings stay aligned with the chunks.
