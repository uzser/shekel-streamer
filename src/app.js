import fs from 'node:fs';
import path from 'node:path';
import { createScraper, CompanyTypes, SCRAPERS } from 'israeli-bank-scrapers';
import { CronJob } from 'cron';
import { DateTime } from 'luxon';
import retry from 'async-retry';
import puppeteer from 'puppeteer';
import winston from 'winston';

import { cfg, allSettings } from './config.js';
import { createStorage, transactionKey } from './storage.js';
import { sendMessage, askForCode, escapeHtml } from './telegram.js';
import { HapoalimOtpScraper } from './hapoalim-otp.js';
import { VisaCalLoginScraper } from './visa-cal-login.js';
import { redactScraperError } from './redact.js';


const DB_NAME = cfg('DB_NAME', 'shekelStreamer');
const TRANSACTIONS_COLLECTION_NAME = cfg('TRANSACTIONS_COLLECTION_NAME', 'transactions');
const TRANSLATIONS_COLLECTION_NAME = cfg('TRANSLATIONS_COLLECTION_NAME', 'translations');
const SQLITE_PATH = cfg('SQLITE_PATH', 'data/shekel-streamer.db');
const DEFAULT_TIMEZONE = cfg('DEFAULT_TIMEZONE', 'Asia/Jerusalem');
const SYNC_SCHEDULE = cfg('SYNC_SCHEDULE', '0 8 * * *');
const SYNC_ON_STARTUP = cfg('SYNC_ON_STARTUP', 'true');
const SYNC_ON_SCHEDULE = cfg('SYNC_ON_SCHEDULE', 'false');
const LOG_LEVEL = cfg('LOG_LEVEL', 'info');
const TELEGRAM_BOT_TOKEN = cfg('TELEGRAM_BOT_TOKEN');
// Private chat of the owner: error alerts and SMS code requests go there.
const TELEGRAM_OWNER_CHAT_ID = cfg('TELEGRAM_OWNER_CHAT_ID');
const OTP_TIMEOUT_MINUTES = Number(cfg('OTP_TIMEOUT_MINUTES', '10'));
// Persistent browser profiles (one per task). They keep the "known device" state of the bank.
const BROWSER_PROFILES_DIR = cfg('BROWSER_PROFILES_DIR');
// Forward proxy for all outgoing traffic of the browser (egress allowlist), e.g. http://127.0.0.1:8888
const PROXY_SERVER = cfg('PROXY_SERVER');
// URL to call (POST) after a run where all tasks succeeded: a dead man's switch.
const HEALTHCHECK_URL = cfg('HEALTHCHECK_URL');
const OPENAI_API_KEY = cfg('OPENAI_API_KEY');
const GPT_MODEL_FAST = cfg('GPT_MODEL_FAST', 'gpt-4o-mini');

const GPT_TRANSLATION_PROMPT = cfg('GPT_TRANSLATION_PROMPT', 'You are a translation service.\nUse the list of correct translations of some sentences when translating (format: "original text|translation"):\n\nפועלים-|Hapoalim\nאושר עד|Osher Ad\nמוביט|Moovit\n\nPlease provide the translations for each line of text, plain list without original text.\nHere is an example request:\nמסטרקרד\nמסטרקרד\n\nAnd the corresponding response:\nMastercard\nMastercard\n\nNow, translate into English every following line of text, specifically in the Israeli context:\nמסטרקרד\n<text_to_replace>\nRespond in a one-column TSV format.');
const GPT_TRANSLATION_PROMPT_PLACEHOLDER = '<text_to_replace>';

const logger = configureLogger();

logger.info('Starting Shekel Streamer...');

const isTranslationEnabled = OPENAI_API_KEY
  && GPT_TRANSLATION_PROMPT.includes(GPT_TRANSLATION_PROMPT_PLACEHOLDER);

if (!isTranslationEnabled) {
  logger.info(`No OpenAI API key or GPT translation prompt does not include ${GPT_TRANSLATION_PROMPT_PLACEHOLDER}. Translation is disabled.`);
}

