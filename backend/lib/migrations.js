const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '..', 'migrations');

async function tableExists(context, tableName) {
  const row = await context.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName]
  );

  return Boolean(row);
}

async function columnExists(context, tableName, columnName) {
  const columns = await context.all(`PRAGMA table_info(${tableName})`);
  return columns.some((column) => column.name === columnName);
}

async function ensureMigrationsTable(context) {
  await context.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function loadMigrationFiles() {
  return fs
    .readdirSync(migrationsDir)
    .filter((fileName) => fileName.endsWith('.js'))
    .sort();
}

async function runMigrations(context) {
  await ensureMigrationsTable(context);

  for (const fileName of loadMigrationFiles()) {
    const migrationPath = path.join(migrationsDir, fileName);
    delete require.cache[require.resolve(migrationPath)];
    const migration = require(migrationPath);
    const migrationId = migration.id || path.basename(fileName, '.js');

    const alreadyApplied = await context.get(
      'SELECT id FROM schema_migrations WHERE id = ?',
      [migrationId]
    );

    if (alreadyApplied) {
      continue;
    }

    const migrationContext = {
      ...context,
      tableExists: (tableName) => tableExists(context, tableName),
      columnExists: (tableName, columnName) => columnExists(context, tableName, columnName)
    };

    await context.withTransaction(async () => {
      await migration.up(migrationContext);
      await context.run('INSERT INTO schema_migrations (id) VALUES (?)', [migrationId]);
    });

    console.log(`Applied migration ${migrationId}`);
  }
}

module.exports = {
  runMigrations
};
