// Small, dependency-free Markdown renderer for model answers.
//
// Safety model: every piece of model text is HTML-escaped before it is placed
// in the output, and the only tags emitted are the fixed ones below. Links are
// only created for http(s) URLs.
//
// Supported: paragraphs, headings, fenced code, inline code, bold, italic,
// strikethrough, links, (nested) lists, blockquotes, tables, horizontal rules.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

export function renderInline(text) {
  // Odd entries are `code spans`, which get no further formatting.
  return String(text)
    .split(/(`[^`\n]+`)/)
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return escapeHtml(part)
        .replace(
          /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
        )
        .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
        .replace(/__(?=\S)(.+?)(?<=\S)__/g, '<strong>$1</strong>')
        .replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, '$1<em>$2</em>')
        .replace(/(^|[^\w])_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1<em>$2</em>')
        .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<del>$1</del>');
    })
    .join('');
}

export function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let i = 0;

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    let m;

    if ((m = line.match(FENCE_RE))) {
      flushParagraph();
      const fence = m[1];
      const lang = m[2];
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence)) code.push(lines[i++]);
      i++; // closing fence
      const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${langAttr}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      i++;
      continue;
    }

    if ((m = line.match(HEADING_RE))) {
      flushParagraph();
      const level = m[1].length;
      out.push(`<h${level}>${renderInline(m[2])}</h${level}>`);
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      flushParagraph();
      out.push('<hr>');
      i++;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      const table = parseTable(lines, i);
      out.push(table.html);
      i = table.next;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      flushParagraph();
      const quoted = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) quoted.push(lines[i++].replace(QUOTE_RE, ''));
      out.push(`<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`);
      continue;
    }

    if (LIST_RE.test(line)) {
      flushParagraph();
      const list = parseList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }

    paragraph.push(line.trim());
    i++;
  }

  flushParagraph();
  return out.join('\n');
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function isTableSeparator(line) {
  if (!line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function parseTable(lines, start) {
  const header = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((cell) => {
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
    if (cell.endsWith(':')) return 'right';
    if (cell.startsWith(':')) return 'left';
    return '';
  });
  const cellHtml = (tag, text, col) => {
    const align = aligns[col] ? ` class="align-${aligns[col]}"` : '';
    return `<${tag}${align}>${renderInline(text)}</${tag}>`;
  };

  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    const cells = splitRow(lines[i]);
    rows.push(`<tr>${header.map((_, col) => cellHtml('td', cells[col] ?? '', col)).join('')}</tr>`);
    i++;
  }
  const head = `<tr>${header.map((text, col) => cellHtml('th', text, col)).join('')}</tr>`;
  return {
    html: `<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div>`,
    next: i,
  };
}

function parseList(lines, start) {
  const html = [];
  const stack = []; // open lists: {indent, tag}
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(LIST_RE);

    if (!m) {
      if (!line.trim()) {
        // A blank line only ends the list if the next content isn't another item.
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && LIST_RE.test(lines[j])) {
          i = j;
          continue;
        }
        break;
      }
      // Indented text continues the current item (but let code fences render as code).
      if (/^\s+\S/.test(line) && !FENCE_RE.test(line)) {
        html.push(`<br>${renderInline(line.trim())}`);
        i++;
        continue;
      }
      break;
    }

    const indent = m[1].replace(/\t/g, '    ').length;
    const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
    const number = Number.parseInt(m[2], 10);
    const startAttr = tag === 'ol' && number !== 1 ? ` start="${number}"` : '';

    if (!stack.length || indent > stack[stack.length - 1].indent) {
      html.push(`<${tag}${startAttr}>`);
      stack.push({ indent, tag });
    } else {
      while (stack.length > 1 && indent < stack[stack.length - 1].indent) {
        html.push(`</li></${stack.pop().tag}>`);
      }
      html.push('</li>');
      const top = stack[stack.length - 1];
      if (top.tag !== tag) {
        html.push(`</${top.tag}><${tag}${startAttr}>`);
        top.tag = tag;
      }
    }
    html.push(`<li>${renderInline(m[3])}`);
    i++;
  }

  while (stack.length) html.push(`</li></${stack.pop().tag}>`);
  return { html: html.join(''), next: i };
}
