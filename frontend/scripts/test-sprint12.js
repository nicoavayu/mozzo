import assert from 'node:assert/strict';
import { summarizeActiveOrderSession } from '../src/lib/suborders.js';
import { isDraftLockedByActiveOrder } from '../src/lib/tableDraft.js';

const summary = summarizeActiveOrderSession({
  suborders: [
    {
      id: 1,
      sequence_number: 1,
      status: 'delivered',
      items: [
        { quantity: 2 },
        { quantity: 1 },
      ],
    },
    {
      id: 2,
      sequence_number: 2,
      status: 'processing',
      items: [
        { quantity: 3 },
      ],
    },
  ],
});

assert.equal(summary.subordersCount, 2);
assert.equal(summary.itemsCount, 6);

assert.equal(isDraftLockedByActiveOrder(null), false);
assert.equal(isDraftLockedByActiveOrder({ id: 1, bill_requested_at: null }), false);
assert.equal(isDraftLockedByActiveOrder({ id: 1, bill_requested_at: '2026-03-29T20:00:00Z' }), true);

console.log('Sprint 12 frontend tests passed');
