// End-to-end tests: the real app server talking to a fake provider server
// that mimics the OpenAI, Anthropic and Gemini wire formats.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createApp } from '../server.js';

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'default-ai-test-'));
const envFile = path.join(tmpDir, '.env');

let upstream;
let app;
let base;
const seen = []; // requests the fake provider received

/** Send server-sent events, a few milliseconds apart. */
function sseOut(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let i = 0;
  const next = () => {
    if (i >= events.length) return res.end();
    const e = events[i++];
    res.write((e.event ? `event: ${e.event}\n` : '') + `data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`);
    setTimeout(next, 2);
  };
  next();
}

const lastText = (json) =>
  json.messages?.at(-1)?.content ?? json.contents?.at(-1)?.parts?.[0]?.text ?? (Array.isArray(json.input) ? json.input.at(-1).content : json.input);

function streamFake(res, prefix, url, json) {
  const text = `${prefix} streams: ${lastText(json)}`;
  const pieces = text.split(/(?<= )/); // word by word
  if (json.model === 'broken-stream') {
    return sseOut(res, [{ data: { choices: [{ delta: { content: 'Partial ' } }] } }, { data: { error: { message: 'stream interrupted' } } }]);
  }
  if (url.endsWith('/chat/completions')) {
    return sseOut(res, [
      ...pieces.map((t) => ({ data: { model: json.model, choices: [{ delta: { content: t } }] } })),
      { data: { model: json.model, choices: [{ delta: {}, finish_reason: 'stop' }] } },
      // Usage only when asked for (Meta isn't asked, so it gets none).
      ...(json.stream_options?.include_usage ? [{ data: { model: json.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } } }] : []),
      { data: '[DONE]' },
    ]);
  }
  if (url === '/anthropic/v1/messages') {
    return sseOut(res, [
      { event: 'message_start', data: { type: 'message_start', message: { model: json.model, usage: { input_tokens: 11, output_tokens: 1 } } } },
      ...pieces.map((t) => ({ event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })),
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
  }
  if (url.includes(':streamGenerateContent')) {
    return sseOut(res, [
      ...pieces.map((t) => ({ data: { candidates: [{ content: { parts: [{ text: t }] } }] } })),
      { data: { modelVersion: 'gemini-test-001', candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 } } },
    ]);
  }
  if (url === '/perplexity/agent') {
    return sseOut(res, [
      ...pieces.map((t) => ({ data: { type: 'response.output_text.delta', delta: t } })),
      {
        data: {
          type: 'response.completed',
          response: {
            model: json.model,
            status: 'completed',
            output: [{ type: 'search_results', results: [{ title: 'Source A', url: 'https://a.example' }] }],
            usage: { input_tokens: 13, output_tokens: 8 },
          },
        },
      },
    ]);
  }
  res.writeHead(404);
  res.end();
}

