module.exports = {
  id: '001_create_base_schema',
  async up(context) {
    await context.exec(`
      CREATE TABLE IF NOT EXISTS menus (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        published_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_menus_single_active
      ON menus (is_active)
      WHERE is_active = 1;

      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_id INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_orders_created_at
      ON orders (created_at DESC);
    `);

    if (!(await context.tableExists('menu_categories'))) {
      await context.exec(`
        CREATE TABLE menu_categories (
          id INTEGER PRIMARY KEY,
          menu_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          FOREIGN KEY (menu_id) REFERENCES menus (id) ON DELETE RESTRICT
        );

        CREATE INDEX idx_menu_categories_menu_id
        ON menu_categories (menu_id);
      `);
    } else if (await context.columnExists('menu_categories', 'menu_id')) {
      await context.exec(`
        CREATE INDEX IF NOT EXISTS idx_menu_categories_menu_id
        ON menu_categories (menu_id);
      `);
    }

    if (!(await context.tableExists('menu_items'))) {
      await context.exec(`
        CREATE TABLE menu_items (
          id INTEGER PRIMARY KEY,
          category_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          price REAL NOT NULL,
          FOREIGN KEY (category_id) REFERENCES menu_categories (id) ON DELETE RESTRICT
        );

        CREATE INDEX idx_menu_items_category_id
        ON menu_items (category_id);
      `);
    } else {
      await context.exec(`
        CREATE INDEX IF NOT EXISTS idx_menu_items_category_id
        ON menu_items (category_id);
      `);
    }

    if (!(await context.tableExists('order_items'))) {
      await context.exec(`
        CREATE TABLE order_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id INTEGER NOT NULL,
          item_id INTEGER NOT NULL,
          quantity INTEGER NOT NULL,
          comments TEXT,
          FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
          FOREIGN KEY (item_id) REFERENCES menu_items (id) ON DELETE RESTRICT
        );

        CREATE INDEX idx_order_items_order_id
        ON order_items (order_id);
      `);
    } else {
      await context.exec(`
        CREATE INDEX IF NOT EXISTS idx_order_items_order_id
        ON order_items (order_id);
      `);
    }
  }
};
