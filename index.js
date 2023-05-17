require('dotenv').config();
const { createScraper, CompanyTypes } = require('israeli-bank-scrapers');
const MongoClient = require('mongodb').MongoClient;
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');

// Function to check if transaction already exists in db
async function transactionExists(record) {
  const client = new MongoClient(process.env.MONGO_CONNECTION_STRING);
  try {
    await client.connect();
    const database = client.db("transactionsDB");
    const transactions = database.collection("transactions");
    // Check if transaction already exists in database
    const existingTransaction = await transactions.findOne({
      date: record.date,
      chargedAmount: record.chargedAmount,
      description: record.description
    });
    return !!existingTransaction;
  } finally {
    await client.close();
  }
}

async function saveTransaction(record) {
  const client = new MongoClient(process.env.MONGO_CONNECTION_STRING);
  try {
    await client.connect();
    const database = client.db("transactionsDB");
    const transactions = database.collection("transactions");
    await transactions.insertOne(record);
  } finally {
    await client.close();
  }
}

function notify(record, chatId) {
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
  bot.sendMessage(chatId, JSON.stringify(record));
}

// Function to scrape bank transactions, store to MongoDB and send to Telegram chat
async function handleTransactions(user, companyId, credentials, chatId) {
  const scraper = createScraper({
    companyId: companyId,
    startDate: new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1),
    //startDate: new Date(new Date().getFullYear() - 1, new Date().getMonth(), new Date().getDate()),
    combineInstallments: false
  });

  const scrapeResult = await scraper.scrape(credentials);

  if (scrapeResult.success) {
    let records = [];
    scrapeResult.accounts.forEach((account) => {
      account.txns.forEach((txn) => {
        records.push({
          accountNumber: account.accountNumber,
          date: new Date(txn.date),
          description: txn.description,
          memo: txn.memo,
          originalAmount: txn.originalAmount,
          originalCurrency: txn.originalCurrency, // possible wrong value: ILS instead of USD
          chargedAmount: txn.chargedAmount, // possible the same as originalAmount, even if in USD/EUR, in case of USD/EUR account
          type: txn.type,
          status: txn.status,
          identifier: txn.identifier, // only if exists
          processedDate: new Date(txn.processedDate),
          installments: txn.installments // only if exists
        });
      });
    });

    // just last record
    // TODO: rework to get actual last record that was not scraped before
    records = records.slice(-1);

    for (const record of records) {
      if (await transactionExists(record)) {
        console.log(`Skipping existing transaction: ${JSON.stringify(record)}`);
        continue;
      }

      await saveTransaction(record);
      await notify(record, chatId);
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