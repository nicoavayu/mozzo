const {
  MONEY_EPSILON,
  createOrderPaymentError,
  listPaymentsForOrder,
  roundMoney,
  summarizeOrderPayments,
} = require('./order-payments');

const VALID_SPLIT_MODES = new Set(['equal', 'manual']);
const VALID_SPLIT_STATUSES = new Set(['open', 'settled']);
const MIN_EQUAL_SPLIT_COUNT = 2;
const MAX_EQUAL_SPLIT_COUNT = 12;

function createBillSplitError(code, message, status = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function ensurePositiveInteger(value, fieldName) {
  const normalizedValue = Number(value);

  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    throw createBillSplitError('INVALID_BILL_SPLIT_PAYLOAD', `${fieldName} must be a positive integer`);
  }

  return normalizedValue;
}

function normalizeEqualSplitCount(value) {
  const normalizedValue = Number(value);

  if (!Number.isInteger(normalizedValue) || normalizedValue < MIN_EQUAL_SPLIT_COUNT || normalizedValue > MAX_EQUAL_SPLIT_COUNT) {
    throw createBillSplitError(
      'INVALID_BILL_SPLIT_COUNT',
      `La división igualitaria debe ser entre ${MIN_EQUAL_SPLIT_COUNT} y ${MAX_EQUAL_SPLIT_COUNT} personas.`,
      400
    );
  }

  return normalizedValue;
}

function normalizeSplitId(value) {
  if (value == null || value === '') {
    return null;
  }

  return ensurePositiveInteger(value, 'split_id');
}

function mapBillSplitRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    order_id: row.order_id,
    label: row.label,
    mode: VALID_SPLIT_MODES.has(row.mode) ? row.mode : 'equal',
    position: row.position,
    status: VALID_SPLIT_STATUSES.has(row.status) ? row.status : 'open',
    created_at: row.created_at,
  };
}

function mapPaymentSplitAllocationRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    payment_id: row.payment_id,
    split_id: row.split_id,
    amount: roundMoney(row.amount),
    created_at: row.created_at,
  };
}

async function getOrderBillSplitContext(database, orderId) {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  const row = await database.get(
    `
      SELECT
        o.id,
        o.table_id,
        o.status,
        o.bill_requested_at,
        o.closed_at,
        ROUND(
          COALESCE(SUM(oi.quantity * oi.unit_price), 0)
          + COALESCE((
            SELECT SUM(oca.amount_delta)
            FROM order_charge_adjustments oca
            WHERE oca.order_id = o.id
          ), 0),
          2
        ) AS total_amount
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.id = ?
      GROUP BY o.id
    `,
    [normalizedOrderId]
  );

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    table_id: row.table_id,
    status: row.status,
    bill_requested_at: row.bill_requested_at,
    closed_at: row.closed_at,
    total_amount: roundMoney(row.total_amount),
  };
}

async function listBillSplitsForOrder(database, orderId) {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  const rows = await database.all(
    `
      SELECT
        id,
        order_id,
        label,
        mode,
        position,
        status,
        created_at
      FROM order_bill_splits
      WHERE order_id = ?
      ORDER BY position ASC, id ASC
    `,
    [normalizedOrderId]
  );

  return rows.map(mapBillSplitRow);
}

