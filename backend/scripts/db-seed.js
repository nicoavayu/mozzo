const database = require('../database');
const { publishMenuVersion } = require('../lib/menu-store');

const seedCategories = [
  {
    name: 'Entradas',
    items: [
      {
        name: 'Tequeños de Queso',
        description: 'Palitos de queso envueltos en masa frita.',
        price: 5.5
      },
      {
        name: 'Sopa del Día',
        description: 'Pregunte a su mesero por la especialidad.',
        price: 4
      }
    ]
  },
  {
    name: 'Platos Principales',
    items: [
      {
        name: 'Lomo Saltado',
        description: 'Trozos de carne con cebolla, tomate y papas fritas.',
        price: 15
      },
      {
        name: 'Arroz con Mariscos',
        description: 'Mixtura de mariscos frescos.',
        price: 18.5
      }
    ]
  },
  {
    name: 'Postres',
    items: [
      {
        name: 'Tiramisu',
        description: 'Tradicional postre italiano con cafe.',
        price: 6
      }
    ]
  },
  {
    name: 'Bebidas',
    items: [
      {
        name: 'Chicha Morada',
        description: 'Bebida refrescante de maiz.',
        price: 3
      }
    ]
  }
];

async function main() {
  await database.initializeDatabase();

  const existingMenus = await database.get('SELECT COUNT(*) AS count FROM menus');

  if (existingMenus.count > 0) {
    console.log('Seed skipped: menu data already exists.');
    return;
  }

  await publishMenuVersion(database, seedCategories, 'Seed Menu');
  console.log(`Database seeded at ${database.dbPath}`);
}

main()
  .catch((error) => {
    console.error('Seed failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await database.close().catch(() => {});
  });
