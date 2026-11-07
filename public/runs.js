// A "run" is one prompt sent to several models, plus any follow-up questions.
// Each model keeps its own side of the conversation.
//
// Saved shape (History, export):
//   {
//     id, createdAt, system,
//     models: [{provider, providerName, model}],
//     turns:  [{prompt, attachments: [{name, size, text, pages?}], createdAt, responses: [Response]}],
//     prompt,  // the first turn's prompt, for the History list
//   }
//   Response: {provider, providerName, model, text, error, seconds, usage, stopReason, sources,
//              cost?, estimatedCost?, costEstimated?}

import { h } from './dom.js';
import { createCard } from './cards.js';
import { buildPrompt } from './prompt.js';
import { formatMoney } from './account.js';

export const MAX_TURNS = 50;

/** Bring older saved runs (one prompt, no turns) up to the current shape. */
export function normalizeRun(run) {
  if (Array.isArray(run.turns) && run.turns.length) {
    return { ...run, prompt: run.turns[0].prompt, models: run.models?.length ? run.models : modelsOf(run.turns[0].responses) };
  }
  const turn = {
    prompt: run.prompt || '',
    attachments: run.attachments || [],
    createdAt: run.createdAt,
    responses: run.responses || [],
  };
  return { id: run.id, createdAt: run.createdAt, system: run.system || '', models: modelsOf(turn.responses), turns: [turn], prompt: turn.prompt };
}

function modelsOf(responses = []) {
  return responses.map((r) => ({ provider: r.provider, providerName: r.providerName || r.provider, model: r.model }));
}

/**
 * The messages to send one model for turn `index`: every earlier turn it
 * answered, then the new question. Turns it failed are left out.
 */
export function conversationFor(run, providerId, index) {
  const messages = [];
  run.turns.slice(0, index).forEach((turn) => {
    const answer = turn.responses.find((r) => r.provider === providerId);
    if (!answer || answer.error || !answer.text) return;
    messages.push({ role: 'user', content: buildPrompt(turn.prompt, turn.attachments) });
    messages.push({ role: 'assistant', content: answer.text });
  });
  const turn = run.turns[index];
  messages.push({ role: 'user', content: buildPrompt(turn.prompt, turn.attachments) });
  return messages;
}

/** "$0.0126" for a charge, "≈ $0.0012" for an estimate, '' when unknown. */
export function costText(r) {
  if (typeof r?.cost === 'number') return formatMoney(r.cost);
  if (typeof r?.estimatedCost === 'number') return `≈ ${formatMoney(r.estimatedCost)}`;
  return '';
}

export function costTitle(r) {
  if (typeof r?.cost === 'number') return r.costEstimated ? 'Charged. The provider gave no token counts, so they were estimated from the text.' : 'Charged to your balance';
  if (typeof r?.estimatedCost === 'number') {
    return r.costEstimated
      ? "Estimate at the provider's list price. Token counts were estimated from the text."
      : "Estimate at the provider's list price, from the token counts it reported";
  }
  return '';
}

/** Total for the whole run (all turns), e.g. "≈ $0.031". */
export function runCostText(run) {
  let charged = 0;
  let estimated = 0;
  let anyCharged = false;
  let anyEstimate = false;
  for (const turn of run.turns) {
    for (const r of turn.responses) {
      if (typeof r.cost === 'number') {
        charged += r.cost;
        anyCharged = true;
      } else if (typeof r.estimatedCost === 'number') {
        estimated += r.estimatedCost;
        anyEstimate = true;
      }
    }
  }
  if (anyCharged) return `Charged ${formatMoney(charged)}`;
  if (anyEstimate) return `≈ ${formatMoney(estimated)} total`;
  return '';
}

/**
 * Draw a run. With `onFollowUp`, it ends with a box for asking every model a
 * follow-up question; `onFollowUp(text)` is called when it's sent.
 * @returns {{el, addTurn(turn, {live}), setBusy(busy, cancel?), refreshCost()}}
 */
export function createRunView(run, { providerById, onFollowUp, onContinue, label, showPrompt = true } = {}) {
  const provider = (m) => providerById(m.provider) || { id: m.provider, name: m.providerName || m.provider };
  const first = run.turns[0]?.prompt || run.prompt || '';
  const costLine = h('span', { class: 'run-cost' });
  const cancel = h('button', { type: 'button', class: 'ghost small', text: 'Cancel', hidden: true });
  const turnsBox = h('div', { class: 'turns' });
  const header = h(
    'header',
    { class: 'run-header' },
    showPrompt
      ? h('p', { class: 'run-prompt', title: first, text: first.length > 220 ? `${first.slice(0, 220)}…` : first })
      : h('span', { class: 'spacer' }),
    costLine,
    h('span', {
      class: 'run-time',
      text: label || new Date(run.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    }),
    cancel,
    onContinue ? h('button', { type: 'button', class: 'primary small', text: 'Continue conversation', onclick: onContinue }) : null,
  );

  let form = null;
  let input = null;
  let send = null;
  if (onFollowUp) {
    input = h('textarea', {
      rows: 2,
      class: 'follow-up-input',
      placeholder: `Ask ${run.models.length === 1 ? 'the model' : `all ${run.models.length} models`} a follow-up question…`,
      'aria-label': 'Follow-up question',
    });
    send = h('button', { type: 'submit', class: 'primary small', text: 'Send follow-up' });
    form = h(
      'form',
      {
        class: 'follow-up',
        onsubmit: (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text || send.disabled) return;
          if (run.turns.length >= MAX_TURNS) {
            input.setCustomValidity('This conversation is long enough. Start a new prompt.');
            input.reportValidity();
            return;
          }
          input.value = '';
          onFollowUp(text);
        },
      },
      input,
      h('div', { class: 'follow-up-actions' }, h('span', { class: 'muted hint', text: 'Each model answers with its own earlier replies in mind.' }), send),
    );
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
  }

  const el = h('section', { class: 'run', 'data-run': run.id }, header, turnsBox, form);

  function addTurn(turn, { live = false } = {}) {
    const index = turnsBox.children.length;
    const cards = run.models.map((m) => createCard(provider(m), m.model, { live }));
    turnsBox.append(
      h(
        'div',
        { class: 'turn' },
        index > 0
          ? h('p', { class: 'turn-prompt' }, h('span', { class: 'turn-label', text: 'Follow-up' }), h('span', { text: turn.prompt }))
          : null,
        turn.attachments?.length
          ? h('p', { class: 'run-files', text: `Files: ${turn.attachments.map((a) => a.name).join(', ')}` })
          : null,
        h('div', { class: 'cards' }, cards.map((c) => c.el)),
      ),
    );
    if (!live) {
      run.models.forEach((m, i) => {
        const r = turn.responses.find((x) => x.provider === m.provider);
        if (!r) cards[i].fail('Not asked');
        else if (r.error) cards[i].fail(r.error, r.text);
        else cards[i].succeed({ ...r, costText: costText(r), costTitle: costTitle(r) });
      });
    }
    return cards;
  }

  function setBusy(busy, onCancel) {
    cancel.hidden = !busy;
    cancel.onclick = busy && onCancel ? onCancel : null;
    if (send) {
      send.disabled = busy;
      send.textContent = busy ? 'Answering…' : 'Send follow-up';
    }
  }

  function refreshCost() {
    const text = runCostText(run);
    costLine.textContent = text;
    costLine.hidden = !text;
  }

  run.turns.forEach((turn) => addTurn(turn));
  refreshCost();
  return { el, addTurn, setBusy, refreshCost, focusFollowUp: () => input?.focus({ preventScroll: true }) };
}
