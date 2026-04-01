const {
  MONEY_EPSILON,
  createPaymentForOrder: createPaymentRecord,
  createPaymentReversalForPayment: createPaymentReversalRecord,
  listPaymentsForOrder,
  listPaymentsForOrderIds,
  normalizePaymentMethod,
  roundMoney,
  summarizeOrderPayments,
  validatePaymentAgainstOrder,
  validatePaymentReversalAgainstPayment,
} = require('./order-payments');
const { getOpenRegister } = require('./cash-register');
const {
  createInitialSuborderForOrder,
  listSubordersForOrder,
  listSubordersForOrderIds,
  summarizeSuborders,
  updateSuborderStatus,
} = require('./order-suborders');

const ACTIVE_ORDER_STATUSES = ['pending', 'processing', 'ready', 'delivered'];
const VALID_ORDER_STATUSES = new Set(ACTIVE_ORDER_STATUSES);
const VALID_HISTORY_PRESETS = new Set(['today', 'last_7_days']);
const VALID_HISTORY_PAYMENT_FILTERS = new Set(['cash', 'card', 'transfer', 'other', 'mercado_pago', 'split']);
const LEGACY_ORDER_PAYMENT_METHODS = new Set(['cash', 'card', 'transfer', 'other']);
const VALID_BILL_PAYMENT_METHOD_PREFERENCES = new Set(['cash', 'card', 'mercado_pago']);
const VALID_BILL_COLLECTION_STATUSES = new Set([
  'requested',
  'waiting_cash',
  'waiting_card',
  'checkout_pending',
  'partial_payment',
  'payment_recorded',
]);
const MAX_COMMENT_LENGTH = 250;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

function createOrderError(code, message, status = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function ensurePositiveInteger(value, fieldName) {
  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw createOrderError('INVALID_ORDER_PAYLOAD', `${fieldName} must be a positive integer`);
  }

  return parsedValue;
}

function normalizeComments(value, fieldName) {
  if (value == null) {
    return '';
  }

  if (typeof value !== 'string') {
    throw createOrderError('INVALID_ORDER_PAYLOAD', `${fieldName} must be a string`);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length > MAX_COMMENT_LENGTH) {
    throw createOrderError(
      'INVALID_ORDER_PAYLOAD',
      `${fieldName} must be ${MAX_COMMENT_LENGTH} characters or fewer`
    );
  }

  return normalizedValue;
}

function normalizeBillPaymentMethodPreference(value, { allowNull = false } = {}) {
  if (value == null || String(value).trim() === '') {
    return allowNull ? null : 'cash';
  }

  const normalizedValue = String(value).trim().toLowerCase();

  if (!VALID_BILL_PAYMENT_METHOD_PREFERENCES.has(normalizedValue)) {
    throw createOrderError(
      'INVALID_BILL_PAYMENT_METHOD',
      'El medio elegido para pedir la cuenta es inválido.',
      400
    );
  }

  return normalizedValue;
}

function normalizeBillCollectionStatus(value) {
  if (value == null || String(value).trim() === '') {
    return null;
  }

  const normalizedValue = String(value).trim().toLowerCase();
  return VALID_BILL_COLLECTION_STATUSES.has(normalizedValue) ? normalizedValue : null;
}

function normalizeOrderPayload(payload) {
  const tableId = ensurePositiveInteger(payload?.table_id, 'table_id');
  const rawItems = payload?.items;

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw createOrderError('INVALID_ORDER_PAYLOAD', 'items must be a non-empty array');
  }

  const items = rawItems.map((item, index) => ({
    item_id: ensurePositiveInteger(item?.item_id, `items[${index}].item_id`),
    quantity: ensurePositiveInteger(item?.quantity, `items[${index}].quantity`),
    comments: normalizeComments(item?.comments, `items[${index}].comments`)
  }));

  return {
    table_id: tableId,
    items
  };
}

function padDateSegment(value) {
  return String(value).padStart(2, '0');
}

function formatUtcSqlTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function formatLocalDateValue(date) {
  return [
    date.getFullYear(),
    padDateSegment(date.getMonth() + 1),
    padDateSegment(date.getDate()),
  ].join('-');
}

