import dotenv from 'dotenv';
dotenv.config();

import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import { MongoClient } from 'mongodb';
import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';
import moment from 'moment-timezone';
import { ChatGPTAPI } from 'chatgpt';
import retry from 'async-retry';

// Function to format transaction for Telegram
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

// Function to translate transaction's description
async function translateDescription(description) {
  const api = new ChatGPTAPI({
    apiKey: process.env.OPENAI_API_KEY,
    completionParams: {
      model: process.env.GPT_MODEL_FAST,
      temperature: 0.2 // for stable results
    }
  });

  const request = process.env.GPT_TRANSLATION_REQUEST.replace(/\\n/g, '\n').replace('<text_to_replace>', description);
  const response = await api.sendMessage(request)
  console.log(`Translation response:\n${response.text}`);

  // Split the text into lines and obtain translations from the response in the format:
  // "translate1
  // translate2"
  // Note: The first line of the response corresponds to the translation of the first phrase from the request.
  // This is why we start the index from [1].
  // This is done to form a list of phrases that can be more clearly understood by the GPT.
  let traslations = response.text.split('\n');
  return traslations[1];
}

// Function to check if transaction already exists in db
async function transactionExists(transaction) {
  const client = new MongoClient(process.env.MONGO_CONNECTION_STRING);
  try {
    await client.connect();
    const database = client.db("transactionsDB");
    const transactions = database.collection("transactions");
    // Check if transaction already exists in database
    const existingTransaction = await transactions.findOne({
      date: transaction.date,
      chargedAmount: transaction.chargedAmount,
      description: transaction.description
    });
    return !!existingTransaction;
  } finally {
    await client.close();
  }
}

async function save(transaction) {
  const client = new MongoClient(process.env.MONGO_CONNECTION_STRING);
  try {
    await client.connect();
    const database = client.db("transactionsDB");
    const transactions = database.collection("transactions");
    await transactions.insertOne(transaction);
  } finally {
    await client.close();
  }
}

function notify(transaction, chatId) {
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
  bot.sendMessage(chatId, format(transaction), { parse_mode: 'Markdown' });
}

// Function to scrape bank transactions, store to MongoDB and send to Telegram chat
async function handleTransactions(user, companyId, credentials, chatId) {
  const scraper = createScraper({
    companyId: companyId,
    startDate: new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1),
    //startDate: new Date(new Date().getFullYear() - 1, new Date().getMonth(), new Date().getDate()),
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

    // just last txns
    // TODO: rework to get actual last txns that was not scraped before
    transactions = transactions.slice(-5);

    for (const transaction of transactions) {
      if (await transactionExists(transaction)) {
        console.log(`Skipping existing transaction: ${JSON.stringify(transaction)}`);
        continue;
      }

      // Try to translate description
      if (process.env.OPENAI_API_KEY && process.env.GPT_TRANSLATION_REQUEST && process.env.GPT_MODEL_FAST) {
        let description = transaction.memo ? `${transaction.description} - ${transaction.memo}` : transaction.description;

        const translatedDescription = await retry(async () => {
          return await translateDescription(description);
        }, {
          retries: 5,
          factor: 2,
          minTimeout: 20000,
          randomize: true
        });

        transaction.translatedDescription = translatedDescription;
      }

      await save(transaction);
      await notify(transaction, chatId);
    }

  } else {
    console.error(`Scraping failed for the following reason: ${JSON.stringify(scrapeResult)}`);
  }
}

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

    cron.schedule(process.env.TRANSACTION_SYNC_SCHEDULE, () => {
      handleTransactions(user, CompanyTypes[companyTypeKey], credentials, chatId);
    }, {
      timezone: 'Asia/Jerusalem'
    });
  });
});
