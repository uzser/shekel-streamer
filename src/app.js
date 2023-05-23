import dotenv from 'dotenv';
dotenv.config();

import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import { MongoClient } from 'mongodb';
import TelegramBot from 'node-telegram-bot-api';
import { CronJob } from 'cron';
import moment from 'moment-timezone';
import { ChatGPTAPI } from 'chatgpt';
import retry from 'async-retry';
import puppeteer from 'puppeteer';
import winston from 'winston';


const DB_NAME = process.env.DB_NAME || 'shekelStreamerDB';
const TRANSACTIONS_COLLECTION_NAME = process.env.TRANSACTIONS_COLLECTION_NAME || 'transactions';
const TRANSLATIONS_COLLECTION_NAME = process.env.TRANSLATIONS_COLLECTION_NAME || 'translations';
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Jerusalem';

configureLogger();

logger.info('Starting Shekel Streamer...');

const isTrnaslationEnabled = process.env.OPENAI_API_KEY && process.env.GPT_MODEL_FAST
  && process.env.GPT_TRANSLATION_PROMPT && process.env.GPT_TRANSLATION_PROMPT.includes('<text_to_replace>');

if (!isTrnaslationEnabled) {
  logger.info('No OpenAI API key or GPT model or GPT translation prompt found. Translation is disabled.');
}

/**
 * Function to configure logger using Winston
 */
