import assert from 'node:assert/strict';
import {
  buildPublishableCategories,
  normalizeMenuDraft,
  validatePublishableMenuDraft,
} from '../src/lib/adminMenuDraft.js';
import { getVisibleVenueLinks } from '../src/lib/venueSettings.js';

const importedDraftMissingPrice = normalizeMenuDraft({
  name: 'Menú importado',
  categories: [
    {
      name: 'Principales',
      items: [{ name: 'Milanesa', description: 'Con papas', price: '' }],
    },
  ],
}, 'image');

assert.equal(
  validatePublishableMenuDraft(importedDraftMissingPrice),
  'El plato "Milanesa" necesita un precio antes de publicar.'
);

const importedDraftInvalidPrice = normalizeMenuDraft({
  name: 'Menú IA',
  categories: [
    {
      name: 'Principales',
      items: [{ name: 'Ravioles', description: '', price: 'abc' }],
    },
  ],
}, 'external_ai');

assert.equal(
  validatePublishableMenuDraft(importedDraftInvalidPrice),
  'El precio de "Ravioles" no es válido.'
);

assert.deepEqual(
  buildPublishableCategories([
    {
      name: 'Principales',
      items: [
        { name: 'Milanesa', description: 'Con papas', price: '12.50' },
        { name: '', description: '', price: '' },
      ],
    },
  ]),
  [
    {
      name: 'Principales',
      items: [
        { name: 'Milanesa', description: 'Con papas', price: 12.5 },
      ],
    },
  ]
);

const visibleLinks = getVisibleVenueLinks({
  restaurant_name: 'Mozzo Palermo',
  restaurant_subtitle: 'Cocina y barra',
  contact_label: 'WhatsApp',
  contact_url: 'https://wa.me/5491100000000',
  review_url: 'https://maps.google.com/example',
  feedback_url: 'https://forms.gle/example',
});

assert.deepEqual(
  visibleLinks,
  [
    { key: 'contact', label: 'WhatsApp', url: 'https://wa.me/5491100000000' },
    { key: 'review', label: 'Dejar reseña', url: 'https://maps.google.com/example' },
    { key: 'feedback', label: 'Enviar sugerencia', url: 'https://forms.gle/example' },
  ]
);

console.log('Hardening frontend tests passed');
