// Admin view: find users, see their balance and history, add or remove credit,
// and refund card payments through Stripe. Only shown to ADMIN_EMAILS; the
// server checks every request too.

import { h, $, fill, formatDate } from './dom.js';
import { formatMoney, formatCents, renderPayments, post } from './account.js';

const els = {};
let selectedId = '';
let searchTimer;

export function initAdmin() {
  Object.assign(els, {
    nav: $('#nav-admin'),
    status: $('#admin-status'),
    search: $('#admin-search'),
    users: $('#admin-users'),
    detail: $('#admin-detail'),
  });
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadUsers, 250);
  });
}

/** Show or hide the Admin tab for the signed-in account. */
export function setAdminVisible(visible) {
  els.nav.hidden = !visible;
}

export function showAdmin() {
  loadUsers();
  if (selectedId) loadUser(selectedId);
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.hidden = !message;
  els.status.classList.toggle('error-text', isError);
}

async function get(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadUsers() {
  let users;
  try {
    ({ users } = await get(`/api/admin/users?q=${encodeURIComponent(els.search.value)}`));
  } catch (err) {
    setStatus(`Couldn't load users: ${err.message}`, true);
    return;
  }
  if (!users.length) {
    fill(els.users, h('p', { class: 'muted', text: els.search.value ? 'No users match.' : 'No users yet.' }));
    return;
  }
  fill(
    els.users,
    h(
      'table',
      { class: 'settings-table usage-table admin-users' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'col', text: 'Email' }),
          h('th', { scope: 'col', text: 'Joined' }),
          ['Balance', 'Paid', 'Spent', 'Answers'].map((t) => h('th', { scope: 'col', class: 'num', text: t })),
        ),
      ),
      h(
        'tbody',
        {},
        users.map((u) =>
          h(
            'tr',
            { class: u.id === selectedId ? 'selected' : '' },
            h('td', {}, h('button', { type: 'button', class: 'link-button', text: u.email, onclick: () => loadUser(u.id) })),
            h('td', { text: formatDate(u.createdAt) }),
            h('td', { class: `num${u.balance < 0 ? ' negative' : ''}`, text: formatMoney(u.balance) }),
            h('td', { class: 'num', text: formatCents(u.paidCents) }),
            h('td', { class: 'num', text: formatMoney(u.spent) }),
            h('td', { class: 'num', text: u.answers.toLocaleString() }),
          ),
        ),
      ),
    ),
  );
}

async function loadUser(id) {
  selectedId = id;
  let user;
  try {
    user = await get(`/api/admin/user?id=${encodeURIComponent(id)}`);
  } catch (err) {
    setStatus(`Couldn't load that user: ${err.message}`, true);
    return;
  }
  for (const row of els.users.querySelectorAll('tbody tr')) row.classList.remove('selected');
  renderUser(user);
  els.detail.hidden = false;
}

function renderUser(user) {
  const amount = h('input', {
    type: 'number',
    step: '0.01',
    id: 'admin-credit-amount',
    placeholder: '5.00',
    'aria-label': 'Amount in dollars',
  });
  const note = h('input', { type: 'text', id: 'admin-credit-note', placeholder: 'Reason (shown to the user)', maxlength: '200', 'aria-label': 'Reason' });
  const creditForm = h(
    'form',
    {
      class: 'admin-credit',
      onsubmit: async (e) => {
        e.preventDefault();
        const cents = Math.round(Number.parseFloat(amount.value) * 100);
        if (!Number.isFinite(cents) || cents === 0) return setStatus('Enter an amount, such as 5 or -2.50.', true);
        try {
          await post('/api/admin/credit', { userId: user.id, cents, note: note.value });
          setStatus(`${cents > 0 ? 'Added' : 'Removed'} ${formatCents(Math.abs(cents))} ${cents > 0 ? 'to' : 'from'} ${user.email}.`);
          await Promise.all([loadUser(user.id), loadUsers()]);
        } catch (err) {
          setStatus(err.message, true);
        }
      },
    },
    h('label', { for: 'admin-credit-amount', class: 'field-label', text: 'Add credit ($, negative to remove)' }),
    h('div', { class: 'admin-credit-row' }, amount, note, h('button', { type: 'submit', class: 'primary small', text: 'Apply' })),
  );

  const payments = h('div', { class: 'table-wrap' });
  renderPayments(payments, user.payments, (p) => (p.kind === 'card' && p.refundedCents < p.cents ? refundButton(user, p) : null));

  const usage = h('div', { class: 'table-wrap' });
  fill(
    usage,
    user.usage.length
      ? h(
          'table',
          { class: 'settings-table usage-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'col', text: 'When' }),
              h('th', { scope: 'col', text: 'Model' }),
              ['Tokens in', 'Tokens out', 'Cost'].map((t) => h('th', { scope: 'col', class: 'num', text: t })),
            ),
          ),
          h(
            'tbody',
            {},
            user.usage.map((u) =>
              h(
                'tr',
                {},
                h('td', { text: formatDate(u.at) }),
                h('td', {}, h('code', { text: `${u.provider} · ${u.model}` })),
                h('td', { class: 'num', text: u.input.toLocaleString() }),
                h('td', { class: 'num', text: u.output.toLocaleString() }),
                h('td', { class: 'num', text: formatMoney(u.cost) }),
              ),
            ),
          ),
        )
      : h('p', { class: 'muted', text: 'No usage yet.' }),
  );

  fill(
    els.detail,
    h(
      'div',
      { class: 'panel-head' },
      h('h2', { text: user.email }),
      h('button', {
        type: 'button',
        class: 'ghost small',
        text: 'Close',
        onclick: () => {
          selectedId = '';
          els.detail.hidden = true;
        },
      }),
    ),
    h('p', { class: `balance${user.balance <= 0 ? ' empty-balance' : ''}`, text: formatMoney(user.balance) }),
    h('p', { class: 'muted', text: `Joined ${formatDate(user.createdAt)}` }),
    creditForm,
    h('h3', { text: 'Payments and credits' }),
    payments,
    h('h3', { text: 'Recent usage' }),
    usage,
  );
}

function refundButton(user, payment) {
  const left = payment.cents - payment.refundedCents;
  const button = h('button', { type: 'button', class: 'ghost small', text: 'Refund…' });
  button.addEventListener('click', () => {
    const input = h('input', { type: 'number', step: '0.01', min: '0.01', max: (left / 100).toFixed(2), value: (left / 100).toFixed(2), 'aria-label': 'Refund amount in dollars', class: 'refund-amount' });
    const confirm = h('button', {
      type: 'button',
      class: 'primary small danger',
      text: 'Refund to card',
      onclick: async () => {
        const cents = Math.round(Number.parseFloat(input.value) * 100);
        confirm.disabled = true;
        try {
          const { balance } = await post('/api/admin/refund', { paymentId: payment.id, cents });
          setStatus(`Refunded ${formatCents(cents)} to ${user.email}'s card. Their balance is now ${formatMoney(balance)}.`);
          await Promise.all([loadUser(user.id), loadUsers()]);
        } catch (err) {
          setStatus(`Refund failed: ${err.message}`, true);
          confirm.disabled = false;
        }
      },
    });
    const cancel = h('button', { type: 'button', class: 'ghost small', text: 'Cancel', onclick: () => wrap.replaceWith(button) });
    const wrap = h('span', { class: 'refund-confirm' }, '$', input, confirm, cancel);
    button.replaceWith(wrap);
    input.focus();
  });
  return button;
}
