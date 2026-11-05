// Billing: pricing maths, Stripe signatures, and the whole flow through the
// server (sign up, top up via a fake Stripe, get charged per answer).

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createApp } from '../server.js';
import {
  billingConfig,
  parsePricing,
  costMicros,
  pricingList,
  paidCredit,
  verifyStripeSignature,
  signStripePayload,
  hashPassword,
  verifyPassword,
} from '../billing.js';
import { parseSettingsText, maskValue } from '../settings.js';
import { PROVIDERS } from '../providers.js';

// --- Unit tests -------------------------------------------------------------

test('billing is off without a Stripe key, and reads its settings', () => {
  assert.equal(billingConfig({}).enabled, false);
  const c = billingConfig({ STRIPE_SECRET_KEY: 'sk_test_x', BILLING_MARKUP_PERCENT: '35', BILLING_TOPUP_AMOUNTS: '20, 5,abc,0.5' });
  assert.equal(c.enabled, true);
  assert.equal(c.markupPercent, 35);
  assert.deepEqual(c.topupCents, [500, 2000]); // under $1 and junk are dropped
  assert.equal(billingConfig({ STRIPE_SECRET_KEY: 'sk_test_x', BILLING_MARKUP_PERCENT: '-5' }).markupPercent, 20);
});

test('pricing.json is parsed and checked', () => {
  const prices = parsePricing('{"_note":"x","openai":{"a":{"input":3,"output":15},"_c":{}}}');
  assert.deepEqual([...prices], [['openai/a', { input: 3, output: 15 }]]);
  assert.throws(() => parsePricing('{"openai":{"a":{"input":-1,"output":1}}}'), /input/);
  assert.throws(() => parsePricing('[]'), /object/);
  // The price list shipped with the app must parse and price every suggested model.
  const shipped = parsePricing(readFileSync(new URL('../pricing.json', import.meta.url), 'utf8'));
  for (const p of PROVIDERS) for (const m of p.models) assert.ok(shipped.has(`${p.id}/${m}`), `${p.id}/${m} has no price`);
  for (const p of PROVIDERS) assert.ok(shipped.has(`${p.id}/${p.defaultModel}`));
});

test('cost is exact micro-dollars with the markup, rounded up', () => {
  const price = { input: 3, output: 15 }; // $ per 1M tokens
  // 1000 × 3 + 500 × 15 = 10,500 µ$ ; +20% = 12,600 µ$ = $0.0126
  assert.equal(costMicros(price, { input: 1000, output: 500 }, 20), 12_600);
  assert.equal(costMicros(price, { input: 1000, output: 500 }, 0), 10_500);
  assert.equal(costMicros({ input: 0.1, output: 0.4 }, { input: 1, output: 0 }, 10), 1); // 0.11 → 1
  assert.equal(costMicros({ input: 1, output: 1 }, { input: 100, output: 0 }, 10), 110); // no float creep to 111
  assert.deepEqual(pricingList(new Map([['x/y', { input: 1, output: 2 }]]), 25), [{ provider: 'x', model: 'y', input: 1.25, output: 2.5 }]);
});

