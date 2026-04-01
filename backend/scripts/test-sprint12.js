const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const migration016 = require('../migrations/016_create_order_suborders');

const ADMIN_PASSWORD = 'test-sprint12-admin-password';
const ADMIN_TOKEN_SECRET = 'test-sprint12-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint12-'));
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

  const tableExists = async (tableName) => {
    const row = await get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [tableName]
    );
    return Boolean(row);
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

  return { run, get, all, exec, tableExists, close };
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
      // retry
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for server at ${baseUrl}`);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return { response, body };
}

async function loginAdmin(baseUrl) {
  const login = await requestJson(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });

  assert.equal(login.response.status, 200);
  assert.ok(login.body.token);
  return login.body.token;
}

function authHeaders(token, includeJson = false) {
  return {
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${token}`,
  };
}

async function testMigrationBackfillsSingleSuborder() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'migration.sqlite');
  const context = createSqliteContext(dbPath);

  try {
    await context.exec(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processing_started_at DATETIME,
        ready_at DATETIME,
        delivered_at DATETIME
      );

      CREATE TABLE order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        comments TEXT,
        item_name TEXT,
        item_description TEXT,
        unit_price REAL
      );
    `);

    const orderInsert = await context.run(
      `
        INSERT INTO orders (
          table_id,
          status,
          created_at,
          processing_started_at,
          ready_at,
          delivered_at
        )
        VALUES (1, 'delivered', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `
    );

    await context.run(
      `
        INSERT INTO order_items (
          order_id,
          item_id,
          quantity,
          comments,
          item_name,
          item_description,
          unit_price
        )
        VALUES (?, 10, 2, 'sin hielo', 'Limonada', 'Prueba', 5)
      `,
      [orderInsert.lastID]
    );

    await migration016.up(context);

    assert.equal(await context.tableExists('order_suborders'), true);
    assert.equal(await context.tableExists('order_suborder_items'), true);

    const suborders = await context.all('SELECT * FROM order_suborders WHERE order_id = ?', [orderInsert.lastID]);
    assert.equal(suborders.length, 1);
    assert.equal(suborders[0].sequence_number, 1);
    assert.equal(suborders[0].status, 'delivered');

    const suborderItems = await context.all('SELECT * FROM order_suborder_items WHERE order_id = ?', [orderInsert.lastID]);
    assert.equal(suborderItems.length, 1);
    assert.equal(suborderItems[0].item_name, 'Limonada');
  } finally {
    await context.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  await testMigrationBackfillsSingleSuborder();

  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'database.sqlite');
  const port = 3322;
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn('node', ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      ADMIN_PASSWORD,
      ADMIN_TOKEN_SECRET,
      BACKEND_URL: baseUrl,
      FRONTEND_URL: 'http://127.0.0.1:5173',
      MP_MOCK_MODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stderr.on('data', (chunk) => process.stderr.write(chunk.toString()));

  try {
    await waitForServer(baseUrl);
    const adminToken = await loginAdmin(baseUrl);

    const publish = await requestJson(`${baseUrl}/api/menu/publish`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({
        name: 'Sprint 12 Menu',
        categories: [
          {
            name: 'Mesa',
            items: [
              { name: 'Pasta Sprint 12', description: 'Principal', price: 20 },
              { name: 'Cafe Sprint 12', description: 'Adicional', price: 10 },
            ],
          },
        ],
      }),
    });
    assert.equal(publish.response.status, 200);

    const menu = await requestJson(`${baseUrl}/api/menu`);
    assert.equal(menu.response.status, 200);
    const [mainItem, extraItem] = menu.body[0].items;

    const initialOrder = await requestJson(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table_id: 1,
        items: [{ item_id: mainItem.id, quantity: 1, comments: 'al dente' }],
      }),
    });
    assert.equal(initialOrder.response.status, 201);
    assert.equal(initialOrder.body.suborders.length, 1);
    assert.equal(initialOrder.body.suborders[0].sequence_number, 1);
    assert.equal(initialOrder.body.total_amount, 20);

    const additionalSuborder = await requestJson(`${baseUrl}/api/tables/1/suborders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ item_id: extraItem.id, quantity: 1, comments: 'sin azucar' }],
      }),
    });
    assert.equal(additionalSuborder.response.status, 201);
    assert.equal(additionalSuborder.body.suborder.sequence_number, 2);
    assert.equal(additionalSuborder.body.order.suborders.length, 2);
    assert.equal(additionalSuborder.body.order.total_amount, 30);

    const session = await requestJson(`${baseUrl}/api/tables/1/orders/session`);
    assert.equal(session.response.status, 200);
    assert.equal(session.body.active_order.suborders.length, 2);

    const openSuborders = await requestJson(`${baseUrl}/api/admin/suborders/open`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(openSuborders.response.status, 200);
    assert.equal(openSuborders.body.length, 2);
    assert.equal(openSuborders.body[0].sequence_number, 1);
    assert.equal(openSuborders.body[1].sequence_number, 2);
    assert.equal(openSuborders.body[0].session_total_amount, 30);

    const firstSuborderId = session.body.active_order.suborders[0].id;
    const secondSuborderId = session.body.active_order.suborders[1].id;
    const rootOrderId = session.body.active_order.id;

    for (const nextStatus of ['processing', 'ready', 'delivered']) {
      const updateFirstSuborder = await requestJson(`${baseUrl}/api/admin/suborders/${firstSuborderId}/status`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({ status: nextStatus }),
      });
      assert.equal(updateFirstSuborder.response.status, 200);
    }

    const requestBillTooEarly = await requestJson(`${baseUrl}/api/tables/1/request-bill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferred_payment_method: 'cash' }),
    });
    assert.equal(requestBillTooEarly.response.status, 409);
    assert.equal(requestBillTooEarly.body.code, 'ORDER_NOT_DELIVERED');

    for (const nextStatus of ['processing', 'ready', 'delivered']) {
      const updateSecondSuborder = await requestJson(`${baseUrl}/api/admin/suborders/${secondSuborderId}/status`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({ status: nextStatus }),
      });
      assert.equal(updateSecondSuborder.response.status, 200);
    }

    const requestBill = await requestJson(`${baseUrl}/api/tables/1/request-bill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferred_payment_method: 'cash' }),
    });
    assert.equal(requestBill.response.status, 201);
    assert.equal(requestBill.body.order.bill_payment_method_preference, 'cash');

    const blockedAdditional = await requestJson(`${baseUrl}/api/tables/1/suborders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ item_id: extraItem.id, quantity: 1, comments: '' }],
      }),
    });
    assert.equal(blockedAdditional.response.status, 409);
    assert.equal(blockedAdditional.body.code, 'BILL_FLOW_ALREADY_STARTED');

    const resolveBill = await requestJson(`${baseUrl}/api/table-requests/${requestBill.body.table_request.id}/resolve`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    assert.equal(resolveBill.response.status, 200);

    const openRegister = await requestJson(`${baseUrl}/api/admin/cash-register/open`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ opening_float: 0, notes_open: 'Sprint 12' }),
    });
    assert.equal(openRegister.response.status, 201);

    const payment = await requestJson(`${baseUrl}/api/admin/orders/${rootOrderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 30, method: 'cash', note: 'Cuenta completa' }),
    });
    assert.equal(payment.response.status, 201);
    assert.equal(payment.body.amount_due, 0);

    const closeOrder = await requestJson(`${baseUrl}/api/admin/orders/${rootOrderId}/close`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    assert.equal(closeOrder.response.status, 200);
    assert.ok(closeOrder.body.closed_at);

    const history = await requestJson(`${baseUrl}/api/admin/orders/history?preset=today`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(history.response.status, 200);
    const closedOrder = history.body.orders.find((order) => order.id === rootOrderId);
    assert.ok(closedOrder);
    assert.equal(closedOrder.total_amount, 30);
    assert.equal(closedOrder.suborders.length, 2);

    console.log('Sprint 12 backend tests passed');
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
