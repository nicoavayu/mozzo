const VALID_SUBORDER_STATUSES = new Set(['pending', 'processing', 'ready', 'delivered', 'cancelled']);
const ACTIVE_SUBORDER_STATUSES = ['pending', 'processing', 'ready', 'delivered'];
const MAX_COMMENT_LENGTH = 250;

function createSuborderError(code, message, status = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function ensurePositiveInteger(value, fieldName) {
  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw createSuborderError('INVALID_SUBORDER_PAYLOAD', `${fieldName} must be a positive integer`);
  }

  return parsedValue;
}

function normalizeComments(value, fieldName) {
  if (value == null) {
    return '';
  }

  if (typeof value !== 'string') {
    throw createSuborderError('INVALID_SUBORDER_PAYLOAD', `${fieldName} must be a string`);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length > MAX_COMMENT_LENGTH) {
    throw createSuborderError(
      'INVALID_SUBORDER_PAYLOAD',
      `${fieldName} must be ${MAX_COMMENT_LENGTH} characters or fewer`
    );
  }

  return normalizedValue;
}

function normalizeSuborderStatus(value) {
  const normalizedValue = String(value || '').trim().toLowerCase();

  if (!VALID_SUBORDER_STATUSES.has(normalizedValue)) {
    throw createSuborderError('INVALID_SUBORDER_STATUS', 'status is invalid');
  }

  return normalizedValue;
}

