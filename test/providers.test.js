import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS,
  resolveProviders,
  publicInfo,
  buildChatRequest,
  parseChatResponse,
  buildModelsRequest,
  parseModelsResponse,
  extractErrorMessage,
  normalizeMessages,
  createSseReader,
  createStreamParser,
} from '../providers.js';

const byId = (env = {}) => Object.fromEntries(resolveProviders(env).map((p) => [p.id, p]));

test('all eight providers are defined', () => {
  assert.deepEqual(
    PROVIDERS.map((p) => p.name),
    ['OpenAI', 'Claude', 'Meta', 'Gemini', 'Grok', 'DeepSeek', 'Perplexity', 'Kimi'],
  );
  for (const p of PROVIDERS) assert.ok(p.models.includes(p.defaultModel), `${p.id} suggests its default model`);
});

test('Kimi accepts either key name', () => {
  assert.equal(byId({ MOONSHOT_API_KEY: 'm' }).kimi.apiKey, 'm');
  assert.equal(byId({ KIMI_API_KEY: 'k', MOONSHOT_API_KEY: 'm' }).kimi.apiKey, 'k');
});

test('resolveProviders reads keys, alternate key names, models and base URLs from env', () => {
  const p = byId({
    OPENAI_API_KEY: 'sk-openai',
    MODEL_API_KEY: 'meta-key',
    GEMINI_MODEL: 'gemini-custom',
    XAI_BASE_URL: 'https://proxy.example/v1///',
  });
  assert.equal(p.openai.apiKey, 'sk-openai');
  assert.equal(p.meta.apiKey, 'meta-key');
  assert.equal(p.anthropic.apiKey, '');
  assert.equal(p.gemini.defaultModel, 'gemini-custom');
  assert.equal(p.xai.baseUrl, 'https://proxy.example/v1');
});

test('publicInfo never exposes the API key', () => {
  const info = publicInfo(byId({ ANTHROPIC_API_KEY: 'sk-ant-secret' }).anthropic);
  assert.equal(info.configured, true);
  assert.ok(!JSON.stringify(info).includes('sk-ant-secret'));
});

test('OpenAI-compatible request (OpenAI, Meta, Grok, DeepSeek, Kimi)', () => {
  const env = { OPENAI_API_KEY: 'k', META_API_KEY: 'k', XAI_API_KEY: 'k', DEEPSEEK_API_KEY: 'k', KIMI_API_KEY: 'k' };
  for (const id of ['openai', 'meta', 'xai', 'deepseek', 'kimi']) {
    const p = byId(env)[id];
    const { url, init } = buildChatRequest(p, { model: 'm', prompt: 'Hi', system: 'Be brief', maxTokens: 100 });
    assert.equal(url, `${p.baseUrl}/chat/completions`);
    assert.equal(init.headers.authorization, 'Bearer k');
    assert.deepEqual(JSON.parse(init.body), {
      model: 'm',
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'Hi' },
      ],
    });
  }
});

test('OpenAI-compatible request omits an empty system prompt', () => {
  const p = byId({ OPENAI_API_KEY: 'k' }).openai;
  const { init } = buildChatRequest(p, { model: 'm', prompt: 'Hi', system: '', maxTokens: 100 });
  assert.deepEqual(JSON.parse(init.body).messages, [{ role: 'user', content: 'Hi' }]);
});

test('Anthropic request uses the Messages API', () => {
  const p = byId({ ANTHROPIC_API_KEY: 'k' }).anthropic;
  const { url, init } = buildChatRequest(p, { model: 'claude-x', prompt: 'Hi', system: 'Be brief', maxTokens: 512 });
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['x-api-key'], 'k');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(JSON.parse(init.body), {
    model: 'claude-x',
    max_tokens: 512,
    system: 'Be brief',
    messages: [{ role: 'user', content: 'Hi' }],
  });
});

