module.exports = {
  id: '006_add_order_status_timestamps',
  async up(context) {
    if (!(await context.columnExists('orders', 'processing_started_at'))) {
      await context.exec(`
        ALTER TABLE orders
        ADD COLUMN processing_started_at DATETIME
      `);
    }

    if (!(await context.columnExists('orders', 'ready_at'))) {
      await context.exec(`
        ALTER TABLE orders
        ADD COLUMN ready_at DATETIME
      `);
    }

    if (!(await context.columnExists('orders', 'delivered_at'))) {
      await context.exec(`
        ALTER TABLE orders
        ADD COLUMN delivered_at DATETIME
      `);
    }
  }
};
