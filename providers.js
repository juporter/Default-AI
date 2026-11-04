// Provider definitions and request/response adapters.
//
// Everything in this file is a pure function of its inputs (no network, no
// globals) so it can be unit tested without API keys. server.js does the
// actual fetching.

// OpenAI's /models endpoint also lists embedding, audio, image and moderation
// models. Hide those from the chat model picker.
const OPENAI_NON_CHAT =
  /(embed|whisper|tts|dall-e|davinci|babbage|moderation|transcribe|realtime|audio|image|search|computer-use|sora)/i;

export const PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    vendor: 'OpenAI',
    api: 'openai',
    keyEnv: ['OPENAI_API_KEY'],
    baseUrlEnv: 'OPENAI_BASE_URL',
    baseUrl: 'https://api.openai.com/v1',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-6-astra',
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
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'xai',
    name: 'Grok',
    vendor: 'xAI',
    api: 'openai',
    keyEnv: ['XAI_API_KEY'],
    baseUrlEnv: 'XAI_BASE_URL',
    baseUrl: 'https://api.x.ai/v1',
    modelEnv: 'XAI_MODEL',
    defaultModel: 'grok-4.7',
    keyUrl: 'https://console.x.ai/',
  },
];

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
 * Build the HTTP request for a single-turn prompt.
 * @returns {{url: string, init: RequestInit}}
 */
export function buildChatRequest(p, { model, prompt, system, maxTokens }) {
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
            messages: [{ role: 'user', content: prompt }],
          }),
        },
      };

    case 'gemini':
      return {
        url: `${p.baseUrl}/models/${encodeURIComponent(stripModelsPrefix(model))}:generateContent`,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': p.apiKey,
          },
          body: JSON.stringify({
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
          }),
        },
      };

    case 'openai':
      // OpenAI, xAI and Meta's Model API all speak the Chat Completions format.
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
            messages: [
              ...(system ? [{ role: 'system', content: system }] : []),
              { role: 'user', content: prompt },
            ],
          }),
        },
      };

    default:
      throw new Error(`Unknown provider api: ${p.api}`);
  }
}

/**
 * Normalize a successful chat response.
 * @returns {{text: string, model: string|undefined, usage: {input?: number, output?: number}, stopReason?: string}}
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
        usage: {
          input: json.usageMetadata?.promptTokenCount,
          output: json.usageMetadata?.candidatesTokenCount,
        },
        stopReason: candidate?.finishReason,
      };
    }

    case 'openai': {
      const choice = json.choices?.[0];
      return {
        text: contentToText(choice?.message?.content),
        model: json.model,
        usage: { input: json.usage?.prompt_tokens, output: json.usage?.completion_tokens },
        stopReason: choice?.finish_reason,
      };
    }

    default:
      throw new Error(`Unknown provider api: ${p.api}`);
  }
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
