# Shekel Streamer — Home Assistant add-on

Scrapes your Israeli bank and card accounts once per start, stores the transactions in SQLite
(`/data/db`), translates descriptions with OpenAI (optional) and posts each new transaction to a
Telegram channel. The add-on exits after the run. Start it from an automation, for example daily:

```yaml
triggers:
  - trigger: time
    at: "08:00:00"
actions:
  - action: hassio.addon_start
    data:
      addon: <repository id>_shekel_streamer
```

## Options

- `telegram_bot_token`: token of your bot (from @BotFather).
- `telegram_owner_chat_id`: your private chat with the bot. Error alerts and SMS code requests go
  there. Send `/start` to the bot once.
- `accounts`: one entry per login. `company` (e.g. `hapoalim`), `user_name` (a short name; it
  also names the browser profile), `telegram_channel_id` (where transactions go) and the
  credential fields that the company needs (Hapoalim: `user_code`, `password`; Isracard and
  Amex: `id`, `card6digits` and the fixed password `password`; Visa Cal: `username`,
  `password`). The scrapers log in with a password only, not with a one-time code.
- `openai_api_key`, `gpt_model_fast`: optional translation.
- `healthcheck_url`: optional; called (POST) after a run where all accounts succeeded. Use an HA
  webhook to detect days without a successful run: `http://homeassistant:8123/api/webhook/<id>`.
  Other hosts need `allowed_domains` and port 443.
- `allowed_domains`: extra host name patterns (extended regex) for the egress allowlist, needed
  for companies other than Hapoalim, e.g. `(^|\.)isracard\.co\.il$`.

## Bank Hapoalim SMS code

On a new device Bank Hapoalim asks for an SMS code. The bot writes to your private chat; reply
with the code within `otp_timeout_minutes` (default 10). The browser profile in `/data/profiles`
keeps the device known, so the bank asks again only when that trust expires.

## Import an old history

Put `history-import.json` (format `shekel-streamer-history-v1`: `transactions` = the documents
of the old MongoDB collection with ISO dates, `translations` = `{description, translation}`)
into the add-on config folder (`/addon_configs/<repository id>_shekel_streamer/`, e.g. with
File editor) and start the add-on. It imports rows that are not in the database yet, sends
nothing to Telegram and deletes the file.

## Load older transactions (backfill)

Put `backfill.json` into the same folder and start the add-on:

```json
{ "from": "2025-01-01", "dryRun": true, "accounts": ["SERGEI_visaCal"] }
```

- `accounts` (optional): the accounts to backfill, as `<user_name>_<company>`. Other accounts do
  a normal sync. Without `accounts`, all accounts are backfilled.
- The sync starts at `from`. Bank Hapoalim: the add-on asks month by month with a 10 s pause
  (the bank returns at most 150 rows per request and blocks fast requests). The bank gives data
  for about 3 years back. Visa Cal: the add-on asks in windows of 1.5 years, one request at a
  time with a 3 s pause; an older window that fails or has no rows ends the history (log line
  "History limit.").
- Rows that are already in the database stay as they are (also when the date is some hours off,
  as in an old history).
- New rows older than `sync_days_count` days are stored without a Telegram post.
- `dryRun: true` only logs the counts by month (found, missing).
- The file is used once: the add-on deletes it at the start. To try again, put it there again.

## Database copy for analysis

At the end of each run the add-on writes a copy of its database to
`/addon_configs/<repository id>_shekel_streamer/export/shekel.sqlite` (SQLite, replaced each
run). Read it with File editor, File Browser or Samba and open it with any SQLite tool. Tables:
`transactions` (one row per transaction; column `doc` holds all fields as JSON) and
`translations`. The copy has no passwords or tokens (they are add-on options, not in the
database), but it has your full transaction history: everybody who can open the add-on config
folder can read it.

## Security model

- Secrets are add-on options (password fields). The app reads them from a tmpfs copy that it
  deletes after reading; they are never environment variables.
- No ports, no ingress, no Home Assistant or Supervisor API.
- Egress firewall: inside the add-on only the proxy (tinyproxy) may connect out, and it allows
  only the bank host names, `api.telegram.org`, `api.openai.com` and `homeassistant`. Only the
  proxy may use DNS. A compromised dependency cannot send your passwords anywhere else.
- Logs (level `info`) contain counts and error types, not transaction data.
