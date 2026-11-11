// Minimal Telegram Bot API client on top of fetch (no third-party dependency).

const API = 'https://api.telegram.org';

async function call(token, method, params) {
  const response = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const body = await response.json().catch(() => ({}));
  if (!body.ok) {
    // Never include the URL in the error: it contains the token.
    throw new Error(`Telegram ${method} failed: ${response.status} ${body.description || ''}`.trim());
  }
  return body.result;
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function sendMessage(token, chatId, html) {
  return call(token, 'sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

/**
 * Asks the owner for a one-time code and waits for the reply in the same private chat.
 * Only messages from `chatId` count. Returns the digits, or null after the timeout.
 */
export async function askForCode(token, chatId, question, timeoutMs) {
  // Skip updates that came before the question.
  const old = await call(token, 'getUpdates', { offset: -1, timeout: 0 });
  let offset = old.length ? old[old.length - 1].update_id + 1 : 0;

  await sendMessage(token, chatId, question);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waitSeconds = Math.max(1, Math.min(30, Math.floor((deadline - Date.now()) / 1000)));
    const updates = await call(token, 'getUpdates', {
      offset,
      timeout: waitSeconds,
      allowed_updates: ['message'],
    });
    for (const update of updates) {
      offset = update.update_id + 1;
      const message = update.message;
      if (!message || String(message.chat?.id) !== String(chatId)) {
        continue;
      }
      const digits = (message.text || '').replace(/\s+/g, '');
      if (/^\d{4,10}$/.test(digits)) {
        // Confirm the offset so the code is not read again on the next run.
        await call(token, 'getUpdates', { offset, timeout: 0 });
        return digits;
      }
    }
  }
  return null;
}
