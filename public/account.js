// Account view: sign in, balance, buying credit and usage. Only shown when the
// server has billing turned on.

import { h, $, fill, formatDate } from './dom.js';

let deps; // { getProviders, onChange(account) }
let billing = { enabled: false };
let account = null; // {email, balance, usage, payments, admin} or null when signed out
let resetToken = ''; // from a password reset link
const els = {};

/** Micro-dollars to "$1.23". Small amounts get more decimals so a 0.04¢ answer isn't "$0.00". */
export function formatMoney(micros) {
  const dollars = (micros || 0) / 1_000_000;
  const abs = Math.abs(dollars);
  const digits = abs === 0 || abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  return `${dollars < 0 ? '−' : ''}$${abs.toFixed(digits)}`;
}

/** Dollars per million tokens (already marked up), e.g. "$3.60". */
const formatRate = (dollars) => `$${dollars < 0.1 ? dollars.toFixed(3) : dollars.toFixed(2)}`;

export function initAccount(options, billingConfig) {
  deps = options;
  billing = billingConfig || { enabled: false };
  Object.assign(els, {
    nav: $('#nav-account'),
    navBalance: $('#nav-balance'),
    status: $('#account-status'),
    signinForm: $('#account-signin'),
    email: $('#account-email'),
    password: $('#account-password'),
    error: $('#account-error'),
    signup: $('#account-signup'),
    signedIn: $('#account-signed-in'),
    emailLabel: $('#account-email-label'),
    logout: $('#account-logout'),
    balance: $('#account-balance'),
    topups: $('#account-topups'),
    usage: $('#account-usage'),
    payments: $('#account-payments'),
    prices: $('#account-prices'),
    forgot: $('#account-forgot'),
    resetForm: $('#account-reset'),
    newPassword: $('#account-new-password'),
    resetError: $('#account-reset-error'),
    resetCancel: $('#account-reset-cancel'),
  });
  if (!billing.enabled) return;

  els.nav.hidden = false;
  els.signinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    authenticate('/api/auth/login');
  });
  els.signup.addEventListener('click', () => {
    if (els.signinForm.reportValidity()) authenticate('/api/auth/signup');
  });
  els.forgot.addEventListener('click', forgotPassword);
  els.resetForm.addEventListener('submit', (e) => {
    e.preventDefault();
    resetPassword();
  });
  els.resetCancel.addEventListener('click', () => {
    resetToken = '';
    render();
  });
  els.logout.addEventListener('click', async () => {
    await post('/api/auth/logout', {}).catch(() => {});
    setAccount(null);
  });
  fill(
    els.topups,
    billing.topupCents.map((cents) =>
      h('button', { type: 'button', class: 'ghost', text: `Add $${cents / 100}`, onclick: (e) => buy(cents, e.currentTarget) }),
    ),
  );
  renderPrices();
}

export const billingEnabled = () => billing.enabled;
export const signedIn = () => Boolean(account);
export const isAdmin = () => Boolean(account?.admin);

/** The marked-up price for a model, or null if it can't be used while billing is on. */
export function priceOf(providerId, model) {
  return billing.prices?.find((p) => p.provider === providerId && p.model === model) || null;
}

export function describePrice(price) {
  return `${formatRate(price.input)} in · ${formatRate(price.output)} out per 1M tokens`;
}

/** Load the signed-in account, and credit a Stripe Checkout the browser just came back from. */
export async function loadAccount() {
  if (!billing.enabled) return;
  const params = new URLSearchParams(location.search);
  const checkout = params.get('checkout');
  if (params.get('reset')) {
    // Keep the token out of the address bar (and browser history) once we have it.
    resetToken = params.get('reset');
    history.replaceState(null, '', `${location.pathname}#account`);
  }
  if (checkout) {
    history.replaceState(null, '', `${location.pathname}${location.hash}`);
    try {
      const result = await post('/api/billing/confirm', { session: checkout });
      setStatus(`Thanks! $${(result.cents / 100).toFixed(2)} was added to your balance.`);
    } catch (err) {
      setStatus(`We couldn't confirm that payment yet (${err.message}). If you were charged, it will appear shortly.`, true);
    }
  }
  await refresh();
}

async function refresh() {
  try {
    const res = await fetch('/api/account');
    const data = await res.json();
    setAccount(data.email ? data : null);
  } catch {
    setAccount(null);
  }
}

/** Opening the Account view: show what we have, then fetch the latest usage. */
export function showAccount() {
  render();
  if (billing.enabled) refresh();
}

/** Called after each answer with the server's new balance. */
export function updateBalance(balance) {
  if (!account || typeof balance !== 'number') return;
  account.balance = balance;
  renderBalance();
}

async function authenticate(url) {
  els.error.hidden = true;
  try {
    const data = await post(url, { email: els.email.value, password: els.password.value });
    els.password.value = '';
    setAccount(data);
    setStatus(url.endsWith('signup') ? 'Your account is ready. Add credit to start sending prompts.' : '');
  } catch (err) {
    els.error.textContent = err.message;
    els.error.hidden = false;
  }
}

