const { handleRequest, resolveProxyConfig } = require('@fal-ai/server-proxy');
const { requireAuth } = require('../../lib/_auth');

const STORAGE_PROXY_PATTERNS = [
  'rest.fal.ai/storage/upload/initiate\\?storage_type=fal-cdn-v3',
  'rest.fal.ai/storage/upload/initiate-multipart\\?storage_type=fal-cdn-v3',
  'rest.fal.ai/storage/upload/complete-multipart\\?storage_type=fal-cdn-v3',
];

function resolveFalAuthorization() {
  const raw = process.env.FAL_API_KEY || process.env.FAL_KEY;
  if (!raw) return undefined;
  return raw.startsWith('Key ') ? raw : `Key ${raw}`;
}

const proxyConfig = resolveProxyConfig({
  allowUnauthorizedRequests: false,
  isAuthenticated: async () => true,
  allowedUrlPatterns: STORAGE_PROXY_PATTERNS,
  allowedEndpoints: [
    'storage/upload/initiate',
    'storage/upload/initiate-multipart',
    'storage/upload/complete-multipart',
  ],
  resolveFalAuth: async () => resolveFalAuthorization(),
});

module.exports = async function handler(req, res) {
  if (!requireAuth(req, res)) {
    return;
  }

  if (!resolveFalAuthorization()) {
    return res.status(500).json({ error: 'FAL_KEY environment variable not configured' });
  }

  return handleRequest({
    id: 'vercel-api',
    method: req.method,
    getRequestBody: async () => JSON.stringify(req.body),
    getHeaders: () => req.headers,
    getHeader: (name) => req.headers[name],
    sendHeader: (name, value) => res.setHeader(name, value),
    respondWith: (status, data) => res.status(status).json(data),
    sendResponse: async (response) => {
      if (response.headers.get('content-type')?.includes('application/json')) {
        return res.status(response.status).json(await response.json());
      }
      return res.status(response.status).send(await response.text());
    },
  }, proxyConfig);
};
