// Billing data in SQLite, through Node's built-in node:sqlite (Node 22.13+),
// so there is still nothing to install.
//
// The database is opened on first use, so the app never creates it (or needs
// node:sqlite) unless billing is turned on. Money is integer micro-dollars, as
// in billing.js. Each method runs in one transaction, and node:sqlite is
// synchronous, so a charge and its usage row are always written together.
//
// On first open, an existing data/billing.json from earlier versions is
// imported and renamed to billing.json.imported.

import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { hashPassword, MICROS_PER_CENT, SESSION_DAYS, RESET_TOKEN_MINUTES } from './billing.js';

const hashToken = (token) => createHash('sha256').update(token).digest('base64url');
const nowIso = () => new Date().toISOString();

const SCHEMA_VERSION = 1;
const SCHEMA = `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    balance       INTEGER NOT NULL DEFAULT 0,  -- micro-dollars
    created_at    TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE resets (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE usage (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    at        TEXT NOT NULL,
    provider  TEXT NOT NULL,
    model     TEXT NOT NULL,
    input     INTEGER NOT NULL,
    output    INTEGER NOT NULL,
    estimated INTEGER NOT NULL DEFAULT 0,
    cost      INTEGER NOT NULL                 -- micro-dollars
  );
  CREATE INDEX usage_user ON usage(user_id, id);
  CREATE TABLE payments (
    id             TEXT PRIMARY KEY,           -- Stripe Checkout session ID
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cents          INTEGER NOT NULL,
    payment_intent TEXT NOT NULL DEFAULT '',
    refunded_cents INTEGER NOT NULL DEFAULT 0,
    at             TEXT NOT NULL
  );
  CREATE INDEX payments_user ON payments(user_id);
  CREATE TABLE adjustments (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind     TEXT NOT NULL,                    -- 'credit' (by hand) or 'refund' (to card)
    cents    INTEGER NOT NULL,
    note     TEXT NOT NULL DEFAULT '',
    by_email TEXT NOT NULL DEFAULT '',
    at       TEXT NOT NULL
  );
  CREATE INDEX adjustments_user ON adjustments(user_id);
`;

let DatabaseSync;

