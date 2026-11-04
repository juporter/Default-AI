// Read chat-history exports from other AI apps (and this app's own export)
// into one shape. Runs in the browser and in Node (for tests); no dependencies.
//
// Imported conversation:
//   { id, source, title, createdAt, messages: [{ role: 'user'|'assistant', text, createdAt }] }
//
// Supported files:
//   ChatGPT   Settings → Data controls → Export: the .zip, or conversations.json from it
//   Claude    Settings → Privacy → Export data: the .zip, or conversations.json from it
//   Gemini    Google Takeout → "My Activity" → Gemini Apps, JSON format: the .zip or MyActivity.json
//   Generic   JSON: [{ title, messages: [{ role, content }] }] or { conversations: [...] }
//   This app  the file made by History → Export

export const APP_EXPORT_FORMAT = 'default-ai-history';

export const SOURCES = {
  app: 'This app',
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  other: 'Other',
};

/**
 * Read an uploaded file (a File/Blob, or anything with name + arrayBuffer()).
 * @returns {Promise<{kind: 'app', runs: object[], conversations: object[]} | {kind: 'conversations', source: string, conversations: object[]}>}
 */
export async function readImportFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text;
  let name = file.name || '';

  if (isZip(bytes)) {
    const entries = listZipEntries(bytes);
    const entry = pickExportEntry(entries);
    if (!entry) {
      throw new Error(
        'This .zip has no conversations.json or MyActivity.json. Upload the export .zip from ChatGPT, Claude or Google Takeout.',
      );
    }
    text = decodeText(await readZipEntry(bytes, entry));
    name = entry.name;
  } else {
    text = decodeText(bytes);
  }

  if (/^\s*</.test(text)) {
    throw new Error('This looks like an HTML file. In Google Takeout, choose JSON as the format for My Activity.');
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("it isn't a chat export. Choose the .zip or .json file from ChatGPT, Claude, Google Takeout or Export history.");
  }
  return parseExport(json);
}

/** Detect the format of already-parsed JSON and normalize it. */
export function parseExport(json) {
  if (json && json.format === APP_EXPORT_FORMAT) {
    return {
      kind: 'app',
      runs: (Array.isArray(json.runs) ? json.runs : []).map(cleanRun).filter(Boolean),
      conversations: (Array.isArray(json.conversations) ? json.conversations : []).map(cleanConversation).filter(Boolean),
    };
  }

  const list = Array.isArray(json) ? json : Array.isArray(json?.conversations) ? json.conversations : null;
  if (!list) throw new Error("This file doesn't look like a chat history export.");

  const sample = list.find((item) => item && typeof item === 'object');
  if (!sample) return { kind: 'conversations', source: 'other', conversations: [] };

  if ('mapping' in sample) return { kind: 'conversations', source: 'chatgpt', conversations: parseChatGPT(list) };
  if ('chat_messages' in sample) return { kind: 'conversations', source: 'claude', conversations: parseClaude(list) };
  if (isGeminiActivity(sample)) return { kind: 'conversations', source: 'gemini', conversations: parseGemini(list) };
  if (Array.isArray(sample.messages)) return { kind: 'conversations', source: 'other', conversations: parseGeneric(list) };

  throw new Error("This file doesn't look like a chat history export.");
}

// ---------------------------------------------------------------------------
// ChatGPT: conversations are trees ("mapping"); follow the visible branch.
// ---------------------------------------------------------------------------

export function parseChatGPT(list) {
  return list
    .map((c, i) => {
      const mapping = c?.mapping && typeof c.mapping === 'object' ? c.mapping : {};
      let nodeId = c.current_node in mapping ? c.current_node : lastLeaf(mapping);
      const chain = [];
      const seen = new Set();
      while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
        seen.add(nodeId);
        chain.push(mapping[nodeId]);
        nodeId = mapping[nodeId].parent;
      }
      chain.reverse();

      const messages = [];
      for (const node of chain) {
        const m = node.message;
        const role = m?.author?.role;
        if (role !== 'user' && role !== 'assistant') continue; // skip system and tool messages
        if (m.metadata?.is_visually_hidden_from_conversation) continue;
        const text = chatgptText(m.content);
        if (text.trim()) messages.push({ role, text, createdAt: epochToIso(m.create_time) });
      }
      return conversation('chatgpt', c.id || c.conversation_id || `${i}`, c.title, epochToIso(c.create_time), messages);
    })
    .filter((c) => c.messages.length);
}

