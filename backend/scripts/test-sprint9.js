const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const migration013 = require('../migrations/013_add_order_payment_reversals');

const ADMIN_PASSWORD = 'test-sprint9-admin-password';
const ADMIN_TOKEN_SECRET = 'test-sprint9-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint9-'));
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

  return { db, run, get, all, exec, withTransaction, tableExists, close };
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
  } catch (_error) {
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
      name: 'Sprint 9 Refunds Menu',
      categories: [
        {
          name: 'Principales',
          items: [{ name: 'Pizza Refund', description: 'Cobros y reversión', price: 20 }],
        },
      ],
    }),
  });

  assert.equal(publish.response.status, 200);

  const menu = await requestJson(`${baseUrl}/api/menu`);
  assert.equal(menu.response.status, 200);
  return menu.body[0].items[0].id;
}

async function createDeliveredOrder(baseUrl, dbPath, { tableId, itemId, quantity = 1, billAttended = true }) {
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
          ready_at = CURRENT_TIMESTAMP,
          bill_requested_at = CURRENT_TIMESTAMP,
          bill_attended_at = ${billAttended ? 'CURRENT_TIMESTAMP' : 'NULL'}
        WHERE id = ?
      `,
      [orderResponse.body.id]
    );
  } finally {
    await directDb.close();
  }

  return orderResponse.body.id;
}

async function insertLegacyClosedOrder(dbPath, { tableId, itemId, totalAmount, paymentMethod }) {
  const directDb = createSqliteContext(dbPath);

  try {
    const orderResult = await directDb.run(
      `
        INSERT INTO orders (
          table_id,
          status,
          created_at,
          delivered_at,
          bill_requested_at,
          bill_attended_at,
          payment_received_at,
          payment_method,
          closed_at
        )
        VALUES (?, 'delivered', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
      `,
      [tableId, paymentMethod]
    );

    await directDb.run(
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
        VALUES (?, ?, 1, '', 'Legacy pago', 'Compatibilidad', ?)
      `,
      [orderResult.lastID, itemId, totalAmount]
    );

    return orderResult.lastID;
  } finally {
    await directDb.close();
  }
}

