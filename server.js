#!/usr/bin/env node
// Default AI Prompt server.
//
// Serves the web UI from ./public and proxies prompts to each provider so the
// API keys stay on the server and are never sent to the browser.
//
//   GET  /api/providers              which providers exist / are configured
//   GET  /api/models?provider=id     live model list from the provider
//   POST /api/chat                   {provider, model, prompt, system} -> answer
//   GET  /api/config                 page settings (ad slots)
//   GET  /api/settings               current settings, secrets masked   (this computer only)
//   POST /api/settings/preview       {text} -> what a settings file would change (this computer only)
//   POST /api/settings/apply         {text} -> write .env and reload    (this computer only)
//   GET  /ads.txt                    AdSense ads.txt, when ADSENSE_CLIENT is set

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import {
  resolveProviders,
  publicInfo,
  buildChatRequest,
  parseChatResponse,
  buildModelsRequest,
  parseModelsResponse,
  extractErrorMessage,
} from './providers.js';
import { allowedVariables, parseSettingsText, maskValue, mergeEnvText, adsConfig } from './settings.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DEFAULT_ENV_FILE = path.join(APP_DIR, '.env');
// Large enough for a prompt with attached files (the browser caps attachments at 2 MB).
const MAX_BODY_BYTES = 8_000_000;
const MODEL_CACHE_MS = 10 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

// Without ads everything comes from this server.
const STRICT_CSP =
  "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// With AdSense on, Google supports only its nonce-based "strict CSP":
// https://support.google.com/adsense/answer/16283098
const adsCsp = (nonce) =>
  `object-src 'none'; script-src 'nonce-${nonce}' 'unsafe-inline' 'unsafe-eval' 'strict-dynamic' https: http:; ` +
  "base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Create the HTTP server (not yet listening).
 * @param {Record<string, string|undefined>} env  usually process.env plus .env
 * @param {{fetchImpl?: typeof fetch, host?: string, envFile?: string}} [options]
 */
