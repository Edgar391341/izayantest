const { buildSiteAuthCookie, isRequestAuthorized, isValidSitePassword } = require('../lib/_auth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const password = typeof body.password === 'string' ? body.password : '';

  if (!isValidSitePassword(password) && !isRequestAuthorized(req)) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  res.setHeader('Set-Cookie', buildSiteAuthCookie(req));
  return res.status(200).json({ ok: true, trusted: true });
};
