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
 *   reassignUser?(fix: {company: string, account: string, user: string}): Promise<number>,
 *   exportTo?(file: string): Promise<void>,
 *   removePendingDuplicates?(): Promise<number>,
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

  const replaceTxn = db.prepare(
    `UPDATE transactions SET date = ?, charged_amount = ?, description = ?, processed_date = ?, status = ?,
       translated_description = ?, doc = ?, updated_at = ? WHERE id = ?`,
  );
  const deleteTxn = db.prepare('DELETE FROM transactions WHERE id = ?');
  // The pending and the completed row of one transaction: same company, account and original
  // amount, at most 3 days apart. The completed row can have another amount (a purchase abroad:
  // the original currency → USD/EUR), another description or another day (bank rows). Same
  // description on another day = another purchase (e.g. a coffee every day).
  const findTwins = db.prepare(
    `SELECT id FROM transactions
     WHERE status = ? AND json_extract(doc, '$.companyId') IS ?
       AND CAST(json_extract(doc, '$.accountNumber') AS TEXT) IS ?
       AND json_extract(doc, '$.originalCurrency') IS ? AND abs(json_extract(doc, '$.originalAmount') - ?) < 0.005
       AND date BETWEEN ? AND ? AND (description != ? OR abs(julianday(date) - julianday(?)) < 0.5)
     ORDER BY description = ? DESC, abs(julianday(date) - julianday(?)), id`,
  );

  const iso = d => new Date(d).toISOString();
  // Old rows can have the same transaction at a date some hours off: the old image ran in UTC,
  // this one in Asia/Jerusalem (bank dates are midnight local time).
  const NEAR_MS = 12 * 60 * 60 * 1000;
  const TWIN_MS = 3 * 24 * 60 * 60 * 1000;
  const twinsOf = (status, t) => {
    const ms = new Date(t.date).getTime();
    return findTwins.all(status, t.companyId ?? null, t.accountNumber == null ? null : String(t.accountNumber),
      t.originalCurrency ?? null, t.originalAmount ?? null, iso(ms - TWIN_MS), iso(ms + TWIN_MS),
      t.description, iso(t.date), t.description, iso(t.date));
  };

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
      // The pending row of this transaction is stored with another amount, description or day:
      // it becomes this completed row (no second row, no second post).
      const twin = t.status === 'completed' && t.originalAmount != null ? twinsOf('pending', t)[0] : undefined;
      if (twin) {
        replaceTxn.run(iso(t.date), t.chargedAmount, t.description, iso(t.processedDate), t.status,
          t.translatedDescription ?? null, JSON.stringify(t), now, twin.id);
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
    // One-time fix: the rows of one card or account belong to another user (doc.userCode).
    // Returns the number of changed rows.
    async reassignUser({ company, account, user }) {
      const result = db.prepare(
        `UPDATE transactions SET doc = json_set(doc, '$.userCode', ?), updated_at = ?
         WHERE json_extract(doc, '$.companyId') = ? AND CAST(json_extract(doc, '$.accountNumber') AS TEXT) = ?
           AND json_extract(doc, '$.userCode') IS NOT ?`,
      ).run(user, new Date().toISOString(), company, String(account), user);
      return Number(result.changes);
    },
    // One-time cleanup (database version 1): pending rows whose completed row is stored as another
    // row (old app, history import). Each completed row takes one pending row. Returns the count.
    async removePendingDuplicates() {
      if (db.prepare('PRAGMA user_version').get().user_version >= 1) {
        return 0;
      }
      const used = new Set();
      let removed = 0;
      db.exec('BEGIN');
      try {
        for (const p of db.prepare("SELECT id, date, description, doc FROM transactions WHERE status = 'pending' ORDER BY date, id").all()) {
          const twin = twinsOf('completed', { ...JSON.parse(p.doc), date: p.date, description: p.description })
            .find(c => !used.has(c.id));
          if (twin) {
            used.add(twin.id);
            deleteTxn.run(p.id);
            removed++;
          }
        }
        db.exec('PRAGMA user_version = 1');
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return removed;
    },
    // A consistent copy of the whole database (for analysis outside the add-on).
    async exportTo(target) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.rmSync(target, { force: true }); // VACUUM INTO needs a new file
      db.prepare('VACUUM INTO ?').run(target);
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
