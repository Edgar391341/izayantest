const { requireAuth } = require('../lib/_auth');

const FAL_API_KEY = process.env.FAL_API_KEY || process.env.FAL_KEY;

const MODEL_ENDPOINTS = {
  'fal-ai/hunyuan3d-v3/image-to-3d': 'https://queue.fal.run/fal-ai/hunyuan3d-v3/image-to-3d',
  'fal-ai/hunyuan3d-v3/text-to-3d': 'https://queue.fal.run/fal-ai/hunyuan3d-v3/text-to-3d',
  'fal-ai/meshy/v6-preview/image-to-3d': 'https://queue.fal.run/fal-ai/meshy/v6-preview/image-to-3d',
  'fal-ai/meshy/v6-preview/text-to-3d': 'https://queue.fal.run/fal-ai/meshy/v6-preview/text-to-3d',
  'fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d': 'https://queue.fal.run/fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d',
  'fal-ai/hunyuan-3d/v3.1/smart-topology': 'https://queue.fal.run/fal-ai/hunyuan-3d/v3.1/smart-topology',
  'fal-ai/meshy/v5/retexture': 'https://queue.fal.run/fal-ai/meshy/v5/retexture',
};

function parseDataUri(dataUri) {
  const s = String(dataUri || '');
  if (!s.startsWith('data:')) return null;
  const comma = s.indexOf(',');
  if (comma < 0) return null;
  const meta = s.slice(5, comma);
  const b64 = s.slice(comma + 1);
  const isB64 = /;base64/i.test(meta);
  if (!isB64) return null;
  const mimeType = (meta.split(';')[0] || 'application/octet-stream').trim();
  const buffer = Buffer.from(b64, 'base64');
  return { mimeType, buffer };
}

async function uploadToFal(fileBuffer, fileName, mimeType) {
  // Step 1: Initiate upload to get a presigned URL and the final CDN URL
  const initResp = await fetch(
    'https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3',
    {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content_type: mimeType || 'application/octet-stream',
        file_name: fileName,
      }),
    }
  );
  if (!initResp.ok) {
    const errorText = await initResp.text();
    throw new Error(`Failed to initiate upload: ${initResp.statusText}: ${errorText}`);
  }
  const { upload_url, file_url } = await initResp.json();

  // Step 2: PUT the file data to the presigned URL
  const putResp = await fetch(upload_url, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType || 'application/octet-stream',
    },
    body: fileBuffer,
  });
  if (!putResp.ok) {
    const errorText = await putResp.text();
    throw new Error(`Failed to upload file: ${putResp.statusText}: ${errorText}`);
  }

  return file_url;
}

function coerceBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return undefined;
}

function coerceInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}