function normalizeSuborderItemsPayload(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw createSuborderError('INVALID_SUBORDER_PAYLOAD', 'items must be a non-empty array');
  }

  return items.map((item, index) => ({
    item_id: ensurePositiveInteger(item?.item_id, `items[${index}].item_id`),
    quantity: ensurePositiveInteger(item?.quantity, `items[${index}].quantity`),
    comments: normalizeComments(item?.comments, `items[${index}].comments`),
  }));
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
    throw createSuborderError(
      'INVALID_ORDER_ITEM',
      'One or more item_id values are invalid for the active menu'
    );
  }

  const unavailableItems = rows.filter((row) => Number(row.is_available) === 0);

  if (unavailableItems.length > 0) {
    throw createSuborderError(
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

function mapSuborderRows(rows) {
  const suborderMap = new Map();

  for (const row of rows) {
    if (!suborderMap.has(row.id)) {
      suborderMap.set(row.id, {
        id: row.id,
        order_id: row.order_id,
        table_id: row.table_id,
        sequence_number: row.sequence_number,
        status: row.status,
        created_at: row.created_at,
        processing_started_at: row.processing_started_at || null,
        ready_at: row.ready_at || null,
        delivered_at: row.delivered_at || null,
        cancelled_at: row.cancelled_at || null,
        items: [],
      });
    }

    if (row.item_id == null) {
      continue;
    }

    suborderMap.get(row.id).items.push({
      id: row.suborder_item_id,
      suborder_id: row.id,
      order_id: row.order_id,
      item_id: row.item_id,
      quantity: row.quantity,
      comments: row.comments || '',
      name: row.item_name || 'Item no disponible',
      description: row.item_description || '',
      price: Number(row.unit_price || 0),
    });
  }

  return Array.from(suborderMap.values());
}

function summarizeSuborders(suborders = []) {
  const normalizedSuborders = Array.isArray(suborders) ? suborders : [];
  const activeSuborders = normalizedSuborders.filter((suborder) => suborder.status !== 'cancelled');

  return {
    total_suborders: normalizedSuborders.length,
    active_suborders: activeSuborders.length,
    delivered_suborders: activeSuborders.filter((suborder) => suborder.status === 'delivered').length,
    total_items: activeSuborders.reduce(
      (sum, suborder) => sum + (suborder.items || []).reduce((itemsSum, item) => itemsSum + Number(item.quantity || 0), 0),
      0
    ),
    latest_suborder_created_at: normalizedSuborders.length > 0
      ? normalizedSuborders[normalizedSuborders.length - 1].created_at
      : null,
  };
}

function deriveOrderLifecycleFromSuborders(suborders = []) {
  const activeSuborders = (suborders || []).filter((suborder) => suborder.status !== 'cancelled');

  if (activeSuborders.length === 0) {
    return {
      status: 'delivered',
      processing_started_at: null,
      ready_at: null,
      delivered_at: null,
    };
  }

  const statuses = new Set(activeSuborders.map((suborder) => suborder.status));
  let status = 'delivered';

  if (statuses.has('pending')) {
    status = 'pending';
  } else if (statuses.has('processing')) {
    status = 'processing';
  } else if (statuses.has('ready')) {
    status = 'ready';
  }

  const processingTimestamps = activeSuborders
    .map((suborder) => suborder.processing_started_at)
    .filter(Boolean)
    .sort();

  const readyTimestamps = activeSuborders
    .map((suborder) => suborder.ready_at)
    .filter(Boolean)
    .sort();

  const deliveredTimestamps = activeSuborders
    .map((suborder) => suborder.delivered_at)
    .filter(Boolean)
    .sort();

  return {
    status,
    processing_started_at: processingTimestamps[0] || null,
    ready_at: ['ready', 'delivered'].includes(status) ? (readyTimestamps[readyTimestamps.length - 1] || null) : null,
    delivered_at: status === 'delivered' ? (deliveredTimestamps[deliveredTimestamps.length - 1] || null) : null,
  };
}

async function listSubordersForOrderIds(database, orderIds = []) {
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
        os.id,
        os.order_id,
        os.table_id,
        os.sequence_number,
        os.status,
        os.created_at,
        os.processing_started_at,
        os.ready_at,
        os.delivered_at,
        os.cancelled_at,
        osi.id AS suborder_item_id,
        osi.item_id,
        osi.quantity,
        osi.comments,
        osi.item_name,
        osi.item_description,
        osi.unit_price
      FROM order_suborders os
      LEFT JOIN order_suborder_items osi ON osi.suborder_id = os.id
      WHERE os.order_id IN (${placeholders})
      ORDER BY os.sequence_number ASC, os.created_at ASC, os.id ASC, osi.id ASC
    `,
    uniqueOrderIds
  );

  const mappedSuborders = mapSuborderRows(rows);
  const subordersByOrderId = new Map(uniqueOrderIds.map((orderId) => [orderId, []]));

  for (const suborder of mappedSuborders) {
    if (!subordersByOrderId.has(suborder.order_id)) {
      subordersByOrderId.set(suborder.order_id, []);
    }

    subordersByOrderId.get(suborder.order_id).push(suborder);
  }

  return subordersByOrderId;
}

async function listSubordersForOrder(database, orderId) {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  const subordersByOrderId = await listSubordersForOrderIds(database, [normalizedOrderId]);
  return subordersByOrderId.get(normalizedOrderId) || [];
}

async function getSuborderById(database, suborderId) {
  const normalizedSuborderId = ensurePositiveInteger(suborderId, 'suborder_id');
  const rows = await database.all(
    `
      SELECT
        os.id,
        os.order_id,
        os.table_id,
        os.sequence_number,
        os.status,
        os.created_at,
        os.processing_started_at,
        os.ready_at,
        os.delivered_at,
        os.cancelled_at,
        osi.id AS suborder_item_id,
        osi.item_id,
        osi.quantity,
        osi.comments,
        osi.item_name,
        osi.item_description,
        osi.unit_price
      FROM order_suborders os
      LEFT JOIN order_suborder_items osi ON osi.suborder_id = os.id
      WHERE os.id = ?
      ORDER BY osi.id ASC
    `,
    [normalizedSuborderId]
  );

  return mapSuborderRows(rows)[0] || null;
}

async function insertSuborderSnapshots(database, orderId, tableId, sequenceNumber, items, menuItemsById, status = 'pending') {
  const insertResult = await database.run(
    `
      INSERT INTO order_suborders (order_id, table_id, sequence_number, status)
      VALUES (?, ?, ?, ?)
    `,
    [orderId, tableId, sequenceNumber, status]
  );

  for (const item of items) {
    const menuItem = menuItemsById.get(item.item_id);

    await database.run(
      `
        INSERT INTO order_suborder_items (
          suborder_id,
          order_id,
          item_id,
          quantity,
          comments,
          item_name,
          item_description,
          unit_price
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        insertResult.lastID,
        orderId,
        item.item_id,
        item.quantity,
        item.comments,
        menuItem.name,
        menuItem.description || '',
        menuItem.price,
      ]
    );

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
        orderId,
        item.item_id,
        item.quantity,
        item.comments,
        menuItem.name,
        menuItem.description || '',
        menuItem.price,
      ]
    );
  }

  return getSuborderById(database, insertResult.lastID);
}

