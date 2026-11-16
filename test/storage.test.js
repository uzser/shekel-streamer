import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStorage, transactionKey } from '../src/storage.js';
import { escapeHtml } from '../src/telegram.js';

function txn(overrides = {}) {
  return {
    accountNumber: '12-345-678',
    date: new Date('2026-11-01T00:00:00.000Z'),
    description: 'סופר',
    translatedDescription: null,
    chargedAmount: -42.5,
    processedDate: new Date('2026-11-02T00:00:00.000Z'),
    status: 'pending',
    ...overrides,
  };
}

async function tempStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shekel-test-'));
  return createStorage({ sqlitePath: path.join(dir, 'sub', 'test.db') });
}

test('sqlite: new transaction is inserted once, then updated', async () => {
  const storage = await tempStorage();
  assert.equal(await storage.saveOrUpdate(txn()), true);
  assert.equal(await storage.saveOrUpdate(txn({ status: 'completed' })), false);
  await storage.close();
});

test('sqlite: existing key needs same processed date, status and a translation', async () => {
  const storage = await tempStorage();
  await storage.saveOrUpdate(txn());
  // No translation yet: not "existing", so it will be processed again.
  assert.equal((await storage.getExistingKeys([txn()])).size, 0);

  await storage.saveOrUpdate(txn({ translatedDescription: 'Supermarket' }));
  const keys = await storage.getExistingKeys([txn(), txn({ status: 'completed' })]);
  assert.deepEqual([...keys], [transactionKey(txn())]);
  await storage.close();
});

test('sqlite: translation cache', async () => {
  const storage = await tempStorage();
  assert.equal(await storage.getTranslation('מוביט'), null);
  await storage.setTranslation('מוביט', 'Moovit');
  await storage.setTranslation('מוביט', 'Other'); // first value stays
  assert.equal(await storage.getTranslation('מוביט'), 'Moovit');
  await storage.close();
});

test('sqlite: history import adds new rows once and keeps translations', async () => {
  const storage = await tempStorage();
  await storage.saveOrUpdate(txn({ translatedDescription: 'Supermarket' }));
  const old = {
    ...txn({ translatedDescription: 'Supermarket', status: 'completed' }),
    date: '2026-11-01T00:00:00.000Z', // same key as the row above: skipped
    processedDate: '2026-11-02T00:00:00.000Z',
    _createdAt: '2026-11-01T08:00:00.000Z',
  };
  const older = { ...old, date: '2024-01-05T22:00:00.000Z', description: 'מוביט', translatedDescription: 'Moovit' };
  const data = {
    format: 'shekel-streamer-history-v1',
    transactions: [old, older],
    translations: [{ description: 'מוביט', translation: 'Moovit' }],
  };

  assert.deepEqual(await storage.importHistory(data), { transactions: 1, skipped: 1, translations: 1 });
  assert.deepEqual(await storage.importHistory(data), { transactions: 0, skipped: 2, translations: 0 });
  assert.equal(await storage.getTranslation('מוביט'), 'Moovit');
  // The imported row counts as existing (it has a translation), so it is not posted again.
  const again = txn({ date: new Date(older.date), description: 'מוביט', status: 'completed' });
  assert.equal((await storage.getExistingKeys([again])).size, 1);
  await assert.rejects(storage.importHistory({ format: 'other' }), /format/);
  await storage.close();
});

test('sqlite: hasNear finds a row some hours off, not one on the next day', async () => {
  const storage = await tempStorage();
  await storage.saveOrUpdate(txn({ date: new Date('2025-03-05T00:00:00.000Z') })); // old image: UTC
  assert.equal(await storage.hasNear(txn({ date: new Date('2025-03-04T22:00:00.000Z') })), true);
  assert.equal(await storage.hasNear(txn({ date: new Date('2025-03-05T00:00:00.000Z') })), true);
  assert.equal(await storage.hasNear(txn({ date: new Date('2025-03-05T22:00:00.000Z') })), false);
  assert.equal(await storage.hasNear(txn({ date: new Date('2025-03-04T22:00:00.000Z'), chargedAmount: -1 })), false);
  assert.equal(await storage.hasNear(txn({ date: new Date('2025-03-04T22:00:00.000Z'), description: 'x' })), false);
  await storage.close();
});

test('sqlite: exportTo writes a full copy and replaces an old one', async () => {
  const storage = await tempStorage();
  await storage.saveOrUpdate(txn({ translatedDescription: 'Supermarket' }));
  await storage.setTranslation('סופר', 'Supermarket');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shekel-export-')), 'out', "it's.sqlite");
  await storage.exportTo(file);
  await storage.saveOrUpdate(txn({ description: 'מוביט' }));
  await storage.exportTo(file); // second copy replaces the first
  await storage.close();

  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.equal(copy.prepare('SELECT count(*) AS n FROM transactions').get().n, 2);
  assert.equal(copy.prepare('SELECT translation FROM translations').get().translation, 'Supermarket');
  copy.close();
});

