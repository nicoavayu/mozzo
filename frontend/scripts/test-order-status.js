import assert from 'node:assert/strict';
import { getCustomerActiveOrderStatus } from '../src/lib/orderStatus.js';

assert.equal(getCustomerActiveOrderStatus('pending').badge, 'Recibido');
assert.equal(getCustomerActiveOrderStatus('processing').badge, 'En preparación');
assert.equal(getCustomerActiveOrderStatus('ready').badge, 'Listo');
assert.equal(getCustomerActiveOrderStatus('delivered').badge, 'En camino');
assert.equal(getCustomerActiveOrderStatus('ready').label, 'Tu pedido está listo');
assert.equal(getCustomerActiveOrderStatus('unknown').badge, 'En curso');

console.log('Customer order status tests passed');
