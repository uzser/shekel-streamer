// Transaction and translation storage: SQLite (default, a local file) or MongoDB
// (when MONGO_CONNECTION_STRING is set, e.g. for the GitHub Actions mode).

import fs from 'node:fs';
import path from 'node:path';

/**
 * Key of a transaction that does not need an update: same date, amount, description,
 * processed date and status.
 */
export function transactionKey(t) {
  return [
    new Date(t.date).toISOString(),
    t.chargedAmount,
    t.description,
    new Date(t.processedDate).toISOString(),
    t.status,
  ].join('|');
}

/**
 * @returns {Promise<{
 *   check(): Promise<void>,
 *   getTranslation(description: string): Promise<string|null>,
 *   setTranslation(description: string, translation: string): Promise<void>,
 *   getExistingKeys(transactions: any[]): Promise<Set<string>>,
 *   saveOrUpdate(transaction: any): Promise<boolean>,
 *   importHistory?(data: object): Promise<{transactions: number, skipped: number, translations: number}>,
 *   hasNear?(transaction: any): Promise<boolean>,
 *   close(): Promise<void>,
 * }>}
 */
export async function createStorage({ mongoConnectionString, dbName, transactionsCollection, translationsCollection, sqlitePath }) {
  if (mongoConnectionString) {
    return createMongoStorage(mongoConnectionString, dbName, transactionsCollection, translationsCollection);
  }
  return createSqliteStorage(sqlitePath);
}

async function createSqliteStorage(file) {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      charged_amount REAL NOT NULL,
      description TEXT NOT NULL,
      processed_date TEXT,
      status TEXT,
      translated_description TEXT,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      UNIQUE (date, charged_amount, description)
    );
    CREATE TABLE IF NOT EXISTS translations (
      description TEXT PRIMARY KEY,
      translation TEXT
    );
  `);

  const findTxn = db.prepare(
    'SELECT id, processed_date, status, translated_description FROM transactions WHERE date = ? AND charged_amount = ? AND description = ?',
  );
  const insertTxn = db.prepare(
    `INSERT INTO transactions (date, charged_amount, description, processed_date, status, translated_description, doc, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateTxn = db.prepare(
    'UPDATE transactions SET processed_date = ?, status = ?, translated_description = ?, doc = ?, updated_at = ? WHERE id = ?',
  );
  const getTr = db.prepare('SELECT translation FROM translations WHERE description = ?');
  const setTr = db.prepare('INSERT OR IGNORE INTO translations (description, translation) VALUES (?, ?)');
  const findNear = db.prepare(
    'SELECT 1 FROM transactions WHERE charged_amount = ? AND description = ? AND date > ? AND date < ? LIMIT 1',
  );

  const iso = d => new Date(d).toISOString();
  // Old rows can have the same transaction at a date some hours off: the old image ran in UTC,
  // this one in Asia/Jerusalem (bank dates are midnight local time).
  const NEAR_MS = 12 * 60 * 60 * 1000;

  return {
    async check() {
      db.prepare('SELECT 1').get();
    },
    async getTranslation(description) {
      return getTr.get(description)?.translation ?? null;
    },
    async setTranslation(description, translation) {
      setTr.run(description, translation ?? null);
    },
    async getExistingKeys(transactions) {
      const keys = new Set();
      for (const t of transactions) {
        const row = findTxn.get(iso(t.date), t.chargedAmount, t.description);
        if (row && row.translated_description !== null
          && row.processed_date === iso(t.processedDate) && row.status === t.status) {
          keys.add(transactionKey(t));
        }
      }
      return keys;
    },
    // A row with the same amount and description and a date less than 12 hours away.
    async hasNear(t) {
      const ms = new Date(t.date).getTime();
      return !!findNear.get(t.chargedAmount, t.description, iso(ms - NEAR_MS), iso(ms + NEAR_MS));
    },
    async saveOrUpdate(t) {
      const now = new Date().toISOString();
      const row = findTxn.get(iso(t.date), t.chargedAmount, t.description);
      if (row) {
        updateTxn.run(iso(t.processedDate), t.status, t.translatedDescription ?? null, JSON.stringify(t), now, row.id);
        return false;
      }
      insertTxn.run(iso(t.date), t.chargedAmount, t.description, iso(t.processedDate), t.status,
        t.translatedDescription ?? null, JSON.stringify(t), now);
      return true;
    },
    // One-time import of an old history (MongoDB export, format shekel-streamer-history-v1).
    // Existing rows are kept; nothing is sent to Telegram.
    async importHistory({ format, transactions = [], translations = [] }) {
      if (format !== 'shekel-streamer-history-v1') {
        throw new Error(`Unknown history format: ${format}`);
      }
      const result = { transactions: 0, skipped: 0, translations: 0 };
      db.exec('BEGIN');
      try {
        for (const { _createdAt, ...t } of transactions) {
          if (findTxn.get(iso(t.date), t.chargedAmount, t.description)) {
            result.skipped++;
            continue;
          }
          insertTxn.run(iso(t.date), t.chargedAmount, t.description, iso(t.processedDate), t.status,
            t.translatedDescription ?? null, JSON.stringify(t), _createdAt || new Date().toISOString());
          result.transactions++;
        }
        for (const { description, translation } of translations) {
          result.translations += Number(setTr.run(description, translation ?? null).changes);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return result;
    },
    async close() {
      db.close();
    },
  };
}

async function createMongoStorage(uri, dbName, transactionsName, translationsName) {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri);
  await client.connect();
  const database = client.db(dbName);
  const transactions = database.collection(transactionsName);
  const translations = database.collection(translationsName);

  return {
    async check() {
      await database.command({ ping: 1 });
    },
    async getTranslation(description) {
      const doc = await translations.findOne({ _id: description });
      return doc ? doc.translation : null;
    },
    async setTranslation(description, translation) {
      try {
        await translations.insertOne({ _id: description, translation });
      } catch (error) {
        if (error.code !== 11000) { // Ignore duplicate key error
          throw error;
        }
      }
    },
    async getExistingKeys(list) {
      if (list.length === 0) {
        return new Set();
      }
      const cursor = transactions.find({
        $or: list.map(t => ({
          date: t.date,
          chargedAmount: t.chargedAmount,
          description: t.description,
          // following fields will update if transaction already exists, so we need to check them too
          processedDate: t.processedDate,
          status: t.status,
          translatedDescription: { $not: { $eq: null } },
        })),
      });
      const keys = new Set();
      for await (const doc of cursor) {
        keys.add(transactionKey(doc));
      }
      return keys;
    },
    async saveOrUpdate(t) {
      const filter = { date: t.date, chargedAmount: t.chargedAmount, description: t.description };
      const existing = await transactions.findOne(filter);
      if (existing) {
        await transactions.updateOne(filter, {
          $set: t,
          $currentDate: { updatedAt: true }, // Add or update a updatedAt field with the current date
        });
        return false;
      }
      await transactions.insertOne({ ...t, createdAt: new Date() });
      return true;
    },
    async close() {
      await client.close();
    },
  };
}
