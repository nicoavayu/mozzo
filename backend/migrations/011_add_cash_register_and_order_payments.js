module.exports = {
  id: '011_add_cash_register_and_order_payments',
  async up(context) {
    await context.exec(`
      CREATE TABLE IF NOT EXISTS cash_register_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
        opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME,
        opening_float REAL NOT NULL DEFAULT 0,
        expected_cash_amount REAL,
        counted_cash_amount REAL,
        cash_difference REAL,
        notes_open TEXT,
        notes_close TEXT,
        opened_by TEXT,
        closed_by TEXT,
        venue_id INTEGER
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_register_single_open
      ON cash_register_sessions (status)
      WHERE status = 'open';

      CREATE INDEX IF NOT EXISTS idx_cash_register_sessions_status
      ON cash_register_sessions (status);

      CREATE INDEX IF NOT EXISTS idx_cash_register_sessions_opened_at
      ON cash_register_sessions (opened_at DESC);

      CREATE TABLE IF NOT EXISTS order_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        cash_register_session_id INTEGER,
        amount REAL NOT NULL CHECK (amount > 0),
        method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'transfer', 'other')),
        note TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by TEXT,
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
        FOREIGN KEY (cash_register_session_id) REFERENCES cash_register_sessions (id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_order_payments_order_id
      ON order_payments (order_id);

      CREATE INDEX IF NOT EXISTS idx_order_payments_cash_register_session_id
      ON order_payments (cash_register_session_id);

      CREATE INDEX IF NOT EXISTS idx_order_payments_created_at
      ON order_payments (created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_orders_closed_at
      ON orders (closed_at DESC);
    `);
  }
};
