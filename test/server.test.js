// End-to-end tests: the real app server talking to a fake provider server
// that mimics the OpenAI, Anthropic and Gemini wire formats.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApp } from '../server.js';

let upstream;
let app;
let base;
const seen = []; // requests the fake provider received

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
    if (json.model === 'slow-model') return setTimeout(() => send(200, {}), 2000);

    if (req.method === 'GET' && req.url.startsWith(`/${prefix}/models`) && prefix !== 'gemini') {
      return send(200, { data: [{ id: `${prefix}-b` }, { id: `${prefix}-a` }] });
    }
    if (req.method === 'GET' && req.url.startsWith('/gemini/models')) {
      return send(200, { models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }] });
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
      // Grok is deliberately left unconfigured.
      XAI_BASE_URL: `${up}/xai`,
      REQUEST_TIMEOUT_MS: '500',
      MAX_TOKENS: '777',
    },
    { host: '127.0.0.1' },
  ).listen(0, '127.0.0.1');
  await once(app, 'listening');
  base = `http://127.0.0.1:${app.address().port}`;
});

after(() => {
  app.close();
  upstream.close();
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
    ],
  );
});

test('sends a prompt to each configured provider and normalizes the answer', async () => {
  const cases = [
    ['openai', 'openai says: Hi', { input: 10, output: 5 }],
    ['meta', 'meta says: Hi', { input: 10, output: 5 }],
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
  assert.match(await res.text(), /Multi-LLM Prompt/);

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
