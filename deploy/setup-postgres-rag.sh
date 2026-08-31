#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y postgresql postgresql-contrib postgresql-18-pgvector openssl

if [[ ! -f /swapfile ]]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
fi
if ! swapon --show=NAME --noheadings | grep -qx '/swapfile'; then
  swapon /swapfile
fi
if ! grep -qF '/swapfile none swap sw 0 0' /etc/fstab; then
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

systemctl enable --now postgresql

install -d -o root -g ubuntu -m 0750 /etc/kanana-chat
if [[ ! -f /etc/kanana-chat/database.env ]]; then
  DB_PASSWORD=$(openssl rand -hex 24)
  umask 0027
  printf 'DATABASE_URL=postgresql://kanana_app:%s@127.0.0.1:5432/kanana_rag\n' "$DB_PASSWORD" \
    > /etc/kanana-chat/database.env
  chown root:ubuntu /etc/kanana-chat/database.env
  chmod 0640 /etc/kanana-chat/database.env
else
  DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' /etc/kanana-chat/database.env)
  DB_PASSWORD=${DATABASE_URL#postgresql://kanana_app:}
  DB_PASSWORD=${DB_PASSWORD%@127.0.0.1:5432/kanana_rag}
fi

sudo -u postgres psql --set=ON_ERROR_STOP=1 --set=app_password="$DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE kanana_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kanana_app') \gexec
ALTER ROLE kanana_app PASSWORD :'app_password';
ALTER ROLE kanana_app CONNECTION LIMIT 20;
SELECT 'CREATE DATABASE kanana_rag OWNER kanana_app'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'kanana_rag') \gexec
REVOKE ALL ON DATABASE kanana_rag FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE kanana_rag TO kanana_app;
ALTER ROLE kanana_app IN DATABASE kanana_rag SET search_path = rag, public;
ALTER SYSTEM SET listen_addresses = '127.0.0.1';
ALTER SYSTEM SET max_connections = '50';
ALTER SYSTEM SET shared_buffers = '512MB';
ALTER SYSTEM SET effective_cache_size = '2GB';
ALTER SYSTEM SET work_mem = '8MB';
ALTER SYSTEM SET maintenance_work_mem = '256MB';
SQL

sudo -u postgres psql --set=ON_ERROR_STOP=1 --dbname=kanana_rag <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS rag AUTHORIZATION kanana_app;

SET ROLE kanana_app;
CREATE TABLE IF NOT EXISTS rag.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name text NOT NULL,
  mime_type text,
  sha256 text UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'indexed', 'failed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rag.chunks (
  id bigserial PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES rag.documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL,
  token_count integer CHECK (token_count IS NULL OR token_count >= 0),
  embedding vector,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON rag.chunks(document_id);
CREATE INDEX IF NOT EXISTS chunks_content_fts_idx
  ON rag.chunks USING gin (to_tsvector('simple', content));
RESET ROLE;
SQL

systemctl restart postgresql
echo "PostgreSQL RAG database is ready."
