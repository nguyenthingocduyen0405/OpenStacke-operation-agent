const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContext, vectorLiteral } = require('../rag');

test('định dạng vector pgvector và từ chối dữ liệu không hợp lệ', () => {
  assert.equal(vectorLiteral([0.25, -1, 0]), '[0.25,-1,0]');
  assert.throws(() => vectorLiteral([]));
  assert.throws(() => vectorLiteral([Number.NaN]));
});

test('tạo ngữ cảnh RAG có tiêu đề và nguồn', () => {
  const context = buildContext([{
    content: 'Nội dung kiểm thử',
    metadata: { title: 'Tạo instance', source_path: 'docs/create.md' }
  }]);
  assert.match(context, /\[1\] 제목: Tạo instance/);
  assert.match(context, /출처: docs\/create\.md/);
  assert.match(context, /Nội dung kiểm thử/);
});