async function createInitialSuborderForOrder(database, orderId, tableId, items) {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  const normalizedTableId = ensurePositiveInteger(tableId, 'table_id');
  const normalizedItems = normalizeSuborderItemsPayload(items);
  const menuItemsById = await resolveActiveMenuItems(database, normalizedItems);

  return insertSuborderSnapshots(
    database,
    normalizedOrderId,
    normalizedTableId,
    1,
    normalizedItems,
    menuItemsById,
    'pending'
  );
}

async function syncOrderStatusFromSuborders(database, orderId) {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  const suborders = await listSubordersForOrder(database, normalizedOrderId);
  const aggregate = deriveOrderLifecycleFromSuborders(suborders);

  await database.run(
    `
      UPDATE orders
      SET
        status = ?,
        processing_started_at = ?,
        ready_at = ?,
        delivered_at = ?
      WHERE id = ?
    `,
    [
      aggregate.status,
      aggregate.processing_started_at,
      aggregate.ready_at,
      aggregate.delivered_at,
      normalizedOrderId,
    ]
  );

  return aggregate;
}

async function appendSuborderToActiveOrder(database, tableId, payload = {}) {
  const normalizedTableId = ensurePositiveInteger(tableId, 'table_id');
  const normalizedItems = normalizeSuborderItemsPayload(payload?.items);
  const activeOrder = await database.get(
    `
      SELECT id, table_id, closed_at, bill_requested_at
      FROM orders
      WHERE table_id = ?
        AND closed_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedTableId]
  );

  if (!activeOrder) {
    throw createSuborderError('NO_OPEN_ORDER', 'No hay una cuenta abierta para agregar un pedido adicional.', 409);
  }

  if (activeOrder.closed_at) {
    throw createSuborderError('ORDER_ALREADY_CLOSED', 'La mesa ya fue cerrada para esta cuenta.', 409);
  }

  if (activeOrder.bill_requested_at) {
    throw createSuborderError(
      'BILL_FLOW_ALREADY_STARTED',
      'La mesa ya pidió la cuenta. No se pueden agregar subpedidos nuevos.',
      409
    );
  }

  const sequenceRow = await database.get(
    `
      SELECT COALESCE(MAX(sequence_number), 0) AS max_sequence
      FROM order_suborders
      WHERE order_id = ?
    `,
    [activeOrder.id]
  );

  const menuItemsById = await resolveActiveMenuItems(database, normalizedItems);
  const suborder = await insertSuborderSnapshots(
    database,
    activeOrder.id,
    normalizedTableId,
    Number(sequenceRow?.max_sequence || 0) + 1,
    normalizedItems,
    menuItemsById,
    'pending'
  );

  await syncOrderStatusFromSuborders(database, activeOrder.id);
  return suborder;
}

async function updateSuborderStatus(database, suborderId, nextStatus) {
  const normalizedSuborderId = ensurePositiveInteger(suborderId, 'suborder_id');
  const normalizedStatus = normalizeSuborderStatus(nextStatus);
  const currentSuborder = await database.get(
    `
      SELECT
        os.id,
        os.order_id,
        os.table_id,
        os.status,
        os.cancelled_at,
        o.closed_at
      FROM order_suborders os
      INNER JOIN orders o ON o.id = os.order_id
      WHERE os.id = ?
    `,
    [normalizedSuborderId]
  );

  if (!currentSuborder) {
    throw createSuborderError('SUBORDER_NOT_FOUND', 'No encontramos ese subpedido.', 404);
  }

  if (currentSuborder.closed_at) {
    throw createSuborderError('ORDER_ALREADY_CLOSED', 'La cuenta ya fue cerrada para esta mesa.', 409);
  }

  const updateStatements = {
    processing: `
      UPDATE order_suborders
      SET
        status = ?,
        processing_started_at = COALESCE(processing_started_at, CURRENT_TIMESTAMP),
        cancelled_at = NULL
      WHERE id = ?
    `,
    ready: `
      UPDATE order_suborders
      SET
        status = ?,
        processing_started_at = COALESCE(processing_started_at, CURRENT_TIMESTAMP),
        ready_at = COALESCE(ready_at, CURRENT_TIMESTAMP),
        cancelled_at = NULL
      WHERE id = ?
    `,
    delivered: `
      UPDATE order_suborders
      SET
        status = ?,
        processing_started_at = COALESCE(processing_started_at, CURRENT_TIMESTAMP),
        ready_at = COALESCE(ready_at, CURRENT_TIMESTAMP),
        delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP),
        cancelled_at = NULL
      WHERE id = ?
    `,
    cancelled: `
      UPDATE order_suborders
      SET
        status = ?,
        cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP)
      WHERE id = ?
    `,
  };

  await database.run(
    updateStatements[normalizedStatus] || 'UPDATE order_suborders SET status = ?, cancelled_at = NULL WHERE id = ?',
    [normalizedStatus, normalizedSuborderId]
  );

  await syncOrderStatusFromSuborders(database, currentSuborder.order_id);
  return getSuborderById(database, normalizedSuborderId);
}

async function listOpenSuborders(database) {
  const rows = await database.all(
    `
      SELECT
        os.id,
        os.order_id,
        os.table_id,
        os.sequence_number,
        os.status,
        os.created_at,
        os.processing_started_at,
        os.ready_at,
        os.delivered_at,
        os.cancelled_at,
        o.bill_requested_at,
        osi.id AS suborder_item_id,
        osi.item_id,
        osi.quantity,
        osi.comments,
        osi.item_name,
        osi.item_description,
        osi.unit_price
      FROM order_suborders os
      INNER JOIN orders o ON o.id = os.order_id
      LEFT JOIN order_suborder_items osi ON osi.suborder_id = os.id
      WHERE o.closed_at IS NULL
        AND os.status IN (${ACTIVE_SUBORDER_STATUSES.map(() => '?').join(', ')})
      ORDER BY os.created_at ASC, os.id ASC, osi.id ASC
    `,
    ACTIVE_SUBORDER_STATUSES
  );

  return mapSuborderRows(rows).map((suborder) => ({
    ...suborder,
    bill_requested_at: rows.find((row) => row.id === suborder.id)?.bill_requested_at || null,
  }));
}

module.exports = {
  ACTIVE_SUBORDER_STATUSES,
  VALID_SUBORDER_STATUSES,
  appendSuborderToActiveOrder,
  createInitialSuborderForOrder,
  createSuborderError,
  deriveOrderLifecycleFromSuborders,
  getSuborderById,
  listOpenSuborders,
  listSubordersForOrder,
  listSubordersForOrderIds,
  normalizeSuborderItemsPayload,
  summarizeSuborders,
  syncOrderStatusFromSuborders,
  updateSuborderStatus,
};
