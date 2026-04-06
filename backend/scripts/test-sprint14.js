const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const migration018 = require('../migrations/018_add_staff_users_and_sessions');

const ADMIN_PASSWORD = 'test-sprint14-admin-password';
const ADMIN_TOKEN_SECRET = 'test-sprint14-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint14-'));
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

async function readCurrentSession(baseUrl, token) {
  return requestJson(`${baseUrl}/api/admin/session/current`, {
    headers: authHeaders(token),
  });
}

async function logoutCurrentSession(baseUrl, token) {
  return requestJson(`${baseUrl}/api/admin/session/current`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
}

async function createStaff(baseUrl, ownerToken, payload) {
  return requestJson(`${baseUrl}/api/admin/staff`, {
    method: 'POST',
    headers: authHeaders(ownerToken, true),
    body: JSON.stringify(payload),
  });
}

async function listStaff(baseUrl, token) {
  return requestJson(`${baseUrl}/api/admin/staff`, {
    headers: authHeaders(token),
  });
}

async function publishMenu(baseUrl, token) {
  const publish = await requestJson(`${baseUrl}/api/menu/publish`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({
      name: 'Sprint 14 Staff Menu',
      categories: [
        {
          name: 'Platos',
          items: [
            { name: 'Milanesa Staff', description: 'Prueba staff', price: 30 },
            { name: 'Pasta Staff', description: 'Prueba split', price: 20 },
          ],
        },
      ],
    }),
  });

  assert.equal(publish.response.status, 200);

  const menu = await requestJson(`${baseUrl}/api/menu`);
  assert.equal(menu.response.status, 200);
  return {
    milanesaId: menu.body[0].items.find((item) => item.name === 'Milanesa Staff').id,
    pastaId: menu.body[0].items.find((item) => item.name === 'Pasta Staff').id,
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

  assert.equal(order.response.status, 201, JSON.stringify(order.body));
  return order.body;
}

async function updateOrderTimestamps(dbPath, orderId, fields = {}) {
  const context = createSqliteContext(dbPath);
  const assignments = [];
  const params = [];

  try {
    if (fields.delivered) {
      assignments.push(
        "status = 'delivered'",
        'ready_at = CURRENT_TIMESTAMP',
        'delivered_at = CURRENT_TIMESTAMP'
      );
    }

    if (fields.billRequested) {
      assignments.push('bill_requested_at = CURRENT_TIMESTAMP');
    }

    if (fields.billAttended) {
      assignments.push('bill_attended_at = CURRENT_TIMESTAMP');
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

async function getOpenSuborderForOrder(baseUrl, token, orderId) {
  const result = await requestJson(`${baseUrl}/api/admin/suborders/open`, {
    headers: authHeaders(token),
  });

  assert.equal(result.response.status, 200);
  const suborder = result.body.find((entry) => entry.order_id === orderId);
  assert.ok(suborder, `Expected an open suborder for order ${orderId}`);
  return suborder;
}

async function updateSuborderStatus(baseUrl, token, suborderId, status) {
  return requestJson(`${baseUrl}/api/admin/suborders/${suborderId}/status`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({ status }),
  });
}

async function resolveTableRequest(baseUrl, token, requestId) {
  return requestJson(`${baseUrl}/api/table-requests/${requestId}/resolve`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}

async function createCallWaiterRequest(baseUrl, tableId) {
  return requestJson(`${baseUrl}/api/tables/${tableId}/call-waiter`, {
    method: 'POST',
  });
}

async function createRequestBill(baseUrl, tableId) {
  return requestJson(`${baseUrl}/api/tables/${tableId}/request-bill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferred_payment_method: 'cash' }),
  });
}

async function openRegister(baseUrl, token, openingFloat = 100) {
  return requestJson(`${baseUrl}/api/admin/cash-register/open`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({ opening_float: openingFloat, notes_open: 'Test sprint14' }),
  });
}

async function closeRegister(baseUrl, token, countedCashAmount = 100) {
  return requestJson(`${baseUrl}/api/admin/cash-register/current/close`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({ counted_cash_amount: countedCashAmount, notes_close: 'Cierre sprint14' }),
  });
}

async function createPayment(baseUrl, token, orderId, payload) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify(payload),
  });
}

async function reversePayment(baseUrl, token, orderId, paymentId, payload) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments/${paymentId}/reversals`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify(payload),
  });
}

async function createEqualSplit(baseUrl, token, orderId, count) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/bill-splits/equal`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({ count }),
  });
}

async function assignPaymentToSplit(baseUrl, token, orderId, paymentId, splitId) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments/${paymentId}/split-allocation`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({ split_id: splitId }),
  });
}

