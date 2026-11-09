import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  readImportFile,
  parseExport,
  htmlToText,
  buildAppExport,
  listZipEntries,
  APP_EXPORT_FORMAT,
} from '../public/importers.js';

// --- helpers ---------------------------------------------------------------

/** Build a real .zip in memory. files: [{name, text, store?}] */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const raw = Buffer.from(f.text);
    const data = f.store ? raw : zlib.deflateRawSync(raw);
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(f.store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(f.store ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const fileOf = (name, content) => ({
  name,
  arrayBuffer: async () => {
    const buf = typeof content === 'string' ? Buffer.from(content) : content;
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
});

// --- sample exports (shapes match each app's export format) ------------------

const chatgptExport = [
  {
    id: 'c1',
    title: 'Trip ideas',
    create_time: 1700000000.5,
    current_node: 'a2',
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['sys'] },
      sys: {
        id: 'sys',
        parent: 'root',
        children: ['u1'],
        message: { author: { role: 'system' }, content: { content_type: 'text', parts: [''] }, create_time: null },
      },
      u1: {
        id: 'u1',
        parent: 'sys',
        children: ['a1', 'a2'],
        message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Where should I go?'] }, create_time: 1700000001 },
      },
      a1: {
        id: 'a1',
        parent: 'u1',
        children: [],
        message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Old answer'] }, create_time: 1700000002 },
      },
      a2: {
        id: 'a2',
        parent: 'u1',
        children: [],
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer' }, 'Try Duluth.'] },
          create_time: 1700000003,
        },
      },
    },
  },
  { id: 'empty', title: 'Nothing', mapping: {} },
];

const claudeExport = [
  {
    uuid: 'k1',
    name: 'Python help',
    created_at: '2026-05-01T10:00:00Z',
    chat_messages: [
      { sender: 'human', text: 'What is a tuple?', created_at: '2026-05-01T10:00:00Z' },
      { sender: 'assistant', text: '', content: [{ type: 'text', text: 'An immutable sequence.' }], created_at: '2026-05-01T10:00:05Z' },
    ],
  },
];

const geminiTakeout = [
  {
    header: 'Gemini Apps',
    title: 'Prompted Plan a day in Minneapolis',
    time: '2026-06-02T15:04:05.000Z',
    products: ['Gemini Apps'],
    safeHtmlItem: [{ html: '<p>Visit the <b>Stone Arch Bridge</b> &amp; the river.</p><ul><li>Mill City</li><li>Walker</li></ul>' }],
  },
  { header: 'Search', title: 'Searched for weather', time: '2026-06-02T15:00:00.000Z', products: ['Search'] },
];

// --- tests -----------------------------------------------------------------

test('ChatGPT export: follows the visible branch and skips system and image parts', () => {
  const out = parseExport(chatgptExport);
  assert.equal(out.kind, 'conversations');
  assert.equal(out.source, 'chatgpt');
  assert.equal(out.conversations.length, 1);
  const [c] = out.conversations;
  assert.equal(c.id, 'chatgpt:c1');
  assert.equal(c.title, 'Trip ideas');
  assert.equal(c.createdAt, new Date(1700000000500).toISOString());
  assert.deepEqual(
    c.messages.map((m) => [m.role, m.text]),
    [
      ['user', 'Where should I go?'],
      ['assistant', 'Try Duluth.'],
    ],
  );
});

test('Claude export: maps human/assistant and reads content blocks', () => {
  const out = parseExport(claudeExport);
  assert.equal(out.source, 'claude');
  assert.deepEqual(
    out.conversations[0].messages.map((m) => [m.role, m.text]),
    [
      ['user', 'What is a tuple?'],
      ['assistant', 'An immutable sequence.'],
    ],
  );
  assert.equal(out.conversations[0].id, 'claude:k1');
});

test('Gemini Takeout: one conversation per prompt, HTML answer turned into text', () => {
  const out = parseExport(geminiTakeout);
  assert.equal(out.source, 'gemini');
  assert.equal(out.conversations.length, 1);
  const [c] = out.conversations;
  assert.equal(c.title, 'Plan a day in Minneapolis');
  assert.deepEqual(c.messages[0], { role: 'user', text: 'Plan a day in Minneapolis', createdAt: '2026-06-02T15:04:05.000Z' });
  assert.equal(c.messages[1].text, 'Visit the Stone Arch Bridge & the river.\n\n- Mill City\n- Walker');
});

test('generic format with role aliases', () => {
  const out = parseExport({
    conversations: [
      {
        title: 'Generic',
        messages: [
          { role: 'human', content: 'Hi' },
          { role: 'model', content: [{ type: 'text', text: 'Hello' }] },
          { role: 'tool', content: 'ignored' },
        ],
      },
    ],
  });
  assert.equal(out.source, 'other');
  assert.deepEqual(
    out.conversations[0].messages.map((m) => [m.role, m.text]),
    [
      ['user', 'Hi'],
      ['assistant', 'Hello'],
    ],
  );
});

