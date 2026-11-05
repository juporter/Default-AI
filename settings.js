// Settings import: parse a .env or JSON file, validate it, and merge it into
// the app's .env file. Pure functions so they can be unit tested.

import { parseEnv } from 'node:util';
import { providerVariables, isSecretVariable } from './providers.js';
import { BILLING_VARIABLES, BILLING_SECRET_VARIABLES } from './billing.js';

const NUMBER_VARIABLES = ['MAX_TOKENS', 'REQUEST_TIMEOUT_MS'];
const AD_VARIABLES = ['ADSENSE_CLIENT', 'ADSENSE_SLOT_TOP', 'ADSENSE_SLOT_BOTTOM', 'ADS_PLACEHOLDER'];

/** Variables a settings file may set. HOST and PORT are left out on purpose. */
export function allowedVariables() {
  return [...providerVariables(), ...NUMBER_VARIABLES, ...AD_VARIABLES, ...BILLING_VARIABLES];
}

export const ADSENSE_CLIENT_RE = /^ca-pub-\d{10,20}$/;
export const ADSENSE_SLOT_RE = /^\d{5,20}$/;

/**
 * Parse the text of a settings file (.env lines or a flat JSON object).
 * @returns {{changes: {name: string, value: string}[], ignored: string[], errors: string[]}}
 */
export function parseSettingsText(text) {
  const source = String(text ?? '');
  let raw;
  if (/^\s*\{/.test(source)) {
    let json;
    try {
      json = JSON.parse(source);
    } catch {
      return { changes: [], ignored: [], errors: ["The file starts with { but isn't valid JSON."] };
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return { changes: [], ignored: [], errors: ['A JSON settings file must be an object of NAME: "value" pairs.'] };
    }
    raw = json;
  } else {
    raw = parseEnv(source);
  }

  const allowed = new Set(allowedVariables());
  const changes = [];
  const ignored = [];
  const errors = [];
  for (const [name, input] of Object.entries(raw)) {
    if (!allowed.has(name)) {
      ignored.push(name);
      continue;
    }
    if (typeof input !== 'string' && typeof input !== 'number' && typeof input !== 'boolean') {
      errors.push(`${name} must be text.`);
      continue;
    }
    const value = String(input).trim();
    const problem = validate(name, value);
    if (problem) errors.push(problem);
    else changes.push({ name, value });
  }
  return { changes, ignored, errors };
}

function validate(name, value) {
  if (/[\r\n\0]/.test(value)) return `${name} can't contain line breaks.`;
  if (value.length > 4096) return `${name} is too long.`;
  if (value === '') return null; // empty clears the setting
  if (name.endsWith('_BASE_URL') && !/^https?:\/\/[^\s]+$/i.test(value)) return `${name} must be an http(s) URL.`;
  if (NUMBER_VARIABLES.includes(name) && !/^[1-9]\d{0,9}$/.test(value)) return `${name} must be a whole number.`;
  if (name === 'ADSENSE_CLIENT' && !ADSENSE_CLIENT_RE.test(value)) return 'ADSENSE_CLIENT must look like ca-pub-1234567890123456.';
  if (name.startsWith('ADSENSE_SLOT_') && !ADSENSE_SLOT_RE.test(value)) return `${name} must be the numeric ad unit ID.`;
  if (name === 'ADS_PLACEHOLDER' && !/^(true|false|1|0)$/i.test(value)) return 'ADS_PLACEHOLDER must be true or false.';
  if (name === 'STRIPE_SECRET_KEY' && !/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(value)) {
    return 'STRIPE_SECRET_KEY must be a Stripe secret key (sk_test_… or sk_live_…).';
  }
  if (name === 'STRIPE_WEBHOOK_SECRET' && !/^whsec_[A-Za-z0-9+/=]+$/.test(value)) {
    return 'STRIPE_WEBHOOK_SECRET must start with whsec_.';
  }
  if (name === 'BILLING_MARKUP_PERCENT' && !/^\d{1,4}(\.\d{1,2})?$/.test(value)) return 'BILLING_MARKUP_PERCENT must be a number such as 20.';
  if (name === 'BILLING_TOPUP_AMOUNTS' && !/^\d{1,4}(\.\d{1,2})?(,\s*\d{1,4}(\.\d{1,2})?)*$/.test(value)) {
    return 'BILLING_TOPUP_AMOUNTS must be dollar amounts separated by commas, such as 5,10,25.';
  }
  if (name === 'ADMIN_EMAILS' && !value.split(',').every((e) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e.trim()))) {
    return 'ADMIN_EMAILS must be email addresses separated by commas.';
  }
  if (name === 'RESEND_API_KEY' && !/^re_[A-Za-z0-9_]+$/.test(value)) return 'RESEND_API_KEY must start with re_.';
  if (name === 'EMAIL_FROM' && !/^([^<>]*<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(value)) {
    return 'EMAIL_FROM must be an address such as "Default AI <billing@example.com>".';
  }
  if (name === 'PUBLIC_URL' && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(value)) return 'PUBLIC_URL must be an http(s) URL.';
  if (value.includes("'") && /["\\]/.test(value)) return `${name} contains characters that can't be saved.`;
  return null;
}

/** Hide all but the last 4 characters of a secret. */
export function maskValue(name, value) {
  if (!value || !(isSecretVariable(name) || BILLING_SECRET_VARIABLES.includes(name))) return value;
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`;
}

/** Format a value for a .env line so parseEnv reads back exactly the same string. */
export function formatEnvValue(value) {
  if (/^[\w.:/@+=,\-]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value}"`; // validate() guarantees no " or \ here
}

/**
 * Merge changes into the text of an existing .env file. Existing lines for a
 * variable are replaced in place; new variables are appended. Comments and
 * unrelated lines are kept.
 */
export function mergeEnvText(existing, changes, now = new Date()) {
  const pending = new Map(changes.map((c) => [c.name, c.value]));
  const lines = String(existing ?? '').split(/\r?\n/);
  if (lines.length && lines.at(-1) === '') lines.pop();

  const out = lines.map((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/);
    if (!m || !pending.has(m[1])) return line;
    const value = pending.get(m[1]);
    pending.delete(m[1]);
    return `${m[1]}=${formatEnvValue(value)}`;
  });

  if (pending.size) {
    if (out.length && out.at(-1).trim() !== '') out.push('');
    out.push(`# Imported from a settings file on ${now.toISOString().slice(0, 10)}`);
    for (const [name, value] of pending) out.push(`${name}=${formatEnvValue(value)}`);
  }
  return `${out.join('\n')}\n`;
}

/** Ads configuration for the page, from the environment. */
export function adsConfig(env) {
  const client = ADSENSE_CLIENT_RE.test(env.ADSENSE_CLIENT || '') ? env.ADSENSE_CLIENT : '';
  const slot = (v) => (ADSENSE_SLOT_RE.test(v || '') ? v : '');
  return {
    enabled: Boolean(client),
    client,
    slots: client ? { top: slot(env.ADSENSE_SLOT_TOP), bottom: slot(env.ADSENSE_SLOT_BOTTOM) } : { top: '', bottom: '' },
    placeholder: !client && /^(true|1)$/i.test(env.ADS_PLACEHOLDER || ''),
  };
}