function fakeProvider(req, res) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {};
    seen.push({ method: req.method, url: req.url, headers: req.headers, json });
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const [, prefix] = req.url.split('/');

    if (json.model === 'missing-model') return send(404, { error: { message: 'model not found' } });

    // Streaming, in each provider's own wire format.
    if (json.stream === true || req.url.includes(':streamGenerateContent')) {
      return streamFake(res, prefix, req.url, json);
    }
    if (json.model === 'slow-model') return setTimeout(() => send(200, {}), 2000);

    if (req.method === 'GET' && req.url.startsWith(`/${prefix}/models`) && prefix !== 'gemini') {
      return send(200, { data: [{ id: `${prefix}-b` }, { id: `${prefix}-a` }] });
    }
    if (req.method === 'GET' && req.url.startsWith('/gemini/models')) {
      return send(200, { models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }] });
    }
    if (req.url === '/perplexity/agent') {
      return send(200, {
        model: json.model,
        status: 'completed',
        output: [
          { type: 'search_results', results: [{ id: 1, title: 'Source A', url: 'https://a.example' }] },
          { type: 'message', content: [{ type: 'output_text', text: `perplexity says: ${json.input}` }] },
        ],
        usage: { input_tokens: 13, output_tokens: 8 },
      });
    }
    if (req.url.endsWith('/chat/completions')) {
      const prompt = json.messages.at(-1).content;
      return send(200, {
        model: json.model,
        choices: [{ message: { role: 'assistant', content: `${prefix} says: ${prompt}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    }
    if (req.url === '/anthropic/v1/messages') {
      return send(200, {
        model: json.model,
        content: [{ type: 'text', text: `claude says: ${json.messages[0].content}` }],
        usage: { input_tokens: 11, output_tokens: 6 },
        stop_reason: 'end_turn',
      });
    }
    if (req.url.startsWith('/gemini/models/') && req.url.endsWith(':generateContent')) {
      return send(200, {
        modelVersion: 'gemini-test-001',
        candidates: [{ content: { parts: [{ text: `gemini says: ${json.contents[0].parts[0].text}` }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 },
      });
    }
    send(404, { error: { message: `fake provider has no route ${req.url}` } });
  });
}

before(async () => {
  upstream = http.createServer(fakeProvider).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const up = `http://127.0.0.1:${upstream.address().port}`;

  app = createApp(
    {
      OPENAI_API_KEY: 'sk-openai-secret',
      OPENAI_BASE_URL: `${up}/openai`,
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      ANTHROPIC_BASE_URL: `${up}/anthropic`,
      META_API_KEY: 'meta-secret',
      META_BASE_URL: `${up}/meta`,
      GEMINI_API_KEY: 'gemini-secret',
      GEMINI_BASE_URL: `${up}/gemini`,
      DEEPSEEK_API_KEY: 'deepseek-secret',
      DEEPSEEK_BASE_URL: `${up}/deepseek`,
      PERPLEXITY_API_KEY: 'pplx-secret',
      PERPLEXITY_BASE_URL: `${up}/perplexity`,
      MOONSHOT_API_KEY: 'kimi-secret',
      KIMI_BASE_URL: `${up}/kimi`,
      // Grok is deliberately left unconfigured (until the settings test adds it).
      XAI_BASE_URL: `${up}/xai`,
      REQUEST_TIMEOUT_MS: '500',
      MAX_TOKENS: '777',
    },
    { host: '127.0.0.1', envFile },
  ).listen(0, '127.0.0.1');
  await once(app, 'listening');
  base = `http://127.0.0.1:${app.address().port}`;
});

after(() => {
  app.close();
  upstream.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const chat = (body, headers = { 'content-type': 'application/json' }) =>
  fetch(`${base}/api/chat`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('lists providers without leaking keys', async () => {
  const res = await fetch(`${base}/api/providers`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('secret'));
  const { providers } = JSON.parse(text);
  assert.deepEqual(
    providers.map((p) => [p.id, p.configured]),
    [
      ['openai', true],
      ['anthropic', true],
      ['meta', true],
      ['gemini', true],
      ['xai', false],
      ['deepseek', true],
      ['perplexity', true],
      ['kimi', true],
    ],
  );
});

test('sends a prompt to each configured provider and normalizes the answer', async () => {
  const cases = [
    ['openai', 'openai says: Hi', { input: 10, output: 5 }],
    ['meta', 'meta says: Hi', { input: 10, output: 5 }],
    ['deepseek', 'deepseek says: Hi', { input: 10, output: 5 }],
    ['kimi', 'kimi says: Hi', { input: 10, output: 5 }],
    ['perplexity', 'perplexity says: Hi', { input: 13, output: 8 }],
    ['anthropic', 'claude says: Hi', { input: 11, output: 6 }],
    ['gemini', 'gemini says: Hi', { input: 12, output: 7 }],
  ];
  const results = await Promise.all(
    cases.map(([provider]) => chat({ provider, model: 'test-model', prompt: 'Hi', system: 'Be brief' })),
  );
  for (const [i, res] of results.entries()) {
    const [provider, text, usage] = cases[i];
    assert.equal(res.status, 200, provider);
    const data = await res.json();
    assert.equal(data.text, text, provider);
    assert.deepEqual(data.usage, usage, provider);
    assert.equal(typeof data.latencyMs, 'number');
  }

  const anthropicCall = seen.find((r) => r.url === '/anthropic/v1/messages');
  assert.equal(anthropicCall.headers['x-api-key'], 'sk-ant-secret');
  assert.equal(anthropicCall.json.max_tokens, 777);
  assert.equal(anthropicCall.json.system, 'Be brief');
  const openaiCall = seen.find((r) => r.url === '/openai/chat/completions');
  assert.equal(openaiCall.headers.authorization, 'Bearer sk-openai-secret');
  const geminiCall = seen.find((r) => r.url.startsWith('/gemini/models/test-model'));
  assert.equal(geminiCall.headers['x-goog-api-key'], 'gemini-secret');
  const pplxCall = seen.find((r) => r.url === '/perplexity/agent');
  assert.deepEqual(pplxCall.json.tools, [{ type: 'web_search' }]);
  assert.equal(pplxCall.json.instructions, 'Be brief');
  assert.equal(seen.find((r) => r.url === '/kimi/chat/completions').headers.authorization, 'Bearer kimi-secret');
});

test('returns Perplexity web sources', async () => {
  const res = await chat({ provider: 'perplexity', prompt: 'Hi' });
  assert.deepEqual((await res.json()).sources, [{ title: 'Source A', url: 'https://a.example' }]);
});

test('rejects oversized requests', async () => {
  const res = await chat({ provider: 'openai', prompt: 'x'.repeat(8_100_000) });
  assert.equal(res.status, 413);
});

test('uses the default model when none is given', async () => {
  const res = await chat({ provider: 'openai', prompt: 'Hi' });
  assert.equal((await res.json()).model, 'gpt-6-astra');
});

test('passes provider errors through', async () => {
  const res = await chat({ provider: 'openai', model: 'missing-model', prompt: 'Hi' });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'HTTP 404: model not found');
});

test('times out slow providers', async () => {
  const res = await chat({ provider: 'meta', model: 'slow-model', prompt: 'Hi' });
  assert.equal(res.status, 504);
  assert.match((await res.json()).error, /did not answer in time/);
});

test('rejects bad chat requests', async () => {
  let res = await chat({ provider: 'xai', prompt: 'Hi' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /XAI_API_KEY/);

  res = await chat({ provider: 'nope', prompt: 'Hi' });
  assert.equal(res.status, 400);

  res = await chat({ provider: 'openai', prompt: '   ' });
  assert.equal(res.status, 400);

  res = await chat('{not json');
  assert.equal(res.status, 400);

  // Cross-site "simple" form posts can't use application/json, so refuse anything else.
  res = await chat(JSON.stringify({ provider: 'openai', prompt: 'Hi' }), { 'content-type': 'text/plain' });
  assert.equal(res.status, 415);
});

test('loads model lists from each provider', async () => {
  let res = await fetch(`${base}/api/models?provider=openai`);
  assert.deepEqual(await res.json(), { models: ['openai-a', 'openai-b'] });
  res = await fetch(`${base}/api/models?provider=gemini`);
  assert.deepEqual(await res.json(), { models: ['gemini-a'] });
  res = await fetch(`${base}/api/models?provider=xai`);
  assert.equal(res.status, 400);
});

test('serves the UI and blocks path traversal', async () => {
  let res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /Default AI Prompt/);

  res = await fetch(`${base}/app.js`);
  assert.match(res.headers.get('content-type'), /javascript/);

  res = await fetch(`${base}/%2e%2e/server.js`);
  assert.equal(res.status, 404);
  res = await fetch(`${base}/..%2Fpackage.json`);
  assert.equal(res.status, 404);
});

test('refuses non-loopback Host headers (DNS rebinding)', async () => {
  const status = await new Promise((resolve, reject) => {
    http
      .get(`${base}/api/providers`, { headers: { host: 'evil.example:80' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on('error', reject);
  });
  assert.equal(status, 403);
});

const postJson = (url, body) =>
  fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('settings: preview masks keys, apply writes .env and turns the provider on without a restart', async () => {
  const text = `XAI_API_KEY=xai-secret-123456\nXAI_MODEL=grok-test\nHOST=0.0.0.0\n`;

  let res = await postJson('/api/settings/preview', { text });
  assert.equal(res.status, 200);
  const preview = await res.json();
  assert.deepEqual(
    preview.changes.sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'XAI_API_KEY', value: '••••3456', action: 'add' },
      { name: 'XAI_MODEL', value: 'grok-test', action: 'add' },
    ],
  );
  assert.deepEqual(preview.ignored, ['HOST']);

  res = await postJson('/api/settings/apply', { text });
  assert.equal(res.status, 200);
  const applied = await res.json();
  const xai = applied.providers.find((p) => p.id === 'xai');
  assert.equal(xai.configured, true);
  assert.equal(xai.defaultModel, 'grok-test');
  assert.ok(!JSON.stringify(applied).includes('xai-secret'));
  assert.deepEqual(parseEnv(readFileSync(envFile, 'utf8')), { XAI_API_KEY: 'xai-secret-123456', XAI_MODEL: 'grok-test' });

  res = await chat({ provider: 'xai', prompt: 'Hi' });
  assert.equal((await res.json()).text, 'xai says: Hi');

  res = await fetch(`${base}/api/settings`);
  const { variables } = await res.json();
  assert.deepEqual(variables.find((v) => v.name === 'XAI_API_KEY'), { name: 'XAI_API_KEY', set: true, value: '••••3456' });
  assert.ok(!JSON.stringify(variables).includes('secret'));
});

test('settings: invalid files are refused and nothing is written', async () => {
  const before = readFileSync(envFile, 'utf8');
  let res = await postJson('/api/settings/apply', { text: 'OPENAI_BASE_URL=ftp://evil\n' });
  assert.equal(res.status, 400);
  res = await postJson('/api/settings/apply', { text: 'NOTHING_USEFUL=1\n' });
  assert.equal(res.status, 400);
  assert.equal(readFileSync(envFile, 'utf8'), before);
});

test('settings: refused from another computer', async (t) => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!lan) return t.skip('no network interface besides loopback');
  const remoteApp = createApp({}, { host: '0.0.0.0', envFile }).listen(0, '0.0.0.0');
  await once(remoteApp, 'listening');
  try {
    const url = `http://${lan.address}:${remoteApp.address().port}`;
    let res = await fetch(`${url}/api/settings`);
    assert.equal(res.status, 403);
    res = await fetch(`${url}/api/settings/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'OPENAI_API_KEY=attacker' }),
    });
    assert.equal(res.status, 403);
    // The rest of the app still works for other computers.
    res = await fetch(`${url}/api/providers`);
    assert.equal(res.status, 200);
  } finally {
    remoteApp.close();
  }
});

test('ads: off by default, strict CSP, no ads.txt', async () => {
  let res = await fetch(`${base}/api/config`);
  assert.equal((await res.json()).ads.enabled, false);
  res = await fetch(`${base}/`);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(`${base}/ads.txt`)).status, 404);
});

test('ads: AdSense on adds a nonce to scripts, Google strict CSP and ads.txt', async () => {
  const adsApp = createApp(
    { ADSENSE_CLIENT: 'ca-pub-1234567890123456', ADSENSE_SLOT_TOP: '1111111111' },
    { host: '127.0.0.1', envFile },
  ).listen(0, '127.0.0.1');
  await once(adsApp, 'listening');
  try {
    const url = `http://127.0.0.1:${adsApp.address().port}`;
    let res = await fetch(`${url}/`);
    const csp = res.headers.get('content-security-policy');
    const nonce = csp.match(/'nonce-([^']+)'/)[1];
    assert.match(csp, /'strict-dynamic'/);
    assert.match(csp, /object-src 'none'/);
    const html = await res.text();
    assert.ok(html.includes(`<script nonce="${nonce}" `));
    // A fresh nonce for every page load.
    const again = (await fetch(`${url}/`)).headers.get('content-security-policy');
    assert.notEqual(again, csp);

    res = await fetch(`${url}/ads.txt`);
    assert.equal(await res.text(), 'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n');
    res = await fetch(`${url}/api/config`);
    assert.deepEqual((await res.json()).ads, {
      enabled: true,
      client: 'ca-pub-1234567890123456',
      slots: { top: '1111111111', bottom: '' },
      placeholder: false,
    });
  } finally {
    adsApp.close();
  }
});

// ---------------------------------------------------------------------------
// Streaming, follow-up questions and cost estimates
// ---------------------------------------------------------------------------

/** POST /api/chat with stream: true and return the parsed events. */
async function streamChat(body) {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) return { status: res.status, error: (await res.json()).error };
  assert.match(res.headers.get('content-type'), /application\/x-ndjson/);
  const events = (await res.text()).trim().split('\n').map((line) => JSON.parse(line));
  return { status: res.status, events, done: events.find((e) => e.type === 'done') };
}

test('streams answers from every provider, piece by piece', async () => {
  for (const provider of ['openai', 'meta', 'deepseek', 'kimi', 'anthropic', 'gemini', 'perplexity']) {
    const { events, done } = await streamChat({ provider, model: 'test-model', prompt: 'tell me more' });
    const deltas = events.filter((e) => e.type === 'delta');
    assert.ok(deltas.length > 2, `${provider} sent the answer in pieces`);
    const expectedPrefix = provider === 'anthropic' ? 'anthropic' : provider;
    assert.equal(deltas.map((d) => d.text).join(''), `${expectedPrefix} streams: tell me more`, provider);
    assert.equal(done.text, `${expectedPrefix} streams: tell me more`, provider);
    assert.equal(typeof done.latencyMs, 'number');
  }
  const { done: claude } = await streamChat({ provider: 'anthropic', prompt: 'x' });
  assert.deepEqual(claude.usage, { input: 11, output: 6 });
  assert.equal(claude.stopReason, 'end_turn');
  const { done: pplx } = await streamChat({ provider: 'perplexity', prompt: 'x' });
  assert.deepEqual(pplx.sources, [{ title: 'Source A', url: 'https://a.example' }]);
});

test('cost estimate (billing off) from token counts, or from length when none are reported', async () => {
  // gpt-6-astra lists at $10 in / $50 out per 1M tokens: 10 × 10 + 5 × 50 = 350 millionths of a dollar.
  const { done } = await streamChat({ provider: 'openai', model: 'gpt-6-astra', prompt: 'x' });
  assert.equal(done.estimatedCost, 350);
  assert.equal(done.costEstimated, undefined);
  assert.equal(done.cost, undefined, 'no charge without billing');
  const plain = await (await chat({ provider: 'openai', model: 'gpt-6-astra', prompt: 'x' })).json();
  assert.equal(plain.estimatedCost, 350);

  // Meta isn't asked for token counts in a stream, so they're estimated from the text.
  const { done: meta } = await streamChat({ provider: 'meta', model: 'muse-spark-1.3', prompt: 'x' });
  assert.equal(meta.costEstimated, true);
  assert.ok(meta.estimatedCost > 0);

  // A model without a list price gets no estimate.
  const { done: unpriced } = await streamChat({ provider: 'openai', model: 'test-model', prompt: 'x' });
  assert.equal(unpriced.estimatedCost, undefined);
});

test('a stream that breaks off reports an error after the text so far', async () => {
  const { events } = await streamChat({ provider: 'openai', model: 'broken-stream', prompt: 'x' });
  assert.deepEqual(events[0], { type: 'delta', text: 'Partial ' });
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).error, /stream interrupted/);
});

test('a provider error before the stream starts is a normal error response', async () => {
  const { status, error } = await streamChat({ provider: 'openai', model: 'missing-model', prompt: 'x' });
  assert.equal(status, 502);
  assert.equal(error, 'HTTP 404: model not found');
});

test('follow-up questions send the whole conversation to each provider', async () => {
  const messages = [
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'First answer' },
    { role: 'user', content: 'And a follow-up?' },
  ];
  seen.length = 0;
  for (const provider of ['openai', 'anthropic', 'gemini', 'perplexity']) {
    const { done } = await streamChat({ provider, model: 'test-model', messages, system: 'Be brief' });
    assert.match(done.text, /And a follow-up\?$/, provider);
  }
  const body = (url) => seen.find((r) => r.url.startsWith(url)).json;
  assert.deepEqual(body('/openai/chat/completions').messages, [{ role: 'system', content: 'Be brief' }, ...messages]);
  assert.deepEqual(body('/anthropic/v1/messages').messages, messages);
  assert.deepEqual(
    body('/gemini/models/').contents.map((c) => c.role),
    ['user', 'model', 'user'],
  );
  assert.deepEqual(
    body('/perplexity/agent').input.map((m) => [m.type, m.role]),
    [
      ['message', 'user'],
      ['message', 'assistant'],
      ['message', 'user'],
    ],
  );

  // The conversation must end with the user's question.
  const bad = await chat({ provider: 'openai', messages: messages.slice(0, 2) });
  assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------------------
// PDF and Word attachments
// ---------------------------------------------------------------------------

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const extract = (name, type) =>
  fetch(`${base}/api/extract`, {
    method: 'POST',
    headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name) },
    body: fixture(name),
  });
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('extracts text from a PDF', async () => {
  const res = await extract('report.pdf', PDF);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.pages, 2);
  assert.match(data.text, /^Quarterly Report\nRevenue grew 12% to \$4\.2M\. Café sales led the gain\./);
  assert.match(data.text, /Owner: Zoë Martín\n\nPage two/);
});

