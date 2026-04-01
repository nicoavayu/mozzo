const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const migration011 = require('../migrations/011_add_cash_register_and_order_payments');

const ADMIN_PASSWORD = 'test-sprint7-admin-password';
const ADMIN_TOKEN_SECRET = 'test-sprint7-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint7-'));
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
  const response = await requestJson(`${baseUrl}/api/menu/publish`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify({
      name: 'Sprint 7 Test Menu',
      categories: [
        {
          name: 'Principales',
          items: [
            {
              name: 'Suprema Sprint 7',
              description: 'Prueba caja y split',
              price: 24,
            },
            {
              name: 'Cortesía Sprint 7',
              description: 'Item de total cero',
              price: 0,
            },
          ],
        },
      ],
    }),
  });

  assert.equal(response.response.status, 200);
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
          ready_at = CURRENT_TIMESTAMP,
          bill_requested_at = CURRENT_TIMESTAMP,
          bill_attended_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [orderResponse.body.id]
    );
  } finally {
    await directDb.close();
  }

  return orderResponse.body.id;
}

async function testMigrationCreatesTables() {
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
    `);

    await migration011.up(context);

    assert.equal(await context.tableExists('cash_register_sessions'), true);
    assert.equal(await context.tableExists('order_payments'), true);

    const orderPaymentsColumns = await context.all('PRAGMA table_info(order_payments)');
    const cashRegisterColumns = await context.all('PRAGMA table_info(cash_register_sessions)');

    assert.ok(orderPaymentsColumns.some((column) => column.name === 'order_id'));
    assert.ok(orderPaymentsColumns.some((column) => column.name === 'method'));
    assert.ok(cashRegisterColumns.some((column) => column.name === 'opening_float'));
    assert.ok(cashRegisterColumns.some((column) => column.name === 'cash_difference'));

    console.log('PASS migration caja + pagos');
  } finally {
    await context.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testCashRegisterAndSplitPayments() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'integration.sqlite');
  const port = 4200 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      ADMIN_PASSWORD,
      ADMIN_TOKEN_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    server.stderr.on('data', (chunk) => process.stderr.write(chunk.toString()));
    await waitForServer(baseUrl);
    const adminToken = await loginAdmin(baseUrl);

    const concurrentOpenResults = await Promise.all([
      requestJson(`${baseUrl}/api/admin/cash-register/open`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({ opening_float: 100, notes_open: 'Apertura A' }),
      }),
      requestJson(`${baseUrl}/api/admin/cash-register/open`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({ opening_float: 50, notes_open: 'Apertura B' }),
      }),
    ]);
    const concurrentStatuses = concurrentOpenResults.map((result) => result.response.status).sort();
    assert.deepEqual(concurrentStatuses, [201, 409]);
    assert.ok(concurrentOpenResults.some((result) => result.body?.code === 'CASH_REGISTER_ALREADY_OPEN'));

    await publishMenu(baseUrl, adminToken);
    const menu = await requestJson(`${baseUrl}/api/menu`);
    const pricedItemId = menu.body[0].items[0].id;
    const zeroPriceItemId = menu.body[0].items[1].id;

    const orderId = await createDeliveredOrder(baseUrl, dbPath, {
      tableId: 7,
      itemId: pricedItemId,
      quantity: 2,
    });

    const partialPayment = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 20, method: 'cash', note: 'Primera parte' }),
    });
    assert.equal(partialPayment.response.status, 201);
    assert.equal(partialPayment.body.amount_paid, 20);
    assert.equal(partialPayment.body.amount_due, 28);
    assert.equal(partialPayment.body.payment_status, 'partial');
    assert.equal(partialPayment.body.closed_at, null);

    const zeroPayment = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 0, method: 'card' }),
    });
    assert.equal(zeroPayment.response.status, 400);
    assert.equal(zeroPayment.body.code, 'INVALID_PAYMENT_AMOUNT');

    const negativePayment = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: -10, method: 'card' }),
    });
    assert.equal(negativePayment.response.status, 400);
    assert.equal(negativePayment.body.code, 'INVALID_PAYMENT_AMOUNT');

    const roundedToZeroPayment = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 0.001, method: 'card' }),
    });
    assert.equal(roundedToZeroPayment.response.status, 400);
    assert.equal(roundedToZeroPayment.body.code, 'INVALID_PAYMENT_AMOUNT');

    const overpay = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 30, method: 'card' }),
    });
    assert.equal(overpay.response.status, 409);
    assert.equal(overpay.body.code, 'PAYMENT_OVERFLOW');

    const closeWithDue = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/close`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    assert.equal(closeWithDue.response.status, 409);
    assert.equal(closeWithDue.body.code, 'ORDER_BALANCE_PENDING');
    assert.equal(closeWithDue.body.amount_due, 28);

    const finalPayment = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 28, method: 'card', note: 'Saldo final' }),
    });
    assert.equal(finalPayment.response.status, 201);
    assert.equal(finalPayment.body.amount_paid, 48);
    assert.equal(finalPayment.body.amount_due, 0);
    assert.equal(finalPayment.body.payment_status, 'paid');
    assert.equal(finalPayment.body.closed_at, null);
    assert.equal(finalPayment.body.payment_method, 'split');

    const alreadyPaid = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 1, method: 'card' }),
    });
    assert.equal(alreadyPaid.response.status, 409);
    assert.equal(alreadyPaid.body.code, 'ORDER_ALREADY_PAID');

    const paymentsList = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(paymentsList.response.status, 200);
    assert.equal(paymentsList.body.payments.length, 2);

    const concurrentCloseResults = await Promise.all([
      requestJson(`${baseUrl}/api/admin/orders/${orderId}/close`, {
        method: 'POST',
        headers: authHeaders(adminToken),
      }),
      requestJson(`${baseUrl}/api/admin/orders/${orderId}/close`, {
        method: 'POST',
        headers: authHeaders(adminToken),
      }),
    ]);
    const closeStatuses = concurrentCloseResults.map((result) => result.response.status).sort();
    assert.deepEqual(closeStatuses, [200, 409]);
    assert.ok(concurrentCloseResults.some((result) => result.body?.closed_at));
    assert.ok(concurrentCloseResults.some((result) => result.body?.code === 'ORDER_ALREADY_CLOSED'));

    const paymentAfterClose = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 1, method: 'card' }),
    });
    assert.equal(paymentAfterClose.response.status, 409);
    assert.equal(paymentAfterClose.body.code, 'ORDER_ALREADY_CLOSED');

    const currentRegister = await requestJson(`${baseUrl}/api/admin/cash-register/current`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(currentRegister.response.status, 200);
    assert.equal(currentRegister.body.expected_cash_amount, 120);

    const closeWithoutCount = await requestJson(`${baseUrl}/api/admin/cash-register/current/close`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ counted_cash_amount: '', notes_close: 'Inválido' }),
    });
    assert.equal(closeWithoutCount.response.status, 400);
    assert.equal(closeWithoutCount.body.code, 'INVALID_CASH_REGISTER_AMOUNT');

    const closeRegister = await requestJson(`${baseUrl}/api/admin/cash-register/current/close`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({
        counted_cash_amount: 119,
        notes_close: 'Cierre test',
      }),
    });
    assert.equal(closeRegister.response.status, 200);
    assert.equal(closeRegister.body.status, 'closed');
    assert.equal(closeRegister.body.expected_cash_amount, 120);
    assert.equal(closeRegister.body.cash_difference, -1);

    const closeRegisterAgain = await requestJson(`${baseUrl}/api/admin/cash-register/current/close`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({
        counted_cash_amount: 119,
      }),
    });
    assert.equal(closeRegisterAgain.response.status, 404);
    assert.equal(closeRegisterAgain.body.code, 'NO_OPEN_CASH_REGISTER');

    const cashWithoutRegisterOrderId = await createDeliveredOrder(baseUrl, dbPath, {
      tableId: 8,
      itemId: pricedItemId,
      quantity: 1,
    });
    const cashWithoutRegister = await requestJson(`${baseUrl}/api/admin/orders/${cashWithoutRegisterOrderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 24, method: 'cash' }),
    });
    assert.equal(cashWithoutRegister.response.status, 409);
    assert.equal(cashWithoutRegister.body.code, 'OPEN_CASH_REGISTER_REQUIRED');

    const cardWithoutRegisterOrderId = await createDeliveredOrder(baseUrl, dbPath, {
      tableId: 9,
      itemId: pricedItemId,
      quantity: 1,
    });
    const cardWithoutRegister = await requestJson(`${baseUrl}/api/admin/orders/${cardWithoutRegisterOrderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 24, method: 'card', note: 'Sin caja abierta' }),
    });
    assert.equal(cardWithoutRegister.response.status, 201);
    assert.equal(cardWithoutRegister.body.payment_status, 'paid');
    const cardWithoutRegisterPayments = await requestJson(`${baseUrl}/api/admin/orders/${cardWithoutRegisterOrderId}/payments`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(cardWithoutRegisterPayments.response.status, 200);
    assert.equal(cardWithoutRegisterPayments.body.payments[0].cash_register_session_id, null);

    const closeCardOrder = await requestJson(`${baseUrl}/api/admin/orders/${cardWithoutRegisterOrderId}/close`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    assert.equal(closeCardOrder.response.status, 200);

    const zeroTotalOrderId = await createDeliveredOrder(baseUrl, dbPath, {
      tableId: 10,
      itemId: zeroPriceItemId,
      quantity: 1,
    });
    const zeroTotalClose = await requestJson(`${baseUrl}/api/admin/orders/${zeroTotalOrderId}/close`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    assert.equal(zeroTotalClose.response.status, 200);
    assert.ok(zeroTotalClose.body.closed_at);
    assert.equal(zeroTotalClose.body.total_amount, 0);
    assert.equal(zeroTotalClose.body.amount_due, 0);

    const directDbLegacy = createSqliteContext(dbPath);
    try {
      const legacyOrderInsert = await directDbLegacy.run(
        `
          INSERT INTO orders (
            table_id,
            status,
            created_at,
            ready_at,
            delivered_at,
            bill_requested_at,
            bill_attended_at,
            payment_received_at,
            payment_method,
            closed_at
          )
          VALUES (?, 'delivered', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'cash', CURRENT_TIMESTAMP)
        `,
        [88]
      );

      await directDbLegacy.run(
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
          VALUES (?, ?, 1, '', 'Legacy milanesa', 'Compatibilidad', 50)
        `,
        [legacyOrderInsert.lastID, pricedItemId]
      );

      await directDbLegacy.run(
        `
          INSERT INTO order_payments (
            order_id,
            cash_register_session_id,
            amount,
            method,
            note,
            created_by
          )
          VALUES (?, NULL, 20, 'card', 'Pago parcial nuevo', 'test')
        `,
        [legacyOrderInsert.lastID]
      );
    } finally {
      await directDbLegacy.close();
    }

    const history = await requestJson(`${baseUrl}/api/admin/orders/history?preset=today&limit=50`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(history.response.status, 200);
    assert.ok(history.body.orders.some((order) => order.id === orderId));

    const legacyOrder = history.body.orders.find((order) => order.table_id === 88);
    assert.ok(legacyOrder);
    assert.equal(legacyOrder.payment_status, 'paid');
    assert.equal(legacyOrder.amount_paid, 50);
    assert.equal(legacyOrder.amount_due, 0);
    assert.equal(legacyOrder.payment_method, 'split');
    assert.equal(legacyOrder.payments.length, 2);

    const missingOrderPayment = await requestJson(`${baseUrl}/api/admin/orders/999999/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 10, method: 'card' }),
    });
    assert.equal(missingOrderPayment.response.status, 404);
    assert.equal(missingOrderPayment.body.code, 'ORDER_NOT_FOUND');

    const registerHistory = await requestJson(`${baseUrl}/api/admin/cash-register/history`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(registerHistory.response.status, 200);
    assert.ok(registerHistory.body.length >= 1);

    console.log('PASS caja + split + cierre separado');
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testOpenRegisterPersistsAcrossRestart() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'restart.sqlite');
  const port = 5200 + Math.floor(Math.random() * 500);
  const baseEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    ADMIN_PASSWORD,
    ADMIN_TOKEN_SECRET,
  };
  const baseUrl = `http://127.0.0.1:${port}`;

  const startServer = () => spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: baseEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let server = startServer();

  try {
    server.stderr.on('data', (chunk) => process.stderr.write(chunk.toString()));
    await waitForServer(baseUrl);
    const adminToken = await loginAdmin(baseUrl);

    const openRegister = await requestJson(`${baseUrl}/api/admin/cash-register/open`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ opening_float: 75, notes_open: 'Persistencia' }),
    });
    assert.equal(openRegister.response.status, 201);

    server.kill('SIGTERM');
    await sleep(400);

    server = startServer();
    server.stderr.on('data', (chunk) => process.stderr.write(chunk.toString()));
    await waitForServer(baseUrl);
    const secondAdminToken = await loginAdmin(baseUrl);

    const currentRegister = await requestJson(`${baseUrl}/api/admin/cash-register/current`, {
      headers: authHeaders(secondAdminToken),
    });
    assert.equal(currentRegister.response.status, 200);
    assert.ok(currentRegister.body);
    assert.equal(currentRegister.body.status, 'open');
    assert.equal(currentRegister.body.opening_float, 75);

    const closeRegister = await requestJson(`${baseUrl}/api/admin/cash-register/current/close`, {
      method: 'POST',
      headers: authHeaders(secondAdminToken, true),
      body: JSON.stringify({
        counted_cash_amount: 80,
        notes_close: 'Cierre tras reinicio',
      }),
    });
    assert.equal(closeRegister.response.status, 200);
    assert.equal(closeRegister.body.cash_difference, 5);

    console.log('PASS persistencia de caja abierta tras reinicio');
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  await testMigrationCreatesTables();
  await testCashRegisterAndSplitPayments();
  await testOpenRegisterPersistsAcrossRestart();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