function configureLogger() {
  const transports = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(info => {
          const { timestamp, level, message, ...rest } = info;
          return `${timestamp} ${level}: ${message}${(Object.keys(rest).length > 0) ? ' ' + JSON.stringify(rest) : ''}`
        })
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

  const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp({
        format: 'YYYY-MM-DDTHH:mm:ss'
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
 * Function to format transaction for Telegram
 * @param {any} transaction 
 * @returns {string} Formatted transaction
 */
function format(transaction) {
  let date = moment(transaction.date).tz(DEFAULT_TIMEZONE);
  let processedDate = moment(transaction.processedDate).tz(DEFAULT_TIMEZONE);

  // If time equals 00:00:00, format without time
  date = date.format('HH:mm:ss') === '00:00:00' ? date.format('YYYY-MM-DD') : date.format('YYYY-MM-DD HH:mm:ss');
  processedDate = processedDate.format('HH:mm:ss') === '00:00:00' ? processedDate.format('YYYY-MM-DD') : processedDate.format('YYYY-MM-DD HH:mm:ss');

  const chargedAmount = new Intl.NumberFormat('he-IL', { style: 'currency', currency: transaction.originalCurrency }).format(transaction.chargedAmount);
  const incomeOrExpenseEmoji = transaction.chargedAmount > 0 ? '💰' : '💸'; // 💰 for income, 💸 for expense
  let description = transaction.memo ? `${transaction.description} - ${transaction.memo}` : transaction.description;

  return `
Acccount: *${transaction.accountNumber} ${incomeOrExpenseEmoji}*
Amount: *${chargedAmount}*
Description: *${description}*${transaction.translatedDescription ? `\nDescription (EN): *${transaction.translatedDescription}*` : ''}
Date: *${date}*${transaction.identifier ? `\nId: *${transaction.identifier}*` : ''}

Processed Date: ${processedDate}
Type: ${transaction.type}
Status: ${transaction.status}
`;
}

/**
 * Function to translate transactions' descriptions using OpenAI Chat API
 * @param {string[]} descriptions
 * @returns {Promise<string[]>} Translated descriptions
 */
async function translateDescriptions(descriptions) {
  const placeholder = '<text_to_replace>';

  if (!isTrnaslationEnabled) {
    return descriptions.map(_ => null);
  }

  const api = new ChatGPTAPI({
    apiKey: process.env.OPENAI_API_KEY,
    completionParams: {
      model: process.env.GPT_MODEL_FAST,
      temperature: 0.2 // for stable results
    }
  });

  // Join all descriptions into one string
  const descriptionsString = descriptions.join('\n');

  const request = process.env.GPT_TRANSLATION_PROMPT.replace(/\\n/g, '\n').replace(placeholder, descriptionsString);
  const response = await api.sendMessage(request)

  logger.info("Translation result was received", { request: descriptionsString, response: response.text });

  // Split the text into lines and obtain translations from the response in the format:
  // "translate1
  // translate2"
  // Note: The first line of the response corresponds to the translation of the first phrase from the request.
  // This is why the first line is ignored (traslations.slice(1)).
  // This is done to form a list of phrases that can be more clearly understood by the GPT when there is only one phrase.
  let traslations = response.text.split('\n').map(translation => translation.trim());
  if (traslations.length !== descriptions.length + 1) {
    const errorMessage = `Number of translations (${traslations.length}) does not match number of descriptions (${descriptions.length})`;
    logger.warn(errorMessage, { descriptions, traslations });
    throw new Error(errorMessage);
  }

  return traslations.slice(1);
}

/**
 * Function to put translation to cache
 * @param {string} description
 * @param {string} translation
 */
async function setTranslationToCache(description, translation) {
  const client = new MongoClient(process.env.MONGO_CONNECTION_STRING);
  try {
    await client.connect();
    const database = client.db(DB_NAME);
    const translations = database.collection(TRANSLATIONS_COLLECTION_NAME);

    try {
      await translations.insertOne({ _id: description, translation: translation });
    } catch (error) {
      if (error.code !== 11000) { // Ignore duplicate key error
        throw error;
      }
    }
  } finally {
    await client.close();
  }
}

/**
 * Function to get translation from cache
 * @param {string} description
 * @returns {Promise<string>} Cached translation
 */
async function getTranslationFromCache(description) {
  const client = new MongoClient(process.env.MONGO_CONNECTION_STRING);
  try {
    await client.connect();
    const database = client.db(DB_NAME);
    const translations = database.collection(TRANSLATIONS_COLLECTION_NAME);
    const doc = await translations.findOne({ _id: description });
    return doc ? doc.translation : null;
  } finally {
    await client.close();
  }
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

  for (const description of descriptionsToTranslate) {
    let cachedTranslation = await getTranslationFromCache(description);
    if (cachedTranslation) {
      cachedTranslations[description] = cachedTranslation;
    } else {
      uniqueNotCachedDescrs.add(description);
    }
  }

  uniqueNotCachedDescrs = Array.from(uniqueNotCachedDescrs);

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
        await setTranslationToCache(uniqueNotCachedDescrs[i], newTranslations[i]);
        cachedTranslations[uniqueNotCachedDescrs[i]] = newTranslations[i];
      }
    } catch (error) {
      logger.error(`Failed to translate descriptions`,
        { descriptions: uniqueNotCachedDescrs, errorMessage: error.message, errorStack: error.stack });
    }
  }

  // Form a list of translations in the same order as the list of transactions
  translations = descriptionsToTranslate.map(description => cachedTranslations[description]);

  return translations;
}


/**
 * Function to get existing transactions from db (by date, chargedAmount, description, processedDate, status and translatedDescription)
 * @param {any} transactions 
 * @returns {Promise<any[]>} Set of transaction keys (date+chargedAmount+description+processedDate+status)
 */
async function getExistingTransactions(transactions) {
  const client = new MongoClient(process.env.MONGO_CONNECTION_STRING);
  if (transactions.length === 0) {
    return new Set();
  }

  try {
    await client.connect();
    const database = client.db(DB_NAME);
    const transCollection = database.collection(TRANSACTIONS_COLLECTION_NAME);

    const query = {
      $or: transactions.map(transaction => ({
        date: transaction.date,
        chargedAmount: transaction.chargedAmount,
        description: transaction.description,

        // following fields will update if transaction already exists, so we need to check them too
        processedDate: transaction.processedDate,
        status: transaction.status,
        translatedDescription: { $not: { $eq: null } }
      }))
    };

    const cursor = transCollection.find(query);
    const existingTransactions = new Set();

    for await (const doc of cursor) {
      existingTransactions.add(doc.date + doc.chargedAmount + doc.description + doc.processedDate + doc.status);
    }

    return existingTransactions;

  } finally {
    await client.close();
  }
}