test('extracts text from Word files made by pandoc and LibreOffice', async () => {
  let data = await (await extract('memo.docx', DOCX)).json();
  assert.equal(
    data.text,
    'Team memo\nHello team, here are the notes & numbers for “Q4”.\nFirst item\nSecond item\nRegion\tSales\nNorth\t120\nSouth\t95\nThanks, Zoë',
  );
  data = await (await extract('letter.docx', 'application/octet-stream')).json();
  assert.match(data.text, /^Offer letter\nDear Sam,/);
  assert.match(data.text, /Salary\t\$120,000/);
});

test('explains documents it cannot read', async () => {
  for (const [name, type, message] of [
    ['scanned.pdf', PDF, /no selectable text/],
    ['locked.pdf', PDF, /password-protected/],
    ['old.doc', 'application/octet-stream', /old Word file/],
  ]) {
    const res = await extract(name, type);
    assert.equal(res.status, 422, name);
    assert.match((await res.json()).error, message, name);
  }
});

test('document upload only accepts PDF and Word types, within the size limit', async () => {
  // A plain form post (text/plain) is refused, so other websites can't send files here.
  let res = await fetch(`${base}/api/extract`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(res.status, 415);
  res = await fetch(`${base}/api/extract`, {
    method: 'POST',
    headers: { 'content-type': PDF, 'x-file-name': 'huge.pdf' },
    body: Buffer.alloc(20_000_001),
  });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /huge\.pdf is larger than 20 MB/);
});
