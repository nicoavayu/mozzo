const crypto = require('crypto');

const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function createAuthError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getAdminConfig() {
  return {
    password: process.env.ADMIN_PASSWORD || '',
    secret: process.env.ADMIN_TOKEN_SECRET || ''
  };
}

function ensureAdminAuthConfigured() {
  const { password, secret } = getAdminConfig();

  if (!password || !secret) {
    throw createAuthError('ADMIN_AUTH_NOT_CONFIGURED', 'Admin auth is not configured');
  }

  return { password, secret };
}

function signPayloadSegment(payloadSegment, secret) {
  return crypto.createHmac('sha256', secret).update(payloadSegment).digest('hex');
}

function issueAdminToken() {
  const { secret } = ensureAdminAuthConfigured();
  const issuedAt = Date.now();
  const payload = {
    role: 'admin',
    iat: issuedAt,
    exp: issuedAt + ADMIN_TOKEN_TTL_MS
  };
  const payloadSegment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = signPayloadSegment(payloadSegment, secret);

  return {
    token: `${payloadSegment}.${signature}`,
    payload
  };
}

function verifyAdminPassword(password) {
  const { password: expectedPassword } = ensureAdminAuthConfigured();

  if (typeof password !== 'string' || password.length === 0) {
    throw createAuthError('INVALID_ADMIN_CREDENTIALS', 'Password is required');
  }

  if (password !== expectedPassword) {
    throw createAuthError('INVALID_ADMIN_CREDENTIALS', 'Invalid admin password');
  }

  return true;
}

function extractBearerToken(authorizationHeader) {
  if (!authorizationHeader || typeof authorizationHeader !== 'string') {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }

  return token;
}

function verifyAdminToken(token) {
  if (!token) {
    throw createAuthError('MISSING_ADMIN_TOKEN', 'Admin token required');
  }

  const { secret } = ensureAdminAuthConfigured();
  const [payloadSegment, signature] = token.split('.');

  if (!payloadSegment || !signature) {
    throw createAuthError('INVALID_ADMIN_TOKEN', 'Invalid admin token');
  }

  const expectedSignature = signPayloadSegment(payloadSegment, secret);
  const signatureBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw createAuthError('INVALID_ADMIN_TOKEN', 'Invalid admin token');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch (error) {
    throw createAuthError('INVALID_ADMIN_TOKEN', 'Invalid admin token');
  }

  if (payload.role !== 'admin' || typeof payload.exp !== 'number') {
    throw createAuthError('INVALID_ADMIN_TOKEN', 'Invalid admin token');
  }

  if (Date.now() >= payload.exp) {
    throw createAuthError('INVALID_ADMIN_TOKEN', 'Invalid admin token');
  }

  return payload;
}

module.exports = {
  extractBearerToken,
  issueAdminToken,
  verifyAdminPassword,
  verifyAdminToken
};