test('Gemini request uses generateContent and accepts a models/ prefix', () => {
  const p = byId({ GEMINI_API_KEY: 'k' }).gemini;
  const { url, init } = buildChatRequest(p, { model: 'models/gemini-x', prompt: 'Hi', system: 'Be brief', maxTokens: 1 });
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent');
  assert.equal(init.headers['x-goog-api-key'], 'k');
  assert.deepEqual(JSON.parse(init.body), {
    systemInstruction: { parts: [{ text: 'Be brief' }] },
    contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
  });
});

test('Gemini model IDs cannot change the request path', () => {
  const p = byId({ GEMINI_API_KEY: 'k' }).gemini;
  const { url } = buildChatRequest(p, { model: '../../evil?x=1', prompt: 'Hi', system: '', maxTokens: 1 });
  assert.ok(url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/..%2F..%2Fevil%3Fx%3D1:'));
});

test('DeepSeek and Kimi use their own hosts', () => {
  const p = byId({ DEEPSEEK_API_KEY: 'k', KIMI_API_KEY: 'k' });
  assert.equal(buildChatRequest(p.deepseek, { model: 'm', prompt: 'Hi' }).url, 'https://api.deepseek.com/chat/completions');
  assert.equal(buildChatRequest(p.kimi, { model: 'm', prompt: 'Hi' }).url, 'https://api.moonshot.ai/v1/chat/completions');
});

test('Perplexity request uses the Agent API with web search on', () => {
  const p = byId({ PERPLEXITY_API_KEY: 'k' }).perplexity;
  const { url, init } = buildChatRequest(p, { model: 'perplexity/sonar', prompt: 'Hi', system: 'Be brief', maxTokens: 900 });
  assert.equal(url, 'https://api.perplexity.ai/v1/agent');
  assert.equal(init.headers.authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(init.body), {
    model: 'perplexity/sonar',
    input: 'Hi',
    instructions: 'Be brief',
    tools: [{ type: 'web_search' }],
  });
  // Anthropic models on the Agent API need an output limit.
  const claude = JSON.parse(buildChatRequest(p, { model: 'anthropic/x', prompt: 'Hi', system: '', maxTokens: 900 }).init.body);
  assert.equal(claude.max_output_tokens, 900);
  assert.equal('instructions' in claude, false);
});

test('parses a Perplexity Agent API response with sources', () => {
  const p = byId().perplexity;
  const out = parseChatResponse(p, {
    model: 'perplexity/sonar',
    status: 'completed',
    output: [
      {
        type: 'search_results',
        queries: ['q'],
        results: [
          { id: 1, title: 'Example', url: 'https://example.com/a', snippet: '…' },
          { id: 2, title: '', url: 'https://example.com/b' },
          { id: 3, title: 'Dup', url: 'https://example.com/a' },
          { id: 4, title: 'Bad', url: 'javascript:alert(1)' },
        ],
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer [web:1]', annotations: [] }] },
    ],
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
  });
  assert.deepEqual(out, {
    text: 'Answer [web:1]',
    model: 'perplexity/sonar',
    usage: { input: 7, output: 3 },
    stopReason: undefined,
    sources: [
      { title: 'Example', url: 'https://example.com/a' },
      { title: 'https://example.com/b', url: 'https://example.com/b' },
    ],
  });
});

test('OpenAI-compatible url_citation annotations become sources', () => {
  const p = byId().openai;
  const out = parseChatResponse(p, {
    choices: [
      {
        message: {
          content: 'Hi',
          annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.org', title: 'Ex' } }],
        },
      },
    ],
  });
  assert.deepEqual(out.sources, [{ title: 'Ex', url: 'https://example.org' }]);
});

test('parses an OpenAI-compatible response', () => {
  const p = byId().openai;
  const out = parseChatResponse(p, {
    model: 'gpt-x',
    choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  });
  assert.deepEqual(out, { text: 'Hello', model: 'gpt-x', usage: { input: 3, output: 1 }, stopReason: 'stop' });
});

test('parses OpenAI-compatible content given as parts', () => {
  const p = byId().meta;
  const out = parseChatResponse(p, { choices: [{ message: { content: [{ type: 'text', text: 'A' }, 'B'] } }] });
  assert.equal(out.text, 'AB');
});

test('parses an Anthropic response, ignoring non-text blocks', () => {
  const p = byId().anthropic;
  const out = parseChatResponse(p, {
    model: 'claude-x',
    content: [
      { type: 'thinking', thinking: '...' },
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ],
    usage: { input_tokens: 5, output_tokens: 2 },
    stop_reason: 'end_turn',
  });
  assert.deepEqual(out, { text: 'Hello', model: 'claude-x', usage: { input: 5, output: 2 }, stopReason: 'end_turn' });
});

test('parses a Gemini response, ignoring thought parts', () => {
  const p = byId().gemini;
  const out = parseChatResponse(p, {
    modelVersion: 'gemini-x-001',
    candidates: [
      {
        content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Hello' }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 },
  });
  assert.deepEqual(out, { text: 'Hello', model: 'gemini-x-001', usage: { input: 4, output: 1 }, stopReason: 'STOP' });
});

test('a blocked Gemini prompt is reported as an error', () => {
  const p = byId().gemini;
  assert.throws(() => parseChatResponse(p, { promptFeedback: { blockReason: 'SAFETY' } }), /SAFETY/);
});

test('model lists are normalized per provider', () => {
  const p = byId();
  assert.deepEqual(
    parseModelsResponse(p.openai, {
      data: [{ id: 'gpt-b' }, { id: 'text-embedding-3-large' }, { id: 'gpt-a' }, { id: 'whisper-1' }, { id: 'gpt-a' }],
    }),
    ['gpt-a', 'gpt-b'],
  );
  assert.deepEqual(parseModelsResponse(p.anthropic, { data: [{ id: 'claude-b' }, { id: 'claude-a' }] }), [
    'claude-a',
    'claude-b',
  ]);
  assert.deepEqual(
    parseModelsResponse(p.gemini, {
      models: [
        { name: 'models/gemini-chat', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding', supportedGenerationMethods: ['embedContent'] },
      ],
    }),
    ['gemini-chat'],
  );
});

test('model list requests use each provider’s auth', () => {
  const p = byId({ OPENAI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b', GEMINI_API_KEY: 'c', PERPLEXITY_API_KEY: 'd' });
  assert.equal(buildModelsRequest(p.openai).init.headers.authorization, 'Bearer a');
  assert.equal(buildModelsRequest(p.perplexity).url, 'https://api.perplexity.ai/v1/models');
  assert.equal(buildModelsRequest(p.perplexity).init.headers.authorization, 'Bearer d');
  assert.equal(buildModelsRequest(p.anthropic).init.headers['x-api-key'], 'b');
  assert.equal(buildModelsRequest(p.gemini).init.headers['x-goog-api-key'], 'c');
});

test('extractErrorMessage handles each provider’s error shape', () => {
  assert.equal(extractErrorMessage('{"error":{"message":"Bad key"}}', 401), 'HTTP 401: Bad key');
  assert.equal(
    extractErrorMessage('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 529),
    'HTTP 529: Overloaded',
  );
  assert.equal(extractErrorMessage('[{"error":{"code":400,"message":"Bad model"}}]', 400), 'HTTP 400: Bad model');
  assert.equal(extractErrorMessage('{"detail":"Nope"}', 403), 'HTTP 403: Nope');
  assert.equal(extractErrorMessage('<html>gateway</html>', 502), 'HTTP 502: <html>gateway</html>');
  assert.equal(extractErrorMessage('', 500), 'HTTP 500');
});

// ---------------------------------------------------------------------------
// Conversations (follow-up questions)
// ---------------------------------------------------------------------------

const history = [
  { role: 'user', content: 'Q1' },
  { role: 'assistant', content: 'A1' },
  { role: 'user', content: 'Q2' },
];

test('normalizeMessages keeps user/assistant turns and accepts a plain prompt', () => {
  assert.deepEqual(normalizeMessages({ prompt: 'Hi' }), [{ role: 'user', content: 'Hi' }]);
  assert.deepEqual(
    normalizeMessages({ messages: [...history, { role: 'system', content: 'x' }, { role: 'user', content: '' }, null] }),
    history,
  );
});

test('a conversation is sent in each API’s own shape', () => {
  const env = { OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'k', PERPLEXITY_API_KEY: 'k' };
  const p = byId(env);
  const body = (id) => JSON.parse(buildChatRequest(p[id], { model: 'm', messages: history, system: 'S', maxTokens: 50 }).init.body);

  assert.deepEqual(body('openai').messages, [{ role: 'system', content: 'S' }, ...history]);
  assert.deepEqual(body('anthropic').messages, history);
  assert.deepEqual(body('gemini').contents, [
    { role: 'user', parts: [{ text: 'Q1' }] },
    { role: 'model', parts: [{ text: 'A1' }] },
    { role: 'user', parts: [{ text: 'Q2' }] },
  ]);
  assert.deepEqual(body('perplexity').input, [
    { type: 'message', role: 'user', content: 'Q1' },
    { type: 'message', role: 'assistant', content: 'A1' },
    { type: 'message', role: 'user', content: 'Q2' },
  ]);
  assert.equal(body('perplexity').instructions, 'S');
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

test('stream requests use each API’s streaming switch', () => {
  const env = { OPENAI_API_KEY: 'k', META_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'k', PERPLEXITY_API_KEY: 'k', KIMI_API_KEY: 'k' };
  const p = byId(env);
  const req = (id) => buildChatRequest(p[id], { model: 'm', prompt: 'Hi', maxTokens: 50, stream: true });
  const body = (id) => JSON.parse(req(id).init.body);

  assert.equal(body('openai').stream, true);
  assert.deepEqual(body('openai').stream_options, { include_usage: true });
  assert.deepEqual(body('kimi').stream_options, { include_usage: true });
  assert.equal(body('meta').stream, true);
  assert.equal('stream_options' in body('meta'), false, 'Meta does not document stream_options');
  assert.equal(body('anthropic').stream, true);
  assert.equal(body('perplexity').stream, true);
  assert.match(req('gemini').url, /:streamGenerateContent\?alt=sse$/);
  // Not streaming: none of the switches.
  const plain = JSON.parse(buildChatRequest(p.openai, { model: 'm', prompt: 'Hi' }).init.body);
  assert.equal('stream' in plain || 'stream_options' in plain, false);
});

test('SSE reader handles events split anywhere, CRLF, comments and multi-line data', () => {
  const reader = createSseReader();
  const raw = ': keep-alive\r\nevent: a\r\ndata: one\r\n\r\ndata: two\ndata: lines\n\ndata: [DONE]\n\n';
  const events = [];
  for (const ch of raw) events.push(...reader.push(ch)); // worst case: one character at a time
  events.push(...reader.end());
  assert.deepEqual(events, [
    { event: 'a', data: 'one' },
    { event: '', data: 'two\nlines' },
    { event: '', data: '[DONE]' },
  ]);
  // A final event without a trailing blank line is still delivered at the end.
  const tail = createSseReader();
  assert.deepEqual(tail.push('data: last'), []);
  assert.deepEqual(tail.end(), [{ event: '', data: 'last' }]);
});

/** Run a fake SSE body through the reader and a provider's parser. */
function streamThrough(p, raw) {
  const reader = createSseReader();
  const parser = createStreamParser(p);
  const outputs = [];
  // Feed in uneven chunks to mimic the network.
  for (let i = 0; i < raw.length; i += 7) {
    for (const ev of reader.push(raw.slice(i, i + 7))) outputs.push(...parser.feed(ev));
  }
  for (const ev of reader.end()) outputs.push(...parser.feed(ev));
  return { outputs, result: parser.finish() };
}

const sse = (events) => events.map((e) => (e.event ? `event: ${e.event}\n` : '') + `data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`).join('');

test('streams Chat Completions (OpenAI style) with a usage-only last chunk', () => {
  const raw = sse([
    { data: { model: 'gpt-x', choices: [{ delta: { role: 'assistant', content: '' } }] } },
    { data: { model: 'gpt-x', choices: [{ delta: { reasoning_content: 'hmm' } }] } },
    { data: { model: 'gpt-x', choices: [{ delta: { content: 'Hel' } }] } },
    { data: { model: 'gpt-x', choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] } },
    { data: { model: 'gpt-x', choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } } },
    { data: '[DONE]' },
  ]);
  const { outputs, result } = streamThrough(byId().openai, raw);
  assert.deepEqual(outputs, [{ type: 'thinking' }, { type: 'delta', text: 'Hel' }, { type: 'delta', text: 'lo' }]);
  assert.deepEqual(result, { text: 'Hello', model: 'gpt-x', usage: { input: 9, output: 2 }, stopReason: 'stop' });
});

test('streams Chat Completions where usage rides on the last content chunk (DeepSeek, Kimi)', () => {
  const raw = sse([
    { data: { choices: [{ delta: { content: 'Hi' } }] } },
    { data: { choices: [{ delta: { content: '!' }, finish_reason: 'stop', usage: { prompt_tokens: 3, completion_tokens: 2 } }] } },
    { data: '[DONE]' },
  ]);
  assert.deepEqual(streamThrough(byId().kimi, raw).result.usage, { input: 3, output: 2 });
});

test('streams Claude events', () => {
  const raw = sse([
    { event: 'message_start', data: { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 25, output_tokens: 1 } } } },
    { event: 'ping', data: { type: 'ping' } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '...' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'there' } } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 15 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
  const { outputs, result } = streamThrough(byId().anthropic, raw);
  assert.equal(outputs[0].type, 'thinking');
  assert.deepEqual(result, { text: 'Hi there', model: 'claude-x', usage: { input: 25, output: 15 }, stopReason: 'end_turn' });
});

test('a Claude error event fails the stream', () => {
  const raw = sse([{ event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }]);
  assert.throws(() => streamThrough(byId().anthropic, raw), /Overloaded/);
});

test('streams Gemini, skipping thought parts and counting thinking tokens as output', () => {
  const raw = sse([
    { data: { candidates: [{ content: { parts: [{ text: 'planning', thought: true }] } }] } },
    { data: { candidates: [{ content: { parts: [{ text: 'Snow ' }] } }] } },
    {
      data: {
        modelVersion: 'gemini-x-001',
        candidates: [{ content: { parts: [{ text: 'falls' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 10 },
      },
    },
  ]);
  const { result } = streamThrough(byId().gemini, raw);
  assert.deepEqual(result, { text: 'Snow falls', model: 'gemini-x-001', usage: { input: 4, output: 12 }, stopReason: 'STOP' });
});

test('streams Perplexity Agent API events with sources from the completed response', () => {
  const raw = sse([
    { data: { type: 'response.created', response: { status: 'in_progress' } } },
    { data: { type: 'response.output_text.delta', delta: 'Grounded ' } },
    { data: { type: 'response.output_text.delta', delta: 'answer' } },
    {
      data: {
        type: 'response.completed',
        response: {
          model: 'perplexity/sonar',
          status: 'completed',
          output: [
            { type: 'search_results', results: [{ title: 'Src', url: 'https://src.example' }] },
            { type: 'message', content: [{ type: 'output_text', text: 'Grounded answer' }] },
          ],
          usage: { input_tokens: 11, output_tokens: 4 },
        },
      },
    },
  ]);
  const { result } = streamThrough(byId().perplexity, raw);
  assert.deepEqual(result, {
    text: 'Grounded answer',
    model: 'perplexity/sonar',
    usage: { input: 11, output: 4 },
    stopReason: undefined,
    sources: [{ title: 'Src', url: 'https://src.example' }],
  });
  assert.throws(
    () => streamThrough(byId().perplexity, sse([{ data: { type: 'response.failed', response: { error: { message: 'Quota exceeded' } } } }])),
    /Quota exceeded/,
  );
});

test('non-streamed Gemini answers also count thinking tokens as output', () => {
  const out = parseChatResponse(byId().gemini, {
    candidates: [{ content: { parts: [{ text: 'x' }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: 30 },
  });
  assert.deepEqual(out.usage, { input: 1, output: 32 });
});
