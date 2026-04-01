import assert from 'node:assert/strict';
import {
  buildCashRegisterClosePayload,
  buildCashRegisterOpenPayload,
  buildOrderPaymentPayload,
  formatInlineMoney,
  validateCashRegisterCloseForm,
  validateCashRegisterOpenForm,
  validateOrderPaymentDraft,
} from '../src/lib/adminPayments.js';
import {
  buildHistoryQuery,
  formatHistoryPaymentMethod,
  HISTORY_PAYMENT_METHOD_OPTIONS,
} from '../src/lib/orderHistory.js';

assert.ok(HISTORY_PAYMENT_METHOD_OPTIONS.some((option) => option.value === 'split'));
assert.equal(formatHistoryPaymentMethod('split'), 'Pago dividido');
assert.equal(
  buildHistoryQuery({ preset: 'today', payment_method: 'split', limit: 50 }),
  '?preset=today&payment_method=split&limit=50'
);

const sampleOrder = {
  id: 11,
  bill_attended_at: '2026-03-26T20:00:00Z',
  amount_due: 48,
  closed_at: null,
};

assert.equal(
  validateOrderPaymentDraft(sampleOrder, { amount: '', method: 'cash', note: '' }, { cashRegisterCurrent: { id: 1 } }),
  'Indicá un monto para registrar el pago.'
);
assert.equal(
  validateOrderPaymentDraft(sampleOrder, { amount: '0.001', method: 'cash', note: '' }, { cashRegisterCurrent: { id: 1 } }),
  'El monto del pago debe ser mayor a 0.01.'
);
assert.equal(
  validateOrderPaymentDraft(sampleOrder, { amount: '70', method: 'cash', note: '' }, { cashRegisterCurrent: { id: 1 } }),
  `El monto supera el saldo pendiente de ${formatInlineMoney(48)}.`
);
assert.equal(
  validateOrderPaymentDraft(sampleOrder, { amount: '10', method: 'cash', note: '' }, { cashRegisterCurrent: null }),
  'Abrí una caja antes de registrar pagos en efectivo.'
);
assert.equal(
  validateOrderPaymentDraft(sampleOrder, { amount: '10', method: 'card', note: 'ok' }, { cashRegisterCurrent: null }),
  null
);
assert.deepEqual(
  buildOrderPaymentPayload(sampleOrder, { amount: '10.129', method: 'card', note: '  parcial  ' }),
  {
    amount: 10.13,
    method: 'card',
    note: 'parcial',
    remaining_amount_due: 48,
  }
);

assert.equal(validateCashRegisterOpenForm({ opening_float: '', notes_open: '' }), 'Indicá el fondo inicial para abrir la caja.');
assert.equal(validateCashRegisterOpenForm({ opening_float: '-1', notes_open: '' }), 'El fondo inicial no puede ser negativo.');
assert.equal(validateCashRegisterOpenForm({ opening_float: 'abc', notes_open: '' }), 'El fondo inicial debe ser un monto válido.');
assert.equal(validateCashRegisterOpenForm({ opening_float: '100', notes_open: '' }), null);
assert.deepEqual(
  buildCashRegisterOpenPayload({ opening_float: '100.456', notes_open: '  turno mañana  ' }),
  { opening_float: 100.46, notes_open: 'turno mañana' }
);

assert.equal(validateCashRegisterCloseForm({ counted_cash_amount: '', notes_close: '' }), 'Indicá el efectivo contado para cerrar la caja.');
assert.equal(validateCashRegisterCloseForm({ counted_cash_amount: '-5', notes_close: '' }), 'El efectivo contado no puede ser negativo.');
assert.equal(validateCashRegisterCloseForm({ counted_cash_amount: '95.5', notes_close: '' }), null);
assert.deepEqual(
  buildCashRegisterClosePayload({ counted_cash_amount: '95.555', notes_close: '  arqueo ok  ' }),
  { counted_cash_amount: 95.56, notes_close: 'arqueo ok' }
);

console.log('Sprint 7 frontend tests passed');