let storage;
try {
  storage = await createStorage({
    mongoConnectionString: cfg('MONGO_CONNECTION_STRING'),
    dbName: DB_NAME,
    transactionsCollection: TRANSACTIONS_COLLECTION_NAME,
    translationsCollection: TRANSLATIONS_COLLECTION_NAME,
    sqlitePath: SQLITE_PATH,
  });
  await storage.check();
} catch (error) {
  logger.error('Failed to open the database.', { errorMessage: error.message });
  process.exit(1);
}

// One-time history import (SQLite only). The file is deleted after a successful import.
const IMPORT_FILE = cfg('IMPORT_FILE');
if (IMPORT_FILE && fs.existsSync(IMPORT_FILE)) {
  try {
    const result = await storage.importHistory(JSON.parse(fs.readFileSync(IMPORT_FILE, 'utf8')));
    fs.unlinkSync(IMPORT_FILE);
    logger.info('History import finished.', result);
  } catch (error) {
    logger.error('History import failed. The file stays for the next run.', { errorMessage: error.message });
  }
}

// One-time backfill (SQLite only): {"from": "YYYY-MM-DD", "dryRun": false, "accounts": [...]}.
// The sync starts at "from"; new rows older than the normal sync window are stored without a
// Telegram post. "accounts" (optional): task keys such as "SERGEI_visaCal"; other accounts do a
// normal sync. A dry run only logs counts by month. The file is used once: it is deleted at the
// start, so a failed backfill does not repeat in the daily run (many bank requests).
const BACKFILL_FILE = cfg('BACKFILL_FILE');
let backfill = null;
if (BACKFILL_FILE && fs.existsSync(BACKFILL_FILE)) {
  try {
    const text = fs.readFileSync(BACKFILL_FILE, 'utf8');
    fs.unlinkSync(BACKFILL_FILE);
    const { from, dryRun, accounts } = JSON.parse(text);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      throw new Error('"from" must be a date YYYY-MM-DD');
    }
    if (accounts !== undefined && !(Array.isArray(accounts) && accounts.every(a => typeof a === 'string'))) {
      throw new Error('"accounts" must be a list of task keys, e.g. ["SERGEI_visaCal"]');
    }
    if (!storage.hasNear) {
      throw new Error('backfill needs the SQLite storage');
    }
    backfill = { from: DateTime.fromISO(from, { zone: DEFAULT_TIMEZONE }).toJSDate(), dryRun: dryRun === true, accounts };
    logger.info('Backfill run.', { from, dryRun: backfill.dryRun, accounts: accounts || 'all' });
  } catch (error) {
    logger.error('Backfill file is not valid (deleted). Normal sync.', { errorMessage: error.message });
  }
}

await initializeSyncTasks();

// End of main code

/**
 * Initialize and run transaction synchronization tasks.
 * If SYNC_ON_STARTUP is true, runs tasks on startup.
 * If SYNC_ON_SCHEDULE is true, schedules tasks according to SYNC_SCHEDULE.
 * Without a schedule the process exits after the run: code 0 if all tasks succeeded, else 1.
 *
 * @returns {Promise<void>}
 */
async function initializeSyncTasks() {
  const transactionSyncTasks = getTransactionSyncTasks();
  if (transactionSyncTasks.length === 0) {
    logger.info('No transaction sync tasks found. Exiting.');
    await exit(0);
  }

  const isScheduled = SYNC_ON_SCHEDULE === 'true' && SYNC_SCHEDULE

  // Run sync on startup if it's configured
  if (SYNC_ON_STARTUP === 'true') {
    const allSucceeded = await processTransactionSyncTasks(transactionSyncTasks);
    if (!isScheduled) {
      logger.info('Sync on schedule is disabled. Exiting.');
      await exit(allSucceeded ? 0 : 1);
    }
  } else if (!isScheduled) {
    logger.info('Sync on startup and schedule are disabled. Exiting.');
    await exit(0);
  }

  // Schedule cron job for this user and company if it's configured
  if (isScheduled) {
    const scheduledTask = new CronJob(SYNC_SCHEDULE, async function () {
      try {
        await processTransactionSyncTasks(transactionSyncTasks);
      } catch (error) {
        logger.error(`Sync failed`, { errorMessage: error.message, errorStack: error.stack });
      }
      logger.info(`Next scheduled sync: ${timezoned(this.nextDate())}`);
    }, null, false, DEFAULT_TIMEZONE); // Don't start the job right now

    scheduledTask.start();

    logger.info(`Next scheduled sync: ${timezoned(scheduledTask.nextDate())}`);
  }
}

