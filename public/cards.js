// Answer cards: one per model, used for live runs and for saved history.

import { h } from './dom.js';
import { renderMarkdown } from './markdown.js';

// Stop reasons that mean the answer was cut off.
const TRUNCATED = new Set(['length', 'max_tokens', 'MAX_TOKENS']);

/**
 * @param {{id: string, name: string}} provider
 * @param {string} model
 * @param {{live?: boolean}} [options]  live cards show a spinner and a running timer
 */
export function createCard(provider, model, { live = true } = {}) {
  const badge = h('span', { class: 'badge', text: live ? '0.0s' : '' });
  const modelLabel = h('span', { class: 'card-model', text: model });
  const body = h('div', { class: 'card-body' }, live ? h('div', { class: 'spinner', role: 'status', 'aria-label': 'Waiting for answer' }) : null);
  const footer = h('footer', { class: 'card-footer', hidden: true });
  const sourcesBox = h('div', { class: 'card-sources', hidden: true });
  const el = h(
    'article',
    { class: 'card', 'data-provider': provider.id, 'data-state': live ? 'loading' : 'done' },
    h(
      'header',
      { class: 'card-header' },
      h(
        'div',
        { class: 'card-title' },
        h('span', { class: 'provider-dot', 'aria-hidden': 'true' }),
        h('h3', { text: provider.name }),
        modelLabel,
      ),
      badge,
    ),
    body,
    sourcesBox,
    footer,
  );

  const started = performance.now();
  const elapsed = () => (performance.now() - started) / 1000;
  const timer = live ? setInterval(() => (badge.textContent = `${elapsed().toFixed(1)}s`), 100) : null;

  // Streaming: re-render the Markdown at most once per frame.
  let streamed = '';
  let frame = 0;
  let streamBox = null;
  const renderStream = () => {
    frame = 0;
    if (!streamBox) {
      streamBox = h('div', { class: 'markdown streaming' });
      body.replaceChildren(streamBox);
    }
    streamBox.innerHTML = renderMarkdown(streamed);
  };

  return {
    el,
    /** Seconds since the card was created (for live cards). */
    elapsed,

    /** The answer so far, while it streams in. */
    update(text) {
      streamed = text;
      el.dataset.state = 'streaming';
      if (!frame) frame = requestAnimationFrame(renderStream);
    },

    /** The model is reasoning before it starts to answer. */
    thinking() {
      if (streamed) return;
      body.replaceChildren(
        h('div', { class: 'thinking', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { text: 'Thinking…' })),
      );
    },

    /** Show an answer: {text, model, usage, stopReason, sources, seconds?} */
    succeed(data) {
      clearInterval(timer);
      cancelAnimationFrame(frame);
      el.dataset.state = 'done';
      const seconds = typeof data.seconds === 'number' ? data.seconds : live ? elapsed() : null;
      badge.textContent = seconds == null ? '' : `${seconds.toFixed(1)}s`;
      if (data.model) modelLabel.textContent = data.model;

      const text = data.text || '';
      const rendered = h('div', { class: 'markdown' });
      rendered.innerHTML = text ? renderMarkdown(text) : '<p class="muted">(empty response)</p>';
      const raw = h('pre', { class: 'raw', hidden: true, text });
      body.replaceChildren(rendered, raw);

      const sources = (data.sources || []).filter((s) => /^https?:\/\//i.test(s.url));
      if (sources.length) {
        sourcesBox.replaceChildren(
          h('p', { class: 'sources-label', text: 'Sources' }),
          h(
            'ol',
            {},
            sources.map((s) => h('li', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: s.title || s.url }))),
          ),
        );
        sourcesBox.hidden = false;
      }

      const usage = [];
      if (data.usage?.input != null) usage.push(`${data.usage.input.toLocaleString()} in`);
      if (data.usage?.output != null) usage.push(`${data.usage.output.toLocaleString()} out`);
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
      footer.replaceChildren(
        ...[
          h('span', { class: 'usage', text: usage.length ? `${usage.join(' · ')} tokens` : '' }),
          data.costText && h('span', { class: 'cost', text: data.costText, title: data.costTitle || '' }),
          TRUNCATED.has(data.stopReason) && h('span', { class: 'warn', text: 'Cut off (token limit)' }),
          h('span', { class: 'spacer' }),
          toggle,
          copy,
        ].filter(Boolean),
      );
      footer.hidden = false;
    },

    /** Show an error, below any text that arrived before it. */
    fail(message, partialText = streamed) {
      clearInterval(timer);
      cancelAnimationFrame(frame);
      el.dataset.state = 'error';
      badge.textContent = message === 'Cancelled' ? 'Cancelled' : 'Error';
      const partial = h('div', { class: 'markdown' });
      if (partialText) partial.innerHTML = renderMarkdown(partialText);
      body.replaceChildren(...[partialText && partial, h('p', { class: 'error', text: message })].filter(Boolean));
    },
  };
}
