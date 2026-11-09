// Provider definitions and request/response adapters.
//
// Everything in this file is a pure function of its inputs (no network, no
// globals) so it can be unit tested without API keys. server.js does the
// actual fetching.

// OpenAI's /models endpoint also lists embedding, audio, image and moderation
// models. Hide those from the chat model picker.
const OPENAI_NON_CHAT =
  /(embed|whisper|tts|dall-e|davinci|babbage|moderation|transcribe|realtime|audio|image|search|computer-use|sora)/i;

// `api` picks the wire format:
//   openai      Chat Completions (OpenAI, Meta, Grok, DeepSeek, Kimi)
// `streamUsage` providers accept stream_options.include_usage (token counts in a stream).
//   anthropic   Anthropic Messages API
//   gemini      Google generateContent
//   perplexity  Perplexity Agent API (Responses format, with web search)
// `models` are suggestions shown when the provider's live model list can't be loaded.
export const PROVIDERS = [
  {
    id: 'openai',
    streamUsage: true,
    name: 'OpenAI',
    vendor: 'OpenAI',
    api: 'openai',
    keyEnv: ['OPENAI_API_KEY'],
    baseUrlEnv: 'OPENAI_BASE_URL',
    baseUrl: 'https://api.openai.com/v1',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-6-astra',
    models: ['gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna'],
    keyUrl: 'https://platform.openai.com/api-keys',
    modelFilter: (id) => !OPENAI_NON_CHAT.test(id),
  },
  {
    id: 'anthropic',
    name: 'Claude',
    vendor: 'Anthropic',
    api: 'anthropic',
    keyEnv: ['ANTHROPIC_API_KEY'],
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    baseUrl: 'https://api.anthropic.com',
    modelEnv: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'meta',
    name: 'Meta',
    vendor: 'Meta',
    api: 'openai',
    keyEnv: ['META_API_KEY', 'MODEL_API_KEY'],
    baseUrlEnv: 'META_BASE_URL',
    baseUrl: 'https://api.meta.ai/v1',
    modelEnv: 'META_MODEL',
    defaultModel: 'muse-spark-1.3',
    models: ['muse-spark-1.3', 'muse-wonder-1.0'],
    keyUrl: 'https://dev.meta.ai/',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    vendor: 'Google',
    api: 'gemini',
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    baseUrlEnv: 'GEMINI_BASE_URL',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-4-argon',
    models: ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'xai',
    streamUsage: true,
    name: 'Grok',
    vendor: 'xAI',
    api: 'openai',
    keyEnv: ['XAI_API_KEY'],
    baseUrlEnv: 'XAI_BASE_URL',
    baseUrl: 'https://api.x.ai/v1',
    modelEnv: 'XAI_MODEL',
    defaultModel: 'grok-4.7',
    models: ['grok-4.7', 'grok-4.3'],
    keyUrl: 'https://console.x.ai/',
  },
  {
    id: 'deepseek',
    streamUsage: true,
    name: 'DeepSeek',
    vendor: 'DeepSeek',
    api: 'openai',
    keyEnv: ['DEEPSEEK_API_KEY'],
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    baseUrl: 'https://api.deepseek.com',
    modelEnv: 'DEEPSEEK_MODEL',
    defaultModel: 'deepseek-v4-pro',
    models: ['deepseek-v4-pro', 'deepseek-flash'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    vendor: 'Perplexity',
    api: 'perplexity',
    keyEnv: ['PERPLEXITY_API_KEY'],
    baseUrlEnv: 'PERPLEXITY_BASE_URL',
    baseUrl: 'https://api.perplexity.ai/v1',
    modelEnv: 'PERPLEXITY_MODEL',
    defaultModel: 'perplexity/sonar',
    models: ['perplexity/sonar', 'perplexity/glm-5.3-flash'],
    keyUrl: 'https://console.perplexity.ai/',
  },
  {
    id: 'kimi',
    streamUsage: true,
    name: 'Kimi',
    vendor: 'Moonshot AI',
    api: 'openai',
    keyEnv: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
    baseUrlEnv: 'KIMI_BASE_URL',
    baseUrl: 'https://api.moonshot.ai/v1',
    modelEnv: 'KIMI_MODEL',
    defaultModel: 'kimi-k3.1-pro',
    models: ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3'],
    keyUrl: 'https://platform.kimi.ai/console/api-keys',
  },
];

/** Every provider-related variable name (keys, models, base URLs). */
export function providerVariables() {
  return PROVIDERS.flatMap((p) => [...p.keyEnv, p.modelEnv, p.baseUrlEnv]);
}

/** True for variables that hold a secret and must be masked when shown. */
export function isSecretVariable(name) {
  return PROVIDERS.some((p) => p.keyEnv.includes(name));
}

/**
 * Resolve each provider against an environment object (normally process.env).
 * Returns provider objects with `apiKey`, `baseUrl` and `defaultModel` filled in.
 */
export function resolveProviders(env) {
  return PROVIDERS.map((p) => {
    const keyName = p.keyEnv.find((name) => env[name]);
    return {
      ...p,
      apiKey: keyName ? env[keyName] : '',
      baseUrl: trimSlash(env[p.baseUrlEnv] || p.baseUrl),
      defaultModel: env[p.modelEnv] || p.defaultModel,
    };
  });
}

/** What the browser is allowed to see about a provider (never the key). */
export function publicInfo(p) {
  return {
    id: p.id,
    name: p.name,
    vendor: p.vendor,
    configured: Boolean(p.apiKey),
    defaultModel: p.defaultModel,
    models: p.models,
    keyEnv: p.keyEnv[0],
    keyUrl: p.keyUrl,
  };
}

function trimSlash(url) {
  return url.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Chat requests
// ---------------------------------------------------------------------------

/**
 * The conversation to send: earlier turns plus the new question, as
 * [{role: 'user' | 'assistant', content}]. A plain `prompt` is a one-turn conversation.
 */
export function normalizeMessages({ prompt, messages }) {
  if (Array.isArray(messages) && messages.length) {
    return messages
      .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content)
      .map((m) => ({ role: m.role, content: m.content }));
  }
  return typeof prompt === 'string' && prompt ? [{ role: 'user', content: prompt }] : [];
}

/**
 * Build the HTTP request for a conversation (or a single prompt).
 * With `stream`, the provider sends the answer piece by piece (see createStreamParser).
 * @returns {{url: string, init: RequestInit}}
 */
export function buildChatRequest(p, { model, prompt, messages, system, maxTokens, stream = false }) {
  const turns = normalizeMessages({ prompt, messages });
  switch (p.api) {
    case 'anthropic':
      return {
        url: `${p.baseUrl}/v1/messages`,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': p.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            // max_tokens is required by the Messages API.
            max_tokens: maxTokens,
            ...(system ? { system } : {}),
            messages: turns,
            ...(stream ? { stream: true } : {}),
          }),
        },
      };

    case 'gemini': {
      const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
      return {
        url: `${p.baseUrl}/models/${encodeURIComponent(stripModelsPrefix(model))}:${method}`,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': p.apiKey,
          },
          body: JSON.stringify({
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents: turns.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          }),
        },
      };
    }

    case 'perplexity':
      // Perplexity's Agent API. Web search is opt-in, so always turn it on:
      // grounded, cited answers are the reason to pick Perplexity.
      return {
        url: `${p.baseUrl}/agent`,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${p.apiKey}`,
          },
          body: JSON.stringify({
            model,
            // One question is a plain string; a conversation is a list of message items.
            input:
              turns.length === 1 ? turns[0].content : turns.map((m) => ({ type: 'message', role: m.role, content: m.content })),
            ...(system ? { instructions: system } : {}),
            tools: [{ type: 'web_search' }],
            // The Agent API requires an output limit for anthropic/* models.
            ...(model.startsWith('anthropic/') ? { max_output_tokens: maxTokens } : {}),
            ...(stream ? { stream: true } : {}),
          }),
        },
      };

    case 'openai':
      // OpenAI, xAI, Meta, DeepSeek and Kimi all speak the Chat Completions format.
      // No temperature / max_tokens: several current reasoning models reject them.
      return {
        url: `${p.baseUrl}/chat/completions`,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${p.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [...(system ? [{ role: 'system', content: system }] : []), ...turns],
            ...(stream ? { stream: true } : {}),
            // Token counts in a stream must be asked for. Only sent to providers
            // that document it (Meta's API doesn't).
            ...(stream && p.streamUsage ? { stream_options: { include_usage: true } } : {}),
          }),
        },
      };

    default:
      throw new Error(`Unknown provider api: ${p.api}`);
  }
}

/**
 * Normalize a successful chat response.
 * @returns {{text: string, model: string|undefined, usage: {input?: number, output?: number}, stopReason?: string, sources?: {title: string, url: string}[]}}
 */
export function parseChatResponse(p, json) {
  switch (p.api) {
    case 'anthropic': {
      const text = (json.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return {
        text,
        model: json.model,
        usage: { input: json.usage?.input_tokens, output: json.usage?.output_tokens },
        stopReason: json.stop_reason,
      };
    }

    case 'gemini': {
      if (json.promptFeedback?.blockReason && !json.candidates?.length) {
        throw new Error(`Prompt blocked by Gemini: ${json.promptFeedback.blockReason}`);
      }
      const candidate = json.candidates?.[0];
      const text = (candidate?.content?.parts || [])
        .filter((part) => typeof part.text === 'string' && !part.thought)
        .map((part) => part.text)
        .join('');
      return {
        text,
        model: json.modelVersion,
        usage: geminiUsage(json.usageMetadata),
        stopReason: candidate?.finishReason,
      };
    }

    case 'perplexity': {
      if (json.error?.message) throw new Error(json.error.message);
      const output = Array.isArray(json.output) ? json.output : [];
      const text = output
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content || [])
        .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
      const results = output.filter((item) => item.type === 'search_results').flatMap((item) => item.results || []);
      return {
        text,
        model: json.model,
        usage: { input: json.usage?.input_tokens, output: json.usage?.output_tokens },
        stopReason: json.status === 'incomplete' ? 'max_tokens' : undefined,
        sources: cleanSources(results.map((r) => ({ title: r.title, url: r.url }))),
      };
    }

    case 'openai': {
      const choice = json.choices?.[0];
      // Some compatible APIs return web citations as url_citation annotations.
      const annotations = Array.isArray(choice?.message?.annotations) ? choice.message.annotations : [];
      const sources = cleanSources(
        annotations
          .filter((a) => a?.type === 'url_citation')
          .map((a) => ({ title: a.url_citation?.title, url: a.url_citation?.url })),
      );
      return {
        text: contentToText(choice?.message?.content),
        model: json.model,
        usage: { input: json.usage?.prompt_tokens, output: json.usage?.completion_tokens },
        stopReason: choice?.finish_reason,
        ...(sources.length ? { sources } : {}),
      };
    }

    default:
      throw new Error(`Unknown provider api: ${p.api}`);
  }
}

/** Gemini bills its "thinking" tokens as output, so count them as output. */
function geminiUsage(meta) {
  if (!meta) return { input: undefined, output: undefined };
  const output = meta.candidatesTokenCount == null && meta.thoughtsTokenCount == null
    ? undefined
    : (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0);
  return { input: meta.promptTokenCount, output };
}

/** Keep only http(s) links, de-duplicated, with a readable title. */
function cleanSources(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (typeof s?.url !== 'string' || !/^https?:\/\//i.test(s.url) || seen.has(s.url)) continue;
    seen.add(s.url);
    const title = typeof s.title === 'string' && s.title.trim() ? s.title.trim() : s.url;
    out.push({ title, url: s.url });
  }
  return out;
}

// Chat Completions content is usually a string, but some compatible APIs
// return an array of parts or a {type, text} object.
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentToText).join('');
  if (content && typeof content.text === 'string') return content.text;
  return '';
}

function stripModelsPrefix(model) {
  return model.replace(/^models\//, '');
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Split a server-sent events stream into events. Feed it text as it arrives;
 * it returns the complete events ({event, data}) found so far.
 */
export function createSseReader() {
  let buffer = '';
  let event = '';
  let data = [];
  const ready = [];
  const line = (text) => {
    if (text === '') {
      if (data.length) ready.push({ event, data: data.join('\n') });
      event = '';
      data = [];
      return;
    }
    if (text.startsWith(':')) return; // comment / keep-alive
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };
  return {
    push(text) {
      buffer += text;
      // A "\r" at the very end may be the first half of "\r\n": wait for more.
      const hold = buffer.endsWith('\r') ? 1 : 0;
      const lines = buffer.slice(0, buffer.length - hold).split(/\r\n|\r|\n/);
      buffer = lines.pop() + buffer.slice(buffer.length - hold);
      for (const l of lines) line(l);
      return ready.splice(0);
    },
    end() {
      if (buffer) line(buffer.replace(/\r$/, ''));
      buffer = '';
      line('');
      return ready.splice(0);
    },
  };
}

/**
 * Turns one provider's stream events into answer text.
 *   feed({event, data}) -> [{type: 'delta', text} | {type: 'thinking'}]   (throws on an error event)
 *   finish()            -> {text, model, usage, stopReason, sources}
 */
export function createStreamParser(p) {
  let text = '';
  let model;
  let stopReason;
  let sources = [];
  const usage = { input: undefined, output: undefined };
  const out = [];
  const addText = (t) => {
    if (typeof t === 'string' && t) {
      text += t;
      out.push({ type: 'delta', text: t });
    }
  };
  const parse = (data) => {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  };

  const handlers = {
    openai({ data }) {
      if (data === '[DONE]') return;
      const json = parse(data);
      if (!json) return;
      if (json.error) throw new Error(json.error.message || 'The provider reported an error');
      if (json.model) model = json.model;
      const choice = json.choices?.[0];
      // Usage arrives on the last chunk (or a final chunk with no choices).
      const u = json.usage || choice?.usage;
      if (u) {
        if (u.prompt_tokens != null) usage.input = u.prompt_tokens;
        if (u.completion_tokens != null) usage.output = u.completion_tokens;
      }
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      const delta = choice?.delta || {};
      if (delta.reasoning_content || delta.reasoning) out.push({ type: 'thinking' });
      addText(contentToText(delta.content));
      if (Array.isArray(delta.annotations)) {
        sources = cleanSources([
          ...sources,
          ...delta.annotations
            .filter((a) => a?.type === 'url_citation')
            .map((a) => ({ title: a.url_citation?.title, url: a.url_citation?.url })),
        ]);
      }
    },

    anthropic({ event, data }) {
      const json = parse(data);
      if (!json) return;
      switch (json.type || event) {
        case 'message_start':
          model = json.message?.model || model;
          if (json.message?.usage?.input_tokens != null) usage.input = json.message.usage.input_tokens;
          if (json.message?.usage?.output_tokens != null) usage.output = json.message.usage.output_tokens;
          break;
        case 'content_block_delta':
          if (json.delta?.type === 'text_delta') addText(json.delta.text);
          else if (json.delta?.type === 'thinking_delta') out.push({ type: 'thinking' });
          break;
        case 'message_delta':
          // These counts are cumulative, so the last one wins.
          if (json.usage?.output_tokens != null) usage.output = json.usage.output_tokens;
          if (json.usage?.input_tokens != null) usage.input = json.usage.input_tokens;
          if (json.delta?.stop_reason) stopReason = json.delta.stop_reason;
          break;
        case 'error':
          throw new Error(json.error?.message || 'Claude reported an error');
      }
    },

    gemini({ data }) {
      const json = parse(data);
      if (!json) return;
      if (json.error) throw new Error(json.error.message || 'Gemini reported an error');
      if (json.promptFeedback?.blockReason && !json.candidates?.length) {
        throw new Error(`Prompt blocked by Gemini: ${json.promptFeedback.blockReason}`);
      }
      if (json.modelVersion) model = json.modelVersion;
      if (json.usageMetadata) Object.assign(usage, geminiUsage(json.usageMetadata));
      const candidate = json.candidates?.[0];
      if (candidate?.finishReason) stopReason = candidate.finishReason;
      for (const part of candidate?.content?.parts || []) {
        if (part.thought) out.push({ type: 'thinking' });
        else addText(part.text);
      }
    },

    perplexity({ data }) {
      const json = parse(data);
      if (!json) return;
      switch (json.type) {
        case 'response.output_text.delta':
          addText(json.delta);
          break;
        case 'response.completed': {
          const final = parseChatResponse(p, json.response || {});
          if (!text) addText(final.text);
          model = final.model || model;
          Object.assign(usage, final.usage);
          stopReason = final.stopReason;
          sources = final.sources || [];
          break;
        }
        case 'response.failed':
          throw new Error(json.response?.error?.message || json.error?.message || 'Perplexity reported an error');
        default:
          if (String(json.type).startsWith('response.reasoning')) out.push({ type: 'thinking' });
      }
    },
  };
  const handle = handlers[p.api];
  if (!handle) throw new Error(`Unknown provider api: ${p.api}`);

  return {
    feed(event) {
      handle(event);
      return out.splice(0);
    },
    finish() {
      return { text, model, usage, stopReason, ...(sources.length ? { sources } : {}) };
    },
  };
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

export function buildModelsRequest(p) {
  switch (p.api) {
    case 'anthropic':
      return {
        url: `${p.baseUrl}/v1/models?limit=100`,
        init: { headers: { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' } },
      };
    case 'gemini':
      return {
        url: `${p.baseUrl}/models?pageSize=1000`,
        init: { headers: { 'x-goog-api-key': p.apiKey } },
      };
    case 'openai':
    case 'perplexity':
      return {
        url: `${p.baseUrl}/models`,
        init: { headers: { authorization: `Bearer ${p.apiKey}` } },
      };
    default:
      throw new Error(`Unknown provider api: ${p.api}`);
  }
}

/** @returns {string[]} sorted, de-duplicated chat model IDs */
export function parseModelsResponse(p, json) {
  let ids;
  if (p.api === 'gemini') {
    ids = (json.models || [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => stripModelsPrefix(m.name || ''));
  } else {
    ids = (json.data || []).map((m) => m.id);
  }
  ids = ids.filter((id) => typeof id === 'string' && id);
  if (p.modelFilter) ids = ids.filter(p.modelFilter);
  return [...new Set(ids)].sort();
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Pull a human-readable message out of a provider error body. */
export function extractErrorMessage(body, status) {
  let json;
  try {
    json = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    json = undefined;
  }
  // Some APIs wrap the error in an array (e.g. [{error: {...}}]).
  if (Array.isArray(json)) json = json[0];
  const msg =
    json?.error?.message ||
    (typeof json?.error === 'string' ? json.error : undefined) ||
    json?.message ||
    (typeof json?.detail === 'string' ? json.detail : undefined);
  if (msg) return `HTTP ${status}: ${msg}`;
  const text = typeof body === 'string' ? body.trim().slice(0, 300) : '';
  return text ? `HTTP ${status}: ${text}` : `HTTP ${status}`;
}
