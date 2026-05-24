const { Blob, File } = require('node:buffer');

let _falClientPromise = null;

function resolveFalApiKey() {
  const key = process.env.FAL_API_KEY || process.env.FAL_KEY;
  if (!key) {
    throw new Error('FAL_KEY environment variable not configured');
  }
  return key.startsWith('Key ') ? key.slice(4) : key;
}

async function getFalClient() {
  if (!_falClientPromise) {
    _falClientPromise = import('@fal-ai/client').then((mod) => {
      const fal = mod && mod.fal ? mod.fal : null;
      if (!fal || typeof fal.config !== 'function' || !fal.storage || typeof fal.storage.upload !== 'function') {
        throw new Error('fal upload client not available');
      }
      fal.config({
        credentials: resolveFalApiKey(),
      });
      return fal;
    });
  }
  return _falClientPromise;
}

async function uploadBufferToFal(buffer, fileName, mimeType) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Upload buffer is empty');
  }
  const fal = await getFalClient();
  const normalizedType = mimeType || 'application/octet-stream';
  const name = fileName || 'upload.bin';
  const uploadObject = typeof File === 'function'
    ? new File([buffer], name, { type: normalizedType })
    : new Blob([buffer], { type: normalizedType });
  const url = await fal.storage.upload(uploadObject, {
    lifecycle: {
      expiresIn: '1d',
    },
  });
  if (!url) {
    throw new Error('Fal upload did not return a file URL');
  }
  return url;
}

module.exports = {
  uploadBufferToFal,
  resolveFalApiKey,
};