export function createApp(
  initialEnv = process.env,
  { fetchImpl = fetch, host = initialEnv.HOST || '127.0.0.1', envFile = DEFAULT_ENV_FILE } = {},
) {
  // Settings can change at runtime (Settings → Import), so keep them mutable.
  const env = { ...initialEnv };
  let providers;
  let byId;
  const modelCache = new Map();
  const reload = () => {
    providers = resolveProviders(env);
    byId = new Map(providers.map((p) => [p.id, p]));
    modelCache.clear();
  };
  reload();

  const maxTokens = () => positiveInt(env.MAX_TOKENS, 4096);
  const timeoutMs = () => positiveInt(env.REQUEST_TIMEOUT_MS, 120_000);
  const checkHost = LOOPBACK_HOSTS.has(host);

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
      throw new HttpError(400, `${p.name} is not configured. Set ${p.keyEnv[0]} in .env or import a settings file.`);
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
    const { url, init } = buildChatRequest(p, { model, prompt, system, maxTokens: maxTokens() });
    let json;
    try {
      json = await upstream(url, init, requestSignal(res, timeoutMs()));
    } catch (err) {
      if (err.name === 'TimeoutError') throw new HttpError(504, 'The provider did not answer in time (see REQUEST_TIMEOUT_MS)');
      throw err;
    }
    let result;
    try {
      result = parseChatResponse(p, json);
    } catch (err) {
      throw new HttpError(502, err.message);
    }
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
    let json;
    try {
      json = await upstream(url, init, requestSignal(res, 30_000));
    } catch (err) {
      if (err.name === 'TimeoutError') throw new HttpError(504, 'The provider did not list its models in time');
      throw err;
    }
    const models = parseModelsResponse(p, json);
    modelCache.set(p.id, { at: Date.now(), models });
    sendJson(res, 200, { models });
  }

  // --- Settings import (only from the computer running the app) -------------

  function requireLocal(req) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      throw new HttpError(403, 'Settings can only be changed on the computer that runs the app.');
    }
  }

  function settingsSummary() {
    return allowedVariables().map((name) => ({
      name,
      set: Boolean(env[name]),
      value: maskValue(name, env[name] || ''),
    }));
  }

  function preview(text) {
    const { changes, ignored, errors } = parseSettingsText(text);
    return {
      changes: changes.map(({ name, value }) => ({
        name,
        value: maskValue(name, value),
        action: value === '' ? 'clear' : env[name] ? 'replace' : 'add',
      })),
      ignored,
      errors,
    };
  }

  async function applySettings(text) {
    const { changes, errors } = parseSettingsText(text);
    if (errors.length) throw new HttpError(400, errors.join(' '));
    if (!changes.length) throw new HttpError(400, 'The file has no settings this app uses.');

    let existing = '';
    try {
      existing = await readFile(envFile, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const tmp = `${envFile}.${process.pid}.tmp`;
    await writeFile(tmp, mergeEnvText(existing, changes), { mode: 0o600 });
    await rename(tmp, envFile);

    for (const { name, value } of changes) env[name] = value;
    reload();
    return changes.map((c) => c.name);
  }

  // --- Pages ----------------------------------------------------------------

  async function serveIndex(req, res) {
    const ads = adsConfig(env);
    const nonce = randomBytes(16).toString('base64');
    let html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    if (ads.enabled) html = html.replaceAll('<script ', `<script nonce="${nonce}" `);
    const body = Buffer.from(html);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES['.html'],
      'content-length': body.length,
      'cache-control': 'no-store',
      'content-security-policy': ads.enabled ? adsCsp(nonce) : STRICT_CSP,
      ...BASE_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function serveAdsTxt(res) {
    const ads = adsConfig(env);
    if (!ads.enabled) throw new HttpError(404, 'Not found');
    const body = `google.com, ${ads.client.replace(/^ca-/, '')}, DIRECT, f08c47fec0942fa0\n`;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', ...BASE_HEADERS });
    res.end(body);
  }

  return http.createServer(async (req, res) => {
    try {
      // Block DNS-rebinding: when bound to loopback, only answer to loopback names.
      if (checkHost && !LOOPBACK_HOSTS.has(hostname(req.headers.host))) {
        throw new HttpError(403, 'Forbidden host');
      }

      const url = new URL(req.url, 'http://localhost');
      const route = `${req.method} ${url.pathname}`;

      switch (route) {
        case 'GET /api/providers':
          return sendJson(res, 200, { providers: providers.map(publicInfo) });
        case 'GET /api/models':
          return await handleModels(res, url.searchParams.get('provider'));
        case 'POST /api/chat':
          return await handleChat(req, res);
        case 'GET /api/config':
          return sendJson(res, 200, { ads: adsConfig(env) });
        case 'GET /api/settings':
          requireLocal(req);
          return sendJson(res, 200, { variables: settingsSummary() });
        case 'POST /api/settings/preview': {
          requireLocal(req);
          const { text } = await readJson(req);
          return sendJson(res, 200, preview(text));
        }
        case 'POST /api/settings/apply': {
          requireLocal(req);
          const { text } = await readJson(req);
          const applied = await applySettings(text);
          return sendJson(res, 200, { applied, providers: providers.map(publicInfo), ads: adsConfig(env) });
        }
        case 'GET /ads.txt':
        case 'HEAD /ads.txt':
          return serveAdsTxt(res);
        case 'GET /':
        case 'HEAD /':
        case 'GET /index.html':
        case 'HEAD /index.html':
          return await serveIndex(req, res);
      }

      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
      if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url.pathname);
      throw new HttpError(405, 'Method not allowed');
    } catch (err) {
      if (res.headersSent || res.destroyed) return;
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
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request is too large. Attach smaller files.');
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
    ...BASE_HEADERS,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...BASE_HEADERS,
  });
  res.end(body);
}

function hostname(hostHeader = '') {
  // "localhost:3000" -> "localhost", "[::1]:3000" -> "[::1]"
  const match = hostHeader.match(/^(\[[^\]]+\]|[^:]+)/);
  return match ? match[1].toLowerCase() : '';
}

function isLoopbackAddress(address = '') {
  return address === '::1' || /^(::ffff:)?127\./.test(address);
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
    fromFile = parseEnv(readFileSync(DEFAULT_ENV_FILE, 'utf8'));
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
    console.log(`\nDefault AI Prompt is running at http://${shownHost}:${port}\n`);
    for (const p of resolveProviders(env)) {
      console.log(
        p.apiKey
          ? `  ✓ ${p.name.padEnd(10)} ${p.defaultModel}`
          : `  ✗ ${p.name.padEnd(10)} not configured (set ${p.keyEnv[0]})`,
      );
    }
    const ads = adsConfig(env);
    if (ads.enabled) console.log(`\n  Ads: AdSense ${ads.client}`);
    console.log('');
  });
}
