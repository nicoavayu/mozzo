const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const ADMIN_PASSWORD = 'test-sprint15-admin-password';
const ADMIN_TOKEN_SECRET = 'test-sprint15-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint15-'));
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

  return { run, close };
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

async function publishMenu(baseUrl, adminToken) {
  const publish = await requestJson(`${baseUrl}/api/menu/publish`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify({
      name: 'Sprint 15 Table Split Menu',
      categories: [
        {
          name: 'Mesa',
          items: [
            { name: 'Tabla Split Cliente', description: 'Split desde la mesa', price: 30 },
          ],
        },
      ],
    }),
  });

  assert.equal(publish.response.status, 200);

  const menu = await requestJson(`${baseUrl}/api/menu`);
  assert.equal(menu.response.status, 200);
  return menu.body[0].items.find((item) => item.name === 'Tabla Split Cliente').id;
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

  assert.equal(order.response.status, 201, JSON.stringify(order.body));
  return order.body;
}

async function markOrderDelivered(dbPath, orderId, { billAttended = false } = {}) {
  const context = createSqliteContext(dbPath);

  try {
    await context.run(
      `
        UPDATE orders
        SET
          status = 'delivered',
          ready_at = CURRENT_TIMESTAMP,
          delivered_at = CURRENT_TIMESTAMP,
          bill_attended_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE bill_attended_at END
        WHERE id = ?
      `,
      [billAttended ? 1 : 0, orderId]
    );
  } finally {
    await context.close();
  }
}

async function requestBill(baseUrl, tableId, payload) {
  return requestJson(`${baseUrl}/api/tables/${tableId}/request-bill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function cancelBillRequest(baseUrl, tableId) {
  return requestJson(`${baseUrl}/api/tables/${tableId}/request-bill`, {
    method: 'DELETE',
  });
}

async function getBillSplits(baseUrl, adminToken, orderId) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/bill-splits`, {
    headers: authHeaders(adminToken),
  });
}

async function createPayment(baseUrl, adminToken, orderId, payload) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify(payload),
  });
}

