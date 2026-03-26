export const HISTORY_PRESET_OPTIONS = [
  { value: 'today', label: 'Hoy' },
  { value: 'last_7_days', label: 'Últimos 7 días' },
];

export const HISTORY_PAYMENT_METHOD_OPTIONS = [
  { value: '', label: 'Todos los medios' },
  { value: 'cash', label: 'Efectivo' },
  { value: 'card', label: 'Tarjeta' },
  { value: 'transfer', label: 'Transferencia' },
  { value: 'other', label: 'Otro' },
];

export const DEFAULT_HISTORY_FILTERS = Object.freeze({
  preset: 'today',
  from: '',
  to: '',
  payment_method: '',
  limit: 50,
  offset: 0,
});

export function normalizeHistoryFilters(value = {}) {
  return {
    preset: String(value.preset || DEFAULT_HISTORY_FILTERS.preset).trim() || DEFAULT_HISTORY_FILTERS.preset,
    from: String(value.from || '').trim(),
    to: String(value.to || '').trim(),
    payment_method: String(value.payment_method || '').trim(),
    limit: Number.isInteger(Number(value.limit)) ? Number(value.limit) : DEFAULT_HISTORY_FILTERS.limit,
    offset: Number.isInteger(Number(value.offset)) ? Number(value.offset) : DEFAULT_HISTORY_FILTERS.offset,
  };
}

export function buildHistoryQuery(filters = {}) {
  const normalized = normalizeHistoryFilters(filters);
  const params = new URLSearchParams();

  if (normalized.from || normalized.to) {
    if (normalized.from) {
      params.set('from', normalized.from);
    }

    if (normalized.to) {
      params.set('to', normalized.to);
    }
  } else if (normalized.preset) {
    params.set('preset', normalized.preset);
  }

  if (normalized.payment_method) {
    params.set('payment_method', normalized.payment_method);
  }

  if (normalized.limit) {
    params.set('limit', String(normalized.limit));
  }

  if (normalized.offset) {
    params.set('offset', String(normalized.offset));
  }

  const queryString = params.toString();
  return queryString ? `?${queryString}` : '';
}

export function formatHistoryPaymentMethod(value) {
  const normalizedValue = String(value || '').trim().toLowerCase();

  switch (normalizedValue) {
    case 'cash':
      return 'Efectivo';
    case 'card':
      return 'Tarjeta';
    case 'transfer':
      return 'Transferencia';
    case 'other':
      return 'Otro';
    default:
      return 'Sin registrar';
  }
}

export function formatHistoryMinutes(value) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) {
    return '—';
  }

  const minutes = Math.max(1, Math.round(Number(value)));
  return `${minutes} min`;
}