async function exit(code) {
  try {
    await storage?.close();
  } finally {
    process.exit(code);
  }
}

/**
 * Function to get ISO string with timezone set to DEFAULT_TIMEZONE
 * @param {DateTime} dateTime Luxon DateTime object
 * @returns {string} ISO string with timezone set to DEFAULT_TIMEZONE
 */
function timezoned(dateTime) {
  return dateTime.setZone(DEFAULT_TIMEZONE).toFormat('yyyy-MM-dd\'T\'HH:mm:ssZZ');
}

/**
 * Function to configure logger using Winston
 */
function configureLogger() {
  const transports = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...rest }) =>
          `${timestamp} ${level}: ${typeof message === 'object'
            ? JSON.stringify(message)
            : message}${Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ''}`
        )
      )
    })
  ];

  // Log to files only if not running in Docker because of permission issues with Docker volumes
  // Use Docker logging instead (docker-compose logs -f, for example)
  if (!process.env.DOCKER) {
    transports.push(
      new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
      new winston.transports.File({ filename: 'logs/combined.log' })
    );
  }

  return winston.createLogger({
    level: LOG_LEVEL,
    format: winston.format.combine(
      winston.format.timestamp({
        format: () => timezoned(DateTime.local())
      }),
      winston.format.errors({ stack: true }),
      winston.format((info) => {
        const { timestamp, level, message, ...rest } = info;
        return { timestamp, level, message, ...rest };
      })(),
      winston.format.json({ deterministic: false })
    ),
    transports
  });
}

/**
 * Formats transaction date and removes time if it's 00:00:00
 * @param {string} jsDate
 * @returns The formatted date string in the DEFAULT_TIMEZONE
 */
function formatDateTime(jsDate) {
  let dateTime = DateTime.fromJSDate(jsDate, { zone: 'Asia/Jerusalem' });

  // If time equals 00:00:00, format without time
  if (dateTime.hour === 0 && dateTime.minute === 0 && dateTime.second === 0) {
    return dateTime.toFormat('yyyy-MM-dd');
  }

  // Re-parse the dateTime in the DEFAULT_TIMEZONE
  return dateTime.setZone(DEFAULT_TIMEZONE).toFormat('yyyy-MM-dd HH:mm:ss');
}

/**
 * Function to format transaction for Telegram (HTML parse mode)
 * @param {any} transaction
 * @returns {string} Formatted transaction
 */
function format(transaction) {
  let date = formatDateTime(transaction.date);
  let processedDate = formatDateTime(transaction.processedDate);
  let chargedAmount;

  if (transaction.originalCurrency && transaction.originalCurrency.length == 3)
    chargedAmount = new Intl.NumberFormat('he-IL', { style: 'currency', currency: transaction.originalCurrency }).format(transaction.chargedAmount);
  else
    chargedAmount = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS' }).format(transaction.chargedAmount);


  const incomeOrExpenseEmoji = transaction.chargedAmount > 0 ? '💰' : '💸'; // 💰 for income, 💸 for expense
  let description = transaction.memo ? `${transaction.description} - ${transaction.memo}` : transaction.description;
  const e = escapeHtml;

  return `
Account: <b>${e(transaction.accountNumber)} ${incomeOrExpenseEmoji}</b>
Amount: <b>${e(chargedAmount)}</b>
Description: <b>${e(description)}</b>${transaction.translatedDescription ? `\nDescription (EN): <b>${e(transaction.translatedDescription)}</b>` : ''}
Date: <b>${e(date)}</b>${transaction.identifier ? `\nId: <b>${e(transaction.identifier)}</b>` : ''}

Processed Date: ${e(processedDate)}${transaction.type != 'normal' ? `\nType: <b>${e(transaction.type)}</b>` : ''}
Status: ${e(transaction.status)}
`;
}

