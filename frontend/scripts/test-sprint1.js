import assert from 'node:assert/strict';
import {
  buildCartFromPersistedDraft,
  isDraftLockedByActiveOrder,
  shouldDiscardPersistedDraft,
} from '../src/lib/tableDraft.js';

function test(name, run) {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('descarta draft persistido si la mesa fue cerrada después del último guardado', () => {
  const shouldDiscard = shouldDiscardPersistedDraft({
    persistedDraft: {
      items: [{ item_id: 1, quantity: 2, comments: '' }],
      updated_at: '2026-03-25T10:00:00.000Z',
    },
    activeOrder: null,
    latestOrder: {
      id: 41,
      closed_at: '2026-03-25T10:05:00.000Z',
    },
  });

  assert.equal(shouldDiscard, true);
});

test('conserva draft persistido si fue guardado después del último cierre', () => {
  const shouldDiscard = shouldDiscardPersistedDraft({
    persistedDraft: {
      items: [{ item_id: 1, quantity: 2, comments: '' }],
      updated_at: '2026-03-25T10:06:00.000Z',
    },
    activeOrder: null,
    latestOrder: {
      id: 41,
      closed_at: '2026-03-25T10:05:00.000Z',
    },
  });

  assert.equal(shouldDiscard, false);
});

test('bloquea el draft cuando existe activeOrder abierto', () => {
  assert.equal(isDraftLockedByActiveOrder(null), false);
  assert.equal(isDraftLockedByActiveOrder({ id: 99, status: 'ready' }), true);
});

test('rehidrata solo items que siguen existiendo en el menú actual', () => {
  const cart = buildCartFromPersistedDraft(
    [
      {
        name: 'Principales',
        items: [
          { id: 7, name: 'Milanesa', price: 12, description: '' },
        ],
      },
    ],
    {
      items: [
        { item_id: 7, quantity: 2, comments: 'sin limón' },
        { item_id: 8, quantity: 1, comments: '' },
      ],
    }
  );

  assert.deepEqual(cart, [
    {
      id: 7,
      name: 'Milanesa',
      price: 12,
      description: '',
      quantity: 2,
      comments: 'sin limón',
    },
  ]);
});

console.log('Frontend sprint 1 tests passed.');
