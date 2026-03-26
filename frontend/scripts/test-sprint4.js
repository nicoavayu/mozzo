import assert from 'node:assert/strict';
import {
  DEFAULT_VENUE_SETTINGS,
  getVisibleVenueLinks,
  normalizeVenueSettings,
  validateVenueSettingsForm,
} from '../src/lib/venueSettings.js';

const normalized = normalizeVenueSettings({});
assert.equal(normalized.restaurant_name, DEFAULT_VENUE_SETTINGS.restaurant_name);
assert.equal(normalized.restaurant_subtitle, '');

const missingNameErrors = validateVenueSettingsForm({
  restaurant_name: '',
  restaurant_subtitle: '',
  contact_label: '',
  contact_url: '',
  review_url: '',
  feedback_url: '',
});
assert.ok(missingNameErrors.restaurant_name);

const incompleteContactErrors = validateVenueSettingsForm({
  restaurant_name: 'Mozzo',
  restaurant_subtitle: '',
  contact_label: 'WhatsApp',
  contact_url: '',
  review_url: '',
  feedback_url: '',
});
assert.ok(incompleteContactErrors.contact);

const invalidUrlErrors = validateVenueSettingsForm({
  restaurant_name: 'Mozzo',
  restaurant_subtitle: '',
  contact_label: '',
  contact_url: '',
  review_url: 'http://',
  feedback_url: '',
});
assert.ok(invalidUrlErrors.review_url);

const validErrors = validateVenueSettingsForm({
  restaurant_name: 'Mozzo Palermo',
  restaurant_subtitle: 'Cocina y barra',
  contact_label: 'WhatsApp',
  contact_url: 'https://wa.me/5491100000000',
  review_url: 'https://example.com/reviews',
  feedback_url: 'https://example.com/feedback',
});
assert.deepEqual(validErrors, {});

const flexibleLinkErrors = validateVenueSettingsForm({
  restaurant_name: 'Mozzo Palermo',
  restaurant_subtitle: '',
  contact_label: 'Web',
  contact_url: 'arma2.com.ar',
  review_url: 'google.com/maps',
  feedback_url: '',
});
assert.deepEqual(flexibleLinkErrors, {});

const visibleLinks = getVisibleVenueLinks({
  restaurant_name: 'Mozzo',
  contact_label: 'WhatsApp',
  contact_url: 'https://wa.me/5491100000000',
  review_url: 'https://example.com/reviews',
  feedback_url: '',
});
assert.deepEqual(
  visibleLinks.map((link) => link.label),
  ['WhatsApp', 'Dejar reseña']
);

console.log('Sprint 4 frontend tests passed');
