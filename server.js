#!/usr/bin/env node
// Default AI Prompt server.
//
// Serves the web UI from ./public and proxies prompts to each provider so the
// API keys stay on the server and are never sent to the browser.
//
//   GET  /api/providers              which providers exist / are configured
//   GET  /api/models?provider=id     live model list from the provider
//   POST /api/chat                   {provider, model, messages | prompt, system, stream} -> answer
//                                    (with stream: true, newline-delimited JSON events)
//   POST /api/extract                a PDF or Word (.docx) file -> {text, pages}
//   GET  /api/config                 page settings (ad slots)
//   GET  /api/settings               current settings, secrets masked   (this computer only)
//   POST /api/settings/preview       {text} -> what a settings file would change (this computer only)
//   POST /api/settings/apply         {text} -> write .env and reload    (this computer only)
//   GET  /ads.txt                    AdSense ads.txt, when ADSENSE_CLIENT is set
//
// Billing (only when STRIPE_SECRET_KEY is set, see billing.js):
//   POST /api/auth/signup            {email, password} -> signed in
//   POST /api/auth/login             {email, password} -> signed in
//   POST /api/auth/logout
//   GET  /api/account                balance, recent usage and payments
//   POST /api/billing/checkout       {cents} -> {url} of a Stripe Checkout page
//   POST /api/billing/confirm        {session} -> credit a finished Checkout
//   POST /api/billing/webhook        Stripe webhook (checkout.session.completed)
//   POST /api/auth/forgot            {email} -> email a password reset link
//   POST /api/auth/reset             {token, password} -> new password, signed in
//   GET  /api/admin/users?q=         accounts with balances (ADMIN_EMAILS only)
//   GET  /api/admin/user?id=         one account: payments, credits, usage
//   POST /api/admin/credit           {userId, cents, note} -> add or remove credit
//   POST /api/admin/refund           {paymentId, cents} -> refund a card payment through Stripe

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
  normalizeMessages,
  createSseReader,
  createStreamParser,
} from './providers.js';
import { allowedVariables, parseSettingsText, maskValue, mergeEnvText, adsConfig } from './settings.js';
import { extractDocument, ExtractError, MAX_DOCUMENT_BYTES, DOCUMENT_TYPES } from './extract.js';
import {
  billingConfig,
  parsePricing,
  priceFor,
  pricingList,
  costMicros,
  estimateTokens,
  verifyPassword,
  EMAIL_RE,
  SESSION_COOKIE,
  createCheckoutSession,
  getCheckoutSession,
  paidCredit,
  verifyStripeSignature,
  createRefund,
  emailConfigured,
  sendResetEmail,
} from './billing.js';
import { BillingStore } from './billing-store.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DEFAULT_ENV_FILE = path.join(APP_DIR, '.env');
const DEFAULT_PRICING_FILE = path.join(APP_DIR, 'pricing.json');
const DEFAULT_BILLING_FILE = path.join(APP_DIR, 'data', 'billing.db');
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;
// Large enough for a prompt with attached files (the browser caps attachments at 2 MB).
const MAX_BODY_BYTES = 8_000_000;
// Follow-up questions per conversation (each is a question and an answer).
const MAX_TURNS = 50;
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
 * @param {{fetchImpl?: typeof fetch, host?: string, envFile?: string, pricingFile?: string, billingFile?: string, authMaxAttempts?: number}} [options]
 */
