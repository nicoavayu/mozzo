const ACTIVE_REQUEST_STATUSES = ['pending'];
const VALID_REQUEST_STATUSES = new Set([...ACTIVE_REQUEST_STATUSES, 'resolved']);
const VALID_REQUEST_TYPES = new Set(['call_waiter', 'request_bill']);
const TABLE_REQUEST_SELECT_FIELDS = `
  tr.id,
  tr.table_id,
  tr.type,
  tr.status,
  tr.created_at,
  tr.resolved_at,
  o.bill_attended_at,
  o.bill_payment_method_preference,
  o.bill_collection_status
`;

function createTableRequestError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function ensurePositiveInteger(value, fieldName) {
  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw createTableRequestError('INVALID_TABLE_REQUEST', `${fieldName} must be a positive integer`);
  }

  return parsedValue;
}

function normalizeRequestType(type) {
  const normalized = String(type || '').trim();

  if (!VALID_REQUEST_TYPES.has(normalized)) {
    throw createTableRequestError('INVALID_TABLE_REQUEST_TYPE', 'type is invalid');
  }

  return normalized;
}

function mapTableRequest(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    table_id: row.table_id,
    type: row.type,
    status: row.status,
    created_at: row.created_at,
    resolved_at: row.resolved_at || null,
    bill_attended_at: row.bill_attended_at || null,
    bill_payment_method_preference: row.bill_payment_method_preference || null,
    bill_collection_status: row.bill_collection_status || null,
  };
}

function buildTableRequestOrderJoin() {
  return `
    LEFT JOIN orders o ON o.id = (
      SELECT o2.id
      FROM orders o2
      WHERE o2.table_id = tr.table_id
        AND o2.closed_at IS NULL
      ORDER BY o2.created_at DESC, o2.id DESC
      LIMIT 1
    )
  `;
}

async function getTableRequestById(database, requestId) {
  const normalizedRequestId = ensurePositiveInteger(requestId, 'request_id');
  const row = await database.get(
    `
      SELECT ${TABLE_REQUEST_SELECT_FIELDS}
      FROM table_requests tr
      ${buildTableRequestOrderJoin()}
      WHERE tr.id = ?
    `,
    [normalizedRequestId]
  );

  return mapTableRequest(row);
}

async function listTableRequests(database) {
  const rows = await database.all(
    `
      SELECT ${TABLE_REQUEST_SELECT_FIELDS}
      FROM table_requests tr
      ${buildTableRequestOrderJoin()}
      ORDER BY
        CASE tr.status WHEN 'pending' THEN 0 ELSE 1 END,
        tr.created_at DESC,
        tr.id DESC
    `
  );

  return rows.map(mapTableRequest);
}

async function listActiveTableRequestsForTable(database, tableId) {
  const normalizedTableId = ensurePositiveInteger(tableId, 'table_id');
  const rows = await database.all(
    `
      SELECT ${TABLE_REQUEST_SELECT_FIELDS}
      FROM table_requests tr
      ${buildTableRequestOrderJoin()}
      WHERE tr.table_id = ?
        AND tr.status IN (${ACTIVE_REQUEST_STATUSES.map(() => '?').join(', ')})
      ORDER BY tr.created_at DESC, tr.id DESC
    `,
    [normalizedTableId, ...ACTIVE_REQUEST_STATUSES]
  );

  return rows.map(mapTableRequest);
}

async function createTableRequest(database, payload) {
  const tableId = ensurePositiveInteger(payload?.table_id, 'table_id');
  const type = normalizeRequestType(payload?.type);

  const existingRequest = await database.get(
    `
      SELECT id, table_id, type, status, created_at, resolved_at
      FROM table_requests
      WHERE table_id = ?
        AND type = ?
        AND status = 'pending'
      ORDER BY id DESC
      LIMIT 1
    `,
    [tableId, type]
  );

  if (existingRequest) {
    return {
      ...(await getTableRequestById(database, existingRequest.id)),
      already_pending: true,
    };
  }

  const insertResult = await database.run(
    `
      INSERT INTO table_requests (table_id, type, status)
      VALUES (?, ?, 'pending')
    `,
    [tableId, type]
  );

  return {
    ...(await getTableRequestById(database, insertResult.lastID)),
    already_pending: false,
  };
}

