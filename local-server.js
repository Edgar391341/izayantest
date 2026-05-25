const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const root = __dirname;
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || 3000);

const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const apiRoutes = {
  '/api/generate': './api/generate.js',
  '/api/video-generate': './api/video-generate.js',
  '/api/status': './api/status.js',
  '/api/account': './api/account.js',
  '/api/auth-config': './api/auth-config.js',
  '/api/login': './api/login.js',
};

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

function decorateResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  };
  res.send = (payload) => res.end(payload);
  return res;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function prepareRequest(req, parsed) {
  req.query = Object.fromEntries(parsed.searchParams.entries());
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return;
  const contentType = String(req.headers['content-type'] || '');
  const bodyBuffer = await readBody(req);
  const bodyText = bodyBuffer.toString('utf8');
  if (contentType.includes('application/json')) {
    req.body = bodyText ? JSON.parse(bodyText) : {};
  } else if (contentType.includes('application/x-www-form-urlencoded')) {
    req.body = Object.fromEntries(new URLSearchParams(bodyText).entries());
  } else {
    req.body = bodyText;
  }
}

function getStaticFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  for (const base of [publicDir, root]) {
    const file = path.normalize(path.join(base, rel));
    if (file.startsWith(base) && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (apiRoutes[parsed.pathname]) {
      await prepareRequest(req, parsed);
      const handler = require(path.join(root, apiRoutes[parsed.pathname]));
      return handler(req, decorateResponse(res));
    }

    const file = getStaticFile(parsed.pathname);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message || 'Internal server error' }));
    } else {
      res.end();
    }
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Local site: http://localhost:${port}`);
});
