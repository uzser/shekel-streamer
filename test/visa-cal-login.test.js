import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import moment from 'moment';
import visaCalModule from 'israeli-bank-scrapers/lib/scrapers/visa-cal.js';
import fetchModule from 'israeli-bank-scrapers/lib/helpers/fetch.js';

import { VisaCalLoginScraper, isOtpLogin } from '../src/visa-cal-login.js';
import { calAppLogin, hashFile } from '../src/visa-cal-app.js';
import { redactScraperError } from '../src/redact.js';

const VisaCalScraper = visaCalModule.default ?? visaCalModule;

test('visaCal: the library scraper and this code use one fetch module', () => {
  const require = createRequire(import.meta.url);
  const scraperRequire = createRequire(require.resolve('israeli-bank-scrapers/lib/scrapers/visa-cal.js'));
  assert.equal(scraperRequire('../helpers/fetch'), fetchModule);
});

test('visaCal: API requests go one at a time with a pause, fetchPost is restored', async t => {
  const calls = [];
  const fakeFetchPost = async url => {
    calls.push({ url, start: Date.now() });
    await new Promise(r => setTimeout(r, 5));
    calls.at(-1).end = Date.now();
    return { statusCode: 1 };
  };
  const realFetchPost = fetchModule.fetchPost;
  fetchModule.fetchPost = fakeFetchPost;
  t.after(() => { fetchModule.fetchPost = realFetchPost; });
  // Like the upstream scraper: two cards in parallel, each asks for months one after the other.
  t.mock.method(VisaCalScraper.prototype, 'fetchData', async () => {
    const card = async id => {
      for (let m = 0; m < 2; m++) {
        await fetchModule.fetchPost(`card${id}/month${m}`);
      }
    };
    await Promise.all([card(1), card(2)]);
    return { success: true, accounts: [] };
  });
  const s = new VisaCalLoginScraper({ companyId: 'visaCal', startDate: new Date() });
  s.requestPauseMs = 20;

  assert.deepEqual(await s.fetchData(), { success: true, accounts: [] });

  assert.equal(calls.length, 4);
  for (let i = 1; i < calls.length; i++) {
    assert.ok(calls[i].start - calls[i - 1].end >= 18, `pause before request ${i}`);
  }
  assert.equal(fetchModule.fetchPost, fakeFetchPost);
});

// A fake page with the Cal login iframe. The user name field shows after `opensAfter` tab clicks.
function fakePage(opensAfter) {
  const clicks = [];
  const frame = {
    url: () => 'https://connect.cal-online.co.il/login',
    waitForSelector: async () => {},
    $eval: async selector => { clicks.push(selector); },
    $: async () => (clicks.length >= opensAfter ? { isVisible: async () => true } : null),
  };
  const page = {
    waitForSelector: async () => {},
    $eval: async () => {},
    frames: () => [{ url: () => 'https://www.cal-online.co.il/' }, frame],
  };
  return { page, frame, clicks };
}

function scraper(page) {
  const s = new VisaCalLoginScraper({ companyId: 'visaCal', startDate: new Date() });
  s.page = page;
  s.formTimeoutMs = 30;
  s.retryPauseMs = 5;
  return s;
}

const day = m => moment(m).format('YYYY-MM-DD');

// Fake upstream fetchData: one row per month of the window, one pending row of today, one row of
// the month after "now". Rows exist from `firstRow` on; `failBefore`: a window that ends before it throws.
function fakeCalHistory(t, { firstRow, failBefore } = {}) {
  const windows = [];
  t.mock.method(VisaCalScraper.prototype, 'fetchData', async function () {
    const now = moment();
    const start = moment(this.options.startDate);
    windows.push([day(start), day(now), this.options.futureMonthsToScrape]);
    if (failBefore && now.isBefore(failBefore)) {
      throw new Error('failed to fetch transactions for card 1234. Message: old');
    }
    const txns = [];
    for (let m = start.clone(); m.isBefore(now); m.add(1, 'months')) {
      if (!firstRow || !m.isBefore(firstRow)) {
        txns.push({ date: m.toISOString(), description: `month ${day(m)}` });
      }
    }
    txns.push({ date: moment(realNowValue()).toISOString(), description: 'pending today' });
    txns.push({ date: now.clone().add(10, 'days').toISOString(), description: 'next month' });
    return { success: true, accounts: [{ accountNumber: '1234', txns }] };
  });
  return windows;
}
const realNowValue = Date.now;

function calScraper(startDate) {
  const s = new VisaCalLoginScraper({ companyId: 'visaCal', startDate });
  s.requestPauseMs = 0;
  return s;
}

