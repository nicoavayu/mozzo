module.exports = {
  id: '012_add_mercado_pago_checkout_sessions',
  async up(context) {
    await context.exec(`
      ALTER TABLE order_payments RENAME TO order_payments_pre_mercado_pago;

      CREATE TABLE order_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        cash_register_session_id INTEGER,
        amount REAL NOT NULL CHECK (amount > 0),
        method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'transfer', 'other', 'mercado_pago')),
        note TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by TEXT,
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
        FOREIGN KEY (cash_register_session_id) REFERENCES cash_register_sessions (id) ON DELETE RESTRICT
      );

      INSERT INTO order_payments (
        id,
        order_id,
        cash_register_session_id,
        amount,
        method,
        note,
        created_at,
        created_by
      )
      SELECT
        id,
        order_id,
        cash_register_session_id,
        amount,
        method,
        note,
        created_at,
        created_by
      FROM order_payments_pre_mercado_pago;

      DROP TABLE order_payments_pre_mercado_pago;

      CREATE INDEX IF NOT EXISTS idx_order_payments_order_id
      ON order_payments (order_id);

      CREATE INDEX IF NOT EXISTS idx_order_payments_cash_register_session_id
      ON order_payments (cash_register_session_id);

      CREATE INDEX IF NOT EXISTS idx_order_payments_created_at
      ON order_payments (created_at DESC);

      CREATE TABLE IF NOT EXISTS mercado_pago_checkouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        amount REAL NOT NULL CHECK (amount > 0),
        currency_id TEXT NOT NULL DEFAULT 'ARS',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'failed')),
        external_reference TEXT NOT NULL UNIQUE,
        preference_id TEXT UNIQUE,
        checkout_url TEXT,
        sandbox_checkout_url TEXT,
        payment_id TEXT UNIQUE,
        payment_status TEXT,
        payment_status_detail TEXT,
        payer_email TEXT,
        order_payment_id INTEGER,
        sync_error TEXT,
        expires_at DATETIME,
        approved_at DATETIME,
        last_checked_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
        FOREIGN KEY (order_payment_id) REFERENCES order_payments (id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mercado_pago_checkouts_order_id
      ON mercado_pago_checkouts (order_id);

      CREATE INDEX IF NOT EXISTS idx_mercado_pago_checkouts_status
      ON mercado_pago_checkouts (status);

      CREATE INDEX IF NOT EXISTS idx_mercado_pago_checkouts_order_status
      ON mercado_pago_checkouts (order_id, status);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_mercado_pago_single_pending_per_order
      ON mercado_pago_checkouts (order_id, status)
      WHERE status = 'pending';

      CREATE INDEX IF NOT EXISTS idx_mercado_pago_checkouts_created_at
      ON mercado_pago_checkouts (created_at DESC);
    `);
  }
};