function lastLeaf(mapping) {
  const leaves = Object.values(mapping).filter((n) => !(n.children || []).length);
  leaves.sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));
  return leaves.at(-1)?.id;
}

function chatgptText(content) {
  if (!content) return '';
  if (Array.isArray(content.parts)) {
    return content.parts
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return typeof content.text === 'string' ? content.text : '';
}

// ---------------------------------------------------------------------------
// Claude: flat list of chat_messages with sender "human" | "assistant".
// ---------------------------------------------------------------------------

export function parseClaude(list) {
  return list
    .map((c, i) => {
      const messages = (Array.isArray(c?.chat_messages) ? c.chat_messages : [])
        .map((m) => ({
          role: m.sender === 'human' ? 'user' : 'assistant',
          text: claudeText(m),
          createdAt: isoOrNull(m.created_at),
        }))
        .filter((m) => m.text.trim());
      return conversation('claude', c.uuid || `${i}`, c.name, isoOrNull(c.created_at), messages);
    })
    .filter((c) => c.messages.length);
}

function claudeText(m) {
  if (typeof m.text === 'string' && m.text.trim()) return m.text;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Gemini (Google Takeout "My Activity"): one entry per prompt, answer as HTML.
// ---------------------------------------------------------------------------

function isGeminiActivity(item) {
  const products = Array.isArray(item.products) ? item.products.join(' ') : '';
  return typeof item.title === 'string' && 'time' in item && /gemini|bard/i.test(`${item.header || ''} ${products}`);
}

export function parseGemini(list) {
  return list
    .filter((item) => item && isGeminiActivity(item))
    .map((item, i) => {
      const prompt = item.title.replace(/^Prompted\s+/, '').trim();
      const answer = (Array.isArray(item.safeHtmlItem) ? item.safeHtmlItem : [])
        .map((part) => htmlToText(part?.html || ''))
        .filter(Boolean)
        .join('\n\n');
      const createdAt = isoOrNull(item.time);
      const messages = [];
      if (prompt) messages.push({ role: 'user', text: prompt, createdAt });
      if (answer) messages.push({ role: 'assistant', text: answer, createdAt });
      return conversation('gemini', `${item.time || ''}-${i}`, prompt.slice(0, 80), createdAt, messages);
    })
    .filter((c) => c.messages.some((m) => m.role === 'user'));
}

/** Turn a snippet of answer HTML into readable text (no DOM needed). */
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(li|tr)>/gi, '')
    .replace(/<\/(p|div|h[1-6]|ul|ol|pre|blockquote|table)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (_, code) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
      const key = code.toLowerCase();
      if (key in named) return named[key];
      const n = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Generic: [{ title, messages: [{ role, content | text }] }]
// ---------------------------------------------------------------------------

const ROLE_ALIASES = { user: 'user', human: 'user', assistant: 'assistant', model: 'assistant', ai: 'assistant', bot: 'assistant' };

export function parseGeneric(list) {
  return list
    .map((c, i) => {
      const messages = (Array.isArray(c?.messages) ? c.messages : [])
        .map((m) => ({
          role: ROLE_ALIASES[String(m?.role || m?.sender || m?.author || '').toLowerCase()],
          text: genericText(m?.content ?? m?.text),
          createdAt: isoOrNull(m?.createdAt ?? m?.created_at ?? m?.timestamp),
        }))
        .filter((m) => m.role && m.text.trim());
      return conversation('other', c.id || `${i}`, c.title || c.name, isoOrNull(c.createdAt ?? c.created_at), messages);
    })
    .filter((c) => c.messages.length);
}

function genericText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(genericText).filter(Boolean).join('\n');
  if (content && typeof content.text === 'string') return content.text;
  return '';
}

// ---------------------------------------------------------------------------
// This app's own export
// ---------------------------------------------------------------------------

/** Build the JSON written by History → Export. */
export function buildAppExport(runs, conversations, now = new Date()) {
  return { format: APP_EXPORT_FORMAT, version: 1, exportedAt: now.toISOString(), runs, conversations };
}

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function cleanRun(run) {
  if (!run || typeof run !== 'object' || typeof run.prompt !== 'string' || !run.id) return null;
  return {
    id: str(String(run.id)),
    createdAt: isoOrNull(run.createdAt) || new Date(0).toISOString(),
    prompt: run.prompt,
    system: str(run.system),
    attachments: (Array.isArray(run.attachments) ? run.attachments : []).map((a) => ({
      name: str(a?.name, 'file'),
      size: num(a?.size) ?? 0,
      text: str(a?.text),
    })),
    responses: (Array.isArray(run.responses) ? run.responses : []).map((r) => ({
      provider: str(r?.provider),
      providerName: str(r?.providerName, str(r?.provider)),
      model: str(r?.model),
      text: str(r?.text),
      error: str(r?.error),
      seconds: num(r?.seconds),
      usage: { input: num(r?.usage?.input), output: num(r?.usage?.output) },
      stopReason: str(r?.stopReason),
      sources: (Array.isArray(r?.sources) ? r.sources : [])
        .filter((s) => typeof s?.url === 'string' && /^https?:\/\//i.test(s.url))
        .map((s) => ({ title: str(s.title, s.url), url: s.url })),
    })),
  };
}

function cleanConversation(c) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.messages)) return null;
  const source = c.source in SOURCES && c.source !== 'app' ? c.source : 'other';
  const messages = c.messages
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.text === 'string')
    .map((m) => ({ role: m.role, text: m.text, createdAt: isoOrNull(m.createdAt) }));
  if (!messages.length) return null;
  const id = String(c.id || '').replace(/^[a-z]+:/, '');
  return conversation(source, id, c.title, isoOrNull(c.createdAt), messages);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function conversation(source, id, title, createdAt, messages) {
  const firstPrompt = messages.find((m) => m.role === 'user')?.text || '';
  return {
    id: `${source}:${id}`,
    source,
    title: (typeof title === 'string' && title.trim()) || firstPrompt.slice(0, 80) || 'Untitled',
    createdAt: createdAt || messages.find((m) => m.createdAt)?.createdAt || null,
    messages,
  };
}