test('visaCal: a start date older than 1.5 years is fetched window by window, no row twice', async t => {
  const today = moment();
  const windows = fakeCalHistory(t, { firstRow: today.clone().subtract(30, 'months') });
  const realNow = moment.now;
  const s = calScraper(today.clone().subtract(6, 'years').toDate());

  const result = await s.fetchData();

  const w1 = today.clone().subtract(18, 'months').add(1, 'days');
  const w2 = w1.clone().subtract(18, 'months').add(1, 'days');
  const w3 = w2.clone().subtract(18, 'months').add(1, 'days');
  assert.deepEqual(windows, [
    [day(w1), day(today), undefined],
    [day(w2), day(w1), 0],
    [day(w3), day(w2), 0],
  ]);
  assert.equal(moment.now, realNow);
  assert.equal(s.options.futureMonthsToScrape, undefined);
  assert.match(s.historyNote, new RegExp(`no rows before ${day(w2)}`));
  const descriptions = result.accounts[0].txns.map(t => t.description);
  assert.equal(new Set(descriptions).size, descriptions.length, 'no row twice');
  assert.equal(descriptions.filter(d => d === 'pending today').length, 1);
  const older = descriptions.filter(d => d.startsWith('month ') && d.slice(6) < day(w1));
  assert.equal(older.length, 12, 'rows of the 2nd window (from 30 months back) are kept');
});

test('visaCal: an older window that fails ends the history, the newer rows stay', async t => {
  const today = moment();
  fakeCalHistory(t, { failBefore: today.clone().subtract(17, 'months') });
  const s = calScraper(today.clone().subtract(5, 'years').toDate());

  const result = await s.fetchData();

  assert.equal(result.success, true);
  assert.ok(result.accounts[0].txns.length > 10);
  assert.match(s.historyNote, /Cal gave no data before .*Message: old/);
});

test('visaCal: a recent start date is one normal fetch', async t => {
  const windows = fakeCalHistory(t);
  await calScraper(moment().subtract(7, 'days').toDate()).fetchData();
  assert.equal(windows.length, 1);
});

