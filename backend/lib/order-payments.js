const VALID_PAYMENT_METHODS = new Set(['cash', 'card', 'transfer', 'other', 'mercado_pago']);
const MAX_PAYMENT_NOTE_LENGTH = 250;
const MAX_PAYMENT_REVERSAL_REASON_LENGTH = 500;
const MONEY_EPSILON = 0.009;

function createOrderPaymentError(code, message, status = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function ensurePositiveInteger(value, fieldName) {
  const normalizedValue = Number(value);

  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    throw createOrderPaymentError('INVALID_PAYMENT_PAYLOAD', `${fieldName} must be a positive integer`);
  }

  return normalizedValue;
}

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function normalizePaymentMethod(value) {
  const normalizedValue = String(value || '').trim().toLowerCase();

  if (!VALID_PAYMENT_METHODS.has(normalizedValue)) {
    throw createOrderPaymentError('INVALID_PAYMENT_METHOD', 'El medio de pago es inválido.', 400);
  }

  return normalizedValue;
}

function normalizePaymentAmount(value) {
  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue) || normalizedValue <= 0) {
    throw createOrderPaymentError('INVALID_PAYMENT_AMOUNT', 'El monto del pago debe ser mayor a 0.', 400);
  }

  const roundedAmount = roundMoney(normalizedValue);

  if (roundedAmount <= MONEY_EPSILON) {
    throw createOrderPaymentError('INVALID_PAYMENT_AMOUNT', 'El monto del pago debe ser mayor a 0.01.', 400);
  }

  return roundedAmount;
}

function normalizePaymentNote(value) {
  if (value == null) {
    return '';
  }

  if (typeof value !== 'string') {
    throw createOrderPaymentError('INVALID_PAYMENT_NOTE', 'La nota del pago debe ser un texto.', 400);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length > MAX_PAYMENT_NOTE_LENGTH) {
    throw createOrderPaymentError(
      'INVALID_PAYMENT_NOTE',
      `La nota del pago debe tener ${MAX_PAYMENT_NOTE_LENGTH} caracteres o menos.`,
      400
    );
  }

  return normalizedValue;
}

function normalizePaymentReversalAmount(value) {
  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue) || normalizedValue <= 0) {
    throw createOrderPaymentError('INVALID_PAYMENT_REVERSAL_AMOUNT', 'El monto de la reversión debe ser mayor a 0.', 400);
  }

  const roundedAmount = roundMoney(normalizedValue);

  if (roundedAmount <= MONEY_EPSILON) {
    throw createOrderPaymentError('INVALID_PAYMENT_REVERSAL_AMOUNT', 'El monto de la reversión debe ser mayor a 0.01.', 400);
  }

  return roundedAmount;
}

function normalizePaymentReversalReason(value) {
  if (typeof value !== 'string') {
    throw createOrderPaymentError('INVALID_PAYMENT_REVERSAL_REASON', 'El motivo de la reversión es obligatorio.', 400);
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    throw createOrderPaymentError('INVALID_PAYMENT_REVERSAL_REASON', 'El motivo de la reversión es obligatorio.', 400);
  }

  if (normalizedValue.length > MAX_PAYMENT_REVERSAL_REASON_LENGTH) {
    throw createOrderPaymentError(
      'INVALID_PAYMENT_REVERSAL_REASON',
      `El motivo de la reversión debe tener ${MAX_PAYMENT_REVERSAL_REASON_LENGTH} caracteres o menos.`,
      400
    );
  }

  return normalizedValue;
}

function mapOrderPaymentRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    order_id: row.order_id,
    cash_register_session_id: row.cash_register_session_id || null,
    amount: roundMoney(row.amount),
    method: row.method,
    note: row.note || '',
    created_at: row.created_at,
    created_by: row.created_by || null,
    legacy: false,
  };
}

function mapOrderPaymentReversalRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    order_payment_id: row.order_payment_id,
    order_id: row.order_id,
    cash_register_session_id: row.cash_register_session_id || null,
    amount: roundMoney(row.amount),
    reason: row.reason || '',
    created_at: row.created_at,
    created_by: row.created_by || null,
  };
}

async function getRawPaymentById(database, paymentId) {
  const normalizedPaymentId = ensurePositiveInteger(paymentId, 'payment_id');
  const row = await database.get(
    `
      SELECT
        id,
        order_id,
        cash_register_session_id,
        amount,
        method,
        note,
        created_at,
        created_by
      FROM order_payments
      WHERE id = ?
    `,
    [normalizedPaymentId]
  );

  return mapOrderPaymentRow(row);
}

async function listRawPaymentsForOrder(database, orderId) {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  const rows = await database.all(
    `
      SELECT
        id,
        order_id,
        cash_register_session_id,
        amount,
        method,
        note,
        created_at,
        created_by
      FROM order_payments
      WHERE order_id = ?
      ORDER BY created_at ASC, id ASC
    `,
    [normalizedOrderId]
  );

  return rows.map(mapOrderPaymentRow);
}