/**
 * Function to save or update transaction in db
 * @param {any} transaction 
 * @returns {Promise<boolean>} true if transaction was inserted, false if transaction already exists
 */
async function saveOrUpdate(transaction) {
  const client = new MongoClient(process.env.MONGO_CONNECTION_STRING);
  try {
    await client.connect();
    const database = client.db(DB_NAME);
    const transCollection = database.collection(TRANSACTIONS_COLLECTION_NAME);

    // Check if transaction already exists
    const existingTransaction = await transCollection.findOne({
      date: transaction.date,
      chargedAmount: transaction.chargedAmount,
      description: transaction.description
    });

    if (existingTransaction) {
      // Transaction exists, update it
      await transCollection.updateOne(
        {
          date: transaction.date,
          chargedAmount: transaction.chargedAmount,
          description: transaction.description
        },
        {
          $set: transaction,
          $currentDate: { updatedAt: true } // Add or update a updatedAt field with the current date
        }
      );

      return false;
    } else {
      transaction.createdAt = new Date(); // Add a createdAt field with the current date
      await transCollection.insertOne(transaction);

      return true;
    }
  } finally {
    await client.close();
  }
}

/**
 * Function to send transaction to Telegram chat with retries
 * @param {any} transaction
 * @param {string} chatId Telegram chat ID
 */
async function notify(transaction, chatId) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) {
    logger.info('No Telegram bot token or chat ID found. Skipping notification.');
    return;
  }

  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

  try {
    await retry(async () => {
      await bot.sendMessage(chatId, format(transaction), { parse_mode: 'Markdown' });
    }, {
      retries: 5,
      minTimeout: 30 * 1000, // 30 seconds
      randomize: true,
    });
  } catch (error) {
    // If the request still fails after all retries, log the error
    logger.error(`Failed to send message to Telegram`,
      { transactionDbId: transaction._id, chatId, errorMessage: error.message, errorStack: error.stack });
  }
}

/**
 * Function to scrape bank transactions, store to MongoDB and send to Telegram chat
 * @param {any} taskDetails { user: string, company: CompanyTypes }
 * @param {any} credentials Credentials for the financial service
 * @param {string} chatId Telegram chat ID
 */
