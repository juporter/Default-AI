// Settings view: which providers have keys, and importing a settings file
// (.env or JSON) that the server saves into its .env file.

import { h, $ } from './dom.js';

let deps; // { getProviders, onApplied }
let pendingText = '';
const els = {};

export function initSettings(options) {
  deps = options;
  Object.assign(els, {
    keys: $('#settings-keys'),
    current: $('#settings-current'),
    importPanel: $('#settings-import'),
    locked: $('#settings-locked'),
    fileButton: $('#settings-file'),
    fileInput: $('#settings-file-input'),
    paste: $('#settings-paste'),
    previewButton: $('#settings-preview-button'),
    preview: $('#settings-preview'),
    status: $('#settings-status'),
  });

  els.fileButton.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', async () => {
    const file = els.fileInput.files[0];
    els.fileInput.value = '';
    if (!file) return;
    if (file.size > 200_000) return setStatus(`${file.name} is too large to be a settings file.`, true);
    await preview(await file.text(), file.name);
  });
  els.previewButton.addEventListener('click', () => preview(els.paste.value, 'the pasted text'));
}

export async function showSettings() {
  renderKeys();
  await loadCurrent();
}

function renderKeys() {
  els.keys.replaceChildren(
    ...deps.getProviders().map((p) =>
      h(
        'tr',
        { 'data-provider': p.id },
        h('th', { scope: 'row' }, h('span', { class: 'provider-dot', 'aria-hidden': 'true' }), ` ${p.name}`),
        h('td', {}, h('span', { class: `status ${p.configured ? 'ready' : 'missing'}`, text: p.configured ? 'Ready' : 'No key' })),
        h('td', {}, h('code', { text: p.keyEnv })),
        h('td', {}, p.keyUrl ? h('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Get a key' }) : null),
      ),
    ),
  );
}

async function loadCurrent() {
  let data;
  try {
    const res = await fetch('/api/settings');
    if (res.status === 403) {
      els.locked.hidden = false;
      els.importPanel.hidden = true;
      els.current.replaceChildren();
      return;
    }
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (err) {
    els.current.replaceChildren(h('p', { class: 'error-text', text: `Couldn't load settings: ${err.message}` }));
    return;
  }
  els.locked.hidden = true;
  els.importPanel.hidden = false;
  const set = data.variables.filter((v) => v.set);
  els.current.replaceChildren(
    set.length
      ? h(
          'table',
          { class: 'settings-table' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Setting' }), h('th', { scope: 'col', text: 'Value' }))),
          h('tbody', {}, set.map((v) => h('tr', {}, h('td', {}, h('code', { text: v.name })), h('td', { class: 'value', text: v.value })))),
        )
      : h('p', { class: 'muted', text: 'No settings saved yet.' }),
  );
}

async function preview(text, label) {
  els.preview.replaceChildren();
  pendingText = '';
  if (!text.trim()) return setStatus('Choose a file or paste some settings first.', true);
  setStatus(`Checking ${label}…`);
  let data;
  try {
    const res = await postJson('/api/settings/preview', { text });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (err) {
    return setStatus(`Couldn't read ${label}: ${err.message}`, true);
  }
  setStatus('');

  const actionLabel = { add: 'Add', replace: 'Replace', clear: 'Remove' };
  const parts = [];
  if (data.errors.length) {
    parts.push(h('ul', { class: 'error-list', role: 'alert' }, data.errors.map((e) => h('li', { text: e }))));
  }
  if (data.changes.length) {
    parts.push(
      h('p', { class: 'preview-intro', text: `Importing ${label} will change ${data.changes.length} setting${data.changes.length === 1 ? '' : 's'}:` }),
      h(
        'table',
        { class: 'settings-table' },
        h(
          'thead',
          {},
          h('tr', {}, h('th', { scope: 'col', text: 'Setting' }), h('th', { scope: 'col', text: 'New value' }), h('th', { scope: 'col', text: 'Change' })),
        ),
        h(
          'tbody',
          {},
          data.changes.map((c) =>
            h(
              'tr',
              {},
              h('td', {}, h('code', { text: c.name })),
              h('td', { class: 'value', text: c.value || '(empty)' }),
              h('td', { text: actionLabel[c.action] }),
            ),
          ),
        ),
      ),
    );
  } else if (!data.errors.length) {
    parts.push(h('p', { class: 'error-text', text: `${label} has no settings this app uses.` }));
  }
  if (data.ignored.length) {
    parts.push(h('p', { class: 'muted', text: `Ignored (not used by this app): ${data.ignored.join(', ')}` }));
  }

  const canApply = data.changes.length && !data.errors.length;
  if (canApply) pendingText = text;
  parts.push(
    h(
      'div',
      { class: 'preview-actions' },
      h('button', { type: 'button', class: 'primary', text: 'Save settings', disabled: !canApply, onclick: apply }),
      h('button', {
        type: 'button',
        class: 'ghost',
        text: 'Cancel',
        onclick: () => {
          pendingText = '';
          els.preview.replaceChildren();
        },
      }),
    ),
  );
  els.preview.replaceChildren(...parts);
}

async function apply() {
  if (!pendingText) return;
  const before = JSON.stringify((await (await fetch('/api/config')).json()).ads);
  let data;
  try {
    const res = await postJson('/api/settings/apply', { text: pendingText });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (err) {
    return setStatus(`Couldn't save: ${err.message}`, true);
  }
  pendingText = '';
  els.preview.replaceChildren();
  els.paste.value = '';
  const ready = data.providers.filter((p) => p.configured).map((p) => p.name);
  setStatus(
    `Saved ${data.applied.length} setting${data.applied.length === 1 ? '' : 's'}. ` +
      (ready.length ? `Ready: ${ready.join(', ')}.` : 'No providers have keys yet.'),
  );
  deps.onApplied({ providers: data.providers, adsChanged: JSON.stringify(data.ads) !== before, billing: data.billing });
  renderKeys();
  await loadCurrent();
}

function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error-text', isError);
  els.status.hidden = !message;
}
