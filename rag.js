const { Pool } = require('pg');

const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const EMBEDDING_MODEL = process.env.OLLAMA_EMBED_MODEL || 'embeddinggemma';
const DATABASE_URL = process.env.DATABASE_URL;

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, max: 5, idleTimeoutMillis: 30_000 })
  : null;

function vectorLiteral(vector) {
  if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Ollama가 올바른 임베딩 벡터를 반환하지 않았습니다.');
  }
  return `[${vector.join(',')}]`;
}

async function embed(input) {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`임베딩 생성 오류 ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.embeddings;
}

async function retrieve(query, limit = 4) {
  if (!pool) return [];
  const [embedding] = await embed(query);
  const result = await pool.query(
    `SELECT c.content, c.metadata,
            c.embedding <=> $1::vector AS vector_distance,
            ts_rank_cd(to_tsvector('simple', c.content), plainto_tsquery('simple', $2)) AS keyword_rank
       FROM rag.chunks c
       JOIN rag.documents d ON d.id = c.document_id
      WHERE d.status = 'indexed'
        AND c.embedding IS NOT NULL
        AND COALESCE(c.metadata->>'status', 'active') = 'active'
      ORDER BY (c.embedding <=> $1::vector)
               - LEAST(ts_rank_cd(to_tsvector('simple', c.content), plainto_tsquery('simple', $2)), 1) * 0.15
      LIMIT $3`,
    [vectorLiteral(embedding), query, limit]
  );
  return result.rows;
}

function buildContext(rows, maxChars = 8_000) {
  let context = '';
  for (const [index, row] of rows.entries()) {
    const metadata = row.metadata || {};
    const source = metadata.source_path || 'unknown';
    const title = metadata.title || source;
    const block = `[${index + 1}] 제목: ${title}\n출처: ${source}\n내용:\n${row.content}\n\n`;
    if (context && context.length + block.length > maxChars) break;
    context += block;
  }
  return context.trim();
}

async function close() {
  if (pool) await pool.end();
}

module.exports = { EMBEDDING_MODEL, buildContext, close, embed, retrieve, vectorLiteral };