function createLocalDate(dateString, fieldName) {
  const normalizedValue = String(dateString || '').trim();

  if (!normalizedValue) {
    return null;
  }

  const match = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    throw createOrderError('INVALID_HISTORY_FILTER', `${fieldName} debe tener formato YYYY-MM-DD.`, 400);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const nextDate = new Date(year, month - 1, day);

  if (
    nextDate.getFullYear() !== year
    || nextDate.getMonth() !== month - 1
    || nextDate.getDate() !== day
  ) {
    throw createOrderError('INVALID_HISTORY_FILTER', `${fieldName} no es una fecha válida.`, 400);
  }

  return nextDate;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function normalizeHistoryFilters(rawFilters = {}) {
  const presetValue = String(rawFilters.preset || 'today').trim().toLowerCase();
  const preset = VALID_HISTORY_PRESETS.has(presetValue) ? presetValue : 'today';
  const fromDate = createLocalDate(rawFilters.from, 'from');
  const toDate = createLocalDate(rawFilters.to, 'to');
  const hasManualRange = Boolean(fromDate || toDate);

  let rangeStart;
  let rangeEnd;

  if (hasManualRange) {
    rangeStart = startOfLocalDay(fromDate || toDate);
    rangeEnd = endOfLocalDay(toDate || fromDate);
  } else {
    const today = new Date();
    rangeEnd = endOfLocalDay(today);
    rangeStart = preset === 'last_7_days'
      ? startOfLocalDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6))
      : startOfLocalDay(today);
  }

  if (rangeStart.getTime() > rangeEnd.getTime()) {
    throw createOrderError('INVALID_HISTORY_FILTER', 'El rango de fechas es inválido.', 400);
  }

  const paymentMethodValue = String(rawFilters.payment_method || '').trim().toLowerCase();
  const paymentMethod = paymentMethodValue
    ? (VALID_HISTORY_PAYMENT_FILTERS.has(paymentMethodValue)
      ? paymentMethodValue
      : (() => {
          throw createOrderError('INVALID_HISTORY_FILTER', 'El filtro de medio de pago es inválido.', 400);
        })())
    : null;

  const limitValue = rawFilters.limit == null ? DEFAULT_HISTORY_LIMIT : Number(rawFilters.limit);
  const offsetValue = rawFilters.offset == null ? 0 : Number(rawFilters.offset);

  if (!Number.isInteger(limitValue) || limitValue <= 0 || limitValue > MAX_HISTORY_LIMIT) {
    throw createOrderError('INVALID_HISTORY_FILTER', `limit debe ser un entero entre 1 y ${MAX_HISTORY_LIMIT}.`, 400);
  }

  if (!Number.isInteger(offsetValue) || offsetValue < 0) {
    throw createOrderError('INVALID_HISTORY_FILTER', 'offset debe ser un entero mayor o igual a 0.', 400);
  }

  return {
    preset: hasManualRange ? null : preset,
    from: formatLocalDateValue(rangeStart),
    to: formatLocalDateValue(rangeEnd),
    payment_method: paymentMethod,
    limit: limitValue,
    offset: offsetValue,
    fromSql: formatUtcSqlTimestamp(rangeStart),
    toSql: formatUtcSqlTimestamp(rangeEnd),
  };
}

function buildClosedHistoryWhereClause(filters) {
  return {
    whereClause: 'WHERE o.closed_at IS NOT NULL AND o.closed_at >= ? AND o.closed_at <= ?',
    params: [filters.fromSql, filters.toSql],
  };
}

function calculateDurationMinutes(start, end) {
  if (!start || !end) {
    return null;
  }

  const durationMs = new Date(end).getTime() - new Date(start).getTime();

  if (Number.isNaN(durationMs) || durationMs <= 0) {
    return null;
  }

  return Math.max(1, Math.round(durationMs / 60000));
}

function buildOrderDurations(order) {
  return {
    prep_minutes: calculateDurationMinutes(order.created_at, order.ready_at),
    service_minutes: calculateDurationMinutes(order.created_at, order.delivered_at),
    to_bill_minutes: calculateDurationMinutes(order.created_at, order.bill_attended_at),
    to_payment_minutes: calculateDurationMinutes(order.created_at, order.payment_received_at),
  };
}

function computeBillCollectionStatus(order) {
  if (!order?.bill_requested_at) {
    return null;
  }

  const amountPaid = Number(order?.amount_paid || 0);
  const amountDue = Number(order?.amount_due || 0);
  const preferredMethod = normalizeBillPaymentMethodPreference(
    order?.bill_payment_method_preference,
    { allowNull: true }
  );

  if (amountDue <= MONEY_EPSILON) {
    return 'payment_recorded';
  }

  if (amountPaid > MONEY_EPSILON) {
    return 'partial_payment';
  }

  switch (preferredMethod) {
    case 'cash':
      return 'waiting_cash';
    case 'card':
      return 'waiting_card';
    case 'mercado_pago':
      return 'checkout_pending';
    default:
      return 'requested';
  }
}

function mapExternalPaymentAttemptRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    provider: 'mercado_pago',
    order_id: row.order_id,
    amount: roundMoney(row.amount),
    currency_id: row.currency_id || 'ARS',
    status: row.status,
    sync_disposition: row.sync_disposition || 'pending',
    external_reference: row.external_reference,
    preference_id: row.preference_id || null,
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

function summarizeExternalPaymentAttempts(attempts = []) {
  const normalizedAttempts = Array.isArray(attempts) ? attempts.filter(Boolean) : [];
  const latestAttempt = normalizedAttempts[normalizedAttempts.length - 1] || null;

  return {
    total_attempts: normalizedAttempts.length,
    pending_count: normalizedAttempts.filter((attempt) => attempt.sync_disposition === 'pending').length,
    applied_count: normalizedAttempts.filter((attempt) => attempt.sync_disposition === 'applied').length,
    ignored_count: normalizedAttempts.filter((attempt) => attempt.sync_disposition === 'ignored').length,
    stale_count: normalizedAttempts.filter((attempt) => attempt.sync_disposition === 'stale').length,
    mismatched_count: normalizedAttempts.filter((attempt) => attempt.sync_disposition === 'mismatched').length,
    has_issues: normalizedAttempts.some((attempt) => ['stale', 'mismatched'].includes(attempt.sync_disposition)),
    latest_status: latestAttempt?.status || null,
    latest_sync_disposition: latestAttempt?.sync_disposition || null,
    latest_status_reason: latestAttempt?.status_reason || null,
    latest_payment_id: latestAttempt?.payment_id || null,
    latest_external_reference: latestAttempt?.external_reference || null,
  };
}

async function listExternalPaymentAttemptsForOrderIds(database, orderIds = []) {
  const uniqueOrderIds = [
    ...new Set(
      (orderIds || [])
        .map((orderId) => Number(orderId))
        .filter((orderId) => Number.isInteger(orderId) && orderId > 0)
    ),
  ];

  if (uniqueOrderIds.length === 0) {
    return new Map();
  }

  const placeholders = uniqueOrderIds.map(() => '?').join(', ');
  const rows = await database.all(
    `
      SELECT
        id,
        order_id,
        amount,
        currency_id,
        status,
        sync_disposition,
        external_reference,
        preference_id,
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
      FROM mercado_pago_checkouts
      WHERE order_id IN (${placeholders})
      ORDER BY created_at ASC, id ASC
    `,
    uniqueOrderIds
  );

  const attemptsByOrderId = new Map(uniqueOrderIds.map((orderId) => [orderId, []]));

  for (const row of rows) {
    const attempt = mapExternalPaymentAttemptRow(row);

    if (!attemptsByOrderId.has(attempt.order_id)) {
      attemptsByOrderId.set(attempt.order_id, []);
    }

    attemptsByOrderId.get(attempt.order_id).push(attempt);
  }

  return attemptsByOrderId;
}

function average(values = []) {
  const validValues = values.filter((value) => Number.isFinite(value));

  if (validValues.length === 0) {
    return null;
  }

  return Number((validValues.reduce((sum, value) => sum + value, 0) / validValues.length).toFixed(2));
}

function mapOrderRows(rows) {
  const orderMap = new Map();

  for (const row of rows) {
    if (!orderMap.has(row.id)) {
      orderMap.set(row.id, {
        id: row.id,
        table_id: row.table_id,
        status: row.status,
        created_at: row.created_at,
        processing_started_at: row.processing_started_at,
        ready_at: row.ready_at,
        delivered_at: row.delivered_at,
        bill_requested_at: row.bill_requested_at,
        bill_attended_at: row.bill_attended_at,
        bill_payment_method_preference: normalizeBillPaymentMethodPreference(
          row.bill_payment_method_preference,
          { allowNull: true }
        ),
        bill_collection_status: normalizeBillCollectionStatus(row.bill_collection_status),
        payment_received_at: row.payment_received_at,
        payment_method: row.payment_method,
        closed_at: row.closed_at,
        total_amount: 0,
        items: []
      });
    }

    if (row.item_id == null) {
      continue;
    }

    orderMap.get(row.id).items.push({
      item_id: row.item_id,
      name: row.item_name || 'Item no disponible',
      description: row.item_description || '',
      price: row.unit_price ?? 0,
      quantity: row.quantity,
      comments: row.comments || ''
    });
  }

  return Array.from(orderMap.values()).map((order) => ({
    ...order,
    total_amount: roundMoney(order.items.reduce(
      (sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 0)),
      0
    )),
  }));
}

