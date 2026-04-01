const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const migration015 = require('../migrations/015_add_bill_payment_flow_fields');

const ADMIN_PASSWORD = 'test-sprint11-admin-password';
const ADMIN_TOKEN_SECRET = 'test-sprint11-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint11-'));
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

  return { run, get, all, exec, columnExists, close };
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

async function publishMenu(baseUrl, adminToken) {
  const publish = await requestJson(`${baseUrl}/api/menu/publish`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify({
      name: 'Sprint 11 Bill Flow Menu',
      categories: [
        {
          name: 'Principales',
          items: [{ name: 'Milanesa Bill Flow', description: 'Cuenta con método', price: 20 }],
        },
      ],
    }),
  });

  assert.equal(publish.response.status, 200);

  const menu = await requestJson(`${baseUrl}/api/menu`);
  assert.equal(menu.response.status, 200);
  return menu.body[0].items[0].id;
}

async function createDeliveredOrder(baseUrl, dbPath, { tableId, itemId, quantity = 1 }) {
  const orderResponse = await requestJson(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table_id: tableId,
      items: [{ item_id: itemId, quantity, comments: '' }],
    }),
  });
  assert.equal(orderResponse.response.status, 201);

  const directDb = createSqliteContext(dbPath);
  try {
    await directDb.run(
      `
        UPDATE orders
        SET
          status = 'delivered',
          delivered_at = CURRENT_TIMESTAMP,
          ready_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [orderResponse.body.id]
    );
  } finally {
    await directDb.close();
  }

  return orderResponse.body.id;
}

async function testMigrationAddsBillFlowColumns() {
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
        bill_requested_at DATETIME,
        bill_attended_at DATETIME,
        closed_at DATETIME
      )
    `);

    await migration015.up(context);
    assert.equal(await context.columnExists('orders', 'bill_payment_method_preference'), true);
    assert.equal(await context.columnExists('orders', 'bill_collection_status'), true);
  } finally {
    await context.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  await testMigrationAddsBillFlowColumns();

  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'database.sqlite');
  const port = 3321;
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

  server.stderr.on('data', (chunk) => {
    process.stderr.write(chunk.toString());
  });

  try {
    await waitForServer(baseUrl);

    const adminToken = await loginAdmin(baseUrl);
    const itemId = await publishMenu(baseUrl, adminToken);

    const openRegister = await requestJson(`${baseUrl}/api/admin/cash-register/open`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ opening_float: 50, notes_open: 'Sprint 11 caja' }),
    });
    assert.equal(openRegister.response.status, 201);

    const cashOrderId = await createDeliveredOrder(baseUrl, dbPath, { tableId: 1, itemId });
    const requestCashBill = await requestJson(`${baseUrl}/api/tables/1/request-bill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferred_payment_method: 'cash' }),
    });
    assert.equal(requestCashBill.response.status, 201);
    assert.equal(requestCashBill.body.table_request.type, 'request_bill');
    assert.equal(requestCashBill.body.order.bill_payment_method_preference, 'cash');
    assert.equal(requestCashBill.body.order.bill_collection_status, 'waiting_cash');
    assert.equal(requestCashBill.body.order.bill_attended_at, null);

    const requestList = await requestJson(`${baseUrl}/api/table-requests`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(requestList.response.status, 200);
    const cashRequest = requestList.body.find((request) => request.table_id === 1 && request.status === 'pending');
    assert.ok(cashRequest);
    assert.equal(cashRequest.bill_payment_method_preference, 'cash');
    assert.equal(cashRequest.bill_collection_status, 'waiting_cash');

    const resolveCashBill = await requestJson(`${baseUrl}/api/table-requests/${requestCashBill.body.table_request.id}/resolve`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    assert.equal(resolveCashBill.response.status, 200);
    assert.equal(resolveCashBill.body.bill_attended_at != null, true);

    const partialCashPayment = await requestJson(`${baseUrl}/api/admin/orders/${cashOrderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 5, method: 'cash', note: 'Seña' }),
    });
    assert.equal(partialCashPayment.response.status, 201);
    assert.equal(partialCashPayment.body.amount_paid, 5);
    assert.equal(partialCashPayment.body.amount_due, 15);
    assert.equal(partialCashPayment.body.bill_collection_status, 'partial_payment');

    const mpOrderId = await createDeliveredOrder(baseUrl, dbPath, { tableId: 2, itemId });
    const requestMpBill = await requestJson(`${baseUrl}/api/tables/2/request-bill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferred_payment_method: 'mercado_pago' }),
    });
    assert.equal(requestMpBill.response.status, 200);
    assert.equal(requestMpBill.body.table_request, null);
    assert.equal(requestMpBill.body.order.bill_payment_method_preference, 'mercado_pago');
    assert.equal(requestMpBill.body.order.bill_collection_status, 'checkout_pending');
    assert.ok(requestMpBill.body.order.bill_attended_at);
    assert.equal(requestMpBill.body.should_start_online_checkout, true);

    const table2ActiveRequests = await requestJson(`${baseUrl}/api/tables/2/requests/active`);
    assert.equal(table2ActiveRequests.response.status, 200);
    assert.equal(table2ActiveRequests.body.length, 0);

    const mpCheckout = await requestJson(`${baseUrl}/api/tables/2/mercado-pago/checkout`, { method: 'POST' });
    assert.equal(mpCheckout.response.status, 201);
    const mpReturn = await fetch(mpCheckout.body.checkout_url, { redirect: 'manual' });
    assert.equal(mpReturn.status, 302);

    const table2Session = await requestJson(`${baseUrl}/api/tables/2/orders/session`);
    assert.equal(table2Session.response.status, 200);
    assert.equal(table2Session.body.active_order.payment_status, 'paid');
    assert.equal(table2Session.body.active_order.bill_collection_status, 'payment_recorded');
    assert.equal(table2Session.body.active_order.payment_method, 'mercado_pago');

    const changedMethodOrderId = await createDeliveredOrder(baseUrl, dbPath, { tableId: 3, itemId });
    const requestMpThenCard = await requestJson(`${baseUrl}/api/tables/3/request-bill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferred_payment_method: 'mercado_pago' }),
    });
    assert.equal(requestMpThenCard.response.status, 200);
    assert.equal(requestMpThenCard.body.order.bill_collection_status, 'checkout_pending');

    const switchToCard = await requestJson(`${baseUrl}/api/tables/3/request-bill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferred_payment_method: 'card' }),
    });
    assert.equal(switchToCard.response.status, 201);
    assert.equal(switchToCard.body.order.bill_payment_method_preference, 'card');
    assert.equal(switchToCard.body.order.bill_collection_status, 'waiting_card');
    assert.ok(switchToCard.body.order.bill_attended_at);
    assert.ok(switchToCard.body.table_request?.id);

    const requestListAfterSwitch = await requestJson(`${baseUrl}/api/table-requests`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(requestListAfterSwitch.response.status, 200);
    const switchedRequest = requestListAfterSwitch.body.find((request) => request.table_id === 3 && request.status === 'pending');
    assert.ok(switchedRequest);
    assert.equal(switchedRequest.bill_payment_method_preference, 'card');
    assert.equal(switchedRequest.bill_collection_status, 'waiting_card');

    const manualAfterMpChoiceOrderId = await createDeliveredOrder(baseUrl, dbPath, { tableId: 4, itemId });
    const requestMpForManualFallback = await requestJson(`${baseUrl}/api/tables/4/request-bill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferred_payment_method: 'mercado_pago' }),
    });
    assert.equal(requestMpForManualFallback.response.status, 200);

    const manualCashPayment = await requestJson(`${baseUrl}/api/admin/orders/${manualAfterMpChoiceOrderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 20, method: 'cash', note: 'Terminó pagando en mesa' }),
    });
    assert.equal(manualCashPayment.response.status, 201);
    assert.equal(manualCashPayment.body.payment_status, 'paid');
    assert.equal(manualCashPayment.body.payment_method, 'cash');
    assert.equal(manualCashPayment.body.bill_payment_method_preference, 'mercado_pago');
    assert.equal(manualCashPayment.body.bill_collection_status, 'payment_recorded');
    assert.equal(manualCashPayment.body.external_payment_attempts.length, 0);

    const openOrders = await requestJson(`${baseUrl}/api/admin/orders/open`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(openOrders.response.status, 200);
    const openOrderTable4 = openOrders.body.find((order) => order.id === manualAfterMpChoiceOrderId);
    assert.ok(openOrderTable4);
    assert.equal(openOrderTable4.bill_payment_method_preference, 'mercado_pago');
    assert.equal(openOrderTable4.bill_collection_status, 'payment_recorded');

    console.log('Sprint 11 backend tests passed');
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
