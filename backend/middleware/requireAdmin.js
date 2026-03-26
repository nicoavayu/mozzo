const { extractBearerToken, verifyAdminToken } = require('../lib/auth');

function requireAdmin(req, res, next) {
  const token = extractBearerToken(req.headers.authorization);

  if (!token) {
    return res.status(401).json({ error: 'Admin token required' });
  }

  try {
    req.admin = verifyAdminToken(token);
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

module.exports = {
  requireAdmin
};
