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

function isRequestAuthorized(req) {
  return true;
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
  isRequestAuthorized,
  requireAuth,
};