export class BillingStore {
  /**
   * @param {string} file  the SQLite database, e.g. data/billing.db
   * @param {{legacyJsonFile?: string}} [options]  a billing.json to import on first open
   */
  constructor(file, { legacyJsonFile = path.join(path.dirname(file), 'billing.json') } = {}) {
    this.file = file;
    this.legacyJsonFile = legacyJsonFile;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    if (!DatabaseSync) {
      try {
        ({ DatabaseSync } = await import('node:sqlite'));
      } catch {
        throw new Error('Billing needs Node.js 22.13 or newer (for its built-in SQLite).');
      }
    }
    if (this.db) return this.db; // opened while we were importing
    if (this.file !== ':memory:') mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const { user_version: version } = db.prepare('PRAGMA user_version').get();
    if (version === 0) {
      transaction(db, () => {
        db.exec(SCHEMA);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        this.importLegacy(db);
      });
    }
    this.db = db;
    return db;
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  /** Copy everything from the old JSON store, then rename it so it isn't imported twice. */
  importLegacy(db) {
    if (!this.legacyJsonFile || !existsSync(this.legacyJsonFile)) return;
    const data = JSON.parse(readFileSync(this.legacyJsonFile, 'utf8'));
    const insertUser = db.prepare('INSERT INTO users (id, email, password_hash, balance, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const u of Object.values(data.users || {})) insertUser.run(u.id, u.email, u.passwordHash, u.balance, u.createdAt);
    const insertSession = db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
    for (const [hash, s] of Object.entries(data.sessions || {})) insertSession.run(hash, s.userId, s.expiresAt);
    const insertReset = db.prepare('INSERT INTO resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
    for (const [hash, r] of Object.entries(data.resets || {})) insertReset.run(hash, r.userId, r.expiresAt);
    const insertUsage = db.prepare(
      'INSERT INTO usage (user_id, at, provider, model, input, output, estimated, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const u of data.usage || []) {
      insertUsage.run(u.userId, u.at, u.provider, u.model, u.input, u.output, u.estimated ? 1 : 0, u.cost);
    }
    const insertPayment = db.prepare(
      'INSERT INTO payments (id, user_id, cents, payment_intent, refunded_cents, at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const [id, p] of Object.entries(data.payments || {})) {
      insertPayment.run(id, p.userId, p.cents, p.paymentIntent || '', p.refundedCents || 0, p.at);
    }
    const insertAdjustment = db.prepare(
      'INSERT INTO adjustments (user_id, kind, cents, note, by_email, at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const a of data.adjustments || []) {
      const kind = a.note === 'Refund to card' ? 'refund' : 'credit';
      insertAdjustment.run(a.userId, kind, a.cents, a.note || '', a.by || '', a.at);
    }
    renameSync(this.legacyJsonFile, `${this.legacyJsonFile}.imported`);
  }

  /** Run fn(db) in one transaction. */
  async tx(fn) {
    const db = await this.open();
    return transaction(db, () => fn(db));
  }

  // --- Accounts -------------------------------------------------------------

  async createUser(email, password) {
    const passwordHash = await hashPassword(password);
    return this.tx((db) => {
      const user = { id: randomUUID(), email, passwordHash, balance: 0, createdAt: nowIso() };
      const { changes } = db
        .prepare('INSERT INTO users (id, email, password_hash, balance, created_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(email) DO NOTHING')
        .run(user.id, email, passwordHash, user.createdAt);
      return changes ? user : null;
    });
  }

  async findByEmail(email) {
    const db = await this.open();
    return toUser(db.prepare('SELECT * FROM users WHERE email = ?').get(email));
  }

  async getUser(id) {
    const db = await this.open();
    return toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  async createSession(userId) {
    const token = randomBytes(32).toString('base64url');
    await this.tx((db) => {
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
      db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
        hashToken(token),
        userId,
        Date.now() + SESSION_DAYS * 86_400_000,
      );
    });
    return { token, maxAge: SESSION_DAYS * 86_400 };
  }

  async userForToken(token) {
    if (!token) return null;
    const db = await this.open();
    return toUser(
      db
        .prepare('SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at >= ?')
        .get(hashToken(token), Date.now()),
    );
  }

  async deleteSession(token) {
    if (!token) return;
    const db = await this.open();
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  // --- Money ----------------------------------------------------------------

  /** Charge a finished answer and record it. Returns the new balance. */
  async charge(userId, entry) {
    return this.tx((db) => {
      const row = db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? RETURNING balance').get(entry.cost, userId);
      if (!row) throw new Error('Account not found');
      db.prepare(
        'INSERT INTO usage (user_id, at, provider, model, input, output, estimated, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(userId, nowIso(), entry.provider, entry.model, entry.input, entry.output, entry.estimated ? 1 : 0, entry.cost);
      return row.balance;
    });
  }

  /** Add credit for a Checkout session, once. Returns {credited, balance}. */
  async credit(userId, checkoutId, cents, paymentIntent = '') {
    return this.tx((db) => {
      const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
      if (!user) throw new Error('Account not found');
      const { changes } = db
        .prepare(
          'INSERT INTO payments (id, user_id, cents, payment_intent, refunded_cents, at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(id) DO NOTHING',
        )
        .run(checkoutId, userId, cents, paymentIntent, nowIso());
      if (!changes) return { credited: false, balance: user.balance };
      const row = db
        .prepare('UPDATE users SET balance = balance + ? WHERE id = ? RETURNING balance')
        .get(cents * MICROS_PER_CENT, userId);
      return { credited: true, balance: row.balance };
    });
  }

  async account(userId, limit = 100) {
    const db = await this.open();
    const user = db.prepare('SELECT email, balance FROM users WHERE id = ?').get(userId);
    if (!user) return null;
    const usage = db
      .prepare('SELECT at, provider, model, input, output, estimated, cost FROM usage WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, limit)
      .map((u) => ({ ...u, estimated: Boolean(u.estimated) }));
    return { email: user.email, balance: user.balance, usage, payments: paymentsOf(db, userId) };
  }

  // --- Password reset -------------------------------------------------------

  /** A one-time reset token for this email, or null if there's no such account. */
  async createReset(email) {
    return this.tx((db) => {
      const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (!user) return null;
      // Drop expired tokens, and older tokens for this user: only the newest link works.
      db.prepare('DELETE FROM resets WHERE expires_at < ? OR user_id = ?').run(Date.now(), user.id);
      const token = randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
        hashToken(token),
        user.id,
        Date.now() + RESET_TOKEN_MINUTES * 60_000,
      );
      return token;
    });
  }

  /** Set a new password with a reset token. Signs the user out everywhere. Returns the user, or null. */
  async resetPassword(token, password) {
    const passwordHash = await hashPassword(password);
    return this.tx((db) => {
      const reset = db.prepare('DELETE FROM resets WHERE token_hash = ? RETURNING user_id, expires_at').get(hashToken(String(token || '')));
      if (!reset || reset.expires_at < Date.now()) return null;
      const user = db.prepare('UPDATE users SET password_hash = ? WHERE id = ? RETURNING *').get(passwordHash, reset.user_id);
      if (!user) return null;
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      return toUser(user);
    });
  }

  // --- Admin ----------------------------------------------------------------

  /** Accounts with totals, newest first, optionally filtered by email (at most `limit`). */
  async listUsers(query = '', limit = 500) {
    const db = await this.open();
    const q = query.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
    return db
      .prepare(
        `SELECT u.id, u.email, u.created_at AS createdAt, u.balance,
                COALESCE((SELECT SUM(cents - refunded_cents) FROM payments WHERE user_id = u.id), 0) AS paidCents,
                COALESCE((SELECT SUM(cost) FROM usage WHERE user_id = u.id), 0) AS spent,
                (SELECT COUNT(*) FROM usage WHERE user_id = u.id) AS answers
           FROM users u
          WHERE u.email LIKE ? ESCAPE '\\'
          ORDER BY u.created_at DESC
          LIMIT ?`,
      )
      .all(`%${q}%`, limit)
      .map((u) => ({ ...u }));
  }

  /** One account in full, for the admin view. */
  async adminUser(userId) {
    const account = await this.account(userId, 50);
    if (!account) return null;
    const { created_at: createdAt } = this.db.prepare('SELECT created_at FROM users WHERE id = ?').get(userId);
    return { id: userId, createdAt, ...account };
  }

  /** Add (or, with negative cents, take away) credit by hand. Returns the new balance. */
  async adjust(userId, cents, note, by) {
    return this.tx((db) => {
      const row = db
        .prepare('UPDATE users SET balance = balance + ? WHERE id = ? RETURNING balance')
        .get(cents * MICROS_PER_CENT, userId);
      if (!row) throw new Error('Account not found');
      db.prepare("INSERT INTO adjustments (user_id, kind, cents, note, by_email, at) VALUES (?, 'credit', ?, ?, ?, ?)").run(
        userId,
        cents,
        note,
        by,
        nowIso(),
      );
      return row.balance;
    });
  }

  async payment(checkoutId) {
    const db = await this.open();
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(checkoutId);
    return p
      ? { userId: p.user_id, cents: p.cents, paymentIntent: p.payment_intent, refundedCents: p.refunded_cents, at: p.at }
      : null;
  }

  /** Record a Stripe refund: the refunded amount comes off the balance. Returns the new balance. */
  async recordRefund(checkoutId, cents, by) {
    return this.tx((db) => {
      const payment = db
        .prepare('UPDATE payments SET refunded_cents = refunded_cents + ? WHERE id = ? AND refunded_cents + ? <= cents RETURNING user_id')
        .get(cents, checkoutId, cents);
      if (!payment) throw new Error('That is more than is left to refund.');
      const row = db
        .prepare('UPDATE users SET balance = balance - ? WHERE id = ? RETURNING balance')
        .get(cents * MICROS_PER_CENT, payment.user_id);
      db.prepare("INSERT INTO adjustments (user_id, kind, cents, note, by_email, at) VALUES (?, 'refund', ?, 'Refund to card', ?, ?)").run(
        payment.user_id,
        -cents,
        by,
        nowIso(),
      );
      return row.balance;
    });
  }
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function toUser(row) {
  if (!row) return null;
  return { id: row.id, email: row.email, passwordHash: row.password_hash, balance: row.balance, createdAt: row.created_at };
}

/** Card payments and manual credits for one user, newest first. */
function paymentsOf(db, userId) {
  const payments = db
    .prepare('SELECT id, cents, refunded_cents, at FROM payments WHERE user_id = ?')
    .all(userId)
    .map((p) => ({ id: p.id, kind: 'card', cents: p.cents, refundedCents: p.refunded_cents, at: p.at }));
  const credits = db
    .prepare("SELECT cents, note, at FROM adjustments WHERE user_id = ? AND kind = 'credit'")
    .all(userId)
    .map((a) => ({ kind: 'credit', cents: a.cents, note: a.note, at: a.at }));
  return [...payments, ...credits].sort((a, b) => b.at.localeCompare(a.at));
}