async function listBillSplitsForOrderIds(database, orderIds = []) {
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
        label,
        mode,
        position,
        status,
        created_at
      FROM order_bill_splits
      WHERE order_id IN (${placeholders})
      ORDER BY order_id ASC, position ASC, id ASC
    `,
    uniqueOrderIds
  );

  const splitsByOrderId = new Map(uniqueOrderIds.map((orderId) => [orderId, []]));

  for (const row of rows) {
    const split = mapBillSplitRow(row);
    if (!splitsByOrderId.has(split.order_id)) {
      splitsByOrderId.set(split.order_id, []);
    }

    splitsByOrderId.get(split.order_id).push(split);
  }

  return splitsByOrderId;
}

async function listPaymentSplitAllocationsForOrder(database, orderId) {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  const rows = await database.all(
    `
      SELECT
        a.id,
        a.payment_id,
        a.split_id,
        a.amount,
        a.created_at
      FROM order_payment_split_allocations a
      INNER JOIN order_bill_splits s ON s.id = a.split_id
      WHERE s.order_id = ?
      ORDER BY a.payment_id ASC, a.id ASC
    `,
    [normalizedOrderId]
  );

  return rows.map(mapPaymentSplitAllocationRow);
}

async function listPaymentSplitAllocationsForOrderIds(database, orderIds = []) {
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
        s.order_id,
        a.id,
        a.payment_id,
        a.split_id,
        a.amount,
        a.created_at
      FROM order_payment_split_allocations a
      INNER JOIN order_bill_splits s ON s.id = a.split_id
      WHERE s.order_id IN (${placeholders})
      ORDER BY s.order_id ASC, a.payment_id ASC, a.id ASC
    `,
    uniqueOrderIds
  );

  const allocationsByOrderId = new Map(uniqueOrderIds.map((orderId) => [orderId, []]));

  for (const row of rows) {
    const allocation = mapPaymentSplitAllocationRow(row);
    if (!allocationsByOrderId.has(row.order_id)) {
      allocationsByOrderId.set(row.order_id, []);
    }

    allocationsByOrderId.get(row.order_id).push(allocation);
  }

  return allocationsByOrderId;
}

async function hasSplitAllocationsForPayment(database, paymentId) {
  const normalizedPaymentId = ensurePositiveInteger(paymentId, 'payment_id');
  const row = await database.get(
    `
      SELECT id
      FROM order_payment_split_allocations
      WHERE payment_id = ?
      LIMIT 1
    `,
    [normalizedPaymentId]
  );

  return Boolean(row);
}

function validateBillSplitOrderState(order, { allowClosedRead = false } = {}) {
  if (!order) {
    throw createBillSplitError('ORDER_NOT_FOUND', 'No encontramos ese pedido.', 404);
  }

  if (order.closed_at) {
    if (allowClosedRead) {
      return order;
    }

    throw createBillSplitError('ORDER_ALREADY_CLOSED', 'La mesa ya fue cerrada para este pedido.', 409);
  }

  if (order.status !== 'delivered') {
    throw createBillSplitError('ORDER_NOT_DELIVERED', 'El pedido todavía no fue entregado.', 409);
  }

  if (!order.bill_requested_at) {
    throw createBillSplitError('BILL_NOT_REQUESTED', 'La cuenta todavía no fue pedida para este pedido.', 409);
  }

  return order;
}

function getEqualSplitAssignedAmount(totalAmount, splitCount, position) {
  const normalizedSplitCount = Number(splitCount);
  const normalizedPosition = Number(position);

  if (!Number.isInteger(normalizedSplitCount) || normalizedSplitCount <= 0) {
    return 0;
  }

  const totalCents = Math.round(roundMoney(totalAmount) * 100);
  const baseCents = Math.floor(totalCents / normalizedSplitCount);
  const remainder = totalCents % normalizedSplitCount;
  const assignedCents = baseCents + (normalizedPosition <= remainder ? 1 : 0);
  return roundMoney(assignedCents / 100);
}

