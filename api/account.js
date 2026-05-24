function setCors(req, res, methods = 'GET, POST, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function readJsonBody(req) {
  if (req && req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (req && typeof req.body === 'string') {
    try {
      return Promise.resolve(JSON.parse(req.body));
    } catch {
      return Promise.resolve({});
    }
  }
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function emptyAccountData() {
  return {
    profile: {
      id: 'local',
      email: null,
      display_name: 'Local Studio',
      avatar_url: null,
      created_at: null,
      updated_at: null,
    },
    user: {
      id: 'local',
      email: null,
      user_metadata: { name: 'Local Studio' },
    },
    history: [],
    historyMeta: {
      totalCount: 0,
      loadedCount: 0,
      nextOffset: null,
      newestId: null,
      newestTimestamp: null,
    },
    titlePresetStore: {},
    charPresetStore: {},
    designPresetState: {
      hiddenBuiltins: [],
      nameOverrides: {},
      customPresets: [],
      fontCustomPresets: [],
    },
    summary: {
      historyCount: 0,
      presetCount: 0,
      customDesignPresetCount: 0,
    },
  };
}

module.exports = async function handler(req, res) {
  setCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, localOnly: true, ...emptyAccountData() });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = await readJsonBody(req);
  const action = body && body.action ? String(body.action) : 'bootstrap';

  if (action === 'bootstrap' || action === 'migrate') {
    return res.status(200).json({ ok: true, localOnly: true, ...emptyAccountData() });
  }

  if (action === 'load-history-page') {
    return res.status(200).json({ ok: true, items: [], totalCount: 0, nextOffset: null });
  }

  if (action === 'save-history') {
    const items = Array.isArray(body.items) ? body.items : (body.item ? [body.item] : []);
    return res.status(200).json({ ok: true, localOnly: true, items });
  }

  if (action === 'clear-history') {
    return res.status(200).json({ ok: true, localOnly: true, deletedCount: 0 });
  }

  if (
    action === 'save-text-presets'
    || action === 'save-design-presets'
    || action === 'compact-history'
    || action === 'delete-history'
    || action === 'delete-owned-assets'
  ) {
    return res.status(200).json({ ok: true, localOnly: true });
  }

  return res.status(400).json({ error: 'Unknown account action' });
};
