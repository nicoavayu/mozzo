export function createEmptyItem() {
  return {
    name: '',
    description: '',
    price: '',
    confidence: null,
    flags: [],
  };
}

export function normalizeMenuDraft(data, draftSourceOverride = null) {
  const categories = Array.isArray(data?.categories)
    ? data.categories
    : Array.isArray(data)
      ? data
      : [];

  const draftSource = draftSourceOverride
    || data?.draftSource
    || data?.diagnostics?.import_source
    || 'image';

  return {
    name: data?.name || 'Menú importado',
    draftSource,
    categories: categories.map((category) => ({
      name: category.name || 'Categoría',
      confidence: category.confidence ?? null,
      reviewCount: category.review_count ?? 0,
      reviewPriority: category.review_priority ?? 0,
      reviewSummary: Array.isArray(category.review_summary) ? category.review_summary : [],
      flags: Array.isArray(category.flags) ? category.flags : [],
      items: Array.isArray(category.items)
        ? category.items.map((item) => ({
            name: item.name || '',
            description: item.description || '',
            price: item.price ?? '',
            confidence: item.confidence ?? null,
            flags: Array.isArray(item.flags) ? item.flags : [],
          }))
        : [],
    })),
    confidence: data?.confidence ?? data?.diagnostics?.global_confidence ?? null,
    diagnostics: data?.diagnostics || null,
    discardedLines: Array.isArray(data?.discarded_lines) ? data.discarded_lines : [],
    suspiciousLines: Array.isArray(data?.suspicious_lines) ? data.suspicious_lines : [],
    previewImages: Array.isArray(data?.preview_images) ? data.preview_images : [],
    notes: Array.isArray(data?.notes) ? data.notes : [],
    reviewRequired: data?.review_required !== false,
  };
}

export function createManualMenuDraft() {
  return {
    name: 'Menú manual',
    draftSource: 'manual',
    categories: [],
    confidence: null,
    diagnostics: null,
    discardedLines: [],
    suspiciousLines: [],
    previewImages: [],
    notes: [],
    reviewRequired: false,
  };
}

export function buildPublishableCategories(categories = []) {
  return categories
    .map((category) => ({
      name: String(category.name || '').trim() || 'Categoría',
      items: (category.items || [])
        .map((item) => ({
          name: String(item.name || '').trim(),
          description: String(item.description || '').trim(),
          price: item.price === '' || item.price === null || item.price === undefined
            ? 0
            : Number(item.price),
        }))
        .filter((item) => item.name),
    }))
    .filter((category) => category.items.length > 0);
}

export function validateManualMenuDraft(draft) {
  if (!draft) {
    return 'No hay un borrador manual para publicar.';
  }

  const menuName = String(draft.name || '').trim();
  if (!menuName) {
    return 'Indicá un nombre para el menú.';
  }

  const categories = Array.isArray(draft.categories) ? draft.categories : [];

  for (const category of categories) {
    for (const item of category.items || []) {
      const name = String(item?.name || '').trim();
      const description = String(item?.description || '').trim();
      const rawPrice = item?.price;
      const hasPrice = rawPrice !== '' && rawPrice !== null && rawPrice !== undefined;
      const hasAnyContent = Boolean(name || description || hasPrice);

      if (!hasAnyContent) {
        continue;
      }

      if (!name) {
        return 'Cada plato manual debe tener nombre o eliminarse antes de publicar.';
      }

      if (!hasPrice) {
        return `El plato "${name}" necesita un precio antes de publicar.`;
      }

      const numericPrice = Number(rawPrice);
      if (!Number.isFinite(numericPrice) || numericPrice < 0) {
        return `El precio de "${name}" no es válido.`;
      }
    }
  }

  if (buildPublishableCategories(categories).length === 0) {
    return 'El borrador manual necesita al menos una categoría con platos válidos.';
  }

  return null;
}
