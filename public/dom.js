// Small DOM helpers shared by the views.

/** Create an element: h('button', {class: 'x', onclick}, 'Label') */
export function h(tag, attrs = {}, ...children) {
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

export const $ = (selector, root = document) => root.querySelector(selector);

/** Replace an element's children, skipping null/false (replaceChildren would print them as text). */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(iso) {
  if (!iso) return 'Unknown date';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Save text as a file in the browser's downloads. */
export function downloadFile(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = h('a', { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** A button that asks "Are you sure?" in place before running `action`. */
export function confirmButton(label, confirmLabel, action, { className = 'ghost small' } = {}) {
  const button = h('button', { type: 'button', class: className, text: label });
  let armed = false;
  let timer;
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = confirmLabel;
      button.classList.add('danger');
      timer = setTimeout(() => {
        armed = false;
        button.textContent = label;
        button.classList.remove('danger');
      }, 4000);
      return;
    }
    clearTimeout(timer);
    button.disabled = true;
    try {
      await action();
    } finally {
      button.disabled = false;
      armed = false;
      button.textContent = label;
      button.classList.remove('danger');
    }
  });
  return button;
}