export function createApp(
  initialEnv = process.env,
  {
    fetchImpl = fetch,
    host = initialEnv.HOST || '127.0.0.1',
    envFile = DEFAULT_ENV_FILE,
    pricingFile = initialEnv.PRICING_FILE || DEFAULT_PRICING_FILE,
    billingFile = initialEnv.BILLING_DATA_FILE || DEFAULT_BILLING_FILE,
    authMaxAttempts = AUTH_MAX_ATTEMPTS,
  } = {},
) {
  // Settings can change at runtime (Settings → Import), so keep them mutable.
  const env = { ...initialEnv };
  let providers;
  let byId;
  const modelCache = new Map();
  let billing;
  let pricing = new Map();
  let pricingError = '';
  const store = new BillingStore(billingFile);
  const authAttempts = new Map(); // ip -> {count, since}
  const reload = () => {
    providers = resolveProviders(env);
    byId = new Map(providers.map((p) => [p.id, p]));
    modelCache.clear();
    billing = billingConfig(env);
    pricing = new Map();
    pricingError = '';
    // Prices are loaded even with billing off, to show cost estimates.
    try {
      pricing = parsePricing(readFileSync(pricingFile, 'utf8'));
    } catch (err) {
      if (billing.enabled) pricingError = err.code === 'ENOENT' ? `${path.basename(pricingFile)} not found` : err.message;
    }
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
    const user = billing.enabled ? await requireUser(req) : null;
    const p = requireProvider(input.provider);
    // A conversation (follow-up questions) or, for older clients, a single prompt.
    const messages = normalizeMessages({ prompt: input.prompt, messages: input.messages });
    if (!messages.length || messages.at(-1).role !== 'user' || !messages.at(-1).content.trim()) {
      throw new HttpError(400, 'Prompt is empty');
    }
    if (messages.length > MAX_TURNS * 2) throw new HttpError(400, 'This conversation is too long. Start a new prompt.');
    const system = typeof input.system === 'string' ? input.system.trim() : '';
    const model = (typeof input.model === 'string' && input.model.trim()) || p.defaultModel;
    if (model.length > 200) throw new HttpError(400, 'Model ID is too long');

    // The list price is used for billing, and for a cost estimate when billing is off.
    const price = priceFor(pricing, p.id, model);
    if (user) {
      if (!price) throw new HttpError(400, `${model} has no price set, so it can't be used yet. Choose another model.`);
      if (user.balance <= 0) throw new HttpError(402, 'Your balance is used up. Add credit under Account to keep going.');
    }
    const promptText = (system ? `${system}\n` : '') + messages.map((m) => m.content).join('\n');
    const bill = (result, partial = false) => settleCost({ user, price, provider: p.id, model, promptText, result, partial });

    const started = performance.now();
    const stream = input.stream === true;
    const { url, init } = buildChatRequest(p, { model, messages, system, maxTokens: maxTokens(), stream });
    const signal = requestSignal(res, timeoutMs());
    const timedOut = (err) => err?.name === 'TimeoutError';
    const TIMEOUT_MESSAGE = 'The provider did not answer in time (see REQUEST_TIMEOUT_MS)';

    if (!stream) {
      let json;
      try {
        json = await upstream(url, init, signal);
      } catch (err) {
        if (timedOut(err)) throw new HttpError(504, TIMEOUT_MESSAGE);
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
        ...(await bill(result)),
      });
      return;
    }

    // --- Streaming: newline-delimited JSON events to the browser ------------
    //   {type: 'thinking'}                     the model is reasoning before it answers
    //   {type: 'delta', text}                  the next piece of the answer
    //   {type: 'done', text, model, usage, …}  the whole answer, its cost and timing
    //   {type: 'error', error}                 the stream broke off
    let upstreamRes;
    try {
      upstreamRes = await fetchImpl(url, { ...init, signal });
    } catch (err) {
      if (timedOut(err)) throw new HttpError(504, TIMEOUT_MESSAGE);
      throw err;
    }
    if (!upstreamRes.ok) {
      throw new HttpError(502, extractErrorMessage(await upstreamRes.text().catch(() => ''), upstreamRes.status));
    }

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no', // ask reverse proxies (nginx) not to buffer the stream
      ...BASE_HEADERS,
    });
    const send = (event) => {
      if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };
    const parser = createStreamParser(p);
    let thinkingSent = false;
    const forward = (events) => {
      for (const event of events) {
        for (const out of parser.feed(event)) {
          if (out.type === 'delta') send(out);
          else if (!thinkingSent) {
            thinkingSent = true;
            send(out);
          }
        }
      }
    };

    let result;
    try {
      if ((upstreamRes.headers.get('content-type') || '').includes('application/json')) {
        // The provider answered all at once instead of streaming.
        result = parseChatResponse(p, JSON.parse(await upstreamRes.text()));
        if (result.text) send({ type: 'delta', text: result.text });
      } else {
        const reader = createSseReader();
        const decoder = new TextDecoder();
        for await (const chunk of upstreamRes.body) forward(reader.push(decoder.decode(chunk, { stream: true })));
        forward(reader.push(decoder.decode()));
        forward(reader.end());
        result = parser.finish();
      }
    } catch (err) {
      // Charge for whatever was generated before the stream broke off (or the
      // browser cancelled), since the provider bills for it too.
      const partial = parser.finish();
      const cost = partial.text ? await bill(partial, true).catch(() => ({})) : {};
      send({ type: 'error', error: timedOut(err) ? TIMEOUT_MESSAGE : err.message || 'The stream broke off', ...cost });
      res.end();
      return;
    }
    send({
      type: 'done',
      ...result,
      model: result.model || model,
      latencyMs: Math.round(performance.now() - started),
      ...(await bill(result)),
    });
    res.end();
  }

  /**
   * Work out an answer's cost from the provider's token counts (or an
   * estimate from its length). With billing on, charge the user; otherwise
   * return an estimate at list price, if the model has one.
   */
  async function settleCost({ user, price, provider, model, promptText, result, partial }) {
    if (!price) return {};
    const reported = !partial && Number.isFinite(result.usage?.input) && Number.isFinite(result.usage?.output);
    const tokens = reported
      ? { input: result.usage.input, output: result.usage.output }
      : {
          input: Number.isFinite(result.usage?.input) ? result.usage.input : estimateTokens(promptText),
          output: Math.max(result.usage?.output || 0, estimateTokens(result.text)),
        };
    const estimated = reported ? {} : { costEstimated: true };
    if (!user) return { estimatedCost: costMicros(price, tokens, 0), ...estimated };
    // Bill the model we asked for: that's the one with a price, even if the
    // provider reports a dated variant of it.
    const cost = costMicros(price, tokens, billing.markupPercent);
    const balance = await store.charge(user.id, {
      provider,
      model,
      input: tokens.input,
      output: tokens.output,
      estimated: !reported,
      cost,
    });
    return { cost, balance, ...estimated };
  }

  // --- Attachments: text from PDF and Word files ------------------------------

  async function handleExtract(req, res) {
    // Only these binary types are accepted. They can't be sent by a plain
    // cross-site form, so other websites can't post files here either.
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (![DOCUMENT_TYPES.pdf, DOCUMENT_TYPES.docx, 'application/octet-stream'].includes(type)) {
      throw new HttpError(415, 'Send a PDF or Word (.docx) file.');
    }
    if (billing.enabled) await requireUser(req);
    let name = '';
    try {
      name = decodeURIComponent(String(req.headers['x-file-name'] || '')).slice(0, 200);
    } catch {
      // keep the default
    }
    const body = await readRaw(req, MAX_DOCUMENT_BYTES).catch((err) => {
      if (err instanceof HttpError && err.status === 413) {
        throw new HttpError(413, `${name || 'The file'} is larger than ${MAX_DOCUMENT_BYTES / 1_000_000} MB.`);
      }
      throw err;
    });
    try {
      const { text, pages } = await extractDocument(new Uint8Array(body), name);
      sendJson(res, 200, { text, ...(pages ? { pages } : {}) });
    } catch (err) {
      if (err instanceof ExtractError) throw new HttpError(422, err.message);
      throw err;
    }
  }

  // --- Billing: accounts, credit and Stripe ----------------------------------

  function requireBilling() {
    if (!billing.enabled) throw new HttpError(404, 'Billing is not turned on');
  }

  async function currentUser(req) {
    return store.userForToken(readCookie(req, SESSION_COOKIE));
  }

  async function requireUser(req) {
    const user = await currentUser(req);
    if (!user) throw new HttpError(401, 'Sign in under Account to send prompts.');
    return user;
  }

  function limitAuth(req) {
    const ip = clientIp(req, env.CLIENT_IP_HEADER);
    const now = Date.now();
    const entry = authAttempts.get(ip);
    if (!entry || now - entry.since > AUTH_WINDOW_MS) {
      authAttempts.set(ip, { count: 1, since: now });
      if (authAttempts.size > 10_000) authAttempts.clear();
      return;
    }
    if (++entry.count > authMaxAttempts) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
  }

  function credentials(input) {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const password = typeof input.password === 'string' ? input.password : '';
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Passwords are 8 to 200 characters.');
    return { email, password };
  }

  async function signIn(req, res, user) {
    const { token, maxAge } = await store.createSession(user.id);
    const secure = isHttps(req) ? '; Secure' : '';
    res.setHeader('set-cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
    sendJson(res, 200, await accountFor(user));
  }

  const isAdmin = (user) => Boolean(user) && billing.adminEmails.has(user.email);

  async function accountFor(user) {
    return { ...(await store.account(user.id)), admin: isAdmin(user) };
  }

  async function handleSignup(req, res) {
    requireBilling();
    limitAuth(req);
    const { email, password } = credentials(await readJson(req));
    const user = await store.createUser(email, password);
    if (!user) throw new HttpError(409, 'There is already an account with that email. Sign in instead.');
    await signIn(req, res, user);
  }

  async function handleLogin(req, res) {
    requireBilling();
    limitAuth(req);
    const { email, password } = credentials(await readJson(req));
    const user = await store.findByEmail(email);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new HttpError(401, 'That email and password do not match an account.');
    }
    await signIn(req, res, user);
  }

  async function handleLogout(req, res) {
    await readJson(req);
    await store.deleteSession(readCookie(req, SESSION_COOKIE));
    res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    sendJson(res, 200, { signedOut: true });
  }

  async function handleAccount(req, res) {
    requireBilling();
    const user = await currentUser(req);
    sendJson(res, 200, user ? await accountFor(user) : { signedIn: false });
  }

  // --- Password reset --------------------------------------------------------

  async function handleForgot(req, res) {
    requireBilling();
    limitAuth(req);
    const input = await readJson(req);
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    const token = await store.createReset(email);
    if (token) {
      const link = `${baseUrl(req)}/?reset=${token}#account`;
      if (emailConfigured(billing)) {
        try {
          await sendResetEmail(billing, { to: email, link }, fetchImpl);
        } catch (err) {
          console.error(`Password reset email to ${email} failed: ${err.message}`);
          throw new HttpError(502, "We couldn't send the email just now. Try again in a few minutes.");
        }
      } else {
        // No email service yet: the person running the server can pass the link on.
        console.log(`Password reset link for ${email} (set RESEND_API_KEY and EMAIL_FROM to email it): ${link}`);
      }
    }
    // Same answer whether or not the account exists, so this can't be used to find out who has one.
    sendJson(res, 200, { sent: true });
  }

  async function handleReset(req, res) {
    requireBilling();
    limitAuth(req);
    const input = await readJson(req);
    const password = typeof input.password === 'string' ? input.password : '';
    if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Passwords are 8 to 200 characters.');
    const user = await store.resetPassword(input.token, password);
    if (!user) throw new HttpError(400, 'This reset link has expired or was already used. Ask for a new one.');
    await signIn(req, res, user);
  }

  // --- Admin -----------------------------------------------------------------

  async function requireAdmin(req) {
    requireBilling();
    const user = await requireUser(req);
    if (!isAdmin(user)) throw new HttpError(403, 'Only admins can do that.');
    return user;
  }

  async function handleAdminUser(req, res, id) {
    await requireAdmin(req);
    const user = await store.adminUser(String(id || ''));
    if (!user) throw new HttpError(404, 'Account not found');
    sendJson(res, 200, user);
  }

  async function handleAdminCredit(req, res) {
    const input = await readJson(req);
    const admin = await requireAdmin(req);
    const cents = Number(input.cents);
    if (!Number.isInteger(cents) || cents === 0 || Math.abs(cents) > 1_000_000) {
      throw new HttpError(400, 'Enter an amount between -$10,000 and $10,000.');
    }
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 200) : '';
    if (!(await store.getUser(String(input.userId || '')))) throw new HttpError(404, 'Account not found');
    const balance = await store.adjust(input.userId, cents, note || (cents > 0 ? 'Credit' : 'Debit'), admin.email);
    sendJson(res, 200, { balance });
  }

  async function handleAdminRefund(req, res) {
    const input = await readJson(req);
    const admin = await requireAdmin(req);
    const paymentId = String(input.paymentId || '');
    const payment = await store.payment(paymentId);
    if (!payment) throw new HttpError(404, 'Payment not found');
    const cents = Number(input.cents);
    const left = payment.cents - (payment.refundedCents || 0);
    if (!Number.isInteger(cents) || cents <= 0 || cents > left) {
      throw new HttpError(400, `Refund between $0.01 and $${(left / 100).toFixed(2)}.`);
    }
    let paymentIntent = payment.paymentIntent;
    try {
      // Payments credited before refunds existed didn't store this; look it up.
      if (!paymentIntent) paymentIntent = paidCredit(await getCheckoutSession(billing, paymentId, fetchImpl))?.paymentIntent;
      if (!paymentIntent) throw new Error('Stripe has no card payment for this checkout.');
      await createRefund(billing, { paymentIntent, cents }, fetchImpl);
    } catch (err) {
      throw new HttpError(502, err.message);
    }
    const balance = await store.recordRefund(paymentId, cents, admin.email);
    sendJson(res, 200, { balance });
  }

  function baseUrl(req) {
    if (billing.publicUrl) return billing.publicUrl;
    return `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
  }

  async function handleCheckout(req, res) {
    requireBilling();
    const input = await readJson(req);
    const user = await requireUser(req);
    const cents = Number(input.cents);
    if (!billing.topupCents.includes(cents)) throw new HttpError(400, 'Choose one of the listed amounts.');
    let session;
    try {
      session = await createCheckoutSession(billing, { user, cents, baseUrl: baseUrl(req) }, fetchImpl);
    } catch (err) {
      throw new HttpError(502, err.message);
    }
    sendJson(res, 200, { url: session.url });
  }

  /** Credit a finished Checkout when the browser returns, in case the webhook is slow or not set up. */
  async function handleConfirm(req, res) {
    requireBilling();
    const input = await readJson(req);
    const user = await requireUser(req);
    let session;
    try {
      session = await getCheckoutSession(billing, String(input.session || ''), fetchImpl);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    const credit = paidCredit(session);
    if (!credit || credit.userId !== user.id) throw new HttpError(400, "That payment isn't complete yet.");
    const result = await store.credit(user.id, credit.id, credit.cents, credit.paymentIntent);
    sendJson(res, 200, { ...result, cents: credit.cents });
  }

  async function handleWebhook(req, res) {
    requireBilling();
    if (!billing.webhookSecret) throw new HttpError(404, 'Set STRIPE_WEBHOOK_SECRET to receive webhooks');
    const raw = await readRaw(req, 1_000_000);
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], billing.webhookSecret)) {
      throw new HttpError(400, 'Bad signature');
    }
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON body');
    }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const credit = paidCredit(event.data?.object);
      if (credit && (await store.getUser(credit.userId))) {
        await store.credit(credit.userId, credit.id, credit.cents, credit.paymentIntent);
      }
    }
    sendJson(res, 200, { received: true });
  }

  function publicBilling() {
    if (!billing.enabled) return { enabled: false };
    return {
      enabled: true,
      currency: billing.currency,
      markupPercent: billing.markupPercent,
      topupCents: billing.topupCents,
      prices: pricingList(pricing, billing.markupPercent),
    };
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

  const server = http.createServer(async (req, res) => {
    try {
      // Block DNS-rebinding: when bound to loopback, only answer to loopback names.
      // (Stripe can't reach a loopback server anyway, so webhooks are unaffected.)
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
        case 'POST /api/extract':
          return await handleExtract(req, res);
        case 'GET /api/config':
          return sendJson(res, 200, { ads: adsConfig(env), billing: publicBilling() });
        case 'POST /api/auth/signup':
          return await handleSignup(req, res);
        case 'POST /api/auth/login':
          return await handleLogin(req, res);
        case 'POST /api/auth/logout':
          return await handleLogout(req, res);
        case 'GET /api/account':
          return await handleAccount(req, res);
        case 'POST /api/billing/checkout':
          return await handleCheckout(req, res);
        case 'POST /api/billing/confirm':
          return await handleConfirm(req, res);
        case 'POST /api/billing/webhook':
          return await handleWebhook(req, res);
        case 'POST /api/auth/forgot':
          return await handleForgot(req, res);
        case 'POST /api/auth/reset':
          return await handleReset(req, res);
        case 'GET /api/admin/users':
          await requireAdmin(req);
          return sendJson(res, 200, { users: await store.listUsers(url.searchParams.get('q') || '') });
        case 'GET /api/admin/user':
          return await handleAdminUser(req, res, url.searchParams.get('id'));
        case 'POST /api/admin/credit':
          return await handleAdminCredit(req, res);
        case 'POST /api/admin/refund':
          return await handleAdminRefund(req, res);
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
          return sendJson(res, 200, {
            applied,
            providers: providers.map(publicInfo),
            ads: adsConfig(env),
            billing: publicBilling(),
          });
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
  server.billingStatus = () => ({ ...publicBilling(), pricingError, models: pricing.size });
  return server;
}

/** Abort the upstream call on timeout, or when the browser disconnects. */
function requestSignal(res, timeoutMs) {
  const disconnected = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) disconnected.abort();
  });
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), disconnected.signal]);
}

async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

/**
 * The visitor's address. Behind a hosting proxy every request comes from the
 * proxy, so CLIENT_IP_HEADER (e.g. "fly-client-ip") names the header the proxy
 * puts the real address in. Only set it when a proxy you trust always sets it.
 */
function clientIp(req, headerName = '') {
  const header = headerName.toLowerCase();
  const forwarded = header && String(req.headers[header] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || '';
}

function isHttps(req) {
  return Boolean(req.socket.encrypted) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
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
    const billing = server.billingStatus();
    if (billing.enabled) {
      console.log(`\n  Billing: on, ${billing.markupPercent}% markup, ${billing.models} priced model(s)`);
      if (billing.pricingError) console.log(`  ⚠ Pricing not loaded (${billing.pricingError}). No model can be used until pricing.json is fixed.`);
    }
    console.log('');
  });
}
