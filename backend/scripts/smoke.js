const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { io: createSocketClient } = require('socket.io-client');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint7-smoke-'));
const dbPath = path.join(tempDir, 'database.sqlite');
const port = 3310;
const baseUrl = `http://127.0.0.1:${port}`;
const adminPassword = 'admin123';
const adminSecret = 'sprint7-smoke-secret';

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
      ADMIN_TOKEN_SECRET: adminSecret,
      BACKEND_URL: baseUrl,
      FRONTEND_URL: 'http://127.0.0.1:5173',
      MP_MOCK_MODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(server);

    const adminToken = await loginAdmin();
    const adminSocket = await createAdminSocket(adminToken);

    try {
      const openRegister = await requestJson(`${baseUrl}/api/admin/cash-register/open`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({
          opening_float: 100,
          notes_open: 'Caja smoke',
        }),
      });
      assert.equal(openRegister.response.status, 201);
      assert.equal(openRegister.body.status, 'open');

      const invalidPublish = await requestJson(`${baseUrl}/api/menu/publish`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({
          name: 'Smoke Menu inválido',
          categories: [
            {
              name: 'Principales',
              items: [{ name: 'Milanesa rota', description: 'Sin precio', price: '' }],
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

      let processingUpdate = waitForStatus('processing');
      adminSocket.emit('update_order_status', { order_id: orderId, status: 'processing', token: adminToken });
      await processingUpdate;

      let readyUpdate = waitForStatus('ready');
      adminSocket.emit('update_order_status', { order_id: orderId, status: 'ready', token: adminToken });
      await readyUpdate;

      let deliveredUpdate = waitForStatus('delivered');
      adminSocket.emit('update_order_status', { order_id: orderId, status: 'delivered', token: adminToken });
      await deliveredUpdate;

      const requestBill = await requestJson(`${baseUrl}/api/tables/1/request-bill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferred_payment_method: 'cash' }),
      });
      assert.equal(requestBill.response.status, 201);
      assert.equal(requestBill.body.order.bill_payment_method_preference, 'cash');
      assert.equal(requestBill.body.order.bill_collection_status, 'waiting_cash');

      const resolveBillUpdate = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === orderId && Boolean(order?.bill_attended_at)
      );
      const resolveBill = await requestJson(`${baseUrl}/api/table-requests/${requestBill.body.table_request.id}/resolve`, {
        method: 'POST',
        headers: authHeaders(adminToken),
      });
      assert.equal(resolveBill.response.status, 200);
      await resolveBillUpdate;

      const partialPaymentUpdate = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === orderId && order?.payment_status === 'partial'
      );
      const partialPayment = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({ amount: 15, method: 'cash', note: 'Primera parte' }),
      });
      assert.equal(partialPayment.response.status, 201);
      assert.equal(partialPayment.body.amount_paid, 15);
      assert.equal(partialPayment.body.amount_due, 25);
      assert.equal(partialPayment.body.closed_at, null);
      await partialPaymentUpdate;

      const firstPaymentId = partialPayment.body.payments[0].id;
      const reversalUpdate = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === orderId && order?.payment_status === 'partial' && order?.amount_paid === 10
      );
      const reversal = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments/${firstPaymentId}/reversals`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({ amount: 5, reason: 'Corrección smoke' }),
      });
      assert.equal(reversal.response.status, 201);
      assert.equal(reversal.body.amount_paid, 10);
      assert.equal(reversal.body.amount_due, 30);
      assert.equal(reversal.body.payments[0].reversed_amount, 5);
      await reversalUpdate;

      const closeWithDue = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/close`, {
        method: 'POST',
        headers: authHeaders(adminToken),
      });
      assert.equal(closeWithDue.response.status, 409);
      assert.equal(closeWithDue.body.code, 'ORDER_BALANCE_PENDING');

      const secondPaymentUpdate = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === orderId && order?.payment_status === 'paid'
      );
      const secondPayment = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({ amount: 30, method: 'card', note: 'Saldo final' }),
      });
      assert.equal(secondPayment.response.status, 201);
      assert.equal(secondPayment.body.amount_paid, 40);
      assert.equal(secondPayment.body.amount_due, 0);
      assert.equal(secondPayment.body.payment_method, 'split');
      assert.equal(secondPayment.body.closed_at, null);
      await secondPaymentUpdate;

      const stillOpenOrders = await requestJson(`${baseUrl}/api/admin/orders/open`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(stillOpenOrders.response.status, 200);
      assert.ok(stillOpenOrders.body.some((order) => order.id === orderId));

      const closeUpdate = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === orderId && Boolean(order?.closed_at)
      );
      const closeOrder = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/close`, {
        method: 'POST',
        headers: authHeaders(adminToken),
      });
      assert.equal(closeOrder.response.status, 200);
      assert.ok(closeOrder.body.closed_at);
      await closeUpdate;

      const openOrders = await requestJson(`${baseUrl}/api/admin/orders/open`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(openOrders.response.status, 200);
      assert.ok(openOrders.body.every((order) => order.id !== orderId));

      const history = await requestJson(`${baseUrl}/api/admin/orders/history?preset=today`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(history.response.status, 200);
      const closedOrder = history.body.orders.find((order) => order.id === orderId);
      assert.ok(closedOrder);
      assert.equal(closedOrder.payment_method, 'split');

      const secondOrderCreated = await requestJson(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table_id: 2,
          items: [{ item_id: itemId, quantity: 1, comments: 'mp mock' }],
        }),
      });
      assert.equal(secondOrderCreated.response.status, 201);
      const secondOrderId = secondOrderCreated.body.id;

      let secondProcessing = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === secondOrderId && order?.status === 'processing'
      );
      adminSocket.emit('update_order_status', { order_id: secondOrderId, status: 'processing', token: adminToken });
      await secondProcessing;

      let secondReady = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === secondOrderId && order?.status === 'ready'
      );
      adminSocket.emit('update_order_status', { order_id: secondOrderId, status: 'ready', token: adminToken });
      await secondReady;

      let secondDelivered = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === secondOrderId && order?.status === 'delivered'
      );
      adminSocket.emit('update_order_status', { order_id: secondOrderId, status: 'delivered', token: adminToken });
      await secondDelivered;

      const secondRequestBill = await requestJson(`${baseUrl}/api/tables/2/request-bill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferred_payment_method: 'mercado_pago' }),
      });
      assert.equal(secondRequestBill.response.status, 200);
      assert.equal(secondRequestBill.body.table_request, null);
      assert.equal(secondRequestBill.body.order.bill_payment_method_preference, 'mercado_pago');
      assert.equal(secondRequestBill.body.order.bill_collection_status, 'checkout_pending');
      assert.ok(secondRequestBill.body.order.bill_attended_at);

      const mpCheckout = await requestJson(`${baseUrl}/api/tables/2/mercado-pago/checkout`, {
        method: 'POST',
      });
      assert.equal(mpCheckout.response.status, 201);
      assert.equal(mpCheckout.body.status, 'pending');

      const mpPaidUpdate = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === secondOrderId && order?.payment_status === 'paid' && order?.payment_method === 'mercado_pago'
      );
      const mpReturn = await fetch(mpCheckout.body.checkout_url, { redirect: 'manual' });
      assert.equal(mpReturn.status, 302);
      await mpPaidUpdate;

      const mpCloseUpdate = waitForSocketEvent(
        adminSocket,
        'order_updated',
        (order) => order?.id === secondOrderId && Boolean(order?.closed_at)
      );
      const closeMpOrder = await requestJson(`${baseUrl}/api/admin/orders/${secondOrderId}/close`, {
        method: 'POST',
        headers: authHeaders(adminToken),
      });
      assert.equal(closeMpOrder.response.status, 200);
      await mpCloseUpdate;

      const currentRegister = await requestJson(`${baseUrl}/api/admin/cash-register/current`, {
        headers: authHeaders(adminToken),
      });
      assert.equal(currentRegister.response.status, 200);
      assert.equal(currentRegister.body.expected_cash_amount, 110);

      const closeRegister = await requestJson(`${baseUrl}/api/admin/cash-register/current/close`, {
        method: 'POST',
        headers: authHeaders(adminToken, true),
        body: JSON.stringify({
          counted_cash_amount: 110,
          notes_close: 'Cierre smoke',
        }),
      });
      assert.equal(closeRegister.response.status, 200);
      assert.equal(closeRegister.body.status, 'closed');
      assert.equal(closeRegister.body.cash_difference, 0);
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
