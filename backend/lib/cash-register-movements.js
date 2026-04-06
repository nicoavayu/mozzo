const MONEY_EPSILON = 0.009;

const VALID_CASH_REGISTER_MOVEMENT_TYPES = new Set([
  'opening_float',
  'sale_cash',
  'refund_cash',
  'cash_in',
  'cash_out',
  'closing_adjustment',
]);
const VALID_CASH_REGISTER_MOVEMENT_DIRECTIONS = new Set(['in', 'out']);
const MAX_REASON_LENGTH = 500;

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function createCashRegisterMovementError(code, message, status = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function ensurePositiveInteger(value, fieldName) {
  const normalizedValue = Number(value);

  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    throw createCashRegisterMovementError('INVALID_CASH_REGISTER_MOVEMENT', `${fieldName} must be a positive integer`);
  }

  return normalizedValue;
}

function normalizeMovementType(value) {
  const normalizedValue = String(value || '').trim().toLowerCase();

  if (!VALID_CASH_REGISTER_MOVEMENT_TYPES.has(normalizedValue)) {
    throw createCashRegisterMovementError('INVALID_CASH_REGISTER_MOVEMENT_TYPE', 'El tipo de movimiento es inválido.', 400);
  }

  return normalizedValue;
}

function normalizeMovementDirection(value) {
  const normalizedValue = String(value || '').trim().toLowerCase();

  if (!VALID_CASH_REGISTER_MOVEMENT_DIRECTIONS.has(normalizedValue)) {
    throw createCashRegisterMovementError('INVALID_CASH_REGISTER_MOVEMENT_DIRECTION', 'La dirección del movimiento es inválida.', 400);
  }

  return normalizedValue;
}

function normalizeMovementAmount(value) {
  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue) || normalizedValue <= 0) {
    throw createCashRegisterMovementError('INVALID_CASH_REGISTER_MOVEMENT_AMOUNT', 'El monto del movimiento debe ser mayor a 0.', 400);
  }

  const roundedAmount = roundMoney(normalizedValue);

  if (roundedAmount <= MONEY_EPSILON) {
    throw createCashRegisterMovementError('INVALID_CASH_REGISTER_MOVEMENT_AMOUNT', 'El monto del movimiento debe ser mayor a 0.01.', 400);
  }

  return roundedAmount;
}

