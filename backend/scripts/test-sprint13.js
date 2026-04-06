const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const migration017 = require('../migrations/017_add_order_bill_splits');

const ADMIN_PASSWORD = 'test-sprint13-admin-password';
const ADMIN_TOKEN_SECRET = 'test-sprint13-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint13-'));
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

async function publishMenu(baseUrl, adminToken) {
  const publish = await requestJson(`${baseUrl}/api/menu/publish`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify({
      name: 'Sprint 13 Split Bill Menu',
      categories: [
        {
          name: 'Mesa',
          items: [
            { name: 'Pasta Split', description: 'Split bill base', price: 30 },
            { name: 'Tabla Grande', description: 'Rounding test', price: 100 },
          ],
        },
      ],
    }),
  });

  assert.equal(publish.response.status, 200);

  const menu = await requestJson(`${baseUrl}/api/menu`);
  assert.equal(menu.response.status, 200);

  const items = menu.body[0].items;
  return {
    pastaId: items.find((item) => item.name === 'Pasta Split').id,
    tablaId: items.find((item) => item.name === 'Tabla Grande').id,
  };
}

async function createOrder(baseUrl, { tableId, itemId, quantity = 1 }) {
  const order = await requestJson(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table_id: tableId,
      items: [{ item_id: itemId, quantity, comments: '' }],
    }),
  });

  assert.equal(order.response.status, 201);
  return order.body;
}

async function markOrderReadyForBilling(dbPath, orderId) {
  const directDb = createSqliteContext(dbPath);

  try {
    await directDb.run(
      `
        UPDATE orders
        SET
          status = 'delivered',
          ready_at = CURRENT_TIMESTAMP,
          delivered_at = CURRENT_TIMESTAMP,
          bill_requested_at = CURRENT_TIMESTAMP,
          bill_attended_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [orderId]
    );
  } finally {
    await directDb.close();
  }
}

async function getBillSplits(baseUrl, adminToken, orderId) {
  const result = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/bill-splits`, {
    headers: authHeaders(adminToken),
  });

  assert.equal(result.response.status, 200);
  return result.body;
}

async function createEqualSplit(baseUrl, adminToken, orderId, count) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/bill-splits/equal`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify({ count }),
  });
}

async function clearBillSplits(baseUrl, adminToken, orderId) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/bill-splits`, {
    method: 'DELETE',
    headers: authHeaders(adminToken),
  });
}

async function createPayment(baseUrl, adminToken, orderId, payload) {
  const result = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify(payload),
  });

  assert.equal(result.response.status, 201);
  return result.body;
}

async function getPaymentSummary(baseUrl, adminToken, orderId) {
  const result = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
    headers: authHeaders(adminToken),
  });

  assert.equal(result.response.status, 200);
  return result.body;
}

async function assignPaymentToSplit(baseUrl, adminToken, orderId, paymentId, splitId) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments/${paymentId}/split-allocation`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify({ split_id: splitId }),
  });
}

async function reversePayment(baseUrl, adminToken, orderId, paymentId, payload) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments/${paymentId}/reversals`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify(payload),
  });
}

