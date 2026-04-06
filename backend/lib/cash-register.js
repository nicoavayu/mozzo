const {
  MONEY_EPSILON,
  createOrderPaymentError,
  roundMoney,
} = require('./order-payments');
const {
  createManualCashRegisterMovement,
  listCashRegisterMovementsForSession,
  recordClosingAdjustmentMovement,
  recordOpeningFloatMovement,
  summarizeCashRegisterMovements,
} = require('./cash-register-movements');

function createCashRegisterError(code, message, status = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function isSingleOpenRegisterConstraint(error) {
  return (
    error?.code === 'SQLITE_CONSTRAINT'
    && (
      /idx_cash_register_single_open/i.test(error?.message || '')
      || /cash_register_sessions\.status/i.test(error?.message || '')
      || /UNIQUE constraint failed/i.test(error?.message || '')
    )
  );
}

function ensurePositiveInteger(value, fieldName) {
  const normalizedValue = Number(value);

  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    throw createCashRegisterError('INVALID_CASH_REGISTER', `${fieldName} must be a positive integer`);
  }

  return normalizedValue;
}

function normalizeMoney(value, fieldName, { allowZero = true } = {}) {
  if (typeof value === 'string' && value.trim() === '') {
    throw createCashRegisterError('INVALID_CASH_REGISTER_AMOUNT', `${fieldName} debe ser un monto válido.`, 400);
  }

  const normalizedValue = Number(value ?? 0);

  if (!Number.isFinite(normalizedValue)) {
    throw createCashRegisterError('INVALID_CASH_REGISTER_AMOUNT', `${fieldName} debe ser un monto válido.`, 400);
  }

  if ((!allowZero && normalizedValue <= 0) || (allowZero && normalizedValue < 0)) {
    throw createCashRegisterError(
      'INVALID_CASH_REGISTER_AMOUNT',
      `${fieldName} debe ser ${allowZero ? 'mayor o igual a 0' : 'mayor a 0'}.`,
      400
    );
  }

  return roundMoney(normalizedValue);
}

function normalizeOptionalText(value, fieldName, maxLength = 500) {
  if (value == null) {
    return '';
  }

  if (typeof value !== 'string') {
    throw createCashRegisterError('INVALID_CASH_REGISTER_TEXT', `${fieldName} debe ser un texto.`, 400);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length > maxLength) {
    throw createCashRegisterError(
      'INVALID_CASH_REGISTER_TEXT',
      `${fieldName} debe tener ${maxLength} caracteres o menos.`,
      400
    );
  }

  return normalizedValue;
}

function mapRegisterSessionRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    status: row.status,
    opened_at: row.opened_at,
    closed_at: row.closed_at || null,
    opening_float: roundMoney(row.opening_float),
    expected_cash_amount: row.expected_cash_amount == null ? null : roundMoney(row.expected_cash_amount),
    counted_cash_amount: row.counted_cash_amount == null ? null : roundMoney(row.counted_cash_amount),
    cash_difference: row.cash_difference == null ? null : roundMoney(row.cash_difference),
    notes_open: row.notes_open || '',
    notes_close: row.notes_close || '',
    opened_by: row.opened_by || null,
    closed_by: row.closed_by || null,
    venue_id: row.venue_id || null,
  };
}

