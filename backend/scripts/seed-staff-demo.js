const database = require('../database');
const { upsertStaffUser } = require('../lib/staff');

const DEMO_STAFF_USERS = [
  {
    name: 'Manager Demo',
    role: 'manager',
    login_code: 'MGR1',
    pin: '1111',
  },
  {
    name: 'Cashier Demo',
    role: 'cashier',
    login_code: 'CAJA1',
    pin: '2222',
  },
  {
    name: 'Server Demo',
    role: 'server',
    login_code: 'MOZO1',
    pin: '3333',
  },
  {
    name: 'Kitchen Demo',
    role: 'kitchen',
    login_code: 'COC1',
    pin: '4444',
  },
];

async function main() {
  await database.initializeDatabase();

  const results = await database.withTransaction(async () => {
    const seeded = [];

    for (const definition of DEMO_STAFF_USERS) {
      seeded.push(await upsertStaffUser(database, definition));
    }

    return seeded;
  });

  console.log('Demo staff ready:');
  for (const result of results) {
    console.log(
      `- ${result.staff_user.name} (${result.staff_user.role}) — login_code: ${result.staff_user.login_code} — pin: ${
        DEMO_STAFF_USERS.find((entry) => entry.login_code === result.staff_user.login_code)?.pin
      } — ${result.action}`
    );
  }
  console.log(`Database updated at ${database.dbPath}`);
}

main()
  .catch((error) => {
    console.error('Demo staff seed failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await database.close().catch(() => {});
  });
