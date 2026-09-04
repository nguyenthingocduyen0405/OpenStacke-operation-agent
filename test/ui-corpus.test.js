const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const corpusPath = path.resolve(__dirname, '../data/ui-actions.ko.jsonl');
const records = fs.readFileSync(corpusPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

test('UI corpus has valid, independent action records', () => {
  assert.equal(records.length, 12);
  assert.equal(new Set(records.map(({ id }) => id)).size, records.length);

  const allowedStatuses = new Set(['partially-jcloud-observed', 'upstream-reference']);
  for (const record of records) {
    assert.match(record.id, /^jcloud_ui-/);
    assert.ok(record.text.length > 100);
    assert.equal(record.metadata.corpus_name, 'jcloud_ui');
    assert.equal(record.metadata.corpus_version, '2.0.0');
    assert.equal(record.metadata.ui_language, 'ko-KR');
    assert.match(record.metadata.upstream_commit, /^[0-9a-f]{40}$/);
    assert.ok(record.metadata.source_path);
    assert.ok(record.metadata.route.startsWith('/'));
    assert.ok(record.metadata.resource_type);
    assert.ok(record.metadata.action);
    assert.ok(Array.isArray(record.metadata.menu_path));
    assert.ok(record.metadata.menu_path.length >= 2);
    assert.ok(Array.isArray(record.metadata.upstream_sources));
    assert.ok(record.metadata.upstream_sources.length >= 1);
    assert.ok(allowedStatuses.has(record.metadata.verification_status));
  }
});

test('instance snapshot and volume snapshot cannot be confused', () => {
  const instance = records.find(({ id }) => id === 'jcloud_ui-compute-create-instance-snapshot');
  const volume = records.find(({ id }) => id === 'jcloud_ui-storage-create-volume-snapshot');

  assert.equal(instance.metadata.resource_type, 'instance');
  assert.equal(instance.metadata.result_route, '/compute/instance-snapshot');
  assert.equal(volume.metadata.resource_type, 'volume');
  assert.equal(volume.metadata.result_route, '/storage/snapshot');
  assert.notDeepEqual(instance.metadata.menu_path, volume.metadata.menu_path);
  assert.match(instance.text, /인스턴스 스냅샷/);
  assert.match(volume.text, /볼륨 스냅샷/);
});