function decorateOrderWithPayments(order, payments = [], externalPaymentAttempts = [], suborders = []) {
  const paymentSummary = summarizeOrderPayments(order, payments);
  const attemptsSummary = summarizeExternalPaymentAttempts(externalPaymentAttempts);
  const subordersSummary = summarizeSuborders(suborders);
  const decoratedOrder = {
    ...order,
    payment_received_at: paymentSummary.payment_received_at,
    payment_method: paymentSummary.primary_method,
    payments: paymentSummary.payments,
    amount_paid: paymentSummary.amount_paid,
    amount_due: paymentSummary.amount_due,
    payment_status: paymentSummary.payment_status,
    payments_summary: paymentSummary.payments_summary,
    external_payment_attempts: externalPaymentAttempts,
    external_payment_attempts_summary: attemptsSummary,
    suborders,
    suborders_summary: subordersSummary,
  };

  return {
    ...decoratedOrder,
    can_close: Boolean(
      !decoratedOrder.closed_at
      && decoratedOrder.status === 'delivered'
      && decoratedOrder.bill_attended_at
      && decoratedOrder.amount_due <= MONEY_EPSILON
    ),
    durations: buildOrderDurations(decoratedOrder),
  };
}

async function enrichOrdersWithPayments(database, orders = []) {
  const orderIds = orders.map((order) => order.id);
  const [paymentsByOrderId, externalAttemptsByOrderId, subordersByOrderId] = await Promise.all([
    listPaymentsForOrderIds(database, orderIds),
    listExternalPaymentAttemptsForOrderIds(database, orderIds),
    listSubordersForOrderIds(database, orderIds),
  ]);

  return orders.map((order) => decorateOrderWithPayments(
    order,
    paymentsByOrderId.get(order.id) || [],
    externalAttemptsByOrderId.get(order.id) || [],
    subordersByOrderId.get(order.id) || []
  ));
}

async function getOrderRows(database, whereClause = '', params = [], orderByClause = 'ORDER BY o.created_at DESC, o.id DESC, oi.id ASC') {
  return database.all(
    `
      SELECT
        o.id,
        o.table_id,
        o.status,
        o.created_at,
        o.processing_started_at,
        o.ready_at,
        o.delivered_at,
        o.bill_requested_at,
        o.bill_attended_at,
        o.bill_payment_method_preference,
        o.bill_collection_status,
        o.payment_received_at,
        o.payment_method,
        o.closed_at,
        oi.item_id,
        oi.quantity,
        oi.comments,
        oi.item_name,
        oi.item_description,
        oi.unit_price
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      ${whereClause}
      ${orderByClause}
    `,
    params
  );
}

async function getOrderById(database, orderId) {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  const rows = await getOrderRows(database, 'WHERE o.id = ?', [normalizedOrderId]);
  const mappedOrder = mapOrderRows(rows)[0] || null;

  if (!mappedOrder) {
    return null;
  }

  const [payments, externalAttemptsByOrderId, subordersByOrderId] = await Promise.all([
    listPaymentsForOrder(database, normalizedOrderId),
    listExternalPaymentAttemptsForOrderIds(database, [normalizedOrderId]),
    listSubordersForOrderIds(database, [normalizedOrderId]),
  ]);
  return decorateOrderWithPayments(
    mappedOrder,
    payments,
    externalAttemptsByOrderId.get(normalizedOrderId) || [],
    subordersByOrderId.get(normalizedOrderId) || []
  );
}

async function getOrderRecordById(database, orderId) {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  return database.get(
    `
      SELECT
        id,
        table_id,
        status,
        created_at,
        processing_started_at,
        ready_at,
        delivered_at,
        bill_requested_at,
        bill_attended_at,
        bill_payment_method_preference,
        bill_collection_status,
        payment_received_at,
        payment_method,
        closed_at
      FROM orders
      WHERE id = ?
    `,
    [normalizedOrderId]
  );
}

async function listOrders(database) {
  const rows = await getOrderRows(database);
  return enrichOrdersWithPayments(database, mapOrderRows(rows));
}

async function listOpenOrders(database) {
  const rows = await getOrderRows(database, 'WHERE o.closed_at IS NULL');
  return enrichOrdersWithPayments(database, mapOrderRows(rows));
}

function matchesHistoryPaymentFilter(order, paymentMethod) {
  if (!paymentMethod) {
    return true;
  }

  return order.payment_method === paymentMethod;
}