function summarizeBillSplits(order, splits = [], payments = [], allocations = []) {
  const summary = summarizeOrderPayments(order, payments);
  const normalizedSplits = [...(splits || [])].sort((left, right) => left.position - right.position || left.id - right.id);
  const mode = normalizedSplits[0]?.mode || null;
  const splitCount = normalizedSplits.length;
  const splitById = new Map(normalizedSplits.map((split) => [split.id, split]));
  const allocationByPaymentId = new Map();
  const paidBySplitId = new Map();

  for (const allocation of allocations || []) {
    allocationByPaymentId.set(allocation.payment_id, allocation);
    paidBySplitId.set(
      allocation.split_id,
      roundMoney((paidBySplitId.get(allocation.split_id) || 0) + Number(allocation.amount || 0))
    );
  }

  const groups = normalizedSplits.map((split) => {
    const amountAssigned = mode === 'equal'
      ? getEqualSplitAssignedAmount(order.total_amount, splitCount, split.position)
      : 0;
    const amountPaid = roundMoney(paidBySplitId.get(split.id) || 0);
    const amountDue = roundMoney(Math.max(0, amountAssigned - amountPaid));
    const status = amountDue <= MONEY_EPSILON ? 'settled' : 'open';

    return {
      id: split.id,
      label: split.label,
      mode: split.mode,
      position: split.position,
      status,
      created_at: split.created_at,
      amount_assigned: amountAssigned,
      amount_paid: amountPaid,
      amount_due: amountDue,
    };
  });

  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const paymentsSummary = (payments || []).map((payment) => {
    const allocation = payment?.id ? allocationByPaymentId.get(payment.id) || null : null;
    const allocatedAmount = allocation ? roundMoney(allocation.amount) : 0;
    const targetGroup = allocation ? groupsById.get(allocation.split_id) || null : null;
    const unallocatedAmount = roundMoney(Math.max(0, Number(payment.net_amount || 0) - allocatedAmount));

    return {
      id: payment.id,
      method: payment.method,
      amount: roundMoney(payment.amount),
      net_amount: roundMoney(payment.net_amount || payment.amount || 0),
      allocated_split_id: targetGroup?.id || null,
      allocated_split_label: targetGroup?.label || null,
      unallocated_amount: unallocatedAmount,
      can_allocate: Boolean(
        payment?.id
        && !payment.legacy
        && Number(payment.reversed_amount || 0) <= MONEY_EPSILON
        && Number(payment.net_amount || payment.amount || 0) > MONEY_EPSILON
      ),
    };
  });

  const hasAssignedPayments = allocations.length > 0;
  const canEditOrder = !order.closed_at && order.status === 'delivered' && Boolean(order.bill_requested_at);

  return {
    order_id: order.id,
    mode,
    has_split_bill: normalizedSplits.length > 0,
    can_configure: canEditOrder,
    can_reconfigure: canEditOrder && !hasAssignedPayments,
    can_clear: canEditOrder && !hasAssignedPayments,
    has_assigned_payments: hasAssignedPayments,
    total_amount: roundMoney(order.total_amount || 0),
    amount_paid: roundMoney(summary.amount_paid || 0),
    amount_due: roundMoney(summary.amount_due || 0),
    payment_status: summary.payment_status,
    groups,
    payments: paymentsSummary,
    unallocated_summary: {
      payments_total_unallocated: roundMoney(
        paymentsSummary.reduce((sum, payment) => sum + Number(payment.unallocated_amount || 0), 0)
      ),
    },
  };
}

async function syncBillSplitStatuses(database, order, splits = [], payments = [], allocations = []) {
  if (!Array.isArray(splits) || splits.length === 0) {
    return;
  }

  const summary = summarizeBillSplits(order, splits, payments, allocations);

  for (const group of summary.groups) {
    const sourceSplit = splits.find((split) => split.id === group.id);
    if (sourceSplit && sourceSplit.status !== group.status) {
      await database.run(
        `
          UPDATE order_bill_splits
          SET status = ?
          WHERE id = ?
        `,
        [group.status, group.id]
      );
    }
  }
}

async function getOrderBillSplitState(database, orderId, options = {}) {
  const order = options.order || await getOrderBillSplitContext(database, orderId);

  if (!order) {
    throw createBillSplitError('ORDER_NOT_FOUND', 'No encontramos ese pedido.', 404);
  }

  const payments = Array.isArray(options.payments) ? options.payments : await listPaymentsForOrder(database, order.id);
  const splits = Array.isArray(options.splits) ? options.splits : await listBillSplitsForOrder(database, order.id);
  const allocations = Array.isArray(options.allocations)
    ? options.allocations
    : await listPaymentSplitAllocationsForOrder(database, order.id);

  return summarizeBillSplits(order, splits, payments, allocations);
}

