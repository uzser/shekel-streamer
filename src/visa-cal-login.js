// Visa Cal scraper with a fix for the new login popup and a pause between API requests.
//
// Since 2026-10 Cal shows some users a new login popup (it looks like an A/B test): the user name
// tab is an Angular tab link, and the old `#regular-login` element is not there. The upstream
// scraper (israeli-bank-scrapers 6.13) waits for `#regular-login` and times out.
// The selectors and the retry come from upstream PR #1212 (not merged).
//
// The upstream scraper asks for the months one after the other without a pause (cards in
// parallel). Here the Cal API requests go one at a time, with a pause before each one.
//
// SMS login ("כניסה מהירה"): credentials { id, last4Digits } instead of { username, password }.
// Cal gives a user name only the cards tied to that user name; the SMS login sees all cards of the
// ID number (bank-issued cards, PayBox, Diners). The flow follows upstream PR #1134 (not merged).
// The code comes from `otpCodeRetriever`. The keys of Cal's login responses (no values) go to
// `loginInfo`; a `hash` (the Cal app logs in again with it, no SMS) goes to `loginHash`.
//
// History: the upstream scraper asks for at most 1.5 years back from "now" (moment()). For an
// older start date, fetchData() asks window by window: moment's clock moves to the end of each
// window. An older window that fails or has no rows ends the history; `historyNote` says why.

import moment from 'moment';
import visaCalModule from 'israeli-bank-scrapers/lib/scrapers/visa-cal.js';
import elements from 'israeli-bank-scrapers/lib/helpers/elements-interactions.js';
import fetchModule from 'israeli-bank-scrapers/lib/helpers/fetch.js';

const VisaCalScraper = visaCalModule.default ?? visaCalModule;
const { waitUntilElementFound, clickButton, fillInput } = elements;

const LOGIN_BUTTON_SELECTOR = '#ccLoginDesktopBtn';
// The user name and password tab ("Login with a user name"); the old id as a fallback.
const PASSWORD_TAB_SELECTOR = '[role="tab"][alt="כניסה עם שם משתמש"], #regular-login';
const USER_NAME_SELECTOR = '[formcontrolname="userName"]';
// The SMS login tab (the default tab in 2026-11) and its form.
const OTP_TAB_SELECTOR = '#send-otp, [role="tab"][alt="כניסה מהירה"]';
const OTP_ID_SELECTOR = '[formcontrolname="id"]';
const OTP_CARD_SELECTOR = '[formcontrolname="secondOtpParam"]';
const OTP_CODE_SELECTOR = '[formcontrolname="otp"]';
// "שלחו לי סיסמה ב-SMS", then the submit button of the code form.
const SUBMIT_SELECTOR = 'button[type="submit"]';
const SSO_URL = 'https://connect.cal-online.co.il/col-rest/calconnect/authentication/SSO';
const TAB_ATTEMPTS = 3;
const FRAME_TIMEOUT_MS = 10000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The oldest start that the upstream scraper accepts for a given "now".
const libraryStart = now => now.clone().subtract(1, 'years').subtract(6, 'months').add(1, 'days');

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

export const isOtpLogin = credentials => Boolean(credentials?.id && credentials?.last4Digits);

