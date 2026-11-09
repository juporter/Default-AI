#!/usr/bin/env node
// Make a consistent copy of the billing database while the app is running.
//
//   node scripts/backup-db.js [destination]
//
// Uses SQLite's VACUUM INTO, which is safe alongside the running app (unlike
// copying billing.db, which can miss changes still in billing.db-wal).
// The source is BILLING_DATA_FILE, or data/billing.db.

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.BILLING_DATA_FILE || path.join(appDir, 'data', 'billing.db');
const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
const destination = process.argv[2] || path.join(path.dirname(source), `billing-backup-${stamp}.db`);

if (!existsSync(source)) {
  console.error(`No database at ${source}.`);
  process.exit(1);
}
if (existsSync(destination)) {
  console.error(`${destination} already exists. Choose another name.`);
  process.exit(1);
}
const db = new DatabaseSync(source, { readOnly: true });
db.prepare('VACUUM INTO ?').run(destination);
db.close();
console.log(`Backed up ${source} to ${destination}`);
