module.exports = {
  id: '005_create_tables',
  async up(context) {
    await context.exec(`
      CREATE TABLE IF NOT EXISTS tables (
        id INTEGER PRIMARY KEY,
        label TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT OR IGNORE INTO tables (id)
      SELECT DISTINCT table_id
      FROM orders
      WHERE table_id IS NOT NULL;

      INSERT OR IGNORE INTO tables (id)
      SELECT DISTINCT table_id
      FROM table_requests
      WHERE table_id IS NOT NULL;
    `);
  }
};
