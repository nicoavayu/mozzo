module.exports = {
  id: '007_orders_open_lifecycle',
  async up(context) {
    if (!(await context.columnExists('orders', 'bill_requested_at'))) {
      await context.exec(`
        ALTER TABLE orders
        ADD COLUMN bill_requested_at DATETIME
      `);
    }

    if (!(await context.columnExists('orders', 'bill_attended_at'))) {
      await context.exec(`
        ALTER TABLE orders
        ADD COLUMN bill_attended_at DATETIME
      `);
    }

    if (!(await context.columnExists('orders', 'closed_at'))) {
      await context.exec(`
        ALTER TABLE orders
        ADD COLUMN closed_at DATETIME
      `);
    }

    const rows = await context.all(
      `
        SELECT
          id,
          table_id,
          status,
          created_at,
          processing_started_at,
          ready_at,
          delivered_at,
          closed_at
        FROM orders
        ORDER BY table_id ASC, created_at DESC, id DESC
      `
    );

    const openOrderByTable = new Set();

    for (const row of rows) {
      if (row.closed_at) {
        continue;
      }

      let closedAt = null;

      if (row.status === 'delivered') {
        closedAt = row.delivered_at || row.ready_at || row.processing_started_at || row.created_at;
      } else if (row.status === 'ready') {
        closedAt = row.ready_at || row.processing_started_at || row.created_at;
      } else if (openOrderByTable.has(row.table_id)) {
        closedAt = row.created_at;
      } else {
        openOrderByTable.add(row.table_id);
      }

      if (closedAt) {
        await context.run(
          `
            UPDATE orders
            SET closed_at = ?
            WHERE id = ?
          `,
          [closedAt, row.id]
        );
      }
    }

    await context.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_single_open_per_table
      ON orders (table_id)
      WHERE closed_at IS NULL
    `);
  }
};
