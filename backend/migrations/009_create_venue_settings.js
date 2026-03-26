module.exports = {
  id: '009_create_venue_settings',
  async up(context) {
    await context.exec(`
      CREATE TABLE IF NOT EXISTS venue_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        restaurant_name TEXT NOT NULL,
        restaurant_subtitle TEXT NOT NULL DEFAULT '',
        contact_label TEXT NOT NULL DEFAULT '',
        contact_url TEXT NOT NULL DEFAULT '',
        review_url TEXT NOT NULL DEFAULT '',
        feedback_url TEXT NOT NULL DEFAULT '',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
};
