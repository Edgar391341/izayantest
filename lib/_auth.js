const crypto = require('crypto');

const SITE_PASSWORD = process.env.SITE_PASSWORD || 'esshatgitem';
const SITE_AUTH_SECRET = process.env.SITE_AUTH_SECRET || SITE_PASSWORD;
const SITE_AUTH_COOKIE = 'nb_site_auth';
const SITE_AUTH_MAX_AGE = 60 * 60 * 24 * 365;

function getCookie(req, name) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;

  const parts = header.split(';').map((p) => p.trim());
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (k === name) return decodeURIComponent(v);
  }

  return null;
}

function getBearerToken(req) {
  const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!auth) return null;

  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : null;
}

function signSiteAuthToken(value) {
  return crypto
    .createHmac('sha256', SITE_AUTH_SECRET)
    .update(String(value || ''))
    .digest('hex');
}

function getSiteAuthToken() {
  return signSiteAuthToken(SITE_PASSWORD);
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function isValidSitePassword(password) {
  return timingSafeEqualString(password, SITE_PASSWORD);
}

function buildSiteAuthCookie(req) {
  const isHttps = String(req.headers && (req.headers['x-forwarded-proto'] || '')).split(',')[0] === 'https';
  const secure = isHttps ? '; Secure' : '';
  return `${SITE_AUTH_COOKIE}=${encodeURIComponent(getSiteAuthToken())}; Max-Age=${SITE_AUTH_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function isRequestAuthorized(req) {
  const cookieToken = getCookie(req, SITE_AUTH_COOKIE);
  if (cookieToken && timingSafeEqualString(cookieToken, getSiteAuthToken())) return true;

  const bearer = getBearerToken(req);
  if (bearer && (timingSafeEqualString(bearer, getSiteAuthToken()) || isValidSitePassword(bearer))) return true;

  return false;
}

function requireAuth(req, res) {
  if (isRequestAuthorized(req)) return true;

  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

module.exports = {
  getCookie,
  getSiteAuthToken,
  isValidSitePassword,
  buildSiteAuthCookie,
  isRequestAuthorized,
  requireAuth,
};
