function runCreateVenueSettingsMigration(db, callback = () => {}) {
  db.run(
    `CREATE TABLE IF NOT EXISTS venue_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      restaurant_name TEXT NOT NULL,
      restaurant_subtitle TEXT NOT NULL DEFAULT '',
      contact_label TEXT NOT NULL DEFAULT '',
      contact_url TEXT NOT NULL DEFAULT '',
      review_url TEXT NOT NULL DEFAULT '',
      feedback_url TEXT NOT NULL DEFAULT '',
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    callback
  );
}

module.exports = { runCreateVenueSettingsMigration };