test('passwords are hashed with scrypt', async () => {
  const stored = await hashPassword('correct horse');
  assert.match(stored, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse', stored), true);
  assert.equal(await verifyPassword('wrong horse', stored), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('Stripe webhook signatures are verified', () => {
  const body = Buffer.from('{"id":"evt_1"}');
  const header = signStripePayload(body, 'whsec_abc');
  assert.equal(verifyStripeSignature(body, header, 'whsec_abc'), true);
  assert.equal(verifyStripeSignature(body, header, 'whsec_other'), false);
  assert.equal(verifyStripeSignature(Buffer.from('{"id":"evt_2"}'), header, 'whsec_abc'), false);
  const old = signStripePayload(body, 'whsec_abc', Math.floor(Date.now() / 1000) - 3600);
  assert.equal(verifyStripeSignature(body, old, 'whsec_abc'), false); // replayed
  assert.equal(verifyStripeSignature(body, '', 'whsec_abc'), false);
});

test('only paid Checkout sessions are credited, never more than was paid', () => {
  const session = {
    object: 'checkout.session',
    id: 'cs_1',
    payment_status: 'paid',
    amount_total: 1000,
    payment_intent: 'pi_1',
    metadata: { user_id: 'u1', credit_cents: '1000' },
  };
  assert.deepEqual(paidCredit(session), { userId: 'u1', cents: 1000, id: 'cs_1', paymentIntent: 'pi_1' });
  assert.equal(paidCredit({ ...session, payment_status: 'unpaid' }), null);
  assert.equal(paidCredit({ ...session, amount_total: 500 }), null);
});

test('billing settings can be imported, and Stripe secrets are masked', () => {
  const { changes, errors } = parseSettingsText(
    'STRIPE_SECRET_KEY=sk_test_abc123\nSTRIPE_WEBHOOK_SECRET=whsec_xyz\nBILLING_MARKUP_PERCENT=25\nBILLING_TOPUP_AMOUNTS=5,10\nPUBLIC_URL=https://ai.example.com',
  );
  assert.deepEqual(errors, []);
  assert.equal(changes.length, 5);
  assert.equal(maskValue('STRIPE_SECRET_KEY', 'sk_test_abc123'), '••••c123');
  assert.equal(maskValue('BILLING_MARKUP_PERCENT', '25'), '25');
  assert.equal(parseSettingsText('STRIPE_SECRET_KEY=pk_test_oops').errors.length, 1);
  assert.equal(parseSettingsText('BILLING_MARKUP_PERCENT=lots').errors.length, 1);
});

// --- Server flow ------------------------------------------------------------

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'default-ai-billing-'));
const pricingFile = path.join(tmpDir, 'pricing.json');
const billingFile = path.join(tmpDir, 'data', 'billing.json');
const WEBHOOK_SECRET = 'whsec_testsecret';
let upstream;
let app;
let base;
const stripeSessions = new Map();
const emails = []; // what the fake Resend was asked to send
const refunds = []; // what the fake Stripe was asked to refund

function fakeUpstream(req, res) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/stripe/v1/checkout/sessions' && req.method === 'POST') {
      assert.equal(req.headers.authorization, 'Bearer sk_test_fake');
      const form = new URLSearchParams(body);
      const session = {
        object: 'checkout.session',
        id: `cs_test_${stripeSessions.size + 1}`,
        url: `https://checkout.stripe.test/${stripeSessions.size + 1}`,
        payment_status: 'unpaid',
        amount_total: Number(form.get('line_items[0][price_data][unit_amount]')),
        client_reference_id: form.get('client_reference_id'),
        payment_intent: `pi_test_${stripeSessions.size + 1}`,
        success_url: form.get('success_url'),
        metadata: { user_id: form.get('metadata[user_id]'), credit_cents: form.get('metadata[credit_cents]') },
      };
      stripeSessions.set(session.id, session);
      return send(200, session);
    }
    if (req.url === '/stripe/v1/refunds' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      refunds.push({ paymentIntent: form.get('payment_intent'), amount: Number(form.get('amount')) });
      return send(200, { object: 'refund', id: `re_${refunds.length}`, status: 'succeeded' });
    }
    if (req.url === '/resend/emails' && req.method === 'POST') {
      assert.equal(req.headers.authorization, 'Bearer re_test');
      emails.push(JSON.parse(body));
      return send(200, { id: `email_${emails.length}` });
    }
    const m = req.url.match(/^\/stripe\/v1\/checkout\/sessions\/(cs_\w+)$/);
    if (m) return stripeSessions.has(m[1]) ? send(200, stripeSessions.get(m[1])) : send(404, { error: { message: 'No such session' } });
    if (req.url === '/openai/chat/completions') {
      const json = JSON.parse(body);
      if (json.model === 'no-usage') {
        return send(200, { choices: [{ message: { content: 'abcdefgh' }, finish_reason: 'stop' }] });
      }
      return send(200, {
        model: json.model,
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      });
    }
    send(404, { error: { message: `no route ${req.url}` } });
  });
}

before(async () => {
  writeFileSync(
    pricingFile,
    JSON.stringify({ openai: { 'gpt-test': { input: 3, output: 15 }, 'no-usage': { input: 1000, output: 1000 } } }),
  );
  upstream = http.createServer(fakeUpstream).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const up = `http://127.0.0.1:${upstream.address().port}`;
  app = createApp(
    {
      OPENAI_API_KEY: 'sk-openai-secret',
      OPENAI_BASE_URL: `${up}/openai`,
      STRIPE_SECRET_KEY: 'sk_test_fake',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_API_BASE: `${up}/stripe`,
      BILLING_MARKUP_PERCENT: '20',
      ADMIN_EMAILS: 'boss@example.com',
      RESEND_API_KEY: 're_test',
      RESEND_API_BASE: `${up}/resend`,
      EMAIL_FROM: 'Default AI <billing@example.com>',
    },
    { host: '127.0.0.1', envFile: path.join(tmpDir, '.env'), pricingFile, billingFile, authMaxAttempts: 30 },
  ).listen(0, '127.0.0.1');
  await once(app, 'listening');
  base = `http://127.0.0.1:${app.address().port}`;
});

