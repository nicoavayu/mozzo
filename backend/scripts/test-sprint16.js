const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const ADMIN_PASSWORD = 'test-sprint16-admin-password';
const ADMIN_TOKEN_SECRET = 'test-sprint16-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint16-'));
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
  return login.body.token;
}

async function publishMenu(baseUrl, adminToken) {
  const publish = await requestJson(`${baseUrl}/api/menu/publish`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify({
      name: 'Sprint 16 Demo Reset Menu',
      categories: [
        {
          name: 'Reset',
          items: [
            { name: 'Milanesa Reset', description: 'Demo reset', price: 30 },
          ],
        },
      ],
    }),
  });

  assert.equal(publish.response.status, 200);

  const menu = await requestJson(`${baseUrl}/api/menu`);
  assert.equal(menu.response.status, 200);
  return menu.body[0].items[0].id;
}

async function createOrder(baseUrl, tableId, itemId) {
  const order = await requestJson(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table_id: tableId,
      items: [{ item_id: itemId, quantity: 1, comments: '' }],
    }),
  });

  assert.equal(order.response.status, 201);
  return order.body;
}

async function markOrderDelivered(dbPath, orderId, { billRequested = false, billAttended = false } = {}) {
  const context = createSqliteContext(dbPath);

  try {
    await context.run(
      `
        UPDATE orders
        SET
          status = 'delivered',
          ready_at = CURRENT_TIMESTAMP,
          delivered_at = CURRENT_TIMESTAMP,
          bill_requested_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE bill_requested_at END,
          bill_attended_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE bill_attended_at END
        WHERE id = ?
      `,
      [billRequested ? 1 : 0, billAttended ? 1 : 0, orderId]
    );
  } finally {
    await context.close();
  }
}

async function createPayment(baseUrl, adminToken, orderId, payload) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
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

async function openCashRegister(baseUrl, adminToken) {
  return requestJson(`${baseUrl}/api/admin/cash-register/open`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify({
      opening_float: 100,
      notes_open: 'Demo reset test',
    }),
  });
}

async function requestBill(baseUrl, tableId, payload) {
  return requestJson(`${baseUrl}/api/tables/${tableId}/request-bill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function callWaiter(baseUrl, tableId) {
  return requestJson(`${baseUrl}/api/tables/${tableId}/call-waiter`, {
    method: 'POST',
  });
}

async function resetOperationalState(baseUrl, adminToken) {
  return requestJson(`${baseUrl}/api/admin/demo/reset-operational-state`, {
    method: 'POST',
    headers: authHeaders(adminToken),
  });
}

async function testOperationalReset(baseUrl, adminToken, dbPath, itemId) {
  const closedOrder = await createOrder(baseUrl, 1, itemId);
  await markOrderDelivered(dbPath, closedOrder.id, { billRequested: true, billAttended: true });
  const payment = await createPayment(baseUrl, adminToken, closedOrder.id, {
    amount: 30,
    method: 'card',
    note: 'Pago reset test',
  });
  assert.equal(payment.response.status, 201, JSON.stringify(payment.body));
  const closed = await closeOrder(baseUrl, adminToken, closedOrder.id);
  assert.equal(closed.response.status, 200, JSON.stringify(closed.body));

  const splitOrder = await createOrder(baseUrl, 2, itemId);
  await markOrderDelivered(dbPath, splitOrder.id);
  const requestedBill = await requestBill(baseUrl, 2, {
    preferred_payment_method: 'cash',
    split_count: 2,
  });
  assert.equal(requestedBill.response.status, 201, JSON.stringify(requestedBill.body));
  assert.equal(requestedBill.body.order.bill_splits_summary.groups.length, 2);

  const waiterRequest = await callWaiter(baseUrl, 3);
  assert.equal(waiterRequest.response.status, 201, JSON.stringify(waiterRequest.body));

  const register = await openCashRegister(baseUrl, adminToken);
  assert.equal(register.response.status, 201, JSON.stringify(register.body));

  const reset = await resetOperationalState(baseUrl, adminToken);
  assert.equal(reset.response.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.success, true);

  const menuAfterReset = await requestJson(`${baseUrl}/api/menu`);
  assert.equal(menuAfterReset.response.status, 200);
  assert.equal(menuAfterReset.body[0].items[0].name, 'Milanesa Reset');

  const openOrdersAfterReset = await requestJson(`${baseUrl}/api/admin/orders/open`, {
    headers: authHeaders(adminToken),
  });
  assert.equal(openOrdersAfterReset.response.status, 200);
  assert.deepEqual(openOrdersAfterReset.body, []);

  const historyAfterReset = await requestJson(`${baseUrl}/api/admin/orders/history`, {
    headers: authHeaders(adminToken),
  });
  assert.equal(historyAfterReset.response.status, 200);
  assert.equal(historyAfterReset.body.total_count, 0);
  assert.deepEqual(historyAfterReset.body.orders, []);

  const requestsAfterReset = await requestJson(`${baseUrl}/api/table-requests`, {
    headers: authHeaders(adminToken),
  });
  assert.equal(requestsAfterReset.response.status, 200);
  assert.deepEqual(requestsAfterReset.body, []);

  const currentRegisterAfterReset = await requestJson(`${baseUrl}/api/admin/cash-register/current`, {
    headers: authHeaders(adminToken),
  });
  assert.equal(currentRegisterAfterReset.response.status, 200);
  assert.equal(currentRegisterAfterReset.body, null);

  const registerHistoryAfterReset = await requestJson(`${baseUrl}/api/admin/cash-register/history`, {
    headers: authHeaders(adminToken),
  });
  assert.equal(registerHistoryAfterReset.response.status, 200);
  assert.deepEqual(registerHistoryAfterReset.body, []);

  const tableSessionAfterReset = await requestJson(`${baseUrl}/api/tables/2/orders/session`);
  assert.equal(tableSessionAfterReset.response.status, 200);
  assert.equal(tableSessionAfterReset.body.active_order, null);
  assert.equal(tableSessionAfterReset.body.latest_order, null);

  const secondReset = await resetOperationalState(baseUrl, adminToken);
  assert.equal(secondReset.response.status, 200, JSON.stringify(secondReset.body));
}

async function main() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'database.sqlite');
  const port = 3560 + Math.floor(Math.random() * 100);
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
    await testOperationalReset(baseUrl, adminToken, dbPath, itemId);
    console.log('PASS demo operational reset preserves menu');
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