async function listRawPaymentsForOrderIds(database, orderIds = []) {
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
        cash_register_session_id,
        amount,
        method,
        note,
        created_at,
        created_by
      FROM order_payments
      WHERE order_id IN (${placeholders})
      ORDER BY created_at ASC, id ASC
    `,
    uniqueOrderIds
  );

  const paymentsByOrderId = new Map(uniqueOrderIds.map((orderId) => [orderId, []]));

  for (const row of rows) {
    const normalizedPayment = mapOrderPaymentRow(row);
    if (!paymentsByOrderId.has(normalizedPayment.order_id)) {
      paymentsByOrderId.set(normalizedPayment.order_id, []);
    }

    paymentsByOrderId.get(normalizedPayment.order_id).push(normalizedPayment);
  }

  return paymentsByOrderId;
}

async function listReversalsForPaymentIds(database, paymentIds = []) {
  const uniquePaymentIds = [
    ...new Set(
      (paymentIds || [])
        .map((paymentId) => Number(paymentId))
        .filter((paymentId) => Number.isInteger(paymentId) && paymentId > 0)
    ),
  ];

  if (uniquePaymentIds.length === 0) {
    return new Map();
  }

  const placeholders = uniquePaymentIds.map(() => '?').join(', ');
  const rows = await database.all(
    `
      SELECT
        id,
        order_payment_id,
        order_id,
        cash_register_session_id,
        amount,
        reason,
        created_at,
        created_by
      FROM order_payment_reversals
      WHERE order_payment_id IN (${placeholders})
      ORDER BY created_at ASC, id ASC
    `,
    uniquePaymentIds
  );

  const reversalsByPaymentId = new Map(uniquePaymentIds.map((paymentId) => [paymentId, []]));

  for (const row of rows) {
    const reversal = mapOrderPaymentReversalRow(row);
    if (!reversalsByPaymentId.has(reversal.order_payment_id)) {
      reversalsByPaymentId.set(reversal.order_payment_id, []);
    }

    reversalsByPaymentId.get(reversal.order_payment_id).push(reversal);
  }

  return reversalsByPaymentId;
}

function decoratePaymentWithReversals(payment, reversals = []) {
  if (!payment) {
    return null;
  }

  const normalizedReversals = Array.isArray(reversals) ? reversals.map((reversal) => ({
    ...reversal,
    amount: roundMoney(reversal.amount),
  })) : [];
  const rawReversedAmount = roundMoney(
    normalizedReversals.reduce((sum, reversal) => sum + Number(reversal.amount || 0), 0)
  );
  const cappedReversedAmount = payment.legacy
    ? 0
    : roundMoney(Math.min(Number(payment.amount || 0), rawReversedAmount));
  const rawNetAmount = roundMoney(Number(payment.amount || 0) - cappedReversedAmount);
  const netAmount = rawNetAmount <= MONEY_EPSILON ? 0 : rawNetAmount;
  const reversibleAmount = payment.legacy ? 0 : netAmount;

  return {
    ...payment,
    reversals: normalizedReversals,
    reversed_amount: cappedReversedAmount,
    net_amount: netAmount,
    reversible_amount: reversibleAmount,
    fully_reversed: !payment.legacy && reversibleAmount <= MONEY_EPSILON,
  };
}

async function attachReversalsToPayments(database, payments = []) {
  const normalizedPayments = Array.isArray(payments) ? payments : [];
  const reversalsByPaymentId = await listReversalsForPaymentIds(
    database,
    normalizedPayments.map((payment) => payment.id)
  );

  return normalizedPayments.map((payment) => decoratePaymentWithReversals(payment, reversalsByPaymentId.get(payment.id) || []));
}

function buildLegacyPayment(order, amountOverride = null) {
  if (!order?.closed_at || !order?.payment_received_at) {
    return [];
  }

  const legacyAmount = roundMoney(amountOverride == null ? order.total_amount : amountOverride);

  if (legacyAmount <= MONEY_EPSILON) {
    return [];
  }

  return [
    decoratePaymentWithReversals({
      id: null,
      order_id: order.id,
      cash_register_session_id: null,
      amount: legacyAmount,
      method: order.payment_method || 'unknown',
      note: '',
      created_at: order.payment_received_at,
      created_by: null,
      legacy: true,
    }),
  ];
}

function getEffectivePaymentsForOrder(order, payments = []) {
  const normalizedPayments = (Array.isArray(payments) ? payments : [])
    .map((payment) => decoratePaymentWithReversals(payment, payment?.reversals || []))
    .filter(Boolean);

  if (normalizedPayments.length === 0) {
    return buildLegacyPayment(order);
  }

  if (!order?.closed_at || !order?.payment_received_at) {
    return normalizedPayments;
  }

  const totalAmount = roundMoney(order?.total_amount);
  const amountPaidByNewPayments = roundMoney(
    normalizedPayments.reduce((sum, payment) => sum + Number(payment.net_amount || 0), 0)
  );
  const legacyRemainder = roundMoney(totalAmount - amountPaidByNewPayments);

  if (legacyRemainder <= MONEY_EPSILON) {
    return normalizedPayments;
  }

  return [
    ...normalizedPayments,
    ...buildLegacyPayment(order, legacyRemainder),
  ];
}

function getPrimaryPaymentMethod(methods = []) {
  const uniqueMethods = [...new Set(methods.filter(Boolean))];

  if (uniqueMethods.length === 0) {
    return null;
  }

  if (uniqueMethods.length === 1) {
    return uniqueMethods[0];
  }

  return 'split';
}

function summarizeOrderPayments(order, payments = []) {
  const detailedPayments = getEffectivePaymentsForOrder(order, payments);
  const effectivePayments = detailedPayments.filter((payment) => Number(payment.net_amount || 0) > MONEY_EPSILON);
  const totalAmount = roundMoney(order?.total_amount);
  const amountPaid = roundMoney(
    effectivePayments.reduce((sum, payment) => sum + Number(payment.net_amount || 0), 0)
  );
  const totalReversed = roundMoney(
    detailedPayments.reduce((sum, payment) => sum + Number(payment.reversed_amount || 0), 0)
  );
  const rawDue = roundMoney(totalAmount - amountPaid);
  const amountDue = rawDue <= MONEY_EPSILON ? 0 : rawDue;
  const paymentStatus = amountPaid <= MONEY_EPSILON
    ? 'unpaid'
    : amountDue <= MONEY_EPSILON
      ? 'paid'
      : 'partial';
  const primaryMethod = getPrimaryPaymentMethod(effectivePayments.map((payment) => payment.method));
  const paymentReceivedAt = paymentStatus === 'paid'
    ? (effectivePayments[effectivePayments.length - 1]?.created_at || order?.payment_received_at || null)
    : null;
  const latestReversalAt = detailedPayments.flatMap((payment) => payment.reversals || []).slice(-1)[0]?.created_at || null;

  return {
    payments: detailedPayments,
    amount_paid: amountPaid,
    amount_due: amountDue,
    payment_status: paymentStatus,
    payment_received_at: paymentReceivedAt,
    primary_method: primaryMethod,
    payments_summary: {
      payments_count: detailedPayments.length,
      effective_payments_count: effectivePayments.length,
      reversals_count: detailedPayments.reduce((sum, payment) => sum + (payment.reversals?.length || 0), 0),
      total_paid: amountPaid,
      total_reversed: totalReversed,
      amount_due: amountDue,
      payment_status: paymentStatus,
      primary_method: primaryMethod,
      methods: [...new Set(effectivePayments.map((payment) => payment.method).filter(Boolean))],
      latest_payment_at: effectivePayments[effectivePayments.length - 1]?.created_at || null,
      latest_reversal_at: latestReversalAt,
      legacy: detailedPayments.some((payment) => payment.legacy),
    },
  };
}

function validatePaymentAgainstOrder(order, payments = [], rawAmount) {
  const normalizedAmount = normalizePaymentAmount(rawAmount);
  const summary = summarizeOrderPayments(order, payments);

  if (summary.payment_status === 'paid' || summary.amount_due <= MONEY_EPSILON) {
    throw createOrderPaymentError('ORDER_ALREADY_PAID', 'El pedido ya quedó completamente saldado.', 409);
  }

  if (normalizedAmount - summary.amount_due > MONEY_EPSILON) {
    throw createOrderPaymentError(
      'PAYMENT_OVERFLOW',
      `El monto supera el saldo pendiente de ${summary.amount_due.toFixed(2)}.`,
      409,
      {
        amount_due: summary.amount_due,
      }
    );
  }

  return {
    amount: normalizedAmount,
    summary,
  };
}

function validatePaymentReversalAgainstPayment(payment, rawAmount) {
  const normalizedPayment = decoratePaymentWithReversals(payment, payment?.reversals || []);

  if (!normalizedPayment || !normalizedPayment.id) {
    throw createOrderPaymentError('ORDER_PAYMENT_NOT_FOUND', 'No encontramos ese pago.', 404);
  }

  if (normalizedPayment.legacy) {
    throw createOrderPaymentError(
      'PAYMENT_REVERSAL_NOT_ALLOWED',
      'Los pagos legacy no se pueden revertir desde este flujo.',
      409
    );
  }

  if (normalizedPayment.reversible_amount <= MONEY_EPSILON) {
    throw createOrderPaymentError(
      'PAYMENT_ALREADY_FULLY_REVERSED',
      'Ese pago ya fue revertido por completo.',
      409
    );
  }

  const amount = normalizePaymentReversalAmount(rawAmount);

  if (amount - normalizedPayment.reversible_amount > MONEY_EPSILON) {
    throw createOrderPaymentError(
      'PAYMENT_REVERSAL_OVERFLOW',
      `La reversión supera el saldo reversible de ${normalizedPayment.reversible_amount.toFixed(2)}.`,
      409,
      {
        reversible_amount: normalizedPayment.reversible_amount,
      }
    );
  }

  return {
    amount,
    payment: normalizedPayment,
  };
}

async function createPaymentForOrder(database, payload) {
  const orderId = ensurePositiveInteger(payload?.order_id, 'order_id');
  const amount = normalizePaymentAmount(payload?.amount);
  const method = normalizePaymentMethod(payload?.method);
  const note = normalizePaymentNote(payload?.note);
  const cashRegisterSessionId = payload?.cash_register_session_id == null
    ? null
    : ensurePositiveInteger(payload.cash_register_session_id, 'cash_register_session_id');
  const createdBy = payload?.created_by == null ? null : String(payload.created_by).trim() || null;

  const result = await database.run(
    `
      INSERT INTO order_payments (
        order_id,
        cash_register_session_id,
        amount,
        method,
        note,
        created_by
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [orderId, cashRegisterSessionId, amount, method, note, createdBy]
  );

  return getRawPaymentById(database, result.lastID);
}

