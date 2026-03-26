const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { runCreateVenueSettingsMigration } = require('./migrations/001_create_venue_settings');

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to SQLite database.');
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS menu_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL
    )`);

      db.run(`CREATE TABLE IF NOT EXISTS menu_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER,
        name TEXT NOT NULL,
        description TEXT,
        price REAL NOT NULL,
        FOREIGN KEY (category_id) REFERENCES menu_categories (id)
    )`);

      db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_id INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

      db.run(`CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        item_id INTEGER,
        quantity INTEGER NOT NULL,
        comments TEXT,
        FOREIGN KEY (order_id) REFERENCES orders (id),
        FOREIGN KEY (item_id) REFERENCES menu_items (id)
    )`);

      runCreateVenueSettingsMigration(db, () => {
        seedDB();
      });
    });
  }
});

function seedDB() {
    db.get("SELECT count(*) as count FROM menu_categories", (err, row) => {
        if (!err && row.count === 0) {
            db.run("INSERT INTO menu_categories (name) VALUES ('Entradas'), ('Platos Principales'), ('Bebidas'), ('Postres')");
            console.log("Categories seeded");
            
            setTimeout(() => {
                db.run("INSERT INTO menu_items (category_id, name, description, price) VALUES (1, 'Nachos con Queso', 'Tortillas crujientes bañadas en queso fundido y jalapeños.', 8.50)");
                db.run("INSERT INTO menu_items (category_id, name, description, price) VALUES (2, 'Hamburguesa Mozzo', 'Doble carne, bacon, queso cheddar y salsa especial.', 14.00)");
                db.run("INSERT INTO menu_items (category_id, name, description, price) VALUES (2, 'Pizza Margarita', 'Salsa de tomate, mozzarella fresca y albahaca.', 12.00)");
                db.run("INSERT INTO menu_items (category_id, name, description, price) VALUES (3, 'Limonada de Menta', 'Refrescante limonada natural con hojas de menta.', 4.50)");
                db.run("INSERT INTO menu_items (category_id, name, description, price) VALUES (4, 'Brownie con Helado', 'Brownie caliente de chocolate con helado de vainilla.', 6.50)");
                console.log("Menu items seeded");
            }, 500);
        }
    });
}

module.exports = db;
