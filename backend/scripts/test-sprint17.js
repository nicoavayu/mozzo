const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const ADMIN_PASSWORD = 'test-sprint17-admin-password';
const ADMIN_TOKEN_SECRET = 'test-sprint17-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint17-'));
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

  return { run, get, all, close };
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

function authHeaders(token, includeJson = false) {
  return {
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${token}`,
  };
}

async function loginOwner(baseUrl) {
  const login = await requestJson(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });

  assert.equal(login.response.status, 200);
  assert.ok(login.body.token);
  return login.body.token;
}

async function createStaff(baseUrl, ownerToken, payload) {
  return requestJson(`${baseUrl}/api/admin/staff`, {
    method: 'POST',
    headers: authHeaders(ownerToken, true),
    body: JSON.stringify(payload),
  });
}

async function loginStaff(baseUrl, loginCode, pin) {
  return requestJson(`${baseUrl}/api/admin/staff/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      login_code: loginCode,
      pin,
    }),
  });
}

async function publishMenu(baseUrl, token) {
  const publish = await requestJson(`${baseUrl}/api/menu/publish`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({
      name: 'Sprint 17 Cancel Menu',
      categories: [
        {
          name: 'Pruebas',
          items: [
            { name: 'Principal Cancel', description: 'Principal', price: 30 },
            { name: 'Extra Cancel', description: 'Extra', price: 20 },
          ],
        },
      ],
    }),
  });

  assert.equal(publish.response.status, 200, JSON.stringify(publish.body));

  const menu = await requestJson(`${baseUrl}/api/menu`);
  assert.equal(menu.response.status, 200);
  return {
    mainItemId: menu.body[0].items.find((item) => item.name === 'Principal Cancel').id,
    extraItemId: menu.body[0].items.find((item) => item.name === 'Extra Cancel').id,
  };
}

async function createOrder(baseUrl, tableId, itemId, quantity = 1) {
  const response = await requestJson(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table_id: tableId,
      items: [{ item_id: itemId, quantity, comments: '' }],
    }),
  });

  assert.equal(response.response.status, 201, JSON.stringify(response.body));
  return response.body;
}

