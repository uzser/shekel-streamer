// Visa Cal login as the Cal app does it: plain HTTPS to api-cc.cal-online.co.il, no browser.
//
// 1. SMS login: sendOTP (ID + last 4 card digits) -> Cal sends an SMS -> verifyOTP (code).
// 2. The answer has a session token and a `hash`. Later logins: bioLogin (hash), no SMS.
// 3. Each bioLogin gives a new hash. The hash before it works one more time; after that only the
//    newest hash works (checked 2026-11-16). So the new hash is stored at once, and the stored
//    previous hash is the second try.
// The session token also works with the web API (api.cal-online.co.il), so the upstream scraper
// fetches the transactions as before.
// Endpoints: upstream RFC #1213. sendOTP is PUT: the gateway refuses POST (checked 2026-11-16).

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

const BASE_URL = 'https://api-cc.cal-online.co.il/Authentication/api';
const HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json; charset=UTF-8',
  'X-Site-Id': '8D37DF16-5812-4ACD-BAE7-CD1A5BFA2207',
  platform: 'android',
  version: '6.26.17',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 11; Pixel 3 Build/RQ1A.210105.003; wv) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.135 Mobile Safari/537.36',
};

/** The stored hashes of one account: a JSON file { hash, previous }, mode 600. */
export function hashFile(filePath) {
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        return {};
      }
    },
    write(hashes) {
      fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(hashes), { mode: 0o600 });
      fs.renameSync(`${filePath}.tmp`, filePath);
    },
  };
}

async function request(fetch, method, path, body, authorization) {
  const response = await fetch(`${BASE_URL}/${path}`, {
    method,
    headers: { ...HEADERS, ...(authorization && { Authorization: authorization }) },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  const result = json && typeof json.result === 'object' && json.result ? json.result : {};
  // Cal's own status text (Hebrew, no account data) or the HTTP status. Never the response body.
  const status = `${json?.statusDescription || `HTTP ${response.status}`} (status ${json?.statusCode ?? '?'})`;
  return { ok: json?.statusCode === 1, result, status };
}

/**
 * Logs in. Returns { authorization, cards, method: 'hash' | 'sms' }.
 * @param {{id: string, last4Digits: string}} credentials
 * @param {{read: () => {hash?: string, previous?: string}, write: (hashes: object) => void}} store
 * @param {(info: {attempt: number}) => Promise<string|null>} getCode asks the owner for the SMS code
 */
export async function calAppLogin(credentials, store, getCode, fetch = globalThis.fetch) {
  const stored = store.read();
  let login = null;
  let method = 'hash';
  for (const hash of [stored.hash, stored.previous].filter(Boolean)) {
    const bio = await request(fetch, 'POST', 'login/bioLogin', { hash });
    if (bio.ok && bio.result.calConnectToken) {
      login = bio.result;
      break;
    }
  }
  if (!login) {
    method = 'sms';
    const send = await request(fetch, 'PUT', 'login/sendOTP',
      { custExtId: String(credentials.id).trim().padStart(9, '0'), last4Digits: String(credentials.last4Digits).trim(), smsByVoice: false });
    if (!send.ok || !send.result.token) {
      throw new Error(`Visa Cal: the SMS request failed: ${send.status}`);
    }
    const code = getCode ? await getCode({ attempt: 1 }) : null;
    if (!code) {
      throw new Error('Visa Cal: no SMS code');
    }
    const verify = await request(fetch, 'POST', 'login/verifyOTP',
      { token: send.result.token, password: String(code).trim(), uuid: randomUUID().replaceAll('-', '') });
    if (!verify.ok || !verify.result.calConnectToken) {
      throw new Error(`Visa Cal: the SMS code failed: ${verify.status}`);
    }
    login = verify.result;
  }
  // Store the new hash before any other step: the old one stops working soon.
  if (login.hash && login.hash !== stored.hash) {
    store.write({ hash: login.hash, previous: method === 'hash' ? stored.hash : undefined });
  }
  const authorization = `CALAuthScheme ${String(login.calConnectToken).trim()}`;
  const init = await request(fetch, 'POST', 'account/init',
    login.temporaryGuid ? { tokenGuid: login.temporaryGuid } : {}, authorization);
  if (!init.ok || !Array.isArray(init.result.cards)) {
    throw new Error(`Visa Cal: no card list after login: ${init.status}`);
  }
  const cards = init.result.cards.map(({ cardUniqueId, last4Digits }) => ({ cardUniqueId, last4Digits }));
  return { authorization, cards, method };
}
