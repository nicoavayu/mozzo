const crypto = require('crypto');
const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');
const {
  MONEY_EPSILON,
  createPaymentForOrder,
  normalizePaymentNote,
  roundMoney,
  validatePaymentAgainstOrder,
} = require('./order-payments');
const {
  createOrderError,
  getActiveOrderForTable,
  getOrderById,
  syncOrderFinancialStateAfterLedgerChange,
} = require('./orders');
const { getOpenRegister } = require('./cash-register');

const CHECKOUT_TTL_MINUTES = 15;
const MERCADO_PAGO_METHOD = 'mercado_pago';
const ACTIVE_CHECKOUT_STATUSES = new Set(['pending']);
const ACTIVE_CHECKOUT_DISPOSITIONS = new Set(['pending']);
const CHECKOUT_STATUSES = new Set([
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'expired',
  'failed',
  'refunded',
  'charged_back',
  'reversed',
]);
const CHECKOUT_SYNC_DISPOSITIONS = new Set(['pending', 'applied', 'ignored', 'stale', 'mismatched']);
const APPROVED_PAYMENT_STATUSES = new Set(['approved']);
const PENDING_PAYMENT_STATUSES = new Set(['pending', 'in_process', 'authorized']);
const REJECTED_PAYMENT_STATUSES = new Set(['rejected']);
const CANCELLED_PAYMENT_STATUSES = new Set(['cancelled', 'canceled']);
const EXPIRED_PAYMENT_STATUSES = new Set(['expired']);
const REFUNDED_PAYMENT_STATUSES = new Set(['refunded']);
const CHARGED_BACK_PAYMENT_STATUSES = new Set(['charged_back', 'charge_back', 'chargedback']);
const REVERSED_PAYMENT_STATUSES = new Set(['reversed']);
const CHECKOUT_SELECT_FIELDS = `
  id,
  order_id,
  amount,
  currency_id,
  status,
  sync_disposition,
  external_reference,
  preference_id,
  checkout_url,
  sandbox_checkout_url,
  payment_id,
  payment_status,
  payment_status_detail,
  payer_email,
  order_payment_id,
  status_reason,
  expires_at,
  approved_at,
  last_checked_at,
  last_event_source,
  created_at,
  updated_at
`;

let mercadoPagoClient = null;
let preferenceClient = null;
let paymentClient = null;

function createMercadoPagoError(code, message, status = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function isSinglePendingCheckoutConstraint(error) {
  return (
    error?.code === 'SQLITE_CONSTRAINT'
    && /idx_mercado_pago_single_pending_per_order|UNIQUE constraint failed/i.test(String(error?.message || ''))
  );
}

function isMercadoPagoMockMode() {
  return process.env.MP_MOCK_MODE === '1';
}

function isMercadoPagoConfigured() {
  return isMercadoPagoMockMode() || Boolean(String(process.env.MP_ACCESS_TOKEN || '').trim());
}

function ensureMercadoPagoConfigured() {
  if (!isMercadoPagoConfigured()) {
    throw createMercadoPagoError(
      'MERCADO_PAGO_NOT_CONFIGURED',
      'Mercado Pago no está configurado en este entorno.',
      503
    );
  }
}

function ensurePositiveInteger(value, fieldName) {
  const normalizedValue = Number(value);

  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    throw createMercadoPagoError('INVALID_MERCADO_PAGO_PAYLOAD', `${fieldName} must be a positive integer`);
  }

  return normalizedValue;
}