function normalizeMovementReason(value, { required = false } = {}) {
  if (value == null) {
    if (required) {
      throw createCashRegisterMovementError('INVALID_CASH_REGISTER_MOVEMENT_REASON', 'El motivo es obligatorio.', 400);
    }

    return '';
  }

  if (typeof value !== 'string') {
    throw createCashRegisterMovementError('INVALID_CASH_REGISTER_MOVEMENT_REASON', 'El motivo debe ser un texto.', 400);
  }

  const normalizedValue = value.trim();

  if (required && !normalizedValue) {
    throw createCashRegisterMovementError('INVALID_CASH_REGISTER_MOVEMENT_REASON', 'El motivo es obligatorio.', 400);
  }

  if (normalizedValue.length > MAX_REASON_LENGTH) {
    throw createCashRegisterMovementError(
      'INVALID_CASH_REGISTER_MOVEMENT_REASON',
      `El motivo debe tener ${MAX_REASON_LENGTH} caracteres o menos.`,
      400
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

function inferMovementDirection(type, direction = null) {
  const normalizedType = normalizeMovementType(type);

  if (normalizedType === 'closing_adjustment') {
    return normalizeMovementDirection(direction);
  }

  return ['opening_float', 'sale_cash', 'cash_in'].includes(normalizedType) ? 'in' : 'out';
}

function mapCashRegisterMovementRow(row) {
  if (!row) {
    return null;
  }

  const type = normalizeMovementType(row.type);
  const direction = normalizeMovementDirection(row.direction);
  const amount = roundMoney(row.amount);
  const signedAmount = direction === 'out' ? roundMoney(-1 * amount) : amount;

  return {
    id: row.id,
    session_id: row.session_id,
    type,
    direction,
    amount,
    signed_amount: signedAmount,
    reason: row.reason || '',
    created_by: row.created_by || null,
    order_payment_id: row.order_payment_id || null,
    order_payment_reversal_id: row.order_payment_reversal_id || null,
    created_at: row.created_at,
  };
}

function summarizeCashRegisterMovements(movements = [], { openingFloatFallback = 0 } = {}) {
  const normalizedMovements = Array.isArray(movements) ? movements.filter(Boolean) : [];
  const totalByType = {
    opening_float: 0,
    sale_cash: 0,
    refund_cash: 0,
    cash_in: 0,
    cash_out: 0,
    closing_adjustment_in: 0,
    closing_adjustment_out: 0,
  };

  for (const movement of normalizedMovements) {
    switch (movement.type) {
      case 'opening_float':
        totalByType.opening_float = roundMoney(totalByType.opening_float + Number(movement.amount || 0));
        break;
      case 'sale_cash':
        totalByType.sale_cash = roundMoney(totalByType.sale_cash + Number(movement.amount || 0));
        break;
      case 'refund_cash':
        totalByType.refund_cash = roundMoney(totalByType.refund_cash + Number(movement.amount || 0));
        break;
      case 'cash_in':
        totalByType.cash_in = roundMoney(totalByType.cash_in + Number(movement.amount || 0));
        break;
      case 'cash_out':
        totalByType.cash_out = roundMoney(totalByType.cash_out + Number(movement.amount || 0));
        break;
      case 'closing_adjustment':
        if (movement.direction === 'out') {
          totalByType.closing_adjustment_out = roundMoney(totalByType.closing_adjustment_out + Number(movement.amount || 0));
        } else {
          totalByType.closing_adjustment_in = roundMoney(totalByType.closing_adjustment_in + Number(movement.amount || 0));
        }
        break;
      default:
        break;
    }
  }

  const openingFloatAmount = totalByType.opening_float > MONEY_EPSILON
    ? totalByType.opening_float
    : roundMoney(openingFloatFallback || 0);
  const expectedCashAmount = roundMoney(
    openingFloatAmount
    + totalByType.sale_cash
    - totalByType.refund_cash
    + totalByType.cash_in
    - totalByType.cash_out
  );

  return {
    movement_count: normalizedMovements.length,
    opening_float_amount: openingFloatAmount,
    sale_cash_amount: totalByType.sale_cash,
    refund_cash_amount: totalByType.refund_cash,
    cash_in_amount: totalByType.cash_in,
    cash_out_amount: totalByType.cash_out,
    closing_adjustment_in_amount: totalByType.closing_adjustment_in,
    closing_adjustment_out_amount: totalByType.closing_adjustment_out,
    expected_cash_amount: expectedCashAmount,
  };
}

async function listCashRegisterMovementsForSession(database, sessionId) {
  const normalizedSessionId = ensurePositiveInteger(sessionId, 'session_id');
  const rows = await database.all(
    `
      SELECT
        id,
        session_id,
        type,
        direction,
        amount,
        reason,
        created_by,
        order_payment_id,
        order_payment_reversal_id,
        created_at
      FROM cash_register_movements
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
    `,
    [normalizedSessionId]
  );

  return rows.map(mapCashRegisterMovementRow);
}

async function listCashRegisterMovementsForSessionIds(database, sessionIds = []) {
  const uniqueSessionIds = [
    ...new Set(
      (sessionIds || [])
        .map((sessionId) => Number(sessionId))
        .filter((sessionId) => Number.isInteger(sessionId) && sessionId > 0)
    ),
  ];

  if (uniqueSessionIds.length === 0) {
    return new Map();
  }

  const placeholders = uniqueSessionIds.map(() => '?').join(', ');
  const rows = await database.all(
    `
      SELECT
        id,
        session_id,
        type,
        direction,
        amount,
        reason,
        created_by,
        order_payment_id,
        order_payment_reversal_id,
        created_at
      FROM cash_register_movements
      WHERE session_id IN (${placeholders})
      ORDER BY session_id ASC, created_at ASC, id ASC
    `,
    uniqueSessionIds
  );

  const movementsBySessionId = new Map(uniqueSessionIds.map((sessionId) => [sessionId, []]));

  for (const row of rows) {
    const movement = mapCashRegisterMovementRow(row);
    if (!movementsBySessionId.has(movement.session_id)) {
      movementsBySessionId.set(movement.session_id, []);
    }

    movementsBySessionId.get(movement.session_id).push(movement);
  }

  return movementsBySessionId;
}

async function getCashRegisterMovementByOrderPaymentId(database, orderPaymentId) {
  const normalizedOrderPaymentId = ensurePositiveInteger(orderPaymentId, 'order_payment_id');
  const row = await database.get(
    `
      SELECT
        id,
        session_id,
        type,
        direction,
        amount,
        reason,
        created_by,
        order_payment_id,
        order_payment_reversal_id,
        created_at
      FROM cash_register_movements
      WHERE order_payment_id = ?
      LIMIT 1
    `,
    [normalizedOrderPaymentId]
  );

  return mapCashRegisterMovementRow(row);
}

async function getCashRegisterMovementByOrderPaymentReversalId(database, orderPaymentReversalId) {
  const normalizedOrderPaymentReversalId = ensurePositiveInteger(orderPaymentReversalId, 'order_payment_reversal_id');
  const row = await database.get(
    `
      SELECT
        id,
        session_id,
        type,
        direction,
        amount,
        reason,
        created_by,
        order_payment_id,
        order_payment_reversal_id,
        created_at
      FROM cash_register_movements
      WHERE order_payment_reversal_id = ?
      LIMIT 1
    `,
    [normalizedOrderPaymentReversalId]
  );

  return mapCashRegisterMovementRow(row);
}

async function createCashRegisterMovement(database, payload = {}) {
  const sessionId = ensurePositiveInteger(payload?.session_id, 'session_id');
  const type = normalizeMovementType(payload?.type);
  const direction = inferMovementDirection(type, payload?.direction);
  const amount = normalizeMovementAmount(payload?.amount);
  const reason = normalizeMovementReason(payload?.reason, {
    required: ['cash_in', 'cash_out'].includes(type),
  });
  const createdBy = normalizeCreatedBy(payload?.created_by);
  const orderPaymentId = payload?.order_payment_id == null ? null : ensurePositiveInteger(payload.order_payment_id, 'order_payment_id');
  const orderPaymentReversalId = payload?.order_payment_reversal_id == null
    ? null
    : ensurePositiveInteger(payload.order_payment_reversal_id, 'order_payment_reversal_id');

  const result = await database.run(
    `
      INSERT INTO cash_register_movements (
        session_id,
        type,
        direction,
        amount,
        reason,
        created_by,
        order_payment_id,
        order_payment_reversal_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [sessionId, type, direction, amount, reason, createdBy, orderPaymentId, orderPaymentReversalId]
  );

  const row = await database.get(
    `
      SELECT
        id,
        session_id,
        type,
        direction,
        amount,
        reason,
        created_by,
        order_payment_id,
        order_payment_reversal_id,
        created_at
      FROM cash_register_movements
      WHERE id = ?
    `,
    [result.lastID]
  );

  return mapCashRegisterMovementRow(row);
}

async function createManualCashRegisterMovement(database, payload = {}) {
  const type = normalizeMovementType(payload?.type);

  if (!['cash_in', 'cash_out'].includes(type)) {
    throw createCashRegisterMovementError(
      'INVALID_CASH_REGISTER_MOVEMENT_TYPE',
      'Solo podés registrar ingresos o retiros manuales desde este flujo.',
      400
    );
  }

  return createCashRegisterMovement(database, payload);
}

async function recordOpeningFloatMovement(database, payload = {}) {
  const amount = normalizeMovementAmount(payload?.amount);
  return createCashRegisterMovement(database, {
    session_id: payload?.session_id,
    type: 'opening_float',
    amount,
    reason: payload?.reason || 'Fondo inicial',
    created_by: payload?.created_by,
  });
}

async function recordCashSaleMovement(database, payload = {}) {
  if (payload?.order_payment_id) {
    const existingMovement = await getCashRegisterMovementByOrderPaymentId(database, payload.order_payment_id);
    if (existingMovement) {
      return existingMovement;
    }
  }

  return createCashRegisterMovement(database, {
    session_id: payload?.session_id,
    type: 'sale_cash',
    amount: payload?.amount,
    reason: payload?.reason || 'Pago en efectivo',
    created_by: payload?.created_by,
    order_payment_id: payload?.order_payment_id,
  });
}

async function recordCashRefundMovement(database, payload = {}) {
  if (payload?.order_payment_reversal_id) {
    const existingMovement = await getCashRegisterMovementByOrderPaymentReversalId(database, payload.order_payment_reversal_id);
    if (existingMovement) {
      return existingMovement;
    }
  }

  return createCashRegisterMovement(database, {
    session_id: payload?.session_id,
    type: 'refund_cash',
    amount: payload?.amount,
    reason: payload?.reason || 'Reversión en efectivo',
    created_by: payload?.created_by,
    order_payment_reversal_id: payload?.order_payment_reversal_id,
  });
}

async function recordClosingAdjustmentMovement(database, payload = {}) {
  const difference = roundMoney(payload?.difference || 0);

  if (Math.abs(difference) <= MONEY_EPSILON) {
    return null;
  }

  return createCashRegisterMovement(database, {
    session_id: payload?.session_id,
    type: 'closing_adjustment',
    direction: difference > 0 ? 'in' : 'out',
    amount: Math.abs(difference),
    reason: payload?.reason || (difference > 0 ? 'Sobrante al cerrar caja' : 'Faltante al cerrar caja'),
    created_by: payload?.created_by,
  });
}

module.exports = {
  MONEY_EPSILON,
  VALID_CASH_REGISTER_MOVEMENT_TYPES,
  createCashRegisterMovement,
  createCashRegisterMovementError,
  createManualCashRegisterMovement,
  getCashRegisterMovementByOrderPaymentId,
  getCashRegisterMovementByOrderPaymentReversalId,
  listCashRegisterMovementsForSession,
  listCashRegisterMovementsForSessionIds,
  mapCashRegisterMovementRow,
  recordCashRefundMovement,
  recordCashSaleMovement,
  recordClosingAdjustmentMovement,
  recordOpeningFloatMovement,
  summarizeCashRegisterMovements,
};
