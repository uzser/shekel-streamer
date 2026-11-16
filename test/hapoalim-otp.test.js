import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import moment from 'moment';
import hapoalimModule from 'israeli-bank-scrapers/lib/scrapers/hapoalim.js';

import { HapoalimOtpScraper } from '../src/hapoalim-otp.js';

const HapoalimScraper = hapoalimModule.default ?? hapoalimModule;

test('hapoalim: the library and this code use one moment module', () => {
  const require = createRequire(import.meta.url);
  const libraryRequire = createRequire(require.resolve('israeli-bank-scrapers/lib/scrapers/hapoalim.js'));
  assert.equal(libraryRequire('moment'), moment);
});

test('hapoalim: a start date older than one year is fetched in one-year windows', async t => {
  const ends = [];
  t.mock.method(HapoalimScraper.prototype, 'fetchData', async () => {
    ends.push(moment().format('YYYY-MM-DD'));
    return { success: true, accounts: [{ accountNumber: '12-1-1', balance: 5, txns: [ends.length] }] };
  });
  const realNow = moment.now;
  const startDate = moment().subtract(2, 'years').subtract(10, 'days').toDate();

  const result = await new HapoalimOtpScraper({ startDate }).fetchData();

  const today = moment();
  assert.deepEqual(ends, [0, 1, 2].map(n => today.clone().subtract(n, 'years').format('YYYY-MM-DD')));
  assert.deepEqual(result, { success: true, accounts: [{ accountNumber: '12-1-1', balance: 5, txns: [1, 2, 3] }] });
  assert.equal(moment.now, realNow);
});

test('hapoalim: a recent start date is one normal fetch', async t => {
  const fetch = t.mock.method(HapoalimScraper.prototype, 'fetchData', async () => ({ success: true, accounts: [] }));
  await new HapoalimOtpScraper({ startDate: moment().subtract(7, 'days').toDate() }).fetchData();
  assert.equal(fetch.mock.callCount(), 1);
});
