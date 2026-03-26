import assert from 'node:assert/strict';
import {
  buildHistoryQuery,
  DEFAULT_HISTORY_FILTERS,
  formatHistoryMinutes,
  formatHistoryPaymentMethod,
  normalizeHistoryFilters,
} from '../src/lib/orderHistory.js';

const defaults = normalizeHistoryFilters({});
assert.deepEqual(defaults, DEFAULT_HISTORY_FILTERS);

const custom = normalizeHistoryFilters({
  preset: 'last_7_days',
  from: '2026-03-20',
  to: '2026-03-26',
  payment_method: 'card',
  limit: 25,
  offset: 10,
});
assert.equal(custom.preset, 'last_7_days');
assert.equal(custom.from, '2026-03-20');
assert.equal(custom.to, '2026-03-26');
assert.equal(custom.payment_method, 'card');
assert.equal(custom.limit, 25);
assert.equal(custom.offset, 10);

assert.equal(
  buildHistoryQuery({ preset: 'today', payment_method: 'cash', limit: 20 }),
  '?preset=today&payment_method=cash&limit=20'
);

assert.equal(
  buildHistoryQuery({ from: '2026-03-20', to: '2026-03-21', payment_method: '', limit: 50 }),
  '?from=2026-03-20&to=2026-03-21&limit=50'
);

assert.equal(formatHistoryPaymentMethod('card'), 'Tarjeta');
assert.equal(formatHistoryPaymentMethod('unknown'), 'Sin registrar');
assert.equal(formatHistoryMinutes(17.2), '17 min');
assert.equal(formatHistoryMinutes(null), '—');

console.log('Sprint 6 frontend tests passed');
