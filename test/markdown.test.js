import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderInline, escapeHtml } from '../public/markdown.js';

test('escapes raw HTML everywhere', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n# <img src=x onerror=alert(1)>\n\n- <b>x</b>');
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('only links http(s) URLs and cannot break out of href', () => {
  assert.equal(renderInline('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  assert.equal(
    renderInline('[docs](https://example.com/a?b=1&c=2)'),
    '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a>',
  );
  const tricky = renderInline('[x](https://e.com/"onmouseover="alert(1))');
  assert.ok(!tricky.includes('"onmouseover'));
});

test('inline formatting', () => {
  assert.equal(renderInline('**bold** and *it* and `a < b`'), '<strong>bold</strong> and <em>it</em> and <code>a &lt; b</code>');
  assert.equal(renderInline('~~old~~'), '<del>old</del>');
  assert.equal(renderInline('2 * 3 * 4'), '2 * 3 * 4');
  assert.equal(renderInline('snake_case_name'), 'snake_case_name');
  assert.equal(renderInline('`**not bold**`'), '<code>**not bold**</code>');
});

test('fenced code is escaped and not formatted', () => {
  const html = renderMarkdown('```js\nconst a = "<b>" && **x**;\n```');
  assert.equal(html, '<pre><code data-lang="js">const a = &quot;&lt;b&gt;&quot; &amp;&amp; **x**;</code></pre>');
});

test('unterminated code fence runs to the end', () => {
  assert.equal(renderMarkdown('```\nabc'), '<pre><code>abc</code></pre>');
});

test('headings, paragraphs, rules and quotes', () => {
  assert.equal(
    renderMarkdown('## Title\nline one\nline two\n\n---\n\n> quoted'),
    '<h2>Title</h2>\n<p>line one<br>line two</p>\n<hr>\n<blockquote><p>quoted</p></blockquote>',
  );
});

test('nested and ordered lists', () => {
  assert.equal(
    renderMarkdown('- a\n- b\n  - b1\n- c'),
    '<ul><li>a</li><li>b<ul><li>b1</li></ul></li><li>c</li></ul>',
  );
  assert.equal(renderMarkdown('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');
  assert.equal(renderMarkdown('1. one\n\n2. two'), '<ol><li>one</li><li>two</li></ol>');
});

test('tables', () => {
  const html = renderMarkdown('| Model | Score |\n|:--|--:|\n| A | **1** |\n| B | 2 |');
  assert.equal(
    html,
    '<div class="table-wrap"><table><thead><tr><th class="align-left">Model</th><th class="align-right">Score</th></tr></thead>' +
      '<tbody><tr><td class="align-left">A</td><td class="align-right"><strong>1</strong></td></tr>' +
      '<tr><td class="align-left">B</td><td class="align-right">2</td></tr></tbody></table></div>',
  );
});

test('escapeHtml', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});
