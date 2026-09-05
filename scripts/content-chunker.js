'use strict';

const crypto = require('node:crypto');

const DEFAULT_OPTIONS = Object.freeze({ maxChars: 2800, minChars: 300, overlapChars: 300 });

function positiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function normalizeOptions(options = {}) {
  const normalized = {
    maxChars: positiveInteger(options.maxChars, DEFAULT_OPTIONS.maxChars, 'maxChars'),
    minChars: positiveInteger(options.minChars, DEFAULT_OPTIONS.minChars, 'minChars'),
    overlapChars: positiveInteger(options.overlapChars, DEFAULT_OPTIONS.overlapChars, 'overlapChars')
  };
  if (normalized.minChars > normalized.maxChars) throw new Error('minChars cannot be greater than maxChars.');
  if (normalized.overlapChars >= normalized.maxChars) throw new Error('overlapChars must be smaller than maxChars.');
  return normalized;
}

function splitBlocks(content) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let code = [];
  let inCode = false;

  function flushParagraph() {
    const text = paragraph.join('\n').trim();
    if (text) blocks.push({ type: 'content', text });
    paragraph = [];
  }

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (!inCode) {
        flushParagraph();
        inCode = true;
        code = [line];
      } else {
        code.push(line);
        blocks.push({ type: 'code', text: code.join('\n').trimEnd() });
        code = [];
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      flushParagraph();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  if (inCode && code.length) blocks.push({ type: 'code', text: code.join('\n').trimEnd() });
  flushParagraph();
  return blocks;
}

function splitLongPiece(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const sentences = text.split(/(?<=[.!?。！？])\s+/u).filter(Boolean);
  const pieces = [];
  let current = '';
  const pushCurrent = () => {
    if (current.trim()) pieces.push(current.trim());
    current = '';
  };

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      pushCurrent();
      const words = sentence.split(/\s+/u).filter(Boolean);
      let wordBuffer = '';
      for (const word of words) {
        if (wordBuffer && wordBuffer.length + word.length + 1 > maxChars) {
          pieces.push(wordBuffer);
          wordBuffer = '';
        }
        if (word.length > maxChars) {
          if (wordBuffer) pieces.push(wordBuffer);
          wordBuffer = '';
          for (let offset = 0; offset < word.length; offset += maxChars) pieces.push(word.slice(offset, offset + maxChars));
        } else {
          wordBuffer += `${wordBuffer ? ' ' : ''}${word}`;
        }
      }
      if (wordBuffer) pieces.push(wordBuffer);
      continue;
    }
    if (current && current.length + sentence.length + 1 > maxChars) pushCurrent();
    current += `${current ? ' ' : ''}${sentence}`;
  }
  pushCurrent();
  return pieces;
}

function renderChunk(sectionPath, parts) {
  const headings = sectionPath.map((heading, index) => `${'#'.repeat(Math.min(index + 1, 6))} ${heading}`).join('\n');
  return [headings, ...parts.map(({ text }) => text)].filter(Boolean).join('\n\n').trim();
}

function overlapParts(parts, overlapChars) {
  const selected = [];
  let length = 0;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part.type === 'code') break;
    const addition = part.text.length + (selected.length ? 2 : 0);
    if (length + addition > overlapChars) break;
    selected.unshift(part);
    length += addition;
  }
  return selected;
}

function chunkDocument(document, options = {}) {
  const settings = normalizeOptions(options);
  const content = document.content ?? document.text;
  if (typeof content !== 'string' || !content.trim()) throw new Error('Document content must be a non-empty string.');
  if (document.metadata?.chunk_policy === 'preserve') {
    return [{ text: content.trim(), sectionPath: [], oversized: content.trim().length > settings.maxChars }];
  }

  const blocks = splitBlocks(content);
  const headings = [];
  const chunks = [];
  let parts = [];
  function flush({ keepOverlap = false } = {}) {
    const text = renderChunk(headings.filter(Boolean), parts);
    if (!text) return;
    chunks.push({ text, sectionPath: headings.filter(Boolean), oversized: text.length > settings.maxChars });
    parts = keepOverlap ? overlapParts(parts, settings.overlapChars) : [];
  }

  for (const block of blocks) {
    if (block.type === 'heading') {
      if (parts.length) flush();
      headings.length = block.level;
      headings[block.level - 1] = block.text;
      continue;
    }
    const sectionPath = headings.filter(Boolean);
    const availableChars = Math.max(1, settings.maxChars - renderChunk(sectionPath, []).length - 2);
    const pieces = block.type === 'code' ? [block.text] : splitLongPiece(block.text, availableChars);
    for (const piece of pieces) {
      const part = { type: block.type, text: piece };
      if (parts.length && renderChunk(sectionPath, [...parts, part]).length > settings.maxChars) flush({ keepOverlap: true });
      parts.push(part);
    }
  }
  if (parts.length) flush();
  if (!chunks.length && headings.some(Boolean)) {
    chunks.push({ text: renderChunk(headings.filter(Boolean), []), sectionPath: headings.filter(Boolean), oversized: false });
  }
  return chunks;
}

function stableId(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function buildChunkRecords(document, options = {}) {
  if (!document?.id || !document.metadata?.source_path) throw new Error('Document requires id and metadata.source_path.');
  const corpusName = document.metadata.corpus_name || String(document.id).split('-')[0];
  if (!corpusName || !/^[a-z0-9][a-z0-9_-]*$/i.test(corpusName)) throw new Error('Document requires a safe metadata.corpus_name.');
  const chunks = chunkDocument(document, options);
  return chunks.map((chunk, index) => ({
    id: `${corpusName}-${document.id}-${stableId([document.id, chunk.sectionPath.join('/'), chunk.text].join('\n'))}`,
    text: chunk.text,
    metadata: {
      ...document.metadata,
      title: document.title || document.metadata.title,
      document_id: document.id,
      chunk_index: index,
      chunk_count: chunks.length,
      chunk_strategy: document.metadata.chunk_policy === 'preserve' ? 'preserve-v1' : 'content-aware-v1',
      section_path: chunk.sectionPath,
      character_count: chunk.text.length,
      oversized: chunk.oversized,
      status: document.metadata.status || 'active'
    }
  }));
}

module.exports = { DEFAULT_OPTIONS, buildChunkRecords, chunkDocument, normalizeOptions, splitBlocks, splitLongPiece };
