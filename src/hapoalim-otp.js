// Bank Hapoalim scraper with SMS one-time-code support.
//
// Since 2026-06 Bank Hapoalim shows an SMS code form after the credentials when it does not know
// the device. The upstream scraper (israeli-bank-scrapers 6.13) waits for a redirect and fails.
// This subclass detects the form, asks `otpCodeRetriever` for the code and submits it.
// The DOM selectors come from upstream PR #1200 (not merged).
//
// Device trust: run the scraper in a browser with a persistent profile (`userDataDir`). The
// profile keeps the cookies and localStorage that mark the device as known, so the bank asks
// for a code again only when that trust expires (about 30 days).

import hapoalimModule from 'israeli-bank-scrapers/lib/scrapers/hapoalim.js';

const HapoalimScraper = hapoalimModule.default ?? hapoalimModule;

const OTP_FORM_SELECTOR = 'form.auth-otp-login';
const OTP_INPUT_SELECTOR = `${OTP_FORM_SELECTOR} input:not([type="hidden"])`;
const OTP_SUBMIT_SELECTOR = '.btn-red_1';
const OTP_ERROR_SELECTOR = '.errors-rb .error-message, .auth-otp-login .error';
const HOME_URL_FRAGMENTS = [
  '/portalserver/HomePage',
  '/ng-portals-bt/rb/he/homepage',
  '/ng-portals/rb/he/homepage',
];
// Inline message on the login page when the user code or the password is wrong (no redirect):
// "One or more of the details you typed is wrong."
const INVALID_CREDENTIALS_TEXT = 'אחד או יותר מהנתונים שהקלדת שגוי';
const MAX_OTP_ATTEMPTS = 3;
const LOGIN_SETTLE_TIMEOUT_MS = 20000;
const OTP_RESULT_TIMEOUT_MS = 20000;
const HOME_TIMEOUT_MS = 15000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Polls `test` until it returns a truthy value or the timeout ends. A throw (for example, the
 * page is navigating) counts as "not yet". Returns the value or null.
 */
async function poll(test, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await test();
      if (value) {
        return value;
      }
    } catch {
      // Page is navigating; try again.
    }
    await sleep(intervalMs);
  }
  return null;
}

function failure(errorType, errorMessage) {
  return { success: false, errorType, errorMessage };
}

export class HapoalimOtpScraper extends HapoalimScraper {
  /**
   * @param {object} options israeli-bank-scrapers options
   * @param {(info: {attempt: number}) => Promise<string|null>} otpCodeRetriever
   */
  constructor(options, otpCodeRetriever) {
    super(options);
    this.otpCodeRetriever = otpCodeRetriever;
  }

  getLoginOptions(credentials) {
    const options = super.getLoginOptions(credentials);
    // Stock postAction waits only for a redirect. The SMS code form and the "wrong details"
    // message appear on the same URL, so also stop when one of them is up.
    options.postAction = async () => {
      const initialUrl = this.page.url();
      await poll(
        async () => this.page.url() !== initialUrl
          || (await this.isOtpFormPresent())
          || (await this.isInvalidCredentialsShown()),
        LOGIN_SETTLE_TIMEOUT_MS,
      );
    };
    return options;
  }

  async login(credentials) {
    let result;
    try {
      result = await super.login(credentials);
    } catch (error) {
      if (!(await this.isOtpFormPresent())) {
        throw error;
      }
      result = { success: false };
    }

    if (!result.success && (await this.isInvalidCredentialsShown())) {
      // Do not retry: repeated wrong logins can block the account.
      return failure('INVALID_PASSWORD', 'Bank Hapoalim: wrong user code or password');
    }

    if (result.success || !(await this.isOtpFormPresent())) {
      return result;
    }

    if (typeof this.otpCodeRetriever !== 'function') {
      return failure('TWO_FACTOR_RETRIEVER_MISSING', 'Bank Hapoalim asked for an SMS code');
    }
    return this.otpLogin();
  }

  async otpLogin() {
    for (let attempt = 1; attempt <= MAX_OTP_ATTEMPTS; attempt += 1) {
      const code = await this.otpCodeRetriever({ attempt });
      const digits = typeof code === 'string' ? code.replace(/\s+/g, '') : '';
      if (!digits) {
        return failure('TWO_FACTOR_RETRIEVER_MISSING', 'No SMS code was provided in time');
      }

      await this.fillOtpCode(digits);
      // page.click sends trusted mouse events; the bank's Angular form ignores el.click().
      await this.page.click(OTP_SUBMIT_SELECTOR);

      const outcome = await poll(async () => {
        if (!(await this.page.$(OTP_FORM_SELECTOR))) {
          return 'gone';
        }
        return (await this.page.$(OTP_ERROR_SELECTOR)) ? 'error' : null;
      }, OTP_RESULT_TIMEOUT_MS);

      if (outcome === 'gone') {
        const atHome = await poll(
          async () => HOME_URL_FRAGMENTS.some(fragment => this.page.url().includes(fragment)),
          HOME_TIMEOUT_MS,
        );
        return atHome
          ? { success: true }
          : failure('GENERAL_ERROR', 'The bank accepted the SMS code but did not open the home page');
      }
      // Wrong code or no answer from the form: ask again.
    }
    return failure('GENERAL_ERROR', `The bank rejected the SMS code ${MAX_OTP_ATTEMPTS} times`);
  }

  async fillOtpCode(code) {
    const inputs = await this.page.$$(OTP_INPUT_SELECTOR);
    if (inputs.length === 1) {
      await inputs[0].click({ clickCount: 3 });
      await inputs[0].type(code, { delay: 100 });
      return;
    }
    // One input per digit.
    for (let i = 0; i < inputs.length; i += 1) {
      await inputs[i].click();
      await inputs[i].evaluate(el => {
        el.value = '';
      });
      if (i < code.length) {
        await inputs[i].type(code[i]);
      }
      await sleep(100);
    }
  }

  async isInvalidCredentialsShown() {
    try {
      return await this.page.evaluate(
        text => !!document.body && document.body.innerText.includes(text),
        INVALID_CREDENTIALS_TEXT,
      );
    } catch {
      return false;
    }
  }

  async isOtpFormPresent() {
    try {
      return !!(await this.page.$(OTP_FORM_SELECTOR));
    } catch {
      return false;
    }
  }
}
