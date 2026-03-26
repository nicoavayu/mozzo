const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const migration007 = require('../migrations/007_orders_open_lifecycle');

const ADMIN_PASSWORD = 'test-sprint1-admin-password';
const ADMIN_TOKEN_SECRET = 'test-sprint1-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint1-'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSqliteContext(dbPath) {
  const db = new sqlite3.Database(dbPath);

  const run = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(err) {
        if (err) {
          reject(err);
          return;
        }

        resolve({ lastID: this.lastID, changes: this.changes });
      });
    });

  const get = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(row);
      });
    });

  const all = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(rows);
      });
    });

  const exec = (sql) =>
    new Promise((resolve, reject) => {
      db.exec(sql, (err) => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });

  const withTransaction = async (work) => {
    await exec('BEGIN IMMEDIATE');

    try {
      const result = await work();
      await exec('COMMIT');
      return result;
    } catch (error) {
      await exec('ROLLBACK');
      throw error;
    }
  };

  const columnExists = async (tableName, columnName) => {
    const columns = await all(`PRAGMA table_info(${tableName})`);
    return columns.some((column) => column.name === columnName);
  };

  const close = () =>
    new Promise((resolve, reject) => {
      db.close((err) => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });

  return { db, run, get, all, exec, withTransaction, columnExists, close };
}

async function waitForServer(baseUrl, timeoutMs = 15000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until timeout.
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for server at ${baseUrl}`);
}

async function loginAdmin(baseUrl) {
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  const data = await response.json();

  assert.equal(response.status, 200, 'admin login should succeed');
  assert.ok(data.token, 'admin login should return token');
  return data.token;
}

function authHeaders(token, includeJson = false) {
  return {
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${token}`,
  };
}

async function publishMenu(baseUrl, adminToken) {
  const response = await fetch(`${baseUrl}/api/menu/publish`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify({
      name: 'Sprint 1 Test Menu',
      categories: [
        {
          name: 'Principales',
          items: [
            {
              name: 'Bife',
              description: 'Prueba sprint 1',
              price: 18,
            },
          ],
        },
      ],
    }),
  });

  assert.equal(response.status, 200, 'publish menu should succeed');
}

async function testMigrationConflictiveLegacy() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'migration.sqlite');
  const context = createSqliteContext(dbPath);

  try {
    await context.exec(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_id INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processing_started_at DATETIME,
        ready_at DATETIME,
        delivered_at DATETIME
      );
    `);

    await context.run(
      `
        INSERT INTO orders (table_id, status, created_at, processing_started_at)
        VALUES (1, 'processing', '2026-03-25 10:00:00', '2026-03-25 10:01:00')
      `
    );
    await context.run(
      `
        INSERT INTO orders (table_id, status, created_at)
        VALUES (1, 'pending', '2026-03-25 10:05:00')
      `
    );
    await context.run(
      `
        INSERT INTO orders (table_id, status, created_at, ready_at)
        VALUES (2, 'ready', '2026-03-25 10:10:00', '2026-03-25 10:25:00')
      `
    );
    await context.run(
      `
        INSERT INTO orders (table_id, status, created_at, delivered_at)
        VALUES (3, 'delivered', '2026-03-25 10:15:00', '2026-03-25 10:40:00')
      `
    );

    await migration007.up(context);

    const orders = await context.all(
      `
        SELECT table_id, status, created_at, closed_at
        FROM orders
        ORDER BY table_id ASC, created_at ASC
      `
    );

    assert.equal(orders[0].table_id, 1);
    assert.equal(orders[0].status, 'processing');
    assert.ok(orders[0].closed_at, 'older processing order should be closed');

    assert.equal(orders[1].table_id, 1);
    assert.equal(orders[1].status, 'pending');
    assert.equal(orders[1].closed_at, null, 'newest pending order should remain open');

    assert.ok(orders[2].closed_at, 'legacy ready order should be closed');
    assert.ok(orders[3].closed_at, 'legacy delivered order should be closed');

    await context.run(`INSERT INTO orders (table_id, status, closed_at) VALUES (9, 'pending', NULL)`);
    let uniqueConstraintFailed = false;
    try {
      await context.run(`INSERT INTO orders (table_id, status, closed_at) VALUES (9, 'pending', NULL)`);
    } catch (error) {
      uniqueConstraintFailed = /UNIQUE|idx_orders_single_open_per_table/i.test(String(error.message || ''));
    }

    assert.equal(uniqueConstraintFailed, true, 'unique partial index should reject a second open order');
  } finally {
    await context.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testConcurrentCreateOrder() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'server.sqlite');
  const uploadDir = path.join(tempDir, 'uploads');
  const port = 3600 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: dbPath,
      UPLOAD_DIR: uploadDir,
      FRONTEND_URL: 'http://127.0.0.1:5173',
      ADMIN_PASSWORD,
      ADMIN_TOKEN_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  server.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitForServer(baseUrl);
    const adminToken = await loginAdmin(baseUrl);
    await publishMenu(baseUrl, adminToken);

    const menuResponse = await fetch(`${baseUrl}/api/menu`);
    const menu = await menuResponse.json();
    const itemId = menu[0].items[0].id;

    const requestBody = {
      table_id: 1,
      items: [{ item_id: itemId, quantity: 1, comments: '' }],
    };

    const createOrder = () =>
      fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      }).then(async (response) => ({
        status: response.status,
        data: await response.json(),
      }));

    const [left, right] = await Promise.all([createOrder(), createOrder()]);
    const statuses = [left.status, right.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 409], 'concurrent creates should yield one success and one conflict');

    const activeOrderResponse = await fetch(`${baseUrl}/api/tables/1/orders/active`);
    const activeOrder = await activeOrderResponse.json();
    assert.equal(activeOrderResponse.status, 200);
    assert.ok(activeOrder?.id, 'table should still expose a single open order');
  } finally {
    const shouldDumpOutput = process.exitCode && serverOutput;
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (shouldDumpOutput) {
      process.stderr.write(serverOutput);
    }
  }
}

async function main() {
  await testMigrationConflictiveLegacy();
  console.log('PASS migration legacy conflictiva');

  await testConcurrentCreateOrder();
  console.log('PASS doble POST /api/orders simultáneo');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
