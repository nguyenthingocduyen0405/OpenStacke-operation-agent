'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildChunkRecords } = require('./content-chunker');

const inputPath = process.argv[2];
const outputPath = process.argv[3] || 'data/rag-chunks.jsonl';

if (!inputPath) {
  console.error('Usage: node scripts/build-corpus.js <raw-documents.jsonl> [rag-chunks.jsonl]');
  process.exit(2);
}

function readDocuments(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON at ${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

function main() {
  const documents = readDocuments(inputPath);
  if (!documents.length) throw new Error('Input corpus is empty.');

  const options = {
    maxChars: process.env.CHUNK_MAX_CHARS,
    minChars: process.env.CHUNK_MIN_CHARS,
    overlapChars: process.env.CHUNK_OVERLAP_CHARS
  };
  const records = documents.flatMap((document) => buildChunkRecords(document, options));

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  console.log(`Built ${records.length} chunks from ${documents.length} documents: ${outputPath}`);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
