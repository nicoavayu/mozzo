module.exports = {
  id: '016_create_order_suborders',
  async up(context) {
    await context.exec(`
      CREATE TABLE IF NOT EXISTS order_suborders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        table_id INTEGER NOT NULL,
        sequence_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'delivered', 'cancelled')),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processing_started_at DATETIME,
        ready_at DATETIME,
        delivered_at DATETIME,
        cancelled_at DATETIME,
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_order_suborders_order_id
      ON order_suborders (order_id);

      CREATE INDEX IF NOT EXISTS idx_order_suborders_table_status_created
      ON order_suborders (table_id, status, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_order_suborders_created_at
      ON order_suborders (created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_order_suborders_status_created
      ON order_suborders (status, created_at ASC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_order_suborders_order_sequence
      ON order_suborders (order_id, sequence_number);

      CREATE TABLE IF NOT EXISTS order_suborder_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        suborder_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        comments TEXT,
        item_name TEXT,
        item_description TEXT,
        unit_price REAL,
        FOREIGN KEY (suborder_id) REFERENCES order_suborders (id) ON DELETE RESTRICT,
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_order_suborder_items_suborder_id
      ON order_suborder_items (suborder_id);

      CREATE INDEX IF NOT EXISTS idx_order_suborder_items_order_id
      ON order_suborder_items (order_id);
    `);

    const ordersWithoutSuborders = await context.all(`
      SELECT
        o.id,
        o.table_id,
        o.status,
        o.created_at,
        o.processing_started_at,
        o.ready_at,
        o.delivered_at
      FROM orders o
      WHERE NOT EXISTS (
        SELECT 1
        FROM order_suborders os
        WHERE os.order_id = o.id
      )
      ORDER BY o.id ASC
    `);

    for (const order of ordersWithoutSuborders) {
      const insertResult = await context.run(
        `
          INSERT INTO order_suborders (
            order_id,
            table_id,
            sequence_number,
            status,
            created_at,
            processing_started_at,
            ready_at,
            delivered_at,
            cancelled_at
          )
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL)
        `,
        [
          order.id,
          order.table_id,
          order.status || 'pending',
          order.created_at || null,
          order.processing_started_at || null,
          order.ready_at || null,
          order.delivered_at || null,
        ]
      );

      const orderItems = await context.all(
        `
          SELECT
            item_id,
            quantity,
            comments,
            item_name,
            item_description,
            unit_price
          FROM order_items
          WHERE order_id = ?
          ORDER BY id ASC
        `,
        [order.id]
      );

      for (const item of orderItems) {
        await context.run(
          `
            INSERT INTO order_suborder_items (
              suborder_id,
              order_id,
              item_id,
              quantity,
              comments,
              item_name,
              item_description,
              unit_price
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            insertResult.lastID,
            order.id,
            item.item_id,
            item.quantity,
            item.comments || '',
            item.item_name || null,
            item.item_description || null,
            item.unit_price ?? null,
          ]
        );
      }
    }
  },
};
