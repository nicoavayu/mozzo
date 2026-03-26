function createTablesError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function ensurePositiveInteger(value, fieldName) {
  const normalized = Number.parseInt(value, 10);

  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw createTablesError('INVALID_TABLE_ID', `${fieldName} must be a positive integer`, 400);
  }

  return normalized;
}

function normalizeTable(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    label: row.label || null,
    created_at: row.created_at
  };
}

async function listTables(database) {
  const rows = await database.all(
    `
      SELECT id, label, created_at
      FROM tables
      ORDER BY id ASC
    `
  );

  return rows.map(normalizeTable);
}

async function getTable(database, tableId) {
  const normalizedTableId = ensurePositiveInteger(tableId, 'table_id');
  const row = await database.get(
    `
      SELECT id, label, created_at
      FROM tables
      WHERE id = ?
    `,
    [normalizedTableId]
  );

  return normalizeTable(row);
}

async function createTable(database, payload) {
  const tableId = ensurePositiveInteger(payload?.table_id ?? payload?.id, 'table_id');
  const label = typeof payload?.label === 'string' ? payload.label.trim() : '';

  try {
    await database.run(
      `
        INSERT INTO tables (id, label)
        VALUES (?, ?)
      `,
      [tableId, label || null]
    );
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) {
      throw createTablesError('TABLE_ALREADY_EXISTS', 'Esa mesa ya existe.', 409);
    }

    throw error;
  }

  return getTable(database, tableId);
}

async function deleteTable(database, tableId) {
  const normalizedTableId = ensurePositiveInteger(tableId, 'table_id');
  const deleteResult = await database.run(
    `
      DELETE FROM tables
      WHERE id = ?
    `,
    [normalizedTableId]
  );

  if (deleteResult.changes === 0) {
    throw createTablesError('TABLE_NOT_FOUND', 'Esa mesa no existe.', 404);
  }

  return { id: normalizedTableId };
}

module.exports = {
  listTables,
  getTable,
  createTable,
  deleteTable
};
