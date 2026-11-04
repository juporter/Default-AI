// History view: prompts sent from this app, plus chats imported from other
// apps. Search, re-use a prompt, import, export and delete.

import { h, $, fill, formatDate, formatBytes, downloadFile, confirmButton } from './dom.js';
import { createCard } from './cards.js';
import { renderMarkdown } from './markdown.js';
import * as store from './store.js';
import { readImportFile, buildAppExport, SOURCES } from './importers.js';

const MAX_LISTED = 300;

let deps; // { usePrompt, providerById }
let entries = [];
let stale = true;
let selectedId = null;
const els = {};

export function initHistory(options) {
  deps = options;
  Object.assign(els, {
    search: $('#history-search'),
    source: $('#history-source'),
    importButton: $('#history-import'),
    importInput: $('#history-import-input'),
    exportButton: $('#history-export'),
    deleteSlot: $('#history-delete-slot'),
    status: $('#history-status'),
    count: $('#history-count'),
    list: $('#history-list'),
    detail: $('#history-detail'),
  });

  els.search.addEventListener('input', render);
  els.source.addEventListener('change', render);
  els.importButton.addEventListener('click', () => els.importInput.click());
  els.importInput.addEventListener('change', async () => {
    await importFiles([...els.importInput.files]);
    els.importInput.value = '';
  });
  els.exportButton.addEventListener('click', exportAll);
  els.deleteSlot.replaceChildren(
    confirmButton('Delete shown', 'Click again to delete', deleteShown, { className: 'ghost small' }),
  );
}

export function markHistoryStale() {
  stale = true;
}

export async function showHistory() {
  if (stale) await load();
  render();
  if (!store.persistent) {
    setStatus("This browser isn't letting the app save history, so it will be lost when you close the page.", true);
  }
}

async function load() {
  const [runs, conversations] = await Promise.all([store.getAll('runs'), store.getAll('conversations')]);
  entries = [
    ...runs.map((run) => ({
      type: 'run',
      id: run.id,
      source: 'app',
      title: firstLine(run.prompt),
      createdAt: run.createdAt,
      meta: `${run.responses.length} model${run.responses.length === 1 ? '' : 's'}`,
      item: run,
    })),
    ...conversations.map((c) => ({
      type: 'conversation',
      id: c.id,
      source: c.source,
      title: c.title,
      createdAt: c.createdAt,
      meta: `${c.messages.length} message${c.messages.length === 1 ? '' : 's'}`,
      item: c,
    })),
  ].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  stale = false;
}

function searchText(entry) {
  if (!entry.search) {
    const parts =
      entry.type === 'run'
        ? [entry.item.prompt, entry.item.system, ...entry.item.responses.map((r) => r.text)]
        : [entry.title, ...entry.item.messages.map((m) => m.text)];
    entry.search = parts.join('\n').toLowerCase();
  }
  return entry.search;
}

function filtered() {
  const query = els.search.value.trim().toLowerCase();
  const source = els.source.value;
  return entries.filter((e) => (source === 'all' || e.source === source) && (!query || searchText(e).includes(query)));
}

function render() {
  const matches = filtered();
  els.count.textContent = entries.length
    ? `${matches.length.toLocaleString()} of ${entries.length.toLocaleString()} shown`
    : '';

  if (!entries.length) {
    els.list.replaceChildren(
      h(
        'li',
        { class: 'history-empty' },
        'No history yet. Prompts you send are saved here, and you can import chats from ChatGPT, Claude or Gemini.',
      ),
    );
    renderDetail(null);
    return;
  }

  fill(
    els.list,
    matches.slice(0, MAX_LISTED).map((entry) =>
      h(
        'li',
        {},
        h(
          'button',
          {
            type: 'button',
            class: 'history-item',
            'aria-current': entry.id === selectedId ? 'true' : 'false',
            onclick: (e) => {
              selectedId = entry.id;
              for (const b of els.list.querySelectorAll('.history-item')) b.setAttribute('aria-current', 'false');
              e.currentTarget.setAttribute('aria-current', 'true');
              renderDetail(entry);
              if (window.matchMedia('(max-width: 860px)').matches) els.detail.scrollIntoView({ behavior: 'smooth' });
            },
          },
          h('span', { class: 'source-tag', 'data-source': entry.source, text: SOURCES[entry.source] || 'Other' }),
          h('span', { class: 'history-title', text: entry.title }),
          h('span', { class: 'history-meta', text: `${formatDate(entry.createdAt)} · ${entry.meta}` }),
        ),
      ),
    ),
    matches.length > MAX_LISTED
      ? h('li', { class: 'history-more', text: `Showing the newest ${MAX_LISTED}. Search to find older items.` })
      : null,
    matches.length ? null : h('li', { class: 'history-empty', text: 'Nothing matches your search.' }),
  );

  renderDetail(matches.find((e) => e.id === selectedId) || null);
}

