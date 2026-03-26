import assert from 'node:assert/strict';
import {
  buildPublishableCategories,
  createManualMenuDraft,
  normalizeMenuDraft,
  validateManualMenuDraft,
} from '../src/lib/adminMenuDraft.js';

function test(name, run) {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('crea un draft manual vacío con origen manual', () => {
  const draft = createManualMenuDraft();

  assert.equal(draft.draftSource, 'manual');
  assert.equal(draft.name, 'Menú manual');
  assert.deepEqual(draft.categories, []);
  assert.equal(draft.reviewRequired, false);
});

test('normaliza un draft importado preservando origen explícito', () => {
  const draft = normalizeMenuDraft(
    {
      name: 'Carta',
      categories: [{ name: 'Bebidas', items: [{ name: 'Limonada', description: '', price: 5 }] }],
    },
    'external_ai'
  );

  assert.equal(draft.draftSource, 'external_ai');
  assert.equal(draft.categories.length, 1);
  assert.equal(draft.categories[0].items.length, 1);
});

test('la validación manual rechaza borradores sin categorías válidas', () => {
  const error = validateManualMenuDraft(createManualMenuDraft());
  assert.equal(error, 'El borrador manual necesita al menos una categoría con platos válidos.');
});

test('la validación manual exige nombre y precio válidos', () => {
  const missingPrice = validateManualMenuDraft({
    ...createManualMenuDraft(),
    categories: [
      {
        name: 'Principales',
        items: [{ name: 'Milanesa', description: '', price: '' }],
      },
    ],
  });

  const missingName = validateManualMenuDraft({
    ...createManualMenuDraft(),
    categories: [
      {
        name: 'Principales',
        items: [{ name: '', description: 'Con papas', price: 12 }],
      },
    ],
  });

  assert.equal(missingPrice, 'El plato "Milanesa" necesita un precio antes de publicar.');
  assert.equal(missingName, 'Cada plato manual debe tener nombre o eliminarse antes de publicar.');
});

test('el draft manual válido se convierte al payload publicable actual', () => {
  const draft = {
    ...createManualMenuDraft(),
    name: 'Cena',
    categories: [
      {
        name: 'Principales',
        items: [
          { name: 'Milanesa', description: 'Con papas', price: '12.50' },
          { name: '', description: '', price: '' },
        ],
      },
      {
        name: 'Vacía',
        items: [],
      },
    ],
  };

  assert.equal(validateManualMenuDraft(draft), null);
  assert.deepEqual(buildPublishableCategories(draft.categories), [
    {
      name: 'Principales',
      items: [
        { name: 'Milanesa', description: 'Con papas', price: 12.5 },
      ],
    },
  ]);
});

console.log('Frontend sprint 2 tests passed.');
