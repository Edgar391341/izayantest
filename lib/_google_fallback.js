const GOOGLE_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;

const IMAGE_FALLBACK_MODELS = {
    'nano-banana-2': 'gemini-3.1-flash-image-preview',
    'nano-banana-2/edit': 'gemini-3.1-flash-image-preview',
    'nano-banana-pro': 'gemini-3-pro-image-preview',
    'nano-banana-pro/edit': 'gemini-3-pro-image-preview',
};

const VIDEO_FALLBACK_MODELS = {
    'veo3.1-i2v': 'veo-3.1-generate-preview',
    'veo3.1-reference-to-video': 'veo-3.1-generate-preview',
    'veo3.1-fast': 'veo-3.1-fast-generate-preview',
    'veo3-fast': 'veo-3.0-fast-generate-001',
    'veo3': 'veo-3.0-generate-001',
};

function hasGoogleApiKey() {
    return !!GOOGLE_API_KEY;
}

function getGoogleImageModelId(modelId) {
    return IMAGE_FALLBACK_MODELS[modelId] || null;
}

function getGoogleVideoModelId(modelId) {
    return VIDEO_FALLBACK_MODELS[modelId] || null;
}

function mapImageSize(value) {
    const s = String(value || '').toUpperCase();
    if (s === '4K' || s === '2K' || s === '1K') return s;
    if (s.includes('4K')) return '4K';
    if (s.includes('2K')) return '2K';
    return undefined;
}

function buildImageParts(payload) {
    const parts = [];
    if (payload.prompt) {
        parts.push({ text: String(payload.prompt) });
    }

    const urls = Array.isArray(payload.image_urls)
        ? payload.image_urls
        : (payload.image_url ? [payload.image_url] : []);

    for (const url of urls) {
        if (typeof url === 'string' && url.startsWith('data:')) {
            const comma = url.indexOf(',');
            const meta = url.slice(5, comma);
            const mimeType = (meta.split(';')[0] || 'image/png').trim();
            parts.push({ inline_data: { mime_type: mimeType, data: url.slice(comma + 1) } });
        } else if (typeof url === 'string' && url) {
            parts.push({ text: `Reference image URL: ${url}` });
        }
    }

    return parts;
}

function normalizeGeminiMediaParts(data, mediaType) {
    const candidates = Array.isArray(data && data.candidates) ? data.candidates : [];
    const urls = [];

    for (const candidate of candidates) {
        const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
            ? candidate.content.parts
            : [];
        for (const part of parts) {
            const inline = part && (part.inlineData || part.inline_data);
            if (inline && inline.data) {
                const mimeType = inline.mimeType || inline.mime_type || (mediaType === 'video' ? 'video/mp4' : 'image/png');
                urls.push(`data:${mimeType};base64,${inline.data}`);
            }
            const fileData = part && (part.fileData || part.file_data);
            if (fileData && (fileData.fileUri || fileData.file_uri)) {
                urls.push(fileData.fileUri || fileData.file_uri);
            }
        }
    }

    return urls;
}

async function generateGoogleImageFallback(modelId, payload) {
    const googleModel = getGoogleImageModelId(modelId);
    if (!googleModel || !GOOGLE_API_KEY) return null;

    const body = {
        contents: [{ role: 'user', parts: buildImageParts(payload) }],
    };

    const config = {};
    const imageConfig = {};
    if (payload.aspect_ratio) imageConfig.aspect_ratio = String(payload.aspect_ratio);
    const imageSize = mapImageSize(payload.resolution || payload.image_size);
    if (imageSize) imageConfig.image_size = imageSize;
    if (Object.keys(imageConfig).length) config.image_config = imageConfig;
    if (payload.enable_google_search || payload.enable_web_search) {
        config.tools = [{ google_search: {} }];
    }
    if (Object.keys(config).length) body.generationConfig = config;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${googleModel}:generateContent?key=${encodeURIComponent(GOOGLE_API_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
        const message = data && data.error && data.error.message ? data.error.message : `Google API error: ${response.status} ${response.statusText}`;
        throw new Error(message);
    }

    const urls = normalizeGeminiMediaParts(data, 'image');
    if (!urls.length) throw new Error('Google API returned no image data');

    return {
        provider: 'google',
        model_id: googleModel,
        completed: true,
        result: { images: urls.map((url) => ({ url })) },
    };
}

async function generateGoogleVideoFallback(modelId, payload) {
    const googleModel = getGoogleVideoModelId(modelId);
    if (!googleModel || !GOOGLE_API_KEY) return null;

    const body = {
        prompt: String(payload.prompt || ''),
    };

    const config = {};
    if (payload.aspect_ratio && payload.aspect_ratio !== 'auto') config.aspectRatio = String(payload.aspect_ratio);
    if (payload.resolution) config.resolution = String(payload.resolution);
    if (payload.duration) config.durationSeconds = Number(payload.duration) || undefined;
    if (payload.negative_prompt) config.negativePrompt = String(payload.negative_prompt);
    if (payload.generate_audio !== undefined) config.generateAudio = !!payload.generate_audio;
    Object.keys(config).forEach((key) => config[key] === undefined && delete config[key]);
    if (Object.keys(config).length) body.config = config;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${googleModel}:predictLongRunning?key=${encodeURIComponent(GOOGLE_API_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
        const message = data && data.error && data.error.message ? data.error.message : `Google API error: ${response.status} ${response.statusText}`;
        throw new Error(message);
    }

    const operationName = data && data.name ? data.name : null;
    if (!operationName) throw new Error('Google API returned no operation name');

    const operationUrl = `https://generativelanguage.googleapis.com/v1beta/${operationName}`;
    return {
        provider: 'google',
        model_id: googleModel,
        request_id: operationName,
        status_url: operationUrl,
        response_url: operationUrl,
    };
}

function normalizeGoogleOperation(data) {
    if (!data || typeof data !== 'object') return data;
    if (!data.done) {
        return { status: 'IN_PROGRESS', provider: 'google', details: data };
    }
    if (data.error) {
        return { status: 'FAILED', provider: 'google', error: data.error.message || 'Google generation failed', details: data.error };
    }

    const response = data.response || {};
    const generatedVideos = Array.isArray(response.generatedVideos) ? response.generatedVideos : [];
    const videos = [];
    for (const item of generatedVideos) {
        const video = item && item.video ? item.video : item;
        const url = video && (video.uri || video.gcsUri || video.fileUri || video.file_uri);
        if (url) videos.push({ url });
        const inline = video && (video.bytesBase64Encoded || video.data);
        if (inline) videos.push({ url: `data:video/mp4;base64,${inline}` });
    }

    return {
        status: 'COMPLETED',
        provider: 'google',
        videos,
        video: videos[0] || null,
        response,
    };
}

module.exports = {
    generateGoogleImageFallback,
    generateGoogleVideoFallback,
    getGoogleImageModelId,
    getGoogleVideoModelId,
    hasGoogleApiKey,
    normalizeGoogleOperation,
};
