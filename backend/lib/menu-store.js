function createMenuStoreError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function ensurePositiveInteger(value, fieldName) {
  const normalizedValue = Number(value);

  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    throw createMenuStoreError('INVALID_MENU_ITEM', `${fieldName} must be a positive integer`);
  }

  return normalizedValue;
}

function normalizeAvailability(value) {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  if (value === 1 || value === '1') {
    return 1;
  }

  if (value === 0 || value === '0') {
    return 0;
  }

  throw createMenuStoreError('INVALID_AVAILABILITY', 'is_available must be a boolean');
}

function hasMenuPrice(value) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'string' && value.trim() === '') {
    return false;
  }

  return true;
}

function validatePublishableCategories(categories) {
  const safeCategories = Array.isArray(categories) ? categories : [];
  const normalizedCategories = [];

  for (const category of safeCategories) {
    const normalizedCategory = {
      name: String(category?.name || '').trim() || 'Categoría',
      items: [],
    };

    for (const item of category?.items || []) {
      const name = String(item?.name || '').trim();
      const description = String(item?.description || '').trim();
      const rawPrice = item?.price;
      const hasPrice = hasMenuPrice(rawPrice);
      const hasAnyContent = Boolean(name || description || hasPrice);

      if (!hasAnyContent) {
        continue;
      }

      if (!name) {
        throw createMenuStoreError(
          'INVALID_MENU_ITEM',
          'Cada plato debe tener nombre o eliminarse antes de publicar.',
          400
        );
      }

      if (!hasPrice) {
        throw createMenuStoreError(
          'INVALID_MENU_PRICE',
          `El plato "${name}" necesita un precio antes de publicar.`,
          400
        );
      }

      const numericPrice = Number(rawPrice);
      if (!Number.isFinite(numericPrice) || numericPrice < 0) {
        throw createMenuStoreError(
          'INVALID_MENU_PRICE',
          `El precio de "${name}" no es válido.`,
          400
        );
      }

      normalizedCategory.items.push({
        name,
        description,
        price: numericPrice,
      });
    }

    if (normalizedCategory.items.length > 0) {
      normalizedCategories.push(normalizedCategory);
    }
  }

  if (normalizedCategories.length === 0) {
    throw createMenuStoreError(
      'EMPTY_MENU_PUBLISH',
      'El borrador no tiene categorías con platos válidos para publicar.',
      400
    );
  }

  return normalizedCategories;
}

async function getActiveMenuCategories(database) {
  const activeMenu = await database.get(
    'SELECT id FROM menus WHERE is_active = 1 ORDER BY published_at DESC, id DESC LIMIT 1'
  );

  if (!activeMenu) {
    return [];
  }

  const categories = await database.all(
    'SELECT id, name FROM menu_categories WHERE menu_id = ? ORDER BY id ASC',
    [activeMenu.id]
  );

  const items = await database.all(
    `
      SELECT mi.id, mi.category_id, mi.name, mi.description, mi.price, mi.is_available
      FROM menu_items mi
      INNER JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE mc.menu_id = ?
      ORDER BY mi.id ASC
    `,
    [activeMenu.id]
  );

  return categories.map((category) => ({
    ...category,
    items: items.filter((item) => item.category_id === category.id)
  }));
}

async function getActiveMenuSummary(database) {
  const activeMenu = await database.get(
    `
      SELECT id, name, published_at
      FROM menus
      WHERE is_active = 1
      ORDER BY published_at DESC, id DESC
      LIMIT 1
    `
  );

  if (!activeMenu) {
    return null;
  }

  const counts = await database.get(
    `
      SELECT
        COUNT(DISTINCT mc.id) AS category_count,
        COUNT(mi.id) AS item_count
      FROM menu_categories mc
      LEFT JOIN menu_items mi ON mi.category_id = mc.id
      WHERE mc.menu_id = ?
    `,
    [activeMenu.id]
  );

  return {
    ...activeMenu,
    category_count: Number(counts?.category_count || 0),
    item_count: Number(counts?.item_count || 0),
  };
}

async function publishMenuVersion(database, categories, name = null) {
  const safeCategories = validatePublishableCategories(categories);
  const menuName = name || `Published Menu ${new Date().toISOString()}`;

  return database.withTransaction(async () => {
    await database.run('UPDATE menus SET is_active = 0 WHERE is_active = 1');

    const menuResult = await database.run(
      `
        INSERT INTO menus (name, is_active, published_at)
        VALUES (?, 1, CURRENT_TIMESTAMP)
      `,
      [menuName]
    );

    for (const category of safeCategories) {
      const categoryResult = await database.run(
        'INSERT INTO menu_categories (menu_id, name) VALUES (?, ?)',
        [menuResult.lastID, category.name]
      );

      for (const item of category.items || []) {
        await database.run(
          `
            INSERT INTO menu_items (category_id, name, description, price)
            VALUES (?, ?, ?, ?)
          `,
          [
            categoryResult.lastID,
            item.name,
            item.description || '',
            item.price
          ]
        );
      }
    }

    return menuResult.lastID;
  });
}

async function clearActiveMenu(database) {
  return database.withTransaction(async () => {
    const activeMenu = await getActiveMenuSummary(database);

    if (!activeMenu) {
      return null;
    }

    await database.run('UPDATE menus SET is_active = 0 WHERE id = ?', [activeMenu.id]);
    return activeMenu;
  });
}

async function updateActiveMenuItemAvailability(database, itemId, isAvailable) {
  const normalizedItemId = ensurePositiveInteger(itemId, 'item_id');
  const normalizedAvailability = normalizeAvailability(isAvailable);

  const activeItem = await database.get(
    `
      SELECT
        mi.id,
        mi.category_id,
        mi.name,
        mi.description,
        mi.price,
        mi.is_available
      FROM menu_items mi
      INNER JOIN menu_categories mc ON mc.id = mi.category_id
      INNER JOIN menus m ON m.id = mc.menu_id
      WHERE mi.id = ?
        AND m.is_active = 1
      LIMIT 1
    `,
    [normalizedItemId]
  );

  if (!activeItem) {
    throw createMenuStoreError(
      'MENU_ITEM_NOT_FOUND',
      'No encontramos ese producto dentro del menú activo.',
      404
    );
  }

  await database.run(
    `
      UPDATE menu_items
      SET is_available = ?
      WHERE id = ?
    `,
    [normalizedAvailability, normalizedItemId]
  );

  return {
    ...activeItem,
    is_available: normalizedAvailability,
  };
}

module.exports = {
  getActiveMenuCategories,
  getActiveMenuSummary,
  publishMenuVersion,
  clearActiveMenu,
  updateActiveMenuItemAvailability,
  validatePublishableCategories,
};
