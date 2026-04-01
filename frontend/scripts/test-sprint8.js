import assert from 'node:assert/strict';
import { getMercadoPagoReturnFeedback, normalizeMercadoPagoReturnStatus } from '../src/lib/mercadoPago.js';
import { buildHistoryQuery, formatHistoryPaymentMethod, HISTORY_PAYMENT_METHOD_OPTIONS } from '../src/lib/orderHistory.js';

assert.equal(normalizeMercadoPagoReturnStatus('approved'), 'approved');
assert.equal(normalizeMercadoPagoReturnStatus('pending'), 'pending');
assert.equal(normalizeMercadoPagoReturnStatus('failure'), 'failure');
assert.equal(normalizeMercadoPagoReturnStatus('unknown'), '');

assert.deepEqual(getMercadoPagoReturnFeedback('approved'), {
  type: 'success',
  title: 'Pago aprobado',
  message: 'Mercado Pago aprobó el pago. Estamos actualizando el saldo de la mesa.',
});
assert.deepEqual(getMercadoPagoReturnFeedback('pending'), {
  type: 'info',
  title: 'Pago pendiente',
  message: 'Mercado Pago dejó el pago pendiente. Cuando cambie el estado, la mesa se va a actualizar sola.',
});
assert.deepEqual(getMercadoPagoReturnFeedback('failure'), {
  type: 'error',
  title: 'Pago no completado',
  message: 'Mercado Pago no pudo completar el pago. Podés intentarlo de nuevo o usar otro medio.',
});
assert.equal(getMercadoPagoReturnFeedback('unknown'), null);

assert.ok(HISTORY_PAYMENT_METHOD_OPTIONS.some((option) => option.value === 'mercado_pago'));
assert.equal(formatHistoryPaymentMethod('mercado_pago'), 'Mercado Pago');
assert.equal(
  buildHistoryQuery({ preset: 'today', payment_method: 'mercado_pago', limit: 50 }),
  '?preset=today&payment_method=mercado_pago&limit=50'
);

console.log('Sprint 8 frontend tests passed');
