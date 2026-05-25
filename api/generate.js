// Vercel Serverless Function for Image Generation using fal.ai
// Handles both text-to-image and image-to-image modes

const { requireAuth } = require('../lib/_auth');
const { uploadBufferToFal } = require('../lib/_fal_upload');
const { generateGoogleImageFallback, getGoogleImageModelId, hasGoogleApiKey } = require('../lib/_google_fallback');

const FAL_API_KEY = process.env.FAL_API_KEY || process.env.FAL_KEY;
const KIE_API_KEY = process.env.KIE_API_KEY || process.env.KIE_KEY;
const KIE_CREATE_TASK_URL = 'https://api.kie.ai/api/v1/jobs/createTask';
const KIE_STATUS_URL = 'https://api.kie.ai/api/v1/jobs/recordInfo';

const IMAGE_MODELS = {
    'flux-pro-v1.1-ultra': {
        endpoint: 'https://queue.fal.run/fal-ai/flux-pro/v1.1-ultra',
        kind: 'text-to-image',
        allowed: ['prompt', 'seed', 'num_images', 'enable_safety_checker', 'output_format', 'safety_tolerance', 'enhance_prompt', 'image_url', 'image_prompt_strength', 'aspect_ratio', 'raw'],
    },
    'nano-banana-pro': {
        endpoint: 'https://queue.fal.run/fal-ai/nano-banana-pro',
        kind: 'text-to-image',
        allowed: ['prompt', 'num_images', 'aspect_ratio', 'output_format', 'resolution', 'limit_generations', 'enable_web_search', 'sync_mode'],
    },
    'nano-banana-pro/edit': {
        endpoint: 'https://queue.fal.run/fal-ai/nano-banana-pro/edit',
        kind: 'image-to-image',
        allowed: ['prompt', 'image_urls', 'num_images', 'aspect_ratio', 'output_format', 'resolution', 'limit_generations', 'enable_web_search', 'sync_mode'],
    },
    'nano-banana-2': {
        endpoint: 'https://queue.fal.run/fal-ai/nano-banana-2',
        kind: 'text-to-image',
        allowed: ['prompt', 'num_images', 'seed', 'aspect_ratio', 'output_format', 'safety_tolerance', 'resolution', 'limit_generations', 'enable_web_search', 'enable_google_search', 'sync_mode'],
    },
    'nano-banana-2/edit': {
        endpoint: 'https://queue.fal.run/fal-ai/nano-banana-2/edit',
        kind: 'image-to-image',
        allowed: ['prompt', 'image_urls', 'num_images', 'seed', 'aspect_ratio', 'output_format', 'safety_tolerance', 'resolution', 'limit_generations', 'enable_web_search', 'enable_google_search', 'sync_mode'],
    },
    'gpt-image-1.5': {
        endpoint: 'https://queue.fal.run/fal-ai/gpt-image-1.5',
        kind: 'text-to-image',
        allowed: ['prompt', 'image_size', 'background', 'quality', 'num_images', 'output_format', 'sync_mode'],
    },
    'openai/gpt-image-2': {
        endpoint: 'https://queue.fal.run/openai/gpt-image-2',
        kind: 'text-to-image',
        allowed: ['prompt', 'image_size', 'quality', 'num_images', 'output_format', 'sync_mode'],
    },
    'gpt-image-1.5/edit': {
        endpoint: 'https://queue.fal.run/fal-ai/gpt-image-1.5/edit',
        kind: 'image-to-image',
        allowed: ['prompt', 'image_urls', 'image_size', 'background', 'quality', 'input_fidelity', 'num_images', 'output_format', 'sync_mode', 'mask_image_url'],
    },
    'openai/gpt-image-2/edit': {
        endpoint: 'https://queue.fal.run/openai/gpt-image-2/edit',
        kind: 'image-to-image',
        allowed: ['prompt', 'image_urls', 'image_size', 'quality', 'num_images', 'output_format', 'sync_mode', 'mask_url'],
    },
    'pixelcut/background-removal': {
        endpoint: 'https://queue.fal.run/pixelcut/background-removal',
        kind: 'image-to-image',
        allowed: ['image_url', 'output_format', 'sync_mode'],
        requiresPrompt: false,
    },
    'fal-ai/topaz/upscale/image': {
        endpoint: 'https://queue.fal.run/fal-ai/topaz/upscale/image',
        kind: 'image-to-image',
        allowed: ['model', 'upscale_factor', 'crop_to_fill', 'image_url', 'output_format', 'subject_detection', 'face_enhancement', 'face_enhancement_creativity', 'face_enhancement_strength', 'sharpen', 'denoise', 'fix_compression', 'strength', 'creativity', 'texture', 'prompt', 'autoprompt', 'detail'],
        requiresPrompt: false,
    },
    'fal-ai/sam-audio/separate': {
        endpoint: 'https://queue.fal.run/fal-ai/sam-audio/separate',
        kind: 'audio-to-audio',
        allowed: ['audio_url', 'prompt', 'predict_spans', 'reranking_candidates', 'acceleration', 'max_chunk_duration', 'chunk_overlap', 'output_format'],
    },
    'fal-ai/sam-audio/span-separate': {
        endpoint: 'https://queue.fal.run/fal-ai/sam-audio/span-separate',
        kind: 'audio-to-audio',
        allowed: ['audio_url', 'prompt', 'spans', 'reranking_candidates', 'acceleration', 'max_chunk_duration', 'chunk_overlap', 'use_sound_activity_ranking', 'trim_to_span', 'output_format'],
        requiresPrompt: false,
    },
    'fal-ai/heygen/v2/translate/precision': {
        endpoint: 'https://queue.fal.run/fal-ai/heygen/v2/translate/precision',
        kind: 'video-to-video',
        allowed: ['video_url', 'output_language', 'translate_audio_only', 'speaker_num', 'enable_dynamic_duration'],
        requiresPrompt: false,
    },
};

