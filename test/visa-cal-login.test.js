import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VisaCalLoginScraper } from '../src/visa-cal-login.js';
import { redactScraperError } from '../src/redact.js';

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
