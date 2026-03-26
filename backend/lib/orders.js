const ACTIVE_ORDER_STATUSES = ['pending', 'processing', 'ready', 'delivered'];
const VALID_ORDER_STATUSES = new Set(ACTIVE_ORDER_STATUSES);
const MAX_COMMENT_LENGTH = 250;

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
        closed_at: row.closed_at,
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

  return Array.from(orderMap.values());
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

async function closeOpenOrderForTable(database, tableId) {
  const activeOrder = await getActiveOrderForTable(database, tableId);

  if (!activeOrder) {
    throw createOrderError('NO_OPEN_ORDER', 'No hay un pedido abierto para cerrar esta mesa.', 404);
  }

  if (activeOrder.status !== 'delivered') {
    throw createOrderError('ORDER_NOT_DELIVERED', 'El pedido todavía no fue entregado.', 409);
  }

  if (!activeOrder.bill_attended_at) {
    throw createOrderError('BILL_NOT_ATTENDED', 'La cuenta todavía no fue atendida.', 409);
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
  getOrderSessionForTable,
  getOrderById,
  listOrders,
  markBillAttendedForTable,
  markBillRequestedForTable,
  updateOrderStatus
};
