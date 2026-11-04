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
