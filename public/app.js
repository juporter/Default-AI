import { renderMarkdown } from './markdown.js';

const STORAGE_KEY = 'multi-llm:prefs:v1';
const CUSTOM = '__custom__';
// Stop reasons that mean the answer was cut off.
const TRUNCATED = new Set(['length', 'max_tokens', 'MAX_TOKENS']);

const $ = (selector) => document.querySelector(selector);
const els = {
  providerList: $('#provider-list'),
  notice: $('#notice'),
  form: $('#prompt-form'),
  prompt: $('#prompt'),
  system: $('#system'),
  systemDetails: $('#system-details'),
  send: $('#send'),
  selectAll: $('#select-all'),
  selectNone: $('#select-none'),
  results: $('#results'),
  emptyResults: $('#empty-results'),
  clearResults: $('#clear-results'),
};

const state = {
  providers: [],
  prefs: loadPrefs(),
  models: {}, // provider id -> string[] loaded from the provider
};

// ---------------------------------------------------------------------------
// Preferences (per browser, best effort)
// ---------------------------------------------------------------------------

function loadPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (prefs && typeof prefs === 'object') return { models: {}, ...prefs };
  } catch {
    // storage unavailable or corrupt
  }
  return { models: {} };
}

function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.prefs));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Tiny DOM helper
// ---------------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) el.append(child);
  }
  return el;
}

// ---------------------------------------------------------------------------
// Providers panel
// ---------------------------------------------------------------------------

function isSelected(p) {
  if (!p.configured) return false;
  // First visit: select every provider that has a key.
  if (!Array.isArray(state.prefs.selected)) return true;
  return state.prefs.selected.includes(p.id);
}

function setSelected(p, selected) {
  const current = new Set(state.providers.filter(isSelected).map((x) => x.id));
  if (selected) current.add(p.id);
  else current.delete(p.id);
  state.prefs.selected = [...current];
  savePrefs();
}

function currentModel(p) {
  return (state.prefs.models[p.id] || '').trim() || p.defaultModel;
}

function renderProviders() {
  els.providerList.replaceChildren(...state.providers.map(providerCard));
  updateSendButton();
}

