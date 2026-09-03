# RAG data

Place the JSONL knowledge file here as `rag-chunks.jsonl`, then run:

```powershell
docker compose exec jcloud-agent npm run rag:ingest -- /data/rag-chunks.jsonl
```

The expected JSONL format is documented in the root README.
