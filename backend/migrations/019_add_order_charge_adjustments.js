module.exports = {
  id: '019_add_order_charge_adjustments',
  async up(context) {
    await context.exec(`
      CREATE TABLE IF NOT EXISTS order_charge_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        suborder_id INTEGER NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('suborder_cancellation')),
        amount_delta REAL NOT NULL,
        reason TEXT,
        created_by TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
        FOREIGN KEY (suborder_id) REFERENCES order_suborders (id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_order_charge_adjustments_order_id
      ON order_charge_adjustments (order_id, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_order_charge_adjustments_suborder_id
      ON order_charge_adjustments (suborder_id, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_order_charge_adjustments_type
      ON order_charge_adjustments (type, created_at ASC);
    `);
  },
};
