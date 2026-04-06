module.exports = {
  id: '020_add_cash_register_movements',
  async up(context) {
    await context.exec(`
      CREATE TABLE IF NOT EXISTS cash_register_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('opening_float', 'sale_cash', 'refund_cash', 'cash_in', 'cash_out', 'closing_adjustment')),
        direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        amount REAL NOT NULL CHECK (amount > 0),
        reason TEXT,
        created_by TEXT,
        order_payment_id INTEGER,
        order_payment_reversal_id INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES cash_register_sessions (id) ON DELETE RESTRICT,
        FOREIGN KEY (order_payment_id) REFERENCES order_payments (id) ON DELETE RESTRICT,
        FOREIGN KEY (order_payment_reversal_id) REFERENCES order_payment_reversals (id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_cash_register_movements_session_id
      ON cash_register_movements (session_id, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_cash_register_movements_type
      ON cash_register_movements (type, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_cash_register_movements_order_payment_id
      ON cash_register_movements (order_payment_id);

      CREATE INDEX IF NOT EXISTS idx_cash_register_movements_order_payment_reversal_id
      ON cash_register_movements (order_payment_reversal_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_register_movements_payment_unique
      ON cash_register_movements (order_payment_id)
      WHERE order_payment_id IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_register_movements_reversal_unique
      ON cash_register_movements (order_payment_reversal_id)
      WHERE order_payment_reversal_id IS NOT NULL;
    `);
  },
};
