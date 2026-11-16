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

const day = m => moment(m).format('YYYY-MM-DD');

test('hapoalim: a start date more than one month back is fetched month by month', async t => {
  const windows = [];
  t.mock.method(HapoalimScraper.prototype, 'fetchData', async function () {
    windows.push([day(this.options.startDate), day(moment())]);
    return { success: true, accounts: [{ accountNumber: '12-1-1', balance: 5, txns: [windows.length] }] };
  });
  const realNow = moment.now;
  const today = moment();
  const startDate = today.clone().subtract(2, 'months').subtract(10, 'days').toDate();
  const scraper = new HapoalimOtpScraper({ startDate, companyId: 'hapoalim' });
  scraper.windowPauseMs = 30;

  const started = Date.now();
  const result = await scraper.fetchData();

  assert.ok(Date.now() - started >= 60, 'a pause before the 2nd and the 3rd request');

  const back = n => today.clone().subtract(n, 'months');
  assert.deepEqual(windows, [
    [day(back(1).add(1, 'days')), day(today)],
    [day(back(2).add(1, 'days')), day(back(1))],
    [day(startDate), day(back(2))],
  ]);
  assert.deepEqual(result, { success: true, accounts: [{ accountNumber: '12-1-1', balance: 5, txns: [1, 2, 3] }] });
  assert.equal(moment.now, realNow);
  assert.deepEqual(scraper.options, { startDate, companyId: 'hapoalim' });
});

test('hapoalim: a month with 150 rows fails (the bank cuts the answer)', async t => {
  t.mock.method(HapoalimScraper.prototype, 'fetchData', async () => (
    { success: true, accounts: [{ accountNumber: '12-1-1', txns: new Array(150).fill(0) }] }));
  const result = await new HapoalimOtpScraper({ startDate: moment().subtract(3, 'months').toDate() }).fetchData();
  assert.equal(result.success, false);
  assert.match(result.errorMessage, /150 rows/);
});

test('hapoalim: a recent start date is one normal fetch', async t => {
  const fetch = t.mock.method(HapoalimScraper.prototype, 'fetchData', async () => ({ success: true, accounts: [] }));
  await new HapoalimOtpScraper({ startDate: moment().subtract(7, 'days').toDate() }).fetchData();
  assert.equal(fetch.mock.callCount(), 1);
});