async function replaceEqualBillSplitsForOrder(database, orderId, payload = {}, options = {}) {
  const order = options.order || await getOrderBillSplitContext(database, orderId);
  validateBillSplitOrderState(order);

  const count = normalizeEqualSplitCount(payload?.count);
  const allocations = await listPaymentSplitAllocationsForOrder(database, order.id);

  if (allocations.length > 0) {
    throw createBillSplitError(
      'BILL_SPLIT_RECONFIGURATION_BLOCKED',
      'No podés reconfigurar la división mientras haya pagos asignados.',
      409
    );
  }

  await database.run('DELETE FROM order_bill_splits WHERE order_id = ?', [order.id]);

  for (let index = 1; index <= count; index += 1) {
    await database.run(
      `
        INSERT INTO order_bill_splits (
          order_id,
          label,
          mode,
          position,
          status
        )
        VALUES (?, ?, 'equal', ?, 'open')
      `,
      [order.id, `Persona ${index}`, index]
    );
  }

  const payments = Array.isArray(options.payments) ? options.payments : await listPaymentsForOrder(database, order.id);
  const splits = await listBillSplitsForOrder(database, order.id);
  await syncBillSplitStatuses(database, order, splits, payments, []);

  return getOrderBillSplitState(database, order.id, {
    order,
    payments,
    splits,
    allocations: [],
    allowClosedRead: true,
  });
}

async function clearBillSplitsForOrder(database, orderId, options = {}) {
  const order = options.order || await getOrderBillSplitContext(database, orderId);
  validateBillSplitOrderState(order);

  const allocations = await listPaymentSplitAllocationsForOrder(database, order.id);

  if (allocations.length > 0) {
    throw createBillSplitError(
      'BILL_SPLIT_CLEAR_BLOCKED',
      'No podés limpiar la división mientras haya pagos asignados.',
      409
    );
  }

  await database.run('DELETE FROM order_bill_splits WHERE order_id = ?', [order.id]);

  return getOrderBillSplitState(database, order.id, {
    order,
    payments: Array.isArray(options.payments) ? options.payments : await listPaymentsForOrder(database, order.id),
    splits: [],
    allocations: [],
    allowClosedRead: true,
  });
}

