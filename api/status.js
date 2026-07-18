// Vercel Serverless Function for checking fal.ai request status
// Proxies status requests to fal.ai to avoid CORS issues

const { requireAuth } = require('../lib/_auth');
const { hasGoogleApiKey, normalizeGoogleOperation } = require('../lib/_google_fallback');

const FAL_API_KEY = process.env.FAL_API_KEY || process.env.FAL_KEY;
const GOOGLE_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const KIE_API_KEY = process.env.KIE_API_KEY || process.env.KIE_KEY;

function extractDetailMessage(details) {
    if (!details) return '';

    if (typeof details === 'string') {
        const text = details.trim();
        if (!text) return '';
        try {
            const parsed = JSON.parse(text);
            return extractDetailMessage(parsed);
        } catch {
            return text;
        }
    }

    if (Array.isArray(details)) {
        for (const item of details) {
            const msg = extractDetailMessage(item);
            if (msg) return msg;
        }
        return '';
    }

    if (typeof details !== 'object') return '';

    if (Array.isArray(details.detail)) {
        for (const entry of details.detail) {
            if (entry && typeof entry === 'object') {
                const msg = typeof entry.msg === 'string' && entry.msg.trim()
                    ? entry.msg.trim()
                    : (typeof entry.message === 'string' ? entry.message.trim() : '');
                if (msg) return msg;
            }
            const nested = extractDetailMessage(entry);
            if (nested) return nested;
        }
    }

    if (typeof details.msg === 'string' && details.msg.trim()) return details.msg.trim();
    if (typeof details.message === 'string' && details.message.trim()) return details.message.trim();
    if (typeof details.error === 'string' && details.error.trim()) return details.error.trim();

    if (details.details) return extractDetailMessage(details.details);
    if (details.detail) return extractDetailMessage(details.detail);

    return '';
}

function pickBestErrorMessage(parsedErr, fallbackMessage) {
    if (!parsedErr || typeof parsedErr !== 'object') return fallbackMessage;

    const primary = typeof parsedErr.error === 'string' && parsedErr.error.trim()
        ? parsedErr.error.trim()
        : (typeof parsedErr.message === 'string' && parsedErr.message.trim() ? parsedErr.message.trim() : '');

    const detail = extractDetailMessage(parsedErr.details || parsedErr.detail || null);

    if ((!primary || /unprocessable entity/i.test(primary) || /status check failed:/i.test(primary)) && detail) {
        return detail;
    }

    if (primary && detail && !primary.toLowerCase().includes(detail.toLowerCase())) {
        return `${primary}\n${detail}`;
    }

    return primary || detail || fallbackMessage;
}

