module.exports = {
  id: '002_migrate_legacy_menu_versioning',
  async up(context) {
    const hasLegacyCategories = await context.tableExists('menu_categories');
    const hasLegacyItems = await context.tableExists('menu_items');

    if (!hasLegacyCategories || !hasLegacyItems) {
      return;
    }

    const categoriesAlreadyVersioned = await context.columnExists('menu_categories', 'menu_id');

    if (categoriesAlreadyVersioned) {
      return;
    }

    const existingActiveMenu = await context.get(
      'SELECT id FROM menus WHERE is_active = 1 LIMIT 1'
    );

    const menuResult = existingActiveMenu || await context.run(
      `
        INSERT INTO menus (name, is_active, published_at)
        VALUES ('Migrated Menu', 1, CURRENT_TIMESTAMP)
      `
    );

    const activeMenuId = existingActiveMenu ? existingActiveMenu.id : menuResult.lastID;

    await context.exec(`
      CREATE TABLE menu_categories_v2 (
        id INTEGER PRIMARY KEY,
        menu_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        FOREIGN KEY (menu_id) REFERENCES menus (id) ON DELETE RESTRICT
      );

      CREATE TABLE menu_items_v2 (
        id INTEGER PRIMARY KEY,
        category_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        price REAL NOT NULL,
        FOREIGN KEY (category_id) REFERENCES menu_categories_v2 (id) ON DELETE RESTRICT
      );

      CREATE TABLE order_items_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        comments TEXT,
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
        FOREIGN KEY (item_id) REFERENCES menu_items_v2 (id) ON DELETE RESTRICT
      );
    `);

    await context.run(
      `
        INSERT INTO menu_categories_v2 (id, menu_id, name)
        SELECT id, ?, name
        FROM menu_categories
        ORDER BY id ASC
      `,
      [activeMenuId]
    );

    await context.exec(`
      INSERT INTO menu_items_v2 (id, category_id, name, description, price)
      SELECT id, category_id, name, description, price
      FROM menu_items
      ORDER BY id ASC;

      INSERT INTO order_items_v2 (id, order_id, item_id, quantity, comments)
      SELECT id, order_id, item_id, quantity, comments
      FROM order_items
      ORDER BY id ASC;

      DROP TABLE order_items;
      DROP TABLE menu_items;
      DROP TABLE menu_categories;

      ALTER TABLE menu_categories_v2 RENAME TO menu_categories;
      ALTER TABLE menu_items_v2 RENAME TO menu_items;
      ALTER TABLE order_items_v2 RENAME TO order_items;

      CREATE INDEX IF NOT EXISTS idx_menu_categories_menu_id
      ON menu_categories (menu_id);

      CREATE INDEX IF NOT EXISTS idx_menu_items_category_id
      ON menu_items (category_id);

      CREATE INDEX IF NOT EXISTS idx_order_items_order_id
      ON order_items (order_id);
    `);
  }
};