async function getRegisterSessionSummary(database, sessionId, options = {}) {
  const normalizedSessionId = ensurePositiveInteger(sessionId, 'cash_register_session_id');
  const movementRows = await listCashRegisterMovementsForSession(database, normalizedSessionId);
  const paymentRows = await database.all(
    `
      SELECT
        id,
        order_id,
        method,
        amount
      FROM order_payments
      WHERE cash_register_session_id = ?
    `,
    [normalizedSessionId]
  );
  const reversalRows = await database.all(
    `
      SELECT
        r.id,
        r.order_payment_id,
        r.order_id,
        r.amount,
        p.method
      FROM order_payment_reversals r
      INNER JOIN order_payments p ON p.id = r.order_payment_id
      WHERE r.cash_register_session_id = ?
    `,
    [normalizedSessionId]
  );

  const cashMovementPaymentIds = new Set(
    movementRows
      .map((movement) => movement.order_payment_id)
      .filter((value) => Number.isInteger(Number(value)) && Number(value) > 0)
      .map(Number)
  );
  const cashMovementReversalIds = new Set(
    movementRows
      .map((movement) => movement.order_payment_reversal_id)
      .filter((value) => Number.isInteger(Number(value)) && Number(value) > 0)
      .map(Number)
  );

  const buckets = new Map();
  const ensureBucket = (method) => {
    const key = method || 'other';
    if (!buckets.has(key)) {
      buckets.set(key, {
        method: key,
        payments_count: 0,
        reversals_count: 0,
        total_amount: 0,
        orders: new Set(),
      });
    }

    return buckets.get(key);
  };

  paymentRows.forEach((row) => {
    const bucket = ensureBucket(row.method);
    bucket.payments_count += 1;
    bucket.total_amount = roundMoney(bucket.total_amount + Number(row.amount || 0));
    bucket.orders.add(row.order_id);
  });

  reversalRows.forEach((row) => {
    const bucket = ensureBucket(row.method);
    bucket.reversals_count += 1;
    bucket.total_amount = roundMoney(bucket.total_amount - Number(row.amount || 0));
    bucket.orders.add(row.order_id);
  });

  const methodOrder = ['cash', 'card', 'transfer', 'other', 'mercado_pago'];
  const methodRank = (method) => {
    const index = methodOrder.indexOf(method);
    return index === -1 ? methodOrder.length : index;
  };
  const breakdown = Array.from(buckets.values())
    .map((entry) => ({
      method: entry.method,
      payments_count: entry.payments_count,
      reversals_count: entry.reversals_count,
      orders_count: entry.orders.size,
      total_amount: roundMoney(entry.total_amount),
    }))
    .sort((left, right) => methodRank(left.method) - methodRank(right.method));

  const totalsByMethod = breakdown.reduce((accumulator, entry) => ({
    ...accumulator,
    [entry.method]: entry.total_amount,
  }), {});

  const totalPaymentsAmount = breakdown.reduce((sum, entry) => sum + entry.total_amount, 0);
  const totalPaymentsCount = breakdown.reduce((sum, entry) => sum + entry.payments_count, 0);
  const totalReversalsCount = breakdown.reduce((sum, entry) => sum + entry.reversals_count, 0);
  const totalOrdersCount = new Set([
    ...paymentRows.map((row) => row.order_id),
    ...reversalRows.map((row) => row.order_id),
  ]);
  const fallbackSaleCashAmount = roundMoney(
    paymentRows
      .filter((row) => row.method === 'cash' && !cashMovementPaymentIds.has(Number(row.id)))
      .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  );
  const fallbackRefundCashAmount = roundMoney(
    reversalRows
      .filter((row) => row.method === 'cash' && !cashMovementReversalIds.has(Number(row.id)))
      .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  );
  const movementSummaryBase = summarizeCashRegisterMovements(movementRows);
  const openingFloatAmount = roundMoney(
    movementSummaryBase.opening_float_amount > MONEY_EPSILON
      ? movementSummaryBase.opening_float_amount
      : Number(options?.opening_float_fallback || 0)
  );
  const cashMovementSummary = {
    ...movementSummaryBase,
    opening_float_amount: openingFloatAmount,
    sale_cash_amount: roundMoney(movementSummaryBase.sale_cash_amount + fallbackSaleCashAmount),
    refund_cash_amount: roundMoney(movementSummaryBase.refund_cash_amount + fallbackRefundCashAmount),
  };
  cashMovementSummary.expected_cash_amount = roundMoney(
    cashMovementSummary.opening_float_amount
    + cashMovementSummary.sale_cash_amount
    - cashMovementSummary.refund_cash_amount
    + cashMovementSummary.cash_in_amount
    - cashMovementSummary.cash_out_amount
  );

  return {
    total_payments_amount: roundMoney(totalPaymentsAmount),
    total_payments_count: totalPaymentsCount,
    total_reversals_count: totalReversalsCount,
    orders_count: totalOrdersCount.size,
    cash_payments_amount: roundMoney(totalsByMethod.cash || 0),
    card_payments_amount: roundMoney(totalsByMethod.card || 0),
    transfer_payments_amount: roundMoney(totalsByMethod.transfer || 0),
    other_payments_amount: roundMoney(totalsByMethod.other || 0),
    mercado_pago_payments_amount: roundMoney(totalsByMethod.mercado_pago || 0),
    payment_breakdown: breakdown,
    movement_summary: cashMovementSummary,
    movements: movementRows,
  };
}

async function getRegisterSessionById(database, sessionId) {
  const normalizedSessionId = ensurePositiveInteger(sessionId, 'cash_register_session_id');
  const row = await database.get(
    `
      SELECT
        id,
        status,
        opened_at,
        closed_at,
        opening_float,
        expected_cash_amount,
        counted_cash_amount,
        cash_difference,
        notes_open,
        notes_close,
        opened_by,
        closed_by,
        venue_id
      FROM cash_register_sessions
      WHERE id = ?
    `,
    [normalizedSessionId]
  );

  if (!row) {
    return null;
  }

  const session = mapRegisterSessionRow(row);
  const summary = await getRegisterSessionSummary(database, normalizedSessionId, {
    opening_float_fallback: session.opening_float,
  });
  const liveExpectedCashAmount = session.closed_at
    ? session.expected_cash_amount
    : roundMoney(summary.movement_summary?.expected_cash_amount ?? session.opening_float);

  return {
    ...session,
    expected_cash_amount: liveExpectedCashAmount,
    summary,
    movements: summary.movements || [],
    movement_summary: summary.movement_summary || null,
  };
}

