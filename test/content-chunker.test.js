'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChunkRecords, chunkDocument, splitBlocks } = require('../scripts/content-chunker');

function document(content, metadata = {}) {
  return {
    id: 'nova-manage-servers',
    title: 'Manage servers',
    content,
    metadata: {
      corpus_name: 'openstack_official',
      corpus_version: '2026.1',
      source_path: 'nova/user/manage-servers',
      ...metadata
    }
  };
}

test('splits Markdown at section boundaries and keeps heading context', () => {
  const chunks = chunkDocument(document([
    '# Compute',
    'Introductory text.',
    '',
    '## Create server',
    'Create the server from an image and flavor.',
    '',
    '## Delete server',
    'Deleting a server is permanent.'
  ].join('\n')), { maxChars: 500, minChars: 20, overlapChars: 50 });

  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[1].sectionPath, ['Compute', 'Create server']);
  assert.match(chunks[1].text, /^# Compute\n## Create server/m);
  assert.doesNotMatch(chunks[1].text, /Deleting a server/);
});

test('keeps fenced code blocks intact', () => {
  const source = [
    '# CLI',
    'Run this command:',
    '',
    '```bash',
    'openstack server create --image ubuntu --flavor small web-01',
    '```',
    '',
    'Verify the server status.'
  ].join('\n');
  const blocks = splitBlocks(source);
  const code = blocks.find(({ type }) => type === 'code');
  assert.equal(code.text, [
    '```bash',
    'openstack server create --image ubuntu --flavor small web-01',
    '```'
  ].join('\n'));

  const chunks = chunkDocument(document(source), { maxChars: 100, minChars: 20, overlapChars: 20 });
  assert.ok(chunks.some(({ text }) => text.includes(code.text)));
});

test('splits oversized prose while retaining section metadata', () => {
  const prose = Array.from({ length: 30 }, (_, index) => `Sentence ${index} explains scheduling behavior.`).join(' ');
  const chunks = chunkDocument(document(`# Scheduler\n\n${prose}`), {
    maxChars: 220,
    minChars: 20,
    overlapChars: 60
  });

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.deepEqual(chunk.sectionPath, ['Scheduler']);
    assert.match(chunk.text, /^# Scheduler/);
    assert.ok(chunk.text.length <= 220);
  }
});

test('preserve policy keeps a UI operation as one chunk', () => {
  const chunks = chunkDocument(document('# Create instance\n\nChoose an image and network.', {
    chunk_policy: 'preserve'
  }), { maxChars: 20, minChars: 10, overlapChars: 5 });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].oversized, true);
});

test('builds deterministic ingest records with corpus prefix and provenance', () => {
  const source = document('# Compute\n\nCreate a server.', { openstack_release: 'gazpacho' });
  const first = buildChunkRecords(source, { maxChars: 500, minChars: 20, overlapChars: 50 });
  const second = buildChunkRecords(source, { maxChars: 500, minChars: 20, overlapChars: 50 });

  assert.deepEqual(first, second);
  assert.match(first[0].id, /^openstack_official-/);
  assert.equal(first[0].metadata.chunk_strategy, 'content-aware-v1');
  assert.deepEqual(first[0].metadata.section_path, ['Compute']);
  assert.equal(first[0].metadata.openstack_release, 'gazpacho');
});