test('visaCal: the tab selector has the new markup and the old id', async () => {
  const { page, frame, clicks } = fakePage(1);
  assert.equal(await scraper(page).openLoginPopup(), frame);
  assert.match(clicks[0], /\[role="tab"\]\[alt="כניסה עם שם משתמש"\]/);
  assert.match(clicks[0], /#regular-login/);
});

test('visaCal: an ignored first tab click is clicked again', async () => {
  const { page, frame, clicks } = fakePage(2);
  assert.equal(await scraper(page).openLoginPopup(), frame);
  assert.equal(clicks.length, 2);
});

test('visaCal: no login form after 3 clicks is an error', async () => {
  const { page, clicks } = fakePage(Infinity);
  await assert.rejects(scraper(page).openLoginPopup(), /failed to open the password login tab/);
  assert.equal(clicks.length, 3);
});

// A fake Cal app API. `validHashes`: the hashes that bioLogin accepts. Each login gives a new hash.
function fakeCalApi(validHashes = []) {
  const calls = [];
  let n = 0;
  const answer = (statusCode, result = null) => ({ status: 200, json: async () => ({ statusCode, statusDescription: 'text', result }) });
  const session = () => ({ calConnectToken: ' token ', temporaryGuid: 'guid', hash: `new${++n}` });
  const fetch = async (url, { method, headers, body }) => {
    const path = url.replace('https://api-cc.cal-online.co.il/Authentication/api/', '');
    const data = JSON.parse(body);
    calls.push({ method, path, data, authorization: headers.Authorization });
    if (path === 'login/bioLogin') return validHashes.includes(data.hash) ? answer(1, session()) : answer(6);
    if (path === 'login/sendOTP') return data.last4Digits === '1234' ? answer(1, { token: 'otp-token' }) : answer(4);
    if (path === 'login/verifyOTP') return data.password === '123456' ? answer(1, session()) : answer(5);
    if (path === 'account/init') {
      return answer(1, { user: { name: 'private' }, cards: [{ cardUniqueId: 'c1', last4Digits: '1234', owner: 'private' }] });
    }
    throw new Error(`unexpected ${path}`);
  };
  return { fetch, calls };
}

function memoryStore(hashes = {}) {
  const store = { hashes, writes: 0, read: () => store.hashes, write: h => { store.hashes = h; store.writes++; } };
  return store;
}

const CAL_ID = { id: '18', last4Digits: '1234' };

test('visaCal: id + last4Digits is the SMS login, user name + password is not', () => {
  assert.equal(isOtpLogin({ id: '1', last4Digits: '1234' }), true);
  assert.equal(isOtpLogin({ username: 'u', password: 'p' }), false);
  assert.equal(isOtpLogin({ id: '1' }), false);
});

test('visaCal app: no stored hash = SMS login, the hash is stored, cards have 2 fields only', async () => {
  const { fetch, calls } = fakeCalApi();
  const store = memoryStore();
  const asked = [];
  const result = await calAppLogin(CAL_ID, store, async info => { asked.push(info); return ' 123456 '; }, fetch);

  assert.deepEqual(asked, [{ attempt: 1 }]);
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`),
    ['PUT login/sendOTP', 'POST login/verifyOTP', 'POST account/init']);
  assert.deepEqual(calls[0].data, { custExtId: '000000018', last4Digits: '1234', smsByVoice: false });
  assert.equal(calls[1].data.token, 'otp-token');
  assert.equal(calls[1].data.password, '123456');
  assert.match(calls[1].data.uuid, /^[0-9a-f]{32}$/);
  assert.deepEqual(calls[2], { method: 'POST', path: 'account/init', data: { tokenGuid: 'guid' }, authorization: 'CALAuthScheme token' });
  assert.deepEqual(result, { authorization: 'CALAuthScheme token', cards: [{ cardUniqueId: 'c1', last4Digits: '1234' }], method: 'sms' });
  assert.deepEqual(store.hashes, { hash: 'new1', previous: undefined });
});

test('visaCal app: a stored hash logs in with no SMS, the new hash replaces it', async () => {
  const { fetch, calls } = fakeCalApi(['h1']);
  const store = memoryStore({ hash: 'h1' });
  const result = await calAppLogin(CAL_ID, store, async () => assert.fail('no SMS'), fetch);

  assert.equal(result.method, 'hash');
  assert.deepEqual(calls.map(c => c.path), ['login/bioLogin', 'account/init']);
  assert.deepEqual(store.hashes, { hash: 'new1', previous: 'h1' });
});

test('visaCal app: a refused hash tries the previous hash, then the SMS login', async () => {
  const previous = fakeCalApi(['h0']);
  const store = memoryStore({ hash: 'h1', previous: 'h0' });
  assert.equal((await calAppLogin(CAL_ID, store, async () => assert.fail('no SMS'), previous.fetch)).method, 'hash');
  assert.deepEqual(previous.calls.map(c => c.data.hash).slice(0, 2), ['h1', 'h0']);
  assert.equal(store.hashes.hash, 'new1');

  const none = fakeCalApi();
  const stale = memoryStore({ hash: 'h1', previous: 'h0' });
  assert.equal((await calAppLogin(CAL_ID, stale, async () => '123456', none.fetch)).method, 'sms');
  assert.deepEqual(stale.hashes, { hash: 'new1', previous: undefined });
});

test('visaCal app: errors have the step and no secret, the stored hash stays', async () => {
  const { fetch } = fakeCalApi();
  const store = memoryStore();
  await assert.rejects(calAppLogin({ id: '18', last4Digits: '9999' }, store, async () => '123456', fetch),
    /the SMS request failed: text \(status 4\)$/);
  await assert.rejects(calAppLogin(CAL_ID, store, async () => null, fetch), /no SMS code$/);
  await assert.rejects(calAppLogin(CAL_ID, store, async () => '000000', fetch), /the SMS code failed: text \(status 5\)$/);
  assert.equal(store.writes, 0);
});

test('visaCal app: hashFile keeps the hashes in a private file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-hash-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, 'ALEX_visaCal.cal-hash');
  const store = hashFile(file);
  assert.deepEqual(store.read(), {});
  store.write({ hash: 'a', previous: 'b' });
  assert.deepEqual(hashFile(file).read(), { hash: 'a', previous: 'b' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['ALEX_visaCal.cal-hash']);
});

test('visaCal: the scraper with id + last4Digits logs in by the app API and fetches with its token and cards', async t => {
  const { fetch } = fakeCalApi(['h1']);
  t.mock.method(globalThis, 'fetch', fetch);
  const seen = {};
  t.mock.method(VisaCalScraper.prototype, 'fetchData', async function () {
    seen.cards = await this.getCards();
    seen.authorization = await this.getAuthorizationHeader();
    return { success: true, accounts: [] };
  });
  const store = memoryStore({ hash: 'h1' });
  const s = new VisaCalLoginScraper({ companyId: 'visaCal', startDate: new Date() }, null, store);
  s.requestPauseMs = 0;

  assert.deepEqual(await s.login(CAL_ID), { success: true });
  await s.fetchData();

  assert.equal(s.loginMethod, 'hash');
  assert.deepEqual(seen, { cards: [{ cardUniqueId: 'c1', last4Digits: '1234' }], authorization: 'CALAuthScheme token' });
  assert.equal(store.hashes.hash, 'new1');
});

test('redact: the request body of a scraper error is removed', () => {
  const text = 'fetchPostWithinPage parse error: Unexpected token \'<\'\n    at JSON.parse, '
    + 'url: https://digital.isracard.co.il/services/ProxyRequestHandler.ashx?reqName=performLogonI, '
    + 'data: {"MisparZihuy":"123456789","Sisma":"secret"}, extraHeaders: {}, result: <html>';
  const redacted = redactScraperError(text);
  assert.ok(!redacted.includes('secret') && !redacted.includes('123456789'));
  assert.match(redacted, /reqName=performLogonI, data: <hidden>$/);
  assert.equal(redactScraperError('Automation detected and blocked by server. Status: 429'),
    'Automation detected and blocked by server. Status: 429');
});
