const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const ADMIN_PASSWORD = 'test-payments-qa-admin-password';
const ADMIN_TOKEN_SECRET = 'test-payments-qa-admin-token-secret';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-payments-qa-'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
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
      name: 'Payments QA Menu',
      categories: [
        {
          name: 'Principales',
          items: [{ name: 'Pizza QA', description: 'Stress test de pagos', price: 30 }],
        },
      ],
    }),
  });

  assert.equal(publish.response.status, 200);

  const menu = await requestJson(`${baseUrl}/api/menu`);
  assert.equal(menu.response.status, 200);
  return menu.body[0].items[0].id;
}

async function createDeliveredOrder(baseUrl, dbPath, { tableId, itemId, quantity = 1 }) {
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
          bill_attended_at = CURRENT_TIMESTAMP
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

async function requestReturn(baseUrl, externalReference, paymentId = null) {
  const params = new URLSearchParams({ external_reference: externalReference });
  if (paymentId) {
    params.set('payment_id', paymentId);
  }

  return fetch(`${baseUrl}/api/payments/mercado-pago/return?${params.toString()}`, {
    redirect: 'manual',
  });
}

async function createCheckout(baseUrl, tableId) {
  const checkout = await requestJson(`${baseUrl}/api/tables/${tableId}/mercado-pago/checkout`, {
    method: 'POST',
  });
  assert.equal(checkout.response.status, 201);
  return checkout.body;
}

async function recordManualPayment(baseUrl, adminToken, orderId, payload) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify(payload),
  });
}