function providerCard(p) {
  const checkbox = h('input', {
    type: 'checkbox',
    checked: isSelected(p),
    disabled: !p.configured,
    'aria-describedby': `status-${p.id}`,
    onchange: () => {
      setSelected(p, checkbox.checked);
      card.classList.toggle('selected', checkbox.checked);
      updateSendButton();
    },
  });

  const card = h(
    'div',
    { class: `provider${isSelected(p) ? ' selected' : ''}${p.configured ? '' : ' unconfigured'}`, 'data-provider': p.id },
    h(
      'label',
      { class: 'provider-toggle' },
      checkbox,
      h('span', { class: 'provider-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'provider-name' }, p.name, h('span', { class: 'provider-vendor', text: p.vendor !== p.name ? p.vendor : '' })),
      h('span', {
        class: `status ${p.configured ? 'ready' : 'missing'}`,
        id: `status-${p.id}`,
        text: p.configured ? 'Ready' : 'No key',
      }),
    ),
  );

  if (p.configured) {
    card.append(modelPicker(p));
  } else {
    card.append(
      h(
        'p',
        { class: 'setup' },
        'Add ',
        h('code', { text: p.keyEnv }),
        ' to ',
        h('code', { text: '.env' }),
        p.keyUrl ? [' · ', h('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Get a key' })] : null,
      ),
    );
  }
  return card;
}

function modelPicker(p) {
  const select = h('select', { class: 'model-select', 'aria-label': `${p.name} model` });
  const custom = h('input', {
    class: 'model-custom',
    type: 'text',
    placeholder: 'Model ID',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': `${p.name} custom model ID`,
    hidden: true,
    oninput: () => {
      state.prefs.models[p.id] = custom.value.trim();
      savePrefs();
    },
  });
  const meta = h('span', { class: 'model-meta', 'aria-live': 'polite' });

  select.addEventListener('change', () => {
    if (select.value === CUSTOM) {
      custom.hidden = false;
      custom.value = currentModel(p);
      custom.focus();
      custom.select();
    } else {
      custom.hidden = true;
      state.prefs.models[p.id] = select.value;
      savePrefs();
    }
  });

  const fillOptions = () => {
    const chosen = currentModel(p);
    const ids = [...new Set([p.defaultModel, chosen, ...(state.models[p.id] || [])])].sort((a, b) =>
      a === p.defaultModel ? -1 : b === p.defaultModel ? 1 : a.localeCompare(b),
    );
    select.replaceChildren(
      ...ids.map((id) => h('option', { value: id, text: id === p.defaultModel ? `${id} (default)` : id })),
      h('option', { value: CUSTOM, text: 'Other model ID…' }),
    );
    select.value = chosen;
  };
  fillOptions();

  const load = async () => {
    meta.textContent = 'Loading models…';
    meta.title = '';
    meta.className = 'model-meta';
    try {
      const res = await fetch(`/api/models?provider=${encodeURIComponent(p.id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      state.models[p.id] = data.models;
      if (custom.hidden) fillOptions();
      meta.textContent = `${data.models.length} models available`;
    } catch (err) {
      meta.textContent = 'Could not list models';
      meta.title = err.message;
      meta.className = 'model-meta warn';
    }
  };
  load();

  return h('div', { class: 'model-row' }, select, custom, meta);
}

/** Reflect state.prefs.selected in the checkboxes without rebuilding the cards. */
function syncSelection() {
  for (const p of state.providers) {
    const card = els.providerList.querySelector(`[data-provider="${p.id}"]`);
    if (!card) continue;
    card.querySelector('input[type="checkbox"]').checked = isSelected(p);
    card.classList.toggle('selected', isSelected(p));
  }
  updateSendButton();
}

function selectedProviders() {
  return state.providers.filter(isSelected);
}

function updateSendButton() {
  const n = selectedProviders().length;
  els.send.disabled = n === 0;
  els.send.textContent = n === 0 ? 'Select a model' : `Send to ${n} model${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Running a prompt
// ---------------------------------------------------------------------------

async function sendPrompt(event) {
  event.preventDefault();
  const prompt = els.prompt.value;
  if (!prompt.trim()) {
    els.prompt.focus();
    return;
  }
  const targets = selectedProviders();
  if (!targets.length) return;

  const system = els.system.value;
  state.prefs.system = system;
  savePrefs();

  const controller = new AbortController();
  const run = createRun(prompt, targets, controller);
  els.results.prepend(run.el);
  els.emptyResults.hidden = true;
  els.clearResults.hidden = false;

  await Promise.allSettled(
    targets.map((p, index) => askProvider(p, currentModel(p), prompt, system, run.cards[index], controller.signal)),
  );
  run.done();
}

function createRun(prompt, targets, controller) {
  const cancel = h('button', { type: 'button', class: 'ghost small', text: 'Cancel', onclick: () => controller.abort() });
  const cards = targets.map((p) => createCard(p, currentModel(p)));
  const el = h(
    'section',
    { class: 'run' },
    h(
      'header',
      { class: 'run-header' },
      h('p', { class: 'run-prompt', title: prompt, text: prompt.length > 220 ? `${prompt.slice(0, 220)}…` : prompt }),
      h('span', { class: 'run-time', text: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }),
      cancel,
    ),
    h('div', { class: 'cards' }, cards.map((c) => c.el)),
  );
  return { el, cards, done: () => cancel.remove() };
}

function createCard(p, model) {
  const badge = h('span', { class: 'badge', text: '0.0s' });
  const modelLabel = h('span', { class: 'card-model', text: model });
  const body = h('div', { class: 'card-body' }, h('div', { class: 'spinner', 'aria-label': 'Waiting for answer' }));
  const footer = h('footer', { class: 'card-footer', hidden: true });
  const el = h(
    'article',
    { class: 'card', 'data-provider': p.id, 'data-state': 'loading' },
    h(
      'header',
      { class: 'card-header' },
      h('div', { class: 'card-title' }, h('span', { class: 'provider-dot', 'aria-hidden': 'true' }), h('h3', { text: p.name }), modelLabel),
      badge,
    ),
    body,
    footer,
  );

  const started = performance.now();
  const seconds = () => ((performance.now() - started) / 1000).toFixed(1);
  const timer = setInterval(() => (badge.textContent = `${seconds()}s`), 100);

  return {
    el,
    succeed(data) {
      clearInterval(timer);
      el.dataset.state = 'done';
      badge.textContent = `${seconds()}s`;
      if (data.model) modelLabel.textContent = data.model;

      const text = data.text || '';
      const rendered = h('div', { class: 'markdown' });
      rendered.innerHTML = text ? renderMarkdown(text) : '<p class="muted">(empty response)</p>';
      const raw = h('pre', { class: 'raw', hidden: true, text });
      body.replaceChildren(rendered, raw);

      const usage = [];
      if (data.usage?.input != null) usage.push(`${data.usage.input.toLocaleString()} in`);
      if (data.usage?.output != null) usage.push(`${data.usage.output.toLocaleString()} out`);
      const copy = h('button', {
        type: 'button',
        class: 'ghost small',
        text: 'Copy',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(text);
            copy.textContent = 'Copied';
          } catch {
            copy.textContent = 'Copy failed';
          }
          setTimeout(() => (copy.textContent = 'Copy'), 1500);
        },
      });
      const toggle = h('button', {
        type: 'button',
        class: 'ghost small',
        text: 'Raw',
        onclick: () => {
          raw.hidden = !raw.hidden;
          rendered.hidden = !raw.hidden;
          toggle.textContent = raw.hidden ? 'Raw' : 'Formatted';
        },
      });
      footer.replaceChildren(
        ...[
          h('span', { class: 'usage', text: usage.length ? `${usage.join(' · ')} tokens` : '' }),
          TRUNCATED.has(data.stopReason) && h('span', { class: 'warn', text: 'Cut off (token limit)' }),
          h('span', { class: 'spacer' }),
          toggle,
          copy,
        ].filter(Boolean),
      );
      footer.hidden = false;
    },
    fail(message) {
      clearInterval(timer);
      el.dataset.state = 'error';
      badge.textContent = 'Error';
      body.replaceChildren(h('p', { class: 'error', text: message }));
    },
  };
}

async function askProvider(p, model, prompt, system, card, signal) {
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: p.id, model, prompt, system }),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    card.succeed(data);
  } catch (err) {
    card.fail(err.name === 'AbortError' ? 'Cancelled' : err.message || 'Request failed');
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function init() {
  els.form.addEventListener('submit', sendPrompt);
  for (const field of [els.prompt, els.system]) {
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        els.form.requestSubmit();
      }
    });
  }
  els.selectAll.addEventListener('click', () => {
    state.prefs.selected = state.providers.filter((p) => p.configured).map((p) => p.id);
    savePrefs();
    syncSelection();
  });
  els.selectNone.addEventListener('click', () => {
    state.prefs.selected = [];
    savePrefs();
    syncSelection();
  });
  els.clearResults.addEventListener('click', () => {
    els.results.replaceChildren();
    els.emptyResults.hidden = false;
    els.clearResults.hidden = true;
  });

  if (state.prefs.system) {
    els.system.value = state.prefs.system;
    els.systemDetails.open = true;
  }

  try {
    const res = await fetch('/api/providers');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.providers = (await res.json()).providers;
  } catch (err) {
    showNotice(`Could not reach the server (${err.message}). Is "npm start" running?`);
    return;
  }

  renderProviders();
  if (!state.providers.some((p) => p.configured)) {
    showNotice('No API keys found. Copy .env.example to .env, add at least one key, then restart the server.');
  }
}

function showNotice(message) {
  els.notice.textContent = message;
  els.notice.hidden = false;
}

init();
