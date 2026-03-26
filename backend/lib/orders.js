const ACTIVE_ORDER_STATUSES = ['pending', 'processing', 'ready', 'delivered'];
const VALID_ORDER_STATUSES = new Set(ACTIVE_ORDER_STATUSES);
const VALID_PAYMENT_METHODS = new Set(['cash', 'card', 'transfer', 'other']);
const VALID_HISTORY_PRESETS = new Set(['today', 'last_7_days']);
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

function normalizePaymentMethod(value) {
  const normalizedValue = String(value || '').trim().toLowerCase();

  if (!VALID_PAYMENT_METHODS.has(normalizedValue)) {
    throw createOrderError('INVALID_PAYMENT_METHOD', 'El medio de pago es inválido.', 400);
  }

  return normalizedValue;
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
    ? normalizePaymentMethod(paymentMethodValue)
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

function buildHistoryWhereClause(filters) {
  const conditions = ['o.closed_at IS NOT NULL', 'o.closed_at >= ?', 'o.closed_at <= ?'];
  const params = [filters.fromSql, filters.toSql];

  if (filters.payment_method) {
    conditions.push('o.payment_method = ?');
    params.push(filters.payment_method);
  }

  return {
    whereClause: `WHERE ${conditions.join(' AND ')}`,
    params,
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
    total_amount: order.items.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 0)), 0),
    durations: buildOrderDurations(order),
  }));
}

async function getOrderRows(database, whereClause = '', params = []) {
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
      ORDER BY o.created_at DESC, o.id DESC, oi.id ASC
    `,
    params
  );
}

async function getOrderById(database, orderId) {
  const rows = await getOrderRows(database, 'WHERE o.id = ?', [orderId]);
  return mapOrderRows(rows)[0] || null;
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
  return mapOrderRows(rows);
}

async function listClosedOrdersHistory(database, rawFilters = {}) {
  const filters = normalizeHistoryFilters(rawFilters);
  const { whereClause, params } = buildHistoryWhereClause(filters);
  const totalRow = await database.get(
    `
      SELECT COUNT(*) AS total_count
      FROM orders o
      ${whereClause}
    `,
    params
  );

  const rows = await database.all(
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
      ORDER BY o.closed_at DESC, o.id DESC, oi.id ASC
      LIMIT ? OFFSET ?
    `,
    [...params, filters.limit, filters.offset]
  );

  return {
    filters: {
      from: filters.from,
      to: filters.to,
      payment_method: filters.payment_method,
      limit: filters.limit,
      offset: filters.offset,
      preset: filters.preset,
    },
    total_count: totalRow?.total_count || 0,
    orders: mapOrderRows(rows),
  };
}

async function getClosedOrdersHistorySummary(database, rawFilters = {}) {
  const filters = normalizeHistoryFilters(rawFilters);
  const { whereClause, params } = buildHistoryWhereClause(filters);
  const rows = await database.all(
    `
      SELECT
        o.id,
        o.created_at,
        o.ready_at,
        o.delivered_at,
        o.bill_attended_at,
        o.payment_received_at,
        o.payment_method,
        o.closed_at,
        COALESCE(SUM(oi.unit_price * oi.quantity), 0) AS total_amount
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      ${whereClause}
      GROUP BY
        o.id,
        o.created_at,
        o.ready_at,
        o.delivered_at,
        o.bill_attended_at,
        o.payment_received_at,
        o.payment_method,
        o.closed_at
      ORDER BY o.closed_at DESC, o.id DESC
    `,
    params
  );

  const summaryRows = rows.map((row) => ({
    total_amount: Number(row.total_amount || 0),
    payment_method: row.payment_method || 'unknown',
    prep_minutes: calculateDurationMinutes(row.created_at, row.ready_at),
    service_minutes: calculateDurationMinutes(row.created_at, row.delivered_at),
    to_payment_minutes: calculateDurationMinutes(row.created_at, row.payment_received_at),
  }));

  const totalRevenue = summaryRows.reduce((sum, row) => sum + row.total_amount, 0);
  const paymentBreakdownMap = new Map();

  for (const row of summaryRows) {
    const bucketKey = row.payment_method;
    const currentBucket = paymentBreakdownMap.get(bucketKey) || {
      payment_method: bucketKey,
      orders_count: 0,
      total_revenue: 0,
    };

    currentBucket.orders_count += 1;
    currentBucket.total_revenue += row.total_amount;
    paymentBreakdownMap.set(bucketKey, currentBucket);
  }

  const paymentMethodOrder = ['cash', 'card', 'transfer', 'other', 'unknown'];
  const payment_breakdown = Array.from(paymentBreakdownMap.values())
    .sort((left, right) => paymentMethodOrder.indexOf(left.payment_method) - paymentMethodOrder.indexOf(right.payment_method));

  return {
    filters: {
      from: filters.from,
      to: filters.to,
      payment_method: filters.payment_method,
      preset: filters.preset,
    },
    summary: {
      orders_count: summaryRows.length,
      total_revenue: Number(totalRevenue.toFixed(2)),
      average_ticket: summaryRows.length > 0 ? Number((totalRevenue / summaryRows.length).toFixed(2)) : 0,
      average_prep_minutes: average(summaryRows.map((row) => row.prep_minutes)),
      average_service_minutes: average(summaryRows.map((row) => row.service_minutes)),
      average_to_payment_minutes: average(summaryRows.map((row) => row.to_payment_minutes)),
    },
    payment_breakdown,
  };
}