async function listClosedOrdersHistory(database, rawFilters = {}) {
  const filters = normalizeHistoryFilters(rawFilters);
  const { whereClause, params } = buildClosedHistoryWhereClause(filters);
  const rows = await getOrderRows(
    database,
    whereClause,
    params,
    'ORDER BY o.closed_at DESC, o.id DESC, oi.id ASC'
  );

  const enrichedOrders = await enrichOrdersWithPayments(database, mapOrderRows(rows));
  const filteredOrders = enrichedOrders.filter((order) => matchesHistoryPaymentFilter(order, filters.payment_method));

  return {
    filters: {
      from: filters.from,
      to: filters.to,
      payment_method: filters.payment_method,
      limit: filters.limit,
      offset: filters.offset,
      preset: filters.preset,
    },
    total_count: filteredOrders.length,
    orders: filteredOrders.slice(filters.offset, filters.offset + filters.limit),
  };
}

async function getClosedOrdersHistorySummary(database, rawFilters = {}) {
  const filters = normalizeHistoryFilters(rawFilters);
  const { whereClause, params } = buildClosedHistoryWhereClause(filters);
  const rows = await getOrderRows(
    database,
    whereClause,
    params,
    'ORDER BY o.closed_at DESC, o.id DESC, oi.id ASC'
  );

  const orders = (await enrichOrdersWithPayments(database, mapOrderRows(rows)))
    .filter((order) => matchesHistoryPaymentFilter(order, filters.payment_method));

  const totalRevenue = roundMoney(orders.reduce((sum, order) => sum + Number(order.total_amount || 0), 0));
  const paymentBreakdownMap = new Map();

  for (const order of orders) {
    const bucketKey = order.payment_method || 'unknown';
    const currentBucket = paymentBreakdownMap.get(bucketKey) || {
      payment_method: bucketKey,
      orders_count: 0,
      total_revenue: 0,
    };

    currentBucket.orders_count += 1;
    currentBucket.total_revenue = roundMoney(currentBucket.total_revenue + Number(order.total_amount || 0));
    paymentBreakdownMap.set(bucketKey, currentBucket);
  }

  const paymentMethodOrder = ['cash', 'card', 'transfer', 'other', 'mercado_pago', 'split', 'unknown'];

  return {
    filters: {
      from: filters.from,
      to: filters.to,
      payment_method: filters.payment_method,
      preset: filters.preset,
    },
    summary: {
      orders_count: orders.length,
      total_revenue: totalRevenue,
      average_ticket: orders.length > 0 ? roundMoney(totalRevenue / orders.length) : 0,
      average_prep_minutes: average(orders.map((order) => order?.durations?.prep_minutes)),
      average_service_minutes: average(orders.map((order) => order?.durations?.service_minutes)),
      average_to_payment_minutes: average(orders.map((order) => order?.durations?.to_payment_minutes)),
    },
    payment_breakdown: Array.from(paymentBreakdownMap.values()).sort(
      (left, right) => paymentMethodOrder.indexOf(left.payment_method) - paymentMethodOrder.indexOf(right.payment_method)
    ),
  };
}

async function getActiveOrderIdForTable(database, tableId) {
  const normalizedTableId = ensurePositiveInteger(tableId, 'table_id');
  const activeOrder = await database.get(
    `
      SELECT id
      FROM orders
      WHERE table_id = ?
        AND closed_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedTableId]
  );

  return activeOrder?.id || null;
}

async function getActiveOrderForTable(database, tableId) {
  const activeOrderId = await getActiveOrderIdForTable(database, tableId);
  return activeOrderId ? getOrderById(database, activeOrderId) : null;
}

async function getLatestOrderForTable(database, tableId) {
  const normalizedTableId = ensurePositiveInteger(tableId, 'table_id');
  const latestOrder = await database.get(
    `
      SELECT id
      FROM orders
      WHERE table_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedTableId]
  );

  return latestOrder?.id ? getOrderById(database, latestOrder.id) : null;
}

async function getOrderSessionForTable(database, tableId) {
  const [activeOrder, latestOrder] = await Promise.all([
    getActiveOrderForTable(database, tableId),
    getLatestOrderForTable(database, tableId),
  ]);

  return {
    active_order: activeOrder,
    latest_order: latestOrder,
  };
}

async function ensureSingleOpenOrderForTable(database, tableId) {
  const activeOrder = await getActiveOrderForTable(database, tableId);

  if (activeOrder) {
    throw createOrderError(
      'OPEN_ORDER_ALREADY_EXISTS',
      'La mesa ya tiene un pedido abierto.',
      409
    );
  }
}

async function createOrder(database, payload) {
  const normalizedPayload = normalizeOrderPayload(payload);
  try {
    return await database.withTransaction(async () => {
      await ensureSingleOpenOrderForTable(database, normalizedPayload.table_id);

      const orderResult = await database.run(
        `INSERT INTO orders (table_id, status) VALUES (?, 'pending')`,
        [normalizedPayload.table_id]
      );

      await createInitialSuborderForOrder(
        database,
        orderResult.lastID,
        normalizedPayload.table_id,
        normalizedPayload.items
      );

      return getOrderById(database, orderResult.lastID);
    });
  } catch (error) {
    if (error?.code === 'SQLITE_CONSTRAINT' || /idx_orders_single_open_per_table/i.test(error?.message || '')) {
      throw createOrderError('OPEN_ORDER_ALREADY_EXISTS', 'La mesa ya tiene un pedido abierto.', 409);
    }

    throw error;
  }
}

