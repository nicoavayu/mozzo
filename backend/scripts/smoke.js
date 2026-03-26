const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { io: createSocketClient } = require('socket.io-client');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint4-smoke-'));
const dbPath = path.join(tempDir, 'database.sqlite');
const port = 3310;
const baseUrl = `http://127.0.0.1:${port}`;
const adminPassword = 'admin123';
const adminSecret = 'sprint4-smoke-secret';

function waitForServer(childProcess) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout esperando backend.'));
    }, 15000);

    childProcess.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes(`Server running on port ${port}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });

    childProcess.stderr.on('data', (chunk) => {
      process.stderr.write(chunk.toString());
    });

    childProcess.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Backend terminó antes de tiempo con código ${code}.`));
    });
  });
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

async function loginAdmin() {
  const login = await requestJson(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPassword })
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

async function waitForSocketEvent(socket, eventName, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, handleEvent);
      reject(new Error(`Timeout esperando evento ${eventName}.`));
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

async function createAdminSocket(token) {
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

async function main() {
  const server = spawn('node', ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      ADMIN_PASSWORD: adminPassword,
      ADMIN_TOKEN_SECRET: adminSecret
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(server);

    const initial = await requestJson(`${baseUrl}/api/venue-settings`);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.restaurant_name, 'Mozzo');
    const adminToken = await loginAdmin();
    const adminSocket = await createAdminSocket(adminToken);

    try {
      const payload = {
        restaurant_name: 'Mozzo Palermo',
        restaurant_subtitle: 'Cocina y barra',
        contact_label: 'WhatsApp',
        contact_url: 'https://wa.me/5491100000000',
        review_url: 'https://example.com/reviews',
        feedback_url: 'https://example.com/feedback'
      };

      const saved = await requestJson(`${baseUrl}/api/admin/venue-settings`, {
        method: 'PUT',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify(payload)
      });
      assert.equal(saved.response.status, 200);
      assert.equal(saved.body.restaurant_name, payload.restaurant_name);

      const fetched = await requestJson(`${baseUrl}/api/venue-settings`);
      assert.equal(fetched.response.status, 200);
      assert.equal(fetched.body.restaurant_subtitle, payload.restaurant_subtitle);
      assert.equal(fetched.body.contact_url, payload.contact_url);

      const invalidPublish = await requestJson(`${baseUrl}/api/menu/publish`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({
          name: 'Smoke Menu inválido',
          categories: [
            {
              name: 'Principales',
              items: [
                { name: 'Milanesa rota', description: 'Sin precio', price: '' },
              ],
            },
          ],
        }),
      });
      assert.equal(invalidPublish.response.status, 400);
      assert.equal(invalidPublish.body.code, 'INVALID_MENU_PRICE');

      const publish = await requestJson(`${baseUrl}/api/menu/publish`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({
          name: 'Smoke Menu',
          categories: [
            {
              name: 'Principales',
              items: [
                { name: 'Milanesa Smoke', description: 'Prueba', price: 20 },
              ],
            },
          ],
        }),
      });
      assert.equal(publish.response.status, 200);

      const menu = await requestJson(`${baseUrl}/api/menu`);
      assert.equal(menu.response.status, 200);
      assert.ok(Array.isArray(menu.body));
      const itemId = menu.body[0].items[0].id;

      const orderCreated = await requestJson(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table_id: 1,
          items: [{ item_id: itemId, quantity: 2, comments: 'sin cebolla' }],
        }),
      });
      assert.equal(orderCreated.response.status, 201);
      assert.equal(orderCreated.body.total_amount, 40);
      const orderId = orderCreated.body.id;

      const waitForStatus = (status) => waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === orderId && order?.status === status
      );

      const processingUpdate = waitForStatus('processing');
      adminSocket.emit('update_order_status', { order_id: orderId, status: 'processing', token: adminToken });
      await processingUpdate;

      const readyUpdate = waitForStatus('ready');
      adminSocket.emit('update_order_status', { order_id: orderId, status: 'ready', token: adminToken });
      await readyUpdate;

      const deliveredUpdate = waitForStatus('delivered');
      adminSocket.emit('update_order_status', { order_id: orderId, status: 'delivered', token: adminToken });
      await deliveredUpdate;

      const requestBill = await requestJson(`${baseUrl}/api/tables/1/request-bill`, {
        method: 'POST',
      });
      assert.equal(requestBill.response.status, 201);

      const sessionWithBillRequested = await requestJson(`${baseUrl}/api/tables/1/orders/session`);
      assert.equal(sessionWithBillRequested.response.status, 200);
      assert.ok(sessionWithBillRequested.body.active_order.bill_requested_at);

      const cancelBill = await requestJson(`${baseUrl}/api/tables/1/request-bill`, {
        method: 'DELETE',
      });
      assert.equal(cancelBill.response.status, 200);

      const sessionAfterBillCancel = await requestJson(`${baseUrl}/api/tables/1/orders/session`);
      assert.equal(sessionAfterBillCancel.response.status, 200);
      assert.equal(sessionAfterBillCancel.body.active_order.bill_requested_at, null);

      const secondRequestBill = await requestJson(`${baseUrl}/api/tables/1/request-bill`, {
        method: 'POST',
      });
      assert.equal(secondRequestBill.response.status, 201);

      const openOrdersBeforePayment = await requestJson(`${baseUrl}/api/admin/orders/open`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(openOrdersBeforePayment.response.status, 200);
      assert.ok(openOrdersBeforePayment.body.some((order) => order.id === orderId));

      const resolveBillUpdate = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === orderId && Boolean(order?.bill_attended_at)
      );
      const resolveBill = await requestJson(`${baseUrl}/api/table-requests/${secondRequestBill.body.id}/resolve`, {
        method: 'POST',
        headers: authHeaders(adminToken),
      });
      assert.equal(resolveBill.response.status, 200);
      await resolveBillUpdate;

      const paymentUpdate = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === orderId && Boolean(order?.payment_received_at) && order?.payment_method === 'card'
      );
      const payment = await requestJson(`${baseUrl}/api/tables/1/payment`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({ payment_method: 'card' }),
      });
      assert.equal(payment.response.status, 200);
      assert.ok(payment.body.payment_received_at);
      assert.equal(payment.body.payment_method, 'card');
      assert.ok(payment.body.closed_at);
      await paymentUpdate;

      const openOrdersAfterPayment = await requestJson(`${baseUrl}/api/admin/orders/open`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(openOrdersAfterPayment.response.status, 200);
      assert.ok(openOrdersAfterPayment.body.every((order) => order.id !== orderId));

      const session = await requestJson(`${baseUrl}/api/tables/1/orders/session`);
      assert.equal(session.response.status, 200);
      assert.equal(session.body.active_order, null);
      assert.equal(session.body.latest_order.payment_method, 'card');
      assert.ok(session.body.latest_order.closed_at);

      const history = await requestJson(`${baseUrl}/api/admin/orders/history?preset=today`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(history.response.status, 200);
      assert.ok(Array.isArray(history.body.orders));
      assert.ok(history.body.orders.some((order) => order.id === orderId));

      const summary = await requestJson(`${baseUrl}/api/admin/orders/history/summary?preset=today`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(summary.response.status, 200);
      assert.equal(summary.body.summary.orders_count, 1);
      assert.equal(summary.body.summary.total_revenue, 40);
      assert.equal(summary.body.payment_breakdown[0].payment_method, 'card');
    } finally {
      adminSocket.close();
    }

    console.log('Smoke check passed');
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