async function appendSuborder(baseUrl, tableId, itemId, quantity = 1) {
  const response = await requestJson(`${baseUrl}/api/tables/${tableId}/suborders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ item_id: itemId, quantity, comments: '' }],
    }),
  });

  assert.equal(response.response.status, 201, JSON.stringify(response.body));
  return response.body;
}

async function updateSuborderStatus(baseUrl, token, suborderId, status, extra = {}) {
  return requestJson(`${baseUrl}/api/admin/suborders/${suborderId}/status`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({
      status,
      ...(extra.reason ? { reason: extra.reason } : {}),
    }),
  });
}

async function getOrderPaymentSummary(baseUrl, token, orderId) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
    headers: authHeaders(token),
  });
}

async function listOpenOrders(baseUrl, token) {
  return requestJson(`${baseUrl}/api/admin/orders/open`, {
    headers: authHeaders(token),
  });
}

async function setOrderFields(dbPath, orderId, fields = {}) {
  const context = createSqliteContext(dbPath);

  try {
    const assignments = [];
    const params = [];

    for (const [column, value] of Object.entries(fields)) {
      assignments.push(`${column} = ?`);
      params.push(value);
    }

    if (assignments.length === 0) {
      return;
    }

    await context.run(
      `
        UPDATE orders
        SET ${assignments.join(', ')}
        WHERE id = ?
      `,
      [...params, orderId]
    );
  } finally {
    await context.close();
  }
}

async function insertOrderPayment(dbPath, orderId, amount) {
  const context = createSqliteContext(dbPath);

  try {
    await context.run(
      `
        INSERT INTO order_payments (
          order_id,
          cash_register_session_id,
          amount,
          method,
          note,
          created_by
        )
        VALUES (?, NULL, ?, 'card', 'Pago manual test', 'test-suite')
      `,
      [orderId, amount]
    );
  } finally {
    await context.close();
  }
}

async function insertBillSplit(dbPath, orderId) {
  const context = createSqliteContext(dbPath);

  try {
    await context.run(
      `
        INSERT INTO order_bill_splits (
          order_id,
          label,
          mode,
          position,
          status
        )
        VALUES (?, 'Persona 1', 'equal', 1, 'open')
      `,
      [orderId]
    );
  } finally {
    await context.close();
  }
}

async function assertMigrationApplied(dbPath) {
  const context = createSqliteContext(dbPath);

  try {
    const tables = await context.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'order_charge_adjustments'"
    );
    assert.equal(tables.length, 1);

    const columns = await context.all('PRAGMA table_info(order_charge_adjustments)');
    assert.ok(columns.some((column) => column.name === 'suborder_id'));
    assert.ok(columns.some((column) => column.name === 'amount_delta'));
    assert.ok(columns.some((column) => column.name === 'created_by'));
  } finally {
    await context.close();
  }
}

async function main() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'database.sqlite');
  const port = 3570 + Math.floor(Math.random() * 100);
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
    await assertMigrationApplied(dbPath);

    const ownerToken = await loginOwner(baseUrl);
    const createManagerResponse = await createStaff(baseUrl, ownerToken, {
      name: 'Mara Manager',
      login_code: 'MGR17',
      role: 'manager',
      pin: '1717',
    });
    assert.equal(createManagerResponse.response.status, 201, JSON.stringify(createManagerResponse.body));

    const managerLogin = await loginStaff(baseUrl, 'MGR17', '1717');
    assert.equal(managerLogin.response.status, 201, JSON.stringify(managerLogin.body));
    const managerToken = managerLogin.body.token;

    const { mainItemId, extraItemId } = await publishMenu(baseUrl, ownerToken);

    const baseOrder = await createOrder(baseUrl, 1, mainItemId);
    const extraSuborder = await appendSuborder(baseUrl, 1, extraItemId);
    assert.equal(extraSuborder.order.total_amount, 50);

    const cancelled = await updateSuborderStatus(baseUrl, managerToken, extraSuborder.suborder.id, 'cancelled', {
      reason: 'Sin stock en cocina',
    });
    assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.suborder.status, 'cancelled');
    assert.match(cancelled.body.suborder.cancelled_by || '', /staff#\d+:Mara Manager:manager/);
    assert.equal(cancelled.body.order.items_total_amount, 50);
    assert.equal(cancelled.body.order.charge_adjustments_total, -20);
    assert.equal(cancelled.body.order.total_amount, 30);
    assert.equal(cancelled.body.order.amount_due, 30);
    assert.equal(cancelled.body.order.charge_adjustments.length, 1);
    assert.equal(cancelled.body.order.charge_adjustments[0].suborder_id, extraSuborder.suborder.id);
    assert.equal(cancelled.body.order.charge_adjustments[0].reason, 'Sin stock en cocina');
    assert.match(cancelled.body.order.charge_adjustments[0].created_by || '', /staff#\d+:Mara Manager:manager/);

    const paymentSummary = await getOrderPaymentSummary(baseUrl, ownerToken, baseOrder.id);
    assert.equal(paymentSummary.response.status, 200);
    assert.equal(paymentSummary.body.items_total_amount, 50);
    assert.equal(paymentSummary.body.charge_adjustments_total, -20);
    assert.equal(paymentSummary.body.total_amount, 30);
    assert.equal(paymentSummary.body.charge_adjustments.length, 1);

    const openOrders = await listOpenOrders(baseUrl, ownerToken);
    assert.equal(openOrders.response.status, 200);
    const cancelledOrder = openOrders.body.find((order) => order.id === baseOrder.id);
    assert.equal(cancelledOrder.total_amount, 30);
    assert.equal(cancelledOrder.charge_adjustments_total, -20);

    const cancelAgain = await updateSuborderStatus(baseUrl, managerToken, extraSuborder.suborder.id, 'cancelled');
    assert.equal(cancelAgain.response.status, 409);
    assert.equal(cancelAgain.body.code, 'SUBORDER_ALREADY_CANCELLED');

    const deliveredOrder = await createOrder(baseUrl, 2, mainItemId);
    const deliveredSuborder = await appendSuborder(baseUrl, 2, extraItemId);
    assert.equal((await updateSuborderStatus(baseUrl, managerToken, deliveredSuborder.suborder.id, 'processing')).response.status, 200);
    assert.equal((await updateSuborderStatus(baseUrl, managerToken, deliveredSuborder.suborder.id, 'ready')).response.status, 200);
    assert.equal((await updateSuborderStatus(baseUrl, managerToken, deliveredSuborder.suborder.id, 'delivered')).response.status, 200);
    const cancelDelivered = await updateSuborderStatus(baseUrl, managerToken, deliveredSuborder.suborder.id, 'cancelled');
    assert.equal(cancelDelivered.response.status, 409);
    assert.equal(cancelDelivered.body.code, 'SUBORDER_ALREADY_DELIVERED');

    const billOrder = await createOrder(baseUrl, 3, mainItemId);
    const billSuborder = await appendSuborder(baseUrl, 3, extraItemId);
    await setOrderFields(dbPath, billOrder.id, { bill_requested_at: new Date().toISOString() });
    const blockedByBill = await updateSuborderStatus(baseUrl, managerToken, billSuborder.suborder.id, 'cancelled');
    assert.equal(blockedByBill.response.status, 409);
    assert.equal(blockedByBill.body.code, 'SUBORDER_CANCELLATION_BLOCKED_BY_BILL_FLOW');

    const paymentBlockedOrder = await createOrder(baseUrl, 4, mainItemId);
    const paymentBlockedSuborder = await appendSuborder(baseUrl, 4, extraItemId);
    await insertOrderPayment(dbPath, paymentBlockedOrder.id, 5);
    const blockedByPayment = await updateSuborderStatus(baseUrl, managerToken, paymentBlockedSuborder.suborder.id, 'cancelled');
    assert.equal(blockedByPayment.response.status, 409);
    assert.equal(blockedByPayment.body.code, 'SUBORDER_CANCELLATION_BLOCKED_BY_PAYMENTS');

    const splitBlockedOrder = await createOrder(baseUrl, 5, mainItemId);
    const splitBlockedSuborder = await appendSuborder(baseUrl, 5, extraItemId);
    await insertBillSplit(dbPath, splitBlockedOrder.id);
    const blockedBySplit = await updateSuborderStatus(baseUrl, managerToken, splitBlockedSuborder.suborder.id, 'cancelled');
    assert.equal(blockedBySplit.response.status, 409);
    assert.equal(blockedBySplit.body.code, 'SUBORDER_CANCELLATION_BLOCKED_BY_SPLIT_BILL');

    const closedOrder = await createOrder(baseUrl, 6, mainItemId);
    const closedSuborder = await appendSuborder(baseUrl, 6, extraItemId);
    await setOrderFields(dbPath, closedOrder.id, { closed_at: new Date().toISOString() });
    const blockedClosed = await updateSuborderStatus(baseUrl, managerToken, closedSuborder.suborder.id, 'cancelled');
    assert.equal(blockedClosed.response.status, 409);
    assert.equal(blockedClosed.body.code, 'ORDER_ALREADY_CLOSED');

    console.log('PASS sprint17 suborder cancellation keeps totals append-only');
  } finally {
    server.kill('SIGTERM');
    await sleep(500);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
