module.exports = {
  id: '014_harden_mercado_pago_checkout_states',
  async up(context) {
    await context.exec(`
      ALTER TABLE mercado_pago_checkouts RENAME TO mercado_pago_checkouts_pre_state_hardening;

      CREATE TABLE mercado_pago_checkouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        amount REAL NOT NULL CHECK (amount > 0),
        currency_id TEXT NOT NULL DEFAULT 'ARS',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'failed', 'refunded', 'charged_back', 'reversed')),
        sync_disposition TEXT NOT NULL DEFAULT 'pending' CHECK (sync_disposition IN ('pending', 'applied', 'ignored', 'stale', 'mismatched')),
        external_reference TEXT NOT NULL UNIQUE,
        preference_id TEXT UNIQUE,
        checkout_url TEXT,
        sandbox_checkout_url TEXT,
        payment_id TEXT UNIQUE,
        payment_status TEXT,
        payment_status_detail TEXT,
        payer_email TEXT,
        order_payment_id INTEGER,
        status_reason TEXT,
        expires_at DATETIME,
        approved_at DATETIME,
        last_checked_at DATETIME,
        last_event_source TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
        FOREIGN KEY (order_payment_id) REFERENCES order_payments (id) ON DELETE SET NULL
      );

      INSERT INTO mercado_pago_checkouts (
        id,
        order_id,
        amount,
        currency_id,
        status,
        sync_disposition,
        external_reference,
        preference_id,
        checkout_url,
        sandbox_checkout_url,
        payment_id,
        payment_status,
        payment_status_detail,
        payer_email,
        order_payment_id,
        status_reason,
        expires_at,
        approved_at,
        last_checked_at,
        last_event_source,
        created_at,
        updated_at
      )
      SELECT
        id,
        order_id,
        amount,
        currency_id,
        status,
        CASE
          WHEN status = 'approved' AND order_payment_id IS NOT NULL THEN 'applied'
          WHEN status = 'pending' THEN 'pending'
          ELSE 'ignored'
        END AS sync_disposition,
        external_reference,
        preference_id,
        checkout_url,
        sandbox_checkout_url,
        payment_id,
        payment_status,
        payment_status_detail,
        payer_email,
        order_payment_id,
        sync_error,
        expires_at,
        approved_at,
        last_checked_at,
        NULL,
        created_at,
        updated_at
      FROM mercado_pago_checkouts_pre_state_hardening;

      DROP TABLE mercado_pago_checkouts_pre_state_hardening;

      CREATE INDEX IF NOT EXISTS idx_mercado_pago_checkouts_order_id
      ON mercado_pago_checkouts (order_id);

      CREATE INDEX IF NOT EXISTS idx_mercado_pago_checkouts_status
      ON mercado_pago_checkouts (status);

      CREATE INDEX IF NOT EXISTS idx_mercado_pago_checkouts_order_status
      ON mercado_pago_checkouts (order_id, status);

      CREATE INDEX IF NOT EXISTS idx_mercado_pago_checkouts_payment_id
      ON mercado_pago_checkouts (payment_id);

      CREATE INDEX IF NOT EXISTS idx_mercado_pago_checkouts_sync_disposition
      ON mercado_pago_checkouts (sync_disposition);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_mercado_pago_single_pending_per_order
      ON mercado_pago_checkouts (order_id)
      WHERE status = 'pending' AND sync_disposition = 'pending';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_mercado_pago_order_payment_unique
      ON mercado_pago_checkouts (order_payment_id)
      WHERE order_payment_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_mercado_pago_checkouts_created_at
      ON mercado_pago_checkouts (created_at DESC);
    `);
  }
};
