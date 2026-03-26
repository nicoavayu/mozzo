import { RESTAURANT_NAME } from './config.js';

export const DEFAULT_VENUE_SETTINGS = Object.freeze({
  restaurant_name: RESTAURANT_NAME,
  restaurant_subtitle: '',
  contact_label: '',
  contact_url: '',
  review_url: '',
  feedback_url: '',
  updated_at: null,
});

export function normalizeVenueSettings(value = {}) {
  return {
    restaurant_name: String(value.restaurant_name || DEFAULT_VENUE_SETTINGS.restaurant_name).trim() || DEFAULT_VENUE_SETTINGS.restaurant_name,
    restaurant_subtitle: String(value.restaurant_subtitle || '').trim(),
    contact_label: String(value.contact_label || '').trim(),
    contact_url: String(value.contact_url || '').trim(),
    review_url: String(value.review_url || '').trim(),
    feedback_url: String(value.feedback_url || '').trim(),
    updated_at: value.updated_at || null,
  };
}

function normalizeOptionalUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateVenueSettingsForm(value = {}) {
  const normalized = {
    restaurant_name: String(value.restaurant_name || '').trim(),
    restaurant_subtitle: String(value.restaurant_subtitle || '').trim(),
    contact_label: String(value.contact_label || '').trim(),
    contact_url: normalizeOptionalUrl(value.contact_url),
    review_url: normalizeOptionalUrl(value.review_url),
    feedback_url: normalizeOptionalUrl(value.feedback_url),
  };
  const errors = {};

  if (!normalized.restaurant_name) {
    errors.restaurant_name = 'El nombre del local es obligatorio.';
  }

  if ((normalized.contact_label && !normalized.contact_url) || (!normalized.contact_label && normalized.contact_url)) {
    errors.contact = 'Completá etiqueta y URL de contacto, o dejá ambos vacíos.';
  }

  ['contact_url', 'review_url', 'feedback_url'].forEach((field) => {
    if (normalized[field] && !isValidHttpUrl(normalized[field])) {
      errors[field] = 'Ingresá una URL válida.';
    }
  });

  return errors;
}

export function getVisibleVenueLinks(settings = {}) {
  const normalized = normalizeVenueSettings(settings);
  const links = [];

  if (normalized.contact_label && normalized.contact_url) {
    links.push({ key: 'contact', label: normalized.contact_label, url: normalized.contact_url });
  }

  if (normalized.review_url) {
    links.push({ key: 'review', label: 'Dejar reseña', url: normalized.review_url });
  }

  if (normalized.feedback_url) {
    links.push({ key: 'feedback', label: 'Enviar sugerencia', url: normalized.feedback_url });
  }

  return links;
}

export function prepareVenueSettingsPayload(value = {}) {
  return {
    restaurant_name: String(value.restaurant_name || '').trim(),
    restaurant_subtitle: String(value.restaurant_subtitle || '').trim(),
    contact_label: String(value.contact_label || '').trim(),
    contact_url: normalizeOptionalUrl(value.contact_url),
    review_url: normalizeOptionalUrl(value.review_url),
    feedback_url: normalizeOptionalUrl(value.feedback_url),
  };
}
