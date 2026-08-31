#!/usr/bin/env bash
set -euo pipefail

source /etc/kanana-chat/database.env

RESULT=$(psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align \
  --command="SELECT current_user || '|' || current_database() || '|' || extversion FROM pg_extension WHERE extname = 'vector';")

if [[ "$RESULT" != kanana_app\|kanana_rag\|0.8.1 ]]; then
  echo "Database verification failed." >&2
  exit 1
fi

echo "Database login, schema access, and pgvector are ready."