async function getOpenRegister(database) {
  const row = await database.get(
    `
      SELECT
        id,
        status,
        opened_at,
        closed_at,
        opening_float,
        expected_cash_amount,
        counted_cash_amount,
        cash_difference,
        notes_open,
        notes_close,
        opened_by,
        closed_by,
        venue_id
      FROM cash_register_sessions
      WHERE status = 'open'
      ORDER BY opened_at DESC, id DESC
      LIMIT 1
    `
  );

  if (!row) {
    return null;
  }

  return getRegisterSessionById(database, row.id);
}

async function openRegister(database, payload = {}) {
  const existingOpenRegister = await getOpenRegister(database);

  if (existingOpenRegister) {
    throw createCashRegisterError('CASH_REGISTER_ALREADY_OPEN', 'Ya hay una caja abierta para este local.', 409);
  }

  const openingFloat = normalizeMoney(payload.opening_float, 'opening_float');
  const notesOpen = normalizeOptionalText(payload.notes_open, 'notes_open');
  const openedBy = payload?.opened_by == null ? null : String(payload.opened_by).trim() || null;

  let result;

  try {
    result = await database.run(
      `
        INSERT INTO cash_register_sessions (
          status,
          opening_float,
          notes_open,
          opened_by
        )
        VALUES ('open', ?, ?, ?)
      `,
      [openingFloat, notesOpen, openedBy]
    );
  } catch (error) {
    if (isSingleOpenRegisterConstraint(error)) {
      throw createCashRegisterError('CASH_REGISTER_ALREADY_OPEN', 'Ya hay una caja abierta para este local.', 409);
    }

    throw error;
  }

  if (openingFloat > MONEY_EPSILON) {
    await recordOpeningFloatMovement(database, {
      session_id: result.lastID,
      amount: openingFloat,
      reason: notesOpen || 'Fondo inicial',
      created_by: openedBy,
    });
  }

  return getRegisterSessionById(database, result.lastID);
}

async function closeRegister(database, payload = {}) {
  const currentRegister = await getOpenRegister(database);

  if (!currentRegister) {
    throw createCashRegisterError('NO_OPEN_CASH_REGISTER', 'No hay una caja abierta para cerrar.', 404);
  }

  const countedCashAmount = normalizeMoney(payload.counted_cash_amount, 'counted_cash_amount');
  const notesClose = normalizeOptionalText(payload.notes_close, 'notes_close');
  const closedBy = payload?.closed_by == null ? null : String(payload.closed_by).trim() || null;
  const expectedCashAmount = roundMoney(currentRegister.expected_cash_amount || 0);
  const cashDifference = Math.abs(countedCashAmount - expectedCashAmount) <= MONEY_EPSILON
    ? 0
    : roundMoney(countedCashAmount - expectedCashAmount);

  await database.run(
    `
      UPDATE cash_register_sessions
      SET
        status = 'closed',
        closed_at = CURRENT_TIMESTAMP,
        expected_cash_amount = ?,
        counted_cash_amount = ?,
        cash_difference = ?,
        notes_close = ?,
        closed_by = ?
      WHERE id = ?
        AND status = 'open'
    `,
    [expectedCashAmount, countedCashAmount, cashDifference, notesClose, closedBy, currentRegister.id]
  );

  await recordClosingAdjustmentMovement(database, {
    session_id: currentRegister.id,
    difference: cashDifference,
    reason: notesClose,
    created_by: closedBy,
  });

  return getRegisterSessionById(database, currentRegister.id);
}

async function createCurrentRegisterMovement(database, payload = {}) {
  const currentRegister = await getOpenRegister(database);

  if (!currentRegister) {
    throw createCashRegisterError('NO_OPEN_CASH_REGISTER', 'No hay una caja abierta para registrar movimientos.', 404);
  }

  await createManualCashRegisterMovement(database, {
    session_id: currentRegister.id,
    type: payload?.type,
    amount: payload?.amount,
    reason: payload?.reason,
    created_by: payload?.created_by,
  });

  return getRegisterSessionById(database, currentRegister.id);
}

async function listRegisterSessions(database, { limit = 20 } = {}) {
  const normalizedLimit = Number.isInteger(Number(limit)) && Number(limit) > 0
    ? Math.min(Number(limit), 100)
    : 20;
  const rows = await database.all(
    `
      SELECT
        id,
        status,
        opened_at,
        closed_at,
        opening_float,
        expected_cash_amount,
        counted_cash_amount,
        cash_difference,
        notes_open,
        notes_close,
        opened_by,
        closed_by,
        venue_id
      FROM cash_register_sessions
      ORDER BY opened_at DESC, id DESC
      LIMIT ?
    `,
    [normalizedLimit]
  );

  return Promise.all(rows.map((row) => getRegisterSessionById(database, row.id)));
}

module.exports = {
  closeRegister,
  createCurrentRegisterMovement,
  createCashRegisterError,
  getOpenRegister,
  getRegisterSessionById,
  getRegisterSessionSummary,
  listRegisterSessions,
  openRegister,
};
