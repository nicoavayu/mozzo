module.exports = {
  id: '004_create_table_requests',
  async up(context) {
    await context.exec(`
      CREATE TABLE IF NOT EXISTS table_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_id INTEGER NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('call_waiter', 'request_bill')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME
      );

      CREATE INDEX IF NOT EXISTS idx_table_requests_status_created
      ON table_requests (status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_table_requests_table_status_created
      ON table_requests (table_id, status, created_at DESC);
    `);
  }
};
