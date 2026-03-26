const DEFAULT_VENUE_SETTINGS = Object.freeze({
  restaurant_name: process.env.RESTAURANT_NAME || process.env.VITE_RESTAURANT_NAME || 'Mozzo',
  restaurant_subtitle: '',
  contact_label: '',
  contact_url: '',
  review_url: process.env.GUEST_REVIEW_URL || '',
  feedback_url: process.env.GUEST_FEEDBACK_URL || '',
  updated_at: null,
});

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeOptionalUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

function normalizeVenueSettingsInput(input = {}) {
  return {
    restaurant_name: String(input.restaurant_name || '').trim(),
    restaurant_subtitle: String(input.restaurant_subtitle || '').trim(),
    contact_label: String(input.contact_label || '').trim(),
    contact_url: normalizeOptionalUrl(input.contact_url),
    review_url: normalizeOptionalUrl(input.review_url),
    feedback_url: normalizeOptionalUrl(input.feedback_url),
  };
}

function validateVenueSettingsInput(input) {
  const errors = {};

  if (!input.restaurant_name) {
    errors.restaurant_name = 'El nombre del local es obligatorio.';
  }

  if ((input.contact_label && !input.contact_url) || (!input.contact_label && input.contact_url)) {
    errors.contact = 'Completá etiqueta y URL de contacto, o dejá ambos vacíos.';
  }

  ['contact_url', 'review_url', 'feedback_url'].forEach((field) => {
    if (input[field] && !isValidHttpUrl(input[field])) {
      errors[field] = 'Ingresá una URL válida.';
    }
  });

  return errors;
}

function mergeVenueSettings(row) {
  if (!row) {
    return { ...DEFAULT_VENUE_SETTINGS };
  }

  return {
    restaurant_name: row.restaurant_name || DEFAULT_VENUE_SETTINGS.restaurant_name,
    restaurant_subtitle: row.restaurant_subtitle || '',
    contact_label: row.contact_label || '',
    contact_url: row.contact_url || '',
    review_url: row.review_url || '',
    feedback_url: row.feedback_url || '',
    updated_at: row.updated_at || null,
  };
}

async function readVenueSettings(database) {
  const row = await database.get(
    `SELECT restaurant_name, restaurant_subtitle, contact_label, contact_url, review_url, feedback_url, updated_at
     FROM venue_settings
     WHERE id = 1`
  );

  return mergeVenueSettings(row);
}

async function saveVenueSettings(database, input) {
  const normalized = normalizeVenueSettingsInput(input);
  const errors = validateVenueSettingsInput(normalized);

  if (Object.keys(errors).length > 0) {
    const error = new Error('Configuración inválida.');
    error.status = 400;
    error.fields = errors;
    throw error;
  }

  await database.run(
    `INSERT INTO venue_settings (
      id,
      restaurant_name,
      restaurant_subtitle,
      contact_label,
      contact_url,
      review_url,
      feedback_url,
      updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      restaurant_name = excluded.restaurant_name,
      restaurant_subtitle = excluded.restaurant_subtitle,
      contact_label = excluded.contact_label,
      contact_url = excluded.contact_url,
      review_url = excluded.review_url,
      feedback_url = excluded.feedback_url,
      updated_at = CURRENT_TIMESTAMP`,
    [
      normalized.restaurant_name,
      normalized.restaurant_subtitle,
      normalized.contact_label,
      normalized.contact_url,
      normalized.review_url,
      normalized.feedback_url,
    ]
  );

  return readVenueSettings(database);
}

module.exports = {
  DEFAULT_VENUE_SETTINGS,
  normalizeOptionalUrl,
  normalizeVenueSettingsInput,
  validateVenueSettingsInput,
  readVenueSettings,
  saveVenueSettings,
};
