const { roundMoney } = require('./order-payments');

const VALID_ADJUSTMENT_TYPES = new Set(['suborder_cancellation']);
const MAX_REASON_LENGTH = 250;

function createOrderChargeAdjustmentError(code, message, status = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function ensurePositiveInteger(value, fieldName) {
  const normalizedValue = Number(value);

  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    throw createOrderChargeAdjustmentError('INVALID_ORDER_CHARGE_ADJUSTMENT', `${fieldName} must be a positive integer`);
  }

  return normalizedValue;
}

function normalizeAdjustmentType(value) {
  const normalizedValue = String(value || '').trim().toLowerCase();

  if (!VALID_ADJUSTMENT_TYPES.has(normalizedValue)) {
    throw createOrderChargeAdjustmentError('INVALID_ORDER_CHARGE_ADJUSTMENT', 'type is invalid');
  }

  return normalizedValue;
}

function normalizeAdjustmentReason(value) {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw createOrderChargeAdjustmentError('INVALID_ORDER_CHARGE_ADJUSTMENT', 'reason must be a string');
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return null;
  }

  if (normalizedValue.length > MAX_REASON_LENGTH) {
    throw createOrderChargeAdjustmentError(
      'INVALID_ORDER_CHARGE_ADJUSTMENT',
      `reason must be ${MAX_REASON_LENGTH} characters or fewer`
    );
  }

  return normalizedValue;
}

function normalizeCreatedBy(value) {
  if (value == null) {
    return null;
  }

  return String(value).trim() || null;
}

function normalizeAmountDelta(value) {
  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue)) {
    throw createOrderChargeAdjustmentError('INVALID_ORDER_CHARGE_ADJUSTMENT', 'amount_delta must be a valid number');
  }

  return roundMoney(normalizedValue);
}

function mapOrderChargeAdjustmentRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    order_id: row.order_id,
    suborder_id: row.suborder_id,
    type: row.type,
    amount_delta: roundMoney(row.amount_delta),
    reason: row.reason || null,
    created_by: row.created_by || null,
    created_at: row.created_at,
  };
}

function calculateSuborderTotal(suborder) {
  return roundMoney(
    (suborder?.items || []).reduce(
      (sum, item) => sum + (Number(item?.price || 0) * Number(item?.quantity || 0)),
      0
    )
  );
}

function sumOrderChargeAdjustments(adjustments = []) {
  return roundMoney(
    (adjustments || []).reduce((sum, adjustment) => sum + Number(adjustment?.amount_delta || 0), 0)
  );
}

async function listOrderChargeAdjustmentsForOrder(database, orderId) {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  const rows = await database.all(
    `
      SELECT
        id,
        order_id,
        suborder_id,
        type,
        amount_delta,
        reason,
        created_by,
        created_at
      FROM order_charge_adjustments
      WHERE order_id = ?
      ORDER BY created_at ASC, id ASC
    `,
    [normalizedOrderId]
  );

  return rows.map(mapOrderChargeAdjustmentRow);
}

async function listOrderChargeAdjustmentsForOrderIds(database, orderIds = []) {
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
        suborder_id,
        type,
        amount_delta,
        reason,
        created_by,
        created_at
      FROM order_charge_adjustments
      WHERE order_id IN (${placeholders})
      ORDER BY order_id ASC, created_at ASC, id ASC
    `,
    uniqueOrderIds
  );

  const adjustmentsByOrderId = new Map(uniqueOrderIds.map((orderId) => [orderId, []]));

  for (const row of rows) {
    const adjustment = mapOrderChargeAdjustmentRow(row);
    if (!adjustmentsByOrderId.has(adjustment.order_id)) {
      adjustmentsByOrderId.set(adjustment.order_id, []);
    }

    adjustmentsByOrderId.get(adjustment.order_id).push(adjustment);
  }

  return adjustmentsByOrderId;
}

async function getSuborderCancellationAdjustmentForSuborder(database, suborderId) {
  const normalizedSuborderId = ensurePositiveInteger(suborderId, 'suborder_id');
  const row = await database.get(
    `
      SELECT
        id,
        order_id,
        suborder_id,
        type,
        amount_delta,
        reason,
        created_by,
        created_at
      FROM order_charge_adjustments
      WHERE suborder_id = ?
        AND type = 'suborder_cancellation'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedSuborderId]
  );

  return mapOrderChargeAdjustmentRow(row);
}

async function createSuborderCancellationAdjustment(database, payload = {}) {
  const orderId = ensurePositiveInteger(payload?.order_id, 'order_id');
  const suborderId = ensurePositiveInteger(payload?.suborder_id, 'suborder_id');
  const type = normalizeAdjustmentType(payload?.type || 'suborder_cancellation');
  const amountDelta = normalizeAmountDelta(payload?.amount_delta);
  const reason = normalizeAdjustmentReason(payload?.reason);
  const createdBy = normalizeCreatedBy(payload?.created_by);

  if (amountDelta >= 0) {
    throw createOrderChargeAdjustmentError(
      'INVALID_ORDER_CHARGE_ADJUSTMENT',
      'amount_delta must be negative for suborder cancellations'
    );
  }

  const insertResult = await database.run(
    `
      INSERT INTO order_charge_adjustments (
        order_id,
        suborder_id,
        type,
        amount_delta,
        reason,
        created_by
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [orderId, suborderId, type, amountDelta, reason, createdBy]
  );

  return database.get(
    `
      SELECT
        id,
        order_id,
        suborder_id,
        type,
        amount_delta,
        reason,
        created_by,
        created_at
      FROM order_charge_adjustments
      WHERE id = ?
    `,
    [insertResult.lastID]
  ).then(mapOrderChargeAdjustmentRow);
}

module.exports = {
  calculateSuborderTotal,
  createOrderChargeAdjustmentError,
  createSuborderCancellationAdjustment,
  getSuborderCancellationAdjustmentForSuborder,
  listOrderChargeAdjustmentsForOrder,
  listOrderChargeAdjustmentsForOrderIds,
  mapOrderChargeAdjustmentRow,
  normalizeAdjustmentReason,
  sumOrderChargeAdjustments,
};
