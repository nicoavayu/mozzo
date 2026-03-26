const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const migration008 = require('../migrations/008_add_menu_item_availability');

const ADMIN_PASSWORD = 'test-sprint3-admin-password';
const ADMIN_TOKEN_SECRET = 'test-sprint3-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint3-'));
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
      name: 'Sprint 3 Test Menu',
      categories: [
        {
          name: 'Principales',
          items: [
            {
              name: 'Milanesa Sprint 3',
              description: 'Disponible para test',
              price: 19,
            },
            {
              name: 'Flan Sprint 3',
              description: 'Postre de test',
              price: 6,
            },
          ],
        },
      ],
    }),
  });

  assert.equal(response.status, 200, 'publish menu should succeed');
}

async function testMigrationAddsAvailability() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'migration.sqlite');
  const context = createSqliteContext(dbPath);

  try {
    await context.exec(`
      CREATE TABLE menu_items (
        id INTEGER PRIMARY KEY,
        category_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        price REAL NOT NULL
      );
    `);

    await context.run(
      `
        INSERT INTO menu_items (id, category_id, name, description, price)
        VALUES (1, 10, 'Empanada', 'Carne', 5)
      `
    );

    await migration008.up(context);

    const columns = await context.all('PRAGMA table_info(menu_items)');
    const availabilityColumn = columns.find((column) => column.name === 'is_available');
    const items = await context.all('SELECT id, is_available FROM menu_items ORDER BY id ASC');

    assert.ok(availabilityColumn, 'migration should add is_available column');
    assert.equal(Number(availabilityColumn.dflt_value), 1, 'is_available default should be 1');
    assert.equal(items[0].is_available, 1, 'existing items should be backfilled as available');
  } finally {
    await context.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testAvailabilityLifecycle() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'server.sqlite');
  const uploadDir = path.join(tempDir, 'uploads');
  const port = 3600 + Math.floor(Math.random() * 2000);
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
    assert.equal(menuResponse.status, 200, 'menu should load');
    assert.equal(menu[0].items[0].is_available, 1, 'newly published items should default to available');

    const unavailableItemId = menu[0].items[0].id;
    const availableItemId = menu[0].items[1].id;

    const toggleResponse = await fetch(`${baseUrl}/api/admin/menu-items/${unavailableItemId}/availability`, {
      method: 'PATCH',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ is_available: false }),
    });
    const toggledItem = await toggleResponse.json();

    assert.equal(toggleResponse.status, 200, 'toggle availability should succeed');
    assert.equal(toggledItem.is_available, 0, 'item should be marked unavailable');

    const menuAfterToggleResponse = await fetch(`${baseUrl}/api/menu`);
    const menuAfterToggle = await menuAfterToggleResponse.json();
    const unavailableItem = menuAfterToggle[0].items.find((item) => item.id === unavailableItemId);
    const availableItem = menuAfterToggle[0].items.find((item) => item.id === availableItemId);

    assert.equal(unavailableItem.is_available, 0, 'public menu should expose unavailable item');
    assert.equal(availableItem.is_available, 1, 'other items should remain available');

    const unavailableOrderResponse = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table_id: 4,
        items: [
          {
            item_id: unavailableItemId,
            quantity: 1,
            comments: '',
          },
        ],
      }),
    });
    const unavailableOrderPayload = await unavailableOrderResponse.json();

    assert.equal(unavailableOrderResponse.status, 409, 'unavailable item should reject order');
    assert.equal(unavailableOrderPayload.code, 'ITEM_UNAVAILABLE');
    assert.deepEqual(unavailableOrderPayload.unavailable_items, [
      {
        item_id: unavailableItemId,
        name: 'Milanesa Sprint 3',
      },
    ]);

    const availableOrderResponse = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table_id: 4,
        items: [
          {
            item_id: availableItemId,
            quantity: 2,
            comments: '',
          },
        ],
      }),
    });
    const availableOrder = await availableOrderResponse.json();

    assert.equal(availableOrderResponse.status, 201, 'available item should still allow ordering');
    assert.equal(availableOrder.items[0].name, 'Flan Sprint 3');
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  await testMigrationAddsAvailability();
  console.log('PASS migración agrega disponibilidad por default');

  await testAvailabilityLifecycle();
  console.log('PASS toggle admin y validación de pedido con ITEM_UNAVAILABLE');

  console.log('Backend sprint 3 tests passed.');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