async function cancelTableRequestForTable(database, payload) {
  const tableId = ensurePositiveInteger(payload?.table_id, 'table_id');
  const type = normalizeRequestType(payload?.type);

  const pendingRequest = await database.get(
    `
      SELECT id, table_id, type, status, created_at, resolved_at
      FROM table_requests
      WHERE table_id = ?
        AND type = ?
        AND status = 'pending'
      ORDER BY id DESC
      LIMIT 1
    `,
    [tableId, type]
  );

  if (!pendingRequest) {
    throw createTableRequestError('TABLE_REQUEST_NOT_FOUND', 'No pending table request found', 404);
  }

  await database.run(
    `
      UPDATE table_requests
      SET status = 'resolved',
          resolved_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    [pendingRequest.id]
  );

  return getTableRequestById(database, pendingRequest.id);
}

async function resolveTableRequest(database, requestId) {
  const normalizedRequestId = ensurePositiveInteger(requestId, 'request_id');
  const currentRequest = await getTableRequestById(database, normalizedRequestId);

  if (!currentRequest) {
    throw createTableRequestError('TABLE_REQUEST_NOT_FOUND', 'Table request not found', 404);
  }

  if (!VALID_REQUEST_STATUSES.has(currentRequest.status)) {
    throw createTableRequestError('INVALID_TABLE_REQUEST_STATUS', 'status is invalid');
  }

  if (currentRequest.status === 'resolved') {
    return currentRequest;
  }

  await database.run(
    `
      UPDATE table_requests
      SET status = 'resolved',
          resolved_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    [normalizedRequestId]
  );

  return getTableRequestById(database, normalizedRequestId);
}

async function resolvePendingTableRequestsForTable(database, tableId) {
  const normalizedTableId = ensurePositiveInteger(tableId, 'table_id');
  const pendingRows = await database.all(
    `
      SELECT id
      FROM table_requests
      WHERE table_id = ?
        AND status = 'pending'
      ORDER BY created_at DESC, id DESC
    `,
    [normalizedTableId]
  );

  const resolvedRequests = [];

  for (const row of pendingRows) {
    await database.run(
      `
        UPDATE table_requests
        SET status = 'resolved',
            resolved_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [row.id]
    );
    resolvedRequests.push(await getTableRequestById(database, row.id));
  }

  return resolvedRequests;
}

async function resolvePendingTableRequestsForTableByType(database, tableId, type) {
  const normalizedTableId = ensurePositiveInteger(tableId, 'table_id');
  const normalizedType = normalizeRequestType(type);
  const pendingRows = await database.all(
    `
      SELECT id
      FROM table_requests
      WHERE table_id = ?
        AND type = ?
        AND status = 'pending'
      ORDER BY created_at DESC, id DESC
    `,
    [normalizedTableId, normalizedType]
  );

  const resolvedRequests = [];

  for (const row of pendingRows) {
    await database.run(
      `
        UPDATE table_requests
        SET status = 'resolved',
            resolved_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [row.id]
    );
    resolvedRequests.push(await getTableRequestById(database, row.id));
  }

  return resolvedRequests;
}

module.exports = {
  ACTIVE_REQUEST_STATUSES,
  VALID_REQUEST_TYPES,
  createTableRequest,
  createTableRequestError,
  getTableRequestById,
  listActiveTableRequestsForTable,
  listTableRequests,
  cancelTableRequestForTable,
  resolvePendingTableRequestsForTable,
  resolvePendingTableRequestsForTableByType,
  resolveTableRequest,
};
