const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { io: createSocketClient } = require('socket.io-client');

const ADMIN_PASSWORD = 'test-sprint6-admin-password';
const ADMIN_TOKEN_SECRET = 'test-sprint6-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint6-'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const timeout = setTimeout(() => reject(new Error('Timeout conectando socket admin.')), 5000);

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

async function updateOrderStatus(socket, adminToken, orderId, status) {
  const nextOrder = waitForSocketEvent(
    socket,
    'order_updated',
    (order) => order?.id === orderId && order?.status === status
  );
  socket.emit('update_order_status', { order_id: orderId, status, token: adminToken });
  return nextOrder;
}

async function publishMenu(baseUrl, adminToken) {
  const response = await requestJson(`${baseUrl}/api/menu/publish`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify({
      name: 'Sprint 6 Test Menu',
      categories: [
        {
          name: 'Principales',
          items: [
            { name: 'Bife Sprint 6', description: 'Prueba', price: 30 },
            { name: 'Pasta Sprint 6', description: 'Prueba', price: 18 },
          ],
        },
      ],
    }),
  });

  assert.equal(response.response.status, 200);
}

async function closeOrder(baseUrl, adminToken, adminSocket, { tableId, itemId, quantity, paymentMethod }) {
  const orderResponse = await requestJson(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table_id: tableId,
      items: [{ item_id: itemId, quantity, comments: '' }],
    }),
  });
  assert.equal(orderResponse.response.status, 201);
  const orderId = orderResponse.body.id;

  await updateOrderStatus(adminSocket, adminToken, orderId, 'processing');
  await updateOrderStatus(adminSocket, adminToken, orderId, 'ready');
  await updateOrderStatus(adminSocket, adminToken, orderId, 'delivered');

  const requestBill = await requestJson(`${baseUrl}/api/tables/${tableId}/request-bill`, {
    method: 'POST',
  });
  assert.equal(requestBill.response.status, 201);

  const billDelivered = waitForSocketEvent(
    adminSocket,
    'order_updated',
    (order) => order?.id === orderId && Boolean(order?.bill_attended_at)
  );
  const resolveRequest = await requestJson(`${baseUrl}/api/table-requests/${requestBill.body.id}/resolve`, {
    method: 'POST',
    headers: authHeaders(adminToken),
  });
  assert.equal(resolveRequest.response.status, 200);
  await billDelivered;

  const paidOrder = waitForSocketEvent(
    adminSocket,
    'order_updated',
    (order) => order?.id === orderId && Boolean(order?.payment_received_at)
  );
  const payment = await requestJson(`${baseUrl}/api/tables/${tableId}/payment`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify({ payment_method: paymentMethod }),
  });
  assert.equal(payment.response.status, 200);
  await paidOrder;

  const closedOrder = waitForSocketEvent(
    adminSocket,
    'order_updated',
    (order) => order?.id === orderId && Boolean(order?.closed_at)
  );
  const close = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/close`, {
    method: 'POST',
    headers: authHeaders(adminToken),
  });
  assert.equal(close.response.status, 200);
  await closedOrder;

  return close.body;
}

async function main() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'server.sqlite');
  const uploadDir = path.join(tempDir, 'uploads');
  const port = 3900 + Math.floor(Math.random() * 1000);
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
      const firstItemId = menu.body[0].items[0].id;
      const secondItemId = menu.body[0].items[1].id;

      const firstPaidOrder = await closeOrder(baseUrl, adminToken, adminSocket, {
        tableId: 11,
        itemId: firstItemId,
        quantity: 2,
        paymentMethod: 'transfer',
      });
      const secondPaidOrder = await closeOrder(baseUrl, adminToken, adminSocket, {
        tableId: 12,
        itemId: secondItemId,
        quantity: 1,
        paymentMethod: 'card',
      });

      const history = await requestJson(`${baseUrl}/api/admin/orders/history?preset=today&limit=10`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(history.response.status, 200);
      assert.equal(history.body.total_count, 2);
      assert.equal(history.body.orders.length, 2);
      assert.ok(history.body.orders.every((order) => Boolean(order.closed_at)));
      assert.ok(history.body.orders.some((order) => order.id === firstPaidOrder.id));
      assert.ok(history.body.orders.some((order) => order.id === secondPaidOrder.id));

      const summary = await requestJson(`${baseUrl}/api/admin/orders/history/summary?preset=today`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(summary.response.status, 200);
      assert.equal(summary.body.summary.orders_count, 2);
      assert.equal(summary.body.summary.total_revenue, 78);
      assert.equal(summary.body.summary.average_ticket, 39);
      assert.equal(summary.body.payment_breakdown.length, 2);

      const cardOnly = await requestJson(`${baseUrl}/api/admin/orders/history?payment_method=card&preset=today`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(cardOnly.response.status, 200);
      assert.equal(cardOnly.body.total_count, 1);
      assert.equal(cardOnly.body.orders[0].payment_method, 'card');

      const emptyFutureRange = await requestJson(`${baseUrl}/api/admin/orders/history?from=2100-01-01&to=2100-01-02`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(emptyFutureRange.response.status, 200);
      assert.equal(emptyFutureRange.body.total_count, 0);

      const invalidRange = await requestJson(`${baseUrl}/api/admin/orders/history?from=2026-03-26&to=2026-03-20`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(invalidRange.response.status, 400);
      assert.equal(invalidRange.body.code, 'INVALID_HISTORY_FILTER');

      const invalidPayment = await requestJson(`${baseUrl}/api/admin/orders/history?payment_method=bitcoin`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(invalidPayment.response.status, 400);
      assert.equal(invalidPayment.body.code, 'INVALID_HISTORY_FILTER');
    } finally {
      adminSocket.close();
    }

    console.log('Sprint 6 backend tests passed');
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