async function closeOrder(baseUrl, adminToken, orderId) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/close`, {
    method: 'POST',
    headers: authHeaders(adminToken),
  });
}

async function testMigrationCreatesSplitTablesOnly() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'migration.sqlite');
  const context = createSqliteContext(dbPath);

  try {
    await context.exec(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT
      );

      CREATE TABLE order_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT
      );
    `);

    await migration017.up(context);

    assert.equal(await context.tableExists('order_bill_splits'), true);
    assert.equal(await context.tableExists('order_payment_split_allocations'), true);
    assert.equal(await context.tableExists('order_bill_split_items'), false);

    const splitColumns = await context.all('PRAGMA table_info(order_bill_splits)');
    assert.ok(splitColumns.some((column) => column.name === 'mode'));
    assert.ok(splitColumns.some((column) => column.name === 'position'));
  } finally {
    await context.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testSplitBillPhaseOne(baseUrl, adminToken, dbPath, itemIds) {
  const baseOrder = await createOrder(baseUrl, {
    tableId: 1,
    itemId: itemIds.pastaId,
  });
  await markOrderReadyForBilling(dbPath, baseOrder.id);

  const initialSummary = await getBillSplits(baseUrl, adminToken, baseOrder.id);
  assert.equal(initialSummary.has_split_bill, false);
  assert.equal(initialSummary.can_configure, true);
  assert.equal(initialSummary.groups.length, 0);

  const equalSplit = await createEqualSplit(baseUrl, adminToken, baseOrder.id, 2);
  assert.equal(equalSplit.response.status, 201);
  assert.equal(equalSplit.body.mode, 'equal');
  assert.equal(equalSplit.body.groups.length, 2);
  assert.equal(equalSplit.body.groups[0].label, 'Persona 1');
  assert.equal(equalSplit.body.groups[0].amount_assigned, 15);
  assert.equal(equalSplit.body.groups[1].amount_assigned, 15);

  const firstPaymentOrder = await createPayment(baseUrl, adminToken, baseOrder.id, {
    amount: 15,
    method: 'card',
    note: 'Persona 1',
  });
  const firstPayment = firstPaymentOrder.payments.find((payment) => payment.note === 'Persona 1');
  assert.ok(firstPayment?.id);

  const assignFirstPayment = await assignPaymentToSplit(
    baseUrl,
    adminToken,
    baseOrder.id,
    firstPayment.id,
    equalSplit.body.groups[0].id
  );
  assert.equal(assignFirstPayment.response.status, 200);
  assert.equal(assignFirstPayment.body.groups[0].status, 'settled');
  assert.equal(assignFirstPayment.body.groups[0].amount_paid, 15);
  assert.equal(assignFirstPayment.body.groups[1].amount_due, 15);
  assert.equal(assignFirstPayment.body.amount_paid, 15);
  assert.equal(assignFirstPayment.body.amount_due, 15);

  const blockedReconfigure = await createEqualSplit(baseUrl, adminToken, baseOrder.id, 3);
  assert.equal(blockedReconfigure.response.status, 409);
  assert.equal(blockedReconfigure.body.code, 'BILL_SPLIT_RECONFIGURATION_BLOCKED');

  const blockedClear = await clearBillSplits(baseUrl, adminToken, baseOrder.id);
  assert.equal(blockedClear.response.status, 409);
  assert.equal(blockedClear.body.code, 'BILL_SPLIT_CLEAR_BLOCKED');

  const blockedReversal = await reversePayment(baseUrl, adminToken, baseOrder.id, firstPayment.id, {
    amount: 15,
    reason: 'No debería permitir reversal con split',
  });
  assert.equal(blockedReversal.response.status, 409);
  assert.equal(blockedReversal.body.code, 'PAYMENT_REVERSAL_BLOCKED_BY_SPLIT_ALLOCATION');

  const secondPaymentOrder = await createPayment(baseUrl, adminToken, baseOrder.id, {
    amount: 15,
    method: 'card',
    note: 'Sin asignar',
  });
  const secondPayment = secondPaymentOrder.payments.find((payment) => payment.note === 'Sin asignar');
  assert.ok(secondPayment?.id);

  const summaryWithUnassignedPayment = await getBillSplits(baseUrl, adminToken, baseOrder.id);
  assert.equal(summaryWithUnassignedPayment.amount_paid, 30);
  assert.equal(summaryWithUnassignedPayment.amount_due, 0);
  assert.equal(summaryWithUnassignedPayment.unallocated_summary.payments_total_unallocated, 15);
  assert.equal(
    summaryWithUnassignedPayment.payments.find((payment) => payment.id === secondPayment.id).allocated_split_id,
    null
  );

  const closePaidOrder = await closeOrder(baseUrl, adminToken, baseOrder.id);
  assert.equal(closePaidOrder.response.status, 200);

  const closedSummary = await getBillSplits(baseUrl, adminToken, baseOrder.id);
  assert.equal(closedSummary.can_configure, false);
  assert.equal(closedSummary.has_split_bill, true);
  assert.equal(closedSummary.groups[1].amount_due, 15);

  const roundedOrder = await createOrder(baseUrl, {
    tableId: 2,
    itemId: itemIds.tablaId,
  });
  await markOrderReadyForBilling(dbPath, roundedOrder.id);

  const roundedSplit = await createEqualSplit(baseUrl, adminToken, roundedOrder.id, 3);
  assert.equal(roundedSplit.response.status, 201);
  assert.deepEqual(
    roundedSplit.body.groups.map((group) => group.amount_assigned),
    [33.34, 33.33, 33.33]
  );

  const reconfiguredRoundedSplit = await createEqualSplit(baseUrl, adminToken, roundedOrder.id, 4);
  assert.equal(reconfiguredRoundedSplit.response.status, 201);
  assert.deepEqual(
    reconfiguredRoundedSplit.body.groups.map((group) => group.amount_assigned),
    [25, 25, 25, 25]
  );

  const clearedRoundedSplit = await clearBillSplits(baseUrl, adminToken, roundedOrder.id);
  assert.equal(clearedRoundedSplit.response.status, 200);
  assert.equal(clearedRoundedSplit.body.has_split_bill, false);
  assert.equal(clearedRoundedSplit.body.groups.length, 0);

  const reversedOrder = await createOrder(baseUrl, {
    tableId: 3,
    itemId: itemIds.pastaId,
  });
  await markOrderReadyForBilling(dbPath, reversedOrder.id);

  const reversedPaymentOrder = await createPayment(baseUrl, adminToken, reversedOrder.id, {
    amount: 15,
    method: 'card',
    note: 'Pago con reversal',
  });
  const reversedPayment = reversedPaymentOrder.payments.find((payment) => payment.note === 'Pago con reversal');
  assert.ok(reversedPayment?.id);

  const splitAfterPayment = await createEqualSplit(baseUrl, adminToken, reversedOrder.id, 2);
  assert.equal(splitAfterPayment.response.status, 201);

  const reversalCreated = await reversePayment(baseUrl, adminToken, reversedOrder.id, reversedPayment.id, {
    amount: 5,
    reason: 'Ajuste parcial',
  });
  assert.equal(reversalCreated.response.status, 201);

  const blockedSplitAssignment = await assignPaymentToSplit(
    baseUrl,
    adminToken,
    reversedOrder.id,
    reversedPayment.id,
    splitAfterPayment.body.groups[0].id
  );
  assert.equal(blockedSplitAssignment.response.status, 409);
  assert.equal(blockedSplitAssignment.body.code, 'PAYMENT_SPLIT_ALLOCATION_BLOCKED');

  const overflowOrder = await createOrder(baseUrl, {
    tableId: 4,
    itemId: itemIds.pastaId,
  });
  await markOrderReadyForBilling(dbPath, overflowOrder.id);

  const overflowSplit = await createEqualSplit(baseUrl, adminToken, overflowOrder.id, 2);
  assert.equal(overflowSplit.response.status, 201);

  const overflowPaymentOrder = await createPayment(baseUrl, adminToken, overflowOrder.id, {
    amount: 20,
    method: 'card',
    note: 'Pago demasiado grande',
  });
  const overflowPayment = overflowPaymentOrder.payments.find((payment) => payment.note === 'Pago demasiado grande');
  assert.ok(overflowPayment?.id);

  const blockedOverflow = await assignPaymentToSplit(
    baseUrl,
    adminToken,
    overflowOrder.id,
    overflowPayment.id,
    overflowSplit.body.groups[0].id
  );
  assert.equal(blockedOverflow.response.status, 409);
  assert.equal(blockedOverflow.body.code, 'BILL_SPLIT_PAYMENT_OVERFLOW');

  const paymentSummary = await getPaymentSummary(baseUrl, adminToken, baseOrder.id);
  assert.ok(paymentSummary.bill_splits_summary);
  assert.equal(paymentSummary.bill_splits_summary.groups.length, 2);
}

async function main() {
  await testMigrationCreatesSplitTablesOnly();

  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'database.sqlite');
  const port = 3360 + Math.floor(Math.random() * 100);
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
    const itemIds = await publishMenu(baseUrl, adminToken);
    await testSplitBillPhaseOne(baseUrl, adminToken, dbPath, itemIds);
    console.log('PASS split bill equal phase 1');
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
