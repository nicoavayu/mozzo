const crypto = require('crypto');
const { verifyAdminToken } = require('./auth');

const STAFF_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const STAFF_ROLES = new Set(['owner', 'manager', 'cashier', 'server', 'kitchen']);
const STAFF_STATUSES = new Set(['active', 'inactive']);
const OWNER_PERMISSIONS = ['*'];
const STAFF_PERMISSIONS_BY_ROLE = {
  owner: OWNER_PERMISSIONS,
  manager: [
    'cash.view',
    'cash.open',
    'cash.close',
    'payments.create',
    'payments.reverse',
    'orders.close',
    'bill_splits.manage',
    'menu.manage',
    'requests.resolve_call_waiter',
    'requests.resolve_bill',
    'suborders.process',
    'suborders.ready',
    'suborders.deliver',
    'suborders.cancel',
  ],
  cashier: [
    'cash.view',
    'cash.open',
    'cash.close',
    'payments.create',
    'payments.reverse',
    'orders.close',
    'bill_splits.manage',
    'requests.resolve_bill',
  ],
  server: [
    'requests.resolve_call_waiter',
    'suborders.deliver',
  ],
  kitchen: [
    'suborders.process',
    'suborders.ready',
  ],
};

function createStaffError(code, message, status = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function normalizeStaffName(value) {
  if (typeof value !== 'string') {
    throw createStaffError('INVALID_STAFF_NAME', 'El nombre del staff es obligatorio.', 400);
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    throw createStaffError('INVALID_STAFF_NAME', 'El nombre del staff es obligatorio.', 400);
  }

  if (normalizedValue.length > 80) {
    throw createStaffError('INVALID_STAFF_NAME', 'El nombre del staff no puede superar los 80 caracteres.', 400);
  }

  return normalizedValue;
}

function normalizeStaffLoginCode(value) {
  if (typeof value !== 'string') {
    throw createStaffError('INVALID_STAFF_LOGIN_CODE', 'El código de acceso es obligatorio.', 400);
  }

  const normalizedValue = value.trim().toUpperCase();

  if (!normalizedValue) {
    throw createStaffError('INVALID_STAFF_LOGIN_CODE', 'El código de acceso es obligatorio.', 400);
  }

  if (!/^[A-Z0-9_-]{3,20}$/.test(normalizedValue)) {
    throw createStaffError(
      'INVALID_STAFF_LOGIN_CODE',
      'El código de acceso debe tener entre 3 y 20 caracteres y solo puede usar letras, números, guion o guion bajo.',
      400
    );
  }

  return normalizedValue;
}

function normalizeStaffRole(value, { allowOwner = false } = {}) {
  const normalizedValue = String(value || '').trim().toLowerCase();

  if (!STAFF_ROLES.has(normalizedValue)) {
    throw createStaffError('INVALID_STAFF_ROLE', 'El rol del staff es inválido.', 400);
  }

  if (!allowOwner && normalizedValue === 'owner') {
    throw createStaffError('INVALID_STAFF_ROLE', 'El rol owner queda reservado para el acceso bootstrap.', 400);
  }

  return normalizedValue;
}

function normalizeStaffPin(value) {
  const normalizedValue = String(value || '').trim();

  if (!/^\d{4,8}$/.test(normalizedValue)) {
    throw createStaffError('INVALID_STAFF_PIN', 'El PIN debe tener entre 4 y 8 dígitos.', 400);
  }

  return normalizedValue;
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function hashStaffPin(pin) {
  const normalizedPin = normalizeStaffPin(pin);
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(normalizedPin, salt, 64).toString('hex');
  return `scrypt:${salt}:${derivedKey}`;
}

function verifyStaffPin(pin, pinHash) {
  const normalizedPin = normalizeStaffPin(pin);
  const normalizedHash = String(pinHash || '');
  const [scheme, salt, storedHash] = normalizedHash.split(':');

  if (scheme !== 'scrypt' || !salt || !storedHash) {
    throw createStaffError('INVALID_STAFF_PIN_HASH', 'El hash del PIN es inválido.', 500);
  }

  const derivedKey = crypto.scryptSync(normalizedPin, salt, 64).toString('hex');
  const derivedBuffer = Buffer.from(derivedKey, 'hex');
  const storedBuffer = Buffer.from(storedHash, 'hex');

  return derivedBuffer.length === storedBuffer.length && crypto.timingSafeEqual(derivedBuffer, storedBuffer);
}

function buildRolePermissions(role) {
  if (role === 'owner') {
    return [...OWNER_PERMISSIONS];
  }

  return [...(STAFF_PERMISSIONS_BY_ROLE[role] || [])];
}

function hasPermission(actor, permission) {
  if (!actor) {
    return false;
  }

  if (actor.role === 'owner') {
    return true;
  }

  const permissions = Array.isArray(actor.permissions) ? actor.permissions : buildRolePermissions(actor.role);
  return permissions.includes(permission);
}

function assertPermission(actor, permission) {
  if (!hasPermission(actor, permission)) {
    throw createStaffError('FORBIDDEN', 'No tenés permiso para hacer eso.', 403, { permission });
  }
}

function formatAuditActor(actor) {
  if (!actor) {
    return null;
  }

  if (actor.auth_type === 'owner') {
    return 'Owner';
  }

  const staffUserId = Number(actor.staff_user_id);
  const role = String(actor.role || '').trim() || 'staff';
  const name = normalizeStaffName(actor.name || 'Staff');
  return `staff#${staffUserId}:${name}:${role}`;
}

function mapStaffUserRow(row) {
  if (!row) {
    return null;
  }

  const status = STAFF_STATUSES.has(row.status) ? row.status : 'inactive';
  const role = STAFF_ROLES.has(row.role) ? row.role : 'server';

  return {
    id: row.id,
    name: row.name,
    login_code: row.login_code,
    role,
    status,
    created_at: row.created_at,
  };
}

function mapStaffActor(row, { authType = 'staff', tokenExpiresAt = null } = {}) {
  if (!row) {
    return null;
  }

  const normalizedUser = mapStaffUserRow(row);

  return {
    auth_type: authType,
    staff_user_id: normalizedUser?.id || null,
    name: normalizedUser?.name || 'Owner',
    login_code: normalizedUser?.login_code || null,
    role: normalizedUser?.role || 'owner',
    permissions: buildRolePermissions(normalizedUser?.role || 'owner'),
    expires_at: tokenExpiresAt,
  };
}

async function listStaffUsers(database) {
  const rows = await database.all(
    `
      SELECT id, name, login_code, role, status, created_at
      FROM staff_users
      ORDER BY created_at DESC, id DESC
    `
  );

  return rows.map(mapStaffUserRow);
}

async function createStaffUser(database, payload = {}) {
  const name = normalizeStaffName(payload?.name);
  const loginCode = normalizeStaffLoginCode(payload?.login_code);
  const role = normalizeStaffRole(payload?.role);
  const pinHash = hashStaffPin(payload?.pin);

  try {
    const result = await database.run(
      `
        INSERT INTO staff_users (name, login_code, role, pin_hash, status)
        VALUES (?, ?, ?, ?, 'active')
      `,
      [name, loginCode, role, pinHash]
    );

    const row = await database.get(
      `
        SELECT id, name, login_code, role, status, created_at
        FROM staff_users
        WHERE id = ?
      `,
      [result.lastID]
    );

    return mapStaffUserRow(row);
  } catch (error) {
    if (error?.code === 'SQLITE_CONSTRAINT') {
      throw createStaffError('STAFF_LOGIN_CODE_TAKEN', 'Ese código de acceso ya está en uso.', 409);
    }

    throw error;
  }
}

async function upsertStaffUser(database, payload = {}, { allowOwner = false } = {}) {
  const name = normalizeStaffName(payload?.name);
  const loginCode = normalizeStaffLoginCode(payload?.login_code);
  const role = normalizeStaffRole(payload?.role, { allowOwner });
  const pinHash = hashStaffPin(payload?.pin);
  const existingRow = await database.get(
    `
      SELECT id
      FROM staff_users
      WHERE login_code = ?
      LIMIT 1
    `,
    [loginCode]
  );

  if (existingRow?.id) {
    await database.run(
      `
        UPDATE staff_users
        SET
          name = ?,
          role = ?,
          pin_hash = ?,
          status = 'active'
        WHERE id = ?
      `,
      [name, role, pinHash, existingRow.id]
    );

    const row = await database.get(
      `
        SELECT id, name, login_code, role, status, created_at
        FROM staff_users
        WHERE id = ?
      `,
      [existingRow.id]
    );

    return {
      action: 'updated',
      staff_user: mapStaffUserRow(row),
    };
  }

  const createdStaffUser = await createStaffUser(database, {
    name,
    login_code: loginCode,
    role,
    pin: payload?.pin,
  });

  return {
    action: 'created',
    staff_user: createdStaffUser,
  };
}

async function getStaffSessionByToken(database, token, { allowExpired = false } = {}) {
  const normalizedToken = String(token || '').trim();

  if (!normalizedToken) {
    return null;
  }

  const row = await database.get(
    `
      SELECT
        ss.id,
        ss.staff_user_id,
        ss.token,
        ss.expires_at,
        ss.created_at,
        su.name,
        su.login_code,
        su.role,
        su.status
      FROM staff_sessions ss
      INNER JOIN staff_users su ON su.id = ss.staff_user_id
      WHERE ss.token = ?
      LIMIT 1
    `,
    [hashSessionToken(normalizedToken)]
  );

  if (!row) {
    return null;
  }

  const expiresAtMs = Date.parse(row.expires_at || '');
  if (!allowExpired && (!Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs || row.status !== 'active')) {
    await database.run(`DELETE FROM staff_sessions WHERE id = ?`, [row.id]);
    return null;
  }

  return {
    id: row.id,
    token_expires_at: row.expires_at,
    created_at: row.created_at,
    actor: mapStaffActor(row, {
      authType: 'staff',
      tokenExpiresAt: row.expires_at,
    }),
  };
}

async function deleteStaffSessionByToken(database, token) {
  const normalizedToken = String(token || '').trim();

  if (!normalizedToken) {
    return { deleted: false };
  }

  const result = await database.run(
    `DELETE FROM staff_sessions WHERE token = ?`,
    [hashSessionToken(normalizedToken)]
  );

  return {
    deleted: result.changes > 0,
  };
}

async function createStaffSession(database, payload = {}) {
  const loginCode = normalizeStaffLoginCode(payload?.login_code);
  const pin = normalizeStaffPin(payload?.pin);
  const row = await database.get(
    `
      SELECT id, name, login_code, role, pin_hash, status, created_at
      FROM staff_users
      WHERE login_code = ?
      LIMIT 1
    `,
    [loginCode]
  );

  if (!row || row.status !== 'active') {
    throw createStaffError('INVALID_STAFF_CREDENTIALS', 'Código o PIN inválido.', 401);
  }

  if (!verifyStaffPin(pin, row.pin_hash)) {
    throw createStaffError('INVALID_STAFF_CREDENTIALS', 'Código o PIN inválido.', 401);
  }

  const token = `staff_${crypto.randomBytes(24).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + STAFF_SESSION_TTL_MS).toISOString();

  await database.run(
    `
      INSERT INTO staff_sessions (staff_user_id, token, expires_at)
      VALUES (?, ?, ?)
    `,
    [row.id, hashSessionToken(token), expiresAt]
  );

  return {
    token,
    expires_at: expiresAt,
    actor: mapStaffActor(row, {
      authType: 'staff',
      tokenExpiresAt: expiresAt,
    }),
  };
}

async function resolveAdminActor(database, token) {
  const normalizedToken = String(token || '').trim();

  if (!normalizedToken) {
    throw createStaffError('MISSING_ADMIN_TOKEN', 'Admin token required', 401);
  }

  try {
    const ownerPayload = verifyAdminToken(normalizedToken);
    return {
      auth_type: 'owner',
      staff_user_id: null,
      name: 'Owner',
      login_code: null,
      role: 'owner',
      permissions: OWNER_PERMISSIONS,
      expires_at: new Date(ownerPayload.exp).toISOString(),
    };
  } catch (error) {
    if (error?.code === 'ADMIN_AUTH_NOT_CONFIGURED') {
      throw error;
    }
  }

  const staffSession = await getStaffSessionByToken(database, normalizedToken);

  if (!staffSession?.actor) {
    throw createStaffError('INVALID_ADMIN_TOKEN', 'Invalid admin token', 403);
  }

  return staffSession.actor;
}

async function getCurrentAdminSession(database, token) {
  const actor = await resolveAdminActor(database, token);

  return {
    authenticated: true,
    actor: {
      auth_type: actor.auth_type,
      staff_user_id: actor.staff_user_id,
      name: actor.name,
      login_code: actor.login_code,
      role: actor.role,
      permissions: actor.permissions,
    },
    expires_at: actor.expires_at,
  };
}

module.exports = {
  STAFF_SESSION_TTL_MS,
  assertPermission,
  buildRolePermissions,
  createStaffError,
  createStaffSession,
  createStaffUser,
  deleteStaffSessionByToken,
  formatAuditActor,
  getCurrentAdminSession,
  getStaffSessionByToken,
  hasPermission,
  listStaffUsers,
  normalizeStaffLoginCode,
  normalizeStaffPin,
  normalizeStaffRole,
  resolveAdminActor,
  upsertStaffUser,
};
