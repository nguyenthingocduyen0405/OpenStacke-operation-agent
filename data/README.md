# RAG data

The deployment uses two independent corpora:

- `rag-chunks.jsonl`: the original JCloud/OpenStack operational knowledge.
- `ui-actions.ko.jsonl`: Korean step-by-step UI actions. Each operation is one document with its own route, menu path, resource type, version, provenance, and verification status.

Ingest the original corpus:

```powershell
docker compose exec jcloud-agent npm run rag:ingest -- /data/rag-chunks.jsonl
```

Ingest the UI corpus without deleting the original corpus:

```powershell
docker compose exec jcloud-agent npm run rag:ingest -- /data/ui-actions.ko.jsonl
```

The UI corpus is based on Skyline Console commit
`afbd8ab93f113cd7a40fe1e3ad6e3174baa0cd41`, checked on 2026-09-04.
A record with `jcloud_verified: false` is an upstream reference and must not be
presented as a directly observed JCloud screen. Replace that status only after
checking the current JCloud UI.
