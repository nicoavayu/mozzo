export const EXTERNAL_AI_MENU_PROMPTS = {
  single_image: `Analizá esta imagen del menú de un restaurante y devolvé TODO el menú detectado en un único JSON válido.

Reglas obligatorias:
- Respondé únicamente JSON válido.
- No agregues explicación, markdown ni texto fuera del JSON.
- No inventes platos, precios, categorías ni notas que no se vean.
- Si no ves bien un precio, usá null.
- Si no ves bien una descripción, usá "".
- Mantené el idioma original del menú.

Formato exacto de salida:
{
  "menu_name": "string",
  "categories": [
    {
      "name": "string",
      "items": [
        {
          "name": "string",
          "description": "string",
          "price": number | null
        }
      ]
    }
  ],
  "notes": ["string"]
}`,
  multi_image: `Analizá estas imágenes del mismo menú de un restaurante y devolvé TODO el menú consolidado en un único JSON válido.

Reglas obligatorias:
- Respondé únicamente JSON válido.
- No agregues explicación, markdown ni texto fuera del JSON.
- Unificá la información de todas las imágenes en una sola respuesta final.
- No repitas categorías ni platos si aparecen en más de una imagen.
- No inventes platos, precios, categorías ni notas que no se vean.
- Si no ves bien un precio, usá null.
- Si no ves bien una descripción, usá "".
- Mantené el idioma original del menú.

Formato exacto de salida:
{
  "menu_name": "string",
  "categories": [
    {
      "name": "string",
      "items": [
        {
          "name": "string",
          "description": "string",
          "price": number | null
        }
      ]
    }
  ],
  "notes": ["string"]
}`,
};

export const EXTERNAL_AI_MENU_JSON_EXAMPLES = {
  valid: `{
  "menu_name": "Menú del día",
  "categories": [
    {
      "name": "Entradas",
      "items": [
        {
          "name": "Sopa casera",
          "description": "Con verduras de estación",
          "price": 7.5
        }
      ]
    },
    {
      "name": "Bebidas",
      "items": [
        {
          "name": "Limonada",
          "description": "",
          "price": null
        }
      ]
    }
  ],
  "notes": ["El menú dice que algunos platos pueden variar."]
}`,
  invalid: `Acá te paso el menú:
{
  "menu_name": "Menú del día",
  "categories": [],
  "notes": []
}`,
};

export const EXTERNAL_AI_MENU_PROMPT = EXTERNAL_AI_MENU_PROMPTS.single_image;

function createValidationError(message) {
  const error = new Error(message);
  error.code = 'INVALID_EXTERNAL_MENU_JSON';
  return error;
}

function ensurePlainObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createValidationError(message);
  }

  return value;
}

function ensureNonEmptyString(value, message) {
  if (typeof value !== 'string' || !value.trim()) {
    throw createValidationError(message);
  }

  return value.trim();
}

function ensureOptionalString(value, message) {
  if (typeof value !== 'string') {
    throw createValidationError(message);
  }

  return value.trim();
}

function ensureNotesArray(value) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw createValidationError('notes debe ser una lista de textos.');
  }

  return value.map((note) => ensureNonEmptyString(note, 'Hay notas vacías o con formato inválido.'));
}