function renderDetail(entry) {
  if (!entry) {
    els.detail.replaceChildren(h('p', { class: 'muted', text: 'Select an item to read it here.' }));
    return;
  }
  const remove = confirmButton('Delete', 'Click again to delete', async () => {
    await store.remove(entry.type === 'run' ? 'runs' : 'conversations', [entry.id]);
    entries = entries.filter((e) => e.id !== entry.id);
    selectedId = null;
    render();
    setStatus('Deleted.');
  });

  if (entry.type === 'run') {
    const run = entry.item;
    fill(
      els.detail,
      h(
        'header',
        { class: 'detail-head' },
        h('div', {}, h('p', { class: 'detail-meta', text: `This app · ${formatDate(run.createdAt)} · ${entry.meta}` })),
        h(
          'div',
          { class: 'detail-actions' },
          h('button', {
            type: 'button',
            class: 'primary small',
            text: 'Use this prompt',
            onclick: () => deps.usePrompt({ prompt: run.prompt, system: run.system, attachments: run.attachments }),
          }),
          remove,
        ),
      ),
      h('div', { class: 'prompt-block', text: run.prompt }),
      run.system ? h('p', { class: 'detail-system' }, h('strong', { text: 'System prompt: ' }), run.system) : null,
      run.attachments.length
        ? h('p', { class: 'run-files', text: `Files: ${run.attachments.map((a) => `${a.name} (${formatBytes(a.size)})`).join(', ')}` })
        : null,
      h(
        'div',
        { class: 'cards' },
        run.responses.map((r) => {
          const provider = deps.providerById(r.provider) || { id: r.provider, name: r.providerName || r.provider };
          const card = createCard(provider, r.model, { live: false });
          if (r.error) card.fail(r.error);
          else card.succeed(r);
          return card.el;
        }),
      ),
    );
    return;
  }

  const c = entry.item;
  const assistantName = SOURCES[c.source] && c.source !== 'other' ? SOURCES[c.source] : 'Assistant';
  els.detail.replaceChildren(
    h(
      'header',
      { class: 'detail-head' },
      h(
        'div',
        {},
        h('h2', { class: 'detail-title', text: c.title }),
        h('p', { class: 'detail-meta', text: `${SOURCES[c.source] || 'Other'} · ${formatDate(c.createdAt)} · ${entry.meta}` }),
      ),
      h('div', { class: 'detail-actions' }, remove),
    ),
    h(
      'ol',
      { class: 'messages' },
      c.messages.map((m) => {
        if (m.role === 'user') {
          return h(
            'li',
            { class: 'message', 'data-role': 'user' },
            h(
              'div',
              { class: 'message-head' },
              h('span', { class: 'message-role', text: 'You' }),
              h('button', {
                type: 'button',
                class: 'ghost small',
                text: 'Use this prompt',
                onclick: () => deps.usePrompt({ prompt: m.text }),
              }),
            ),
            h('div', { class: 'prompt-block', text: m.text }),
          );
        }
        const body = h('div', { class: 'markdown' });
        body.innerHTML = renderMarkdown(m.text);
        return h(
          'li',
          { class: 'message', 'data-role': 'assistant' },
          h('div', { class: 'message-head' }, h('span', { class: 'message-role', text: assistantName })),
          body,
        );
      }),
    ),
  );
}

async function importFiles(files) {
  for (const file of files) {
    setStatus(`Reading ${file.name}…`);
    try {
      const result = await readImportFile(file);
      if (result.kind === 'app') {
        await store.putMany('runs', result.runs);
        await store.putMany('conversations', result.conversations);
        setStatus(
          `Imported ${result.runs.length.toLocaleString()} saved prompts and ${result.conversations.length.toLocaleString()} chats from ${file.name}.`,
        );
      } else if (!result.conversations.length) {
        setStatus(`${file.name} has no chats to import.`, true);
      } else {
        await store.putMany('conversations', result.conversations);
        setStatus(`Imported ${result.conversations.length.toLocaleString()} ${SOURCES[result.source]} chats from ${file.name}.`);
      }
    } catch (err) {
      setStatus(`Couldn't import ${file.name}: ${err.message}`, true);
    }
  }
  await load();
  render();
}

async function exportAll() {
  const [runs, conversations] = await Promise.all([store.getAll('runs'), store.getAll('conversations')]);
  if (!runs.length && !conversations.length) {
    setStatus('There is no history to export yet.', true);
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  downloadFile(`default-ai-history-${date}.json`, JSON.stringify(buildAppExport(runs, conversations), null, 1));
  setStatus(`Exported ${runs.length.toLocaleString()} saved prompts and ${conversations.length.toLocaleString()} chats.`);
}

async function deleteShown() {
  const matches = filtered();
  if (!matches.length) return setStatus('Nothing to delete.', true);
  await store.remove('runs', matches.filter((e) => e.type === 'run').map((e) => e.id));
  await store.remove('conversations', matches.filter((e) => e.type === 'conversation').map((e) => e.id));
  const gone = new Set(matches.map((e) => e.id));
  entries = entries.filter((e) => !gone.has(e.id));
  if (gone.has(selectedId)) selectedId = null;
  render();
  setStatus(`Deleted ${matches.length.toLocaleString()} item${matches.length === 1 ? '' : 's'}.`);
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error-text', isError);
  els.status.hidden = !message;
}

function firstLine(text) {
  const line = String(text).trim().split('\n')[0];
  return line.length > 120 ? `${line.slice(0, 120)}…` : line || '(empty prompt)';
}
