module.exports = {
  id: '010_add_order_payment_fields',
  async up(context) {
    if (!(await context.columnExists('orders', 'payment_received_at'))) {
      await context.run(`
        ALTER TABLE orders
        ADD COLUMN payment_received_at DATETIME
      `);
    }

    if (!(await context.columnExists('orders', 'payment_method'))) {
      await context.run(`
        ALTER TABLE orders
        ADD COLUMN payment_method TEXT CHECK (payment_method IN ('cash', 'card', 'transfer', 'other'))
      `);
    }
  }
};