function epochToIso(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function isoOrNull(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function decodeText(bytes) {
  return new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
}

// ---------------------------------------------------------------------------
// Minimal .zip reader (stored and deflate entries, including ZIP64), using
// the platform's DecompressionStream for inflating.
// ---------------------------------------------------------------------------

export function isZip(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function listZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This .zip file can't be read (no central directory).");

  let count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === 0xffffffff || count === 0xffff) {
    const locator = eocd - 20;
    if (locator >= 0 && view.getUint32(locator, true) === 0x07064b50) {
      const zip64 = Number(view.getBigUint64(locator + 8, true));
      if (view.getUint32(zip64, true) === 0x06064b50) {
        count = Number(view.getBigUint64(zip64 + 32, true));
        offset = Number(view.getBigUint64(zip64 + 48, true));
      }
    }
  }

  const entries = [];
  let p = offset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) {
      throw new Error("This .zip file can't be read (damaged directory).");
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    let compressedSize = view.getUint32(p + 20, true);
    let size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    let localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength));

    let e = p + 46 + nameLength;
    const extraEnd = e + extraLength;
    while (e + 4 <= extraEnd) {
      const id = view.getUint16(e, true);
      const len = view.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) (size = Number(view.getBigUint64(q, true))), (q += 8);
        if (compressedSize === 0xffffffff) (compressedSize = Number(view.getBigUint64(q, true))), (q += 8);
        if (localOffset === 0xffffffff) localOffset = Number(view.getBigUint64(q, true));
      }
      e += 4 + len;
    }
    entries.push({ name, method, compressedSize, size, localOffset, encrypted: Boolean(flags & 1) });
    p = extraEnd + commentLength;
  }
  return entries;
}

export async function readZipEntry(bytes, entry) {
  if (entry.encrypted) throw new Error(`${entry.name} is password-protected.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localOffset;
  if (view.getUint32(at, true) !== 0x04034b50) throw new Error("This .zip file can't be read (damaged entry).");
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error(`${entry.name} uses a compression method this app can't read.`);
}

/** Choose the file inside an export .zip that holds the conversations. */
export function pickExportEntry(entries) {
  const files = entries.filter((e) => !e.name.endsWith('/') && !/(^|\/)__MACOSX\//.test(e.name));
  const base = (e) => e.name.split('/').pop().toLowerCase();
  return (
    files.find((e) => base(e) === 'conversations.json') ||
    files.find((e) => /gemini|bard/i.test(e.name) && base(e).endsWith('.json')) ||
    files.find((e) => base(e) === 'myactivity.json') ||
    (files.filter((e) => base(e).endsWith('.json')).length === 1 ? files.find((e) => base(e).endsWith('.json')) : undefined)
  );
}
