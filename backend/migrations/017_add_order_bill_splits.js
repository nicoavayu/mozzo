module.exports = {
  id: '017_add_order_bill_splits',
  async up(context) {
    await context.exec(`
      CREATE TABLE IF NOT EXISTS order_bill_splits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('equal', 'manual')),
        position INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled')),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_order_bill_splits_order_id_created
      ON order_bill_splits (order_id, created_at ASC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_order_bill_splits_order_id_position
      ON order_bill_splits (order_id, position);

      CREATE TABLE IF NOT EXISTS order_payment_split_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id INTEGER NOT NULL,
        split_id INTEGER NOT NULL,
        amount REAL NOT NULL CHECK (amount > 0),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (payment_id) REFERENCES order_payments (id) ON DELETE RESTRICT,
        FOREIGN KEY (split_id) REFERENCES order_bill_splits (id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_order_payment_split_allocations_payment_id
      ON order_payment_split_allocations (payment_id);

      CREATE INDEX IF NOT EXISTS idx_order_payment_split_allocations_split_id
      ON order_payment_split_allocations (split_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_order_payment_split_allocations_payment_split
      ON order_payment_split_allocations (payment_id, split_id);
    `);
  },
};