function inferExtFromDataUri(dataUri) {
    const match = /^data:([^;,]+)/i.exec(String(dataUri || ''));
    const mime = match ? match[1].toLowerCase() : '';
    if (mime.includes('png')) return 'png';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('gif')) return 'gif';
    if (mime.includes('avif')) return 'avif';
    return 'jpg';
}

async function uploadDataUriToKie(dataUri, label, index) {
    const fileName = `${String(label || 'card-studio-ref').replace(/[^a-z0-9_-]+/gi, '-')}-${Date.now()}-${index}.${inferExtFromDataUri(dataUri)}`;
    const response = await fetch('https://kieai.redpandaai.co/api/file-base64-upload', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${KIE_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            base64Data: dataUri,
            uploadPath: 'images/card-studio',
            fileName,
        }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.code >= 400 || data.success === false) {
        const message = data && (data.msg || data.message || data.error)
            ? (data.msg || data.message || data.error)
            : `KIE upload failed: ${response.status} ${response.statusText}`;
        throw new Error(message);
    }
    const url = data.data && (data.data.downloadUrl || data.data.fileUrl || data.data.url);
    if (!url) throw new Error('KIE upload returned no file URL');
    return url;
}

async function normalizeKieImageInputs(imageUrls) {
    const list = Array.isArray(imageUrls) ? imageUrls : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const value = String(list[i] || '').trim();
        if (!value) continue;
        if (/^data:image\//i.test(value)) {
            out.push(await uploadDataUriToKie(value, 'card-studio-ref', i));
        } else {
            out.push(value);
        }
    }
    return out;
}

function getKieImageModelId(modelId) {
    const id = String(modelId || '').trim();
    if (id === 'nano-banana-2' || id === 'nano-banana-2/edit' || id === 'kie/nano-banana-2') return 'nano-banana-2';
    if (id === 'nano-banana-pro' || id === 'nano-banana-pro/edit' || id === 'kie/nano-banana-pro') return 'nano-banana-pro';
    if (id === 'gpt-image-2-text-to-image') return 'gpt-image-2-text-to-image';
    if (id === 'gpt-image-2-image-to-image') return 'gpt-image-2-image-to-image';
    return null;
}

function isGptImage2KieModel(modelId) {
    const id = String(modelId || '').trim();
    return id === 'gpt-image-2-text-to-image' || id === 'gpt-image-2-image-to-image';
}