test("this app's export round-trips and is sanitized", () => {
  const run = {
    id: 'r1',
    createdAt: '2026-11-04T10:00:00.000Z',
    prompt: 'Hello',
    system: '',
    attachments: [{ name: 'a.txt', size: 3, text: 'abc' }],
    responses: [
      {
        provider: 'openai',
        providerName: 'OpenAI',
        model: 'gpt-x',
        text: 'Hi',
        error: '',
        seconds: 1.2,
        usage: { input: 1, output: 2 },
        stopReason: 'stop',
        sources: [
          { title: 'Ok', url: 'https://ok.example' },
          { title: 'Bad', url: 'javascript:alert(1)' },
        ],
      },
    ],
  };
  const exported = buildAppExport([run], parseExport(claudeExport).conversations, new Date('2026-11-04T12:00:00Z'));
  assert.equal(exported.format, APP_EXPORT_FORMAT);
  const back = parseExport(JSON.parse(JSON.stringify(exported)));
  assert.equal(back.kind, 'app');
  assert.equal(back.runs.length, 1);
  // A version 1 run (one prompt) comes back as a run with one turn.
  const [turn] = back.runs[0].turns;
  assert.deepEqual(turn.responses[0].sources, [{ title: 'Ok', url: 'https://ok.example' }]);
  assert.equal(turn.attachments[0].text, 'abc');
  assert.equal(back.runs[0].prompt, 'Hello');
  assert.deepEqual(back.runs[0].models, [{ provider: 'openai', providerName: 'OpenAI', model: 'gpt-x' }]);
  assert.equal(back.conversations[0].id, 'claude:k1');
  assert.equal(back.conversations[0].source, 'claude');
});

test('reads conversations.json from a compressed export .zip', async () => {
  const zip = makeZip([
    { name: 'users.json', text: '{"id":"u"}' },
    { name: 'conversations.json', text: JSON.stringify(claudeExport) },
  ]);
  const out = await readImportFile(fileOf('data-export.zip', zip));
  assert.equal(out.source, 'claude');
  assert.equal(out.conversations[0].messages[1].text, 'An immutable sequence.');
});

test('reads a Google Takeout .zip with an uncompressed entry', async () => {
  const zip = makeZip([
    { name: 'Takeout/archive_browser.html', text: '<html></html>', store: true },
    { name: 'Takeout/My Activity/Gemini Apps/MyActivity.json', text: JSON.stringify(geminiTakeout), store: true },
  ]);
  assert.equal(listZipEntries(new Uint8Array(zip)).length, 2);
  const out = await readImportFile(fileOf('takeout.zip', zip));
  assert.equal(out.source, 'gemini');
});

test('reads a plain JSON file with a byte-order mark', async () => {
  const out = await readImportFile(fileOf('conversations.json', '﻿' + JSON.stringify(chatgptExport)));
  assert.equal(out.source, 'chatgpt');
});

test('clear errors for files it cannot read', async () => {
  await assert.rejects(readImportFile(fileOf('x.html', '<html>hi</html>')), /HTML file/);
  await assert.rejects(readImportFile(fileOf('x.json', '{oops')), /isn't a chat export/);
  await assert.rejects(readImportFile(fileOf('x.json', '{"hello":1}')), /doesn't look like a chat history/);
  await assert.rejects(
    readImportFile(fileOf('x.zip', makeZip([{ name: 'a.txt', text: 'x' }, { name: 'b.txt', text: 'y' }]))),
    /no conversations\.json/,
  );
});

test('htmlToText decodes entities and keeps structure', () => {
  assert.equal(htmlToText('<p>a &lt;b&gt; &#169; &#x41;</p><p>next<br>line</p>'), 'a <b> © A\n\nnext\nline');
  assert.equal(htmlToText('<script>alert(1)</script>ok'), 'ok');
});

test('conversations with follow-ups, costs and PDF page counts survive export and import', () => {
  const run = {
    id: 'r2',
    createdAt: '2026-11-07T10:00:00.000Z',
    system: 'Be brief',
    models: [{ provider: 'anthropic', providerName: 'Claude', model: 'claude-x' }],
    turns: [
      {
        prompt: 'Summarize',
        attachments: [{ name: 'report.pdf', size: 120, text: 'Revenue grew', pages: 2 }],
        createdAt: '2026-11-07T10:00:00.000Z',
        responses: [{ provider: 'anthropic', providerName: 'Claude', model: 'claude-x', text: 'It grew.', estimatedCost: 350 }],
      },
      {
        prompt: 'By how much?',
        attachments: [],
        createdAt: '2026-11-07T10:01:00.000Z',
        responses: [{ provider: 'anthropic', providerName: 'Claude', model: 'claude-x', text: '12%.', cost: 1200, costEstimated: true }],
      },
    ],
    prompt: 'Summarize',
  };
  const back = parseExport(JSON.parse(JSON.stringify(buildAppExport([run], []))));
  const [saved] = back.runs;
  assert.equal(saved.turns.length, 2);
  assert.equal(saved.turns[0].attachments[0].pages, 2);
  assert.equal(saved.turns[0].responses[0].estimatedCost, 350);
  assert.equal(saved.turns[1].responses[0].cost, 1200);
  assert.equal(saved.turns[1].responses[0].costEstimated, true);
  assert.equal(saved.turns[1].prompt, 'By how much?');
  assert.equal(saved.system, 'Be brief');
});