function normalizeUrlOrUpload(v, fileLabel) {
  if (!v) return null;
  const s = String(v);
  if (s.startsWith('http://') || s.startsWith('https://')) return { kind: 'url', value: s };
  const parsed = parseDataUri(s);
  if (!parsed) {
    throw new Error(`Invalid ${fileLabel}. Provide https URL or data URI.`);
  }
  return { kind: 'data', value: parsed };
}

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

  if (!requireAuth(req, res)) {
    return;
  }

  if (!FAL_API_KEY) {
    return res.status(500).json({ error: 'FAL_KEY environment variable not configured' });
  }

  try {
    const body = req.body || {};

    const modelId = body.model_id ? String(body.model_id).trim() : 'fal-ai/hunyuan3d-v3/image-to-3d';
    const endpoint = MODEL_ENDPOINTS[modelId];
    if (!endpoint) {
      return res.status(400).json({ error: 'Unknown model_id' });
    }

    const payload = {};

    const uploadUrlOrData = async (value, key, namePrefix) => {
      const img = normalizeUrlOrUpload(value, key);
      if (!img) return;
      if (img.kind === 'url') {
        payload[key] = img.value;
        return;
      }
      const { mimeType, buffer } = img.value;
      const ext = mimeType === 'image/png' ? 'png' : (mimeType === 'image/webp' ? 'webp' : 'jpg');
      payload[key] = await uploadToFal(buffer, `${namePrefix}-${Date.now()}.${ext}`, mimeType);
    };

    if (modelId === 'fal-ai/hunyuan3d-v3/image-to-3d') {
      const inputImage = normalizeUrlOrUpload(body.input_image_url, 'input_image_url');
      if (!inputImage) {
        return res.status(400).json({ error: 'input_image_url is required' });
      }

      if (inputImage.kind === 'url') {
        payload.input_image_url = inputImage.value;
      } else {
        const { mimeType, buffer } = inputImage.value;
        const ext = mimeType === 'image/png' ? 'png' : (mimeType === 'image/webp' ? 'webp' : 'jpg');
        payload.input_image_url = await uploadToFal(buffer, `hunyuan3d-v3-front-${Date.now()}.${ext}`, mimeType);
      }

      await uploadUrlOrData(body.back_image_url, 'back_image_url', 'hunyuan3d-v3-back');
      await uploadUrlOrData(body.left_image_url, 'left_image_url', 'hunyuan3d-v3-left');
      await uploadUrlOrData(body.right_image_url, 'right_image_url', 'hunyuan3d-v3-right');

      const enablePbr = coerceBool(body.enable_pbr);
      if (typeof enablePbr === 'boolean') {
        payload.enable_pbr = enablePbr;
      }

      const faceCount = coerceInt(body.face_count);
      if (typeof faceCount === 'number') {
        if (faceCount < 40000 || faceCount > 1500000) {
          return res.status(400).json({ error: 'face_count must be in range 40000-1500000' });
        }
        payload.face_count = faceCount;
      }

      const generateType = body.generate_type ? String(body.generate_type) : null;
      if (generateType) {
        const allowed = new Set(['Normal', 'LowPoly', 'Geometry']);
        if (!allowed.has(generateType)) {
          return res.status(400).json({ error: 'generate_type must be Normal, LowPoly, or Geometry' });
        }
        payload.generate_type = generateType;
      }

      const polygonType = body.polygon_type ? String(body.polygon_type) : null;
      if (polygonType) {
        const allowed = new Set(['triangle', 'quadrilateral']);
        if (!allowed.has(polygonType)) {
          return res.status(400).json({ error: 'polygon_type must be triangle or quadrilateral' });
        }
        payload.polygon_type = polygonType;
      }
    }

    if (modelId === 'fal-ai/hunyuan3d-v3/text-to-3d') {
      const prompt = body.prompt ? String(body.prompt) : '';
      if (!prompt.trim()) {
        return res.status(400).json({ error: 'prompt is required' });
      }
      if (prompt.length > 1024) {
        return res.status(400).json({ error: 'prompt max length is 1024 characters' });
      }
      payload.prompt = prompt;

      const enablePbr = coerceBool(body.enable_pbr);
      if (typeof enablePbr === 'boolean') {
        payload.enable_pbr = enablePbr;
      }

      const faceCount = coerceInt(body.face_count);
      if (typeof faceCount === 'number') {
        if (faceCount < 40000 || faceCount > 1500000) {
          return res.status(400).json({ error: 'face_count must be in range 40000-1500000' });
        }
        payload.face_count = faceCount;
      }

      const generateType = body.generate_type ? String(body.generate_type) : null;
      if (generateType) {
        const allowed = new Set(['Normal', 'LowPoly', 'Geometry']);
        if (!allowed.has(generateType)) {
          return res.status(400).json({ error: 'generate_type must be Normal, LowPoly, or Geometry' });
        }
        payload.generate_type = generateType;
      }

      const polygonType = body.polygon_type ? String(body.polygon_type) : null;
      if (polygonType) {
        const allowed = new Set(['triangle', 'quadrilateral']);
        if (!allowed.has(polygonType)) {
          return res.status(400).json({ error: 'polygon_type must be triangle or quadrilateral' });
        }
        payload.polygon_type = polygonType;
      }
    }

    if (modelId === 'fal-ai/meshy/v6-preview/image-to-3d') {
      if (!body.image_url) {
        return res.status(400).json({ error: 'image_url is required' });
      }

      await uploadUrlOrData(body.image_url, 'image_url', 'meshy-v6-image');
      await uploadUrlOrData(body.texture_image_url, 'texture_image_url', 'meshy-v6-texture');

      const topology = body.topology ? String(body.topology) : null;
      if (topology) {
        const allowed = new Set(['quad', 'triangle']);
        if (!allowed.has(topology)) {
          return res.status(400).json({ error: 'topology must be quad or triangle' });
        }
        payload.topology = topology;
      }

      const targetPoly = coerceInt(body.target_polycount);
      if (typeof targetPoly === 'number') {
        if (targetPoly < 100 || targetPoly > 300000) {
          return res.status(400).json({ error: 'target_polycount must be in range 100-300000' });
        }
        payload.target_polycount = targetPoly;
      }

      const symmetry = body.symmetry_mode ? String(body.symmetry_mode) : null;
      if (symmetry) {
        const allowed = new Set(['off', 'auto', 'on']);
        if (!allowed.has(symmetry)) {
          return res.status(400).json({ error: 'symmetry_mode must be off, auto, or on' });
        }
        payload.symmetry_mode = symmetry;
      }

      const shouldRemesh = coerceBool(body.should_remesh);
      if (typeof shouldRemesh === 'boolean') payload.should_remesh = shouldRemesh;

      const shouldTexture = coerceBool(body.should_texture);
      if (typeof shouldTexture === 'boolean') payload.should_texture = shouldTexture;

      const enablePbr = coerceBool(body.enable_pbr);
      if (typeof enablePbr === 'boolean') payload.enable_pbr = enablePbr;

      const isAT = coerceBool(body.is_a_t_pose);
      if (typeof isAT === 'boolean') payload.is_a_t_pose = isAT;

      const texturePrompt = body.texture_prompt ? String(body.texture_prompt) : null;
      if (texturePrompt) {
        if (texturePrompt.length > 600) {
          return res.status(400).json({ error: 'texture_prompt max length is 600' });
        }
        payload.texture_prompt = texturePrompt;
      }

      const safety = coerceBool(body.enable_safety_checker);
      if (typeof safety === 'boolean') payload.enable_safety_checker = safety;
    }

    if (modelId === 'fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d') {
      const inputImage = normalizeUrlOrUpload(body.input_image_url, 'input_image_url');
      if (!inputImage) {
        return res.status(400).json({ error: 'input_image_url is required' });
      }

      if (inputImage.kind === 'url') {
        payload.input_image_url = inputImage.value;
      } else {
        const { mimeType, buffer } = inputImage.value;
        const ext = mimeType === 'image/png' ? 'png' : (mimeType === 'image/webp' ? 'webp' : 'jpg');
        payload.input_image_url = await uploadToFal(buffer, `rapid-i2-3d-front-${Date.now()}.${ext}`, mimeType);
      }

      const enablePbr = coerceBool(body.enable_pbr);
      if (typeof enablePbr === 'boolean') payload.enable_pbr = enablePbr;

      const enableGeometry = coerceBool(body.enable_geometry);
      if (typeof enableGeometry === 'boolean') payload.enable_geometry = enableGeometry;
    }

    if (modelId === 'fal-ai/hunyuan-3d/v3.1/smart-topology') {
      if (!body.input_file_url) {
        return res.status(400).json({ error: 'input_file_url is required (GLB or OBJ file URL)' });
      }

      // Auto-detect file type from URL extension if not explicitly set
      let detectedType = body.input_file_type ? String(body.input_file_type) : null;
      if (!detectedType) {
        const urlLower = String(body.input_file_url).toLowerCase();
        if (urlLower.includes('.obj')) detectedType = 'obj';
        else detectedType = 'glb';
      }

      const fileInput = normalizeUrlOrUpload(body.input_file_url, 'input_file_url');
      if (fileInput.kind === 'url') {
        payload.input_file_url = fileInput.value;
      } else {
        const { mimeType, buffer } = fileInput.value;
        const ext = detectedType || 'glb';
        payload.input_file_url = await uploadToFal(buffer, `smart-topo-${Date.now()}.${ext}`, mimeType || 'application/octet-stream');
      }

      const allowedTypes = new Set(['glb', 'obj']);
      if (!allowedTypes.has(detectedType)) {
        return res.status(400).json({ error: 'input_file_type must be glb or obj' });
      }
      payload.input_file_type = detectedType;

      const polygonType = body.polygon_type ? String(body.polygon_type) : 'triangle';
      const allowedPoly = new Set(['triangle', 'quadrilateral']);
      if (!allowedPoly.has(polygonType)) {
        return res.status(400).json({ error: 'polygon_type must be triangle or quadrilateral' });
      }
      payload.polygon_type = polygonType;

      const faceLevel = body.face_level ? String(body.face_level) : 'medium';
      const allowedLevels = new Set(['high', 'medium', 'low']);
      if (!allowedLevels.has(faceLevel)) {
        return res.status(400).json({ error: 'face_level must be high, medium, or low' });
      }
      payload.face_level = faceLevel;
    }

    if (modelId === 'fal-ai/meshy/v5/retexture') {
      if (!body.model_url) {
        return res.status(400).json({ error: 'model_url is required (3D model file URL)' });
      }

      const modelInput = normalizeUrlOrUpload(body.model_url, 'model_url');
      if (modelInput.kind === 'url') {
        payload.model_url = modelInput.value;
      } else {
        const { mimeType, buffer } = modelInput.value;
        payload.model_url = await uploadToFal(buffer, `meshy-retex-model-${Date.now()}.glb`, mimeType || 'application/octet-stream');
      }

      const textPrompt = body.text_style_prompt ? String(body.text_style_prompt) : null;
      if (textPrompt) {
        if (textPrompt.length > 600) {
          return res.status(400).json({ error: 'text_style_prompt max length is 600' });
        }
        payload.text_style_prompt = textPrompt;
      }

      if (body.image_style_url) {
        await uploadUrlOrData(body.image_style_url, 'image_style_url', 'meshy-retex-style');
      }

      if (!textPrompt && !payload.image_style_url) {
        return res.status(400).json({ error: 'Either text_style_prompt or image_style_url is required' });
      }

      const enableOrigUv = coerceBool(body.enable_original_uv);
      if (typeof enableOrigUv === 'boolean') payload.enable_original_uv = enableOrigUv;

      const enablePbr = coerceBool(body.enable_pbr);
      if (typeof enablePbr === 'boolean') payload.enable_pbr = enablePbr;

      const safety = coerceBool(body.enable_safety_checker);
      if (typeof safety === 'boolean') payload.enable_safety_checker = safety;
    }

    if (modelId === 'fal-ai/meshy/v6-preview/text-to-3d') {
      const prompt = body.prompt ? String(body.prompt) : '';
      if (!prompt.trim()) {
        return res.status(400).json({ error: 'prompt is required' });
      }
      if (prompt.length > 600) {
        return res.status(400).json({ error: 'prompt max length is 600' });
      }
      payload.prompt = prompt;

      await uploadUrlOrData(body.texture_image_url, 'texture_image_url', 'meshy-v6-texture');

      const mode = body.mode ? String(body.mode) : null;
      if (mode) {
        const allowed = new Set(['preview', 'full']);
        if (!allowed.has(mode)) {
          return res.status(400).json({ error: 'mode must be preview or full' });
        }
        payload.mode = mode;
      }

      const artStyle = body.art_style ? String(body.art_style) : null;
      if (artStyle) {
        const allowed = new Set(['realistic', 'sculpture']);
        if (!allowed.has(artStyle)) {
          return res.status(400).json({ error: 'art_style must be realistic or sculpture' });
        }
        payload.art_style = artStyle;
      }

      const seed = coerceInt(body.seed);
      if (typeof seed === 'number') payload.seed = seed;

      const topology = body.topology ? String(body.topology) : null;
      if (topology) {
        const allowed = new Set(['quad', 'triangle']);
        if (!allowed.has(topology)) {
          return res.status(400).json({ error: 'topology must be quad or triangle' });
        }
        payload.topology = topology;
      }

      const targetPoly = coerceInt(body.target_polycount);
      if (typeof targetPoly === 'number') {
        if (targetPoly < 100 || targetPoly > 300000) {
          return res.status(400).json({ error: 'target_polycount must be in range 100-300000' });
        }
        payload.target_polycount = targetPoly;
      }

      const shouldRemesh = coerceBool(body.should_remesh);
      if (typeof shouldRemesh === 'boolean') payload.should_remesh = shouldRemesh;

      const symmetry = body.symmetry_mode ? String(body.symmetry_mode) : null;
      if (symmetry) {
        const allowed = new Set(['off', 'auto', 'on']);
        if (!allowed.has(symmetry)) {
          return res.status(400).json({ error: 'symmetry_mode must be off, auto, or on' });
        }
        payload.symmetry_mode = symmetry;
      }

      const isAT = coerceBool(body.is_a_t_pose);
      if (typeof isAT === 'boolean') payload.is_a_t_pose = isAT;

      const enablePbr = coerceBool(body.enable_pbr);
      if (typeof enablePbr === 'boolean') payload.enable_pbr = enablePbr;

      const enableExp = coerceBool(body.enable_prompt_expansion);
      if (typeof enableExp === 'boolean') payload.enable_prompt_expansion = enableExp;

      const texturePrompt = body.texture_prompt ? String(body.texture_prompt) : null;
      if (texturePrompt) {
        if (texturePrompt.length > 600) {
          return res.status(400).json({ error: 'texture_prompt max length is 600' });
        }
        payload.texture_prompt = texturePrompt;
      }

      const safety = coerceBool(body.enable_safety_checker);
      if (typeof safety === 'boolean') payload.enable_safety_checker = safety;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(errorText);
      } catch {
        parsed = null;
      }
      const message = (parsed && (parsed.error || parsed.message)) ? (parsed.error || parsed.message) : `FAL API error: ${response.status} ${response.statusText}`;
      return res.status(response.status).json({
        error: message,
        details: parsed || errorText,
      });
    }

    const data = await response.json();
    const requestId = data.request_id || data.requestId || data.id || null;
    const statusUrl = data.status_url || (requestId ? `${endpoint}/requests/${requestId}/status` : null);
    const responseUrl = data.response_url || (requestId ? `${endpoint}/requests/${requestId}` : null);

    if (!statusUrl) {
      return res.status(502).json({
        error: 'FAL API returned no status_url',
        details: data,
      });
    }

    return res.status(200).json({
      request_id: requestId,
      status_url: statusUrl,
      response_url: responseUrl,
    });
  } catch (error) {
    console.error('3D generate error:', error);
    return res.status(500).json({
      error: error && error.message ? error.message : 'Internal server error',
    });
  }
};
