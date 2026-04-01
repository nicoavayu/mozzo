const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { io: createSocketClient } = require('socket.io-client');
const migration010 = require('../migrations/010_add_order_payment_fields');

const ADMIN_PASSWORD = 'test-sprint5-admin-password';
const ADMIN_TOKEN_SECRET = 'test-sprint5-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint5-'));
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

async function createAdminSocket(baseUrl, token) {
  const socket = createSocketClient(baseUrl, {
    transports: ['websocket'],
    forceNew: true,
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout conectando socket admin.'));
    }, 5000);

    socket.on('connect', () => {
      socket.emit('join_admin', { token });
    });

    socket.on('admin_joined', () => {
      clearTimeout(timeout);
      resolve();
    });

    socket.on('auth_error', (payload) => {
      clearTimeout(timeout);
      reject(new Error(payload?.error || 'No pudimos autenticar el socket admin.'));
    });

    socket.on('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  return socket;
}

async function waitForSocketEvent(socket, eventName, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, handleEvent);
      reject(new Error(`Timeout esperando ${eventName}.`));
    }, timeoutMs);

    const handleEvent = (payload) => {
      if (!predicate(payload)) {
        return;
      }

      clearTimeout(timeout);
      socket.off(eventName, handleEvent);
      resolve(payload);
    };

    socket.on(eventName, handleEvent);
  });
}

async function publishMenu(baseUrl, adminToken) {
  const response = await requestJson(`${baseUrl}/api/menu/publish`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify({
      name: 'Sprint 5 Test Menu',
      categories: [
        {
          name: 'Principales',
          items: [
            {
              name: 'Suprema Sprint 5',
              description: 'Prueba cierre económico',
              price: 24,
            },
          ],
        },
      ],
    }),
  });

  assert.equal(response.response.status, 200);
}

async function updateOrderStatus(socket, adminToken, orderId, status) {
  const nextOrder = waitForSocketEvent(
    socket,
    'order_updated',
    (order) => order?.id === orderId && order?.status === status
  );
  socket.emit('update_order_status', { order_id: orderId, status, token: adminToken });
  return nextOrder;
}

async function testMigrationAddsPaymentFields() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'migration.sqlite');
  const context = createSqliteContext(dbPath);

  try {
    await context.exec(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_id INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await migration010.up(context);

    const columns = await context.all('PRAGMA table_info(orders)');
    const paymentReceivedColumn = columns.find((column) => column.name === 'payment_received_at');
    const paymentMethodColumn = columns.find((column) => column.name === 'payment_method');

    assert.ok(paymentReceivedColumn, 'migration should add payment_received_at');
    assert.ok(paymentMethodColumn, 'migration should add payment_method');
  } finally {
    await context.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testPaymentLifecycle() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'server.sqlite');
  const uploadDir = path.join(tempDir, 'uploads');
  const port = 3800 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
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
    const adminSocket = await createAdminSocket(baseUrl, adminToken);

    try {
      await publishMenu(baseUrl, adminToken);

      const menu = await requestJson(`${baseUrl}/api/menu`);
      const itemId = menu.body[0].items[0].id;

      const orderResponse = await requestJson(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table_id: 5,
          items: [{ item_id: itemId, quantity: 1, comments: '' }],
        }),
      });
      assert.equal(orderResponse.response.status, 201);
      const orderId = orderResponse.body.id;

      const requestBill = await requestJson(`${baseUrl}/api/tables/5/request-bill`, {
        method: 'POST',
      });
      assert.equal(requestBill.response.status, 201);

      const resolveTooSoon = await requestJson(`${baseUrl}/api/table-requests/${requestBill.body.id}/resolve`, {
        method: 'POST',
        headers: authHeaders(adminToken),
      });
      assert.equal(resolveTooSoon.response.status, 409);
      assert.equal(resolveTooSoon.body.code, 'ORDER_NOT_DELIVERED');

      const paymentTooSoon = await requestJson(`${baseUrl}/api/tables/5/payment`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({ payment_method: 'cash' }),
      });
      assert.equal(paymentTooSoon.response.status, 409);
      assert.equal(paymentTooSoon.body.code, 'ORDER_NOT_DELIVERED');

      await updateOrderStatus(adminSocket, adminToken, orderId, 'processing');
      await updateOrderStatus(adminSocket, adminToken, orderId, 'ready');
      await updateOrderStatus(adminSocket, adminToken, orderId, 'delivered');

      const paymentBeforeBillDelivered = await requestJson(`${baseUrl}/api/tables/5/payment`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({ payment_method: 'cash' }),
      });
      assert.equal(paymentBeforeBillDelivered.response.status, 409);
      assert.equal(paymentBeforeBillDelivered.body.code, 'BILL_NOT_ATTENDED');

      const deliveredBillOrder = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === orderId && Boolean(order?.bill_attended_at)
      );
      const resolveDeliveredBill = await requestJson(`${baseUrl}/api/table-requests/${requestBill.body.id}/resolve`, {
        method: 'POST',
        headers: authHeaders(adminToken),
      });
      assert.equal(resolveDeliveredBill.response.status, 200);
      await deliveredBillOrder;

      const invalidPaymentMethod = await requestJson(`${baseUrl}/api/tables/5/payment`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({ payment_method: 'bitcoin' }),
      });
      assert.equal(invalidPaymentMethod.response.status, 400);
      assert.equal(invalidPaymentMethod.body.code, 'INVALID_PAYMENT_METHOD');

      const paidOrder = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === orderId && Boolean(order?.payment_received_at) && order?.payment_method === 'transfer'
      );
      const payment = await requestJson(`${baseUrl}/api/tables/5/payment`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({ payment_method: 'transfer' }),
      });
      assert.equal(payment.response.status, 200);
      assert.equal(payment.body.payment_method, 'transfer');
      assert.ok(payment.body.payment_received_at);
      assert.equal(payment.body.closed_at, null);
      await paidOrder;

      const closedOrder = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === orderId && Boolean(order?.closed_at)
      );
      const closeResponse = await requestJson(`${baseUrl}/api/tables/5/close`, {
        method: 'POST',
        headers: authHeaders(adminToken),
      });
      assert.equal(closeResponse.response.status, 200);
      assert.ok(closeResponse.body.closed_at);
      await closedOrder;

      const duplicatePayment = await requestJson(`${baseUrl}/api/tables/5/payment`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({ payment_method: 'cash' }),
      });
      assert.equal(duplicatePayment.response.status, 404);
      assert.equal(duplicatePayment.body.code, 'NO_OPEN_ORDER');

      const session = await requestJson(`${baseUrl}/api/tables/5/orders/session`);
      assert.equal(session.response.status, 200);
      assert.equal(session.body.active_order, null);
      assert.equal(session.body.latest_order.payment_method, 'transfer');
      assert.ok(session.body.latest_order.closed_at);
    } finally {
      adminSocket.close();
    }
  } finally {
    const shouldDumpOutput = process.exitCode && serverOutput;
    server.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (shouldDumpOutput) {
      process.stderr.write(serverOutput);
    }
  }
}

async function main() {
  await testMigrationAddsPaymentFields();
  console.log('PASS migration payment fields');

  await testPaymentLifecycle();
  console.log('PASS cierre económico simple');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
