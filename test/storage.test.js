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

test('telegram: HTML escaping', () => {
  assert.equal(escapeHtml('A&B <b>*_x_*</b>'), 'A&amp;B &lt;b&gt;*_x_*&lt;/b&gt;');
  assert.equal(escapeHtml(undefined), '');
});