async function updateOrderStatus(database, orderId, status) {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  if (!VALID_ORDER_STATUSES.has(status)) {
    throw createOrderError('INVALID_ORDER_STATUS', 'status is invalid');
  }

  const currentOrder = await getOrderRecordById(database, normalizedOrderId);

  if (!currentOrder) {
    throw createOrderError('ORDER_NOT_FOUND', 'Order not found', 404);
  }

  if (currentOrder.closed_at) {
    throw createOrderError('ORDER_ALREADY_CLOSED', 'La mesa ya fue cerrada para este pedido.', 409);
  }

  const suborders = await listSubordersForOrder(database, normalizedOrderId);
  const nextSuborder = [...suborders]
    .filter((suborder) => suborder.status !== 'cancelled')
    .sort((left, right) => {
      const leftTime = Date.parse(left.created_at || '') || 0;
      const rightTime = Date.parse(right.created_at || '') || 0;
      return rightTime - leftTime || right.id - left.id;
    })[0];

  if (!nextSuborder) {
    throw createOrderError('SUBORDER_NOT_FOUND', 'No encontramos un subpedido operativo para actualizar.', 404);
  }

  const updatedSuborder = await updateSuborderStatus(database, nextSuborder.id, status);
  const nextOrder = await getOrderById(database, normalizedOrderId);

  return {
    order: nextOrder,
    suborder: updatedSuborder,
  };
}

async function syncBillCollectionStateForOrder(database, orderId) {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  const order = await getOrderById(database, normalizedOrderId);

  if (!order) {
    return null;
  }

  const nextStatus = computeBillCollectionStatus(order);
  const nextPreferredMethod = order.bill_requested_at
    ? normalizeBillPaymentMethodPreference(order.bill_payment_method_preference, { allowNull: true })
    : null;

  if (
    nextStatus === normalizeBillCollectionStatus(order.bill_collection_status)
    && nextPreferredMethod === normalizeBillPaymentMethodPreference(order.bill_payment_method_preference, { allowNull: true })
  ) {
    return order;
  }

  await database.run(
    `
      UPDATE orders
      SET
        bill_payment_method_preference = ?,
        bill_collection_status = ?
      WHERE id = ?
    `,
    [nextPreferredMethod, nextStatus, normalizedOrderId]
  );

  return getOrderById(database, normalizedOrderId);
}

async function syncOrderFinancialStateAfterLedgerChange(database, orderId) {
  await syncLegacyPaymentFieldsForOrder(database, orderId);
  return syncBillCollectionStateForOrder(database, orderId);
}

async function markBillRequestedForTable(database, tableId, preferredPaymentMethod = 'cash') {
  const activeOrder = await getActiveOrderForTable(database, tableId);

  if (!activeOrder) {
    throw createOrderError('NO_OPEN_ORDER', 'No hay un pedido abierto para pedir la cuenta.', 409);
  }

  if (activeOrder.closed_at) {
    throw createOrderError('ORDER_ALREADY_CLOSED', 'La mesa ya fue cerrada para este pedido.', 409);
  }

  if (activeOrder.status !== 'delivered') {
    throw createOrderError('ORDER_NOT_DELIVERED', 'El pedido todavía no fue entregado.', 409);
  }

  if (Number(activeOrder.amount_due || 0) <= MONEY_EPSILON) {
    throw createOrderError('ORDER_ALREADY_PAID', 'El pedido ya quedó completamente saldado.', 409);
  }

  const normalizedPreferredMethod = normalizeBillPaymentMethodPreference(preferredPaymentMethod);
  const shouldAutoAttend = normalizedPreferredMethod === 'mercado_pago';
  const nextStatus = computeBillCollectionStatus({
    ...activeOrder,
    bill_requested_at: activeOrder.bill_requested_at || new Date().toISOString(),
    bill_attended_at: shouldAutoAttend
      ? (activeOrder.bill_attended_at || new Date().toISOString())
      : activeOrder.bill_attended_at,
    bill_payment_method_preference: normalizedPreferredMethod,
  });

  await database.run(
    `
      UPDATE orders
      SET
        bill_requested_at = COALESCE(bill_requested_at, CURRENT_TIMESTAMP),
        bill_attended_at = CASE
          WHEN ? = 1 THEN COALESCE(bill_attended_at, CURRENT_TIMESTAMP)
          ELSE bill_attended_at
        END,
        bill_payment_method_preference = ?,
        bill_collection_status = ?
      WHERE id = ?
        AND closed_at IS NULL
    `,
    [shouldAutoAttend ? 1 : 0, normalizedPreferredMethod, nextStatus, activeOrder.id]
  );

  return getOrderById(database, activeOrder.id);
}