async function assignPaymentToBillSplit(database, orderId, paymentId, payload = {}, options = {}) {
  const normalizedOrderId = ensurePositiveInteger(orderId, 'order_id');
  const normalizedPaymentId = ensurePositiveInteger(paymentId, 'payment_id');
  const targetSplitId = normalizeSplitId(payload?.split_id);
  const order = options.order || await getOrderBillSplitContext(database, normalizedOrderId);
  validateBillSplitOrderState(order);

  const payments = Array.isArray(options.payments) ? options.payments : await listPaymentsForOrder(database, normalizedOrderId);
  const payment = payments.find((entry) => entry.id === normalizedPaymentId);

  if (!payment) {
    throw createBillSplitError('ORDER_PAYMENT_NOT_FOUND', 'No encontramos ese pago dentro del pedido.', 404);
  }

  if (payment.legacy) {
    throw createBillSplitError('PAYMENT_SPLIT_ALLOCATION_NOT_ALLOWED', 'Los pagos legacy no se pueden asignar a grupos.', 409);
  }

  if (Number(payment.reversed_amount || 0) > MONEY_EPSILON) {
    throw createOrderPaymentError(
      'PAYMENT_SPLIT_ALLOCATION_BLOCKED',
      'No podés asignar a grupos un pago que ya tiene reversals.',
      409
    );
  }

  const paymentNetAmount = roundMoney(payment.net_amount || payment.amount || 0);
  const splits = Array.isArray(options.splits) ? options.splits : await listBillSplitsForOrder(database, normalizedOrderId);
  const allocations = Array.isArray(options.allocations)
    ? options.allocations
    : await listPaymentSplitAllocationsForOrder(database, normalizedOrderId);
  const allocationsWithoutCurrentPayment = allocations.filter((allocation) => allocation.payment_id !== normalizedPaymentId);

  if (targetSplitId != null) {
    const targetSplit = splits.find((split) => split.id === targetSplitId);

    if (!targetSplit || targetSplit.order_id !== normalizedOrderId) {
      throw createBillSplitError('ORDER_BILL_SPLIT_NOT_FOUND', 'No encontramos ese grupo dentro de la cuenta.', 404);
    }

    const preview = summarizeBillSplits(order, splits, payments, allocationsWithoutCurrentPayment);
    const targetGroup = preview.groups.find((group) => group.id === targetSplitId);

    if (!targetGroup) {
      throw createBillSplitError('ORDER_BILL_SPLIT_NOT_FOUND', 'No encontramos ese grupo dentro de la cuenta.', 404);
    }

    if (paymentNetAmount - Number(targetGroup.amount_due || 0) > MONEY_EPSILON) {
      throw createBillSplitError(
        'BILL_SPLIT_PAYMENT_OVERFLOW',
        `Ese pago supera el saldo pendiente de ${targetGroup.label}.`,
        409,
        { split_id: targetSplitId, amount_due: targetGroup.amount_due }
      );
    }
  }

  await database.run('DELETE FROM order_payment_split_allocations WHERE payment_id = ?', [normalizedPaymentId]);

  if (targetSplitId != null) {
    await database.run(
      `
        INSERT INTO order_payment_split_allocations (
          payment_id,
          split_id,
          amount
        )
        VALUES (?, ?, ?)
      `,
      [normalizedPaymentId, targetSplitId, paymentNetAmount]
    );
  }

  const nextAllocations = targetSplitId == null
    ? allocationsWithoutCurrentPayment
    : [
        ...allocationsWithoutCurrentPayment,
        {
          id: null,
          payment_id: normalizedPaymentId,
          split_id: targetSplitId,
          amount: paymentNetAmount,
          created_at: null,
        },
      ];

  await syncBillSplitStatuses(database, order, splits, payments, nextAllocations);

  return getOrderBillSplitState(database, normalizedOrderId, {
    order,
    payments,
    splits: await listBillSplitsForOrder(database, normalizedOrderId),
    allocations: await listPaymentSplitAllocationsForOrder(database, normalizedOrderId),
    allowClosedRead: true,
  });
}

async function listBillSplitStatesForOrderIds(database, orders = [], paymentsByOrderId = new Map()) {
  const orderIds = (orders || []).map((order) => order.id).filter(Boolean);
  if (orderIds.length === 0) {
    return new Map();
  }

  const [splitsByOrderId, allocationsByOrderId] = await Promise.all([
    listBillSplitsForOrderIds(database, orderIds),
    listPaymentSplitAllocationsForOrderIds(database, orderIds),
  ]);

  return new Map(
    orders.map((order) => [
      order.id,
      summarizeBillSplits(
        order,
        splitsByOrderId.get(order.id) || [],
        paymentsByOrderId.get(order.id) || [],
        allocationsByOrderId.get(order.id) || []
      ),
    ])
  );
}

module.exports = {
  assignPaymentToBillSplit,
  clearBillSplitsForOrder,
  createBillSplitError,
  getEqualSplitAssignedAmount,
  getOrderBillSplitState,
  hasSplitAllocationsForPayment,
  listBillSplitStatesForOrderIds,
  listBillSplitsForOrder,
  replaceEqualBillSplitsForOrder,
  summarizeBillSplits,
  validateBillSplitOrderState,
};