export class VisaCalLoginScraper extends VisaCalScraper {
  /**
   * @param {(info: {attempt: number}) => Promise<string|null>} [otpCodeRetriever] for the SMS login
   */
  constructor(options, otpCodeRetriever) {
    super(options);
    this.otpCodeRetriever = otpCodeRetriever;
    this.otpFormTimeoutMs = 30000;
    this.loginInfo = [];
    this.loginHash = null;
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
      const { startDate } = this.options;
      if (!startDate || !moment(startDate).isBefore(libraryStart(moment()))) {
        return await super.fetchData();
      }
      return await this.fetchHistory();
    } finally {
      fetchModule.fetchPost = realFetchPost;
    }
  }

  // Windows from the newest: [max(startDate, libraryStart(end)), end). Each window keeps only its
  // own rows: pending rows and the month after `end` come again in every window.
  async fetchHistory() {
    const { options } = this;
    const realNow = moment.now;
    const accounts = new Map();
    try {
      for (let end = moment(), i = 0; end.isAfter(options.startDate); i++) {
        const endMs = end.valueOf();
        moment.now = () => endMs;
        const windowStart = moment.max(moment(options.startDate), libraryStart(end));
        this.options = { ...options, startDate: windowStart.toDate(), ...(i > 0 && { futureMonthsToScrape: 0 }) };
        let result;
        try {
          result = await super.fetchData();
        } catch (error) {
          if (i === 0) {
            throw error;
          }
          result = { success: false, errorMessage: error.message };
        }
        if (!result.success) {
          if (i === 0) {
            return result;
          }
          this.historyNote = `Cal gave no data before ${end.format('YYYY-MM-DD')}: ${result.errorMessage || result.errorType}`;
          break;
        }
        let rows = 0;
        for (const account of result.accounts) {
          const txns = i === 0 ? account.txns : account.txns.filter(t => moment(t.date).isBefore(end));
          rows += txns.length;
          if (!accounts.has(account.accountNumber)) {
            accounts.set(account.accountNumber, { ...account, txns: [] });
          }
          accounts.get(account.accountNumber).txns.push(...txns);
        }
        if (i > 0 && rows === 0) {
          this.historyNote = `no rows before ${end.format('YYYY-MM-DD')}`;
          break;
        }
        end = windowStart;
      }
    } finally {
      moment.now = realNow;
      this.options = options;
    }
    return { success: true, accounts: [...accounts.values()] };
  }

  getLoginOptions(credentials) {
    const options = super.getLoginOptions(credentials);
    if (!isOtpLogin(credentials)) {
      return options;
    }
    return {
      ...options,
      fields: [
        { selector: OTP_ID_SELECTOR, value: credentials.id },
        { selector: OTP_CARD_SELECTOR, value: credentials.last4Digits },
      ],
      preAction: () => this.openLoginPopupAnyMarkup(OTP_TAB_SELECTOR, OTP_ID_SELECTOR, 'SMS'),
      submitButtonSelector: () => this.submitOtp(),
    };
  }

  // The login frame when `selector` is visible in it, else null.
  async frameWithVisible(selector) {
    const frame = await getLoginFrame(this.page);
    const field = await frame.$(selector).catch(() => null);
    return field && (await field.isVisible().catch(() => false)) ? frame : null;
  }

  async submitOtp() {
    await clickButton(await getLoginFrame(this.page), SUBMIT_SELECTOR);
    const frame = await poll(() => this.frameWithVisible(OTP_CODE_SELECTOR), this.otpFormTimeoutMs, this.retryPauseMs);
    if (!frame) {
      const fields = await (await getLoginFrame(this.page)).evaluate(() => [...document.querySelectorAll('[formcontrolname]')]
        .filter(e => e.offsetWidth || e.offsetHeight).map(e => e.getAttribute('formcontrolname')).join(', ')).catch(() => '?');
      throw new Error(`Visa Cal: no SMS code field after the send button (visible fields: ${fields})`);
    }
    const code = this.otpCodeRetriever ? await this.otpCodeRetriever({ attempt: 1 }) : null;
    if (!code) {
      throw new Error('Visa Cal: no SMS code');
    }
    await fillInput(frame, OTP_CODE_SELECTOR, String(code).trim());
    this.page.on('response', response => this.readLoginResponse(response));
    // The upstream wait for the token request (10 s from getLoginOptions) is over by now.
    this.authRequestPromise = this.page.waitForRequest(SSO_URL, { timeout: 30000 }).catch(() => undefined);
    await clickButton(frame, SUBMIT_SELECTOR);
  }

  // Keeps the path and the result keys of Cal's login and OTP responses, never the values.
  async readLoginResponse(response) {
    const url = new URL(response.url());
    if (!/cal-online\.co\.il$/.test(url.hostname) || !/otp|login|sso/i.test(url.pathname)) {
      return;
    }
    const json = await response.json().catch(() => null);
    const result = json && typeof json.result === 'object' && json.result ? json.result : null;
    this.loginInfo.push({ path: url.pathname, keys: result ? Object.keys(result) : [] });
    if (typeof result?.hash === 'string' && result.hash) {
      this.loginHash = result.hash;
    }
  }

  async openLoginPopupAnyMarkup(tabSelector = PASSWORD_TAB_SELECTOR, fieldSelector = USER_NAME_SELECTOR, name = 'password') {
    await waitUntilElementFound(this.page, LOGIN_BUTTON_SELECTOR, true);
    await clickButton(this.page, LOGIN_BUTTON_SELECTOR);
    await waitUntilElementFound(await getLoginFrame(this.page), tabSelector);
    // A click on the tab navigates the iframe. A click before the iframe app is ready is ignored.
    for (let attempt = 1; attempt <= TAB_ATTEMPTS; attempt++) {
      await clickButton(await getLoginFrame(this.page), tabSelector).catch(() => {});
      const frame = await poll(() => this.frameWithVisible(fieldSelector), this.formTimeoutMs, this.retryPauseMs);
      if (frame) {
        return frame;
      }
    }
    throw new Error(`Visa Cal: failed to open the ${name} login tab`);
  }
}
