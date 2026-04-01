const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { io: createSocketClient } = require('socket.io-client');

const ADMIN_PASSWORD = 'test-hardening-admin-password';
const ADMIN_TOKEN_SECRET = 'test-hardening-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-hardening-'));
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

async function publishValidMenu(baseUrl, adminToken) {
  const response = await requestJson(`${baseUrl}/api/menu/publish`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify({
      name: 'Hardening Test Menu',
      categories: [
        {
          name: 'Principales',
          items: [
            { name: 'Bife hardening', description: 'Prueba', price: 30 },
          ],
        },
      ],
    }),
  });

  assert.equal(response.response.status, 200);
}

async function main() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'server.sqlite');
  const uploadDir = path.join(tempDir, 'uploads');
  const port = 4000 + Math.floor(Math.random() * 1000);
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
      const invalidPublish = await requestJson(`${baseUrl}/api/menu/publish`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({
          name: 'Inválido',
          categories: [
            {
              name: 'Principales',
              items: [{ name: 'Sin precio', description: 'Debe fallar', price: '' }],
            },
          ],
        }),
      });
      assert.equal(invalidPublish.response.status, 400);
      assert.equal(invalidPublish.body.code, 'INVALID_MENU_PRICE');

      await publishValidMenu(baseUrl, adminToken);
      const menu = await requestJson(`${baseUrl}/api/menu`);
      const itemId = menu.body[0].items[0].id;

      const createdOrder = await requestJson(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table_id: 21,
          items: [{ item_id: itemId, quantity: 1, comments: '' }],
        }),
      });
      assert.equal(createdOrder.response.status, 201);
      const orderId = createdOrder.body.id;

      const openOrdersInitial = await requestJson(`${baseUrl}/api/admin/orders/open`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(openOrdersInitial.response.status, 200);
      assert.ok(openOrdersInitial.body.some((order) => order.id === orderId));
      assert.ok(openOrdersInitial.body.every((order) => !order.closed_at));

      await updateOrderStatus(adminSocket, adminToken, orderId, 'processing');
      await updateOrderStatus(adminSocket, adminToken, orderId, 'ready');
      await updateOrderStatus(adminSocket, adminToken, orderId, 'delivered');

      const requestBill = await requestJson(`${baseUrl}/api/tables/21/request-bill`, {
        method: 'POST',
      });
      assert.equal(requestBill.response.status, 201);

      const sessionWithBill = await requestJson(`${baseUrl}/api/tables/21/orders/session`);
      assert.equal(sessionWithBill.response.status, 200);
      assert.ok(sessionWithBill.body.active_order.bill_requested_at);

      const cancelBill = await requestJson(`${baseUrl}/api/tables/21/request-bill`, {
        method: 'DELETE',
      });
      assert.equal(cancelBill.response.status, 200);

      const sessionWithoutBill = await requestJson(`${baseUrl}/api/tables/21/orders/session`);
      assert.equal(sessionWithoutBill.response.status, 200);
      assert.equal(sessionWithoutBill.body.active_order.bill_requested_at, null);

      const requestBillAgain = await requestJson(`${baseUrl}/api/tables/21/request-bill`, {
        method: 'POST',
      });
      assert.equal(requestBillAgain.response.status, 201);

      const billDelivered = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === orderId && Boolean(order?.bill_attended_at)
      );
      const resolveRequest = await requestJson(`${baseUrl}/api/table-requests/${requestBillAgain.body.id}/resolve`, {
        method: 'POST',
        headers: authHeaders(adminToken),
      });
      assert.equal(resolveRequest.response.status, 200);
      await billDelivered;

      const cancelAfterBillDelivered = await requestJson(`${baseUrl}/api/tables/21/request-bill`, {
        method: 'DELETE',
      });
      assert.equal(cancelAfterBillDelivered.response.status, 409);
      assert.equal(cancelAfterBillDelivered.body.code, 'BILL_ALREADY_ATTENDED');

      const paymentRecorded = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === orderId && Boolean(order?.payment_received_at)
      );
      const payment = await requestJson(`${baseUrl}/api/tables/21/payment`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({ payment_method: 'transfer' }),
      });
      assert.equal(payment.response.status, 200);
      await paymentRecorded;

      const secondOrder = await requestJson(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table_id: 22,
          items: [{ item_id: itemId, quantity: 1, comments: '' }],
        }),
      });
      assert.equal(secondOrder.response.status, 201);

      const openOrdersAfterPayment = await requestJson(`${baseUrl}/api/admin/orders/open`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(openOrdersAfterPayment.response.status, 200);
      assert.ok(openOrdersAfterPayment.body.some((order) => order.id === secondOrder.body.id));
      assert.ok(openOrdersAfterPayment.body.some((order) => order.id === orderId));
      assert.ok(openOrdersAfterPayment.body.every((order) => !order.closed_at));

      const closedOrder = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === orderId && Boolean(order?.closed_at)
      );
      const closeResponse = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/close`, {
        method: 'POST',
        headers: authHeaders(adminToken),
      });
      assert.equal(closeResponse.response.status, 200);
      await closedOrder;

      const openOrdersAfterClose = await requestJson(`${baseUrl}/api/admin/orders/open`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(openOrdersAfterClose.response.status, 200);
      assert.ok(openOrdersAfterClose.body.some((order) => order.id === secondOrder.body.id));
      assert.ok(openOrdersAfterClose.body.every((order) => order.id !== orderId));

      const history = await requestJson(`${baseUrl}/api/admin/orders/history?preset=today`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(history.response.status, 200);
      assert.ok(history.body.orders.some((order) => order.id === orderId));
      assert.ok(history.body.orders.every((order) => order.id !== secondOrder.body.id));
    } finally {
      adminSocket.close();
    }

    console.log('Hardening backend tests passed');
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
