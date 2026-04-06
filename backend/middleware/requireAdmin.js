const database = require('../database');
const { extractBearerToken } = require('../lib/auth');
const { assertPermission, resolveAdminActor } = require('../lib/staff');

async function requireAdmin(req, res, next) {
  const token = extractBearerToken(req.headers.authorization);

  if (!token) {
    return res.status(401).json({ error: 'Admin token required' });
  }

  try {
    req.admin = await resolveAdminActor(database, token);
    req.adminToken = token;
    return next();
  } catch (error) {
    if (error.code === 'ADMIN_AUTH_NOT_CONFIGURED') {
      return res.status(500).json({ error: error.message });
    }

    if (error.code === 'MISSING_ADMIN_TOKEN') {
      return res.status(401).json({ error: error.message });
    }

    return res.status(403).json({ error: 'Invalid admin token' });
  }
}

function requireOwner(req, res, next) {
  return requireAdmin(req, res, () => {
    if (req.admin?.role !== 'owner') {
      return res.status(403).json({ error: 'No tenés permiso para hacer eso.' });
    }

    return next();
  });
}

function requirePermission(permission) {
  return (req, res, next) => requireAdmin(req, res, () => {
    try {
      assertPermission(req.admin, permission);
      return next();
    } catch (error) {
      return res.status(error.status || 403).json({ error: error.message });
    }
  });
}

module.exports = {
  requireAdmin,
  requireOwner,
  requirePermission,
};
