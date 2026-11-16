import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toStoredTransaction, currencyToIsoCode } from '../src/stored-transaction.js';

const context = { companyId: 'visaCal', user: 'SERGEI', chatId: '-1' };

test('stored transaction keeps the charged currency (Cal: purchase abroad, charged in USD)', () => {
  const txn = {
    date: '2025-04-16T00:00:00.000Z', processedDate: '2025-05-10T00:00:00.000Z', description: 'AIRBNB',
    originalAmount: -10930877, originalCurrency: 'IDR', chargedAmount: -659.1, chargedCurrency: '$',
    type: 'normal', status: 'completed',
  };
  const t = toStoredTransaction({ accountNumber: '0228' }, txn, context);
  assert.equal(t.chargedCurrency, 'USD');
  assert.equal(t.chargedAmount, -659.1);
  assert.equal(t.originalCurrency, 'IDR');
  assert.equal(t.accountNumber, '0228');
  assert.equal(t.companyId, 'visaCal');
  assert.equal(t.userCode, 'SERGEI');
  assert.equal(t.chatId, '-1');
  assert.equal(t.translatedDescription, null);
  assert.ok(t.date instanceof Date && t.processedDate instanceof Date);
});

test('stored transaction without a charged currency (bank rows, pending card rows): null', () => {
  const txn = { date: '2026-11-01T00:00:00.000Z', processedDate: '2026-11-01T00:00:00.000Z', chargedAmount: -5, originalCurrency: '₪' };
  const t = toStoredTransaction({ accountNumber: '12-345' }, txn, context);
  assert.equal(t.chargedCurrency, null);
  assert.equal(t.originalCurrency, 'ILS');
});

test('currencyToIsoCode: symbols to ISO codes, codes stay', () => {
  assert.equal(currencyToIsoCode('₪'), 'ILS');
  assert.equal(currencyToIsoCode('$'), 'USD');
  assert.equal(currencyToIsoCode('€'), 'EUR');
  assert.equal(currencyToIsoCode('GBP'), 'GBP');
  assert.equal(currencyToIsoCode(undefined), '');
});
