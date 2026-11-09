import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, checkFile, checkText, documentType, isDocument, looksBinary } from '../public/prompt.js';

test('prompt without attachments is unchanged', () => {
  assert.equal(buildPrompt('Hi', []), 'Hi');
});

test('attachments are appended in fenced blocks named after the file', () => {
  assert.equal(
    buildPrompt('Summarize', [
      { name: 'notes.md', text: '# Notes' },
      { name: 'data.csv', text: 'a,b\n1,2' },
    ]),
    'Summarize\n\nAttached file: notes.md\n```md\n# Notes\n```\n\nAttached file: data.csv\n```csv\na,b\n1,2\n```',
  );
});

test("a file containing backtick fences can't close its own block", () => {
  const out = buildPrompt('Review', [{ name: 'README', text: 'Use:\n````\ncode\n````' }]);
  assert.ok(out.includes('Attached file: README\n`````\nUse:'));
  assert.ok(out.endsWith('````\n`````'));
});

test('checkFile accepts text, PDF and Word files and rejects other binaries and oversized files', () => {
  assert.equal(checkFile({ name: 'a.txt', size: 10, type: 'text/plain' }, 0), '');
  assert.equal(checkFile({ name: 'Makefile', size: 10, type: '' }, 0), '');
  assert.equal(checkFile({ name: 'report.pdf', size: 5_000_000, type: 'application/pdf' }, 0), '');
  assert.equal(checkFile({ name: 'memo.docx', size: 10, type: '' }, 0), '');
  assert.match(checkFile({ name: 'huge.pdf', size: 20_000_001, type: 'application/pdf' }, 0), /larger than 20 MB/);
  assert.match(checkFile({ name: 'old.doc', size: 10, type: 'application/msword' }, 0), /save it as \.docx/);
  assert.match(checkFile({ name: 'photo', size: 10, type: 'image/png' }, 0), /can't be attached/);
  assert.match(checkFile({ name: 'sheet.xlsx', size: 10, type: '' }, 0), /can't be attached/);
  assert.match(checkFile({ name: 'big.log', size: 1_500_000, type: 'text/plain' }, 0), /larger than 1 MB/);
  assert.match(checkFile({ name: 'c.txt', size: 600_000, type: 'text/plain' }, 1_500_000), /2 MB in total/);
});

test('looksBinary', () => {
  assert.equal(looksBinary('plain text'), false);
  assert.equal(looksBinary('PK\u0003\u0004\u0000'), true);
});

test('documents: type detection and limits on their extracted text', () => {
  assert.equal(isDocument({ name: 'A.PDF', type: '' }), true);
  assert.equal(isDocument({ name: 'notes.txt', type: 'text/plain' }), false);
  assert.equal(documentType({ name: 'x.pdf', type: '' }), 'application/pdf');
  assert.equal(documentType({ name: 'x.docx', type: '' }), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(checkText('a.pdf', 'short text', 0), '');
  assert.match(checkText('big.pdf', 'é'.repeat(600_000), 0), /more than 1 MB of text/); // 1.2 MB as UTF-8
  assert.match(checkText('c.pdf', 'x'.repeat(600_000), 1_500_000), /2 MB of text in total/);
});
