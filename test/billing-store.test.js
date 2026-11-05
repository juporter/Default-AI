// The SQLite billing store on its own: importing the old JSON file, and the
// money rules (credit once, refunds capped, charges recorded with their usage).

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { BillingStore } from '../billing-store.js';
import { hashPassword, verifyPassword } from '../billing.js';

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'default-ai-store-'));
test.after(() => rmSync(tmpDir, { recursive: true, force: true }));

test('nothing is created until billing is used', () => {
  const file = path.join(tmpDir, 'lazy', 'billing.db');
  new BillingStore(file); // constructing is free
  assert.equal(existsSync(path.dirname(file)), false);
});

test('imports an existing billing.json once, then renames it', async () => {
  const dir = path.join(tmpDir, 'legacy');
  const json = path.join(dir, 'billing.json');
  const passwordHash = await hashPassword('old password');
  const future = Date.now() + 86_400_000;
  rmSync(dir, { recursive: true, force: true });
  await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }));
  writeFileSync(
    json,
    JSON.stringify({
      users: { u1: { id: 'u1', email: 'old@example.com', passwordHash, balance: 7_500_000, createdAt: '2026-11-01T00:00:00.000Z' } },
      emails: { 'old@example.com': 'u1' },
      sessions: { hashedtoken: { userId: 'u1', expiresAt: future } },
      usage: [
        { userId: 'u1', at: '2026-11-02T00:00:00.000Z', provider: 'openai', model: 'gpt-6-luna', input: 10, output: 5, estimated: false, cost: 2500 },
      ],
      payments: { cs_old: { userId: 'u1', cents: 1000, paymentIntent: 'pi_old', refundedCents: 200, at: '2026-11-01T01:00:00.000Z' } },
      resets: {},
      adjustments: [
        { userId: 'u1', cents: 50, note: 'Goodwill', by: 'boss@example.com', at: '2026-11-01T02:00:00.000Z' },
        { userId: 'u1', cents: -200, note: 'Refund to card', by: 'boss@example.com', at: '2026-11-01T03:00:00.000Z' },
      ],
    }),
  );

  const store = new BillingStore(path.join(dir, 'billing.db'));
  const user = await store.findByEmail('old@example.com');
  assert.equal(user.balance, 7_500_000);
  assert.equal(await verifyPassword('old password', user.passwordHash), true);
  const account = await store.account('u1');
  assert.equal(account.usage.length, 1);
  assert.deepEqual(
    account.payments.map((p) => [p.kind, p.cents, p.refundedCents ?? p.note]),
    [
      ['credit', 50, 'Goodwill'], // the refund ledger row isn't shown twice
      ['card', 1000, 200],
    ],
  );
  assert.deepEqual(await store.payment('cs_old'), {
    userId: 'u1',
    cents: 1000,
    paymentIntent: 'pi_old',
    refundedCents: 200,
    at: '2026-11-01T01:00:00.000Z',
  });
  assert.equal(existsSync(json), false);
  assert.equal(existsSync(`${json}.imported`), true);
  store.close();

  // Reopening doesn't import again.
  const again = new BillingStore(path.join(dir, 'billing.db'));
  assert.equal((await again.listUsers()).length, 1);
  again.close();
});

test('money rules: credit once, charges with usage, refunds capped', async () => {
  const store = new BillingStore(path.join(tmpDir, 'money', 'billing.db'));
  const user = await store.createUser('ada@example.com', 'a good password');
  assert.equal(await store.createUser('ada@example.com', 'another password'), null);

  assert.deepEqual(await store.credit(user.id, 'cs_1', 1000, 'pi_1'), { credited: true, balance: 10_000_000 });
  assert.deepEqual(await store.credit(user.id, 'cs_1', 1000, 'pi_1'), { credited: false, balance: 10_000_000 });

  // Many answers at once (one prompt sent to several models): every charge lands.
  const entry = { provider: 'openai', model: 'm', input: 1, output: 1, estimated: false, cost: 1000 };
  await Promise.all(Array.from({ length: 20 }, () => store.charge(user.id, entry)));
  const account = await store.account(user.id);
  assert.equal(account.balance, 10_000_000 - 20_000);
  assert.equal(account.usage.length, 20);

  assert.equal(await store.recordRefund('cs_1', 600, 'boss'), 10_000_000 - 20_000 - 6_000_000);
  await assert.rejects(store.recordRefund('cs_1', 401, 'boss'), /more than is left/);
  assert.equal((await store.payment('cs_1')).refundedCents, 600);
  assert.equal((await store.getUser(user.id)).balance, 10_000_000 - 20_000 - 6_000_000);

  const [listed] = await store.listUsers('ADA'.toLowerCase());
  assert.deepEqual(
    { paid: listed.paidCents, spent: listed.spent, answers: listed.answers },
    { paid: 400, spent: 20_000, answers: 20 },
  );
  assert.deepEqual(await store.listUsers('%'), []); // LIKE wildcards are matched literally
  store.close();
});