async function assignPaymentToSplit(baseUrl, adminToken, orderId, paymentId, splitId) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments/${paymentId}/split-allocation`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify({ split_id: splitId }),
  });
}

async function testTableBillSplitFlow(baseUrl, adminToken, dbPath, itemId) {
  const orderBetweenThree = await createOrder(baseUrl, { tableId: 1, itemId });
  await markOrderDelivered(dbPath, orderBetweenThree.id);

  const splitBetweenThree = await requestBill(baseUrl, 1, {
    preferred_payment_method: 'cash',
    split_count: 3,
  });
  assert.equal(splitBetweenThree.response.status, 201, JSON.stringify(splitBetweenThree.body));
  assert.equal(splitBetweenThree.body.preferred_payment_method, 'cash');
  assert.equal(splitBetweenThree.body.split_count, 3);
  assert.equal(splitBetweenThree.body.order.bill_splits_summary.has_split_bill, true);
  assert.equal(splitBetweenThree.body.order.bill_splits_summary.groups.length, 3);

  const adminViewBetweenThree = await getBillSplits(baseUrl, adminToken, orderBetweenThree.id);
  assert.equal(adminViewBetweenThree.response.status, 200);
  assert.equal(adminViewBetweenThree.body.groups.length, 3);
  assert.deepEqual(
    adminViewBetweenThree.body.groups.map((group) => group.amount_assigned),
    [10, 10, 10]
  );

  const orderWithoutSplit = await createOrder(baseUrl, { tableId: 2, itemId });
  await markOrderDelivered(dbPath, orderWithoutSplit.id);

  const noSplit = await requestBill(baseUrl, 2, {
    preferred_payment_method: 'card',
    split_count: 1,
  });
  assert.equal(noSplit.response.status, 201, JSON.stringify(noSplit.body));
  assert.equal(noSplit.body.split_count, null);
  assert.equal(noSplit.body.order.bill_splits_summary.has_split_bill, false);

  const reconfigurableOrder = await createOrder(baseUrl, { tableId: 3, itemId });
  await markOrderDelivered(dbPath, reconfigurableOrder.id);

  const splitBetweenTwo = await requestBill(baseUrl, 3, {
    preferred_payment_method: 'cash',
    split_count: 2,
  });
  assert.equal(splitBetweenTwo.response.status, 201);
  assert.equal(splitBetweenTwo.body.order.bill_splits_summary.groups.length, 2);

  const splitBetweenFour = await requestBill(baseUrl, 3, {
    preferred_payment_method: 'cash',
    split_count: 4,
  });
  assert.equal(splitBetweenFour.response.status, 200);
  assert.equal(splitBetweenFour.body.table_request.already_pending, true);
  assert.equal(splitBetweenFour.body.order.bill_splits_summary.groups.length, 4);

  const clearedSplit = await requestBill(baseUrl, 3, {
    preferred_payment_method: 'cash',
    split_count: 1,
  });
  assert.equal(clearedSplit.response.status, 200);
  assert.equal(clearedSplit.body.order.bill_splits_summary.has_split_bill, false);

  const lockedOrder = await createOrder(baseUrl, { tableId: 4, itemId });
  await markOrderDelivered(dbPath, lockedOrder.id, { billAttended: true });

  const lockedSplit = await requestBill(baseUrl, 4, {
    preferred_payment_method: 'cash',
    split_count: 2,
  });
  assert.equal(lockedSplit.response.status, 201);
  assert.equal(lockedSplit.body.order.bill_splits_summary.groups.length, 2);

  const paymentCreated = await createPayment(baseUrl, adminToken, lockedOrder.id, {
    amount: 15,
    method: 'card',
    note: 'Pago cliente split',
  });
  assert.equal(paymentCreated.response.status, 201, JSON.stringify(paymentCreated.body));
  const payment = paymentCreated.body.payments.find((entry) => entry.note === 'Pago cliente split');
  assert.ok(payment?.id);

  const splitGroupId = lockedSplit.body.order.bill_splits_summary.groups[0].id;
  const allocation = await assignPaymentToSplit(baseUrl, adminToken, lockedOrder.id, payment.id, splitGroupId);
  assert.equal(allocation.response.status, 200, JSON.stringify(allocation.body));
  assert.equal(allocation.body.groups[0].amount_paid, 15);

  const blockedClear = await requestBill(baseUrl, 4, {
    preferred_payment_method: 'cash',
    split_count: 1,
  });
  assert.equal(blockedClear.response.status, 409);
  assert.equal(blockedClear.body.code, 'BILL_SPLIT_CLEAR_BLOCKED');

  const blockedReconfigure = await requestBill(baseUrl, 4, {
    preferred_payment_method: 'cash',
    split_count: 3,
  });
  assert.equal(blockedReconfigure.response.status, 409);
  assert.equal(blockedReconfigure.body.code, 'BILL_SPLIT_RECONFIGURATION_BLOCKED');

  const cancellableOrder = await createOrder(baseUrl, { tableId: 5, itemId });
  await markOrderDelivered(dbPath, cancellableOrder.id);

  const splitBeforeCancel = await requestBill(baseUrl, 5, {
    preferred_payment_method: 'card',
    split_count: 2,
  });
  assert.equal(splitBeforeCancel.response.status, 201);
  assert.equal(splitBeforeCancel.body.order.bill_splits_summary.groups.length, 2);

  const canceledBill = await cancelBillRequest(baseUrl, 5);
  assert.equal(canceledBill.response.status, 200, JSON.stringify(canceledBill.body));
  assert.equal(canceledBill.body.order.bill_requested_at, null);
  assert.equal(canceledBill.body.order.bill_splits_summary.has_split_bill, false);
}

async function main() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'database.sqlite');
  const port = 3460 + Math.floor(Math.random() * 100);
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
    const itemId = await publishMenu(baseUrl, adminToken);
    await testTableBillSplitFlow(baseUrl, adminToken, dbPath, itemId);
    console.log('PASS split bill mesa equal phase 1');
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
