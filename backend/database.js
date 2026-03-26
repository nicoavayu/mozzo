const path = require('path');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const { runMigrations } = require('./lib/migrations');

dotenv.config({ path: path.join(__dirname, '.env') });

const dbPath = path.resolve(process.env.DB_PATH || process.env.DATABASE_PATH || path.join(__dirname, 'database.sqlite'));
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to SQLite database.');
  }
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({
        lastID: this.lastID,
        changes: this.changes
      });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows);
    });
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) {
        reject(err);
        return;
      }

      resolve();
    });
  });
}

async function withTransaction(work) {
  await exec('BEGIN IMMEDIATE');

  try {
    const result = await work();
    await exec('COMMIT');
    return result;
  } catch (error) {
    try {
      await exec('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed', rollbackError.message);
    }

    throw error;
  }
}

async function initializeDatabase() {
  await exec('PRAGMA foreign_keys = ON');
  await runMigrations({ db, run, get, all, exec, withTransaction });
}

function close() {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        reject(err);
        return;
      }

      resolve();
    });
  });
}

module.exports = {
  db,
  dbPath,
  run,
  get,
  all,
  exec,
  withTransaction,
  initializeDatabase,
  close
};