async function submitKieImageTask(body) {
    if (!KIE_API_KEY) throw new Error('KIE_API_KEY environment variable not configured');
    const kieModel = getKieImageModelId(body.model_id);
    if (!kieModel) throw new Error(`Unknown KIE model_id: ${body.model_id || ''}`);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) throw new Error('Prompt is required');

    const isGpt2 = isGptImage2KieModel(kieModel);
    const imageInput = await normalizeKieImageInputs(body.image_urls || body.image_input || []);
    const input = {
        prompt,
    };

    if (isGpt2) {
        if (imageInput.length > 0) input.input_urls = imageInput;
        input.aspect_ratio = body.aspect_ratio || 'auto';
    } else {
        input.image_input = imageInput;
        input.aspect_ratio = body.aspect_ratio || 'auto';
        input.resolution = body.resolution || '1K';
        const outputFormat = String(body.output_format || 'png').toLowerCase();
        input.output_format = outputFormat === 'jpeg' ? 'jpeg' : 'png';
    }

    const requestBody = {
        model: kieModel,
        input,
    };
    if (body.callBackUrl) requestBody.callBackUrl = String(body.callBackUrl);

    const response = await fetch(KIE_CREATE_TASK_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${KIE_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.code >= 400) {
        const message = data && (data.msg || data.message || data.error)
            ? (data.msg || data.message || data.error)
            : `KIE API error: ${response.status} ${response.statusText}`;
        throw new Error(message);
    }

    const taskId = data && data.data && (data.data.taskId || data.data.task_id || data.data.id);
    if (!taskId) throw new Error('KIE API returned no taskId');
    const statusUrl = `${KIE_STATUS_URL}?taskId=${encodeURIComponent(taskId)}`;
    return {
        provider: 'kie',
        model_id: kieModel,
        request_id: taskId,
        status_url: statusUrl,
        response_url: statusUrl,
    };
}

function pickAllowed(obj, allowed) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
            out[k] = obj[k];
        }
    }
    return out;
}

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
    return uploadBufferToFal(fileBuffer, fileName, mimeType);
}

async function normalizeImageUrls(imageUrls) {
    const list = Array.isArray(imageUrls) ? imageUrls : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (!v) continue;
        const s = String(v);
        if (s.startsWith('http://') || s.startsWith('https://')) {
            out.push(s);
            continue;
        }
        const parsed = parseDataUri(s);
        if (!parsed) {
            throw new Error('Invalid image input. Provide https URL(s) or data URI(s).');
        }
        const ext = parsed.mimeType === 'image/png' ? 'png' : (parsed.mimeType === 'image/webp' ? 'webp' : 'jpg');
        const url = await uploadToFal(parsed.buffer, `upload-${Date.now()}-${i}.${ext}`, parsed.mimeType);
        out.push(url);
    }
    return out;
}

async function normalizeSingleImageUrl(imageUrl) {
    if (!imageUrl) return null;
    const value = String(imageUrl);
    if (value.startsWith('http://') || value.startsWith('https://')) {
        return value;
    }
    const parsed = parseDataUri(value);
    if (!parsed) {
        throw new Error('Invalid image input. Provide an https URL or data URI.');
    }
    const ext = parsed.mimeType === 'image/png' ? 'png' : (parsed.mimeType === 'image/webp' ? 'webp' : 'jpg');
    return uploadToFal(parsed.buffer, `upload-${Date.now()}.${ext}`, parsed.mimeType);
}

