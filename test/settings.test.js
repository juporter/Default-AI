import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { parseSettingsText, mergeEnvText, formatEnvValue, maskValue, adsConfig, allowedVariables } from '../settings.js';

test('reads .env text, keeps known variables and lists the rest as ignored', () => {
  const out = parseSettingsText(
    '# my keys\nOPENAI_API_KEY=sk-abc123456789\nexport DEEPSEEK_API_KEY="ds-key"\nHOST=0.0.0.0\nSOMETHING=else\nKIMI_MODEL=kimi-k3\n',
  );
  // Node's parseEnv doesn't keep line order, so compare sorted.
  const byName = (a, b) => a.name.localeCompare(b.name);
  assert.deepEqual(out.changes.sort(byName), [
    { name: 'DEEPSEEK_API_KEY', value: 'ds-key' },
    { name: 'KIMI_MODEL', value: 'kimi-k3' },
    { name: 'OPENAI_API_KEY', value: 'sk-abc123456789' },
  ]);
  assert.deepEqual(out.ignored.sort(), ['HOST', 'SOMETHING']);
  assert.deepEqual(out.errors, []);
});

test('reads a flat JSON settings file', () => {
  const out = parseSettingsText('{"PERPLEXITY_API_KEY": "pplx-1", "MAX_TOKENS": 2048}');
  assert.deepEqual(out.changes, [
    { name: 'PERPLEXITY_API_KEY', value: 'pplx-1' },
    { name: 'MAX_TOKENS', value: '2048' },
  ]);
});

test('rejects unsafe or malformed values', () => {
  const out = parseSettingsText(
    JSON.stringify({
      OPENAI_BASE_URL: 'file:///etc/passwd',
      MAX_TOKENS: 'lots',
      ADSENSE_CLIENT: 'pub-123',
      ADSENSE_SLOT_TOP: 'abc',
      XAI_API_KEY: 'a\nINJECTED=1',
      GEMINI_API_KEY: { nested: true },
    }),
  );
  assert.equal(out.changes.length, 0);
  assert.equal(out.errors.length, 6);
  assert.match(parseSettingsText('{oops').errors[0], /isn't valid JSON/);
});

test('HOST and PORT can never be set from a settings file', () => {
  assert.ok(!allowedVariables().includes('HOST'));
  assert.ok(!allowedVariables().includes('PORT'));
});

test('merges into an existing .env, replacing in place and appending new ones', () => {
  const existing = '# keys\nOPENAI_API_KEY=old\nPORT=3000\n';
  const merged = mergeEnvText(
    existing,
    [
      { name: 'OPENAI_API_KEY', value: 'new' },
      { name: 'KIMI_API_KEY', value: 'kimi key with spaces' },
    ],
    new Date('2026-11-04T00:00:00Z'),
  );
  assert.equal(
    merged,
    "# keys\nOPENAI_API_KEY=new\nPORT=3000\n\n# Imported from a settings file on 2026-11-04\nKIMI_API_KEY='kimi key with spaces'\n",
  );
  assert.deepEqual(parseEnv(merged), { OPENAI_API_KEY: 'new', PORT: '3000', KIMI_API_KEY: 'kimi key with spaces' });
});

test('every value that passes validation reads back unchanged', () => {
  for (const value of ['plain', 'sk-proj_ABC.123/x+y=', 'has space', 'has#hash', "it's", 'a"b', '']) {
    const { errors } = parseSettingsText(JSON.stringify({ OPENAI_MODEL: value }));
    if (errors.length) continue;
    assert.equal(parseEnv(`X=${formatEnvValue(value)}`).X, value, value);
  }
});

test('masks secrets only', () => {
  assert.equal(maskValue('OPENAI_API_KEY', 'sk-1234567890abcd'), '••••abcd');
  assert.equal(maskValue('OPENAI_API_KEY', 'short'), '••••');
  assert.equal(maskValue('OPENAI_MODEL', 'gpt-x'), 'gpt-x');
});

test('adsConfig only enables AdSense for a valid publisher ID', () => {
  assert.deepEqual(adsConfig({}), { enabled: false, client: '', slots: { top: '', bottom: '' }, placeholder: false });
  assert.equal(adsConfig({ ADS_PLACEHOLDER: 'true' }).placeholder, true);
  assert.equal(adsConfig({ ADSENSE_CLIENT: 'ca-pub-123"><script>' }).enabled, false);
  assert.deepEqual(adsConfig({ ADSENSE_CLIENT: 'ca-pub-1234567890123456', ADSENSE_SLOT_TOP: '1234567890', ADSENSE_SLOT_BOTTOM: 'x' }), {
    enabled: true,
    client: 'ca-pub-1234567890123456',
    slots: { top: '1234567890', bottom: '' },
    placeholder: false,
  });
});