/**
 * Function to translate transactions' descriptions using OpenAI Chat Completions API
 * @param {string[]} descriptions
 * @returns {Promise<string[]>} Translated descriptions
 */
async function translateDescriptions(descriptions) {
  logger.debug("Translating descriptions", { descriptions });
  if (!isTranslationEnabled) {
    return descriptions.map(_ => null);
  }

  // Join all descriptions into one string
  const descriptionsString = descriptions.join('\n');

  const request = GPT_TRANSLATION_PROMPT.replace(/\\n/g, '\n').replace(GPT_TRANSLATION_PROMPT_PLACEHOLDER, descriptionsString);

  logger.info("Translation request was sent, count of phrases: " + descriptions.length);
  logger.debug({ request });

  const httpResponse = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: GPT_MODEL_FAST,
      messages: [{ role: 'user', content: request }],
    }),
  });
  const body = await httpResponse.json().catch(() => ({}));
  if (!httpResponse.ok) {
    throw new Error(`OpenAI request failed: ${httpResponse.status} ${body.error?.message || ''}`.trim());
  }
  const responseText = body.choices?.[0]?.message?.content ?? '';

  // Note: response can include extra translanslation in the the beginning. Details are below.
  logger.info("Translation response was received");
  logger.debug({ response: responseText });

  // Split the text into lines and obtain translations from the response in the format:
  // "translate1
  // translate2"
  // Note: The first line of the response corresponds to the translation of the first phrase from the request.
  // This is why the first line is ignored (traslations.slice(1)).
  // This is done to form a list of phrases that can be more clearly understood by the GPT when there is only one phrase.
  let traslations = responseText.trim().split('\n').map(translation => translation.trim());
  if (traslations.length - 1 !== descriptions.length) {
    const errorMessage = `The number of translations (${traslations.length - 1}) does not match the number of descriptions (${descriptions.length})`;
    logger.warn(errorMessage);
    throw new Error(errorMessage);
  }

  return traslations.slice(1);
}


/**
 * Function to get list of translations for given descriptions from cache or OpenAI Chat API
 * @param {any[]} transaction
 * @returns {Promise<string[]>} Translated descriptions
 */
async function getTranslations(transactions) {
  const descriptionsToTranslate = transactions.map(transaction => {
    return transaction.memo ? `${transaction.description} - ${transaction.memo}` : transaction.description;
  });

  let translations = [];
  let uniqueNotCachedDescrs = new Set();
  let cachedTranslations = {};

  logger.debug(`Descriptions to translate: ${descriptionsToTranslate}`);

  for (const description of descriptionsToTranslate) {
    let cachedTranslation = await storage.getTranslation(description);
    if (cachedTranslation) {
      cachedTranslations[description] = cachedTranslation;
    } else {
      uniqueNotCachedDescrs.add(description);
    }
  }

  uniqueNotCachedDescrs = Array.from(uniqueNotCachedDescrs);
  logger.debug("Unique descriptions not found in cache", { uniqueNotCachedDescrs });

  if (uniqueNotCachedDescrs.length > 0) {
    try {
      const newTranslations = await retry(async () => {
        return await translateDescriptions(uniqueNotCachedDescrs);
      }, {
        retries: 5,
        factor: 2,
        minTimeout: 20000,
        randomize: true
      });

      for (let i = 0; i < uniqueNotCachedDescrs.length; i++) {
        await storage.setTranslation(uniqueNotCachedDescrs[i], newTranslations[i]);
        cachedTranslations[uniqueNotCachedDescrs[i]] = newTranslations[i];
      }
    } catch (error) {
      logger.error(`Failed to translate descriptions`,
        { errorMessage: error.message, errorStack: error.stack });
      logger.debug({ descriptions: uniqueNotCachedDescrs });
    }
  }

  // Form a list of translations in the same order as the list of transactions
  translations = descriptionsToTranslate.map(description => cachedTranslations[description]);

  return translations;
}

/**
 * Function to send transaction to Telegram chat with retries
 * @param {any} transaction
 * @param {string} chatId Telegram chat ID
 */
