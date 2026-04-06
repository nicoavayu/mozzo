module.exports = {
  id: '018_add_staff_users_and_sessions',
  async up(context) {
    await context.exec(`
      CREATE TABLE IF NOT EXISTS staff_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        login_code TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'cashier', 'server', 'kitchen')),
        pin_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_users_login_code
      ON staff_users (login_code);

      CREATE INDEX IF NOT EXISTS idx_staff_users_role_status
      ON staff_users (role, status);

      CREATE INDEX IF NOT EXISTS idx_staff_users_status
      ON staff_users (status);

      CREATE TABLE IF NOT EXISTS staff_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        staff_user_id INTEGER NOT NULL,
        token TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (staff_user_id) REFERENCES staff_users (id) ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_sessions_token
      ON staff_sessions (token);

      CREATE INDEX IF NOT EXISTS idx_staff_sessions_staff_user_id
      ON staff_sessions (staff_user_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_staff_sessions_expires_at
      ON staff_sessions (expires_at);
    `);

    const orderColumns = await context.all(`PRAGMA table_info(orders)`);
    if (!orderColumns.some((column) => column.name === 'closed_by')) {
      await context.exec(`ALTER TABLE orders ADD COLUMN closed_by TEXT;`);
    }

    const suborderColumns = await context.all(`PRAGMA table_info(order_suborders)`);
    if (!suborderColumns.some((column) => column.name === 'cancelled_by')) {
      await context.exec(`ALTER TABLE order_suborders ADD COLUMN cancelled_by TEXT;`);
    }
  },
};