async function getActiveOrderForTable(database, tableId) {
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

  if (!activeOrder) {
    return null;
  }

  return getOrderById(database, activeOrder.id);
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

  if (!latestOrder) {
    return null;
  }

  return getOrderById(database, latestOrder.id);
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

async function resolveActiveMenuItems(database, items) {
  const uniqueItemIds = [...new Set(items.map((item) => item.item_id))];
  const placeholders = uniqueItemIds.map(() => '?').join(', ');

  const rows = await database.all(
    `
      SELECT
        mi.id AS item_id,
        mi.name,
        mi.description,
        mi.price,
        mi.is_available
      FROM menu_items mi
      INNER JOIN menu_categories mc ON mc.id = mi.category_id
      INNER JOIN menus m ON m.id = mc.menu_id
      WHERE m.is_active = 1
        AND mi.id IN (${placeholders})
    `,
    uniqueItemIds
  );

  if (rows.length !== uniqueItemIds.length) {
    throw createOrderError(
      'INVALID_ORDER_ITEM',
      'One or more item_id values are invalid for the active menu'
    );
  }

  const unavailableItems = rows.filter((row) => Number(row.is_available) === 0);

  if (unavailableItems.length > 0) {
    throw createOrderError(
      'ITEM_UNAVAILABLE',
      'Uno o más productos ya no están disponibles.',
      409,
      {
        unavailable_items: unavailableItems.map((item) => ({
          item_id: item.item_id,
          name: item.name,
        })),
      }
    );
  }

  return new Map(rows.map((row) => [row.item_id, row]));
}

async function createOrder(database, payload) {
  const normalizedPayload = normalizeOrderPayload(payload);
  try {
    return await database.withTransaction(async () => {
      await ensureSingleOpenOrderForTable(database, normalizedPayload.table_id);
      const activeMenuItems = await resolveActiveMenuItems(database, normalizedPayload.items);

      const orderResult = await database.run(
        `INSERT INTO orders (table_id, status) VALUES (?, 'pending')`,
        [normalizedPayload.table_id]
      );

      for (const item of normalizedPayload.items) {
        const menuItem = activeMenuItems.get(item.item_id);

        await database.run(
          `
            INSERT INTO order_items (
              order_id,
              item_id,
              quantity,
              comments,
              item_name,
              item_description,
              unit_price
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          [
            orderResult.lastID,
            item.item_id,
            item.quantity,
            item.comments,
            menuItem.name,
            menuItem.description || '',
            menuItem.price
          ]
        );
      }

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

  const updateStatements = {
    processing: `
      UPDATE orders
      SET
        status = ?,
        processing_started_at = COALESCE(processing_started_at, CURRENT_TIMESTAMP)
      WHERE id = ?
    `,
    ready: `
      UPDATE orders
      SET
        status = ?,
        processing_started_at = COALESCE(processing_started_at, CURRENT_TIMESTAMP),
        ready_at = COALESCE(ready_at, CURRENT_TIMESTAMP)
      WHERE id = ?
    `,
    delivered: `
      UPDATE orders
      SET
        status = ?,
        processing_started_at = COALESCE(processing_started_at, CURRENT_TIMESTAMP),
        ready_at = COALESCE(ready_at, CURRENT_TIMESTAMP),
        delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP)
      WHERE id = ?
    `
  };

  const updateResult = await database.run(
    updateStatements[status] || 'UPDATE orders SET status = ? WHERE id = ?',
    [status, normalizedOrderId]
  );

  return getOrderById(database, normalizedOrderId);
}

async function markBillRequestedForTable(database, tableId) {
  const activeOrder = await getActiveOrderForTable(database, tableId);

  if (!activeOrder) {
    throw createOrderError('NO_OPEN_ORDER', 'No hay un pedido abierto para pedir la cuenta.', 409);
  }

  await database.run(
    `
      UPDATE orders
      SET bill_requested_at = COALESCE(bill_requested_at, CURRENT_TIMESTAMP)
      WHERE id = ?
        AND closed_at IS NULL
    `,
    [activeOrder.id]
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
      SET bill_requested_at = NULL
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

  if (activeOrder.payment_received_at) {
    throw createOrderError('PAYMENT_ALREADY_RECORDED', 'El pago ya fue registrado para esta mesa.', 409);
  }

  await database.run(
    `
      UPDATE orders
      SET
        bill_requested_at = COALESCE(bill_requested_at, CURRENT_TIMESTAMP),
        bill_attended_at = COALESCE(bill_attended_at, CURRENT_TIMESTAMP)
      WHERE id = ?
        AND closed_at IS NULL
    `,
    [activeOrder.id]
  );

  return getOrderById(database, activeOrder.id);
}

async function markPaymentReceivedForTable(database, tableId, paymentMethod) {
  const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod);
  const activeOrder = await getActiveOrderForTable(database, tableId);

  if (!activeOrder) {
    throw createOrderError('NO_OPEN_ORDER', 'No hay un pedido abierto para registrar el cobro.', 404);
  }

  if (activeOrder.status !== 'delivered') {
    throw createOrderError('ORDER_NOT_DELIVERED', 'El pedido todavía no fue entregado.', 409);
  }

  if (!activeOrder.bill_attended_at) {
    throw createOrderError('BILL_NOT_ATTENDED', 'La cuenta todavía no fue entregada.', 409);
  }

  if (activeOrder.payment_received_at) {
    throw createOrderError('PAYMENT_ALREADY_RECORDED', 'El pago ya fue registrado para esta mesa.', 409);
  }

  await database.run(
    `
      UPDATE orders
      SET
        payment_received_at = COALESCE(payment_received_at, CURRENT_TIMESTAMP),
        payment_method = COALESCE(payment_method, ?),
        closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP)
      WHERE id = ?
        AND closed_at IS NULL
    `,
    [normalizedPaymentMethod, activeOrder.id]
  );

  return getOrderById(database, activeOrder.id);
}

async function closeOpenOrderForTable(database, tableId) {
  const activeOrder = await getActiveOrderForTable(database, tableId);

  if (!activeOrder) {
    throw createOrderError('NO_OPEN_ORDER', 'No hay un pedido abierto para cerrar esta mesa.', 404);
  }

  if (activeOrder.status !== 'delivered') {
    throw createOrderError('ORDER_NOT_DELIVERED', 'El pedido todavía no fue entregado.', 409);
  }

  if (!activeOrder.bill_attended_at) {
    throw createOrderError('BILL_NOT_ATTENDED', 'La cuenta todavía no fue entregada.', 409);
  }

  if (!activeOrder.payment_received_at) {
    throw createOrderError('PAYMENT_NOT_RECEIVED', 'El pago todavía no fue registrado.', 409);
  }

  await database.run(
    `
      UPDATE orders
      SET closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP)
      WHERE id = ?
        AND closed_at IS NULL
    `,
    [activeOrder.id]
  );

  return getOrderById(database, activeOrder.id);
}

module.exports = {
  ACTIVE_ORDER_STATUSES,
  VALID_ORDER_STATUSES,
  clearBillRequestedForTable,
  closeOpenOrderForTable,
  createOrder,
  createOrderError,
  getActiveOrderForTable,
  getLatestOrderForTable,
  getClosedOrdersHistorySummary,
  getOrderSessionForTable,
  getOrderById,
  listClosedOrdersHistory,
  listOrders,
  markBillAttendedForTable,
  markBillRequestedForTable,
  markPaymentReceivedForTable,
  updateOrderStatus
};