async function clearBillRequestedForTable(database, tableId) {
  const activeOrder = await getActiveOrderForTable(database, tableId);

  if (!activeOrder) {
    return null;
  }

  await database.run(
    `
      UPDATE orders
      SET
        bill_requested_at = NULL,
        bill_attended_at = NULL,
        bill_payment_method_preference = NULL,
        bill_collection_status = NULL
      WHERE id = ?
        AND closed_at IS NULL
        AND bill_attended_at IS NULL
    `,
    [activeOrder.id]
  );

  return getOrderById(database, activeOrder.id);
}

async function markBillAttendedForTable(database, tableId) {
  const activeOrder = await getActiveOrderForTable(database, tableId);

  if (!activeOrder) {
    return null;
  }

  if (activeOrder.status !== 'delivered') {
    throw createOrderError('ORDER_NOT_DELIVERED', 'El pedido todavía no fue entregado.', 409);
  }

  await database.run(
    `
      UPDATE orders
      SET
        bill_requested_at = COALESCE(bill_requested_at, CURRENT_TIMESTAMP),
        bill_attended_at = COALESCE(bill_attended_at, CURRENT_TIMESTAMP),
        bill_collection_status = ?
      WHERE id = ?
        AND closed_at IS NULL
    `,
    [
      computeBillCollectionStatus({
        ...activeOrder,
        bill_requested_at: activeOrder.bill_requested_at || new Date().toISOString(),
        bill_attended_at: activeOrder.bill_attended_at || new Date().toISOString(),
      }),
      activeOrder.id,
    ]
  );

  return getOrderById(database, activeOrder.id);
}

async function syncLegacyPaymentFieldsForOrder(database, orderId) {
  const order = await getOrderById(database, orderId);

  if (!order) {
    return null;
  }

  if (order.payment_status !== 'paid') {
    return order;
  }

  const nonLegacyPayments = (order.payments || []).filter((payment) => !payment.legacy);
  const uniqueMethods = [...new Set(nonLegacyPayments.map((payment) => payment.method).filter(Boolean))];
  const legacyCompatibleMethod = uniqueMethods.length === 1 && LEGACY_ORDER_PAYMENT_METHODS.has(uniqueMethods[0])
    ? uniqueMethods[0]
    : null;

  await database.run(
    `
      UPDATE orders
      SET
        payment_received_at = COALESCE(payment_received_at, ?),
        payment_method = ?
      WHERE id = ?
    `,
    [order.payment_received_at || new Date().toISOString(), legacyCompatibleMethod, orderId]
  );

  return getOrderById(database, orderId);
}

