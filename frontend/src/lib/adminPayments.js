const MONEY_EPSILON = 0.009;
const MAX_PAYMENT_NOTE_LENGTH = 250;
const MAX_PAYMENT_REVERSAL_REASON_LENGTH = 500;
const MAX_CASH_REGISTER_NOTE_LENGTH = 500;

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function parseMoney(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalizedValue = Number(value);
  return Number.isFinite(normalizedValue) ? roundMoney(normalizedValue) : null;
}

export function formatInlineMoney(value) {
  return `$${roundMoney(value).toFixed(2)}`;
}

export function validateOrderPaymentDraft(order, draft, { cashRegisterCurrent } = {}) {
  if (!order) {
    return 'No encontramos ese pedido.';
  }

  if (order.closed_at) {
    return 'La mesa ya fue cerrada para este pedido.';
  }

  if (!order.bill_attended_at) {
    return 'La cuenta todavía no fue entregada.';
  }

  if (Number(order.amount_due || 0) <= MONEY_EPSILON) {
    return 'El pedido ya quedó completamente saldado.';
  }

  const rawAmount = String(draft?.amount ?? '').trim();
  if (!rawAmount) {
    return 'Indicá un monto para registrar el pago.';
  }

  const amount = parseMoney(rawAmount);
  if (amount == null) {
    return 'El monto del pago debe ser un número válido.';
  }

  if (amount <= MONEY_EPSILON) {
    return 'El monto del pago debe ser mayor a 0.01.';
  }

  if (amount - Number(order.amount_due || 0) > MONEY_EPSILON) {
    return `El monto supera el saldo pendiente de ${formatInlineMoney(order.amount_due)}.`;
  }

  const method = String(draft?.method || '').trim().toLowerCase();
  if (!method) {
    return 'Elegí un medio de pago.';
  }

  if (method === 'cash' && !cashRegisterCurrent) {
    return 'Abrí una caja antes de registrar pagos en efectivo.';
  }

  const note = String(draft?.note || '').trim();
  if (note.length > MAX_PAYMENT_NOTE_LENGTH) {
    return `La nota del pago debe tener ${MAX_PAYMENT_NOTE_LENGTH} caracteres o menos.`;
  }

  return null;
}

export function buildOrderPaymentPayload(order, draft) {
  return {
    amount: parseMoney(draft?.amount),
    method: String(draft?.method || '').trim().toLowerCase(),
    note: String(draft?.note || '').trim(),
    remaining_amount_due: roundMoney(order?.amount_due || 0),
  };
}

export function validatePaymentReversalDraft(order, payment, draft, { cashRegisterCurrent } = {}) {
  if (!order || !payment) {
    return 'No encontramos ese pago.';
  }

  if (order.closed_at) {
    return 'La mesa ya fue cerrada para este pedido.';
  }

  if (payment.legacy) {
    return 'Los pagos legacy no se pueden revertir desde este flujo.';
  }

  if (Number(payment.reversible_amount || 0) <= MONEY_EPSILON) {
    return 'Ese pago ya fue revertido por completo.';
  }

  const rawAmount = String(draft?.amount ?? '').trim();
  if (!rawAmount) {
    return 'Indicá un monto para revertir.';
  }

  const amount = parseMoney(rawAmount);
  if (amount == null) {
    return 'El monto de la reversión debe ser un número válido.';
  }

  if (amount <= MONEY_EPSILON) {
    return 'El monto de la reversión debe ser mayor a 0.01.';
  }

  if (amount - Number(payment.reversible_amount || 0) > MONEY_EPSILON) {
    return `La reversión supera el monto reversible de ${formatInlineMoney(payment.reversible_amount)}.`;
  }

  if (payment.method === 'cash' && !cashRegisterCurrent) {
    return 'Abrí una caja antes de revertir pagos en efectivo.';
  }

  const reason = String(draft?.reason || '').trim();
  if (!reason) {
    return 'Indicá el motivo de la reversión.';
  }

  if (reason.length > MAX_PAYMENT_REVERSAL_REASON_LENGTH) {
    return `El motivo de la reversión debe tener ${MAX_PAYMENT_REVERSAL_REASON_LENGTH} caracteres o menos.`;
  }

  return null;
}

export function buildPaymentReversalPayload(payment, draft) {
  return {
    amount: parseMoney(draft?.amount),
    reason: String(draft?.reason || '').trim(),
    remaining_reversible_amount: roundMoney(payment?.reversible_amount || 0),
  };
}

export function validateCashRegisterOpenForm(form) {
  const rawOpeningFloat = String(form?.opening_float ?? '').trim();
  if (!rawOpeningFloat) {
    return 'Indicá el fondo inicial para abrir la caja.';
  }

  const openingFloat = parseMoney(form?.opening_float);
  if (openingFloat == null) {
    return 'El fondo inicial debe ser un monto válido.';
  }

  if (openingFloat < 0) {
    return 'El fondo inicial no puede ser negativo.';
  }

  const notes = String(form?.notes_open || '').trim();
  if (notes.length > MAX_CASH_REGISTER_NOTE_LENGTH) {
    return `La nota de apertura debe tener ${MAX_CASH_REGISTER_NOTE_LENGTH} caracteres o menos.`;
  }

  return null;
}

export function buildCashRegisterOpenPayload(form) {
  return {
    opening_float: parseMoney(form?.opening_float) ?? 0,
    notes_open: String(form?.notes_open || '').trim(),
  };
}

export function validateCashRegisterCloseForm(form) {
  const rawCountedCash = String(form?.counted_cash_amount ?? '').trim();
  if (!rawCountedCash) {
    return 'Indicá el efectivo contado para cerrar la caja.';
  }

  const countedCash = parseMoney(form?.counted_cash_amount);
  if (countedCash == null) {
    return 'Indicá el efectivo contado para cerrar la caja.';
  }

  if (countedCash < 0) {
    return 'El efectivo contado no puede ser negativo.';
  }

  const notes = String(form?.notes_close || '').trim();
  if (notes.length > MAX_CASH_REGISTER_NOTE_LENGTH) {
    return `La nota de cierre debe tener ${MAX_CASH_REGISTER_NOTE_LENGTH} caracteres o menos.`;
  }

  return null;
}

export function buildCashRegisterClosePayload(form) {
  return {
    counted_cash_amount: parseMoney(form?.counted_cash_amount) ?? 0,
    notes_close: String(form?.notes_close || '').trim(),
  };
}