test('sqlite: reassignUser changes only the rows of that company and account', async () => {
  const storage = await tempStorage();
  const cal = { companyId: 'visaCal', userCode: 'SERGEI', translatedDescription: 'x' };
  await storage.saveOrUpdate(txn({ ...cal, accountNumber: '6422' }));
  await storage.saveOrUpdate(txn({ ...cal, accountNumber: '6422', description: 'מוביט' }));
  await storage.saveOrUpdate(txn({ ...cal, accountNumber: '0228', description: 'other card' }));
  await storage.saveOrUpdate(txn({ ...cal, companyId: 'isracard', accountNumber: '6422', description: 'other company' }));

  const fix = { company: 'visaCal', account: '6422', user: 'ALEX' };
  assert.equal(await storage.reassignUser(fix), 2);
  assert.equal(await storage.reassignUser(fix), 0); // nothing left to change
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shekel-reassign-')), 'copy.sqlite');
  await storage.exportTo(file);
  await storage.close();

  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(file, { readOnly: true });
  const users = copy.prepare(
    "SELECT json_extract(doc, '$.companyId') AS c, json_extract(doc, '$.accountNumber') AS a, json_extract(doc, '$.userCode') AS u FROM transactions ORDER BY c, a, u",
  ).all().map(r => `${r.c}/${r.a}/${r.u}`);
  assert.deepEqual(users, ['isracard/6422/SERGEI', 'visaCal/0228/SERGEI', 'visaCal/6422/ALEX', 'visaCal/6422/ALEX']);
  copy.close();
});

// Card purchase abroad: pending in the original currency, completed in USD (same day, same merchant).
const abroad = {
  accountNumber: '0228', companyId: 'visaCal', userCode: 'SERGEI', translatedDescription: 'Cafe',
  date: new Date('2026-11-01T22:00:00.000Z'), description: 'CAFE UBUD',
  originalAmount: -1000000, originalCurrency: 'IDR',
};

async function rows(storage) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shekel-rows-')), 'copy.sqlite');
  await storage.exportTo(file);
  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(file, { readOnly: true });
  const result = copy.prepare('SELECT status, charged_amount AS amount, description FROM transactions ORDER BY id').all()
    .map(r => `${r.status}|${r.amount}|${r.description}`);
  copy.close();
  return result;
}

test('sqlite: the completed row of a purchase abroad replaces its pending row (no new row)', async () => {
  const storage = await tempStorage();
  assert.equal(await storage.saveOrUpdate({ ...abroad, status: 'pending', chargedAmount: -1000000,
    processedDate: abroad.date }), true);
  assert.equal(await storage.saveOrUpdate({ ...abroad, status: 'completed', chargedAmount: -60.5, chargedCurrency: 'USD',
    processedDate: new Date('2026-12-10T00:00:00.000Z') }), false);
  assert.deepEqual(await rows(storage), ['completed|-60.5|CAFE UBUD']);
  await storage.close();
});

test('sqlite: a bank row completed with another description and day replaces its pending row', async () => {
  const storage = await tempStorage();
  const salary = { accountNumber: '12-345', companyId: 'hapoalim', originalAmount: 9000, originalCurrency: 'ILS',
    chargedAmount: 9000, translatedDescription: 'Salary' };
  await storage.saveOrUpdate({ ...salary, status: 'pending', description: 'משכורת', date: new Date('2024-03-09T22:00:00.000Z'),
    processedDate: new Date('2024-03-09T22:00:00.000Z') });
  assert.equal(await storage.saveOrUpdate({ ...salary, status: 'completed', description: 'משכורת חברה',
    date: new Date('2024-03-10T22:00:00.000Z'), processedDate: new Date('2024-03-10T22:00:00.000Z') }), false);
  assert.deepEqual(await rows(storage), ['completed|9000|משכורת חברה']);
  await storage.close();
});

test('sqlite: same merchant and amount on another day is a new purchase, other account too', async () => {
  const storage = await tempStorage();
  await storage.saveOrUpdate({ ...abroad, status: 'pending', chargedAmount: -1000000, processedDate: abroad.date });
  const nextDay = new Date('2026-11-02T22:00:00.000Z');
  assert.equal(await storage.saveOrUpdate({ ...abroad, status: 'completed', chargedAmount: -60.5, date: nextDay,
    processedDate: nextDay }), true);
  assert.equal(await storage.saveOrUpdate({ ...abroad, accountNumber: '6422', status: 'completed', chargedAmount: -60.4,
    processedDate: nextDay }), true);
  assert.equal((await rows(storage)).length, 3);
  await storage.close();
});

test('sqlite: removePendingDuplicates removes old pending rows that have a completed row, once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shekel-dedupe-'));
  const file = path.join(dir, 'old.db');
  let storage = await createStorage({ sqlitePath: file });
  const iso = d => new Date(d).toISOString();
  const doc = (t) => ({ ...abroad, ...t, date: iso(t.date ?? abroad.date), processedDate: iso(t.date ?? abroad.date) });
  // An old database: the old app stored both rows (history import keeps them as they are).
  await storage.importHistory({
    format: 'shekel-streamer-history-v1',
    transactions: [
      doc({ status: 'pending', chargedAmount: -1000000 }),
      doc({ status: 'completed', chargedAmount: -60.5 }),
      doc({ status: 'pending', chargedAmount: -5, originalAmount: -5, originalCurrency: 'ILS', description: 'NO TWIN' }),
    ],
  });
  await storage.close();
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA user_version = 0'); // as before this version
  raw.close();

  storage = await createStorage({ sqlitePath: file });
  assert.equal(await storage.removePendingDuplicates(), 1);
  assert.deepEqual(await rows(storage), ['completed|-60.5|CAFE UBUD', 'pending|-5|NO TWIN']);
  // Done once: the database version is set, the next start changes nothing.
  await storage.importHistory({ format: 'shekel-streamer-history-v1', transactions: [
    doc({ status: 'pending', chargedAmount: -1000000, description: 'CAFE UBUD' })] });
  assert.equal(await storage.removePendingDuplicates(), 0);
  assert.equal((await rows(storage)).length, 3);
  await storage.close();
});

test('telegram: HTML escaping', () => {
  assert.equal(escapeHtml('A&B <b>*_x_*</b>'), 'A&amp;B &lt;b&gt;*_x_*&lt;/b&gt;');
  assert.equal(escapeHtml(undefined), '');
});
