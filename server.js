#!/usr/bin/env node
// Multi-LLM prompt server.
//
// Serves the web UI from ./public and proxies prompts to each provider so the
// API keys stay on the server and are never sent to the browser.
//
//   GET  /api/providers           which providers exist / are configured
//   GET  /api/models?provider=id  live model list from the provider
//   POST /api/chat                {provider, model, prompt, system} -> answer

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  resolveProviders,
  publicInfo,
  buildChatRequest,
  parseChatResponse,
  buildModelsRequest,
  parseModelsResponse,
  extractErrorMessage,
} from './providers.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const MAX_BODY_BYTES = 1_000_000;
const MODEL_CACHE_MS = 10 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Create the HTTP server (not yet listening).
 * @param {Record<string, string|undefined>} env  usually process.env
 * @param {{fetchImpl?: typeof fetch, host?: string}} [options]
 */
export function createApp(env = process.env, { fetchImpl = fetch, host = env.HOST || '127.0.0.1' } = {}) {
  const providers = resolveProviders(env);
  const byId = new Map(providers.map((p) => [p.id, p]));
  const maxTokens = positiveInt(env.MAX_TOKENS, 4096);
  const timeoutMs = positiveInt(env.REQUEST_TIMEOUT_MS, 120_000);
  const checkHost = LOOPBACK_HOSTS.has(host);
  const modelCache = new Map();

  async function upstream(url, init, signal) {
    const res = await fetchImpl(url, { ...init, signal });
    const body = await res.text();
    if (!res.ok) throw new HttpError(502, extractErrorMessage(body, res.status));
    try {
      return JSON.parse(body);
    } catch {
      throw new HttpError(502, 'Provider returned a response that is not JSON');
    }
  }

  function requireProvider(id) {
    const p = byId.get(id);
    if (!p) throw new HttpError(400, `Unknown provider: ${id}`);
    if (!p.apiKey) {
      throw new HttpError(400, `${p.name} is not configured. Set ${p.keyEnv[0]} in .env and restart the server.`);
    }
    return p;
  }

  async function handleChat(req, res) {
    const input = await readJson(req);
    const p = requireProvider(input.provider);
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    if (!prompt.trim()) throw new HttpError(400, 'Prompt is empty');
    const system = typeof input.system === 'string' ? input.system.trim() : '';
    const model = (typeof input.model === 'string' && input.model.trim()) || p.defaultModel;
    if (model.length > 200) throw new HttpError(400, 'Model ID is too long');

    const started = performance.now();
    const { url, init } = buildChatRequest(p, { model, prompt, system, maxTokens });
    const json = await upstream(url, init, requestSignal(res, timeoutMs));
    const result = parseChatResponse(p, json);
    sendJson(res, 200, {
      ...result,
      model: result.model || model,
      latencyMs: Math.round(performance.now() - started),
    });
  }

  async function handleModels(res, providerId) {
    const p = requireProvider(providerId);
    const cached = modelCache.get(p.id);
    if (cached && Date.now() - cached.at < MODEL_CACHE_MS) {
      return sendJson(res, 200, { models: cached.models });
    }
    const { url, init } = buildModelsRequest(p);
    const json = await upstream(url, init, requestSignal(res, 30_000));
    const models = parseModelsResponse(p, json);
    modelCache.set(p.id, { at: Date.now(), models });
    sendJson(res, 200, { models });
  }

  return http.createServer(async (req, res) => {
    try {
      // Block DNS-rebinding: when bound to loopback, only answer to loopback names.
      if (checkHost && !LOOPBACK_HOSTS.has(hostname(req.headers.host))) {
        throw new HttpError(403, 'Forbidden host');
      }

      const url = new URL(req.url, 'http://localhost');
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /api/providers') {
        return sendJson(res, 200, { providers: providers.map(publicInfo) });
      }
      if (route === 'GET /api/models') {
        return await handleModels(res, url.searchParams.get('provider'));
      }
      if (route === 'POST /api/chat') {
        return await handleChat(req, res);
      }
      if (url.pathname.startsWith('/api/')) {
        throw new HttpError(404, 'Not found');
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        return await serveStatic(req, res, url.pathname);
      }
      throw new HttpError(405, 'Method not allowed');
    } catch (err) {
      if (res.headersSent || res.destroyed) return;
      if (err.name === 'TimeoutError') {
        return sendJson(res, 504, { error: 'The provider did not answer in time (see REQUEST_TIMEOUT_MS)' });
      }
      if (err.name === 'AbortError') return; // the browser went away
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      sendJson(res, 502, { error: err.cause?.message || err.message || 'Request failed' });
    }
  });
}

/** Abort the upstream call on timeout, or when the browser disconnects. */
function requestSignal(res, timeoutMs) {
  const disconnected = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) disconnected.abort();
  });
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), disconnected.signal]);
}

async function readJson(req) {
  // Requiring JSON also stops other websites posting here with a "simple"
  // cross-origin form request (JSON forces a CORS preflight we never approve).
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Expected application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'Invalid JSON body');
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Bad path');
  }
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Not found');

  let data;
  try {
    data = await readFile(filePath);
  } catch {
    throw new HttpError(404, 'Not found');
  }
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'content-length': data.length,
    'cache-control': 'no-cache',
    ...SECURITY_HEADERS,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

function hostname(hostHeader = '') {
  // "localhost:3000" -> "localhost", "[::1]:3000" -> "[::1]"
  const match = hostHeader.match(/^(\[[^\]]+\]|[^:]+)/);
  return match ? match[1].toLowerCase() : '';
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Entry point: `node server.js`
// ---------------------------------------------------------------------------

/**
 * The shell environment plus ./.env. Values in .env win, so a variable that
 * happens to be set in your shell (e.g. ANTHROPIC_BASE_URL) can't silently
 * override what you configured for this app.
 */
function loadEnv() {
  let fromFile = {};
  try {
    fromFile = parseEnv(readFileSync(path.join(APP_DIR, '.env'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { ...process.env, ...fromFile };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const env = loadEnv();
  const host = env.HOST || '127.0.0.1';
  const port = positiveInt(env.PORT, 3000);
  const server = createApp(env, { host });

  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set PORT in .env.` : err.message);
    process.exit(1);
  });

  server.listen(port, host, () => {
    const shownHost = host.includes(':') ? `[${host}]` : host;
    console.log(`\nMulti-LLM is running at http://${shownHost}:${port}\n`);
    for (const p of resolveProviders(env)) {
      console.log(
        p.apiKey
          ? `  ✓ ${p.name.padEnd(8)} ${p.defaultModel}`
          : `  ✗ ${p.name.padEnd(8)} not configured (set ${p.keyEnv[0]})`,
      );
    }
    console.log('');
  });
}
