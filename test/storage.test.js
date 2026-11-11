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

test('telegram: HTML escaping', () => {
  assert.equal(escapeHtml('A&B <b>*_x_*</b>'), 'A&amp;B &lt;b&gt;*_x_*&lt;/b&gt;');
  assert.equal(escapeHtml(undefined), '');
});
