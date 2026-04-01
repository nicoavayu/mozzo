const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const migration014 = require('../migrations/014_harden_mercado_pago_checkout_states');

const ADMIN_PASSWORD = 'test-sprint10-admin-password';
const ADMIN_TOKEN_SECRET = 'test-sprint10-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint10-'));
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
      name: 'Sprint 10 MP State Machine Menu',
      categories: [
        {
          name: 'Principales',
          items: [{ name: 'Pizza MP Hardened', description: 'State machine', price: 30 }],
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

function buildMockPaymentId({ status = 'approved', externalReference, amount = null, id = null }) {
  const parts = [`status=${status}`];

  if (id) {
    parts.push(`id=${id}`);
  }

  if (amount != null) {
    parts.push(`amount=${amount}`);
  }

  parts.push(`external_reference=${externalReference}`);

  return `mock_payment__${parts.join('__')}`;
}

async function getCheckoutRow(dbPath, externalReference) {
  const directDb = createSqliteContext(dbPath);
  try {
    return directDb.get(
      `
        SELECT
          id,
          order_id,
          amount,
          status,
          sync_disposition,
          external_reference,
          payment_id,
          payment_status,
          order_payment_id,
          status_reason
        FROM mercado_pago_checkouts
        WHERE external_reference = ?
      `,
      [externalReference]
    );
  } finally {
    await directDb.close();
  }
}

async function postWebhook(baseUrl, paymentId, externalReference) {
  return requestJson(`${baseUrl}/api/payments/mercado-pago/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'payment',
      data: { id: paymentId },
      external_reference: externalReference,
    }),
  });
}

async function testMigrationHardensCheckoutSchema() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'migration.sqlite');
  const context = createSqliteContext(dbPath);

  try {
    await context.exec(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_id INTEGER NOT NULL
      );

      CREATE TABLE order_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL
      );

      CREATE TABLE mercado_pago_checkouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        currency_id TEXT NOT NULL DEFAULT 'ARS',
        status TEXT NOT NULL DEFAULT 'pending',
        external_reference TEXT NOT NULL UNIQUE,
        preference_id TEXT UNIQUE,
        checkout_url TEXT,
        sandbox_checkout_url TEXT,
        payment_id TEXT UNIQUE,
        payment_status TEXT,
        payment_status_detail TEXT,
        payer_email TEXT,
        order_payment_id INTEGER,
        sync_error TEXT,
        expires_at DATETIME,
        approved_at DATETIME,
        last_checked_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await migration014.up(context);

    assert.equal(await context.tableExists('mercado_pago_checkouts'), true);
    const columns = await context.all('PRAGMA table_info(mercado_pago_checkouts)');
    assert.ok(columns.some((column) => column.name === 'sync_disposition'));
    assert.ok(columns.some((column) => column.name === 'status_reason'));
    assert.ok(columns.some((column) => column.name === 'last_event_source'));
    console.log('PASS migration mercado pago state hardening');
  } finally {
    await context.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testMercadoPagoStateMachine() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'database.sqlite');
  const port = 4500 + Math.floor(Math.random() * 100);
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

    const orderId = await createDeliveredOrder(baseUrl, dbPath, {
      tableId: 1,
      itemId,
      quantity: 2,
      billAttended: true,
    });

    const checkoutCreated = await requestJson(`${baseUrl}/api/tables/1/mercado-pago/checkout`, { method: 'POST' });
    assert.equal(checkoutCreated.response.status, 201);
    assert.equal(checkoutCreated.body.status, 'pending');
    assert.equal(checkoutCreated.body.sync_disposition, 'pending');

    const reusedCheckout = await requestJson(`${baseUrl}/api/tables/1/mercado-pago/checkout`, { method: 'POST' });
    assert.equal(reusedCheckout.response.status, 201);
    assert.equal(reusedCheckout.body.external_reference, checkoutCreated.body.external_reference);

    const pendingWebhook = await postWebhook(
      baseUrl,
      buildMockPaymentId({ status: 'pending', externalReference: checkoutCreated.body.external_reference }),
      checkoutCreated.body.external_reference
    );
    assert.equal(pendingWebhook.response.status, 200);

    let checkoutRow = await getCheckoutRow(dbPath, checkoutCreated.body.external_reference);
    assert.equal(checkoutRow.status, 'pending');
    assert.equal(checkoutRow.sync_disposition, 'pending');
    assert.equal(checkoutRow.order_payment_id, null);

    const rejectedWebhook = await postWebhook(
      baseUrl,
      buildMockPaymentId({ status: 'rejected', externalReference: checkoutCreated.body.external_reference }),
      checkoutCreated.body.external_reference
    );
    assert.equal(rejectedWebhook.response.status, 200);

    checkoutRow = await getCheckoutRow(dbPath, checkoutCreated.body.external_reference);
    assert.equal(checkoutRow.status, 'rejected');
    assert.equal(checkoutRow.sync_disposition, 'ignored');
    assert.equal(checkoutRow.order_payment_id, null);

    const newCheckout = await requestJson(`${baseUrl}/api/tables/1/mercado-pago/checkout`, { method: 'POST' });
    assert.equal(newCheckout.response.status, 201);
    assert.notEqual(newCheckout.body.external_reference, checkoutCreated.body.external_reference);

    const returnAfterWebhook = await fetch(
      `${baseUrl}/api/payments/mercado-pago/return?external_reference=${encodeURIComponent(newCheckout.body.external_reference)}`,
      { redirect: 'manual' }
    );
    assert.equal(returnAfterWebhook.status, 302);
    assert.ok(returnAfterWebhook.headers.get('location').includes('mp_status=pending'));

    const approvedExternalPaymentId = `mp_payment_${newCheckout.body.external_reference}`;
    const approvedPaymentId = buildMockPaymentId({
      status: 'approved',
      id: approvedExternalPaymentId,
      externalReference: newCheckout.body.external_reference,
    });
    const approvedWebhook = await postWebhook(baseUrl, approvedPaymentId, newCheckout.body.external_reference);
    assert.equal(approvedWebhook.response.status, 200);

    checkoutRow = await getCheckoutRow(dbPath, newCheckout.body.external_reference);
    assert.equal(checkoutRow.status, 'approved');
    assert.equal(checkoutRow.sync_disposition, 'applied');
    assert.ok(checkoutRow.order_payment_id);

    const summaryAfterApproved = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(summaryAfterApproved.response.status, 200);
    assert.equal(summaryAfterApproved.body.payments.length, 1);

    const duplicateWebhook = await postWebhook(baseUrl, approvedPaymentId, newCheckout.body.external_reference);
    assert.equal(duplicateWebhook.response.status, 200);
    const summaryAfterDuplicate = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(summaryAfterDuplicate.body.payments.length, 1);

    const refundedWebhook = await postWebhook(
      baseUrl,
      buildMockPaymentId({
        status: 'refunded',
        id: approvedExternalPaymentId,
        externalReference: newCheckout.body.external_reference,
      }),
      newCheckout.body.external_reference
    );
    assert.equal(refundedWebhook.response.status, 200);

    checkoutRow = await getCheckoutRow(dbPath, newCheckout.body.external_reference);
    assert.equal(checkoutRow.status, 'refunded');
    assert.equal(checkoutRow.sync_disposition, 'ignored');
    assert.match(checkoutRow.status_reason, /reversión manual/i);

    const summaryAfterRefundedStatus = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(summaryAfterRefundedStatus.body.payments.length, 1);
    assert.equal(summaryAfterRefundedStatus.body.payment_status, 'paid');
    assert.equal(summaryAfterRefundedStatus.body.external_payment_attempts.length, 2);
    const latestRefundedAttempt = summaryAfterRefundedStatus.body.external_payment_attempts.at(-1);
    assert.equal(latestRefundedAttempt.status, 'refunded');
    assert.equal(latestRefundedAttempt.sync_disposition, 'ignored');
    assert.equal(latestRefundedAttempt.order_payment_id, checkoutRow.order_payment_id);
    assert.equal(summaryAfterRefundedStatus.body.external_payment_attempts_summary.total_attempts, 2);
    assert.equal(summaryAfterRefundedStatus.body.external_payment_attempts_summary.ignored_count, 2);

    const closeApprovedOrder = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/close`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    assert.equal(closeApprovedOrder.response.status, 200);

    const closedHistory = await requestJson(`${baseUrl}/api/admin/orders/history?preset=today`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(closedHistory.response.status, 200);
    const closedOrderFromHistory = closedHistory.body.orders.find((entry) => entry.id === orderId);
    assert.ok(closedOrderFromHistory);
    assert.equal(closedOrderFromHistory.external_payment_attempts.length, 2);
    assert.equal(closedOrderFromHistory.external_payment_attempts.at(-1).status, 'refunded');
    assert.equal(closedOrderFromHistory.external_payment_attempts.at(-1).sync_disposition, 'ignored');

    const staleOrderId = await createDeliveredOrder(baseUrl, dbPath, {
      tableId: 2,
      itemId,
      quantity: 2,
      billAttended: true,
    });

    const staleCheckout = await requestJson(`${baseUrl}/api/tables/2/mercado-pago/checkout`, { method: 'POST' });
    assert.equal(staleCheckout.response.status, 201);

    const manualPayment = await requestJson(`${baseUrl}/api/admin/orders/${staleOrderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 20, method: 'card', note: 'Pago parcial manual' }),
    });
    assert.equal(manualPayment.response.status, 201);
    assert.equal(manualPayment.body.amount_due, 40);

    const newStaleAwareCheckout = await requestJson(`${baseUrl}/api/tables/2/mercado-pago/checkout`, { method: 'POST' });
    assert.equal(newStaleAwareCheckout.response.status, 201);
    assert.notEqual(newStaleAwareCheckout.body.external_reference, staleCheckout.body.external_reference);
    assert.equal(newStaleAwareCheckout.body.amount, 40);

    const staleCheckoutRow = await getCheckoutRow(dbPath, staleCheckout.body.external_reference);
    assert.equal(staleCheckoutRow.status, 'pending');
    assert.equal(staleCheckoutRow.sync_disposition, 'stale');

    const staleApproved = await postWebhook(
      baseUrl,
      buildMockPaymentId({ status: 'approved', externalReference: staleCheckout.body.external_reference }),
      staleCheckout.body.external_reference
    );
    assert.equal(staleApproved.response.status, 200);

    const staleApprovedRow = await getCheckoutRow(dbPath, staleCheckout.body.external_reference);
    assert.equal(staleApprovedRow.status, 'approved');
    assert.equal(staleApprovedRow.sync_disposition, 'stale');
    assert.equal(staleApprovedRow.order_payment_id, null);
    assert.match(staleApprovedRow.status_reason, /saldo pendiente|saldado|cerrado|válido/i);

    const staleOrderSummary = await requestJson(`${baseUrl}/api/admin/orders/${staleOrderId}/payments`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(staleOrderSummary.body.payments.length, 1);
    assert.equal(staleOrderSummary.body.amount_paid, 20);
    assert.equal(staleOrderSummary.body.amount_due, 40);

    const fullManualOrderId = await createDeliveredOrder(baseUrl, dbPath, {
      tableId: 3,
      itemId,
      quantity: 1,
      billAttended: true,
    });

    const lateCheckout = await requestJson(`${baseUrl}/api/tables/3/mercado-pago/checkout`, { method: 'POST' });
    assert.equal(lateCheckout.response.status, 201);

    const fullManualPayment = await requestJson(`${baseUrl}/api/admin/orders/${fullManualOrderId}/payments`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({ amount: 30, method: 'card', note: 'Manual completo' }),
    });
    assert.equal(fullManualPayment.response.status, 201);
    assert.equal(fullManualPayment.body.payment_status, 'paid');

    const lateApproved = await postWebhook(
      baseUrl,
      buildMockPaymentId({ status: 'approved', externalReference: lateCheckout.body.external_reference }),
      lateCheckout.body.external_reference
    );
    assert.equal(lateApproved.response.status, 200);

    const lateCheckoutRow = await getCheckoutRow(dbPath, lateCheckout.body.external_reference);
    assert.equal(lateCheckoutRow.status, 'approved');
    assert.equal(lateCheckoutRow.sync_disposition, 'stale');
    assert.equal(lateCheckoutRow.order_payment_id, null);

    const lateOrderSummary = await requestJson(`${baseUrl}/api/admin/orders/${fullManualOrderId}/payments`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(lateOrderSummary.body.payments.length, 1);
    assert.equal(lateOrderSummary.body.payments_summary.primary_method, 'card');
    assert.equal(lateOrderSummary.body.external_payment_attempts_summary.stale_count, 1);

    const openOrdersAfterLateApproved = await requestJson(`${baseUrl}/api/admin/orders/open`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(openOrdersAfterLateApproved.response.status, 200);
    const lateOpenOrder = openOrdersAfterLateApproved.body.find((entry) => entry.id === fullManualOrderId);
    assert.ok(lateOpenOrder);
    assert.equal(lateOpenOrder.external_payment_attempts_summary.stale_count, 1);
    assert.equal(lateOpenOrder.external_payment_attempts.at(-1).sync_disposition, 'stale');

    const mismatchOrderA = await createDeliveredOrder(baseUrl, dbPath, {
      tableId: 4,
      itemId,
      quantity: 1,
      billAttended: true,
    });
    const mismatchOrderB = await createDeliveredOrder(baseUrl, dbPath, {
      tableId: 5,
      itemId,
      quantity: 1,
      billAttended: true,
    });

    const checkoutA = await requestJson(`${baseUrl}/api/tables/4/mercado-pago/checkout`, { method: 'POST' });
    const checkoutB = await requestJson(`${baseUrl}/api/tables/5/mercado-pago/checkout`, { method: 'POST' });
    assert.equal(checkoutA.response.status, 201);
    assert.equal(checkoutB.response.status, 201);

    const mismatchPaymentId = buildMockPaymentId({
      status: 'approved',
      externalReference: checkoutA.body.external_reference,
    });
    const applyA = await postWebhook(baseUrl, mismatchPaymentId, checkoutA.body.external_reference);
    assert.equal(applyA.response.status, 200);

    const misuseOnB = await postWebhook(baseUrl, mismatchPaymentId, checkoutB.body.external_reference);
    assert.equal(misuseOnB.response.status, 200);

    const checkoutBRow = await getCheckoutRow(dbPath, checkoutB.body.external_reference);
    assert.equal(checkoutBRow.sync_disposition, 'mismatched');
    assert.equal(checkoutBRow.order_payment_id, null);

    const orderBPayments = await requestJson(`${baseUrl}/api/admin/orders/${mismatchOrderB}/payments`, {
      headers: authHeaders(adminToken),
    });
    assert.equal(orderBPayments.body.payments.length, 0);

    const cancelledOrderId = await createDeliveredOrder(baseUrl, dbPath, {
      tableId: 6,
      itemId,
      quantity: 1,
      billAttended: true,
    });
    const cancelledCheckout = await requestJson(`${baseUrl}/api/tables/6/mercado-pago/checkout`, { method: 'POST' });
    assert.equal(cancelledCheckout.response.status, 201);

    const cancelledWebhook = await postWebhook(
      baseUrl,
      buildMockPaymentId({ status: 'cancelled', externalReference: cancelledCheckout.body.external_reference }),
      cancelledCheckout.body.external_reference
    );
    assert.equal(cancelledWebhook.response.status, 200);

    const cancelledRow = await getCheckoutRow(dbPath, cancelledCheckout.body.external_reference);
    assert.equal(cancelledRow.status, 'cancelled');
    assert.equal(cancelledRow.sync_disposition, 'ignored');

    const expiredOrderId = await createDeliveredOrder(baseUrl, dbPath, {
      tableId: 7,
      itemId,
      quantity: 1,
      billAttended: true,
    });
    const expiredCheckout = await requestJson(`${baseUrl}/api/tables/7/mercado-pago/checkout`, { method: 'POST' });
    assert.equal(expiredCheckout.response.status, 201);

    const expiredWebhook = await postWebhook(
      baseUrl,
      buildMockPaymentId({ status: 'expired', externalReference: expiredCheckout.body.external_reference }),
      expiredCheckout.body.external_reference
    );
    assert.equal(expiredWebhook.response.status, 200);

    const expiredRow = await getCheckoutRow(dbPath, expiredCheckout.body.external_reference);
    assert.equal(expiredRow.status, 'expired');
    assert.equal(expiredRow.sync_disposition, 'ignored');

    const chargedBackOrderId = await createDeliveredOrder(baseUrl, dbPath, {
      tableId: 8,
      itemId,
      quantity: 1,
      billAttended: true,
    });
    const chargedBackCheckout = await requestJson(`${baseUrl}/api/tables/8/mercado-pago/checkout`, { method: 'POST' });
    assert.equal(chargedBackCheckout.response.status, 201);
    const chargedBackExternalPaymentId = `mp_payment_${chargedBackCheckout.body.external_reference}`;
    const chargedBackPaymentId = buildMockPaymentId({
      status: 'approved',
      id: chargedBackExternalPaymentId,
      externalReference: chargedBackCheckout.body.external_reference,
    });
    await postWebhook(baseUrl, chargedBackPaymentId, chargedBackCheckout.body.external_reference);

    const chargedBackWebhook = await postWebhook(
      baseUrl,
      buildMockPaymentId({
        status: 'charged_back',
        id: chargedBackExternalPaymentId,
        externalReference: chargedBackCheckout.body.external_reference,
      }),
      chargedBackCheckout.body.external_reference
    );
    assert.equal(chargedBackWebhook.response.status, 200);

    const chargedBackRow = await getCheckoutRow(dbPath, chargedBackCheckout.body.external_reference);
    assert.equal(chargedBackRow.status, 'charged_back');
    assert.equal(chargedBackRow.sync_disposition, 'ignored');

    const returnApprovedAfterWebhook = await fetch(
      `${baseUrl}/api/payments/mercado-pago/return?external_reference=${encodeURIComponent(checkoutA.body.external_reference)}`,
      { redirect: 'manual' }
    );
    assert.equal(returnApprovedAfterWebhook.status, 302);
    assert.ok(returnApprovedAfterWebhook.headers.get('location').includes('mp_status=approved'));

    const returnForStaleApproved = await fetch(
      `${baseUrl}/api/payments/mercado-pago/return?external_reference=${encodeURIComponent(staleCheckout.body.external_reference)}&payment_id=${encodeURIComponent(buildMockPaymentId({ status: 'approved', externalReference: staleCheckout.body.external_reference }))}`,
      { redirect: 'manual' }
    );
    assert.equal(returnForStaleApproved.status, 302);
    assert.ok(returnForStaleApproved.headers.get('location').includes('mp_status=failure'));

    console.log('Sprint 10 backend tests passed');
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

Promise.resolve()
  .then(testMigrationHardensCheckoutSchema)
  .then(testMercadoPagoStateMachine)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
