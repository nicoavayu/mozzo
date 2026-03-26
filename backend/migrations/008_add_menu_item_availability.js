module.exports = {
  id: '008_add_menu_item_availability',
  async up(context) {
    if (!(await context.columnExists('menu_items', 'is_available'))) {
      await context.exec(`
        ALTER TABLE menu_items
        ADD COLUMN is_available INTEGER NOT NULL DEFAULT 1
      `);
    }

    await context.run(
      `
        UPDATE menu_items
        SET is_available = 1
        WHERE is_available IS NULL
      `
    );

    await context.exec(`
      CREATE INDEX IF NOT EXISTS idx_menu_items_category_id_is_available
      ON menu_items (category_id, is_available)
    `);
  }
};