function parseMaybeJson(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function normalizeKieTaskRecord(data) {
    if (data && Number(data.code) >= 400 && !data.data) {
        return {
            status: 'FAILED',
            provider: 'kie',
            error: data.msg || data.message || 'KIE request failed',
            raw: data,
        };
    }

    const record = data && data.data && typeof data.data === 'object' ? data.data : {};
    const state = String(record.state || '').toLowerCase();
    const result = parseMaybeJson(record.resultJson) || {};
    const urls = [];
    const push = (url) => {
        const next = String(url || '').trim();
        if (next && !urls.includes(next)) urls.push(next);
    };

    if (Array.isArray(result.resultUrls)) result.resultUrls.forEach(push);
    if (Array.isArray(result.result_urls)) result.result_urls.forEach(push);
    if (Array.isArray(result.urls)) result.urls.forEach(push);
    if (Array.isArray(result.imageUrls)) result.imageUrls.forEach(push);
    if (Array.isArray(result.images)) {
        for (const image of result.images) push(image && (image.url || image));
    }
    if (result.url) push(result.url);

    if (state === 'success') {
        return {
            status: 'COMPLETED',
            provider: 'kie',
            taskId: record.taskId || null,
            images: urls.map((url) => ({ url })),
            videos: urls.map((url) => ({ url })),
            resultUrls: urls,
            resultJson: result,
            raw: data,
        };
    }
    if (state === 'fail' || state === 'failed') {
        const resultError = extractDetailMessage(result);
        const topLevelMessage = typeof data.msg === 'string' && !/^success$/i.test(data.msg.trim()) ? data.msg.trim() : '';
        let failureMessage = record.failMsg || resultError || topLevelMessage || 'KIE generation failed';
        if (/^generation failed$/i.test(failureMessage) && /grok-imagine/i.test(String(record.model || ''))) {
            failureMessage = 'Grok временно не смог обработать запрос. Выберите фото заново и запускайте только одно видео за раз.';
        }
        return {
            status: 'FAILED',
            provider: 'kie',
            error: record.failCode && !failureMessage.includes(record.failCode)
                ? `${failureMessage} (${record.failCode})`
                : failureMessage,
            failCode: record.failCode || '',
            raw: data,
        };
    }
    return {
        status: 'IN_PROGRESS',
        provider: 'kie',
        state: record.state || 'waiting',
        progress: record.progress || 0,
        raw: data,
    };
}

module.exports = async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!requireAuth(req, res)) {
        return;
    }

    const rawStatusUrl = req.query && req.query.statusUrl ? String(req.query.statusUrl) : '';
    const isGoogleStatusUrl = /^https:\/\/generativelanguage\.googleapis\.com\//i.test(rawStatusUrl);
    const isKieStatusUrl = /^https:\/\/api\.kie\.ai\//i.test(rawStatusUrl);
    if (!FAL_API_KEY && (!isGoogleStatusUrl || !hasGoogleApiKey()) && (!isKieStatusUrl || !KIE_API_KEY)) {
        return res.status(500).json({ error: 'FAL_KEY environment variable not configured' });
    }

    try {
        const { statusUrl } = req.query;

        if (!statusUrl) {
            return res.status(400).json({ error: 'statusUrl parameter is required' });
        }

        let parsed;
        try {
            parsed = new URL(statusUrl);
        } catch {
            return res.status(400).json({ error: 'Invalid statusUrl' });
        }

        if (parsed.protocol !== 'https:') {
            return res.status(400).json({ error: 'statusUrl must be https' });
        }

        const allowedHosts = new Set(['queue.fal.run', 'generativelanguage.googleapis.com', 'api.kie.ai']);
        if (!allowedHosts.has(parsed.hostname)) {
            return res.status(400).json({ error: 'statusUrl host not allowed' });
        }

        const isGoogleRequest = parsed.hostname === 'generativelanguage.googleapis.com';
        const isKieRequest = parsed.hostname === 'api.kie.ai';
        if (isGoogleRequest && !GOOGLE_API_KEY) {
            return res.status(500).json({ error: 'GEMINI_API_KEY environment variable not configured' });
        }
        if (isKieRequest && !KIE_API_KEY) {
            return res.status(500).json({ error: 'KIE_API_KEY environment variable not configured' });
        }
        if (isGoogleRequest && !parsed.searchParams.has('key')) {
            parsed.searchParams.set('key', GOOGLE_API_KEY);
        }

        // Fetch status from fal.ai, Google Gemini/Veo, or KIE.
        const response = await fetch(parsed.toString(), {
            method: 'GET',
            headers: isGoogleRequest ? {
                'Content-Type': 'application/json'
            } : isKieRequest ? {
                'Authorization': `Bearer ${KIE_API_KEY}`,
                'Content-Type': 'application/json'
            } : {
                'Authorization': `Key ${FAL_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('FAL Status Error:', errorText);
            let parsedErr;
            try {
                parsedErr = JSON.parse(errorText);
            } catch {
                parsedErr = null;
            }

            const fallbackMessage = `Status check failed: ${response.statusText}`;
            const bestMessage = pickBestErrorMessage(parsedErr, fallbackMessage);

            return res.status(response.status).json({
                error: bestMessage,
                details: parsedErr || errorText,
                status: response.status,
            });
        }

        const data = await response.json();

        // Forward the response
        return res.status(200).json(isGoogleRequest ? normalizeGoogleOperation(data) : (isKieRequest ? normalizeKieTaskRecord(data) : data));

    } catch (error) {
        console.error('Status check error:', error);
        return res.status(500).json({
            error: error.message || 'Internal server error'
        });
    }
}
