import assert from 'node:assert/strict';
import {
  buildCartFromPersistedDraft,
  reconcileCartWithMenu,
  reconcilePersistedDraft,
  removeUnavailableItemsFromCart,
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

const menuCategories = [
  {
    name: 'Bebidas',
    items: [
      { id: 1, name: 'Agua', description: '', price: 3, is_available: 1 },
      { id: 2, name: 'Limonada', description: '', price: 5, is_available: 0 },
    ],
  },
];

test('rehidrata solo items disponibles del draft persistido', () => {
  const cart = buildCartFromPersistedDraft(menuCategories, {
    items: [
      { item_id: 1, quantity: 2, comments: '' },
      { item_id: 2, quantity: 1, comments: 'sin hielo' },
    ],
  });

  assert.deepEqual(cart, [
    {
      id: 1,
      name: 'Agua',
      description: '',
      price: 3,
      is_available: 1,
      quantity: 2,
      comments: '',
    },
  ]);
});

test('informa qué items quedaron no disponibles al reconciliar draft persistido', () => {
  const result = reconcilePersistedDraft(menuCategories, {
    items: [
      { item_id: 1, quantity: 1, comments: '' },
      { item_id: 2, quantity: 1, comments: '' },
    ],
  });

  assert.equal(result.cart.length, 1);
  assert.deepEqual(result.unavailableItems, ['Limonada']);
});

test('saca items apagados del carrito en memoria cuando cambia el menú', () => {
  const result = reconcileCartWithMenu(menuCategories, [
    { id: 1, name: 'Agua', description: '', price: 3, quantity: 1, comments: '' },
    { id: 2, name: 'Limonada', description: '', price: 5, quantity: 1, comments: '' },
  ]);

  assert.equal(result.cart.length, 1);
  assert.deepEqual(result.unavailableItems, ['Limonada']);
});

test('filtra items rechazados por backend al confirmar pedido', () => {
  const result = removeUnavailableItemsFromCart(
    [
      { id: 1, name: 'Agua', quantity: 1, comments: '' },
      { id: 2, name: 'Limonada', quantity: 1, comments: '' },
    ],
    [{ item_id: 2, name: 'Limonada' }]
  );

  assert.deepEqual(result.cart, [
    { id: 1, name: 'Agua', quantity: 1, comments: '' },
  ]);
  assert.deepEqual(result.unavailableItems, ['Limonada']);
});

console.log('Frontend sprint 3 tests passed.');
