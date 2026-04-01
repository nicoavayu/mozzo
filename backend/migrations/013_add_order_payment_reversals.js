module.exports = {
  id: '013_add_order_payment_reversals',
  async up(context) {
    await context.exec(`
      CREATE TABLE IF NOT EXISTS order_payment_reversals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_payment_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL,
        cash_register_session_id INTEGER,
        amount REAL NOT NULL CHECK (amount > 0),
        reason TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by TEXT,
        FOREIGN KEY (order_payment_id) REFERENCES order_payments (id) ON DELETE RESTRICT,
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
        FOREIGN KEY (cash_register_session_id) REFERENCES cash_register_sessions (id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_order_payment_reversals_payment_id
      ON order_payment_reversals (order_payment_id);

      CREATE INDEX IF NOT EXISTS idx_order_payment_reversals_order_id
      ON order_payment_reversals (order_id);

      CREATE INDEX IF NOT EXISTS idx_order_payment_reversals_cash_register_session_id
      ON order_payment_reversals (cash_register_session_id);

      CREATE INDEX IF NOT EXISTS idx_order_payment_reversals_created_at
      ON order_payment_reversals (created_at DESC);
    `);
  }
};