async function testMigrationCreatesReversalsTable() {
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
        closed_at DATETIME
      );

      CREATE TABLE cash_register_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL DEFAULT 'open'
      );

      CREATE TABLE order_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        cash_register_session_id INTEGER,
        amount REAL NOT NULL,
        method TEXT NOT NULL,
        note TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by TEXT
      );
    `);

    await migration013.up(context);

    assert.equal(await context.tableExists('order_payment_reversals'), true);
    const reversalColumns = await context.all('PRAGMA table_info(order_payment_reversals)');
    assert.ok(reversalColumns.some((column) => column.name === 'order_payment_id'));
    assert.ok(reversalColumns.some((column) => column.name === 'reason'));
    assert.ok(reversalColumns.some((column) => column.name === 'cash_register_session_id'));
    console.log('PASS migration reversals');
  } finally {
    await context.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testRefundsAndVoidsFlow() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'integration.sqlite');
  const port = 4400 + Math.floor(Math.random() * 100);
  const baseUrl = `http://127.0.0.1:${port}`;
  const frontendUrl = 'http://127.0.0.1:4173';

  const server = spawn('node', ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      ADMIN_PASSWORD,
      ADMIN_TOKEN_SECRET,
      BACKEND_URL: baseUrl,
      FRONTEND_URL: frontendUrl,
      MP_MOCK_MODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stderr.on('data', (chunk) => process.stderr.write(chunk.toString()));

  try {
    await waitForServer(baseUrl);
    const adminToken = await loginAdmin(baseUrl);
    const itemId = await publishMenu(baseUrl, adminToken);

    const openRegister = await requestJson(`${baseUrl}/api/admin/cash-register/open`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ opening_float: 50, notes_open: 'Caja refunds test' }),
    });
    assert.equal(openRegister.response.status, 201);

    const orderId = await createDeliveredOrder(baseUrl, dbPath, {
      tableId: 1,
      itemId,
      quantity: 2,
      billAttended: true,
    });

    const firstPayment = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 25, method: 'cash', note: 'Seña inicial' }),
    });
    assert.equal(firstPayment.response.status, 201);
    assert.equal(firstPayment.body.amount_paid, 25);
    assert.equal(firstPayment.body.amount_due, 15);

    const cashPaymentId = firstPayment.body.payments[0].id;

    const missingReason = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments/${cashPaymentId}/reversals`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 5, reason: '' }),
    });
    assert.equal(missingReason.response.status, 400);
    assert.equal(missingReason.body.code, 'INVALID_PAYMENT_REVERSAL_REASON');

    const overReversal = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments/${cashPaymentId}/reversals`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 30, reason: 'Error manual' }),
    });
    assert.equal(overReversal.response.status, 409);
    assert.equal(overReversal.body.code, 'PAYMENT_REVERSAL_OVERFLOW');
    assert.equal(overReversal.body.reversible_amount, 25);

    const reversal = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments/${cashPaymentId}/reversals`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 10, reason: 'Cobro duplicado' }),
    });
    assert.equal(reversal.response.status, 201);
    assert.equal(reversal.body.amount_paid, 15);
    assert.equal(reversal.body.amount_due, 25);
    assert.equal(reversal.body.payment_status, 'partial');
    assert.equal(reversal.body.payment_received_at, null);
    assert.equal(reversal.body.payment_method, 'cash');
    assert.equal(reversal.body.payments[0].reversed_amount, 10);
    assert.equal(reversal.body.payments[0].net_amount, 15);
    assert.equal(reversal.body.payments[0].reversible_amount, 15);
    assert.equal(reversal.body.payments[0].reversals.length, 1);

    const currentRegisterAfterReversal = await requestJson(`${baseUrl}/api/admin/cash-register/current`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(currentRegisterAfterReversal.response.status, 200);
    assert.equal(currentRegisterAfterReversal.body.expected_cash_amount, 65);
    assert.equal(currentRegisterAfterReversal.body.summary.cash_payments_amount, 15);
    assert.equal(currentRegisterAfterReversal.body.summary.total_reversals_count, 1);

    const secondPayment = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 25, method: 'card', note: 'Saldo final' }),
    });
    assert.equal(secondPayment.response.status, 201);
    assert.equal(secondPayment.body.amount_paid, 40);
    assert.equal(secondPayment.body.amount_due, 0);
    assert.equal(secondPayment.body.payment_status, 'paid');
    assert.equal(secondPayment.body.payment_method, 'split');
    assert.equal(secondPayment.body.can_close, true);

    const closeOrder = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/close`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    assert.equal(closeOrder.response.status, 200);
    assert.ok(closeOrder.body.closed_at);

    const reversalOnClosedOrder = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments/${cashPaymentId}/reversals`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 5, reason: 'Tarde' }),
    });
    assert.equal(reversalOnClosedOrder.response.status, 409);
    assert.equal(reversalOnClosedOrder.body.code, 'ORDER_ALREADY_CLOSED');

    const legacyOrderId = await insertLegacyClosedOrder(dbPath, {
      tableId: 9,
      itemId,
      totalAmount: 12,
      paymentMethod: 'transfer',
    });

    const history = await requestJson(`${baseUrl}/api/admin/orders/history?preset=today`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(history.response.status, 200);
    const closedOrder = history.body.orders.find((order) => order.id === orderId);
    assert.ok(closedOrder);
    assert.equal(closedOrder.payment_method, 'split');
    const legacyOrder = history.body.orders.find((order) => order.id === legacyOrderId);
    assert.ok(legacyOrder);
    assert.equal(legacyOrder.payment_status, 'paid');
    assert.equal(legacyOrder.amount_paid, 12);
    assert.equal(legacyOrder.amount_due, 0);
    assert.equal(legacyOrder.payments.length, 1);
    assert.equal(legacyOrder.payments[0].legacy, true);

    const mpOrderId = await createDeliveredOrder(baseUrl, dbPath, {
      tableId: 2,
      itemId,
      quantity: 1,
      billAttended: true,
    });

    const checkoutCreated = await requestJson(`${baseUrl}/api/tables/2/mercado-pago/checkout`, {
      method: 'POST',
    });
    assert.equal(checkoutCreated.response.status, 201);

    const returned = await fetch(checkoutCreated.body.checkout_url, { redirect: 'manual' });
    assert.equal(returned.status, 302);

    const mpPaymentSummary = await requestJson(`${baseUrl}/api/admin/orders/${mpOrderId}/payments`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(mpPaymentSummary.response.status, 200);
    assert.equal(mpPaymentSummary.body.payment_status, 'paid');
    assert.equal(mpPaymentSummary.body.payments.length, 1);
    const mpPaymentId = mpPaymentSummary.body.payments[0].id;

    const mpReversal = await requestJson(`${baseUrl}/api/admin/orders/${mpOrderId}/payments/${mpPaymentId}/reversals`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 20, reason: 'Reversión manual MP' }),
    });
    assert.equal(mpReversal.response.status, 201);
    assert.equal(mpReversal.body.amount_paid, 0);
    assert.equal(mpReversal.body.amount_due, 20);
    assert.equal(mpReversal.body.payment_status, 'unpaid');
    assert.equal(mpReversal.body.payment_method, null);
    assert.equal(mpReversal.body.payments[0].fully_reversed, true);

    const duplicateMpReversal = await requestJson(`${baseUrl}/api/admin/orders/${mpOrderId}/payments/${mpPaymentId}/reversals`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 1, reason: 'Duplicada' }),
    });
    assert.equal(duplicateMpReversal.response.status, 409);
    assert.equal(duplicateMpReversal.body.code, 'PAYMENT_ALREADY_FULLY_REVERSED');

    const closeRegister = await requestJson(`${baseUrl}/api/admin/cash-register/current/close`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ counted_cash_amount: 65, notes_close: 'Arqueo refunds ok' }),
    });
    assert.equal(closeRegister.response.status, 200);
    assert.equal(closeRegister.body.cash_difference, 0);

    console.log('Sprint 9 backend tests passed');
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

Promise.resolve()
  .then(testMigrationCreatesReversalsTable)
  .then(testRefundsAndVoidsFlow)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
