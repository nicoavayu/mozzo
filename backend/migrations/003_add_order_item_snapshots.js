module.exports = {
  id: '003_add_order_item_snapshots',
  async up(context) {
    if (!(await context.columnExists('order_items', 'item_name'))) {
      await context.run('ALTER TABLE order_items ADD COLUMN item_name TEXT');
    }

    if (!(await context.columnExists('order_items', 'item_description'))) {
      await context.run('ALTER TABLE order_items ADD COLUMN item_description TEXT');
    }

    if (!(await context.columnExists('order_items', 'unit_price'))) {
      await context.run('ALTER TABLE order_items ADD COLUMN unit_price REAL');
    }

    await context.exec(`
      UPDATE order_items
      SET
        item_name = COALESCE(
          item_name,
          (SELECT mi.name FROM menu_items mi WHERE mi.id = order_items.item_id)
        ),
        item_description = COALESCE(
          item_description,
          (SELECT mi.description FROM menu_items mi WHERE mi.id = order_items.item_id)
        ),
        unit_price = COALESCE(
          unit_price,
          (SELECT mi.price FROM menu_items mi WHERE mi.id = order_items.item_id)
        )
      WHERE item_name IS NULL
         OR item_description IS NULL
         OR unit_price IS NULL;

      CREATE INDEX IF NOT EXISTS idx_orders_table_status_id
      ON orders (table_id, status, id DESC);
    `);
  }
};