export function validateExternalMenuJson(rawValue) {
  if (!String(rawValue || '').trim()) {
    throw createValidationError('Pegá el JSON antes de validarlo.');
  }

  let parsedValue;

  try {
    parsedValue = JSON.parse(rawValue);
  } catch {
    throw createValidationError(
      'El JSON no es válido. Pegá solo el bloque JSON, sin texto antes ni después.'
    );
  }

  const root = ensurePlainObject(
    parsedValue,
    'El contenido pegado no tiene el formato esperado.'
  );
  const menuName = ensureNonEmptyString(root.menu_name, 'Falta el nombre del menú.');

  if (!Object.prototype.hasOwnProperty.call(root, 'categories')) {
    throw createValidationError('Falta categories.');
  }

  if (!Array.isArray(root.categories)) {
    throw createValidationError('categories debe ser una lista de categorías.');
  }

  if (root.categories.length === 0) {
    throw createValidationError('No se detectaron categorías.');
  }

  const categories = root.categories.map((category) => {
    const normalizedCategory = ensurePlainObject(
      category,
      'Hay una categoría con formato inválido.'
    );
    const categoryName = ensureNonEmptyString(
      normalizedCategory.name,
      'Hay categorías sin nombre.'
    );

    if (!Object.prototype.hasOwnProperty.call(normalizedCategory, 'items')) {
      throw createValidationError(`La categoría "${categoryName}" no trae productos.`);
    }

    if (!Array.isArray(normalizedCategory.items)) {
      throw createValidationError(`La categoría "${categoryName}" tiene un listado de productos inválido.`);
    }

    const items = normalizedCategory.items.map((item) => {
      const normalizedItem = ensurePlainObject(item, 'Hay un producto con formato inválido.');
      const itemName = ensureNonEmptyString(normalizedItem.name, 'Hay productos sin nombre.');

      if (!Object.prototype.hasOwnProperty.call(normalizedItem, 'description')) {
        throw createValidationError('Cada producto debe incluir description, aunque esté vacía.');
      }

      const itemDescription = ensureOptionalString(
        normalizedItem.description,
        'description debe ser un texto. Si no hay descripción, usá "".'
      );

      const priceValue = normalizedItem.price;
      if (priceValue !== null && (typeof priceValue !== 'number' || Number.isNaN(priceValue))) {
        throw createValidationError('El precio debe ser número o null.');
      }

      if (typeof priceValue === 'number' && priceValue < 0) {
        throw createValidationError('El precio no puede ser negativo.');
      }

      return {
        name: itemName,
        description: itemDescription,
        price: priceValue,
      };
    });

    const usefulItems = items.filter((item) => item.name);
    if (usefulItems.length === 0) {
      throw createValidationError(`La categoría "${categoryName}" no tiene productos válidos.`);
    }

    return {
      name: categoryName,
      items: usefulItems,
    };
  });

  const totalItems = categories.reduce((sum, category) => sum + category.items.length, 0);
  if (totalItems === 0) {
    throw createValidationError('No se detectaron productos válidos.');
  }

  const notes = ensureNotesArray(root.notes);
  const itemsWithNullPrice = categories.reduce(
    (sum, category) => sum + category.items.filter((item) => item.price === null).length,
    0
  );

  return {
    menu_name: menuName,
    categories,
    notes,
    summary: {
      categoryCount: categories.length,
      itemCount: totalItems,
      noteCount: notes.length,
      hasNotes: notes.length > 0,
      pricesPendingCount: itemsWithNullPrice,
      categoriesPreview: categories.map((category) => ({
        name: category.name,
        itemCount: category.items.length,
      })),
    },
  };
}

export function buildDraftFromExternalMenu(validatedMenu) {
  const categories = validatedMenu.categories.map((category) => {
    const items = category.items.map((item) => {
      const flags = [];

      if (item.price === null) {
        flags.push('price_missing');
      }

      return {
        name: item.name,
        description: item.description,
        price: item.price === null ? '' : item.price,
        confidence: null,
        flags,
      };
    });

    const reviewCount = items.filter((item) => item.flags.length > 0).length;

    return {
      name: category.name,
      confidence: null,
      reviewCount,
      reviewPriority: reviewCount > 0 ? 2 : 0,
      reviewSummary: reviewCount > 0 ? ['Hay precios pendientes para completar'] : [],
      flags: [],
      items,
    };
  });

  const warnings = [
    'JSON importado desde una IA externa. Revisá categorías, textos y precios antes de publicar.'
  ];

  if (validatedMenu.summary.pricesPendingCount > 0) {
    warnings.push(
      `Hay ${validatedMenu.summary.pricesPendingCount} precio(s) sin confirmar. Completalos antes de publicar.`
    );
  }

  return {
    name: validatedMenu.menu_name,
    categories,
    confidence: null,
    diagnostics: {
      import_source: 'external_ai',
      import_summary: validatedMenu.summary,
      warnings,
      review_focus: {
        items_to_review: validatedMenu.summary.pricesPendingCount,
        estimated_prices: 0,
        low_confidence_items: 0,
        inferred_categories: 0,
        heuristic_groups: 0,
        service_notes: 0,
        suspicious_lines: 0,
        discarded_lines: 0,
      },
      review_queue: categories
        .filter((category) => category.reviewPriority > 0)
        .map((category) => ({
          name: category.name,
          confidence: null,
          review_count: category.reviewCount,
          review_priority: category.reviewPriority,
          summary: category.reviewSummary,
          flags: category.flags,
        })),
    },
    discarded_lines: [],
    suspicious_lines: [],
    preview_images: [],
    review_required: true,
    notes: validatedMenu.notes,
  };
}