async function notify(transaction, chatId, taskKey) {
  logger.debug(`Sending notification to Telegram`, { taskKey: taskKey });

  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    logger.info('No Telegram bot token or chat ID found. Skipping notification.', { taskKey: taskKey });
    return;
  }

  try {
    await retry(async () => {
      await sendMessage(TELEGRAM_BOT_TOKEN, chatId, format(transaction));
    }, {
      retries: 5,
      minTimeout: 30 * 1000, // 30 seconds
      randomize: true,
    });
  } catch (error) {
    // If the request still fails after all retries, log the error
    logger.error(`Failed to send message to Telegram`,
      { taskKey, errorMessage: error.message });
  }
}

/**
 * Sends a short message to the owner's private chat. Never include transaction data here.
 */
async function notifyOwner(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_OWNER_CHAT_ID) {
    return;
  }
  try {
    await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID, escapeHtml(text));
  } catch (error) {
    logger.error('Failed to send a message to the owner', { errorMessage: error.message });
  }
}

/**
 * Returns a function that asks the owner for an SMS code in Telegram.
 */
function createOtpCodeRetriever(taskKey) {
  return async ({ attempt }) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_OWNER_CHAT_ID) {
      logger.error('The bank asks for an SMS code, but TELEGRAM_OWNER_CHAT_ID is not set', { taskKey });
      return null;
    }
    logger.info('The bank asks for an SMS code. Waiting for the owner in Telegram.', { taskKey, attempt });
    const question = attempt === 1
      ? `🔐 ${taskKey}: the bank sent you an SMS code. Reply here with the code within ${OTP_TIMEOUT_MINUTES} minutes.`
      : `🔐 ${taskKey}: the bank did not accept the code (attempt ${attempt}). Reply with the code again.`;
    const code = await askForCode(TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID, escapeHtml(question), OTP_TIMEOUT_MINUTES * 60 * 1000);
    if (code) {
      await notifyOwner(`${taskKey}: code received, logging in.`);
    } else {
      logger.warn('No SMS code from the owner in time', { taskKey });
    }
    return code;
  };
}

/**
 * Launches a browser for one task. With BROWSER_PROFILES_DIR the profile is kept between runs.
 */
async function launchBrowser(taskKey) {
  const args = [];
  if (process.env.DOCKER === 'true') {
    args.push(
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox",
      "--no-sandbox",
    );
  }
  if (PROXY_SERVER) {
    args.push(`--proxy-server=${PROXY_SERVER}`);
  }
  return puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    userDataDir: BROWSER_PROFILES_DIR ? path.join(BROWSER_PROFILES_DIR, taskKey) : undefined,
    args,
  });
}

/**
 * Function to sync bank transactions, store them and send to Telegram chat
 * @param {string} taskKey Task key for logging
 * @param {string} user User code
 * @param {CompanyTypes} companyId Company ID
 * @param {any} credentials Credentials for the financial service
 * @param {string} chatId Telegram chat ID
 * @returns {Promise<{success: boolean, errorType?: string}>}
 */
