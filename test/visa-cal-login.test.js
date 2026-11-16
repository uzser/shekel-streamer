import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import moment from 'moment';
import visaCalModule from 'israeli-bank-scrapers/lib/scrapers/visa-cal.js';
import fetchModule from 'israeli-bank-scrapers/lib/helpers/fetch.js';

import { VisaCalLoginScraper, isOtpLogin } from '../src/visa-cal-login.js';
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

// A fake page for the SMS login: the code field shows after the first click on the submit button.
function fakeOtpPage() {
  const events = [];
  const frame = {
    url: () => 'https://connect.cal-online.co.il/send-otp',
    waitForSelector: async () => {},
    $eval: async selector => { events.push(`click ${selector}`); },
    type: async (selector, value) => { events.push(`type ${selector} ${value}`); },
    $: async selector => (selector === '[formcontrolname="otp"]' && !events.some(e => e.startsWith('click button'))
      ? null : { isVisible: async () => true }),
    evaluate: async () => '',
  };
  const page = {
    waitForSelector: async () => {},
    waitForRequest: () => new Promise(() => {}),
    on: (name) => events.push(`on ${name}`),
    $eval: async () => {},
    frames: () => [frame],
  };
  return { page, frame, events };
}

test('visaCal: id + last4Digits is the SMS login, user name + password is not', () => {
  assert.equal(isOtpLogin({ id: '1', last4Digits: '1234' }), true);
  assert.equal(isOtpLogin({ username: 'u', password: 'p' }), false);
  assert.equal(isOtpLogin({ id: '1' }), false);

  const { page } = fakeOtpPage();
  const s = scraper(page);
  const otp = s.getLoginOptions({ id: '000000018', last4Digits: '1234' });
  assert.deepEqual(otp.fields, [
    { selector: '[formcontrolname="id"]', value: '000000018' },
    { selector: '[formcontrolname="secondOtpParam"]', value: '1234' },
  ]);
  assert.equal(typeof otp.submitButtonSelector, 'function');
  const password = s.getLoginOptions({ username: 'u', password: 'p' });
  assert.equal(password.fields[0].selector, '[formcontrolname="userName"]');
  assert.equal(password.submitButtonSelector, 'button[type="submit"]');
});

test('visaCal: SMS login sends the code request, types the code from the retriever, submits', async () => {
  const { page, events } = fakeOtpPage();
  const asked = [];
  const s = new VisaCalLoginScraper({ companyId: 'visaCal', startDate: new Date() }, async info => {
    asked.push(info);
    return ' 123456 ';
  });
  s.page = page;
  s.retryPauseMs = 5;

  await s.submitOtp();

  assert.deepEqual(asked, [{ attempt: 1 }]);
  assert.deepEqual(events, [
    'click button[type="submit"]',
    'click [formcontrolname="otp"]',
    'type [formcontrolname="otp"] 123456',
    'on response',
    'click button[type="submit"]',
  ]);
});

test('visaCal: SMS login with no code or no code field is an error', async () => {
  const noCode = new VisaCalLoginScraper({ companyId: 'visaCal', startDate: new Date() }, async () => null);
  noCode.page = fakeOtpPage().page;
  noCode.retryPauseMs = 5;
  await assert.rejects(noCode.submitOtp(), /no SMS code$/);

  const { page, frame } = fakeOtpPage();
  frame.$ = async () => null;
  const noField = new VisaCalLoginScraper({ companyId: 'visaCal', startDate: new Date() }, async () => '1');
  noField.page = page;
  noField.retryPauseMs = 5;
  noField.otpFormTimeoutMs = 30;
  await assert.rejects(noField.submitOtp(), /no SMS code field/);
});

test('visaCal: login responses keep the paths and result keys, the hash goes to loginHash', async () => {
  const s = scraper(fakeOtpPage().page);
  const response = (url, json) => ({ url: () => url, json: async () => json });
  await s.readLoginResponse(response('https://api.cal-online.co.il/Authentication/api/login/verifyOTP',
    { result: { calConnectToken: 't', hash: 'h' } }));
  await s.readLoginResponse(response('https://api.cal-online.co.il/Transactions/api/x', { result: { a: 1 } }));
  await s.readLoginResponse(response('https://evil.example/login', { result: { hash: 'x' } }));
  assert.deepEqual(s.loginInfo, [{ path: '/Authentication/api/login/verifyOTP', keys: ['calConnectToken', 'hash'] }]);
  assert.equal(s.loginHash, 'h');
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
