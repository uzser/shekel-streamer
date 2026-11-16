// Visa Cal scraper with a fix for the new login popup and a pause between API requests.
//
// Since 2026-10 Cal shows some users a new login popup (it looks like an A/B test): the user name
// tab is an Angular tab link, and the old `#regular-login` element is not there. The upstream
// scraper (israeli-bank-scrapers 6.13) waits for `#regular-login` and times out.
// The selectors and the retry come from upstream PR #1212 (not merged).
//
// The upstream scraper asks for the months one after the other without a pause (cards in
// parallel). Here the Cal API requests go one at a time, with a pause before each one.

import visaCalModule from 'israeli-bank-scrapers/lib/scrapers/visa-cal.js';
import elements from 'israeli-bank-scrapers/lib/helpers/elements-interactions.js';
import fetchModule from 'israeli-bank-scrapers/lib/helpers/fetch.js';

const VisaCalScraper = visaCalModule.default ?? visaCalModule;
const { waitUntilElementFound, clickButton } = elements;

const LOGIN_BUTTON_SELECTOR = '#ccLoginDesktopBtn';
// The user name and password tab ("Login with a user name"); the old id as a fallback.
const PASSWORD_TAB_SELECTOR = '[role="tab"][alt="כניסה עם שם משתמש"], #regular-login';
const USER_NAME_SELECTOR = '[formcontrolname="userName"]';
const TAB_ATTEMPTS = 3;
const FRAME_TIMEOUT_MS = 10000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Calls `check` until it returns a truthy value or the time is over. Returns the last value.
async function poll(check, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value || Date.now() >= deadline) {
      return value;
    }
    await sleep(intervalMs);
  }
}

async function getLoginFrame(page) {
  const frame = await poll(() => page.frames().find(f => f.url().includes('connect')), FRAME_TIMEOUT_MS, 250);
  if (!frame) {
    throw new Error('failed to extract login iframe');
  }
  return frame;
}

export class VisaCalLoginScraper extends VisaCalScraper {
  constructor(options) {
    super(options);
    this.formTimeoutMs = 5000;
    this.retryPauseMs = 250;
    this.requestPauseMs = 3000;
    // openLoginPopup is a class field of the upstream scraper: replace it after super().
    this.openLoginPopup = () => this.openLoginPopupAnyMarkup();
  }

  // The upstream scraper calls fetchPost of the library fetch module (read at each call), so a
  // wrapper on that module puts its requests in one queue.
  async fetchData() {
    const realFetchPost = fetchModule.fetchPost;
    let queue = Promise.resolve();
    fetchModule.fetchPost = (...args) => {
      const result = queue.then(() => sleep(this.requestPauseMs)).then(() => realFetchPost(...args));
      queue = result.catch(() => {});
      return result;
    };
    try {
      return await super.fetchData();
    } finally {
      fetchModule.fetchPost = realFetchPost;
    }
  }

  async openLoginPopupAnyMarkup() {
    await waitUntilElementFound(this.page, LOGIN_BUTTON_SELECTOR, true);
    await clickButton(this.page, LOGIN_BUTTON_SELECTOR);
    await waitUntilElementFound(await getLoginFrame(this.page), PASSWORD_TAB_SELECTOR);
    // A click on the tab navigates the iframe. A click before the iframe app is ready is ignored.
    for (let attempt = 1; attempt <= TAB_ATTEMPTS; attempt++) {
      await clickButton(await getLoginFrame(this.page), PASSWORD_TAB_SELECTOR).catch(() => {});
      const frame = await poll(async () => {
        const current = await getLoginFrame(this.page);
        const field = await current.$(USER_NAME_SELECTOR).catch(() => null);
        return field && (await field.isVisible().catch(() => false)) ? current : null;
      }, this.formTimeoutMs, this.retryPauseMs);
      if (frame) {
        return frame;
      }
    }
    throw new Error('Visa Cal: failed to open the password login tab');
  }
}