async function handleTransactions(taskDetails, credentials, chatId) {

  const daysCount = Number(process.env.SCRAPING_DAYS_COUNT) || 7;
  const initialScrapeDate = new Date(new Date().setDate(new Date().getDate() - daysCount));

  logger.info(`Scraping started...`, { ...taskDetails, initialScrapeDate });

  let scraperOptions = {
    companyId: taskDetails.company,
    startDate: initialScrapeDate,
    combineInstallments: false,
    timeout: 0, // no timeout
  }

  if (process.env.DOCKER) {
    scraperOptions.browser = await puppeteer.launch({
      headless: "new",
      executablePath: '/usr/bin/chromium-browser',
      args: [
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-setuid-sandbox",
        "--no-sandbox",
      ]
    })
  }

  const scrapeResult = await createScraper(scraperOptions).scrape(credentials);

  if (scrapeResult.success) {
    let transactions = [];
    scrapeResult.accounts.forEach((account) => {
      account.txns.forEach((txn) => {
        transactions.push({
          accountNumber: account.accountNumber,
          date: new Date(txn.date),
          description: txn.description,
          translatedDescription: null, // will be filled later
          memo: txn.memo, // can be null
          originalAmount: txn.originalAmount,
          originalCurrency: txn.originalCurrency, // possible wrong value: ILS instead of USD
          chargedAmount: txn.chargedAmount, // possible the same as originalAmount, even if originalCurrency is USD/EUR
          type: txn.type,
          status: txn.status,
          identifier: txn.identifier, // can be null
          processedDate: new Date(txn.processedDate),
          installments: txn.installments, // can be null
          companyId: taskDetails.company,
          userCode: taskDetails.user,
          chatId: chatId
        });
      });
    });

    if (transactions.length === 0) {
      logger.info(`No transactions found.`, taskDetails);
      return;
    }

    logger.info(`Total transactions found: ${transactions.length}`, taskDetails);

    // Sort transactions by date from oldest to newest
    transactions.sort((a, b) => a.date - b.date)

    const existingTransactions = await getExistingTransactions(transactions);

    // Filter out the transactions that already exist in the db and don't need to be updated
    if (existingTransactions.size > 0) {
      transactions = existingTransactions.size > 0 ? transactions.filter(transaction => {
        const key = transaction.date + transaction.chargedAmount + transaction.description + transaction.processedDate + transaction.status;
        return !existingTransactions.has(key);
      }) : transactions;
    }

    let counters = {
      new: 0,
      updated: 0
    };

    const chunkSize = 30; // to not exceed token limit in OpenAI Chat API while translating
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
        const isNewTransaction = await saveOrUpdate(transaction);

        // Send notification only if transaction is new
        if (isNewTransaction) {
          counters.new++;
          await notify(transaction, chatId);
        } else {
          counters.updated++;
        }
      }
    }

    logger.info(`Scraping finished. New: ${counters.new}, updated: ${counters.updated}`, taskDetails);
  } else {
    logger.error(`Scraping failed`,
      { ...taskDetails, errorType: scrapeResult.errorType, errorMessage: scrapeResult.errorMessage });
  }
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

const users = process.env.USERS.split(',');

// For each user, scrape their transactions
users.forEach((user) => {
  // Get environment variables for this user
  const userEnvVars = Object.keys(process.env).filter(
    key => key.startsWith(`${user}_`) && !key.startsWith(`${user}_TELEGRAM`));

  // Get unique company names from user's environment variables
  const companies = [...new Set(userEnvVars.map(key => key.split('_')[1]))];

  companies.forEach((company) => {
    const credentials = {
      id: process.env[`${user}_${company}_ID`],
      num: process.env[`${user}_${company}_NUM`],
      username: process.env[`${user}_${company}_USERNAME`],
      userCode: process.env[`${user}_${company}_USER_CODE`],
      password: process.env[`${user}_${company}_PASSWORD`],
      card6Digits: process.env[`${user}_${company}_CARD6DIGITS`],
      nationalID: process.env[`${user}_${company}_NATIONAL_ID`],
    };

    const chatId = process.env[`${user}_${company}_TELEGRAM_CHANNEL_ID`] || process.env[`${user}_TELEGRAM_CHANNEL_ID`];

    // Get CompanyTypes key from config company name
    const companyTypeKey = findKeyCaseInsensitive(CompanyTypes, company);
    if (!companyTypeKey) {
      logger.error(`Unknown company: ${company}`);
      return;
    }

    const taskDetails = { user, company: CompanyTypes[companyTypeKey] };

    // Handle transactions for this user
    handleTransactions(taskDetails, credentials, chatId)
      .catch((error) => logger.error(`Scraping failed`, { ...taskDetails, errorMessage: error.message, errorStack: error.stack }));

    // Schedule cron job for this user
    const scheduledTask = new CronJob(process.env.TRANSACTION_SYNC_SCHEDULE, async function () {
      try {
        await handleTransactions(taskDetails, credentials, chatId);
      } catch (error) {
        logger.error(`Scraping failed`, { ...taskDetails, errorMessage: error.message, errorStack: error.stack });
      }
      logger.info(`Next scheduled run: ${this.nextDate()}`, { taskDetails });
    }, null, false, DEFAULT_TIMEZONE); // Don't start the job right now

    scheduledTask.start();
    logger.info(`Next scheduled: ${scheduledTask.nextDate()}`, taskDetails);
  });
});
