const fs = require('node:fs');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { EMBEDDING_MODEL, embed, vectorLiteral } = require('../rag');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/ingest-rag.js <rag-chunks.jsonl>');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

function readRecords(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      const record = JSON.parse(line);
      if (!record.id || !record.text || !record.metadata?.source_path) {
        throw new Error(`Invalid record at line ${index + 1}.`);
      }
      return record;
    });
}

async function main() {
  const records = readRecords(inputPath);
  const corpusName = records[0]?.metadata?.corpus_name || records[0]?.id.split('-')[0];
  if (!corpusName || !/^[a-z0-9][a-z0-9_-]*$/i.test(corpusName)) {
    throw new Error('Unable to determine a safe corpus name.');
  }
  if (records.some((record) => !record.id.startsWith(`${corpusName}-`))) {
    throw new Error(`All record IDs must use the ${corpusName}- prefix.`);
  }
  console.log(`Embedding ${records.length} chunks with ${EMBEDDING_MODEL}...`);

  const embeddings = [];
  for (let offset = 0; offset < records.length; offset += 8) {
    const batch = records.slice(offset, offset + 8);
    const vectors = await embed(batch.map((record) => record.text));
    if (!Array.isArray(vectors) || vectors.length !== batch.length) {
      throw new Error(`Embedding count mismatch at batch ${offset}.`);
    }
    embeddings.push(...vectors);
  }
  const dimension = embeddings[0]?.length;
  if (!dimension || embeddings.some((vector) => vector.length !== dimension)) {
    throw new Error('Embedding dimensions are missing or inconsistent.');
  }

  const grouped = new Map();
  records.forEach((record, index) => {
    const key = record.metadata.source_path;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ record, embedding: embeddings[index] });
  });

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [sourcePath, items] of grouped) {
      const sha256 = crypto.createHash('sha256')
        .update(items.map(({ record }) => record.text).join('\n'))
        .digest('hex');
      const documentMetadata = {
        corpus_name: corpusName,
        title: items[0].record.metadata.title,
        corpus_version: items[0].record.metadata.corpus_version,
        source_path: sourcePath,
        embedding_model: EMBEDDING_MODEL,
        embedding_dimension: dimension
      };
      const existing = await client.query(
        'SELECT id FROM rag.documents WHERE source_name = $1 ORDER BY created_at DESC LIMIT 1',
        [sourcePath]
      );
      let documentId;
      if (existing.rowCount) {
        documentId = existing.rows[0].id;
        await client.query(
          `UPDATE rag.documents
              SET sha256 = $2, mime_type = 'text/markdown', status = 'pending',
                  metadata = $3::jsonb, updated_at = now()
            WHERE id = $1`,
          [documentId, sha256, JSON.stringify(documentMetadata)]
        );
        await client.query('DELETE FROM rag.chunks WHERE document_id = $1', [documentId]);
      } else {
        const inserted = await client.query(
          `INSERT INTO rag.documents (source_name, mime_type, sha256, status, metadata)
           VALUES ($1, 'text/markdown', $2, 'pending', $3::jsonb)
           RETURNING id`,
          [sourcePath, sha256, JSON.stringify(documentMetadata)]
        );
        documentId = inserted.rows[0].id;
      }

      for (const [index, item] of items.entries()) {
        const metadata = { ...item.record.metadata, corpus_chunk_id: item.record.id };
        await client.query(
          `INSERT INTO rag.chunks (document_id, chunk_index, content, embedding, metadata)
           VALUES ($1, $2, $3, $4::vector, $5::jsonb)`,
          [documentId, index, item.record.text, vectorLiteral(item.embedding), JSON.stringify(metadata)]
        );
      }
      await client.query("UPDATE rag.documents SET status = 'indexed', updated_at = now() WHERE id = $1", [documentId]);
    }
    const sourcePaths = [...grouped.keys()];
    const removed = await client.query(
      `DELETE FROM rag.documents d
        WHERE NOT (d.source_name = ANY($2::text[]))
          AND (
            d.metadata->>'corpus_name' = $1
            OR EXISTS (
              SELECT 1 FROM rag.chunks c
               WHERE c.document_id = d.id
                 AND c.metadata->>'corpus_chunk_id' LIKE $3
            )
          )`,
      [corpusName, sourcePaths, `${corpusName}-%`]
    );
    await client.query('COMMIT');
    console.log(`Indexed ${records.length} chunks from ${grouped.size} documents (${dimension} dimensions); removed ${removed.rowCount} obsolete documents.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
