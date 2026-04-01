const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const ADMIN_PASSWORD = 'test-sprint8-admin-password';
const ADMIN_TOKEN_SECRET = 'test-sprint8-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint8-'));
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
      name: 'Sprint 8 MP Menu',
      categories: [
        {
          name: 'Principales',
          items: [{ name: 'Pizza MP', description: 'Pago online', price: 30 }],
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

async function main() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'database.sqlite');
  const port = 4300 + Math.floor(Math.random() * 100);
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

    const gatewayStatus = await requestJson(`${baseUrl}/api/payments/mercado-pago/status`);
    assert.equal(gatewayStatus.response.status, 200);
    assert.equal(gatewayStatus.body.enabled, true);

    await createDeliveredOrder(baseUrl, dbPath, {
      tableId: 2,
      itemId,
      quantity: 1,
      billAttended: false,
    });

    const checkoutBlocked = await requestJson(`${baseUrl}/api/tables/2/mercado-pago/checkout`, {
      method: 'POST',
    });
    assert.equal(checkoutBlocked.response.status, 409);
    assert.equal(checkoutBlocked.body.code, 'BILL_NOT_ATTENDED');

    const orderId = await createDeliveredOrder(baseUrl, dbPath, {
      tableId: 1,
      itemId,
      quantity: 2,
      billAttended: true,
    });

    const checkoutCreated = await requestJson(`${baseUrl}/api/tables/1/mercado-pago/checkout`, {
      method: 'POST',
    });
    assert.equal(checkoutCreated.response.status, 201);
    assert.equal(checkoutCreated.body.status, 'pending');
    assert.ok(checkoutCreated.body.checkout_url.includes('/api/payments/mercado-pago/return'));

    const beforePay = await requestJson(`${baseUrl}/api/tables/1/orders/session`);
    assert.equal(beforePay.response.status, 200);
    assert.equal(beforePay.body.active_order.amount_due, 60);
    assert.equal(beforePay.body.active_order.payment_status, 'unpaid');
    assert.equal(beforePay.body.active_order.closed_at, null);

    const returned = await fetch(checkoutCreated.body.checkout_url, { redirect: 'manual' });
    assert.equal(returned.status, 302);
    assert.ok(returned.headers.get('location').includes('/1?mp_status=approved'));

    const afterPay = await requestJson(`${baseUrl}/api/tables/1/orders/session`);
    assert.equal(afterPay.response.status, 200);
    assert.equal(afterPay.body.active_order.amount_paid, 60);
    assert.equal(afterPay.body.active_order.amount_due, 0);
    assert.equal(afterPay.body.active_order.payment_status, 'paid');
    assert.equal(afterPay.body.active_order.payment_method, 'mercado_pago');
    assert.equal(afterPay.body.active_order.closed_at, null);

    const duplicateWebhook = await requestJson(`${baseUrl}/api/payments/mercado-pago/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'payment',
        data: {
          id: `mock_payment_${checkoutCreated.body.external_reference}`,
        },
      }),
    });
    assert.equal(duplicateWebhook.response.status, 200);

    const paymentSummary = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(paymentSummary.response.status, 200);
    assert.equal(paymentSummary.body.payments.length, 1);
    assert.equal(paymentSummary.body.payments[0].method, 'mercado_pago');

    const closeBeforePay = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/close`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    assert.equal(closeBeforePay.response.status, 200);
    assert.ok(closeBeforePay.body.closed_at);

    const history = await requestJson(`${baseUrl}/api/admin/orders/history?preset=today&payment_method=mercado_pago`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(history.response.status, 200);
    assert.ok(history.body.orders.some((order) => order.id === orderId));

    console.log('Sprint 8 backend tests passed');
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
