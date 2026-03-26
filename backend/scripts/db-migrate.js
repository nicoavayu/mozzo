const database = require('../database');

async function main() {
  await database.initializeDatabase();
  console.log(`Database migrated at ${database.dbPath}`);
}

main()
  .catch((error) => {
    console.error('Migration failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await database.close().catch(() => {});
  });
