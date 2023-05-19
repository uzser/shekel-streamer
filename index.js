import dotenv from 'dotenv';
dotenv.config();

import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import { MongoClient } from 'mongodb';
import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';
import moment from 'moment-timezone';
import { ChatGPTAPI } from 'chatgpt';
import retry from 'async-retry';

/**
 * Function to format transaction for Telegram
 * @param {any} transaction 
 * @returns {string} Formatted transaction
 */
function format(transaction) {
  let date = moment(transaction.date).tz("Asia/Jerusalem");
  let processedDate = moment(transaction.processedDate).tz("Asia/Jerusalem");

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

  if (!process.env.OPENAI_API_KEY || !process.env.GPT_MODEL_FAST || !process.env.GPT_TRANSLATION_PROMPT
    || !process.env.GPT_TRANSLATION_PROMPT.includes(placeholder)) {
    console.log('No OpenAI API key or GPT model or GPT translation prompt found. Skipping translation.');
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
  const description = descriptions.join('\n');

  const prompt = process.env.GPT_TRANSLATION_PROMPT.replace(/\\n/g, '\n').replace(placeholder, description);
  const response = await api.sendMessage(prompt)

  console.log(`Request:\n${prompt}\n\nResponse:\n${response.text}\n`);

  // Split the text into lines and obtain translations from the response in the format:
  // "translate1
  // translate2"
  // Note: The first line of the response corresponds to the translation of the first phrase from the request.
  // This is why the first line is ignored (traslations.slice(1)).
  // This is done to form a list of phrases that can be more clearly understood by the GPT when there is only one phrase.
  let traslations = response.text.split('\n');
  if (traslations.length !== descriptions.length + 1) {
    throw new Error(`Number of translations (${traslations.length}) does not match number of descriptions (${descriptions.length})`);
  }

  return traslations.slice(1);
}

/**
 * Function to get list of translations for given descriptions
 * @param {any[]} transaction
 * @returns {Promise<string[]>} Translated descriptions
 */
async function getTranslations(transactions) {
  let descriptionsToTranslate = [];
  transactions.forEach((transaction) => {
    let description = transaction.memo ? `${transaction.description} - ${transaction.memo}` : transaction.description;
    descriptionsToTranslate.push(description);
  });

  try {
    // Fetch translations in bulk
    const translations = await retry(async () => {
      return await translateDescriptions(descriptionsToTranslate);
    }, {
      retries: 5,
      factor: 2,
      minTimeout: 20000,
      randomize: true
    });

    return translations;
  } catch (err) {
    // If the request still fails after all retries, log the error
    console.error(`Failed to translate descriptions: ${err}`);
  }
}

/**
 * Function to get existing transactions from db (by date, chargedAmount, description, processedDate, status and translatedDescription)
 * @param {any} transactions 
 * @returns {Promise<any[]>} Set of transaction keys (date+chargedAmount+description+processedDate+status)
 */
async function getExistingTransactions(transactions) {
  const client = new MongoClient(process.env.MONGO_CONNECTION_STRING);
  try {
    await client.connect();
    const database = client.db("transactionsDB");
    const transCollection = database.collection("transactions");

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
    const database = client.db("transactionsDB");
    const transCollection = database.collection("transactions");

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
 * @param {string} chatId
 */
async function notify(transaction, chatId) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) {
    console.log('No Telegram bot token or chat ID found. Skipping notification.');
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
  } catch (err) {
    // If the request still fails after all retries, log the error
    console.error(`Failed to send message to Telegram: ${err}`);
  }
}

/**
 * Function to scrape bank transactions, store to MongoDB and send to Telegram chat
 * @param {string} user
 * @param {CompanyTypes} companyId
 * @param {any} credentials
 * @param {string} chatId
 */
async function handleTransactions(user, companyId, credentials, chatId, startDate) {
  const scraper = createScraper({
    companyId: companyId,
    startDate: startDate,
    combineInstallments: false,
    timeout: 0 // no timeout
  });

  const scrapeResult = await scraper.scrape(credentials);

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
          companyId: companyId,
          userCode: user,
          chatId: chatId
        });
      });
    });

    // Sort transactions by date from oldest to newest
    transactions.sort((a, b) => a.date - b.date)

    const existingTransactions = await getExistingTransactions(transactions);

    // Filter out the transactions that already exist in the db and don't need to be updated
    transactions = transactions.filter(transaction => {
      const key = transaction.date + transaction.chargedAmount + transaction.description + transaction.processedDate + transaction.status;
      return !existingTransactions.has(key);
    });

    const chunkSize = 20; // to not exceed token limit in OpenAI Chat API while translating
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
        const isNewTransaction = !!await saveOrUpdate(transaction);
        // Send notification only if transaction is new
        if (isNewTransaction) {
          await notify(transaction, chatId);
        }
      }
    }
  } else {
    console.error(`Scraping failed for the following reason: ${scrapeResult.errorType} - ${scrapeResult.errorMessage}`);
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
      console.error(`Unknown company: ${company}`);
      return;
    }

    // a week ago
    let startDate = new Date(new Date().setDate(new Date().getDate() - 7));
    // a month ago
    // let startDate = new Date(new Date().setMonth(new Date().getMonth() - 1));
    // a year ago
    // let startDate = new Date(new Date().setFullYear(new Date().getFullYear() - 1));

    handleTransactions(user, CompanyTypes[companyTypeKey], credentials, chatId, startDate);

    cron.schedule(process.env.TRANSACTION_SYNC_SCHEDULE, () => {
      handleTransactions(user, CompanyTypes[companyTypeKey], credentials, chatId, startDate);
    }, {
      timezone: 'Asia/Jerusalem'
    });
  });
});