async function closeOrder(baseUrl, token, orderId) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/close`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}

async function toggleAvailability(baseUrl, token, itemId, isAvailable) {
  return requestJson(`${baseUrl}/api/admin/menu-items/${itemId}/availability`, {
    method: 'PATCH',
    headers: authHeaders(token, true),
    body: JSON.stringify({ is_available: isAvailable }),
  });
}

async function testMigrationCreatesStaffTablesAndAuditColumns() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'migration.sqlite');
  const context = createSqliteContext(dbPath);

  try {
    await context.exec(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        closed_at DATETIME
      );

      CREATE TABLE order_suborders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER
      );
    `);

    await migration018.up(context);

    assert.equal(await context.tableExists('staff_users'), true);
    assert.equal(await context.tableExists('staff_sessions'), true);

    const orderColumns = await context.all('PRAGMA table_info(orders)');
    const suborderColumns = await context.all('PRAGMA table_info(order_suborders)');
    assert.ok(orderColumns.some((column) => column.name === 'closed_by'));
    assert.ok(suborderColumns.some((column) => column.name === 'cancelled_by'));
  } finally {
    await context.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  await testMigrationCreatesStaffTablesAndAuditColumns();

  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'database.sqlite');
  const port = 3470 + Math.floor(Math.random() * 100);
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

    const ownerToken = await loginOwner(baseUrl);
    const ownerSession = await readCurrentSession(baseUrl, ownerToken);
    assert.equal(ownerSession.response.status, 200);
    assert.equal(ownerSession.body.actor.role, 'owner');
    assert.equal(ownerSession.body.actor.auth_type, 'owner');

    const staffDefinitions = [
      { name: 'Mara Manager', login_code: 'MGR1', role: 'manager', pin: '1111' },
      { name: 'Cami Caja', login_code: 'CAJA1', role: 'cashier', pin: '2222' },
      { name: 'Seba Salon', login_code: 'MOZO1', role: 'server', pin: '3333' },
      { name: 'Kira Cocina', login_code: 'COC1', role: 'kitchen', pin: '4444' },
    ];

    for (const definition of staffDefinitions) {
      const created = await createStaff(baseUrl, ownerToken, definition);
      assert.equal(created.response.status, 201);
      assert.equal(created.body.role, definition.role);
      assert.equal(created.body.login_code, definition.login_code);
    }

    const ownerStaffList = await listStaff(baseUrl, ownerToken);
    assert.equal(ownerStaffList.response.status, 200);
    assert.equal(ownerStaffList.body.length, 4);

    const invalidPin = await loginStaff(baseUrl, 'CAJA1', '9999');
    assert.equal(invalidPin.response.status, 401);

    const managerLogin = await loginStaff(baseUrl, 'MGR1', '1111');
    const cashierLogin = await loginStaff(baseUrl, 'CAJA1', '2222');
    const serverLogin = await loginStaff(baseUrl, 'MOZO1', '3333');
    const kitchenLogin = await loginStaff(baseUrl, 'COC1', '4444');

    assert.equal(managerLogin.response.status, 201);
    assert.equal(cashierLogin.response.status, 201);
    assert.equal(serverLogin.response.status, 201);
    assert.equal(kitchenLogin.response.status, 201);

    const managerToken = managerLogin.body.token;
    const cashierToken = cashierLogin.body.token;
    const serverToken = serverLogin.body.token;
    const kitchenToken = kitchenLogin.body.token;

    const cashierSession = await readCurrentSession(baseUrl, cashierToken);
    assert.equal(cashierSession.response.status, 200);
    assert.equal(cashierSession.body.actor.role, 'cashier');
    assert.equal(cashierSession.body.actor.auth_type, 'staff');

    const managerStaffList = await listStaff(baseUrl, managerToken);
    assert.equal(managerStaffList.response.status, 403);

    const logoutCashier = await logoutCurrentSession(baseUrl, cashierToken);
    assert.equal(logoutCashier.response.status, 204);
    const cashierAfterLogout = await readCurrentSession(baseUrl, cashierToken);
    assert.equal(cashierAfterLogout.response.status, 403);

    const cashierRelogin = await loginStaff(baseUrl, 'CAJA1', '2222');
    assert.equal(cashierRelogin.response.status, 201);
    const cashierTokenActive = cashierRelogin.body.token;

    const menuIds = await publishMenu(baseUrl, ownerToken);

    const managerCanToggleMenu = await toggleAvailability(baseUrl, managerToken, menuIds.milanesaId, false);
    assert.equal(managerCanToggleMenu.response.status, 200);

    const cashierCannotToggleMenu = await toggleAvailability(baseUrl, cashierTokenActive, menuIds.milanesaId, true);
    assert.equal(cashierCannotToggleMenu.response.status, 403);

    const managerRestoresMenu = await toggleAvailability(baseUrl, managerToken, menuIds.milanesaId, true);
    assert.equal(managerRestoresMenu.response.status, 200);

    const cashOpenByServer = await openRegister(baseUrl, serverToken, 120);
    assert.equal(cashOpenByServer.response.status, 403);

    const cashOpenByCashier = await openRegister(baseUrl, cashierTokenActive, 120);
    assert.equal(cashOpenByCashier.response.status, 201);
    assert.match(cashOpenByCashier.body.opened_by || '', /staff#\d+:Cami Caja:cashier/);

    const cashCloseByCashier = await closeRegister(baseUrl, cashierTokenActive, 120);
    assert.equal(cashCloseByCashier.response.status, 200);
    assert.match(cashCloseByCashier.body.closed_by || '', /staff#\d+:Cami Caja:cashier/);

    const callWaiterOrder = await createOrder(baseUrl, { tableId: 101, itemId: menuIds.milanesaId });
    assert.ok(callWaiterOrder.id);
    const waiterRequest = await createCallWaiterRequest(baseUrl, 101);
    assert.equal(waiterRequest.response.status, 201);
    const waiterResolvedByServer = await resolveTableRequest(baseUrl, serverToken, waiterRequest.body.id);
    assert.equal(waiterResolvedByServer.response.status, 200);

    const billOrder = await createOrder(baseUrl, { tableId: 102, itemId: menuIds.milanesaId });
    await updateOrderTimestamps(dbPath, billOrder.id, { delivered: true });
    const billRequest = await createRequestBill(baseUrl, 102);
    assert.equal(billRequest.response.status, 201);
    const billResolveByServer = await resolveTableRequest(baseUrl, serverToken, billRequest.body.id);
    assert.equal(billResolveByServer.response.status, 403);
    const billResolveByCashier = await resolveTableRequest(baseUrl, cashierTokenActive, billRequest.body.id);
    assert.equal(billResolveByCashier.response.status, 200);

    const lifecycleOrder = await createOrder(baseUrl, { tableId: 103, itemId: menuIds.milanesaId });
    const lifecycleSuborder = await getOpenSuborderForOrder(baseUrl, ownerToken, lifecycleOrder.id);
    const processingByKitchen = await updateSuborderStatus(baseUrl, kitchenToken, lifecycleSuborder.id, 'processing');
    assert.equal(processingByKitchen.response.status, 200);
    const readyByKitchen = await updateSuborderStatus(baseUrl, kitchenToken, lifecycleSuborder.id, 'ready');
    assert.equal(readyByKitchen.response.status, 200);
    const deliveredByKitchen = await updateSuborderStatus(baseUrl, kitchenToken, lifecycleSuborder.id, 'delivered');
    assert.equal(deliveredByKitchen.response.status, 403);
    const deliveredByServer = await updateSuborderStatus(baseUrl, serverToken, lifecycleSuborder.id, 'delivered');
    assert.equal(deliveredByServer.response.status, 200);

    const blockedCancelOrder = await createOrder(baseUrl, { tableId: 104, itemId: menuIds.milanesaId });
    const blockedCancelSuborder = await getOpenSuborderForOrder(baseUrl, ownerToken, blockedCancelOrder.id);
    const blockedServerCancel = await updateSuborderStatus(baseUrl, serverToken, blockedCancelSuborder.id, 'cancelled');
    assert.equal(blockedServerCancel.response.status, 403);

    const cancelOrder = await createOrder(baseUrl, { tableId: 105, itemId: menuIds.milanesaId });
    const cancelSuborder = await getOpenSuborderForOrder(baseUrl, ownerToken, cancelOrder.id);
    const cancelledByManager = await updateSuborderStatus(baseUrl, managerToken, cancelSuborder.id, 'cancelled');
    assert.equal(cancelledByManager.response.status, 200);
    assert.match(cancelledByManager.body.suborder.cancelled_by || '', /staff#\d+:Mara Manager:manager/);

    const paymentOrder = await createOrder(baseUrl, { tableId: 106, itemId: menuIds.milanesaId });
    await updateOrderTimestamps(dbPath, paymentOrder.id, { delivered: true, billRequested: true, billAttended: true });
    const blockedPaymentByServer = await createPayment(baseUrl, serverToken, paymentOrder.id, {
      amount: 10,
      method: 'card',
      note: 'bloqueado',
    });
    assert.equal(blockedPaymentByServer.response.status, 403);
    const paymentByCashier = await createPayment(baseUrl, cashierTokenActive, paymentOrder.id, {
      amount: 10,
      method: 'card',
      note: 'cobro parcial',
    });
    assert.equal(paymentByCashier.response.status, 201);
    const cashierPayment = paymentByCashier.body.payments.find((payment) => payment.note === 'cobro parcial');
    assert.ok(cashierPayment?.id);
    assert.match(cashierPayment.created_by || '', /staff#\d+:Cami Caja:cashier/);

    const blockedReversalByServer = await reversePayment(baseUrl, serverToken, paymentOrder.id, cashierPayment.id, {
      amount: 5,
      reason: 'No debería poder',
    });
    assert.equal(blockedReversalByServer.response.status, 403);
    const reversalByCashier = await reversePayment(baseUrl, cashierTokenActive, paymentOrder.id, cashierPayment.id, {
      amount: 5,
      reason: 'Ajuste caja',
    });
    assert.equal(reversalByCashier.response.status, 201);
    const reversedPayment = reversalByCashier.body.payments.find((payment) => payment.id === cashierPayment.id);
    assert.ok(reversedPayment.reversals.length > 0);
    assert.match(reversedPayment.reversals[0].created_by || '', /staff#\d+:Cami Caja:cashier/);

    const splitOrder = await createOrder(baseUrl, { tableId: 107, itemId: menuIds.pastaId, quantity: 2 });
    await updateOrderTimestamps(dbPath, splitOrder.id, { delivered: true, billRequested: true, billAttended: true });
    const blockedSplitByServer = await createEqualSplit(baseUrl, serverToken, splitOrder.id, 2);
    assert.equal(blockedSplitByServer.response.status, 403);
    const splitByCashier = await createEqualSplit(baseUrl, cashierTokenActive, splitOrder.id, 2);
    assert.equal(splitByCashier.response.status, 201);
    assert.equal(splitByCashier.body.groups.length, 2);

    const splitPayment = await createPayment(baseUrl, cashierTokenActive, splitOrder.id, {
      amount: 20,
      method: 'card',
      note: 'Persona 1',
    });
    assert.equal(splitPayment.response.status, 201);
    const splitPaymentRecord = splitPayment.body.payments.find((payment) => payment.note === 'Persona 1');
    assert.ok(splitPaymentRecord?.id);
    const splitAllocation = await assignPaymentToSplit(
      baseUrl,
      cashierTokenActive,
      splitOrder.id,
      splitPaymentRecord.id,
      splitByCashier.body.groups[0].id
    );
    assert.equal(splitAllocation.response.status, 200);
    assert.equal(splitAllocation.body.groups[0].amount_paid, 20);

    const closeOrderCandidate = await createOrder(baseUrl, { tableId: 108, itemId: menuIds.milanesaId });
    await updateOrderTimestamps(dbPath, closeOrderCandidate.id, { delivered: true, billRequested: true, billAttended: true });
    const closePayment = await createPayment(baseUrl, cashierTokenActive, closeOrderCandidate.id, {
      amount: 30,
      method: 'card',
      note: 'Pago total',
    });
    assert.equal(closePayment.response.status, 201);
    const blockedCloseByServer = await closeOrder(baseUrl, serverToken, closeOrderCandidate.id);
    assert.equal(blockedCloseByServer.response.status, 403);
    const closeByCashier = await closeOrder(baseUrl, cashierTokenActive, closeOrderCandidate.id);
    assert.equal(closeByCashier.response.status, 200);
    assert.match(closeByCashier.body.closed_by || '', /staff#\d+:Cami Caja:cashier/);

    console.log('PASS staff roles, PIN auth, permissions, and audit trail');
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
