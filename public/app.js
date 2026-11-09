import { h, $, formatBytes } from './dom.js';
import { checkFile, checkText, documentType, isDocument, looksBinary, textBytes } from './prompt.js';
import { createRunView, normalizeRun, conversationFor, costText, costTitle } from './runs.js';
import * as store from './store.js';
import { setupAds } from './ads.js';
import { initHistory, showHistory, markHistoryStale } from './history.js';
import { initSettings, showSettings } from './settings-view.js';
import * as account from './account.js';
import { initAdmin, setAdminVisible, showAdmin } from './admin.js';

const STORAGE_KEY = 'multi-llm:prefs:v1';
const CUSTOM = '__custom__';
const VIEWS = ['compare', 'history', 'settings', 'account', 'admin'];

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
  attach: $('#attach'),
  attachInput: $('#attach-input'),
  attachments: $('#attachments'),
  attachError: $('#attach-error'),
  results: $('#results'),
  emptyResults: $('#empty-results'),
  clearResults: $('#clear-results'),
};

const state = {
  providers: [],
  prefs: loadPrefs(),
  models: {}, // provider id -> string[] loaded from the provider
  attachments: [], // {name, size, text}
  config: { billing: { enabled: false } },
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
// Views: #compare (default), #history, #settings
// ---------------------------------------------------------------------------

function showView() {
  const requested = location.hash.slice(1);
  const available = VIEWS.filter(
    (v) => (v !== 'account' || account.billingEnabled()) && (v !== 'admin' || account.isAdmin()),
  );
  const name = available.includes(requested) ? requested : 'compare';
  for (const view of VIEWS) {
    $(`#view-${view}`).hidden = view !== name;
    const link = $(`#nav-${view}`);
    if (view === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (name === 'history') showHistory();
  if (name === 'settings') showSettings();
  if (name === 'account') account.showAccount();
  if (name === 'admin') showAdmin();
}

// ---------------------------------------------------------------------------
// Providers panel
// ---------------------------------------------------------------------------

function isSelected(p) {
  if (!usable(p)) return false;
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
  const chosen = (state.prefs.models[p.id] || '').trim() || p.defaultModel;
  if (!account.billingEnabled() || account.priceOf(p.id, chosen)) return chosen;
  // With billing on, fall back to a model that has a price.
  return pricedModels(p)[0] || chosen;
}

/** With billing on, only models with a price can be used. */
function pricedModels(p) {
  return account.billingEnabled() ? (state.config.billing.prices || []).filter((x) => x.provider === p.id).map((x) => x.model) : [];
}

function usable(p) {
  return p.configured && (!account.billingEnabled() || pricedModels(p).length > 0);
}

function renderProviders() {
  els.providerList.replaceChildren(...state.providers.map(providerCard));
  updateSendButton();
}

function providerCard(p) {
  const checkbox = h('input', {
    type: 'checkbox',
    id: `pick-${p.id}`,
    checked: isSelected(p),
    disabled: !usable(p),
    'aria-describedby': `status-${p.id}`,
    onchange: () => {
      setSelected(p, checkbox.checked);
      card.classList.toggle('selected', checkbox.checked);
      updateSendButton();
    },
  });

  const card = h(
    'div',
    { class: `provider${isSelected(p) ? ' selected' : ''}${usable(p) ? '' : ' unconfigured'}`, 'data-provider': p.id },
    h(
      'label',
      { class: 'provider-toggle' },
      checkbox,
      h('span', { class: 'provider-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'provider-name' }, p.name, h('span', { class: 'provider-vendor', text: p.vendor !== p.name ? p.vendor : '' })),
      h('span', {
        class: `status ${usable(p) ? 'ready' : 'missing'}`,
        id: `status-${p.id}`,
        text: !p.configured ? 'No key' : usable(p) ? 'Ready' : 'No prices',
      }),
    ),
  );

  if (usable(p)) {
    card.append(modelPicker(p));
  } else if (p.configured) {
    card.append(h('p', { class: 'setup', text: 'None of this provider’s models has a price yet.' }));
  } else {
    card.append(
      h(
        'p',
        { class: 'setup' },
        'Add ',
        h('code', { text: p.keyEnv }),
        ' in ',
        h('a', { href: '#settings', text: 'Settings' }),
        p.keyUrl ? [' · ', h('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Get a key' })] : null,
      ),
    );
  }
  return card;
}

function modelPicker(p) {
  const select = h('select', { class: 'model-select', id: `model-${p.id}`, 'aria-label': `${p.name} model` });
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

  const billed = account.billingEnabled();
  const showPrice = () => {
    if (!billed) return;
    const price = account.priceOf(p.id, select.value);
    priceLine.textContent = price ? account.describePrice(price) : '';
  };
  const priceLine = h('span', { class: 'model-price' });

  select.addEventListener('change', () => {
    showPrice();
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

  const fillOptions = (listed) => {
    const chosen = currentModel(p);
    let ids = [...new Set([p.defaultModel, chosen, ...(listed || p.models || [])])];
    // With billing on, only priced models can be chosen (and no free-typed IDs).
    if (billed) ids = pricedModels(p);
    ids.sort((a, b) => (a === p.defaultModel ? -1 : b === p.defaultModel ? 1 : a.localeCompare(b)));
    select.replaceChildren(
      ...ids.map((id) => h('option', { value: id, text: id === p.defaultModel ? `${id} (default)` : id })),
      billed ? null : h('option', { value: CUSTOM, text: 'Other model ID…' }),
    );
    select.value = chosen;
    showPrice();
  };
  fillOptions(state.models[p.id]);

  const load = async () => {
    if (billed) {
      meta.textContent = `${select.options.length} model${select.options.length === 1 ? '' : 's'} available`;
      return;
    }
    meta.textContent = 'Loading models…';
    meta.title = '';
    meta.className = 'model-meta';
    try {
      const res = await fetch(`/api/models?provider=${encodeURIComponent(p.id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.models.length) throw new Error('the provider listed no models');
      state.models[p.id] = data.models;
      if (custom.hidden) fillOptions(data.models);
      meta.textContent = `${data.models.length} model${data.models.length === 1 ? '' : 's'} available`;
    } catch (err) {
      meta.textContent = 'Showing suggested models';
      meta.title = `Couldn't load the full list: ${err.message}`;
      meta.className = 'model-meta warn';
    }
  };
  load();

  return h('div', { class: 'model-row' }, select, custom, meta, billed ? priceLine : null);
}

/** Reflect state.prefs.selected in the checkboxes without rebuilding the cards. */
function syncSelection() {
  for (const p of state.providers) {
    const box = $(`#pick-${p.id}`);
    if (!box) continue;
    box.checked = isSelected(p);
    box.closest('.provider').classList.toggle('selected', isSelected(p));
  }
  updateSendButton();
}

function selectedProviders() {
  return state.providers.filter(isSelected);
}

function updateSendButton() {
  const n = selectedProviders().length;
  if (account.billingEnabled() && !account.signedIn()) {
    els.send.disabled = false;
    els.send.textContent = 'Sign in to send';
    return;
  }
  els.send.disabled = n === 0;
  els.send.textContent = n === 0 ? 'Select a model' : `Send to ${n} model${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

const attachedBytes = (except) => state.attachments.reduce((n, a) => (a === except ? n : n + (a.size || 0)), 0);

async function addFiles(files) {
  const problems = [];
  const showProblems = () => {
    els.attachError.textContent = problems.join(' ');
    els.attachError.hidden = !problems.length;
  };
  for (const file of files) {
    const problem = checkFile(file, attachedBytes());
    if (problem) {
      problems.push(problem);
      continue;
    }

    if (isDocument(file)) {
      // PDFs and Word files: the server pulls out their text.
      const item = { name: file.name, size: 0, text: '', pending: true };
      state.attachments.push(item);
      renderAttachments();
      try {
        const res = await fetch('/api/extract', {
          method: 'POST',
          headers: { 'content-type': documentType(file), 'x-file-name': encodeURIComponent(file.name) },
          body: file,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const tooBig = checkText(file.name, data.text, attachedBytes(item));
        if (tooBig) throw new Error(tooBig);
        Object.assign(item, { pending: false, text: data.text, size: textBytes(data.text), ...(data.pages ? { pages: data.pages } : {}) });
      } catch (err) {
        state.attachments.splice(state.attachments.indexOf(item), 1);
        problems.push(err.message.includes(file.name) ? err.message : `${file.name}: ${err.message}`);
      }
      renderAttachments();
      showProblems();
      continue;
    }

    const text = await file.text();
    if (looksBinary(text)) {
      problems.push(`${file.name} doesn't look like a text file.`);
      continue;
    }
    state.attachments.push({ name: file.name, size: file.size, text });
  }
  renderAttachments();
  showProblems();
}

function renderAttachments() {
  els.attachments.replaceChildren(
    ...state.attachments.map((file) =>
      h(
        'li',
        { class: `attachment${file.pending ? ' pending' : ''}` },
        h('span', { class: 'attachment-name', text: file.name }),
        h('span', {
          class: 'attachment-size',
          text: file.pending ? 'Reading…' : file.pages ? `${file.pages} page${file.pages === 1 ? '' : 's'}` : formatBytes(file.size),
          title: file.pending ? '' : `${formatBytes(file.size)} of text`,
        }),
        h('button', {
          type: 'button',
          class: 'attachment-remove',
          'aria-label': `Remove ${file.name}`,
          text: '×',
          onclick: () => {
            state.attachments.splice(state.attachments.indexOf(file), 1);
            renderAttachments();
            els.attachError.hidden = true;
          },
        }),
      ),
    ),
  );
  els.attachments.hidden = !state.attachments.length;
}

// ---------------------------------------------------------------------------
// Running a prompt, and follow-up questions
// ---------------------------------------------------------------------------

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const providerById = (id) => state.providers.find((p) => p.id === id);

async function sendPrompt(event) {
  event.preventDefault();
  if (account.billingEnabled() && !account.signedIn()) {
    location.hash = '#account';
    return;
  }
  const prompt = els.prompt.value;
  if (!prompt.trim()) {
    els.prompt.focus();
    return;
  }
  if (state.attachments.some((a) => a.pending)) {
    els.attachError.textContent = 'Wait until the attached files have been read.';
    els.attachError.hidden = false;
    return;
  }
  const targets = selectedProviders();
  if (!targets.length) return;

  const system = els.system.value;
  state.prefs.system = system;
  savePrefs();

  const run = {
    id: newId(),
    createdAt: new Date().toISOString(),
    system,
    models: targets.map((p) => ({ provider: p.id, providerName: p.name, model: currentModel(p) })),
    turns: [],
    prompt,
  };
  const view = showRunInCompare(run);
  await sendTurn(run, view, prompt, state.attachments.map(({ name, size, text, pages }) => ({ name, size, text, ...(pages ? { pages } : {}) })));
}

/** Put a run at the top of Compare, with a follow-up box. */
function showRunInCompare(run) {
  let view;
  view = createRunView(run, {
    providerById,
    onFollowUp: (question) => sendTurn(run, view, question, []),
  });
  els.results.prepend(view.el);
  els.emptyResults.hidden = true;
  els.clearResults.hidden = false;
  return view;
}

/** Ask every model in the run one question (the first prompt or a follow-up). */
async function sendTurn(run, view, prompt, attachments) {
  const turn = { prompt, attachments, createdAt: new Date().toISOString(), responses: [] };
  run.turns.push(turn);
  const index = run.turns.length - 1;
  const cards = view.addTurn(turn, { live: true });
  const controller = new AbortController();
  view.setBusy(true, () => controller.abort());

  turn.responses = await Promise.all(
    run.models.map((m, i) =>
      askProvider(m, conversationFor(run, m.provider, index), run.system, cards[i], controller.signal),
    ),
  );
  view.setBusy(false);
  view.refreshCost();

  try {
    await store.putMany('runs', [run]);
    markHistoryStale();
  } catch (err) {
    showNotice(`This answer couldn't be saved to History: ${err.message}`);
  }
}

/** Read newline-delimited JSON events from a streamed response. */
async function readEvents(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line));
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}

/** Stream one model's answer into its card. Resolves with the saved response. */
async function askProvider(m, messages, system, card, signal) {
  const base = { provider: m.provider, providerName: m.providerName, model: m.model, usage: {}, stopReason: '', sources: [] };
  let text = '';
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: m.provider, model: m.model, messages, system, stream: true }),
      signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    let done = null;
    let failure = null;
    await readEvents(res, (event) => {
      if (event.type === 'delta') {
        text += event.text;
        card.update(text);
      } else if (event.type === 'thinking') {
        card.thinking();
      } else if (event.type === 'done') {
        done = event;
      } else if (event.type === 'error') {
        failure = event;
      }
    });
    if (failure) {
      account.updateBalance(failure.balance);
      const err = new Error(failure.error || 'The answer broke off');
      err.cost = pickCost(failure);
      throw err;
    }
    if (!done) throw new Error('The answer stopped before it finished.');

    const response = {
      ...base,
      model: done.model || m.model,
      text: done.text ?? text,
      error: '',
      seconds: card.elapsed(),
      usage: done.usage || {},
      stopReason: done.stopReason || '',
      sources: done.sources || [],
      ...pickCost(done),
    };
    card.succeed({ ...response, costText: costText(response), costTitle: costTitle(response) });
    account.updateBalance(done.balance);
    return response;
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Cancelled' : err.message || 'Request failed';
    card.fail(message, text);
    return { ...base, text, error: message, seconds: card.elapsed(), ...(err.cost || {}) };
  }
}