async function forgotPassword() {
  els.error.hidden = true;
  if (!els.email.value.trim()) {
    els.error.textContent = 'Enter your email above first, then click Forgot password.';
    els.error.hidden = false;
    els.email.focus();
    return;
  }
  els.forgot.disabled = true;
  try {
    await post('/api/auth/forgot', { email: els.email.value });
    setStatus(`If there's an account for ${els.email.value.trim()}, we've emailed it a link to reset the password. It works for an hour.`);
  } catch (err) {
    els.error.textContent = err.message;
    els.error.hidden = false;
  } finally {
    els.forgot.disabled = false;
  }
}

async function resetPassword() {
  els.resetError.hidden = true;
  try {
    const data = await post('/api/auth/reset', { token: resetToken, password: els.newPassword.value });
    resetToken = '';
    els.newPassword.value = '';
    setAccount(data);
    setStatus('Your password has been changed.');
  } catch (err) {
    els.resetError.textContent = err.message;
    els.resetError.hidden = false;
  }
}

async function buy(cents, button) {
  button.disabled = true;
  try {
    const { url } = await post('/api/billing/checkout', { cents });
    location.assign(url);
  } catch (err) {
    setStatus(`Couldn't start checkout: ${err.message}`, true);
    button.disabled = false;
  }
}

function setAccount(data) {
  account = data;
  render();
  deps.onChange(account);
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.hidden = !message;
  els.status.classList.toggle('error-text', isError);
}

function render() {
  if (!billing.enabled) return;
  els.resetForm.hidden = !resetToken;
  els.signinForm.hidden = Boolean(account) || Boolean(resetToken);
  els.signedIn.hidden = !account || Boolean(resetToken);
  renderBalance();
  if (!account) return;
  els.emailLabel.textContent = account.email;
  renderUsage();
  renderPayments(els.payments, account.payments || []);
}

/** Card payments and manual credits. `actions(payment)` can add a cell of buttons (the admin view's Refund). */
export function renderPayments(el, payments, actions = null) {
  if (!payments.length) {
    fill(el, h('p', { class: 'muted', text: 'No payments yet.' }));
    return;
  }
  fill(
    el,
    h(
      'table',
      { class: 'settings-table usage-table' },
      h('thead', {}, headRow(actions ? ['When', 'What', 'Amount', ''] : ['When', 'What', 'Amount'], 2)),
      h(
        'tbody',
        {},
        payments.map((p) =>
          h(
            'tr',
            {},
            h('td', { text: formatDate(p.at) }),
            h('td', { text: describePayment(p) }),
            h('td', { class: 'num', text: formatCents(p.cents) }),
            actions ? h('td', { class: 'num' }, actions(p)) : null,
          ),
        ),
      ),
    ),
  );
}

function describePayment(p) {
  if (p.kind === 'card') {
    if (!p.refundedCents) return 'Card payment';
    return p.refundedCents >= p.cents ? 'Card payment (refunded)' : `Card payment (${formatCents(p.refundedCents)} refunded)`;
  }
  return p.note || (p.cents > 0 ? 'Credit' : 'Debit');
}

export const formatCents = (cents) => `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;

function renderBalance() {
  els.navBalance.textContent = account ? formatMoney(account.balance) : '';
  if (!account) return;
  els.balance.textContent = formatMoney(account.balance);
  els.balance.classList.toggle('empty-balance', account.balance <= 0);
}

function renderUsage() {
  const names = new Map(deps.getProviders().map((p) => [p.id, p.name]));
  const rows = account.usage || [];
  if (!rows.length) {
    fill(els.usage, h('p', { class: 'muted', text: 'No usage yet. Each answer you get will be listed here with its cost.' }));
    return;
  }
  fill(
    els.usage,
    h(
      'table',
      { class: 'settings-table usage-table' },
      h(
        'thead',
        {},
        headRow(['When', 'Model', 'Input tokens', 'Output tokens', 'Cost'], 2),
      ),
      h(
        'tbody',
        {},
        rows.map((u) =>
          h(
            'tr',
            {},
            h('td', { text: formatDate(u.at) }),
            h('td', {}, h('strong', { text: names.get(u.provider) || u.provider }), ' ', h('code', { text: u.model })),
            h('td', { class: 'num', text: u.input.toLocaleString() }),
            h('td', { class: 'num', text: u.output.toLocaleString() }),
            h('td', { class: 'num', text: formatMoney(u.cost), title: u.estimated ? 'Estimated: the provider did not report token counts' : '' }),
          ),
        ),
      ),
    ),
  );
}

function renderPrices() {
  const names = new Map(deps.getProviders().map((p) => [p.id, p.name]));
  const prices = billing.prices || [];
  if (!prices.length) {
    fill(els.prices, h('p', { class: 'muted', text: 'No models have prices yet, so prompts are paused.' }));
    return;
  }
  fill(
    els.prices,
    h(
      'table',
      { class: 'settings-table usage-table' },
      h('thead', {}, headRow(['Model', 'Input', 'Output'], 1)),
      h(
        'tbody',
        {},
        prices.map((p) =>
          h(
            'tr',
            {},
            h('td', {}, h('strong', { text: names.get(p.provider) || p.provider }), ' ', h('code', { text: p.model })),
            h('td', { class: 'num', text: formatRate(p.input) }),
            h('td', { class: 'num', text: formatRate(p.output) }),
          ),
        ),
      ),
    ),
  );
}

/** A header row whose columns from `numFrom` on hold numbers (right-aligned). */
function headRow(labels, numFrom) {
  return h('tr', {}, labels.map((t, i) => h('th', { scope: 'col', class: i >= numFrom ? 'num' : false, text: t })));
}


export async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