module.exports = async function handler(req, res) {
    // Enable CORS
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

    const requestedModelId = (req.body || {}).model_id || 'flux-pro-v1.1-ultra';
    const isKieModel = !!getKieImageModelId(requestedModelId);
    if (!isKieModel && !FAL_API_KEY && (!getGoogleImageModelId(requestedModelId) || !hasGoogleApiKey())) {
        return res.status(500).json({ error: 'FAL_KEY environment variable not configured' });
    }

    try {
        const body = req.body || {};
        const model_id = body.model_id || 'flux-pro-v1.1-ultra';
        if (getKieImageModelId(model_id)) {
            const result = await submitKieImageTask(body);
            return res.status(200).json(result);
        }

        const model = IMAGE_MODELS[model_id] || null;
        if (!model) {
            return res.status(400).json({ error: `Unknown model_id: ${model_id}` });
        }

        const prompt = typeof body.prompt === 'string' ? body.prompt : '';
        const requiresPrompt = model.requiresPrompt !== false;

        if (requiresPrompt && !prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        const rawPayload = {
            ...body,
        };
        if (prompt) rawPayload.prompt = prompt;

        const allowed = Array.isArray(model.allowed) ? model.allowed : [];
        const supportsImageUrls = allowed.includes('image_urls');
        const supportsImageUrl = allowed.includes('image_url');

        const maxImageUrlsByModel = {
            'nano-banana-pro/edit': 14,
            'nano-banana-2/edit': 14,
            'gpt-image-1.5/edit': 4,
            'openai/gpt-image-2/edit': 4,
        };

        if (supportsImageUrls) {
            if (Array.isArray(rawPayload.image_urls)) {
                const max = maxImageUrlsByModel[model_id];
                if (typeof max === 'number' && Number.isFinite(max) && rawPayload.image_urls.length > max) {
                    rawPayload.image_urls = rawPayload.image_urls.slice(0, max);
                }
            }

            // Legacy compatibility: old UI sends image_url for mode==='image'
            if (typeof rawPayload.image_url === 'string' && rawPayload.image_url && !rawPayload.image_urls) {
                rawPayload.image_urls = [rawPayload.image_url];
            }

            // Normalize multi-image + optional mask upload
            if (Array.isArray(rawPayload.image_urls)) {
                rawPayload.image_urls = await normalizeImageUrls(rawPayload.image_urls);
            }
        }

        if (supportsImageUrl && typeof rawPayload.image_url === 'string' && rawPayload.image_url) {
            rawPayload.image_url = await normalizeSingleImageUrl(rawPayload.image_url);
        }

        if (typeof rawPayload.mask_image_url === 'string' && rawPayload.mask_image_url.startsWith('data:')) {
            const parsed = parseDataUri(rawPayload.mask_image_url);
            if (!parsed) throw new Error('Invalid mask image data URI');
            const ext = parsed.mimeType === 'image/png' ? 'png' : (parsed.mimeType === 'image/webp' ? 'webp' : 'jpg');
            rawPayload.mask_image_url = await uploadToFal(parsed.buffer, `mask-${Date.now()}.${ext}`, parsed.mimeType);
        }
        if (typeof rawPayload.mask_url === 'string' && rawPayload.mask_url.startsWith('data:')) {
            const parsed = parseDataUri(rawPayload.mask_url);
            if (!parsed) throw new Error('Invalid mask image data URI');
            const ext = parsed.mimeType === 'image/png' ? 'png' : (parsed.mimeType === 'image/webp' ? 'webp' : 'jpg');
            rawPayload.mask_url = await uploadToFal(parsed.buffer, `mask-${Date.now()}.${ext}`, parsed.mimeType);
        }

        const payload = pickAllowed(rawPayload, allowed);

        // Submit to fal.ai
        const endpoint = model.endpoint;

        let response = null;
        if (FAL_API_KEY) {
            response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Key ${FAL_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
        }

        if (!response || !response.ok) {
            const errorText = response ? await response.text() : 'FAL_KEY environment variable not configured';
            console.error('FAL API Error:', errorText);
            const googleFallback = await generateGoogleImageFallback(model_id, payload).catch((fallbackError) => {
                console.error('Google image fallback error:', fallbackError);
                return { error: fallbackError.message || 'Google fallback failed' };
            });
            if (googleFallback && !googleFallback.error) {
                return res.status(200).json(googleFallback);
            }
            return res.status(response ? response.status : 500).json({
                error: googleFallback && googleFallback.error
                    ? googleFallback.error
                    : `FAL API error: ${response ? response.statusText : 'missing API key'}`
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

        // Return request info for polling
        return res.status(200).json({
            request_id: requestId,
            status_url: statusUrl,
            response_url: responseUrl,
        });

    } catch (error) {
        console.error('Generate error:', error);
        return res.status(500).json({
            error: error.message || 'Internal server error'
        });
    }
}
