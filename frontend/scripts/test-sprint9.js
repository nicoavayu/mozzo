import assert from 'node:assert/strict';
import {
  buildPaymentReversalPayload,
  formatInlineMoney,
  validatePaymentReversalDraft,
} from '../src/lib/adminPayments.js';

const openOrder = {
  id: 15,
  closed_at: null,
};

const payment = {
  id: 21,
  legacy: false,
  method: 'cash',
  reversible_amount: 18,
};

assert.equal(
  validatePaymentReversalDraft(openOrder, payment, { amount: '', reason: 'ok' }, { cashRegisterCurrent: { id: 1 } }),
  'Indicá un monto para revertir.'
);

assert.equal(
  validatePaymentReversalDraft(openOrder, payment, { amount: 'abc', reason: 'ok' }, { cashRegisterCurrent: { id: 1 } }),
  'El monto de la reversión debe ser un número válido.'
);

assert.equal(
  validatePaymentReversalDraft(openOrder, payment, { amount: '0.001', reason: 'ok' }, { cashRegisterCurrent: { id: 1 } }),
  'El monto de la reversión debe ser mayor a 0.01.'
);

assert.equal(
  validatePaymentReversalDraft(openOrder, payment, { amount: '25', reason: 'ok' }, { cashRegisterCurrent: { id: 1 } }),
  `La reversión supera el monto reversible de ${formatInlineMoney(18)}.`
);

assert.equal(
  validatePaymentReversalDraft(openOrder, payment, { amount: '5', reason: '' }, { cashRegisterCurrent: { id: 1 } }),
  'Indicá el motivo de la reversión.'
);

assert.equal(
  validatePaymentReversalDraft(openOrder, payment, { amount: '5', reason: 'ok' }, { cashRegisterCurrent: null }),
  'Abrí una caja antes de revertir pagos en efectivo.'
);

assert.equal(
  validatePaymentReversalDraft(
    openOrder,
    { ...payment, method: 'mercado_pago' },
    { amount: '5', reason: 'reversión manual' },
    { cashRegisterCurrent: null }
  ),
  null
);

assert.equal(
  validatePaymentReversalDraft(
    openOrder,
    { ...payment, legacy: true },
    { amount: '5', reason: 'legacy' },
    { cashRegisterCurrent: { id: 1 } }
  ),
  'Los pagos legacy no se pueden revertir desde este flujo.'
);

assert.equal(
  validatePaymentReversalDraft(
    openOrder,
    { ...payment, reversible_amount: 0 },
    { amount: '5', reason: 'agotado' },
    { cashRegisterCurrent: { id: 1 } }
  ),
  'Ese pago ya fue revertido por completo.'
);

assert.deepEqual(
  buildPaymentReversalPayload(payment, { amount: '10.129', reason: '  ajuste interno  ' }),
  {
    amount: 10.13,
    reason: 'ajuste interno',
    remaining_reversible_amount: 18,
  }
);

console.log('Sprint 9 frontend tests passed');
