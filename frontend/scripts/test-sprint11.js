import assert from 'node:assert/strict';
import {
  BILL_PAYMENT_METHOD_OPTIONS,
  formatBillCollectionStatusLabel,
  formatBillPaymentMethodLabel,
  getBillPaymentOption,
} from '../src/lib/billFlow.js';

assert.equal(BILL_PAYMENT_METHOD_OPTIONS.length, 3);
assert.equal(formatBillPaymentMethodLabel('cash'), 'Efectivo');
assert.equal(formatBillPaymentMethodLabel('card'), 'Tarjeta');
assert.equal(formatBillPaymentMethodLabel('mercado_pago'), 'Mercado Pago');
assert.equal(formatBillCollectionStatusLabel('waiting_cash'), 'Esperando cobro en efectivo');
assert.equal(formatBillCollectionStatusLabel('waiting_card'), 'Esperando cobro con tarjeta');
assert.equal(formatBillCollectionStatusLabel('checkout_pending'), 'Esperando pago online');
assert.equal(formatBillCollectionStatusLabel('partial_payment'), 'Pago parcial registrado');
assert.equal(formatBillCollectionStatusLabel('payment_recorded'), 'Pago completo registrado');
assert.equal(getBillPaymentOption('mercado_pago')?.customer_description.includes('checkout online'), true);

console.log('Sprint 11 frontend tests passed');