async function createOrderPayment(database, orderId, payload = {}, options = {}) {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  const order = await getOrderById(database, normalizedOrderId);

  if (!order) {
    throw createOrderError('ORDER_NOT_FOUND', 'No encontramos ese pedido.', 404);
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

  const method = normalizePaymentMethod(payload?.method);
  const { amount } = validatePaymentAgainstOrder(order, order.payments, payload?.amount);
  const openRegister = await getOpenRegister(database);

  if (method === 'cash' && !openRegister) {
    throw createOrderError('OPEN_CASH_REGISTER_REQUIRED', 'Necesitás una caja abierta para registrar pagos en efectivo.', 409);
  }

  await createPaymentRecord(database, {
    order_id: normalizedOrderId,
    cash_register_session_id: openRegister?.id || null,
    amount,
    method,
    note: payload?.note,
    created_by: options.created_by || null,
  });

  return syncOrderFinancialStateAfterLedgerChange(database, normalizedOrderId);
}

async function listOrderPayments(database, orderId) {
  const order = await getOrderById(database, orderId);

  if (!order) {
    throw createOrderError('ORDER_NOT_FOUND', 'No encontramos ese pedido.', 404);
  }

  return order.payments || [];
}

async function getOrderPaymentSummary(database, orderId) {
  const order = await getOrderById(database, orderId);

  if (!order) {
    throw createOrderError('ORDER_NOT_FOUND', 'No encontramos ese pedido.', 404);
  }

  return {
    order_id: order.id,
    total_amount: order.total_amount,
    amount_paid: order.amount_paid,
    amount_due: order.amount_due,
    payment_status: order.payment_status,
    bill_payment_method_preference: order.bill_payment_method_preference,
    bill_collection_status: order.bill_collection_status,
    payments_summary: order.payments_summary,
    payments: order.payments,
    external_payment_attempts: order.external_payment_attempts,
    external_payment_attempts_summary: order.external_payment_attempts_summary,
  };
}

async function reverseOrderPayment(database, orderId, paymentId, payload = {}, options = {}) {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  const normalizedPaymentId = ensurePositiveInteger(paymentId, 'payment_id');
  const order = await getOrderById(database, normalizedOrderId);

  if (!order) {
    throw createOrderError('ORDER_NOT_FOUND', 'No encontramos ese pedido.', 404);
  }

  if (order.closed_at) {
    throw createOrderError('ORDER_ALREADY_CLOSED', 'No se pueden revertir pagos de una mesa ya cerrada.', 409);
  }

  const payment = (order.payments || []).find((entry) => entry.id === normalizedPaymentId);

  if (!payment) {
    throw createOrderError('ORDER_PAYMENT_NOT_FOUND', 'No encontramos ese pago dentro del pedido.', 404);
  }

  const { amount } = validatePaymentReversalAgainstPayment(payment, payload?.amount);
  const openRegister = await getOpenRegister(database);

  if (payment.method === 'cash' && !openRegister) {
    throw createOrderError(
      'OPEN_CASH_REGISTER_REQUIRED',
      'Necesitás una caja abierta para revertir pagos en efectivo.',
      409
    );
  }

  await createPaymentReversalRecord(database, {
    order_payment_id: normalizedPaymentId,
    order_id: normalizedOrderId,
    cash_register_session_id: openRegister?.id || null,
    amount,
    reason: payload?.reason,
    created_by: options.created_by || null,
  });

  return syncBillCollectionStateForOrder(database, normalizedOrderId);
}

async function markPaymentReceivedForTable(database, tableId, paymentMethod, options = {}) {
  const activeOrder = await getActiveOrderForTable(database, tableId);

  if (!activeOrder) {
    throw createOrderError('NO_OPEN_ORDER', 'No hay un pedido abierto para registrar el cobro.', 404);
  }

  if (activeOrder.amount_due <= MONEY_EPSILON) {
    throw createOrderError('ORDER_ALREADY_PAID', 'El pedido ya quedó completamente saldado.', 409);
  }

  return createOrderPayment(database, activeOrder.id, {
    amount: activeOrder.amount_due,
    method: paymentMethod,
    note: options.note || '',
  }, options);
}

async function validateOrderClose(order) {
  if (!order) {
    throw createOrderError('ORDER_NOT_FOUND', 'No encontramos ese pedido.', 404);
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

  if (order.amount_due > MONEY_EPSILON) {
    throw createOrderError(
      'ORDER_BALANCE_PENDING',
      `Todavía queda un saldo pendiente de ${order.amount_due.toFixed(2)}.`,
      409,
      { amount_due: order.amount_due }
    );
  }
}

async function closeOrderById(database, orderId) {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  const order = await getOrderById(database, normalizedOrderId);

  await validateOrderClose(order);

  await database.run(
    `
      UPDATE orders
      SET closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP)
      WHERE id = ?
        AND closed_at IS NULL
    `,
    [normalizedOrderId]
  );

  return getOrderById(database, normalizedOrderId);
}

async function closeOpenOrderForTable(database, tableId) {
  const activeOrder = await getActiveOrderForTable(database, tableId);

  if (!activeOrder) {
    throw createOrderError('NO_OPEN_ORDER', 'No hay un pedido abierto para cerrar esta mesa.', 404);
  }

  return closeOrderById(database, activeOrder.id);
}

module.exports = {
  ACTIVE_ORDER_STATUSES,
  VALID_BILL_PAYMENT_METHOD_PREFERENCES,
  VALID_ORDER_STATUSES,
  clearBillRequestedForTable,
  closeOpenOrderForTable,
  closeOrderById,
  createOrder,
  createOrderError,
  createOrderPayment,
  getActiveOrderForTable,
  getClosedOrdersHistorySummary,
  getLatestOrderForTable,
  getOrderById,
  getOrderPaymentSummary,
  getOrderSessionForTable,
  listClosedOrdersHistory,
  listOpenOrders,
  listOrderPayments,
  listOrders,
  markBillAttendedForTable,
  markBillRequestedForTable,
  markPaymentReceivedForTable,
  normalizeBillPaymentMethodPreference,
  reverseOrderPayment,
  syncBillCollectionStateForOrder,
  syncOrderFinancialStateAfterLedgerChange,
  updateOrderStatus
};