async function handleTransactions(taskKey, user, companyId, credentials, chatId) {

  const daysCount = Number(cfg('SYNC_DAYS_COUNT')) || 7;
  const initialSyncDate = new Date(new Date().setDate(new Date().getDate() - daysCount));

  const taskBackfill = backfill && (!backfill.accounts || backfill.accounts.includes(taskKey)) ? backfill : null;
  const startDate = taskBackfill ? taskBackfill.from : initialSyncDate;

  logger.info(`Sync started...`, { taskKey, initialSyncDate: DateTime.fromJSDate(startDate).toISODate() });

  const browser = await launchBrowser(taskKey);
  let syncResult;
  try {
    const scraperOptions = {
      companyId: companyId,
      startDate,
      combineInstallments: false,
      browser,
      skipCloseBrowser: true,
      // Debug only: the screenshot can show account data.
      storeFailureScreenShotPath: cfg('FAILURE_SCREENSHOT_PATH'),
    };

    const scraper = companyId === CompanyTypes.hapoalim
      ? new HapoalimOtpScraper(scraperOptions, createOtpCodeRetriever(taskKey))
      : companyId === CompanyTypes.visaCal
        ? new VisaCalLoginScraper(scraperOptions)
        : createScraper(scraperOptions);

    syncResult = await scraper.scrape(credentials);
    if (scraper.historyNote) {
      logger.info('History limit.', { taskKey, note: redactScraperError(scraper.historyNote).slice(0, 300) });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  if (!syncResult.success) {
    logger.error(`Sync failed`, {
      taskKey,
      errorType: syncResult.errorType,
      errorMessage: redactScraperError(syncResult.errorMessage).slice(0, 300),
    });
    return { success: false, errorType: syncResult.errorType };
  }

  let transactions = [];
  syncResult.accounts.forEach((account) => {
    account.txns.forEach((txn) => {
      transactions.push({
        accountNumber: account.accountNumber,
        date: new Date(txn.date),
        description: txn.description,
        translatedDescription: null, // will be filled later
        memo: txn.memo, // can be null
        originalAmount: txn.originalAmount,
        originalCurrency: currencyToIsoCode(txn.originalCurrency), // can be null, possible wrong value: ILS instead of USD
        chargedAmount: txn.chargedAmount, // possible the same as originalAmount, even if originalCurrency is USD/EUR
        type: txn.type, // normal | installments
        status: txn.status, // completed | pending
        identifier: txn.identifier, // can be null
        processedDate: new Date(txn.processedDate),
        installments: txn.installments, // can be null
        category: txn.category, // can be null
        companyId: companyId,
        userCode: user,
        chatId: chatId
      });
    });
  });

  if (transactions.length === 0) {
    logger.info(`No transactions found.`, { taskKey });
    return { success: true };
  }

  logger.info(`Total transactions found: ${transactions.length}`, { taskKey });

  // Sort transactions by date from oldest to newest
  transactions.sort((a, b) => a.date - b.date)

  if (taskBackfill) {
    // Rows that are in the database (also at a date some hours off) stay as they are.
    const months = {};
    const missing = [];
    for (const transaction of transactions) {
      const month = DateTime.fromJSDate(transaction.date).setZone(DEFAULT_TIMEZONE).toFormat('yyyy-MM');
      months[month] ??= { found: 0, missing: 0 };
      months[month].found++;
      if (!(await storage.hasNear(transaction))) {
        months[month].missing++;
        missing.push(transaction);
      }
    }
    logger.info('Backfill: transactions by month', { taskKey, months });
    if (taskBackfill.dryRun) {
      return { success: true };
    }
    transactions = missing;
  }

  const existingTransactions = await storage.getExistingKeys(transactions);
  logger.debug(`Existing transactions found: ${existingTransactions.size}`, { taskKey });

  // Filter out the transactions that already exist in the db and don't need to be updated
  if (existingTransactions.size > 0) {
    transactions = transactions.filter(transaction => !existingTransactions.has(transactionKey(transaction)));
  }

  let counters = {
    new: 0,
    updated: 0,
    notPosted: 0
  };

  const chunkSize = Number(cfg('GPT_TRANSLATION_COUNT')) || 30;
  let chunkCount = Math.ceil(transactions.length / chunkSize);

  for (let i = 0; i < chunkCount; i++) {

    let currentTransactions = transactions.slice(i * chunkSize, (i + 1) * chunkSize);

    // Create a list of descriptions to translate
    const translations = await getTranslations(currentTransactions);

    // Assign translations back to current transactions
    currentTransactions.forEach((transaction, index) => {
      transaction.translatedDescription = translations[index];
    });

    for (const transaction of currentTransactions) {
      const isNewTransaction = await storage.saveOrUpdate(transaction);

      // Send notification only if transaction is new
      if (isNewTransaction) {
        counters.new++;
        // Backfill: post only the rows of the normal sync window.
        if (!taskBackfill || transaction.date >= initialSyncDate) {
          await notify(transaction, chatId, taskKey);
        } else {
          counters.notPosted++;
        }
      } else {
        counters.updated++;
      }
    }
  }

  logger.info(`Sync finished. New: ${counters.new}, updated: ${counters.updated}`,
    { taskKey, ...(taskBackfill && { notPosted: counters.notPosted }) });
  return { success: true };
}

/**
 * Function to standardize currency symbols to ISO currency codes.
 * @param {string} currency Currency symbol (e.g., ₪, $, €)
 * @returns {string} ISO currency code (e.g., ILS, USD, EUR)
 */
function currencyToIsoCode(currency) {
  return (currency || '').replace('₪', 'ILS').replace('$', 'USD').replace('€', 'EUR');
}

/**
 * Function to find key in object, case insensitive
 * @param {any} object
 * @param {string} targetKey
 * @returns {string} Key of the object that matches the target key, case insensitive
 */
function findKeyCaseInsensitive(object, targetKey) {
  const lowerCaseTargetKey = targetKey.toLowerCase();
  for (const key in object) {
    if (key.toLowerCase() === lowerCaseTargetKey) {
      return key;
    }
  }
  return null;
}

/**
 * Returns transaction synchronization tasks based on settings starting with specific user prefix.
 * @returns {Array} Array of tasks to be executed.
 */
function getTransactionSyncTasksFromEnvVars() {
  const transactionSyncTasks = [];
  const settings = allSettings();

  const users = (settings.USERS || '').split(',').filter(Boolean);
  users.forEach((user) => {
    // Get settings for this user
    const userEnvVars = Object.keys(settings).filter(
      key => key.startsWith(`${user}_`) && !key.startsWith(`${user}_TELEGRAM`)
    );

    // Get unique company names from user's settings
    const companies = [...new Set(userEnvVars.map(key => key.split('_')[1]))];

    companies.forEach((company) => {
      const credentials = {
        id: settings[`${user}_${company}_ID`],
        num: settings[`${user}_${company}_NUM`],
        username: settings[`${user}_${company}_USERNAME`],
        userCode: settings[`${user}_${company}_USER_CODE`],
        password: settings[`${user}_${company}_PASSWORD`],
        card6Digits: settings[`${user}_${company}_CARD6DIGITS`],
        nationalID: settings[`${user}_${company}_NATIONAL_ID`],
      };

      const chatId = settings[`${user}_${company}_TELEGRAM_CHANNEL_ID`] || settings[`${user}_TELEGRAM_CHANNEL_ID`];

      // Get CompanyTypes key from config company name
      const companyTypeKey = findKeyCaseInsensitive(CompanyTypes, company);
      if (!companyTypeKey) {
        logger.error(`Unknown company: ${company}`);
        return;
      }
      const companyId = CompanyTypes[companyTypeKey];
      const taskKey = user + '_' + companyId;

      // Push the flat task object into the array
      transactionSyncTasks.push({
        taskKey,
        user,
        companyId,
        credentials,
        chatId
      });
    });
  });

  return transactionSyncTasks;
}

/**
 * Returns transaction synchronization tasks based on the USERS_JSON structure.
 * @param {string|any[]} usersJson JSON string or already parsed array
 * @returns {Array} Array of tasks to be executed.
 */
function getTransactionSyncTasksFromJSON(usersJson) {
  const transactionSyncTasks = [];

  let credentialsData;
  try {
    credentialsData = typeof usersJson === 'string' ? JSON.parse(usersJson) : usersJson;
  } catch (e) {
    logger.error('Failed to parse USERS_JSON. Please ensure it is valid JSON.');
    return transactionSyncTasks;
  }

  if (!Array.isArray(credentialsData)) {
    logger.error('USERS_JSON should be an array of user credentials.');
    return transactionSyncTasks;
  }

  credentialsData.forEach((user, userIndex) => {
    const { userName, telegramChannelId, companies } = user;

    if (!userName || !Array.isArray(companies)) {
      logger.error(`Invalid user entry. Expected "userName", and "companies" properties. Check user #${userIndex} (index starts from 0).`);
      return;
    }

    if (!telegramChannelId) {
      logger.warn(`No telegramChannelId specified for user #${userIndex} (index starts from 0). Notifications will not be sent.`);
    }

    companies.forEach((company, companyIndex) => {
      const { companyName, telegramChannelId: companyTelegramChannelId, ...credentials } = company; //
      const chatId = companyTelegramChannelId || telegramChannelId;

      // Get CompanyTypes key from config company name
      const companyTypeKey = findKeyCaseInsensitive(CompanyTypes, companyName);
      if (!companyTypeKey) {
        logger.error(`Unknown company. Check user #${userIndex}, company #${companyIndex} (index starts from 0)`);
        return;
      }

      const scraper = SCRAPERS[companyTypeKey];
      if (!scraper) {
        logger.error(`No scraper found for company. Check user #${userIndex}, company #${companyIndex} (index starts from 0)`);
        return;
      }

      const missingFields = scraper.loginFields.filter(field => !credentials.hasOwnProperty(field));
      if (missingFields.length > 0) {
        logger.error(`Missing required fields for company. Check user #${userIndex}, company #${companyIndex} (index starts from 0): Missing fields: ${missingFields.join(', ')}`);
        return;
      }

      const companyId = CompanyTypes[companyTypeKey];
      // Stable key: it names the persistent browser profile of this login.
      const taskKey = `${userName}_${companyId}`;

      // Push the flat task object into the array
      transactionSyncTasks.push({
        taskKey,
        user: userName,
        companyId,
        credentials,
        chatId
      });
    });
  });

  return transactionSyncTasks;
}

/**
 * Converts the flat `accounts` list of the config file (Home Assistant add-on options) into the
 * USERS_JSON structure. Each account is one login: { company, user_name, telegram_channel_id,
 * user_code, password, id, card6digits, username, num, national_id }.
 */
function accountsToUsersJson(accounts) {
  const fieldNames = {
    user_code: 'userCode', password: 'password', id: 'id', card6digits: 'card6Digits',
    username: 'username', num: 'num', national_id: 'nationalID',
  };
  return accounts.map(account => {
    const company = { companyName: account.company };
    for (const [optionName, credentialName] of Object.entries(fieldNames)) {
      if (account[optionName]) {
        company[credentialName] = String(account[optionName]);
      }
    }
    return {
      userName: account.user_name,
      telegramChannelId: account.telegram_channel_id,
      companies: [company],
    };
  });
}

/**
 * Returns transaction synchronization tasks.
 * @returns {Array} Array of tasks to be executed.
 */
function getTransactionSyncTasks() {
  const accounts = cfg('ACCOUNTS');
  if (Array.isArray(accounts)) {
    return getTransactionSyncTasksFromJSON(accountsToUsersJson(accounts));
  }
  const usersJson = cfg('USERS_JSON');
  if (usersJson) {
    return getTransactionSyncTasksFromJSON(usersJson);
  }
  return getTransactionSyncTasksFromEnvVars();
}

/**
 * Processes the given transaction sync tasks sequentially.
 * Alerts the owner about failed tasks and calls HEALTHCHECK_URL when all tasks succeeded.
 * @returns {Promise<boolean>} true if all tasks succeeded
 */
async function processTransactionSyncTasks(transactionSyncTasks) {
  const failed = [];
  for (const task of transactionSyncTasks) {
    try {
      const result = await handleTransactions(task.taskKey, task.user, task.companyId, task.credentials, task.chatId);
      if (!result.success) {
        failed.push(`${task.taskKey} (${result.errorType || 'unknown error'})`);
      }
    } catch (error) {
      logger.error(`Sync failed`, {
        taskKey: task.taskKey,
        errorMessage: redactScraperError(error.message),
        errorStack: redactScraperError(error.stack),
      });
      failed.push(`${task.taskKey} (exception)`);
    }
  }

  if (failed.length > 0) {
    await notifyOwner(`⚠️ shekel-streamer: sync failed for ${failed.join(', ')}. See the logs.`);
    return false;
  }

  if (backfill) {
    logger.info('Backfill finished.', { dryRun: backfill.dryRun });
    backfill = null;
  }

  if (HEALTHCHECK_URL) {
    try {
      await fetch(HEALTHCHECK_URL, { method: 'POST' });
    } catch (error) {
      logger.warn('Healthcheck call failed', { errorMessage: error.message });
    }
  }
  return true;
}
