// Billing: accounts, prepaid credit and per-request token charges.
//
// Off unless STRIPE_SECRET_KEY is set. When on, every prompt needs a signed-in
// account with credit. Each answer is charged from the provider's token counts:
//
//   cost = (input tokens × input price + output tokens × output price) × (1 + markup)
//
// Prices are US dollars per million tokens, read from pricing.json. Because
// tokens × $/1M tokens is exactly micro-dollars, all money is kept as whole
// micro-dollars (1 USD = 1,000,000) so there is no floating-point drift.
//
// Credit is bought through Stripe Checkout. A payment is credited when Stripe's
// webhook arrives, or when the browser comes back from Checkout, whichever is
// first; each Checkout session is credited only once.

import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export const MICROS_PER_DOLLAR = 1_000_000;
export const MICROS_PER_CENT = 10_000;
export const SESSION_COOKIE = 'dai_session';
export const SESSION_DAYS = 30;
const WEBHOOK_TOLERANCE_S = 300;

export const BILLING_VARIABLES = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'BILLING_MARKUP_PERCENT',
  'BILLING_TOPUP_AMOUNTS',
  'PUBLIC_URL',
  'ADMIN_EMAILS',
  'RESEND_API_KEY',
  'EMAIL_FROM',
];
export const BILLING_SECRET_VARIABLES = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY'];
export const RESET_TOKEN_MINUTES = 60;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Billing settings from the environment. */
export function billingConfig(env) {
  const secretKey = env.STRIPE_SECRET_KEY || '';
  const markup = Number.parseFloat(env.BILLING_MARKUP_PERCENT);
  const topups = String(env.BILLING_TOPUP_AMOUNTS || '5,10,25')
    .split(',')
    .map((s) => Math.round(Number.parseFloat(s) * 100))
    .filter((cents) => Number.isFinite(cents) && cents >= 100 && cents <= 100_000);
  return {
    enabled: Boolean(secretKey),
    secretKey,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    stripeBase: (env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, ''),
    markupPercent: Number.isFinite(markup) && markup >= 0 && markup <= 1000 ? markup : 20,
    topupCents: topups.length ? [...new Set(topups)].sort((a, b) => a - b) : [500, 1000, 2500],
    currency: 'usd',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    adminEmails: new Set(
      String(env.ADMIN_EMAILS || '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
    resendKey: env.RESEND_API_KEY || '',
    resendBase: (env.RESEND_API_BASE || 'https://api.resend.com').replace(/\/+$/, ''),
    emailFrom: env.EMAIL_FROM || '',
  };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Read pricing.json: {"<provider id>": {"<model id>": {"input": 3, "output": 15}}}
 * with prices in US dollars per million tokens. Keys starting with "_" are
 * comments and are skipped.
 * @returns {Map<string, {input: number, output: number}>} keyed by "provider/model"
 */
export function parsePricing(text) {
  const json = JSON.parse(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('pricing.json must be an object');
  const prices = new Map();
  for (const [provider, models] of Object.entries(json)) {
    if (provider.startsWith('_')) continue;
    if (!models || typeof models !== 'object') throw new Error(`pricing.json: "${provider}" must be an object of models`);
    for (const [model, price] of Object.entries(models)) {
      if (model.startsWith('_')) continue;
      const input = Number(price?.input);
      const output = Number(price?.output);
      if (!(input >= 0) || !(output >= 0)) {
        throw new Error(`pricing.json: ${provider} ${model} needs "input" and "output" prices of 0 or more`);
      }
      prices.set(`${provider}/${model}`, { input, output });
    }
  }
  return prices;
}

export function priceFor(pricing, provider, model) {
  return pricing.get(`${provider}/${model}`) || null;
}

/** Prices with the markup applied, for showing to users. */
export function pricingList(pricing, markupPercent) {
  const factor = 1 + markupPercent / 100;
  return [...pricing].map(([key, price]) => {
    const slash = key.indexOf('/');
    return {
      provider: key.slice(0, slash),
      model: key.slice(slash + 1),
      input: round6(price.input * factor),
      output: round6(price.output * factor),
    };
  });
}

/**
 * The charge for one answer, in micro-dollars, rounded up.
 * @param {{input: number, output: number}} price  dollars per million tokens
 * @param {{input?: number, output?: number}} usage token counts
 */
export function costMicros(price, usage, markupPercent) {
  const base = (usage.input || 0) * price.input + (usage.output || 0) * price.output;
  // Round before ceil so 1.1 × 100 = 110.00000000000001 doesn't become 111.
  return Math.ceil(round6((base * (100 + markupPercent)) / 100));
}

/** Rough token count (about 4 characters per token) when a provider doesn't report usage. */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// ---------------------------------------------------------------------------
// Passwords and sessions
// ---------------------------------------------------------------------------

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

// ---------------------------------------------------------------------------
// Stripe (REST API over fetch, so there are no dependencies)
// ---------------------------------------------------------------------------

/** Create a Checkout session for a credit top-up. Returns the Stripe session object. */
export async function createCheckoutSession(config, { user, cents, baseUrl }, fetchImpl = fetch) {
  const form = new URLSearchParams({
    mode: 'payment',
    success_url: `${baseUrl}/?checkout={CHECKOUT_SESSION_ID}#account`,
    cancel_url: `${baseUrl}/#account`,
    client_reference_id: user.id,
    customer_email: user.email,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': config.currency,
    'line_items[0][price_data][unit_amount]': String(cents),
    'line_items[0][price_data][product_data][name]': 'Default AI Prompt credit',
    'metadata[user_id]': user.id,
    'metadata[credit_cents]': String(cents),
  });
  return stripeRequest(config, 'POST', '/v1/checkout/sessions', form, fetchImpl);
}

export async function getCheckoutSession(config, id, fetchImpl = fetch) {
  if (!/^cs_[A-Za-z0-9_]{1,250}$/.test(id)) throw new Error('Not a Checkout session ID');
  return stripeRequest(config, 'GET', `/v1/checkout/sessions/${id}`, null, fetchImpl);
}

async function stripeRequest(config, method, pathname, form, fetchImpl) {
  const res = await fetchImpl(`${config.stripeBase}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${config.secretKey}`,
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? form.toString() : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe: ${json.error?.message || `HTTP ${res.status}`}`);
  return json;
}

/**
 * What a completed Checkout session should credit, or null if it isn't ours or isn't paid.
 * @returns {{userId: string, cents: number, id: string} | null}
 */
export function paidCredit(session) {
  if (!session || session.object !== 'checkout.session' || session.payment_status !== 'paid') return null;
  const userId = session.metadata?.user_id || session.client_reference_id;
  const cents = Number.parseInt(session.metadata?.credit_cents, 10);
  if (!userId || !Number.isFinite(cents) || cents <= 0) return null;
  // Never credit more than was actually paid.
  if (Number.isFinite(session.amount_total) && session.amount_total < cents) return null;
  const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || '';
  return { userId, cents, id: session.id, paymentIntent };
}

/** Refund part or all of a card payment. https://docs.stripe.com/api/refunds/create */
export async function createRefund(config, { paymentIntent, cents }, fetchImpl = fetch) {
  const form = new URLSearchParams({ payment_intent: paymentIntent, amount: String(cents), reason: 'requested_by_customer' });
  return stripeRequest(config, 'POST', '/v1/refunds', form, fetchImpl);
}

// ---------------------------------------------------------------------------
// Email (Resend's HTTP API, so there are no dependencies)
// ---------------------------------------------------------------------------

export const emailConfigured = (config) => Boolean(config.resendKey && config.emailFrom);

/** Send the password reset email. https://resend.com/docs/api-reference/emails/send-email */
export async function sendResetEmail(config, { to, link }, fetchImpl = fetch) {
  const text =
    `Someone asked to reset the password for your Default AI Prompt account (${to}).\n\n` +
    `To choose a new password, open this link within ${RESET_TOKEN_MINUTES} minutes:\n${link}\n\n` +
    "If it wasn't you, ignore this email. Your password stays the same.";
  const res = await fetchImpl(`${config.resendBase}/emails`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.resendKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: config.emailFrom, to: [to], subject: 'Reset your password', text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(`Email: ${json.message || `HTTP ${res.status}`}`);
  }
}

/**
 * Check a webhook's Stripe-Signature header.
 * https://docs.stripe.com/webhooks#verify-manually
 */
export function verifyStripeSignature(rawBody, header, secret, now = Date.now()) {
  if (!secret || !header) return false;
  let timestamp;
  const signatures = [];
  for (const part of String(header).split(',')) {
    const [key, value] = part.split('=');
    if (key === 't') timestamp = Number.parseInt(value, 10);
    if (key === 'v1' && value) signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || !signatures.length) return false;
  if (Math.abs(now / 1000 - timestamp) > WEBHOOK_TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  return signatures.some((sig) => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Build a Stripe-Signature header (used by the tests). */
export function signStripePayload(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}