after(() => {
  app.close();
  upstream.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const post = (url, body, cookie = '') =>
  fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

function webhook(event, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(event);
  return fetch(`${base}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, secret) },
    body: raw,
  });
}

let cookie;

test('config tells the page billing is on, with marked-up prices', async () => {
  const { billing } = await (await fetch(`${base}/api/config`)).json();
  assert.equal(billing.enabled, true);
  assert.deepEqual(billing.topupCents, [500, 1000, 2500]);
  assert.deepEqual(billing.prices.find((p) => p.model === 'gpt-test'), { provider: 'openai', model: 'gpt-test', input: 3.6, output: 18 });
  assert.ok(!JSON.stringify(billing).includes('sk_test'));
});

test('prompts need an account', async () => {
  const res = await post('/api/chat', { provider: 'openai', model: 'gpt-test', prompt: 'Hi' });
  assert.equal(res.status, 401);
});

test('sign up, sign out, sign in', async () => {
  let res = await post('/api/auth/signup', { email: 'Ada@Example.com', password: 'short' });
  assert.equal(res.status, 400);
  res = await post('/api/auth/signup', { email: 'Ada@Example.com', password: 'a good password' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const signupCookie = cookieOf(res);
  const created = await res.json();
  assert.equal(created.email, 'ada@example.com');
  assert.equal(created.balance, 0);

  res = await post('/api/auth/signup', { email: 'ada@example.com', password: 'another password' });
  assert.equal(res.status, 409);
  await post('/api/auth/logout', {}, signupCookie);

  res = await post('/api/auth/login', { email: 'ada@example.com', password: 'wrong password' });
  assert.equal(res.status, 401);
  res = await post('/api/auth/login', { email: 'ada@example.com', password: 'a good password' });
  assert.equal(res.status, 200);
  cookie = cookieOf(res);

  const account = await (await fetch(`${base}/api/account`, { headers: { cookie } })).json();
  assert.equal(account.email, 'ada@example.com');
  assert.ok(!JSON.stringify(account).includes('scrypt'));
});

test('an empty balance blocks prompts', async () => {
  const res = await post('/api/chat', { provider: 'openai', model: 'gpt-test', prompt: 'Hi' }, cookie);
  assert.equal(res.status, 402);
});

test('top up through Checkout: confirm on return, webhook credits only once', async () => {
  let res = await post('/api/billing/checkout', { cents: 123 }, cookie);
  assert.equal(res.status, 400); // not one of the offered amounts
  res = await post('/api/billing/checkout', { cents: 1000 }, cookie);
  assert.equal(res.status, 200);
  assert.match((await res.json()).url, /^https:\/\/checkout\.stripe\.test\//);
  const session = [...stripeSessions.values()].at(-1);
  assert.match(session.success_url, /\/\?checkout=\{CHECKOUT_SESSION_ID\}#account$/);

  // Not paid yet.
  res = await post('/api/billing/confirm', { session: session.id }, cookie);
  assert.equal(res.status, 400);

  session.payment_status = 'paid';
  res = await post('/api/billing/confirm', { session: session.id }, cookie);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { credited: true, balance: 10_000_000, cents: 1000 });

  // The webhook for the same session must not double-credit.
  res = await webhook({ type: 'checkout.session.completed', data: { object: session } });
  assert.equal(res.status, 200);
  const account = await (await fetch(`${base}/api/account`, { headers: { cookie } })).json();
  assert.equal(account.balance, 10_000_000);
  assert.deepEqual(account.payments.map((p) => p.cents), [1000]);
});

test('webhook alone credits a payment, and forged webhooks are refused', async () => {
  const res0 = await post('/api/billing/checkout', { cents: 500 }, cookie);
  assert.equal(res0.status, 200);
  const session = { ...[...stripeSessions.values()].at(-1), payment_status: 'paid' };

  let res = await webhook({ type: 'checkout.session.completed', data: { object: session } }, 'whsec_wrong');
  assert.equal(res.status, 400);
  res = await webhook({ type: 'checkout.session.completed', data: { object: session } });
  assert.equal(res.status, 200);
  const account = await (await fetch(`${base}/api/account`, { headers: { cookie } })).json();
  assert.equal(account.balance, 15_000_000);
});

test('each answer is charged from the balance', async () => {
  const res = await post('/api/chat', { provider: 'openai', model: 'gpt-test', prompt: 'Hi' }, cookie);
  assert.equal(res.status, 200);
  const data = await res.json();
  // (1000 × $3 + 500 × $15) per 1M tokens = $0.0105, +20% = $0.0126
  assert.equal(data.cost, 12_600);
  assert.equal(data.balance, 15_000_000 - 12_600);
  const account = await (await fetch(`${base}/api/account`, { headers: { cookie } })).json();
  assert.deepEqual(account.usage[0], { ...account.usage[0], provider: 'openai', model: 'gpt-test', input: 1000, output: 500, cost: 12_600 });
});

test('usage is estimated when a provider does not report tokens', async () => {
  const res = await post('/api/chat', { provider: 'openai', model: 'no-usage', prompt: 'abcdefgh' }, cookie);
  const data = await res.json();
  // 2 tokens in, 2 out at $1000/1M = 4000 µ$, +20% = 4800
  assert.equal(data.cost, 4800);
  const account = await (await fetch(`${base}/api/account`, { headers: { cookie } })).json();
  assert.equal(account.usage[0].estimated, true);
});

test('models without a price are refused', async () => {
  const res = await post('/api/chat', { provider: 'openai', model: 'gpt-unpriced', prompt: 'Hi' }, cookie);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no price/);
});

test('balances and sessions survive a restart', async () => {
  const saved = JSON.parse(readFileSync(billingFile, 'utf8'));
  const user = Object.values(saved.users)[0];
  assert.equal(user.balance, 15_000_000 - 12_600 - 4800);
  assert.ok(!JSON.stringify(saved).includes(cookie.split('=')[1])); // tokens are stored hashed
});

test('signing out ends the session', async () => {
  await post('/api/auth/logout', {}, cookie);
  const account = await (await fetch(`${base}/api/account`, { headers: { cookie } })).json();
  assert.equal(account.signedIn, false);
});

// --- Password reset ---------------------------------------------------------

const resetToken = (email) => new URL(email.text.match(/https?:\/\/\S+/)[0]).searchParams.get('reset');

test('password reset: emails a one-time link that sets a new password and signs out other sessions', async () => {
  let res = await post('/api/auth/login', { email: 'ada@example.com', password: 'a good password' });
  const oldSession = cookieOf(res);

  // Unknown emails get the same answer, and no email is sent.
  res = await post('/api/auth/forgot', { email: 'nobody@example.com' });
  assert.equal(res.status, 200);
  assert.equal(emails.length, 0);

  res = await post('/api/auth/forgot', { email: 'Ada@Example.com' });
  assert.equal(res.status, 200);
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ['ada@example.com']);
  assert.equal(emails[0].from, 'Default AI <billing@example.com>');
  const token = resetToken(emails[0]);
  assert.ok(token.length > 30);
  assert.match(emails[0].text, /\/\?reset=[\w-]+#account/);

  res = await post('/api/auth/reset', { token: 'wrong', password: 'brand new password' });
  assert.equal(res.status, 400);
  res = await post('/api/auth/reset', { token, password: 'short' });
  assert.equal(res.status, 400);
  res = await post('/api/auth/reset', { token, password: 'brand new password' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).email, 'ada@example.com');

  // The link only works once, the old session is gone, the old password no longer works.
  res = await post('/api/auth/reset', { token, password: 'another password' });
  assert.equal(res.status, 400);
  const account = await (await fetch(`${base}/api/account`, { headers: { cookie: oldSession } })).json();
  assert.equal(account.signedIn, false);
  res = await post('/api/auth/login', { email: 'ada@example.com', password: 'a good password' });
  assert.equal(res.status, 401);
  res = await post('/api/auth/login', { email: 'ada@example.com', password: 'brand new password' });
  assert.equal(res.status, 200);
  cookie = cookieOf(res);
});

test('password reset: only the newest link works, and tokens are stored hashed', async () => {
  await post('/api/auth/forgot', { email: 'ada@example.com' });
  await post('/api/auth/forgot', { email: 'ada@example.com' });
  const [older, newer] = emails.slice(-2).map(resetToken);
  assert.ok(!readFileSync(billingFile, 'utf8').includes(newer));
  let res = await post('/api/auth/reset', { token: older, password: 'brand new password' });
  assert.equal(res.status, 400);
  res = await post('/api/auth/reset', { token: newer, password: 'brand new password' });
  assert.equal(res.status, 200);
  cookie = cookieOf(res);
});

// --- Admin ------------------------------------------------------------------

let adminCookie;

test('admin: only ADMIN_EMAILS can use the admin API', async () => {
  let res = await fetch(`${base}/api/admin/users`, { headers: { cookie } });
  assert.equal(res.status, 403);
  assert.equal((await (await fetch(`${base}/api/account`, { headers: { cookie } })).json()).admin, false);
  res = await fetch(`${base}/api/admin/users`);
  assert.equal(res.status, 401);

  res = await post('/api/auth/signup', { email: 'boss@example.com', password: 'boss password' });
  adminCookie = cookieOf(res);
  assert.equal((await res.json()).admin, true);
  res = await fetch(`${base}/api/admin/users`, { headers: { cookie: adminCookie } });
  assert.equal(res.status, 200);
  const { users } = await res.json();
  const ada = users.find((u) => u.email === 'ada@example.com');
  assert.equal(ada.paidCents, 1500);
  assert.equal(ada.answers, 2);
  assert.equal(ada.balance, 15_000_000 - 12_600 - 4800);
  assert.ok(!JSON.stringify(users).includes('scrypt'));

  const filtered = await (await fetch(`${base}/api/admin/users?q=boss`, { headers: { cookie: adminCookie } })).json();
  assert.deepEqual(filtered.users.map((u) => u.email), ['boss@example.com']);
});

test('admin: add and remove credit, shown to the user with the reason', async () => {
  const { users } = await (await fetch(`${base}/api/admin/users?q=ada`, { headers: { cookie: adminCookie } })).json();
  const ada = users[0];
  let res = await post('/api/admin/credit', { userId: ada.id, cents: 250, note: 'Sorry about the outage' }, adminCookie);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).balance, ada.balance + 2_500_000);
  res = await post('/api/admin/credit', { userId: ada.id, cents: -50 }, adminCookie);
  assert.equal((await res.json()).balance, ada.balance + 2_000_000);
  res = await post('/api/admin/credit', { userId: ada.id, cents: 1.5 }, adminCookie);
  assert.equal(res.status, 400);
  res = await post('/api/admin/credit', { userId: ada.id, cents: 100 }, cookie); // not an admin
  assert.equal(res.status, 403);

  const account = await (await fetch(`${base}/api/account`, { headers: { cookie } })).json();
  assert.deepEqual(
    account.payments.filter((p) => p.kind === 'credit').map((p) => [p.cents, p.note]),
    [
      [-50, 'Debit'],
      [250, 'Sorry about the outage'],
    ],
  );
});

test('admin: refund a card payment through Stripe, never more than was paid', async () => {
  const { users } = await (await fetch(`${base}/api/admin/users?q=ada`, { headers: { cookie: adminCookie } })).json();
  const detail = await (await fetch(`${base}/api/admin/user?id=${users[0].id}`, { headers: { cookie: adminCookie } })).json();
  const payment = detail.payments.find((p) => p.kind === 'card' && p.cents === 1000);
  assert.ok(payment);

  let res = await post('/api/admin/refund', { paymentId: payment.id, cents: 1001 }, adminCookie);
  assert.equal(res.status, 400);
  res = await post('/api/admin/refund', { paymentId: payment.id, cents: 400 }, adminCookie);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).balance, users[0].balance - 4_000_000);
  assert.deepEqual(refunds.at(-1), { paymentIntent: stripeSessions.get(payment.id).payment_intent, amount: 400 });

  res = await post('/api/admin/refund', { paymentId: payment.id, cents: 601 }, adminCookie);
  assert.equal(res.status, 400); // only $6.00 left
  res = await post('/api/admin/refund', { paymentId: payment.id, cents: 600 }, adminCookie);
  assert.equal(res.status, 200);

  const after = await (await fetch(`${base}/api/admin/user?id=${users[0].id}`, { headers: { cookie: adminCookie } })).json();
  assert.equal(after.payments.find((p) => p.id === payment.id).refundedCents, 1000);
  assert.equal(refunds.length, 2);
});

test('sign-in, sign-up and reset requests are rate-limited', async () => {
  let status;
  for (let i = 0; i < 31 && status !== 429; i++) {
    status = (await post('/api/auth/login', { email: 'ada@example.com', password: 'guessing wrong' })).status;
  }
  assert.equal(status, 429);
  assert.equal((await post('/api/auth/forgot', { email: 'ada@example.com' })).status, 429);
});