function getBackendBaseUrl() {
  return String(process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
}

function getFrontendBaseUrl() {
  return String(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function formatSqlTimestamp(date) {
  return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
}

function buildCheckoutStatusFromPaymentStatus(paymentStatus) {
  const normalizedStatus = String(paymentStatus || '').trim().toLowerCase();

  if (APPROVED_PAYMENT_STATUSES.has(normalizedStatus)) {
    return 'approved';
  }

  if (PENDING_PAYMENT_STATUSES.has(normalizedStatus)) {
    return 'pending';
  }

  if (REJECTED_PAYMENT_STATUSES.has(normalizedStatus)) {
    return 'rejected';
  }

  if (CANCELLED_PAYMENT_STATUSES.has(normalizedStatus)) {
    return 'cancelled';
  }

  if (EXPIRED_PAYMENT_STATUSES.has(normalizedStatus)) {
    return 'expired';
  }

  if (REFUNDED_PAYMENT_STATUSES.has(normalizedStatus)) {
    return 'refunded';
  }

  if (CHARGED_BACK_PAYMENT_STATUSES.has(normalizedStatus)) {
    return 'charged_back';
  }

  if (REVERSED_PAYMENT_STATUSES.has(normalizedStatus)) {
    return 'reversed';
  }

  return 'failed';
}

function mapCheckoutRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    order_id: row.order_id,
    amount: roundMoney(row.amount),
    currency_id: row.currency_id || 'ARS',
    status: row.status,
    sync_disposition: row.sync_disposition || 'pending',
    external_reference: row.external_reference,
    preference_id: row.preference_id || null,
    checkout_url: row.checkout_url || null,
    sandbox_checkout_url: row.sandbox_checkout_url || null,
    payment_id: row.payment_id || null,
    payment_status: row.payment_status || null,
    payment_status_detail: row.payment_status_detail || null,
    payer_email: row.payer_email || null,
    order_payment_id: row.order_payment_id || null,
    status_reason: row.status_reason || null,
    expires_at: row.expires_at || null,
    approved_at: row.approved_at || null,
    last_checked_at: row.last_checked_at || null,
    last_event_source: row.last_event_source || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function buildExternalReference() {
  return `mozzo_mp_${crypto.randomUUID()}`;
}

function buildMockPaymentId(externalReference) {
  return `mock_payment_${externalReference}`;
}

function buildReturnUrl(result, externalReference) {
  const params = new URLSearchParams({
    result,
    external_reference: externalReference,
  });

  return `${getBackendBaseUrl()}/api/payments/mercado-pago/return?${params.toString()}`;
}

function buildNotificationUrl() {
  return `${getBackendBaseUrl()}/api/payments/mercado-pago/webhook`;
}

function buildCheckoutTitle(order, restaurantName) {
  const venueName = String(restaurantName || 'Mozzo').trim() || 'Mozzo';
  return `${venueName} · Mesa ${order.table_id} · Pedido #${order.id}`;
}

function buildMercadoPagoPaymentNote(payment) {
  const paymentId = payment?.id ? ` #${payment.id}` : '';
  const payerEmail = payment?.payer?.email ? ` · ${payment.payer.email}` : '';
  return normalizePaymentNote(`Mercado Pago${paymentId}${payerEmail}`);
}

function getMercadoPagoClient() {
  ensureMercadoPagoConfigured();

  if (isMercadoPagoMockMode()) {
    return null;
  }

  if (!mercadoPagoClient) {
    mercadoPagoClient = new MercadoPagoConfig({
      accessToken: String(process.env.MP_ACCESS_TOKEN || '').trim(),
      options: {
        timeout: 10000,
      },
    });
  }

  return mercadoPagoClient;
}

function getPreferenceClient() {
  if (isMercadoPagoMockMode()) {
    return null;
  }

  if (!preferenceClient) {
    preferenceClient = new Preference(getMercadoPagoClient());
  }

  return preferenceClient;
}

function getPaymentClient() {
  if (isMercadoPagoMockMode()) {
    return null;
  }

  if (!paymentClient) {
    paymentClient = new Payment(getMercadoPagoClient());
  }

  return paymentClient;
}

function isCheckoutExpired(checkout) {
  if (!checkout?.expires_at) {
    return false;
  }

  const expiresAt = new Date(checkout.expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt < Date.now();
}

async function getCheckoutById(database, checkoutId) {
  const normalizedCheckoutId = ensurePositiveInteger(checkoutId, 'checkout_id');
  const row = await database.get(
    `
      SELECT ${CHECKOUT_SELECT_FIELDS}
      FROM mercado_pago_checkouts
      WHERE id = ?
    `,
    [normalizedCheckoutId]
  );

  return mapCheckoutRow(row);
}

async function getCheckoutByExternalReference(database, externalReference) {
  const normalizedValue = String(externalReference || '').trim();

  if (!normalizedValue) {
    return null;
  }

  const row = await database.get(
    `
      SELECT ${CHECKOUT_SELECT_FIELDS}
      FROM mercado_pago_checkouts
      WHERE external_reference = ?
      LIMIT 1
    `,
    [normalizedValue]
  );

  return mapCheckoutRow(row);
}

async function getCheckoutByPaymentId(database, paymentId) {
  const normalizedValue = String(paymentId || '').trim();

  if (!normalizedValue) {
    return null;
  }

  const row = await database.get(
    `
      SELECT ${CHECKOUT_SELECT_FIELDS}
      FROM mercado_pago_checkouts
      WHERE payment_id = ?
      LIMIT 1
    `,
    [normalizedValue]
  );

  return mapCheckoutRow(row);
}

async function findReusablePendingCheckout(database, orderId, amount) {
  const row = await database.get(
    `
      SELECT ${CHECKOUT_SELECT_FIELDS}
      FROM mercado_pago_checkouts
      WHERE order_id = ?
        AND status = 'pending'
        AND sync_disposition = 'pending'
        AND order_payment_id IS NULL
        AND ABS(amount - ?) <= ?
        AND (expires_at IS NULL OR expires_at >= CURRENT_TIMESTAMP)
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [orderId, roundMoney(amount), MONEY_EPSILON]
  );

  return mapCheckoutRow(row);
}

async function updateCheckout(database, checkoutId, updates = {}) {
  const normalizedCheckoutId = ensurePositiveInteger(checkoutId, 'checkout_id');
  const fields = [];
  const values = [];

  Object.entries(updates).forEach(([key, value]) => {
    fields.push(`${key} = ?`);
    values.push(value);
  });

  if (fields.length === 0) {
    return getCheckoutById(database, normalizedCheckoutId);
  }

  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(normalizedCheckoutId);

  await database.run(
    `
      UPDATE mercado_pago_checkouts
      SET ${fields.join(', ')}
      WHERE id = ?
    `,
    values
  );

  return getCheckoutById(database, normalizedCheckoutId);
}

function createCheckoutTransitionUpdate(checkout, payment, {
  status,
  syncDisposition,
  statusReason = null,
  orderPaymentId = checkout?.order_payment_id || null,
  approvedAt = checkout?.approved_at || null,
  eventSource = 'sync',
} = {}) {
  if (!CHECKOUT_STATUSES.has(status)) {
    throw new Error(`Unsupported Mercado Pago checkout status: ${status}`);
  }

  if (!CHECKOUT_SYNC_DISPOSITIONS.has(syncDisposition)) {
    throw new Error(`Unsupported Mercado Pago checkout disposition: ${syncDisposition}`);
  }

  return {
    status,
    sync_disposition: syncDisposition,
    payment_id: payment?.id ? String(payment.id) : checkout?.payment_id || null,
    payment_status: payment?.status ? String(payment.status).trim().toLowerCase() : checkout?.payment_status || null,
    payment_status_detail: payment?.status_detail ? String(payment.status_detail).trim() : checkout?.payment_status_detail || null,
    payer_email: payment?.payer?.email || checkout?.payer_email || null,
    order_payment_id: orderPaymentId,
    status_reason: statusReason,
    approved_at: approvedAt,
    last_checked_at: formatSqlTimestamp(new Date()),
    last_event_source: eventSource,
  };
}

function buildExternalStatusReason(checkout, payment, nextStatus) {
  const detail = String(payment?.status_detail || '').trim();

  if (nextStatus === 'pending') {
    return checkout?.sync_disposition === 'stale' ? checkout.status_reason : null;
  }

  if (['rejected', 'cancelled', 'expired', 'failed'].includes(nextStatus)) {
    return detail || `Mercado Pago reportó el intento como ${nextStatus}.`;
  }

  if (['refunded', 'charged_back', 'reversed'].includes(nextStatus)) {
    if (checkout?.order_payment_id) {
      return `Mercado Pago reportó ${nextStatus}. El ledger interno no se revirtió automáticamente; registrá una reversión manual si corresponde.`;
    }

    return detail || `Mercado Pago reportó el intento como ${nextStatus}.`;
  }

  return null;
}

async function preserveCheckoutState(database, checkout, payment, eventSource) {
  return updateCheckout(
    database,
    checkout.id,
    createCheckoutTransitionUpdate(checkout, payment, {
      status: checkout.status,
      syncDisposition: checkout.sync_disposition,
      statusReason: checkout.status_reason || null,
      orderPaymentId: checkout.order_payment_id || null,
      approvedAt: checkout.approved_at || null,
      eventSource,
    })
  );
}

async function markCheckoutPendingState(database, checkout, payment, eventSource) {
  if (checkout.sync_disposition === 'stale' || checkout.sync_disposition === 'mismatched') {
    return preserveCheckoutState(database, checkout, payment, eventSource);
  }

  return updateCheckout(
    database,
    checkout.id,
    createCheckoutTransitionUpdate(checkout, payment, {
      status: 'pending',
      syncDisposition: 'pending',
      statusReason: null,
      eventSource,
    })
  );
}

async function markCheckoutIgnoredState(database, checkout, payment, nextStatus, eventSource) {
  return updateCheckout(
    database,
    checkout.id,
    createCheckoutTransitionUpdate(checkout, payment, {
      status: nextStatus,
      syncDisposition: 'ignored',
      statusReason: buildExternalStatusReason(checkout, payment, nextStatus),
      eventSource,
    })
  );
}

async function markCheckoutMismatch(database, checkout, payment, reason, eventSource, options = {}) {
  const attachPaymentId = options.attachPaymentId !== false;
  const paymentSnapshot = attachPaymentId
    ? payment
    : { ...payment, id: checkout?.payment_id || null };

  return updateCheckout(
    database,
    checkout.id,
    createCheckoutTransitionUpdate(checkout, paymentSnapshot, {
      status: buildCheckoutStatusFromPaymentStatus(payment?.status),
      syncDisposition: 'mismatched',
      statusReason: reason,
      eventSource,
    })
  );
}

async function markCheckoutStale(database, checkout, payment, reason, eventSource) {
  const approvedAt = payment?.date_approved
    ? formatSqlTimestamp(payment.date_approved)
    : checkout?.approved_at || null;

  return updateCheckout(
    database,
    checkout.id,
    createCheckoutTransitionUpdate(checkout, payment, {
      status: buildCheckoutStatusFromPaymentStatus(payment?.status),
      syncDisposition: 'stale',
      statusReason: reason,
      eventSource,
      approvedAt,
    })
  );
}

async function markObsoletePendingCheckoutsForOrder(database, orderId, currentAmount, eventSource = 'checkout_create') {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  const rows = await database.all(
    `
      SELECT ${CHECKOUT_SELECT_FIELDS}
      FROM mercado_pago_checkouts
      WHERE order_id = ?
        AND status = 'pending'
        AND sync_disposition = 'pending'
        AND order_payment_id IS NULL
    `,
    [normalizedOrderId]
  );

  for (const row of rows) {
    const checkout = mapCheckoutRow(row);
    const sameAmount = Math.abs(Number(checkout.amount || 0) - Number(currentAmount || 0)) <= MONEY_EPSILON;

    if (sameAmount && !isCheckoutExpired(checkout)) {
      continue;
    }

    const nextStatus = isCheckoutExpired(checkout) ? 'expired' : 'pending';
    const nextDisposition = isCheckoutExpired(checkout) ? 'ignored' : 'stale';
    const nextReason = isCheckoutExpired(checkout)
      ? 'El checkout venció antes de reutilizarse.'
      : 'El saldo cambió y este checkout quedó desactualizado.';

    await updateCheckout(
      database,
      checkout.id,
      {
        status: nextStatus,
        sync_disposition: nextDisposition,
        status_reason: nextReason,
        last_checked_at: formatSqlTimestamp(new Date()),
        last_event_source: eventSource,
      }
    );
  }
}

function ensureOrderCanStartCheckout(order) {
  if (!order) {
    throw createOrderError('NO_OPEN_ORDER', 'No hay un pedido abierto para iniciar el pago online.', 404);
  }

  if (order.closed_at) {
    throw createOrderError('ORDER_ALREADY_CLOSED', 'La mesa ya fue cerrada para este pedido.', 409);
  }

  if (order.status !== 'delivered') {
    throw createOrderError('ORDER_NOT_DELIVERED', 'El pedido todavía no fue entregado.', 409);
  }

  if (!order.bill_attended_at) {
    throw createOrderError('BILL_NOT_ATTENDED', 'La cuenta todavía no fue entregada.', 409);
  }

  if (Number(order.amount_due || 0) <= MONEY_EPSILON) {
    throw createOrderError('ORDER_ALREADY_PAID', 'El pedido ya quedó completamente saldado.', 409);
  }
}

async function createMercadoPagoPreference({ externalReference, order, amount, restaurantName }) {
  if (isMercadoPagoMockMode()) {
    const initPoint = `${buildReturnUrl('success', externalReference)}&payment_id=${encodeURIComponent(buildMockPaymentId(externalReference))}`;

    return {
      id: `mock_pref_${externalReference}`,
      init_point: initPoint,
      sandbox_init_point: initPoint,
      expires_at: new Date(Date.now() + CHECKOUT_TTL_MINUTES * 60 * 1000).toISOString(),
    };
  }

  const preference = getPreferenceClient();
  const expirationDate = new Date(Date.now() + CHECKOUT_TTL_MINUTES * 60 * 1000);
  const title = buildCheckoutTitle(order, restaurantName);
  const body = {
    external_reference: externalReference,
    notification_url: buildNotificationUrl(),
    auto_return: 'approved',
    back_urls: {
      success: buildReturnUrl('success', externalReference),
      pending: buildReturnUrl('pending', externalReference),
      failure: buildReturnUrl('failure', externalReference),
    },
    expires: true,
    expiration_date_to: expirationDate.toISOString(),
    items: [
      {
        id: String(order.id),
        title,
        quantity: 1,
        currency_id: 'ARS',
        unit_price: roundMoney(amount),
      },
    ],
    metadata: {
      mozzo_order_id: order.id,
      mozzo_table_id: order.table_id,
      mozzo_external_reference: externalReference,
    },
  };

  return preference.create({
    body,
    requestOptions: {
      idempotencyKey: crypto.randomUUID(),
    },
  });
}

async function createCheckoutForTable(database, tableId, options = {}) {
  ensureMercadoPagoConfigured();
  const activeOrder = await getActiveOrderForTable(database, tableId);
  ensureOrderCanStartCheckout(activeOrder);
  const amount = roundMoney(activeOrder.amount_due);

  await markObsoletePendingCheckoutsForOrder(database, activeOrder.id, amount, 'checkout_create');

  const reusableCheckout = await findReusablePendingCheckout(database, activeOrder.id, amount);
  if (reusableCheckout) {
    return reusableCheckout;
  }

  const externalReference = buildExternalReference();
  const preference = await createMercadoPagoPreference({
    externalReference,
    order: activeOrder,
    amount,
    restaurantName: options.restaurant_name,
  });
  const expiresAt = preference.date_of_expiration || preference.expiration_date_to || preference.expires_at || new Date(Date.now() + CHECKOUT_TTL_MINUTES * 60 * 1000).toISOString();

  try {
    const result = await database.run(
      `
        INSERT INTO mercado_pago_checkouts (
          order_id,
          amount,
          currency_id,
          status,
          sync_disposition,
          external_reference,
          preference_id,
          checkout_url,
          sandbox_checkout_url,
          expires_at,
          last_event_source
        )
        VALUES (?, ?, 'ARS', 'pending', 'pending', ?, ?, ?, ?, ?, 'checkout_create')
      `,
      [
        activeOrder.id,
        amount,
        externalReference,
        preference.id || null,
        preference.init_point || null,
        preference.sandbox_init_point || null,
        formatSqlTimestamp(expiresAt),
      ]
    );

    return getCheckoutById(database, result.lastID);
  } catch (error) {
    if (isSinglePendingCheckoutConstraint(error)) {
      const existingCheckout = await findReusablePendingCheckout(database, activeOrder.id, amount);

      if (existingCheckout) {
        return existingCheckout;
      }
    }

    throw error;
  }
}

function parseMockPaymentDescriptor(paymentId, checkout = null) {
  const normalizedPaymentId = String(paymentId || '').trim();

  if (!normalizedPaymentId) {
    return null;
  }

  const legacyPrefix = 'mock_payment_';
  if (normalizedPaymentId.startsWith(legacyPrefix) && !normalizedPaymentId.startsWith('mock_payment__')) {
    return {
      status: 'approved',
      amount: checkout?.amount || 0,
      external_reference: normalizedPaymentId.slice(legacyPrefix.length),
    };
  }

  if (!normalizedPaymentId.startsWith('mock_payment__')) {
    return null;
  }

  const descriptor = {};
  const segments = normalizedPaymentId.split('__').slice(1);

  for (const segment of segments) {
    const [rawKey, ...valueParts] = segment.split('=');
    const key = String(rawKey || '').trim();
    const value = valueParts.join('=').trim();

    if (!key) {
      continue;
    }

    descriptor[key] = value;
  }

  return {
    id: String(descriptor.id || normalizedPaymentId).trim(),
    status: String(descriptor.status || 'approved').trim().toLowerCase(),
    amount: descriptor.amount == null ? checkout?.amount || 0 : Number(descriptor.amount),
    external_reference: String(descriptor.external_reference || checkout?.external_reference || '').trim(),
  };
}

function buildMockPayment(checkout, paymentId) {
  const descriptor = parseMockPaymentDescriptor(paymentId, checkout) || {
    status: 'approved',
    amount: checkout?.amount || 0,
    external_reference: checkout?.external_reference || '',
  };
  const normalizedStatus = String(descriptor.status || 'approved').trim().toLowerCase();

  return {
    id: descriptor.id || paymentId || buildMockPaymentId(checkout.external_reference),
    status: normalizedStatus,
    status_detail: normalizedStatus === 'approved' ? 'accredited' : `${normalizedStatus}_mock`,
    external_reference: descriptor.external_reference,
    transaction_amount: Number.isFinite(Number(descriptor.amount)) ? roundMoney(descriptor.amount) : roundMoney(checkout.amount),
    payer: {
      email: 'mockpayer@mozzo.test',
    },
    date_approved: new Date().toISOString(),
  };
}

async function getMercadoPagoPaymentById(database, paymentId, checkout = null) {
  if (isMercadoPagoMockMode()) {
    const descriptor = parseMockPaymentDescriptor(paymentId, checkout);
    const nextCheckout = checkout || await getCheckoutByExternalReference(
      database,
      descriptor?.external_reference || String(paymentId || '').replace(/^mock_payment_/, '')
    );

    if (!nextCheckout) {
      throw createMercadoPagoError('MERCADO_PAGO_PAYMENT_NOT_FOUND', 'No pudimos encontrar ese pago de Mercado Pago.', 404);
    }

    return buildMockPayment(nextCheckout, paymentId);
  }

  const payment = getPaymentClient();
  return payment.get({ id: paymentId });
}

function buildOrderPaymentIdempotentNote(payment) {
  return buildMercadoPagoPaymentNote(payment);
}

function buildStaleApprovedReason(order, fallbackMessage) {
  if (!order) {
    return 'No encontramos el pedido asociado a este checkout.';
  }

  if (order.closed_at) {
    return 'El pedido ya fue cerrado y no admite nuevos pagos.';
  }

  if (order.status !== 'delivered' || !order.bill_attended_at) {
    return 'El pedido ya no está en un estado válido para registrar el pago online.';
  }

  return fallbackMessage;
}

async function applyMercadoPagoPayment(database, checkout, payment, eventSource = 'sync') {
  return database.withTransaction(async () => {
    const currentCheckout = await getCheckoutByExternalReference(database, checkout.external_reference);

    if (!currentCheckout) {
      return { checkout: null, order: null, applied: false, ignored: true };
    }

    const normalizedPaymentId = String(payment?.id || '').trim();
    const nextStatus = buildCheckoutStatusFromPaymentStatus(payment?.status);

    if (
      currentCheckout.sync_disposition === 'mismatched'
      || (
        currentCheckout.order_payment_id
        && currentCheckout.status === 'approved'
        && !['approved', 'refunded', 'charged_back', 'reversed'].includes(nextStatus)
      )
      || (
        ['refunded', 'charged_back', 'reversed'].includes(currentCheckout.status)
        && nextStatus !== currentCheckout.status
      )
    ) {
      return {
        checkout: await preserveCheckoutState(database, currentCheckout, payment, eventSource),
        order: await getOrderById(database, currentCheckout.order_id),
        applied: false,
      };
    }

    if (currentCheckout.order_payment_id) {
      if (normalizedPaymentId && currentCheckout.payment_id && normalizedPaymentId !== currentCheckout.payment_id) {
        return {
          checkout: await markCheckoutMismatch(
            database,
            currentCheckout,
            payment,
            'El checkout ya quedó aplicado con otro payment_id externo.',
            eventSource,
            { attachPaymentId: false }
          ),
          order: await getOrderById(database, currentCheckout.order_id),
          applied: false,
        };
      }

      if (nextStatus === 'approved') {
        return {
          checkout: await updateCheckout(
            database,
            currentCheckout.id,
            createCheckoutTransitionUpdate(currentCheckout, payment, {
              status: 'approved',
              syncDisposition: 'applied',
              statusReason: null,
              orderPaymentId: currentCheckout.order_payment_id,
              approvedAt: currentCheckout.approved_at || formatSqlTimestamp(payment?.date_approved || new Date()),
              eventSource,
            })
          ),
          order: await getOrderById(database, currentCheckout.order_id),
          applied: false,
        };
      }

      if (['refunded', 'charged_back', 'reversed'].includes(nextStatus)) {
        return {
          checkout: await markCheckoutIgnoredState(database, currentCheckout, payment, nextStatus, eventSource),
          order: await getOrderById(database, currentCheckout.order_id),
          applied: false,
        };
      }

      return {
        checkout: await preserveCheckoutState(database, currentCheckout, payment, eventSource),
        order: await getOrderById(database, currentCheckout.order_id),
        applied: false,
      };
    }

    if (payment?.external_reference && String(payment.external_reference).trim() !== currentCheckout.external_reference) {
      return {
        checkout: await markCheckoutMismatch(
          database,
          currentCheckout,
          payment,
          'La referencia externa informada por Mercado Pago no coincide con este checkout.',
          eventSource,
          { attachPaymentId: false }
        ),
        order: await getOrderById(database, currentCheckout.order_id),
        applied: false,
      };
    }

    if (normalizedPaymentId) {
      const paymentLinkedElsewhere = await getCheckoutByPaymentId(database, normalizedPaymentId);

      if (paymentLinkedElsewhere && paymentLinkedElsewhere.id !== currentCheckout.id) {
        return {
          checkout: await markCheckoutMismatch(
            database,
            currentCheckout,
            payment,
            'Ese payment_id ya quedó asociado a otro checkout.',
            eventSource,
            { attachPaymentId: false }
          ),
          order: await getOrderById(database, currentCheckout.order_id),
          applied: false,
        };
      }
    }

    if (nextStatus !== 'approved') {
      if (nextStatus === 'pending') {
        return {
          checkout: await markCheckoutPendingState(database, currentCheckout, payment, eventSource),
          order: await getOrderById(database, currentCheckout.order_id),
          applied: false,
        };
      }

      return {
        checkout: await markCheckoutIgnoredState(database, currentCheckout, payment, nextStatus, eventSource),
        order: await getOrderById(database, currentCheckout.order_id),
        applied: false,
      };
    }

    const amount = roundMoney(payment?.transaction_amount ?? currentCheckout.amount);

    if (Math.abs(amount - Number(currentCheckout.amount || 0)) > MONEY_EPSILON) {
      return {
        checkout: await markCheckoutMismatch(
          database,
          currentCheckout,
          payment,
          'El monto aprobado por Mercado Pago no coincide con el checkout pendiente.',
          eventSource
        ),
        order: await getOrderById(database, currentCheckout.order_id),
        applied: false,
      };
    }

    const order = await getOrderById(database, currentCheckout.order_id);

    if (!order || order.closed_at || order.status !== 'delivered' || !order.bill_attended_at) {
      return {
        checkout: await markCheckoutStale(
          database,
          currentCheckout,
          payment,
          buildStaleApprovedReason(order, 'El pedido ya no está disponible para aplicar este cobro.'),
          eventSource
        ),
        order,
        applied: false,
      };
    }

    try {
      validatePaymentAgainstOrder(order, order.payments, amount);
    } catch (error) {
      return {
        checkout: await markCheckoutStale(
          database,
          currentCheckout,
          payment,
          buildStaleApprovedReason(order, error.message),
          eventSource
        ),
        order,
        applied: false,
      };
    }

    const openRegister = await getOpenRegister(database);
    const paymentRow = await createPaymentForOrder(database, {
      order_id: currentCheckout.order_id,
      cash_register_session_id: openRegister?.id || null,
      amount,
      method: MERCADO_PAGO_METHOD,
      note: buildOrderPaymentIdempotentNote(payment),
      created_by: 'mercado_pago',
    });
    const refreshedOrder = await syncOrderFinancialStateAfterLedgerChange(database, currentCheckout.order_id);
    const approvedCheckout = await updateCheckout(
      database,
      currentCheckout.id,
      createCheckoutTransitionUpdate(currentCheckout, payment, {
        status: 'approved',
        syncDisposition: 'applied',
        statusReason: null,
        orderPaymentId: paymentRow?.id || null,
        approvedAt: formatSqlTimestamp(payment?.date_approved || new Date()),
        eventSource,
      })
    );

    return { checkout: approvedCheckout, order: refreshedOrder, applied: true };
  });
}

async function syncMercadoPagoCheckout(database, { paymentId = null, externalReference = null, eventSource = 'sync' } = {}) {
  const normalizedPaymentId = String(paymentId || '').trim();
  const normalizedExternalReference = String(externalReference || '').trim();

  let checkout = normalizedExternalReference
    ? await getCheckoutByExternalReference(database, normalizedExternalReference)
    : null;
  let payment = null;

  if (!checkout && !normalizedPaymentId) {
    return { checkout: null, order: null, applied: false, ignored: true };
  }

  if (!checkout && normalizedPaymentId) {
    payment = await getMercadoPagoPaymentById(database, normalizedPaymentId, checkout);
    const paymentExternalReference = String(payment?.external_reference || '').trim();

    if (paymentExternalReference) {
      checkout = await getCheckoutByExternalReference(database, paymentExternalReference);
    }
  }

  if (!checkout) {
    return { checkout: null, order: null, applied: false, ignored: true };
  }

  if (!normalizedPaymentId) {
    if (checkout.status === 'pending' && checkout.sync_disposition === 'pending' && isCheckoutExpired(checkout)) {
      checkout = await updateCheckout(database, checkout.id, {
        status: 'expired',
        sync_disposition: 'ignored',
        status_reason: 'El checkout venció antes de confirmarse el pago.',
        last_checked_at: formatSqlTimestamp(new Date()),
        last_event_source: eventSource,
      });
    }

    return { checkout, order: await getOrderById(database, checkout.order_id), applied: false, ignored: true };
  }

  if (!payment) {
    payment = await getMercadoPagoPaymentById(database, normalizedPaymentId, checkout);
  }

  const appliedResult = await applyMercadoPagoPayment(database, checkout, payment, eventSource);
  return {
    ...appliedResult,
    ignored: false,
    payment,
  };
}

function extractMercadoPagoPaymentId(payload = {}, query = {}) {
  const candidates = [
    payload?.data?.id,
    payload?.id,
    query?.['data.id'],
    query?.id,
    query?.payment_id,
    query?.collection_id,
  ];

  for (const candidate of candidates) {
    const normalizedValue = String(candidate || '').trim();
    if (normalizedValue) {
      return normalizedValue;
    }
  }

  return null;
}

function extractMercadoPagoExternalReference(payload = {}, query = {}) {
  const candidates = [
    payload?.external_reference,
    payload?.data?.external_reference,
    query?.external_reference,
  ];

  for (const candidate of candidates) {
    const normalizedValue = String(candidate || '').trim();
    if (normalizedValue) {
      return normalizedValue;
    }
  }

  return null;
}

function buildMercadoPagoReturnRedirect(tableId, status) {
  const params = new URLSearchParams({ mp_status: status || 'pending' });
  return `${getFrontendBaseUrl()}/${tableId}?${params.toString()}`;
}

module.exports = {
  ACTIVE_CHECKOUT_STATUSES,
  ACTIVE_CHECKOUT_DISPOSITIONS,
  CHECKOUT_TTL_MINUTES,
  MERCADO_PAGO_METHOD,
  buildMercadoPagoReturnRedirect,
  createCheckoutForTable,
  createMercadoPagoError,
  extractMercadoPagoExternalReference,
  extractMercadoPagoPaymentId,
  getCheckoutByExternalReference,
  getCheckoutById,
  getCheckoutByPaymentId,
  isMercadoPagoConfigured,
  isMercadoPagoMockMode,
  syncMercadoPagoCheckout,
};