async function reversePayment(baseUrl, adminToken, orderId, paymentId, payload) {
  return requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments/${paymentId}/reversals`, {
    method: 'POST',
    headers: authHeaders(adminToken, true),
    body: JSON.stringify(payload),
  });
}

async function getOrderSummary(baseUrl, adminToken, orderId) {
  const response = await requestJson(`${baseUrl}/api/admin/orders/${orderId}/payments`, {
    headers: authHeaders(adminToken),
  });
  assert.equal(response.response.status, 200);
  return response.body;
}

async function getOpenOrders(baseUrl, adminToken) {
  const response = await requestJson(`${baseUrl}/api/admin/orders/open`, {
    headers: authHeaders(adminToken),
  });
  assert.equal(response.response.status, 200);
  return response.body;
}

async function getHistory(baseUrl, adminToken) {
  const response = await requestJson(`${baseUrl}/api/admin/orders/history?preset=today`, {
    headers: authHeaders(adminToken),
  });
  assert.equal(response.response.status, 200);
  return response.body.orders;
}

async function getCurrentRegister(baseUrl, adminToken) {
  const response = await requestJson(`${baseUrl}/api/admin/cash-register/current`, {
    headers: authHeaders(adminToken),
  });
  assert.equal(response.response.status, 200);
  return response.body;
}

function assertFinancialInvariants(snapshot, label) {
  assert.ok(Number(snapshot.amount_paid) >= 0, `${label}: amount_paid negativo`);
  assert.ok(Number(snapshot.amount_due) >= 0, `${label}: amount_due negativo`);

  const netPaidFromLedger = roundMoney(
    (snapshot.payments || []).reduce((sum, payment) => sum + Number(payment.net_amount ?? payment.amount ?? 0), 0)
  );

  assert.equal(roundMoney(snapshot.amount_paid), netPaidFromLedger, `${label}: amount_paid inconsistente con ledger`);

  const expectedDue = roundMoney(Math.max(0, Number(snapshot.total_amount || 0) - netPaidFromLedger));
  assert.equal(roundMoney(snapshot.amount_due), expectedDue, `${label}: amount_due inconsistente con ledger`);

  if (snapshot.payment_status === 'unpaid') {
    assert.equal(roundMoney(snapshot.amount_paid), 0, `${label}: unpaid con amount_paid > 0`);
    assert.ok(roundMoney(snapshot.amount_due) >= 0, `${label}: unpaid con amount_due inválido`);
  }

  if (snapshot.payment_status === 'partial') {
    assert.ok(roundMoney(snapshot.amount_paid) > 0, `${label}: partial sin pagos`);
    assert.ok(roundMoney(snapshot.amount_due) > 0, `${label}: partial sin saldo pendiente`);
  }

  if (snapshot.payment_status === 'paid') {
    assert.equal(roundMoney(snapshot.amount_due), 0, `${label}: paid con saldo pendiente`);
  }
}

function assertHistoryAndAdminMatch(adminSummary, historyOrder, label) {
  assert.equal(historyOrder.id, adminSummary.order_id, `${label}: id distinto`);
  assert.equal(roundMoney(historyOrder.total_amount), roundMoney(adminSummary.total_amount), `${label}: total distinto`);
  assert.equal(roundMoney(historyOrder.amount_paid), roundMoney(adminSummary.amount_paid), `${label}: amount_paid distinto`);
  assert.equal(roundMoney(historyOrder.amount_due), roundMoney(adminSummary.amount_due), `${label}: amount_due distinto`);
  assert.equal(historyOrder.payment_status, adminSummary.payment_status, `${label}: payment_status distinto`);
  assert.equal((historyOrder.payments || []).length, (adminSummary.payments || []).length, `${label}: pagos serializados distintos`);
  assert.equal(
    (historyOrder.external_payment_attempts || []).length,
    (adminSummary.external_payment_attempts || []).length,
    `${label}: intentos externos serializados distintos`
  );
}

async function assertExternalTerminalAudit({
  baseUrl,
  adminToken,
  dbPath,
  tableId,
  itemId,
  externalStatus,
}) {
  const orderId = await createDeliveredOrder(baseUrl, dbPath, {
    tableId,
    itemId,
    quantity: 1,
  });

  const checkout = await createCheckout(baseUrl, tableId);
  const stablePaymentId = `qa_mp_terminal_${externalStatus}_${tableId}`;

  const approved = await postWebhook(
    baseUrl,
    buildMockPaymentId({
      status: 'approved',
      id: stablePaymentId,
      externalReference: checkout.external_reference,
    }),
    checkout.external_reference
  );
  assert.equal(approved.response.status, 200);

  const finalEvent = await postWebhook(
    baseUrl,
    buildMockPaymentId({
      status: externalStatus,
      id: stablePaymentId,
      externalReference: checkout.external_reference,
    }),
    checkout.external_reference
  );
  assert.equal(finalEvent.response.status, 200);

  const summary = await getOrderSummary(baseUrl, adminToken, orderId);
  assert.equal(summary.payments.length, 1);
  assert.equal(summary.payments[0].method, 'mercado_pago');
  assert.equal(summary.payment_status, 'paid');
  assert.equal(summary.external_payment_attempts.length, 1);
  assert.equal(summary.external_payment_attempts[0].status, externalStatus);
  assert.equal(summary.external_payment_attempts[0].sync_disposition, 'ignored');
  assertFinancialInvariants(summary, `terminal-${externalStatus}`);
}

async function main() {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'database.sqlite');
  const port = 4600 + Math.floor(Math.random() * 100);
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

    const openRegister = await requestJson(`${baseUrl}/api/admin/cash-register/open`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({
        opening_float: 50,
        notes_open: 'QA sintético de pagos',
      }),
    });
    assert.equal(openRegister.response.status, 201);

    let expectedCashAmount = 50;

    const happyOrderId = await createDeliveredOrder(baseUrl, dbPath, { tableId: 1, itemId, quantity: 2 });
    const happyCheckout = await createCheckout(baseUrl, 1);

    const happyPending = await postWebhook(
      baseUrl,
      buildMockPaymentId({ status: 'pending', externalReference: happyCheckout.external_reference }),
      happyCheckout.external_reference
    );
    assert.equal(happyPending.response.status, 200);

    const happyPendingReturn = await requestReturn(baseUrl, happyCheckout.external_reference);
    assert.equal(happyPendingReturn.status, 302);
    assert.ok(happyPendingReturn.headers.get('location').includes('mp_status=pending'));

    let happySummary = await getOrderSummary(baseUrl, adminToken, happyOrderId);
    assert.equal(happySummary.payments.length, 0);
    assert.equal(happySummary.external_payment_attempts.length, 1);
    assert.equal(happySummary.external_payment_attempts[0].status, 'pending');
    assert.equal(happySummary.external_payment_attempts[0].sync_disposition, 'pending');
    assertFinancialInvariants(happySummary, 'happy-pending');

    const happyPaymentId = 'qa_mp_happy_1';
    const happyApproved = await postWebhook(
      baseUrl,
      buildMockPaymentId({
        status: 'approved',
        id: happyPaymentId,
        externalReference: happyCheckout.external_reference,
      }),
      happyCheckout.external_reference
    );
    assert.equal(happyApproved.response.status, 200);

    const duplicateHappyApproved = await postWebhook(
      baseUrl,
      buildMockPaymentId({
        status: 'approved',
        id: happyPaymentId,
        externalReference: happyCheckout.external_reference,
      }),
      happyCheckout.external_reference
    );
    assert.equal(duplicateHappyApproved.response.status, 200);

    const happyApprovedReturn = await requestReturn(baseUrl, happyCheckout.external_reference);
    assert.equal(happyApprovedReturn.status, 302);
    assert.ok(happyApprovedReturn.headers.get('location').includes('mp_status=approved'));

    happySummary = await getOrderSummary(baseUrl, adminToken, happyOrderId);
    assert.equal(happySummary.payments.length, 1);
    assert.equal(happySummary.payments[0].method, 'mercado_pago');
    assert.equal(happySummary.external_payment_attempts[0].order_payment_id, happySummary.payments[0].id);
    assertFinancialInvariants(happySummary, 'happy-approved');

    const rejectedOrderId = await createDeliveredOrder(baseUrl, dbPath, { tableId: 2, itemId, quantity: 1 });
    const rejectedCheckout = await createCheckout(baseUrl, 2);
    const rejected = await postWebhook(
      baseUrl,
      buildMockPaymentId({ status: 'rejected', externalReference: rejectedCheckout.external_reference }),
      rejectedCheckout.external_reference
    );
    assert.equal(rejected.response.status, 200);
    const rejectedSummary = await getOrderSummary(baseUrl, adminToken, rejectedOrderId);
    assert.equal(rejectedSummary.payments.length, 0);
    assert.equal(rejectedSummary.external_payment_attempts.at(-1).status, 'rejected');
    assert.equal(rejectedSummary.external_payment_attempts.at(-1).sync_disposition, 'ignored');
    assertFinancialInvariants(rejectedSummary, 'rejected');

    const cancelledOrderId = await createDeliveredOrder(baseUrl, dbPath, { tableId: 3, itemId, quantity: 1 });
    const cancelledCheckout = await createCheckout(baseUrl, 3);
    const cancelled = await postWebhook(
      baseUrl,
      buildMockPaymentId({ status: 'cancelled', externalReference: cancelledCheckout.external_reference }),
      cancelledCheckout.external_reference
    );
    assert.equal(cancelled.response.status, 200);
    const cancelledSummary = await getOrderSummary(baseUrl, adminToken, cancelledOrderId);
    assert.equal(cancelledSummary.payments.length, 0);
    assert.equal(cancelledSummary.external_payment_attempts.at(-1).status, 'cancelled');
    assert.equal(cancelledSummary.external_payment_attempts.at(-1).sync_disposition, 'ignored');
    assertFinancialInvariants(cancelledSummary, 'cancelled');

    const expiredOrderId = await createDeliveredOrder(baseUrl, dbPath, { tableId: 4, itemId, quantity: 1 });
    const expiredCheckout = await createCheckout(baseUrl, 4);
    const expired = await postWebhook(
      baseUrl,
      buildMockPaymentId({ status: 'expired', externalReference: expiredCheckout.external_reference }),
      expiredCheckout.external_reference
    );
    assert.equal(expired.response.status, 200);
    const expiredSummary = await getOrderSummary(baseUrl, adminToken, expiredOrderId);
    assert.equal(expiredSummary.payments.length, 0);
    assert.equal(expiredSummary.external_payment_attempts.at(-1).status, 'expired');
    assert.equal(expiredSummary.external_payment_attempts.at(-1).sync_disposition, 'ignored');
    assertFinancialInvariants(expiredSummary, 'expired');

    await assertExternalTerminalAudit({
      baseUrl,
      adminToken,
      dbPath,
      tableId: 5,
      itemId,
      externalStatus: 'refunded',
    });
    await assertExternalTerminalAudit({
      baseUrl,
      adminToken,
      dbPath,
      tableId: 6,
      itemId,
      externalStatus: 'charged_back',
    });
    await assertExternalTerminalAudit({
      baseUrl,
      adminToken,
      dbPath,
      tableId: 7,
      itemId,
      externalStatus: 'reversed',
    });

    const reuseOrderAId = await createDeliveredOrder(baseUrl, dbPath, { tableId: 8, itemId, quantity: 1 });
    const reuseOrderBId = await createDeliveredOrder(baseUrl, dbPath, { tableId: 9, itemId, quantity: 1 });
    const reuseCheckoutA = await createCheckout(baseUrl, 8);
    const reuseCheckoutB = await createCheckout(baseUrl, 9);
    const reusedExternalPaymentId = 'qa_mp_reused_payment';

    const applyReuseA = await postWebhook(
      baseUrl,
      buildMockPaymentId({
        status: 'approved',
        id: reusedExternalPaymentId,
        externalReference: reuseCheckoutA.external_reference,
      }),
      reuseCheckoutA.external_reference
    );
    assert.equal(applyReuseA.response.status, 200);

    const misuseReuseB = await postWebhook(
      baseUrl,
      buildMockPaymentId({
        status: 'approved',
        id: reusedExternalPaymentId,
        externalReference: reuseCheckoutB.external_reference,
      }),
      reuseCheckoutB.external_reference
    );
    assert.equal(misuseReuseB.response.status, 200);

    const reuseOrderASummary = await getOrderSummary(baseUrl, adminToken, reuseOrderAId);
    const reuseOrderBSummary = await getOrderSummary(baseUrl, adminToken, reuseOrderBId);
    assert.equal(reuseOrderASummary.payments.length, 1);
    assert.equal(reuseOrderBSummary.payments.length, 0);
    assert.equal(reuseOrderBSummary.external_payment_attempts.at(-1).sync_disposition, 'mismatched');
    assertFinancialInvariants(reuseOrderASummary, 'reused-payment-a');
    assertFinancialInvariants(reuseOrderBSummary, 'reused-payment-b');

    const staleOrderId = await createDeliveredOrder(baseUrl, dbPath, { tableId: 10, itemId, quantity: 2 });
    const staleOldCheckout = await createCheckout(baseUrl, 10);
    const staleManualPayment = await recordManualPayment(baseUrl, adminToken, staleOrderId, {
      amount: 20,
      method: 'card',
      note: 'Ajuste previo',
    });
    assert.equal(staleManualPayment.response.status, 201);
    const staleNewCheckout = await createCheckout(baseUrl, 10);
    assert.notEqual(staleNewCheckout.external_reference, staleOldCheckout.external_reference);
    const lateOldApproved = await postWebhook(
      baseUrl,
      buildMockPaymentId({
        status: 'approved',
        id: 'qa_mp_stale_old',
        externalReference: staleOldCheckout.external_reference,
      }),
      staleOldCheckout.external_reference
    );
    assert.equal(lateOldApproved.response.status, 200);
    const staleSummary = await getOrderSummary(baseUrl, adminToken, staleOrderId);
    assert.equal(staleSummary.payments.length, 1);
    assert.equal(staleSummary.amount_due, 40);
    assert.equal(staleSummary.external_payment_attempts.length, 2);
    assert.equal(staleSummary.external_payment_attempts_summary.stale_count, 1);
    assert.equal(staleSummary.external_payment_attempts.at(-1).status, 'pending');
    assert.equal(staleSummary.external_payment_attempts[0].sync_disposition, 'stale');
    assertFinancialInvariants(staleSummary, 'stale-checkout');

    const latePaidOrderId = await createDeliveredOrder(baseUrl, dbPath, { tableId: 11, itemId, quantity: 1 });
    const latePaidCheckout = await createCheckout(baseUrl, 11);
    const lateManualFull = await recordManualPayment(baseUrl, adminToken, latePaidOrderId, {
      amount: 30,
      method: 'card',
      note: 'Saldo cubierto por mostrador',
    });
    assert.equal(lateManualFull.response.status, 201);
    const lateApproved = await postWebhook(
      baseUrl,
      buildMockPaymentId({
        status: 'approved',
        id: 'qa_mp_late_paid',
        externalReference: latePaidCheckout.external_reference,
      }),
      latePaidCheckout.external_reference
    );
    assert.equal(lateApproved.response.status, 200);
    const latePaidSummary = await getOrderSummary(baseUrl, adminToken, latePaidOrderId);
    assert.equal(latePaidSummary.payments.length, 1);
    assert.equal(latePaidSummary.payments[0].method, 'card');
    assert.equal(latePaidSummary.external_payment_attempts.at(-1).sync_disposition, 'stale');
    assertFinancialInvariants(latePaidSummary, 'late-approved-fully-paid');

    const mixOrderId = await createDeliveredOrder(baseUrl, dbPath, { tableId: 12, itemId, quantity: 3 });
    const mixCashPayment = await recordManualPayment(baseUrl, adminToken, mixOrderId, {
      amount: 60,
      method: 'cash',
      note: 'Parte en efectivo',
    });
    assert.equal(mixCashPayment.response.status, 201);
    expectedCashAmount += 60;
    const mixCashPaymentId = mixCashPayment.body.payments.find((payment) => payment.method === 'cash')?.id;
    assert.ok(mixCashPaymentId);

    const mixCheckout = await createCheckout(baseUrl, 12);
    const mixApproved = await postWebhook(
      baseUrl,
      buildMockPaymentId({
        status: 'approved',
        id: 'qa_mp_mix',
        externalReference: mixCheckout.external_reference,
      }),
      mixCheckout.external_reference
    );
    assert.equal(mixApproved.response.status, 200);

    const mixPartialReversal = await reversePayment(baseUrl, adminToken, mixOrderId, mixCashPaymentId, {
      amount: 10,
      reason: 'Se corrigió un cobro en efectivo',
    });
    assert.equal(mixPartialReversal.response.status, 201);
    expectedCashAmount -= 10;

    const mixFinalTransfer = await recordManualPayment(baseUrl, adminToken, mixOrderId, {
      amount: 10,
      method: 'transfer',
      note: 'Completa por transferencia',
    });
    assert.equal(mixFinalTransfer.response.status, 201);

    const mixSummaryBeforeClose = await getOrderSummary(baseUrl, adminToken, mixOrderId);
    assert.equal(mixSummaryBeforeClose.payment_status, 'paid');
    assert.equal(mixSummaryBeforeClose.payments.length, 3);
    assert.equal(mixSummaryBeforeClose.payments.find((payment) => payment.id === mixCashPaymentId)?.reversed_amount, 10);
    assert.equal(mixSummaryBeforeClose.external_payment_attempts.length, 1);
    assert.equal(mixSummaryBeforeClose.external_payment_attempts[0].sync_disposition, 'applied');
    assertFinancialInvariants(mixSummaryBeforeClose, 'mix-before-close');

    const fullyReversedOrderId = await createDeliveredOrder(baseUrl, dbPath, { tableId: 13, itemId, quantity: 1 });
    const fullyReversedCashPayment = await recordManualPayment(baseUrl, adminToken, fullyReversedOrderId, {
      amount: 30,
      method: 'cash',
      note: 'Cobro a revertir completo',
    });
    assert.equal(fullyReversedCashPayment.response.status, 201);
    expectedCashAmount += 30;
    const fullyReversedPaymentId = fullyReversedCashPayment.body.payments.find((payment) => payment.method === 'cash')?.id;
    assert.ok(fullyReversedPaymentId);

    const excessiveReversal = await reversePayment(baseUrl, adminToken, fullyReversedOrderId, fullyReversedPaymentId, {
      amount: 31,
      reason: 'No debería dejar sobre-revertir',
    });
    assert.equal(excessiveReversal.response.status, 409);
    assert.equal(excessiveReversal.body.code, 'PAYMENT_REVERSAL_OVERFLOW');

    const fullReversal = await reversePayment(baseUrl, adminToken, fullyReversedOrderId, fullyReversedPaymentId, {
      amount: 30,
      reason: 'Reversión total',
    });
    assert.equal(fullReversal.response.status, 201);
    expectedCashAmount -= 30;

    const duplicateFullReversal = await reversePayment(baseUrl, adminToken, fullyReversedOrderId, fullyReversedPaymentId, {
      amount: 1,
      reason: 'Intento duplicado',
    });
    assert.equal(duplicateFullReversal.response.status, 409);
    assert.equal(duplicateFullReversal.body.code, 'PAYMENT_ALREADY_FULLY_REVERSED');

    const fullyReversedSummary = await getOrderSummary(baseUrl, adminToken, fullyReversedOrderId);
    assert.equal(fullyReversedSummary.payment_status, 'unpaid');
    assert.equal(fullyReversedSummary.amount_paid, 0);
    assert.equal(fullyReversedSummary.amount_due, 30);
    assert.equal(fullyReversedSummary.payments[0].fully_reversed, true);
    assertFinancialInvariants(fullyReversedSummary, 'full-reversal');

    const currentRegister = await getCurrentRegister(baseUrl, adminToken);
    assert.equal(currentRegister.expected_cash_amount, roundMoney(expectedCashAmount));

    const closeMixOrder = await requestJson(`${baseUrl}/api/admin/orders/${mixOrderId}/close`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    assert.equal(closeMixOrder.response.status, 200);

    const openOrders = await getOpenOrders(baseUrl, adminToken);
    const historyOrders = await getHistory(baseUrl, adminToken);

    openOrders.forEach((order) => assertFinancialInvariants(order, `open-order-${order.id}`));
    historyOrders.forEach((order) => assertFinancialInvariants(order, `history-order-${order.id}`));

    assert.ok(!openOrders.some((order) => order.id === mixOrderId));
    const latePaidOpenOrder = openOrders.find((order) => order.id === latePaidOrderId);
    assert.ok(latePaidOpenOrder);
    assert.ok(!historyOrders.some((order) => order.id === latePaidOrderId));

    const mixHistoryOrder = historyOrders.find((order) => order.id === mixOrderId);
    assert.ok(mixHistoryOrder);
    assertHistoryAndAdminMatch(mixSummaryBeforeClose, mixHistoryOrder, 'mix-order-history-sync');

    const closeRegister = await requestJson(`${baseUrl}/api/admin/cash-register/current/close`, {
      method: 'POST',
      headers: authHeaders(adminToken, true),
      body: JSON.stringify({
        counted_cash_amount: expectedCashAmount,
        notes_close: 'Cierre QA',
      }),
    });
    assert.equal(closeRegister.response.status, 200);
    assert.equal(closeRegister.body.expected_cash_amount, roundMoney(expectedCashAmount));
    assert.equal(closeRegister.body.cash_difference, 0);

    console.log('Payments QA synthetic battery passed');
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