function pickCost(event) {
  const out = {};
  for (const key of ['cost', 'estimatedCost', 'costEstimated']) if (event[key] !== undefined) out[key] = event[key];
  return out;
}

/** Called from History: put an old prompt (and its files) back in the composer. */
function usePrompt({ prompt, system = '', attachments = [] }) {
  els.prompt.value = prompt;
  els.system.value = system;
  if (system) els.systemDetails.open = true;
  state.attachments = attachments.map((a) => ({ name: a.name, size: a.size ?? textBytes(a.text), text: a.text, ...(a.pages ? { pages: a.pages } : {}) }));
  renderAttachments();
  els.attachError.hidden = true;
  goToCompare();
  els.prompt.focus();
}

/** Switch to Compare right away (not on the next hashchange), so focus can move there. */
function goToCompare() {
  if (location.hash !== '#compare') location.hash = '#compare';
  showView();
}

/** Called from History: reopen a saved conversation in Compare to ask more. */
function continueRun(saved) {
  const run = normalizeRun(structuredClone(saved));
  els.results.querySelector(`[data-run="${CSS.escape(run.id)}"]`)?.remove();
  const view = showRunInCompare(run);
  goToCompare();
  view.el.scrollIntoView({ block: 'start' });
  view.focusFollowUp();
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function showNotice(message) {
  els.notice.textContent = message;
  els.notice.hidden = false;
}

function onSettingsApplied({ providers, adsChanged, billing }) {
  state.providers = providers;
  renderProviders();
  if (adsChanged) showNotice('Ad settings changed. Reload the page to see them.');
  else if (billing && billing.enabled !== account.billingEnabled()) {
    showNotice('Billing settings changed. Reload the page to see them.');
  }
}

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

  els.attach.addEventListener('click', () => els.attachInput.click());
  els.attachInput.addEventListener('change', async () => {
    await addFiles([...els.attachInput.files]);
    els.attachInput.value = '';
  });
  els.form.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) {
      e.preventDefault();
      els.form.classList.add('dropping');
    }
  });
  els.form.addEventListener('dragleave', (e) => {
    if (!els.form.contains(e.relatedTarget)) els.form.classList.remove('dropping');
  });
  els.form.addEventListener('drop', (e) => {
    e.preventDefault();
    els.form.classList.remove('dropping');
    if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
  });

  if (state.prefs.system) {
    els.system.value = state.prefs.system;
    els.systemDetails.open = true;
  }

  initHistory({ usePrompt, continueRun, providerById });
  initSettings({
    getProviders: () => state.providers,
    onApplied: onSettingsApplied,
  });
  window.addEventListener('hashchange', showView);

  try {
    const [providersRes, configRes] = await Promise.all([fetch('/api/providers'), fetch('/api/config')]);
    if (!providersRes.ok) throw new Error(`HTTP ${providersRes.status}`);
    state.providers = (await providersRes.json()).providers;
    if (configRes.ok) {
      state.config = await configRes.json();
      setupAds(state.config.ads);
    }
  } catch (err) {
    showNotice(`Could not reach the server (${err.message}). Is "npm start" running?`);
    return;
  }

  initAdmin();
  account.initAccount(
    {
      getProviders: () => state.providers,
      onChange: () => {
        updateSendButton();
        setAdminVisible(account.isAdmin());
        if (location.hash === '#admin' && !account.isAdmin()) location.hash = '#account';
      },
    },
    state.config.billing,
  );
  await account.loadAccount();

  renderProviders();
  showView();
  if (!state.providers.some((p) => p.configured)) {
    showNotice('No API keys yet. Add them in Settings, or copy .env.example to .env and restart the server.');
  }
}

init();