async function createPaymentReversalForPayment(database, payload) {
  const orderPaymentId = ensurePositiveInteger(payload?.order_payment_id, 'order_payment_id');
  const orderId = ensurePositiveInteger(payload?.order_id, 'order_id');
  const amount = normalizePaymentReversalAmount(payload?.amount);
  const reason = normalizePaymentReversalReason(payload?.reason);
  const cashRegisterSessionId = payload?.cash_register_session_id == null
    ? null
    : ensurePositiveInteger(payload.cash_register_session_id, 'cash_register_session_id');
  const createdBy = payload?.created_by == null ? null : String(payload.created_by).trim() || null;

  const result = await database.run(
    `
      INSERT INTO order_payment_reversals (
        order_payment_id,
        order_id,
        cash_register_session_id,
        amount,
        reason,
        created_by
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [orderPaymentId, orderId, cashRegisterSessionId, amount, reason, createdBy]
  );

  const row = await database.get(
    `
      SELECT
        id,
        order_payment_id,
        order_id,
        cash_register_session_id,
        amount,
        reason,
        created_at,
        created_by
      FROM order_payment_reversals
      WHERE id = ?
    `,
    [result.lastID]
  );

  return mapOrderPaymentReversalRow(row);
}

async function getPaymentById(database, paymentId) {
  const payment = await getRawPaymentById(database, paymentId);

  if (!payment) {
    return null;
  }

  const reversalsByPaymentId = await listReversalsForPaymentIds(database, [payment.id]);
  return decoratePaymentWithReversals(payment, reversalsByPaymentId.get(payment.id) || []);
}

async function listPaymentsForOrder(database, orderId) {
  const payments = await listRawPaymentsForOrder(database, orderId);
  return attachReversalsToPayments(database, payments);
}

async function listPaymentsForOrderIds(database, orderIds = []) {
  const paymentsByOrderId = await listRawPaymentsForOrderIds(database, orderIds);
  const allPayments = Array.from(paymentsByOrderId.values()).flat();
  const reversalsByPaymentId = await listReversalsForPaymentIds(database, allPayments.map((payment) => payment.id));

  return new Map(
    Array.from(paymentsByOrderId.entries()).map(([orderId, payments]) => [
      orderId,
      payments.map((payment) => decoratePaymentWithReversals(payment, reversalsByPaymentId.get(payment.id) || [])),
    ])
  );
}

module.exports = {
  MAX_PAYMENT_NOTE_LENGTH,
  MAX_PAYMENT_REVERSAL_REASON_LENGTH,
  MONEY_EPSILON,
  VALID_PAYMENT_METHODS,
  createOrderPaymentError,
  createPaymentForOrder,
  createPaymentReversalForPayment,
  decoratePaymentWithReversals,
  getEffectivePaymentsForOrder,
  getPaymentById,
  listPaymentsForOrder,
  listPaymentsForOrderIds,
  normalizePaymentAmount,
  normalizePaymentMethod,
  normalizePaymentNote,
  normalizePaymentReversalAmount,
  normalizePaymentReversalReason,
  roundMoney,
  summarizeOrderPayments,
  validatePaymentAgainstOrder,
  validatePaymentReversalAgainstPayment,
};
