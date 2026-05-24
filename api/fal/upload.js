const busboy = require('busboy');
const { requireAuth } = require('../../lib/_auth');
const { uploadBufferToFal } = require('../../lib/_fal_upload');

const config = {
  api: {
    bodyParser: false,
  },
};

async function parseSingleUpload(req) {
  return new Promise((resolve, reject) => {
    let uploadedFile = null;
    const bb = busboy({ headers: req.headers });

    bb.on('file', (_fieldName, file, info) => {
      const chunks = [];
      file.on('data', (chunk) => {
        chunks.push(chunk);
      });
      file.on('end', () => {
        if (uploadedFile) return;
        const buffer = Buffer.concat(chunks);
        if (!buffer.length) return;
        uploadedFile = {
          buffer,
          filename: info && info.filename ? info.filename : 'upload.bin',
          mimeType: info && info.mimeType ? info.mimeType : 'application/octet-stream',
        };
      });
    });

    bb.on('close', () => resolve(uploadedFile));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  if (!requireAuth(req, res)) {
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const uploadedFile = await parseSingleUpload(req);
    if (!uploadedFile) {
      return res.status(400).json({ error: 'No upload file provided' });
    }

    const url = await uploadBufferToFal(
      uploadedFile.buffer,
      uploadedFile.filename,
      uploadedFile.mimeType
    );

    return res.status(200).json({ ok: true, url });
  } catch (error) {
    console.error('Fal upload error:', error);
    return res.status(500).json({
      error: error && error.message ? error.message : 'Upload failed',
    });
  }
};

module.exports.config = config;
