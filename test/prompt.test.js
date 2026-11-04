import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, checkFile, looksBinary } from '../public/prompt.js';

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

test('checkFile rejects binary types and sizes over the limits', () => {
  assert.equal(checkFile({ name: 'a.txt', size: 10, type: 'text/plain' }, 0), '');
  assert.equal(checkFile({ name: 'Makefile', size: 10, type: '' }, 0), '');
  assert.match(checkFile({ name: 'report.pdf', size: 10, type: 'application/pdf' }, 0), /only text files/);
  assert.match(checkFile({ name: 'photo', size: 10, type: 'image/png' }, 0), /only text files/);
  assert.match(checkFile({ name: 'big.log', size: 1_500_000, type: 'text/plain' }, 0), /larger than 1 MB/);
  assert.match(checkFile({ name: 'c.txt', size: 600_000, type: 'text/plain' }, 1_500_000), /2 MB in total/);
});

test('looksBinary', () => {
  assert.equal(looksBinary('plain text'), false);
  assert.equal(looksBinary('PK\u0003\u0004\u0000'), true);
});
