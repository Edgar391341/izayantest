// Icons
if (window.lucide && typeof window.lucide.createIcons === 'function') {
  window.lucide.createIcons();
}

// State
let currentMode = 'tools';
let currentVideoTab = 'text-to-video';
let activeAccountStorageScope = null;
let hasExplicitAccountStorageScope = false;
let accountSyncSuspendCount = 0;

function getBridgeAccountStorageScope() {
  try {
    const bridge = window.NanoAccountBridge || null;
    if (!bridge || typeof bridge.getScopedUserId !== 'function') return null;
    const userId = bridge.getScopedUserId();
    return userId ? String(userId) : null;
  } catch (_) {
    return null;
  }
}

function setActiveAccountStorageScope(userId) {
  activeAccountStorageScope = userId ? String(userId) : null;
  hasExplicitAccountStorageScope = true;
}

function getActiveAccountStorageScope() {
  if (hasExplicitAccountStorageScope) return activeAccountStorageScope || null;
  return getBridgeAccountStorageScope() || null;
}

function getScopedStorageKey(baseKey, explicitScope) {
  const scope = explicitScope === undefined
    ? getActiveAccountStorageScope()
    : (explicitScope ? String(explicitScope) : null);
  return scope ? `${baseKey}::${scope}` : baseKey;
}

function readStoredJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function loadStoredArray(baseKey) {
  const value = readStoredJson(getScopedStorageKey(baseKey), []);
  return Array.isArray(value) ? value : [];
}

function getHistoryCacheMetaKey(explicitScope) {
  return getScopedStorageKey('nano_history_meta', explicitScope);
}

function createHistoryClientId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `hist_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function ensureHistoryItemIdentity(item) {
  if (!item || typeof item !== 'object') return item;
  if (!item.id || typeof item.id !== 'string') {
    item.id = createHistoryClientId();
  }
  return item;
}

function getHistoryPrimaryUrl(item) {
  const meta = item && item.meta && typeof item.meta === 'object' ? item.meta : null;
  return (
    (meta && (meta.originalDownloadUrl || meta.originalUrl || meta.previewUrl || meta.thumbnail_fallback || meta.placeholderUrl))
    || item.modelDownloadUrl
    || item.url
    || item.thumbnailUrl
    || ''
  );
}

function isHistoryImagePreviewSource(url) {
  const value = String(url || '').trim();
  if (!value) return false;
  if (/^data:image\//i.test(value)) return true;
  if (/^blob:/i.test(value)) return true;
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)(?:[\?#].*)?$/i.test(value);
}

function isHistoryOriginalEquivalentUrl(item, candidate) {
  const value = String(candidate || '').trim();
  if (!value || !item || typeof item !== 'object') return false;
  const meta = item.meta && typeof item.meta === 'object' ? item.meta : null;
  const originals = [
    item.url,
    item.modelDownloadUrl,
    meta && meta.originalUrl,
    meta && meta.originalDownloadUrl,
  ].map((entry) => String(entry || '').trim()).filter(Boolean);
  return originals.includes(value);
}

function hasUsableHistoryPreview(item, candidate = item && item.thumbnailUrl) {
  const preview = String(candidate || '').trim();
  if (!preview || !item || typeof item !== 'object') return false;
  if (item.type === 'audio') return true;
  if (item.type === 'video') return isHistoryImagePreviewSource(preview);
  if (item.type === '3d') return isHistoryImagePreviewSource(preview) || !isHistoryOriginalEquivalentUrl(item, preview);
  if (item.type === 'image') {
    if (isHistoryOriginalEquivalentUrl(item, preview) && !/^data:image\//i.test(preview)) return false;
    return true;
  }
  return true;
}

function pickHistoryPreviewCandidate(item, candidates = []) {
  for (const candidate of candidates) {
    if (hasUsableHistoryPreview(item, candidate)) return String(candidate).trim();
  }
  return '';
}

function getHistorySemanticKey(item) {
  if (!item || typeof item !== 'object') return '';
  const meta = item.meta && typeof item.meta === 'object' ? item.meta : null;
  const clientId = meta && meta.clientId ? String(meta.clientId) : '';
  if (clientId) return `client:${clientId}`;
  if (!item.cloud && item.id) return `local:${String(item.id)}`;
  const type = item.type || 'image';
  const timestamp = Number.isFinite(Number(item.timestamp)) ? Number(item.timestamp) : 0;
  const primaryUrl = getHistoryPrimaryUrl(item);
  if (primaryUrl) return `media:${type}:${timestamp}:${primaryUrl}`;
  const requestId = item.genCtx && (item.genCtx.requestId || item.genCtx.taskId || item.genCtx.jobId || item.genCtx.id)
    ? String(item.genCtx.requestId || item.genCtx.taskId || item.genCtx.jobId || item.genCtx.id)
    : '';
  if (requestId) return `req:${type}:${requestId}`;
  const prompt = item.prompt ? String(item.prompt).trim() : '';
  if (prompt) return `prompt:${type}:${timestamp}:${prompt.slice(0, 200)}`;
  return '';
}

function getHistoryIdentityKey(item, fallbackIndex = 0) {
  const semanticKey = getHistorySemanticKey(item);
  if (semanticKey) return semanticKey;
  if (item && item.id) return `id:${item.id}`;
  const type = item && item.type ? item.type : 'image';
  const primaryUrl = getHistoryPrimaryUrl(item);
  const timestamp = Number.isFinite(Number(item && item.timestamp)) ? Number(item.timestamp) : 0;
  return `fallback:${type}:${timestamp}:${primaryUrl}:${fallbackIndex}`;
}

const LOCAL_HISTORY_CACHE_LIMIT = 120;
const LOCAL_HISTORY_INLINE_THUMB_MAX_LENGTH = 18000;
const ACCOUNT_HISTORY_SYNC_STRING_LIMIT = 8192;
const ACCOUNT_HISTORY_SYNC_INLINE_DATA_LIMIT = 4096;

function normalizeHistoryItemForRuntime(item) {
  if (!item || typeof item !== 'object') return item;
  const next = item;
  const meta = next.meta && typeof next.meta === 'object' ? next.meta : null;
  const type = next.type || 'image';
  const originalUrl = meta && meta.originalUrl ? String(meta.originalUrl) : '';
  const originalDownloadUrl = meta && meta.originalDownloadUrl ? String(meta.originalDownloadUrl) : '';
  const originalResidualUrl = meta && meta.originalResidualUrl ? String(meta.originalResidualUrl) : '';
  const previewUrl = meta && meta.previewUrl ? String(meta.previewUrl) : '';
  const fallbackThumb = meta && meta.thumbnail_fallback ? String(meta.thumbnail_fallback) : '';

  ensureHistoryItemIdentity(next);

  if (type === 'video') {
    if (next.thumbnailUrl && !hasUsableHistoryPreview(next, next.thumbnailUrl)) {
      next.thumbnailUrl = null;
    }
    if ((!next.url || /^data:image\//i.test(String(next.url))) && (originalUrl || originalDownloadUrl)) {
      next.url = originalUrl || originalDownloadUrl;
    }
    if (next.thumbnailUrl && next.url && String(next.thumbnailUrl) === String(next.url)) {
      next.thumbnailUrl = fallbackThumb && fallbackThumb !== next.url ? fallbackThumb : null;
    }
    if (!next.thumbnailUrl) {
      const thumbCandidate = fallbackThumb || (previewUrl && previewUrl !== next.url ? previewUrl : '');
      if (thumbCandidate && thumbCandidate !== next.url) next.thumbnailUrl = thumbCandidate;
    }
  } else if (type === 'audio') {
    if ((!next.url || /^data:image\//i.test(String(next.url))) && (originalUrl || originalDownloadUrl)) {
      next.url = originalUrl || originalDownloadUrl;
    }
    if (!next.residualUrl && originalResidualUrl) {
      next.residualUrl = originalResidualUrl;
    }
    if (!next.thumbnailUrl) {
      next.thumbnailUrl = fallbackThumb || previewUrl || createAudioPlaceholderDataUrl('AUDIO');
    }
  } else if (type === 'image') {
    if (next.thumbnailUrl && !hasUsableHistoryPreview(next, next.thumbnailUrl)) {
      next.thumbnailUrl = null;
    }
    if (originalUrl && (!next.url || (fallbackThumb && String(next.url) === fallbackThumb))) {
      next.url = originalUrl;
    }
    if (!next.thumbnailUrl) {
      const thumbCandidate = fallbackThumb || (previewUrl && previewUrl !== next.url ? previewUrl : '');
      if (thumbCandidate && thumbCandidate !== next.url) next.thumbnailUrl = thumbCandidate;
    }
  } else if (type === '3d') {
    if (!next.url && (fallbackThumb || previewUrl)) next.url = fallbackThumb || previewUrl;
    if (!next.modelDownloadUrl && (originalDownloadUrl || originalUrl)) {
      next.modelDownloadUrl = originalDownloadUrl || originalUrl;
    }
    if (!next.thumbnailUrl && (fallbackThumb || previewUrl)) next.thumbnailUrl = fallbackThumb || previewUrl;
  }

  return next;
}

function sortHistoryItems(items) {
  return items.sort((a, b) => {
    const at = Number.isFinite(Number(a && a.timestamp)) ? Number(a.timestamp) : 0;
    const bt = Number.isFinite(Number(b && b.timestamp)) ? Number(b.timestamp) : 0;
    return bt - at;
  });
}

function dedupeHistoryItems(items) {
  const map = new Map();
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    if (!item) return;
    const normalizedItem = normalizeHistoryItemForRuntime(item);
    const key = getHistoryIdentityKey(normalizedItem, index);
    const existing = map.get(key);
    map.set(key, existing ? Object.assign(existing, normalizedItem) : normalizedItem);
  });
  return sortHistoryItems(Array.from(map.values()));
}

function buildHistoryCacheMeta(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const persistedCount = Number.isFinite(Number(options.persistedCount))
    ? Math.max(0, Math.min(list.length, Number(options.persistedCount)))
    : list.length;
  return {
    count: list.length,
    cachedCount: persistedCount,
    complete: persistedCount >= list.length,
    savedAt: Date.now(),
    newestId: list[0] && list[0].id ? list[0].id : null,
    newestTimestamp: list[0] && Number.isFinite(Number(list[0].timestamp)) ? Number(list[0].timestamp) : null,
  };
}

function getScopedHistoryCacheMeta(explicitScope) {
  const raw = readStoredJson(getHistoryCacheMetaKey(explicitScope), null);
  if (!raw || typeof raw !== 'object') {
    return { count: 0, cachedCount: 0, complete: false, savedAt: 0, newestId: null, newestTimestamp: null };
  }
  return {
    count: Number.isFinite(Number(raw.count)) ? Math.max(0, Number(raw.count)) : 0,
    cachedCount: Number.isFinite(Number(raw.cachedCount))
      ? Math.max(0, Number(raw.cachedCount))
      : (Number.isFinite(Number(raw.count)) ? Math.max(0, Number(raw.count)) : 0),
    complete: raw.complete !== false,
    savedAt: Number.isFinite(Number(raw.savedAt)) ? Number(raw.savedAt) : 0,
    newestId: raw.newestId ? String(raw.newestId) : null,
    newestTimestamp: Number.isFinite(Number(raw.newestTimestamp)) ? Number(raw.newestTimestamp) : null,
  };
}

function persistHistoryCacheMeta(items, explicitScope, options = {}) {
  try {
    localStorage.setItem(getHistoryCacheMetaKey(explicitScope), JSON.stringify(buildHistoryCacheMeta(items, options)));
  } catch (_) {}
}

function withAccountSyncSuspended(fn) {
  accountSyncSuspendCount += 1;
  try {
    return fn();
  } finally {
    accountSyncSuspendCount = Math.max(0, accountSyncSuspendCount - 1);
  }
}

function isAccountSyncSuspended() {
  return accountSyncSuspendCount > 0;
}

function isPrimaryCoarsePointer() {
  try {
    return !!(window.matchMedia && (
      window.matchMedia('(pointer: coarse)').matches
      || window.matchMedia('(hover: none)').matches
    ));
  } catch (_) {
    return false;
  }
}

function shouldSkipClientHistoryThumbnailWork() {
  return document.hidden || !!activeTouchAssetDrag;
}

function canGenerateClientHistoryThumbnail(item) {
  if (!item || !item.url || item.type === '3d' || item.type === 'audio') return false;
  if (shouldSkipClientHistoryThumbnailWork()) return false;
  if (hasUsableHistoryPreview(item)) return false;
  if (item.type === 'image' && /^data:image\//i.test(String(item.url))) return false;
  return item.type === 'video' || item.type === 'image';
}

// Start from local storage immediately so refresh never boots with an empty
// in-memory cache before the local account bridge finishes initializing.
let history = loadStoredArray('nano_history');
let tasks = loadStoredArray('nano_tasks');
const HISTORY_FILTERS = [
  { id: 'all', types: null },
  { id: 'image', types: ['image'] },
  { id: 'video', types: ['video'] },
  { id: 'audio', types: ['audio'] },
  { id: '3d', types: ['3d'] },
];
let historyViewState = { type: HISTORY_FILTERS[0].id, query: '' };
let historyHydrating = false;

const pollTimers = new Map();

const MAX_CONCURRENT_TASKS = 4;
let taskTicker = null;
let currentPreview = null;

// Gallery state for multiple outputs
let galleryItems = [];
let galleryIndex = 0;

// File state
let uploadedImageFiles = [];
let uploadedMaskFile = null;
let uploadedVideoFile = null;
let uploadedVideoImageFile = null;
let uploadedReferenceImages = [];
let uploadedSeedanceReferenceImages = [];
let uploadedSeedanceReferenceVideos = [];
let uploadedSeedanceReferenceAudios = [];
let uploadedEndImageFile = null;
let uploaded3dFrontFile = null;
let uploaded3dBackFile = null;
let uploaded3dLeftFile = null;
let uploaded3dRightFile = null;
let uploaded3dMeshyTextureImageFile = null;
let uploaded3dTopologyFile = null;
let uploaded3dRetextureModelFile = null;
let uploaded3dRetextureStyleImageFile = null;
let uploadedAudioFile = null;

// Kling 3 specific file state
let uploadedKling3StartImage = null;
let uploadedKling3EndImage = null;
let uploadedKling3Video = null;
let uploadedKling3RefImages = [];

// Tools mode state
let uploadedToolsImages = [];
let uploadedToolsUtilityImage = null;
let uploadedToolsUtilityAudio = null;
let uploadedToolsUtilityVideo = null;
const managedUploadRemoteState = Object.create(null);
let toolsCharsCount = 0;
let currentToolsTool = 'card-studio';
let currentKling3Tab = 'v3-text-to-video';
let currentKling3Family = 'v3';
let currentLtx23Family = 'text-to-video';
let currentSeedance2Family = 'text-to-video';
let kling3MultiPrompts = [];
let kling3Elements = []; // KlingV3ElementInput: { id, frontalImageFile, frontalImageUrl, referenceImageFiles, referenceImageUrls, videoFile, videoUrl }
let kling3SelectedModelByTab = {};
let kling3LastTabByFamily = { v3: 'v3-text-to-video', o3: 'o3-text-to-video' };
let kling3ControlsInitialized = false;
let ltx23SelectedModelByFamily = {};
let seedance2SelectedModelByFamily = {};

const TOOLS_TOOL_IDS = new Set(['card-studio']);
const TOOLS_TOOL_MODEL_IDS = {
  'card-studio': null,
  enhancer: 'fal-ai/topaz/upscale/image',
  'background-removal': 'pixelcut/background-removal',
  'sam-audio': 'fal-ai/sam-audio/separate',
  'heygen-translate': 'fal-ai/heygen/v2/translate/precision',
};
const SAM_AUDIO_MODEL_NOTES = {
  'fal-ai/sam-audio/separate': 'tools_sam_audio_note_separate',
  'fal-ai/sam-audio/span-separate': 'tools_sam_audio_note_span',
};
const HEYGEN_TRANSLATE_DEFAULT_LANGUAGE = 'Russian';
const HEYGEN_TRANSLATE_LANGUAGES = [
  'English', 'Spanish', 'French', 'Hindi', 'Italian', 'German', 'Polish', 'Portuguese', 'Chinese', 'Japanese', 'Dutch', 'Turkish', 'Korean',
  'Danish', 'Arabic', 'Romanian', 'Mandarin', 'Filipino', 'Swedish', 'Indonesian', 'Ukrainian', 'Greek', 'Czech', 'Bulgarian', 'Malay',
  'Slovak', 'Croatian', 'Tamil', 'Finnish', 'Russian', 'Afrikaans (South Africa)', 'Albanian (Albania)', 'Amharic (Ethiopia)',
  'Arabic (Algeria)', 'Arabic (Bahrain)', 'Arabic (Egypt)', 'Arabic (Iraq)', 'Arabic (Jordan)', 'Arabic (Kuwait)', 'Arabic (Lebanon)',
  'Arabic (Libya)', 'Arabic (Morocco)', 'Arabic (Oman)', 'Arabic (Qatar)', 'Arabic (Saudi Arabia)', 'Arabic (Syria)', 'Arabic (Tunisia)',
  'Arabic (United Arab Emirates)', 'Arabic (Yemen)', 'Armenian (Armenia)', 'Azerbaijani (Latin, Azerbaijan)', 'Bangla (Bangladesh)', 'Basque',
  'Bengali (India)', 'Bosnian (Bosnia and Herzegovina)', 'Bulgarian (Bulgaria)', 'Burmese (Myanmar)', 'Catalan', 'Chinese (Cantonese, Traditional)',
  'Chinese (Jilu Mandarin, Simplified)', 'Chinese (Mandarin, Simplified)', 'Chinese (Northeastern Mandarin, Simplified)',
  'Chinese (Southwestern Mandarin, Simplified)', 'Chinese (Taiwanese Mandarin, Traditional)', 'Chinese (Wu, Simplified)',
  'Chinese (Zhongyuan Mandarin Henan, Simplified)', 'Chinese (Zhongyuan Mandarin Shaanxi, Simplified)', 'Croatian (Croatia)',
  'Czech (Czechia)', 'Danish (Denmark)', 'Dutch (Belgium)', 'Dutch (Netherlands)', 'English (Australia)', 'English (Canada)',
  'English (Hong Kong SAR)', 'English (India)', 'English (Ireland)', 'English (Kenya)', 'English (New Zealand)', 'English (Nigeria)',
  'English (Philippines)', 'English (Singapore)', 'English (South Africa)', 'English (Tanzania)', 'English (UK)', 'English (United States)',
  'Estonian (Estonia)', 'Filipino (Philippines)', 'Finnish (Finland)', 'French (Belgium)', 'French (Canada)', 'French (France)',
  'French (Switzerland)', 'Galician', 'Georgian (Georgia)', 'German (Austria)', 'German (Germany)', 'German (Switzerland)', 'Greek (Greece)',
  'Gujarati (India)', 'Hebrew (Israel)', 'Hindi (India)', 'Hungarian (Hungary)', 'Icelandic (Iceland)', 'Indonesian (Indonesia)', 'Irish (Ireland)',
  'Italian (Italy)', 'Japanese (Japan)', 'Javanese (Latin, Indonesia)', 'Kannada (India)', 'Kazakh (Kazakhstan)', 'Khmer (Cambodia)',
  'Korean (Korea)', 'Lao (Laos)', 'Latvian (Latvia)', 'Lithuanian (Lithuania)', 'Macedonian (North Macedonia)', 'Malay (Malaysia)',
  'Malayalam (India)', 'Maltese (Malta)', 'Marathi (India)', 'Mongolian (Mongolia)', 'Nepali (Nepal)', 'Norwegian Bokmål (Norway)',
  'Pashto (Afghanistan)', 'Persian (Iran)', 'Polish (Poland)', 'Portuguese (Brazil)', 'Portuguese (Portugal)', 'Romanian (Romania)',
  'Russian (Russia)', 'Serbian (Latin, Serbia)', 'Sinhala (Sri Lanka)', 'Slovak (Slovakia)', 'Slovenian (Slovenia)', 'Somali (Somalia)',
  'Spanish (Argentina)', 'Spanish (Bolivia)', 'Spanish (Chile)', 'Spanish (Colombia)', 'Spanish (Costa Rica)', 'Spanish (Cuba)',
  'Spanish (Dominican Republic)', 'Spanish (Ecuador)', 'Spanish (El Salvador)', 'Spanish (Equatorial Guinea)', 'Spanish (Guatemala)',
  'Spanish (Honduras)', 'Spanish (Mexico)', 'Spanish (Nicaragua)', 'Spanish (Panama)', 'Spanish (Paraguay)', 'Spanish (Peru)',
  'Spanish (Puerto Rico)', 'Spanish (Spain)', 'Spanish (United States)', 'Spanish (Uruguay)', 'Spanish (Venezuela)', 'Sundanese (Indonesia)',
  'Swahili (Kenya)', 'Swahili (Tanzania)', 'Swedish (Sweden)', 'Tamil (India)', 'Tamil (Malaysia)', 'Tamil (Singapore)', 'Tamil (Sri Lanka)',
  'Telugu (India)', 'Thai (Thailand)', 'Turkish (Türkiye)', 'Ukrainian (Ukraine)', 'Urdu (India)', 'Urdu (Pakistan)', 'Uzbek (Latin, Uzbekistan)',
  'Vietnamese (Vietnam)', 'Welsh (United Kingdom)', 'Zulu (South Africa)', 'English - Your Accent', 'English - American Accent'
];
const TOPAZ_SUBJECT_MODELS = new Set(['Standard V2', 'Recovery V2']);
const TOPAZ_FACE_MODELS = new Set(['Standard V2', 'Recovery V2']);
const TOPAZ_SHARPEN_DENOISE_MODELS = new Set(['Standard V2', 'Low Resolution V2', 'CGI', 'High Fidelity V2', 'Text Refine', 'Redefine']);
const TOPAZ_FIX_COMPRESSION_MODELS = new Set(['Standard V2', 'Low Resolution V2', 'High Fidelity V2', 'Text Refine']);
const TOPAZ_MODEL_NOTES = {
  'Standard V2': 'tools_enhancer_note_standard_v2',
  'Low Resolution V2': 'tools_enhancer_note_low_resolution_v2',
  'CGI': 'tools_enhancer_note_cgi',
  'High Fidelity V2': 'tools_enhancer_note_high_fidelity_v2',
  'Text Refine': 'tools_enhancer_note_text_refine',
  'Recovery': 'tools_enhancer_note_recovery',
  'Redefine': 'tools_enhancer_note_redefine',
  'Recovery V2': 'tools_enhancer_note_recovery_v2',
  'Standard MAX': 'tools_enhancer_note_standard_max',
  'Wonder': 'tools_enhancer_note_wonder',
};
const TOPAZ_HELP_TEXT = {
  sourceImage: 'tools_help_source_image',
  sourceVideo: 'tools_help_source_video',
  model: 'tools_help_model',
  upscale_factor: 'tools_help_upscale_factor',
  output_format: 'tools_help_output_format',
  crop_to_fill: 'tools_help_crop_to_fill',
  subject_detection: 'tools_help_subject_detection',
  face_enhancement: 'tools_help_face_enhancement',
  face_enhancement_strength: 'tools_help_face_strength',
  face_enhancement_creativity: 'tools_help_face_creativity',
  sharpen: 'tools_help_sharpen',
  denoise: 'tools_help_denoise',
  fix_compression: 'tools_help_fix_compression',
  strength: 'tools_help_strength',
  detail: 'tools_help_detail',
  creativity: 'tools_help_creativity',
  texture: 'tools_help_texture',
  autoprompt: 'tools_help_autoprompt',
  prompt: 'tools_help_prompt',
  cutout_output_format: 'tools_help_cutout_output_format',
  cutout_sync_mode: 'tools_help_cutout_sync_mode',
  sourceAudio: 'tools_help_source_audio',
  sam_audio_model: 'tools_help_sam_audio_model',
  sam_audio_prompt: 'tools_help_sam_audio_prompt',
  sam_audio_predict_spans: 'tools_help_sam_audio_predict_spans',
  sam_audio_spans: 'tools_help_sam_audio_spans',
  sam_audio_reranking_candidates: 'tools_help_sam_audio_reranking_candidates',
  sam_audio_acceleration: 'tools_help_sam_audio_acceleration',
  sam_audio_max_chunk_duration: 'tools_help_sam_audio_max_chunk_duration',
  sam_audio_chunk_overlap: 'tools_help_sam_audio_chunk_overlap',
  sam_audio_use_sound_activity_ranking: 'tools_help_sam_audio_sound_activity_ranking',
  sam_audio_trim_to_span: 'tools_help_sam_audio_trim_to_span',
  sam_audio_output_format: 'tools_help_sam_audio_output_format',
  heygen_output_language: 'tools_help_heygen_output_language',
  heygen_translate_audio_only: 'tools_help_heygen_translate_audio_only',
  heygen_speaker_num: 'tools_help_heygen_speaker_num',
  heygen_dynamic_duration: 'tools_help_heygen_dynamic_duration',
};
const TOPAZ_RANGE_CONTROLS = [
  { inputId: 'toolsEnhancerUpscaleFactor', rangeId: 'toolsEnhancerUpscaleFactorRange', min: 1, max: 4, step: 0.1, precision: 1 },
  { inputId: 'toolsEnhancerFaceStrength', rangeId: 'toolsEnhancerFaceStrengthRange', min: 0, max: 1, step: 0.05, precision: 2 },
  { inputId: 'toolsEnhancerFaceCreativity', rangeId: 'toolsEnhancerFaceCreativityRange', min: 0, max: 1, step: 0.05, precision: 2 },
  { inputId: 'toolsEnhancerSharpen', rangeId: 'toolsEnhancerSharpenRange', min: 0, max: 1, step: 0.05, precision: 2 },
  { inputId: 'toolsEnhancerDenoise', rangeId: 'toolsEnhancerDenoiseRange', min: 0, max: 1, step: 0.05, precision: 2 },
  { inputId: 'toolsEnhancerFixCompression', rangeId: 'toolsEnhancerFixCompressionRange', min: 0, max: 1, step: 0.05, precision: 2 },
  { inputId: 'toolsEnhancerStrength', rangeId: 'toolsEnhancerStrengthRange', min: 0.01, max: 1, step: 0.01, precision: 2 },
  { inputId: 'toolsEnhancerDetail', rangeId: 'toolsEnhancerDetailRange', min: 0, max: 1, step: 0.05, precision: 2 },
  { inputId: 'toolsEnhancerCreativity', rangeId: 'toolsEnhancerCreativityRange', min: 1, max: 6, step: 1, precision: 0 },
  { inputId: 'toolsEnhancerTexture', rangeId: 'toolsEnhancerTextureRange', min: 1, max: 5, step: 1, precision: 0 },
  { inputId: 'toolsSamAudioRerankingCandidates', rangeId: 'toolsSamAudioRerankingCandidatesRange', min: 1, max: 7, step: 1, precision: 0 },
  { inputId: 'toolsSamAudioMaxChunkDuration', rangeId: 'toolsSamAudioMaxChunkDurationRange', min: 10, max: 60, step: 1, precision: 0 },
  { inputId: 'toolsSamAudioChunkOverlap', rangeId: 'toolsSamAudioChunkOverlapRange', min: 0, max: 30, step: 0.5, precision: 1 },
];
const TOPAZ_HELP_TARGETS = [
  { key: 'sourceImage', selector: '#toolsEnhancerWorkspace .group-label', placement: 'group' },
  { key: 'model', selector: '#toolsEnhancerModelField > label' },
  { key: 'upscale_factor', selector: '#toolsEnhancerUpscaleField > label' },
  { key: 'output_format', selector: '#toolsEnhancerOutputFormatField > label' },
  { key: 'crop_to_fill', selector: '#toolsEnhancerCropToFill', placement: 'toggle' },
  { key: 'subject_detection', selector: '#toolsEnhancerSubjectField > label' },
  { key: 'face_enhancement', selector: '#toolsEnhancerFaceEnhancement', placement: 'toggle' },
  { key: 'face_enhancement_strength', selector: '#toolsEnhancerFaceStrengthField > label' },
  { key: 'face_enhancement_creativity', selector: '#toolsEnhancerFaceCreativityField > label' },
  { key: 'sharpen', selector: '#toolsEnhancerSharpenField > label' },
  { key: 'denoise', selector: '#toolsEnhancerDenoiseField > label' },
  { key: 'fix_compression', selector: '#toolsEnhancerFixCompressionField > label' },
  { key: 'strength', selector: '#toolsEnhancerStrengthField > label' },
  { key: 'detail', selector: '#toolsEnhancerDetailField > label' },
  { key: 'creativity', selector: '#toolsEnhancerCreativityField > label' },
  { key: 'texture', selector: '#toolsEnhancerTextureField > label' },
  { key: 'autoprompt', selector: '#toolsEnhancerAutoprompt', placement: 'toggle' },
  { key: 'prompt', selector: '#toolsEnhancerPromptField > label' },
  { key: 'sourceImage', selector: '#toolsBgRemovalWorkspace .group-label', placement: 'group' },
  { key: 'cutout_output_format', selector: '#toolsBgOutputFormatField > label' },
  { key: 'cutout_sync_mode', selector: '#toolsBgSyncModeField > label' },
  { key: 'sourceAudio', selector: '#toolsSamAudioWorkspace .group-label', placement: 'group' },
  { key: 'sam_audio_model', selector: '#toolsSamAudioModelField > label' },
  { key: 'sam_audio_output_format', selector: '#toolsSamAudioOutputFormatField > label' },
  { key: 'sam_audio_prompt', selector: '#toolsSamAudioPromptField > label' },
  { key: 'sam_audio_predict_spans', selector: '#toolsSamAudioPredictSpans', placement: 'toggle' },
  { key: 'sam_audio_spans', selector: '#toolsSamAudioSpansField > label' },
  { key: 'sam_audio_reranking_candidates', selector: '#toolsSamAudioRerankingField > label' },
  { key: 'sam_audio_acceleration', selector: '#toolsSamAudioAccelerationField > label' },
  { key: 'sam_audio_max_chunk_duration', selector: '#toolsSamAudioMaxChunkField > label' },
  { key: 'sam_audio_chunk_overlap', selector: '#toolsSamAudioChunkOverlapField > label' },
  { key: 'sam_audio_use_sound_activity_ranking', selector: '#toolsSamAudioUseSoundActivityRanking', placement: 'toggle' },
  { key: 'sam_audio_trim_to_span', selector: '#toolsSamAudioTrimToSpan', placement: 'toggle' },
  { key: 'sourceVideo', selector: '#toolsHeygenWorkspace .group-label', placement: 'group' },
  { key: 'heygen_output_language', selector: '#toolsHeygenOutputLanguageField > label' },
  { key: 'heygen_speaker_num', selector: '#toolsHeygenSpeakerNumField > label' },
  { key: 'heygen_translate_audio_only', selector: '#toolsHeygenTranslateAudioOnly', placement: 'toggle' },
  { key: 'heygen_dynamic_duration', selector: '#toolsHeygenDynamicDuration', placement: 'toggle' },
];
let activeToolsHelpButton = null;
let toolsHelpPopoverEl = null;
let toolsHelpDelegationBound = false;

function toolsUiText(key, fallback = '') {
  try {
    if (window.I18N && typeof window.I18N.t === 'function') return window.I18N.t(key);
  } catch (_) {}
  return fallback || key;
}

function toolsHelpAria(labelText) {
  return toolsUiText('tools_help_aria', '{label} help').replace('{label}', labelText || toolsUiText('tools_help_title', 'Setting Help'));
}

function createAudioPlaceholderDataUrl(label = 'AUDIO') {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#1f1728"/>
          <stop offset="100%" stop-color="#0b0a10"/>
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="16" fill="url(#g)"/>
      <rect x="18" y="38" width="6" height="20" rx="3" fill="#d4915a" opacity="0.75"/>
      <rect x="30" y="30" width="6" height="36" rx="3" fill="#f2c69b" opacity="0.82"/>
      <rect x="42" y="24" width="6" height="48" rx="3" fill="#ffffff" opacity="0.92"/>
      <rect x="54" y="30" width="6" height="36" rx="3" fill="#f2c69b" opacity="0.82"/>
      <rect x="66" y="38" width="6" height="20" rx="3" fill="#d4915a" opacity="0.75"/>
      <text x="50%" y="84" dominant-baseline="middle" text-anchor="middle" fill="#e8d6c0" font-family="Arial" font-size="10" letter-spacing="1.2">${label}</text>
    </svg>`
  )}`;
}

function resolveToolsHelpButtonTitle(buttonEl) {
  if (!buttonEl) return toolsUiText('tools_help_title', 'Setting Help');
  const toggleCopy = buttonEl.closest('.tools-toggle-copy');
  if (toggleCopy) {
    const textSpan = toggleCopy.querySelector('span[data-i18n], span');
    const text = (textSpan ? textSpan.textContent : '').trim();
    if (text) return text;
  }
  const head = buttonEl.closest('.tools-setting-head, .group-label');
  if (head) {
    const textSpan = head.querySelector('span[data-i18n], span');
    const text = (textSpan ? textSpan.textContent : '').trim();
    if (text) return text;
    const plainText = Array.from(head.childNodes || [])
      .filter((node) => !(node.nodeType === 1 && node.classList && node.classList.contains('tools-help-btn')))
      .map((node) => node.textContent || '')
      .join(' ')
      .trim();
    if (plainText) return plainText;
  }
  return buttonEl.title || toolsUiText('tools_help_title', 'Setting Help');
}

function bindGlobalToolsHelpInteractions() {
  if (toolsHelpDelegationBound) return;
  toolsHelpDelegationBound = true;
  document.addEventListener('click', (event) => {
    const buttonEl = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('.tools-help-btn')
      : null;
    if (!buttonEl) return;
    event.preventDefault();
    event.stopPropagation();
    const key = buttonEl.dataset.helpKey || '';
    if (!key) return;
    openToolsHelpPopover(buttonEl, key, resolveToolsHelpButtonTitle(buttonEl));
  }, true);
}

function isRemoteAssetItem(item) {
  return !!(item && typeof item === 'object' && item.__remoteAsset && typeof item.url === 'string' && item.url);
}

function createRemoteAssetItem(payload = {}) {
  if (!payload || !payload.url) return null;
  const mimeHint = String(payload.mimeHint || '').toLowerCase();
  const type = payload.type || (mimeHint.startsWith('video/') ? 'video' : mimeHint.startsWith('audio/') ? 'audio' : 'image');
  const fallbackExt = type === 'video' ? 'mp4' : type === 'audio' ? 'mp3' : 'png';
  const name = payload.filename || deriveFilenameFromUrl(payload.url, fallbackExt);
  return {
    __remoteAsset: true,
    url: String(payload.url),
    name,
    type: payload.mimeHint || inferMimeTypeFromName(name, type === 'video' ? 'video/mp4' : type === 'audio' ? 'audio/mpeg' : 'image/png'),
    assetType: type,
  };
}

function normalizeRemoteAssetItems(value, fallbackKind = 'image') {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return list
    .map((entry) => {
      if (!entry) return null;
      if (typeof entry === 'string') {
        return createRemoteAssetItem({ url: entry, type: fallbackKind });
      }
      if (isRemoteAssetItem(entry)) return entry;
      if (typeof entry === 'object' && entry.url) {
        return createRemoteAssetItem({
          url: entry.url,
          filename: entry.name || entry.filename,
          mimeHint: entry.type || entry.mimeHint,
          type: entry.assetType || fallbackKind,
        });
      }
      return null;
    })
    .filter(Boolean);
}

function getAssetItemName(item, fallback = 'asset') {
  if (!item) return fallback;
  if (isRemoteAssetItem(item)) return item.name || deriveFilenameFromUrl(item.url, 'bin');
  return item.name || fallback;
}

function getAssetItemPreviewUrl(item) {
  if (!item) return '';
  return isRemoteAssetItem(item) ? item.url : '';
}

function clearPreviewBlobUrls(host) {
  if (!host || !Array.isArray(host._previewBlobUrls)) {
    if (host) host._previewBlobUrls = [];
    return;
  }
  host._previewBlobUrls.forEach((url) => {
    try { URL.revokeObjectURL(url); } catch (_) {}
  });
  host._previewBlobUrls = [];
}

function getPreviewSrcForAssetItem(item, host) {
  if (!item) return '';
  if (isRemoteAssetItem(item)) return item.url;
  const blobUrl = URL.createObjectURL(item);
  if (host) {
    if (!Array.isArray(host._previewBlobUrls)) host._previewBlobUrls = [];
    host._previewBlobUrls.push(blobUrl);
  }
  return blobUrl;
}

async function ensureFileLikeAssetItem(item) {
  if (!item) return null;
  if (!isRemoteAssetItem(item)) return item;
  return fetchUrlAsFile(item.url, {
    type: item.assetType || 'image',
    filename: item.name,
    mimeHint: item.type,
  });
}
const NEWS_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const GPT_IMAGE_15_TEXT_MODEL_ID = 'gpt-image-1.5';
const GPT_IMAGE_15_EDIT_MODEL_ID = 'gpt-image-1.5/edit';
const GPT_IMAGE_2_TEXT_MODEL_ID = 'openai/gpt-image-2';
const GPT_IMAGE_2_EDIT_MODEL_ID = 'openai/gpt-image-2/edit';
const GPT_IMAGE_TEXT_MODEL_IDS = new Set([GPT_IMAGE_15_TEXT_MODEL_ID, GPT_IMAGE_2_TEXT_MODEL_ID]);
const GPT_IMAGE_EDIT_MODEL_IDS = new Set([GPT_IMAGE_15_EDIT_MODEL_ID, GPT_IMAGE_2_EDIT_MODEL_ID]);
const GPT_IMAGE_15_TEXT_SIZE_OPTIONS = [
  { value: '1024x1024', label: '1024×1024' },
  { value: '1536x1024', label: '1536×1024' },
  { value: '1024x1536', label: '1024×1536' },
];
const GPT_IMAGE_15_EDIT_SIZE_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  ...GPT_IMAGE_15_TEXT_SIZE_OPTIONS,
];
const GPT_IMAGE_2_BASE_SIZE_OPTIONS = [
  { value: 'square_hd', label: 'Square HD' },
  { value: 'square', label: 'Square' },
  { value: 'portrait_4_3', label: 'Portrait 4:3' },
  { value: 'portrait_16_9', label: 'Portrait 16:9' },
  { value: 'landscape_4_3', label: 'Landscape 4:3' },
  { value: 'landscape_16_9', label: 'Landscape 16:9' },
];
const GPT_IMAGE_2_TEXT_SIZE_OPTIONS = [
  ...GPT_IMAGE_2_BASE_SIZE_OPTIONS,
  { value: 'custom', label: 'Custom' },
];
const GPT_IMAGE_2_EDIT_SIZE_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  ...GPT_IMAGE_2_BASE_SIZE_OPTIONS,
  { value: 'custom', label: 'Custom' },
];
const TEXT_OUTPUT_FORMAT_OPTIONS = [
  { value: 'jpeg', label: 'JPEG' },
  { value: 'png', label: 'PNG' },
];
const GPT_TEXT_OUTPUT_FORMAT_OPTIONS = [
  ...TEXT_OUTPUT_FORMAT_OPTIONS,
  { value: 'webp', label: 'WebP' },
];
const GPT_IMAGE_2_TEXT_DEFAULT_SIZE = 'landscape_4_3';
const GPT_IMAGE_2_EDIT_DEFAULT_SIZE = 'auto';
const GPT_IMAGE_2_TOOLS_DEFAULT_SIZE = 'custom';
const GPT_IMAGE_2_TOOLS_DEFAULT_WIDTH = 1200;
const GPT_IMAGE_2_TOOLS_DEFAULT_HEIGHT = 1600;
const GPT_IMAGE_2_MIN_PIXELS = 655360;
const GPT_IMAGE_2_MAX_PIXELS = 8294400;
const GPT_IMAGE_2_MAX_EDGE = 3840;
const DEFAULT_IMAGE_TEXT_MODEL = 'nano-banana-pro';
const DEFAULT_IMAGE_EDIT_MODEL = 'nano-banana-pro/edit';
const DEFAULT_TOOLS_MODEL = 'nano-banana-2';
const DEFAULT_3D_MODEL = 'fal-ai/meshy/v6-preview/image-to-3d';

const IMAGE_MODELS_TEXT = [
  { id: 'nano-banana-pro', label: 'Nano Banana Pro' },
  { id: 'nano-banana-2', label: 'Nano Banana 2' },
  { id: GPT_IMAGE_2_TEXT_MODEL_ID, label: 'GPT Image 2' },
  { id: 'gpt-image-1.5', label: 'GPT-Image 1.5' },
  { id: 'flux-pro-v1.1-ultra', label: 'Flux Pro v1.1 Ultra' },
];

const EDIT_MAX_IMAGES = {
  'nano-banana-2/edit': 14,
  'nano-banana-pro/edit': 14,
  [GPT_IMAGE_2_EDIT_MODEL_ID]: 4,
  'gpt-image-1.5/edit': 4,
};
function editMaxImages() {
  const sel = qs('imageModelEdit');
  const id = sel ? sel.value : DEFAULT_IMAGE_EDIT_MODEL;
  return EDIT_MAX_IMAGES[id] || EDIT_MAX_IMAGES[DEFAULT_IMAGE_EDIT_MODEL] || 4;
}

const IMAGE_MODELS_EDIT = [
  { id: 'nano-banana-pro/edit', label: 'Nano Banana Pro (Edit)' },
  { id: 'nano-banana-2/edit', label: 'Nano Banana 2 (Edit)' },
  { id: GPT_IMAGE_2_EDIT_MODEL_ID, label: 'GPT Image 2 (Edit)' },
  { id: 'gpt-image-1.5/edit', label: 'GPT-Image 1.5 (Edit)' },
];
const TOOLS_MODELS = [
  { id: 'nano-banana-2', label: 'Nano Banana 2 (KIE)' },
];
TOOLS_TOOL_MODEL_IDS['card-studio'] = DEFAULT_TOOLS_MODEL;

const THREE_D_MODELS = [
  { id: 'fal-ai/meshy/v6-preview/image-to-3d', label: 'Meshy V6 Preview (Image to 3D)', kind: 'image-to-3d', provider: 'fal' },
  { id: 'fal-ai/hunyuan3d-v3/image-to-3d', label: 'Hunyuan3D V3 (Image to 3D)', kind: 'image-to-3d', provider: 'fal' },
  { id: 'fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d', label: 'Hunyuan3D V3.1 Rapid (Image to 3D)', kind: 'image-to-3d', provider: 'fal' },
  { id: 'fal-ai/meshy/v6-preview/text-to-3d', label: 'Meshy V6 Preview (Text to 3D)', kind: 'text-to-3d', provider: 'fal' },
  { id: 'fal-ai/hunyuan3d-v3/text-to-3d', label: 'Hunyuan3D V3 (Text to 3D)', kind: 'text-to-3d', provider: 'fal' },
  { id: 'fal-ai/hunyuan-3d/v3.1/smart-topology', label: 'Hunyuan3D V3.1 Smart Topology', kind: 'topology', provider: 'fal' },
  { id: 'fal-ai/meshy/v5/retexture', label: 'Meshy V5 Retexture', kind: 'retexture', provider: 'fal' },
];

// Kling 3 Models
const KLING3_MODELS = {
  'v3-text-to-video': [
    { id: 'kling-v3-pro-t2v', label: 'Kling 3.0 Pro (Text to Video)' },
  ],
  'v3-image-to-video': [
    { id: 'kling-v3-pro-i2v', label: 'Kling 3.0 Pro (Image to Video)' },
  ],
  'v3-motion-control': [
    {
      id: 'kling-v3-pro-motion-control',
      label: 'Kling 3.0 Pro (Motion Control)',
      addedAt: '2026-03-05T00:00:00.000Z',
      newsDescriptionKey: 'news_desc_kling_v3_pro_motion',
    },
    {
      id: 'kling-v3-standard-motion-control',
      label: 'Kling 3.0 Standard (Motion Control)',
      addedAt: '2026-03-05T00:00:00.000Z',
      newsDescriptionKey: 'news_desc_kling_v3_standard_motion',
    },
  ],
  'o3-text-to-video': [
    { id: 'kling-o3-pro-t2v', label: 'Kling O3 Pro (Text to Video)' },
  ],
  'o3-image-to-video': [
    { id: 'kling-o3-pro-i2v', label: 'Kling O3 Pro (Image to Video)' },
  ],
  'o3-reference-to-video': [
    { id: 'kling-o3-pro-ref2v', label: 'Kling O3 Pro (Reference to Video)' },
  ],
  'o3-video-to-video': [
    { id: 'kling-o3-pro-v2v-ref', label: 'Kling O3 Pro (V2V Reference)' },
    { id: 'kling-o3-pro-v2v-edit', label: 'Kling O3 Pro (V2V Edit)' },
  ],
};

const KLING3_MOTION_MODEL_IDS = new Set([
  'kling-v3-standard-motion-control',
  'kling-v3-pro-motion-control',
]);

const KLING3_MODEL_TO_TAB = new Map(
  Object.entries(KLING3_MODELS).flatMap(([tab, models]) => (models || []).map((model) => [model.id, tab])),
);

const KLING3_TAB_TO_VIDEO_TAB = {
  'v3-text-to-video': 'text-to-video',
  'o3-text-to-video': 'text-to-video',
  'v3-image-to-video': 'image-to-video',
  'o3-image-to-video': 'image-to-video',
  'v3-motion-control': 'video-to-video',
  'o3-video-to-video': 'video-to-video',
  'o3-reference-to-video': 'reference-to-video',
};

const LTX23_MODELS = {
  'text-to-video': [
    { id: 'ltx-2.3-pro-t2v', label: 'Pro' },
    { id: 'ltx-2.3-fast-t2v', label: 'Fast' },
  ],
  'image-to-video': [
    { id: 'ltx-2.3-pro-i2v', label: 'Pro' },
    { id: 'ltx-2.3-fast-i2v', label: 'Fast' },
  ],
  'video-to-video': [
    { id: 'ltx-2.3-retake-v2v', label: 'Retake' },
    { id: 'ltx-2.3-extend-v2v', label: 'Extend' },
  ],
  'audio-to-video': [
    { id: 'ltx-2.3-a2v', label: 'Audio' },
  ],
};

const LTX23_MODEL_TO_FAMILY = new Map(
  Object.entries(LTX23_MODELS).flatMap(([family, models]) => (models || []).map((model) => [model.id, family])),
);

const SEEDANCE2_MODELS = {
  'text-to-video': [
    { id: 'seedance-2.0-fast-t2v', label: 'Fast' },
    { id: 'seedance-2.0-pro-t2v', label: 'Pro' },
  ],
  'image-to-video': [
    { id: 'seedance-2.0-fast-i2v', label: 'Fast' },
    { id: 'seedance-2.0-pro-i2v', label: 'Pro' },
  ],
  'reference-to-video': [
    { id: 'seedance-2.0-fast-ref2v', label: 'Fast' },
    { id: 'seedance-2.0-pro-ref2v', label: 'Pro' },
  ],
};

const SEEDANCE2_MODEL_TO_FAMILY = new Map(
  Object.entries(SEEDANCE2_MODELS).flatMap(([family, models]) => (models || []).map((model) => [model.id, family])),
);

function isKling3VideoKind(kind) {
  return String(kind || '').trim().startsWith('kling3-');
}

function getSeedance2FamilyForModelId(modelId) {
  return modelId ? (SEEDANCE2_MODEL_TO_FAMILY.get(String(modelId).trim()) || null) : null;
}

function isSeedance2VideoModelId(modelId) {
  return !!getSeedance2FamilyForModelId(modelId);
}

function getLtx23FamilyForModelId(modelId) {
  return modelId ? (LTX23_MODEL_TO_FAMILY.get(String(modelId).trim()) || null) : null;
}

function isLtx23VideoModelId(modelId) {
  return !!getLtx23FamilyForModelId(modelId);
}

function getSelectedLtx23ModelId(fallback = '') {
  if (fallback && isLtx23VideoModelId(fallback)) return fallback;
  const videoModelId = qs('videoModel') ? String(qs('videoModel').value || '').trim() : '';
  if (isLtx23VideoModelId(videoModelId)) return videoModelId;
  return '';
}

function getKling3TabForModelId(modelId) {
  return modelId ? (KLING3_MODEL_TO_TAB.get(String(modelId).trim()) || null) : null;
}

function isKling3VideoModelId(modelId) {
  return !!getKling3TabForModelId(modelId);
}

function getKling3FamilyForTab(tab) {
  return String(tab || '').startsWith('o3-') ? 'o3' : 'v3';
}

function getVideoTabForKling3Tab(tab) {
  return KLING3_TAB_TO_VIDEO_TAB[String(tab || '').trim()] || null;
}

function getSelectedKling3ModelId(fallback = '') {
  if (fallback && isKling3VideoModelId(fallback)) return fallback;
  const videoModelId = qs('videoModel') ? String(qs('videoModel').value || '').trim() : '';
  if (isKling3VideoModelId(videoModelId)) return videoModelId;
  const klingModelId = qs('kling3Model') ? String(qs('kling3Model').value || '').trim() : '';
  if (isKling3VideoModelId(klingModelId)) return klingModelId;
  return '';
}

function isKling3MotionModelId(modelId) {
  return KLING3_MOTION_MODEL_IDS.has(modelId);
}

function isKling3MotionOrientationVideo() {
  const orientation = qs('kling3MotionOrientation') ? qs('kling3MotionOrientation').value : 'video';
  return orientation === 'video';
}

let VIDEO_MODELS = [];
let VIDEO_MODEL_MAP = new Map();
let videoModelsLoaded = false;
let videoModelsPromise = null;

function qs(id) {
  return document.getElementById(id);
}

let viewportLockRaf = 0;

function syncViewportLock() {
  const viewport = window.visualViewport;
  const viewportHeight = Math.max(1, Math.round((viewport && Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : window.innerHeight) || window.innerHeight || 0));
  document.documentElement.style.setProperty('--app-vh', `${viewportHeight}px`);
  if (window.scrollX || window.scrollY || document.documentElement.scrollTop || document.body.scrollTop) {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }
}

function scheduleViewportLockSync() {
  if (viewportLockRaf) return;
  viewportLockRaf = requestAnimationFrame(() => {
    viewportLockRaf = 0;
    syncViewportLock();
  });
}

function getScrollableContainer(el) {
  let node = el ? el.parentElement : null;
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(style.overflowY || '') && node.scrollHeight > node.clientHeight + 4) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function scrollElementWithinContainer(el, options = {}) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return;
  const container = getScrollableContainer(el);
  if (!container) {
    scheduleViewportLockSync();
    return;
  }
  const { behavior = 'smooth', block = 'center' } = options;
  const containerRect = container.getBoundingClientRect();
  const targetRect = el.getBoundingClientRect();
  const targetTop = targetRect.top - containerRect.top + container.scrollTop;
  let nextTop = targetTop;

  if (block === 'center') {
    nextTop -= Math.max(0, (container.clientHeight - targetRect.height) / 2);
  } else if (block === 'nearest') {
    const currentTop = container.scrollTop;
    const currentBottom = currentTop + container.clientHeight;
    const targetBottom = targetTop + targetRect.height;
    if (targetTop < currentTop) {
      nextTop = targetTop - 12;
    } else if (targetBottom > currentBottom) {
      nextTop = targetBottom - container.clientHeight + 12;
    } else {
      scheduleViewportLockSync();
      return;
    }
  } else {
    nextTop -= 12;
  }

  container.scrollTo({ top: Math.max(0, nextTop), behavior });
  scheduleViewportLockSync();
}

window.addEventListener('resize', scheduleViewportLockSync, { passive: true });
window.addEventListener('orientationchange', scheduleViewportLockSync, { passive: true });
window.addEventListener('pageshow', scheduleViewportLockSync, { passive: true });
window.addEventListener('focus', scheduleViewportLockSync, true);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleViewportLockSync();
});
document.addEventListener('focusin', (e) => {
  const target = e.target;
  if (target && /^(INPUT|TEXTAREA|SELECT)$/i.test(target.tagName || '')) {
    setTimeout(scheduleViewportLockSync, 140);
  }
});
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', scheduleViewportLockSync, { passive: true });
  window.visualViewport.addEventListener('scroll', scheduleViewportLockSync, { passive: true });
}
scheduleViewportLockSync();

function getAccountBridge() {
  return window.NanoAccountBridge || null;
}

function queueAccountTextPresetSync() {
  if (isAccountSyncSuspended()) return;
  const bridge = getAccountBridge();
  if (bridge && typeof bridge.queueTextPresetSync === 'function') {
    bridge.queueTextPresetSync();
  }
}

function queueAccountDesignPresetSync() {
  if (isAccountSyncSuspended()) return;
  const bridge = getAccountBridge();
  if (bridge && typeof bridge.queueDesignPresetSync === 'function') {
    bridge.queueDesignPresetSync();
  }
}

function queueAccountHistoryPersist(items) {
  if (isAccountSyncSuspended()) return;
  const bridge = getAccountBridge();
  if (bridge && typeof bridge.queueHistoryPersist === 'function') {
    bridge.queueHistoryPersist(items);
  }
}

function queueAccountHistoryDelete(item) {
  if (isAccountSyncSuspended()) return;
  const bridge = getAccountBridge();
  if (bridge && typeof bridge.queueHistoryDelete === 'function') {
    bridge.queueHistoryDelete(item);
  }
}

// ---- Drag & Drop utility ----
function fileMatchesAccept(file, accept) {
  if (!accept) return true;
  const types = accept.split(',').map(t => t.trim().toLowerCase());
  const name = file.name.toLowerCase();
  const mime = (file.type || '').toLowerCase();
  for (const t of types) {
    if (t.startsWith('.') && name.endsWith(t)) return true;
    if (t.endsWith('/*') && mime.startsWith(t.slice(0, -1))) return true;
    if (mime === t) return true;
  }
  return false;
}

const INTERNAL_ASSET_MIME = 'application/x-nano-asset';

function getI18nText(key, fallback) {
  if (window.I18N && typeof window.I18N.t === 'function') {
    const translated = window.I18N.t(key);
    if (translated && translated !== key) return translated;
  }
  return fallback || key;
}

function hasTransferType(dt, type) {
  if (!dt || !dt.types) return false;
  return Array.from(dt.types).includes(type);
}

function isExternalFileTransfer(dt) {
  return hasTransferType(dt, 'Files');
}

function isInternalAssetTransfer(dt) {
  return hasTransferType(dt, INTERNAL_ASSET_MIME) || hasTransferType(dt, 'text/uri-list');
}

function canHandleDropTransfer(dt) {
  return isExternalFileTransfer(dt) || isInternalAssetTransfer(dt);
}

function isUploadSurface(target) {
  return !!(target && typeof target.closest === 'function' && target.closest('.upload-zone, .upload-area'));
}

function inferMimeTypeFromName(name, fallback = 'application/octet-stream') {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  return fallback;
}

function deriveFilenameFromUrl(url, fallbackExt = 'bin') {
  try {
    const parsed = new URL(url, window.location.origin);
    const file = parsed.pathname.split('/').pop();
    if (file) return decodeURIComponent(file);
  } catch (_) {
    const clean = String(url || '').split('?')[0].split('#')[0];
    const file = clean.split('/').pop();
    if (file) return decodeURIComponent(file);
  }
  return `asset.${fallbackExt}`;
}

function readUriList(uriList) {
  const lines = String(uriList || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => !line.startsWith('#')) || '';
}

function getInternalAssetPayload(dt, inputEl) {
  if (!dt) return null;
  let payload = null;
  if (hasTransferType(dt, INTERNAL_ASSET_MIME)) {
    try {
      payload = JSON.parse(dt.getData(INTERNAL_ASSET_MIME) || 'null');
    } catch (_) {
      payload = null;
    }
  }
  if (!payload || !payload.url) {
    const url = readUriList(dt.getData('text/uri-list'));
    if (url) payload = { url };
  }
  if (!payload || !payload.url) return null;

  const accept = String((inputEl && inputEl.accept) || '').toLowerCase();
  let inferredType = payload.type || '';
  if (!inferredType) {
    if (accept.includes('image/')) inferredType = 'image';
    else if (accept.includes('video/')) inferredType = 'video';
    else if (accept.includes('audio/')) inferredType = 'audio';
  }

  const fallbackExt = inferredType === 'image' ? 'png' : inferredType === 'video' ? 'mp4' : inferredType === 'audio' ? 'mp3' : 'bin';
  const filename = payload.filename || deriveFilenameFromUrl(payload.url, fallbackExt);
  const mimeHint = payload.mimeHint || inferMimeTypeFromName(filename, inferredType ? `${inferredType}/*` : 'application/octet-stream');

  return {
    ...payload,
    type: inferredType || payload.type || '',
    filename,
    mimeHint,
  };
}

function getDropRejectMessage(accept) {
  const normalized = String(accept || '').toLowerCase();
  if (normalized.includes('image/')) return getI18nText('drop_accept_images_only', 'This target accepts images only.');
  if (normalized.includes('video/')) return getI18nText('drop_accept_videos_only', 'This target accepts videos only.');
  if (normalized.includes('audio/')) return getI18nText('drop_accept_audio_only', 'This target accepts audio only.');
  return getI18nText('drop_accept_supported_files', 'This file type is not supported here.');
}

async function fetchUrlAsFile(url, payload = {}) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  const fallbackExt = payload.type === 'image' ? 'png' : payload.type === 'video' ? 'mp4' : payload.type === 'audio' ? 'mp3' : 'bin';
  const filename = payload.filename || deriveFilenameFromUrl(url, fallbackExt);
  return new File([blob], filename, { type: blob.type || payload.mimeHint || inferMimeTypeFromName(filename) });
}

function assignFilesToInput(inputEl, files, opts = {}) {
  const safeFiles = Array.from(files || []).filter(Boolean);
  if (!inputEl || safeFiles.length === 0) return;
  if (typeof inputEl._assignDroppedFiles === 'function') {
    inputEl._assignDroppedFiles(safeFiles, opts);
    return;
  }
  const dt = new DataTransfer();
  safeFiles.forEach((file) => dt.items.add(file));
  inputEl.files = dt.files;
  inputEl.dispatchEvent(new Event('change', { bubbles: true }));
}
function getUploadSurfaceForInput(inputEl, explicitZone) {
  if (explicitZone) return explicitZone;
  if (!inputEl || typeof inputEl.closest !== 'function') return null;
  return inputEl.closest('.upload-zone, .upload-area');
}

function ensureUploadSurfaceLoader(surfaceEl) {
  if (!surfaceEl) return null;
  let loader = surfaceEl.querySelector('.upload-surface-loader');
  if (!loader) {
    loader = document.createElement('div');
    loader.className = 'upload-surface-loader';
    loader.setAttribute('aria-hidden', 'true');
    loader.innerHTML = '<div class="spinner upload-surface-spinner"></div>';
    surfaceEl.appendChild(loader);
  }
  return loader;
}

function setUploadSurfaceLoading(surfaceEl, loading) {
  if (!surfaceEl) return;
  ensureUploadSurfaceLoader(surfaceEl);
  surfaceEl.classList.toggle('upload-loading', !!loading);
  surfaceEl.setAttribute('aria-busy', loading ? 'true' : 'false');
}

function applyInternalAssetUrlToManagedInput(inputEl, payload) {
  if (!inputEl || !payload || !payload.url) return false;
  const config = inputEl._uploadConfig;
  if (!config || !config.kind || (config.kind !== 'image' && config.kind !== 'video' && config.kind !== 'audio')) return false;
  if (payload.type && config.kind && payload.type !== config.kind) return false;
  const remoteItem = createRemoteAssetItem(payload);
  if (!remoteItem) return false;
  const nextRemote = config.multiple
    ? [...getManagedUploadRemoteItems(config), remoteItem]
    : [remoteItem];
  if (!config.multiple) config.setFiles(null);
  setManagedUploadRemoteItems(config, nextRemote);
  refreshManagedUploadUi(inputEl);
  return true;
}

function applyInternalAssetUrlToImageCollectionInput(inputEl, payload) {
  if (!inputEl || !payload || payload.type !== 'image') return false;
  const remoteItem = createRemoteAssetItem(payload);
  if (!remoteItem) return false;

  if (inputEl.id === 'imageInput') {
    const max = editMaxImages();
    if (uploadedImageFiles.length >= max) {
      showToast(window.I18N ? I18N.t('wiz_max_images').replace('{n}', max) : `Maximum ${max} images allowed`, 'error');
      return true;
    }
    uploadedImageFiles = [...uploadedImageFiles, remoteItem].slice(0, max);
    updateImagePreview();
    return true;
  }

  if (inputEl.id === 'toolsImageInput') {
    const max = wizMaxImages();
    if (uploadedToolsImages.length >= max) {
      showToast(window.I18N ? I18N.t('wiz_max_images').replace('{n}', max) : `Maximum ${max} images`, 'error');
      return true;
    }
    uploadedToolsImages = [...uploadedToolsImages, remoteItem].slice(0, max);
    updateToolsImagePreview();
    saveAppState();
    return true;
  }

  return false;
}

async function applyInternalAssetPayloadToInput(inputEl, payload, options = {}) {
  if (!inputEl || !payload || !payload.url) return false;
  const accept = inputEl.accept || '';
  const append = !!options.append;
  const surfaceEl = getUploadSurfaceForInput(inputEl, options.zoneEl);
  const uploadConfig = inputEl._uploadConfig || null;
  const sameManagedKind = !!(
    uploadConfig
    && uploadConfig.kind
    && payload.type
    && uploadConfig.kind === payload.type
  );

  if (!sameManagedKind && !fileMatchesAccept({ name: payload.filename, type: payload.mimeHint }, accept)) {
    showToast(getDropRejectMessage(accept), 'error');
    return false;
  }

  setUploadSurfaceLoading(surfaceEl, true);
  try {
    if (applyInternalAssetUrlToManagedInput(inputEl, payload)) {
      return true;
    }
    if (applyInternalAssetUrlToImageCollectionInput(inputEl, payload)) {
      return true;
    }
    const fetchedFile = await fetchUrlAsFile(payload.url, payload);
    if (!fileMatchesAccept(fetchedFile, accept)) {
      showToast(getDropRejectMessage(accept), 'error');
      return false;
    }
    assignFilesToInput(inputEl, [fetchedFile], { append, reason: options.reason || 'drop' });
    return true;
  } catch (err) {
    console.error('Failed to fetch dragged asset', err);
    showToast(getI18nText('drop_fetch_asset_failed', 'Failed to load the dragged asset.'), 'error');
    return false;
  } finally {
    setUploadSurfaceLoading(surfaceEl, false);
  }
}
function setupDropZone(zoneEl, inputEl) {
  if (!zoneEl || !inputEl) return;
  if (zoneEl._dropZoneBoundFor === inputEl.id) return;
  zoneEl._dropZoneBoundFor = inputEl.id;
  zoneEl._dropInput = inputEl;
  zoneEl.addEventListener('pointerdown', () => rememberPreferredImagePasteTarget(inputEl), true);

  const markActive = (e) => {
    if (!canHandleDropTransfer(e.dataTransfer)) return false;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    zoneEl.classList.add('drag-over');
    return true;
  };

  zoneEl.addEventListener('dragover', (e) => {
    markActive(e);
  });
  zoneEl.addEventListener('dragenter', (e) => {
    markActive(e);
  });
  zoneEl.addEventListener('dragleave', (e) => {
    if (!canHandleDropTransfer(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!zoneEl.contains(e.relatedTarget)) {
      zoneEl.classList.remove('drag-over');
    }
  });
  zoneEl.addEventListener('drop', async (e) => {
    if (!canHandleDropTransfer(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    zoneEl.classList.remove('drag-over');

    const accept = inputEl.accept || '';
    let acceptedFiles = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((file) => fileMatchesAccept(file, accept));

    if (acceptedFiles.length === 0 && isInternalAssetTransfer(e.dataTransfer)) {
      const payload = getInternalAssetPayload(e.dataTransfer, inputEl);
      if (!payload) return;
      await applyInternalAssetPayloadToInput(inputEl, payload, { append: !!inputEl.multiple, zoneEl, reason: 'drop' });
      return;
    }
    if (acceptedFiles.length === 0) {
      showToast(getDropRejectMessage(accept), 'error');
      return;
    }

    assignFilesToInput(inputEl, acceptedFiles, { append: !!inputEl.multiple, reason: 'drop' });
  });
}

// Prevent browser from opening files dropped outside upload zones
document.addEventListener('dragover', (e) => {
  if (isExternalFileTransfer(e.dataTransfer) && !isUploadSurface(e.target)) {
    e.preventDefault();
  }
});
document.addEventListener('drop', (e) => {
  if (isExternalFileTransfer(e.dataTransfer) && !isUploadSurface(e.target)) {
    e.preventDefault();
  }
  document.body.classList.remove('dragging-internal-asset');
});

let preferredImagePasteInputId = '';

function rememberPreferredImagePasteTarget(inputEl) {
  if (!inputEl || !inputEl.id) return;
  const accept = String(inputEl.accept || '').toLowerCase();
  if (!accept.includes('image/')) return;
  preferredImagePasteInputId = inputEl.id;
}

function isElementEffectivelyVisible(el) {
  let node = el;
  while (node && node.nodeType === 1) {
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    node = node.parentElement;
  }
  return !!el && document.body.contains(el);
}

function resolveVisibleUploadSurface(inputEl) {
  const surface = getUploadSurfaceForInput(inputEl);
  return surface && isElementEffectivelyVisible(surface) ? surface : null;
}

function canPasteIntoImageInputId(inputId) {
  if (!inputId) return false;
  const inputEl = qs(inputId);
  if (!inputEl) return false;
  const accept = String(inputEl.accept || '').toLowerCase();
  if (!accept.includes('image/')) return false;
  return !!resolveVisibleUploadSurface(inputEl);
}

function resolveVideoPasteImageInputId() {
  const selectedModel = getSelectedVideoModel();
  const selectedModelId = selectedModel && selectedModel.id ? String(selectedModel.id) : (qs('videoModel') ? String(qs('videoModel').value || '') : '');

  if (selectedModelId && isSeedance2VideoModelId(selectedModelId)) {
    const family = getSeedance2FamilyForModelId(selectedModelId);
    if (family === 'reference-to-video' && canPasteIntoImageInputId('seedance2ReferenceImagesInput')) return 'seedance2ReferenceImagesInput';
    if (family === 'image-to-video' && canPasteIntoImageInputId('videoImageInput')) return 'videoImageInput';
  }

  if (selectedModelId && isKling3VideoModelId(selectedModelId)) {
    if (currentKling3Tab === 'motion-control' && canPasteIntoImageInputId('kling3RefImagesInput')) return 'kling3RefImagesInput';
    if (canPasteIntoImageInputId('kling3StartImageInput')) return 'kling3StartImageInput';
    if (canPasteIntoImageInputId('kling3EndImageInput')) return 'kling3EndImageInput';
  }

  const orderedFallbacks = currentVideoTab === 'reference-to-video'
    ? ['referenceImagesInput', 'videoImageInput', 'videoEndImageInput']
    : ['videoImageInput', 'referenceImagesInput', 'videoEndImageInput'];
  return orderedFallbacks.find((inputId) => canPasteIntoImageInputId(inputId)) || '';
}

function resolveThreeDPasteImageInputId() {
  return [
    'threeDFrontInput',
    'threeDMeshyTextureImageInput',
    'threeDRetextureStyleImageInput',
    'threeDBackInput',
    'threeDLeftInput',
    'threeDRightInput',
  ].find((inputId) => canPasteIntoImageInputId(inputId)) || '';
}

function resolveCurrentImagePasteInput() {
  if (preferredImagePasteInputId && canPasteIntoImageInputId(preferredImagePasteInputId)) {
    return qs(preferredImagePasteInputId);
  }

  let fallbackInputId = '';
  if (currentMode === 'tools') {
    if (currentToolsTool === 'card-studio') fallbackInputId = canPasteIntoImageInputId('toolsImageInput') ? 'toolsImageInput' : '';
    else if (currentToolsTool === 'enhancer' || currentToolsTool === 'background-removal') fallbackInputId = canPasteIntoImageInputId('toolsUtilityImageInput') ? 'toolsUtilityImageInput' : '';
  } else if (currentMode === 'image') {
    fallbackInputId = canPasteIntoImageInputId('imageInput') ? 'imageInput' : '';
  } else if (currentMode === 'video') {
    fallbackInputId = resolveVideoPasteImageInputId();
  } else if (currentMode === '3d') {
    fallbackInputId = resolveThreeDPasteImageInputId();
  }

  return fallbackInputId ? qs(fallbackInputId) : null;
}

function appendPastedImagesToCollectionInput(inputEl, files) {
  const safeFiles = Array.from(files || []).filter(Boolean);
  if (!inputEl || !safeFiles.length) return false;

  if (inputEl.id === 'imageInput') {
    const max = editMaxImages();
    uploadedImageFiles = [...uploadedImageFiles, ...safeFiles].slice(0, max);
    updateImagePreview();
    if (uploadedImageFiles.length >= max) {
      showToast((window.I18N ? I18N.t('wiz_max_images') : 'Maximum {n} images allowed').replace('{n}', max));
    }
    return true;
  }

  if (inputEl.id === 'toolsImageInput') {
    const max = wizMaxImages();
    uploadedToolsImages = [...uploadedToolsImages, ...safeFiles].slice(0, max);
    updateToolsImagePreview();
    saveAppState();
    if (uploadedToolsImages.length >= max) {
      showToast((window.I18N ? I18N.t('wiz_max_images') : 'Maximum {n} images').replace('{n}', max));
    }
    return true;
  }

  return false;
}

function isTextEntryElement(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  const type = String(el.getAttribute('type') || 'text').toLowerCase();
  return type !== 'file';
}

function handleGlobalImagePaste(event) {
  const clipboard = event.clipboardData;
  if (!clipboard) return;
  const imageFiles = Array.from(clipboard.items || [])
    .map((item) => (item && item.kind === 'file' ? item.getAsFile() : null))
    .filter((file) => file && /^image\//i.test(String(file.type || '')));
  if (!imageFiles.length) return;

  if (isTextEntryElement(document.activeElement)) return;

  const targetInput = resolveCurrentImagePasteInput();
  if (!targetInput) {
    showToast(i18nText('toast_image_paste_no_target', 'Open an image upload area first.'), 'error');
    return;
  }

  event.preventDefault();
  rememberPreferredImagePasteTarget(targetInput);
  const handledByCollection = appendPastedImagesToCollectionInput(targetInput, imageFiles);
  if (!handledByCollection) {
    const shouldAppend = !!((targetInput._uploadConfig && targetInput._uploadConfig.multiple) || targetInput.multiple);
    assignFilesToInput(targetInput, shouldAppend ? imageFiles : [imageFiles[0]], { append: shouldAppend, reason: 'paste' });
  }
  showToast(i18nText('toast_image_pasted', 'Image pasted'));
}

function initGlobalImagePaste() {
  if (window.__nanoImagePasteInitialized) return;
  window.__nanoImagePasteInitialized = true;
  document.addEventListener('paste', handleGlobalImagePaste, true);
}

// Force-download a cross-origin URL by fetching as blob
async function forceDownload(url, filename) {
  if (!url) return;
  try {
    showToast(window.I18N ? I18N.t('toast_preparing_download') : 'Preparing download…');
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  } catch (e) {
    console.error('Download failed, falling back to new tab:', e);
    window.open(url, '_blank');
  }
}

// ---- Use as Asset ----
const ASSET_TARGETS = {
  image: [
    { label: 'Edit → Source Image', i18nKey: 'asset_edit_source', mode: 'image', inputId: 'imageInput' },
    { label: 'Edit → Mask', i18nKey: 'asset_edit_mask', mode: 'image', inputId: 'maskInput' },
    { label: '3D Hunyuan → Front View', i18nKey: 'asset_3d_hunyuan_front', mode: '3d', inputId: 'threeDFrontInput', select3dModel: 'fal-ai/hunyuan3d-v3/image-to-3d' },
    { label: '3D Hunyuan → Back View', i18nKey: 'asset_3d_hunyuan_back', mode: '3d', inputId: 'threeDBackInput', select3dModel: 'fal-ai/hunyuan3d-v3/image-to-3d' },
    { label: '3D Hunyuan → Left View', i18nKey: 'asset_3d_hunyuan_left', mode: '3d', inputId: 'threeDLeftInput', select3dModel: 'fal-ai/hunyuan3d-v3/image-to-3d' },
    { label: '3D Hunyuan → Right View', i18nKey: 'asset_3d_hunyuan_right', mode: '3d', inputId: 'threeDRightInput', select3dModel: 'fal-ai/hunyuan3d-v3/image-to-3d' },
    { label: '3D Rapid → Front Image', i18nKey: 'asset_3d_rapid_front', mode: '3d', inputId: 'threeDFrontInput', select3dModel: 'fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d' },
    { label: '3D Meshy → Texture Image', i18nKey: 'asset_3d_meshy_texture', mode: '3d', inputId: 'threeDMeshyTextureImageInput', select3dModel: 'fal-ai/meshy/v6-preview/image-to-3d' },
    { label: '3D Retexture → Style Image', i18nKey: 'asset_3d_retexture_style', mode: '3d', inputId: 'threeDRetextureStyleImageInput', select3dModel: 'fal-ai/meshy/v5/retexture' },
    { label: 'Video → Image', i18nKey: 'asset_video_image', mode: 'video', inputId: 'videoImageInput', videoTab: 'image-to-video' },
    { label: 'Video → End Frame', i18nKey: 'asset_video_end_frame', mode: 'video', inputId: 'videoEndImageInput', videoTab: 'image-to-video' },
    { label: 'Seedance → Ref Images', i18nKey: 'asset_seedance_ref_images', mode: 'video', inputId: 'seedance2ReferenceImagesInput', videoTab: 'reference-to-video', selectVideoModel: 'seedance-2.0-fast-ref2v' },
    { label: 'Tools → Enhancer Image', mode: 'tools', inputId: 'toolsUtilityImageInput', toolsTool: 'enhancer' },
    { label: 'Tools → Cutout Image', mode: 'tools', inputId: 'toolsUtilityImageInput', toolsTool: 'background-removal' },
    { label: 'Kling3 → Start Image', i18nKey: 'asset_kling3_start', mode: 'video', inputId: 'kling3StartImageInput', videoTab: 'image-to-video', kling3Tab: 'image-to-video' },
    { label: 'Kling3 → End Image', i18nKey: 'asset_kling3_end', mode: 'video', inputId: 'kling3EndImageInput', videoTab: 'image-to-video', kling3Tab: 'image-to-video' },
  ],
  video: [
    { label: 'Video → Video Input', i18nKey: 'asset_video_input', mode: 'video', inputId: 'videoInput', videoTab: 'video-to-video' },
    { label: 'Kling3 → Video Input', i18nKey: 'asset_kling3_video', mode: 'video', inputId: 'kling3VideoInput', videoTab: 'video-to-video', kling3Tab: 'video-to-video' },
    { label: 'Seedance → Ref Videos', i18nKey: 'asset_seedance_ref_videos', mode: 'video', inputId: 'seedance2ReferenceVideosInput', videoTab: 'reference-to-video', selectVideoModel: 'seedance-2.0-fast-ref2v' },
    { label: 'Tools → Heygen Translate', mode: 'tools', inputId: 'toolsUtilityVideoInput', toolsTool: 'heygen-translate' },
  ],
  audio: [
    { label: 'Video → Audio Input', mode: 'video', inputId: 'audioInput', videoTab: 'audio-to-video' },
    { label: 'Seedance → Ref Audio', i18nKey: 'asset_seedance_ref_audio', mode: 'video', inputId: 'seedance2ReferenceAudiosInput', videoTab: 'reference-to-video', selectVideoModel: 'seedance-2.0-fast-ref2v' },
    { label: 'Tools → SAM Audio', mode: 'tools', inputId: 'toolsUtilityAudioInput', toolsTool: 'sam-audio' },
  ],
  '3d': [
    { label: '3D Topology → 3D File', i18nKey: 'asset_3d_topology', mode: '3d', inputId: 'threeDTopologyFileInput', select3dModel: 'fal-ai/hunyuan-3d/v3.1/smart-topology' },
    { label: '3D Retexture → 3D Model', i18nKey: 'asset_3d_retexture_model', mode: '3d', inputId: 'threeDRetextureModelInput', select3dModel: 'fal-ai/meshy/v5/retexture' },
  ],
};

function resolveAssetTargetVideoTab(target) {
  if (!target) return null;
  if (target.mode !== 'video') return target.videoTab || null;

  // The shared video image input is used by both image-to-video and audio-to-video.
  // When the user is already in audio-to-video, keep that workflow active instead of
  // forcing the generic image-to-video tab.
  if (target.inputId === 'videoImageInput') {
    const selectedModel = getSelectedVideoModel();
    const selectedKind = selectedModel && selectedModel.kind ? selectedModel.kind : currentVideoTab;
    if (selectedKind === 'audio-to-video' || currentVideoTab === 'audio-to-video') {
      return 'audio-to-video';
    }
  }

  return target.videoTab || null;
}

let _assetMenu = null;

function closeAssetMenu() {
  if (_assetMenu) { _assetMenu.remove(); _assetMenu = null; }
}
document.addEventListener('click', (e) => {
  if (_assetMenu && !_assetMenu.contains(e.target)) closeAssetMenu();
}, true);

function showAssetMenu(anchorEl, item) {
  closeAssetMenu();
  const targets = ASSET_TARGETS[item.type];
  if (!targets || targets.length === 0) { showToast(window.I18N ? I18N.t('toast_no_placement') : 'No available placements for this type', 'error'); return; }

  const menu = document.createElement('div');
  menu.className = 'asset-menu';
  targets.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'asset-menu-item';
    btn.textContent = (t.i18nKey && window.I18N) ? I18N.t(t.i18nKey) : t.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAssetMenu();
      applyAsset(item, t);
    });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  _assetMenu = menu;

  // Position near anchor
  const rect = anchorEl.getBoundingClientRect();
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 100;
  let top = rect.bottom + 4;
  let left = rect.left;
  if (left + mw > window.innerWidth) left = window.innerWidth - mw - 8;
  if (left < 4) left = 4;
  if (top + mh > window.innerHeight) top = rect.top - mh - 4;
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
}

async function applyAsset(item, target) {
  const url = item.type === '3d' ? (item.modelDownloadUrl || item.glbUrl) : item.url;
  if (!url) { showToast(window.I18N ? I18N.t('toast_no_url') : 'No URL available', 'error'); return; }

  showToast(window.I18N ? I18N.t('toast_setting_asset') : 'Setting asset…');

  // 1. Switch mode if needed
  if (target.mode && target.mode !== currentMode) {
    switchMode(target.mode);
  }

  if (target.mode === 'tools' && target.toolsTool) {
    switchToolsTool(target.toolsTool, { skipSave: true, force: true });
  }

  // 2. Navigate to the correct sub-section within the mode
  if (target.select3dModel) {
    const sel = qs('threeDModel');
    if (sel && sel.value !== target.select3dModel) {
      sel.value = target.select3dModel;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    update3dUiVisibility();
  }

  if (target.selectVideoModel) {
    await ensureVideoModelsReady();
    const videoSel = qs('videoModel');
    if (videoSel && videoSel.value !== target.selectVideoModel) {
      videoSel.value = target.selectVideoModel;
      videoSel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  const targetVideoTab = resolveAssetTargetVideoTab(target);
  if (targetVideoTab) {
    ensureVideoControls();
    switchVideoTab(targetVideoTab);
  }

  if (target.kling3Tab) {
    // Determine the full tab name using the current kling3 family
    const family = currentKling3Family || 'v3';
    const suffix = target.kling3Tab; // e.g. 'image-to-video', 'video-to-video'
    // video-to-video and reference-to-video only exist in o3
    let fullTab;
    if (suffix === 'video-to-video' || suffix === 'reference-to-video') {
      fullTab = 'o3-' + suffix;
      if (currentKling3Family !== 'o3') switchKling3Family('o3');
    } else {
      fullTab = family + '-' + suffix;
    }
    switchKling3Tab(fullTab);
    updateKling3UiVisibility();
  }

  // Small delay to let UI update after section switches
  await new Promise(r => setTimeout(r, 150));

  try {
    const fallbackExt = item.type === 'video' ? 'mp4' : item.type === '3d' ? (item.modelFormat || 'glb') : 'png';
    const file = await fetchUrlAsFile(url, {
      type: item.type === '3d' ? 'file' : item.type,
      filename: deriveFilenameFromUrl(url, fallbackExt),
      mimeHint: item.type === 'video' ? 'video/mp4' : item.type === '3d' ? 'application/octet-stream' : 'image/png',
    });
    const inputEl = qs(target.inputId);
    if (!inputEl) { showToast(window.I18N ? I18N.t('toast_input_not_found') : 'Input not found - section may not be loaded', 'error'); return; }

    assignFilesToInput(inputEl, [file], { append: false, reason: 'asset' });

    // Close media modal if open so user can see the target section
    const modal = qs('mediaModal');
    if (modal && modal.style.display && modal.style.display !== 'none') {
      closeMediaModal();
    }

    // Scroll the target into view
    const scrollTarget = inputEl.closest('.upload-zone, .upload-item, .setting-group, .form-group');
    if (scrollTarget) {
      setTimeout(() => scrollElementWithinContainer(scrollTarget, { behavior: 'smooth', block: 'center' }), 100);
    }

    showToast(window.I18N ? I18N.t('toast_asset_applied') : 'Asset applied!');
  } catch (e) {
    console.error('Apply asset failed:', e);
    showToast((window.I18N ? I18N.t('toast_failed_asset') : 'Failed to set asset: ') + (e.message || e), 'error');
  }
}

const MANAGED_UPLOADS = {
  maskInput: { labelId: 'maskUploadLabel', emptyKey: 'upload_mask', previewKind: 'image', kind: 'image', multiple: false, getFiles: () => uploadedMaskFile ? [uploadedMaskFile] : [], setFiles: (next) => { uploadedMaskFile = next || null; } },
  videoInput: { labelId: 'videoFileLabel', emptyKey: 'upload_video', previewKind: 'video', kind: 'video', multiple: false, remoteUrlInputId: 'videoUrlInput', getFiles: () => uploadedVideoFile ? [uploadedVideoFile] : [], setFiles: (next) => { uploadedVideoFile = next || null; } },
  videoImageInput: { labelId: 'videoImageLabel', emptyKey: 'select_image', previewKind: 'image', kind: 'image', multiple: false, getFiles: () => uploadedVideoImageFile ? [uploadedVideoImageFile] : [], setFiles: (next) => { uploadedVideoImageFile = next || null; } },
  referenceImagesInput: { labelId: 'refImagesLabel', emptyKey: 'select_images', previewKind: 'image', kind: 'image', multiple: true, getFiles: () => uploadedReferenceImages, setFiles: (next) => { uploadedReferenceImages = next; } },
  seedance2ReferenceImagesInput: { labelId: 'seedance2RefImagesLabel', emptyKey: 'select_images', previewKind: 'image', kind: 'image', multiple: true, getFiles: () => uploadedSeedanceReferenceImages, setFiles: (next) => { uploadedSeedanceReferenceImages = next; } },
  seedance2ReferenceVideosInput: { labelId: 'seedance2RefVideosLabel', emptyKey: 'upload_video', previewKind: 'video', kind: 'video', multiple: true, getFiles: () => uploadedSeedanceReferenceVideos, setFiles: (next) => { uploadedSeedanceReferenceVideos = next; } },
  seedance2ReferenceAudiosInput: { labelId: 'seedance2RefAudiosLabel', emptyKey: 'select_audio', kind: 'audio', multiple: true, showFileName: true, getFiles: () => uploadedSeedanceReferenceAudios, setFiles: (next) => { uploadedSeedanceReferenceAudios = next; } },
  videoEndImageInput: { labelId: 'endImageLabel', emptyKey: 'select_image', previewKind: 'image', kind: 'image', multiple: false, getFiles: () => uploadedEndImageFile ? [uploadedEndImageFile] : [], setFiles: (next) => { uploadedEndImageFile = next || null; } },
  audioInput: { labelId: 'audioFileLabel', emptyKey: 'select_audio', kind: 'audio', multiple: false, showFileName: true, getFiles: () => uploadedAudioFile ? [uploadedAudioFile] : [], setFiles: (next) => { uploadedAudioFile = next || null; } },
  toolsUtilityImageInput: { labelId: 'toolsUtilityImageLabel', emptyKey: 'select_image', previewKind: 'image', kind: 'image', multiple: false, getFiles: () => uploadedToolsUtilityImage ? [uploadedToolsUtilityImage] : [], setFiles: (next) => { uploadedToolsUtilityImage = next || null; } },
  toolsUtilityAudioInput: { labelId: 'toolsUtilityAudioLabel', emptyKey: 'select_audio', kind: 'audio', multiple: false, showFileName: true, getFiles: () => uploadedToolsUtilityAudio ? [uploadedToolsUtilityAudio] : [], setFiles: (next) => { uploadedToolsUtilityAudio = next || null; } },
  toolsUtilityVideoInput: { labelId: 'toolsUtilityVideoLabel', emptyKey: 'upload_video', previewKind: 'video', kind: 'video', multiple: false, showFileName: true, getFiles: () => uploadedToolsUtilityVideo ? [uploadedToolsUtilityVideo] : [], setFiles: (next) => { uploadedToolsUtilityVideo = next || null; } },
  kling3StartImageInput: { labelId: 'kling3StartImageLabel', emptyKey: 'select_image', previewKind: 'image', kind: 'image', multiple: false, getFiles: () => uploadedKling3StartImage ? [uploadedKling3StartImage] : [], setFiles: (next) => { uploadedKling3StartImage = next || null; } },
  kling3EndImageInput: { labelId: 'kling3EndImageLabel', emptyKey: 'select_image', previewKind: 'image', kind: 'image', multiple: false, getFiles: () => uploadedKling3EndImage ? [uploadedKling3EndImage] : [], setFiles: (next) => { uploadedKling3EndImage = next || null; } },
  kling3VideoInput: { labelId: 'kling3VideoLabel', emptyKey: 'upload_video', previewKind: 'video', kind: 'video', multiple: false, remoteUrlInputId: 'kling3VideoUrlInput', getFiles: () => uploadedKling3Video ? [uploadedKling3Video] : [], setFiles: (next) => { uploadedKling3Video = next || null; } },
  kling3RefImagesInput: { labelId: 'kling3RefImagesLabel', emptyKey: 'select_images', previewKind: 'image', kind: 'image', multiple: true, getFiles: () => uploadedKling3RefImages, setFiles: (next) => { uploadedKling3RefImages = next; } },
  threeDFrontInput: { labelId: 'threeDFrontLabel', emptyKey: 'upload_front', previewKind: 'image', kind: 'image', multiple: false, getFiles: () => uploaded3dFrontFile ? [uploaded3dFrontFile] : [], setFiles: (next) => { uploaded3dFrontFile = next || null; } },
  threeDBackInput: { labelId: 'threeDBackLabel', emptyKey: 'upload_front', previewKind: 'image', kind: 'image', multiple: false, getFiles: () => uploaded3dBackFile ? [uploaded3dBackFile] : [], setFiles: (next) => { uploaded3dBackFile = next || null; } },
  threeDLeftInput: { labelId: 'threeDLeftLabel', emptyKey: 'upload_front', previewKind: 'image', kind: 'image', multiple: false, getFiles: () => uploaded3dLeftFile ? [uploaded3dLeftFile] : [], setFiles: (next) => { uploaded3dLeftFile = next || null; } },
  threeDRightInput: { labelId: 'threeDRightLabel', emptyKey: 'upload_front', previewKind: 'image', kind: 'image', multiple: false, getFiles: () => uploaded3dRightFile ? [uploaded3dRightFile] : [], setFiles: (next) => { uploaded3dRightFile = next || null; } },
  threeDMeshyTextureImageInput: { labelId: 'threeDMeshyTextureImageLabel', emptyKey: 'upload_texture', previewKind: 'image', kind: 'image', multiple: false, getFiles: () => uploaded3dMeshyTextureImageFile ? [uploaded3dMeshyTextureImageFile] : [], setFiles: (next) => { uploaded3dMeshyTextureImageFile = next || null; } },
  threeDTopologyFileInput: { labelId: 'threeDTopologyFileLabel', emptyKey: 'upload_glb_obj', kind: 'file', multiple: false, showFileName: true, getFiles: () => uploaded3dTopologyFile ? [uploaded3dTopologyFile] : [], setFiles: (next) => { uploaded3dTopologyFile = next || null; } },
  threeDRetextureModelInput: { labelId: 'threeDRetextureModelLabel', emptyKey: 'upload_3d_model', kind: 'file', multiple: false, showFileName: true, getFiles: () => uploaded3dRetextureModelFile ? [uploaded3dRetextureModelFile] : [], setFiles: (next) => { uploaded3dRetextureModelFile = next || null; } },
  threeDRetextureStyleImageInput: { labelId: 'threeDRetextureStyleImageLabel', emptyKey: 'upload_style', previewKind: 'image', kind: 'image', multiple: false, getFiles: () => uploaded3dRetextureStyleImageFile ? [uploaded3dRetextureStyleImageFile] : [], setFiles: (next) => { uploaded3dRetextureStyleImageFile = next || null; } },
};

Object.entries(MANAGED_UPLOADS).forEach(([inputId, config]) => {
  if (!config.inputId) config.inputId = inputId;
  if (!config.stateKey) config.stateKey = inputId;
});

function toManagedFileArray(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

function getManagedUploadFiles(config) {
  if (!config) return [];
  const files = toManagedFileArray(config.getFiles ? config.getFiles() : []);
  if (files.length > 0) return files;
  const inputEl = config.inputId ? qs(config.inputId) : null;
  if (inputEl && inputEl.files && inputEl.files.length) {
    return Array.from(inputEl.files).filter(Boolean);
  }
  return [];
}

function getManagedUploadPrimarySource(config, legacyFallback = null) {
  const remoteItems = getManagedUploadRemoteItems(config);
  if (remoteItems[0]) return remoteItems[0];
  const files = getManagedUploadFiles(config);
  if (files[0]) return files[0];
  return legacyFallback || null;
}

function getManagedUploadStateKey(config) {
  if (!config) return '';
  return config.stateKey || config.inputId || '';
}

function getManagedUploadRemoteItems(config) {
  if (!config) return [];
  if (typeof config.getRemoteItems === 'function') {
    return normalizeRemoteAssetItems(config.getRemoteItems(), config.kind || config.previewKind || 'image');
  }
  if (config.remoteUrlInputId) {
    const remoteUrl = getManagedUploadRemoteUrl(config);
    return remoteUrl ? normalizeRemoteAssetItems([remoteUrl], config.kind || config.previewKind || 'image') : [];
  }
  const key = getManagedUploadStateKey(config);
  return key ? normalizeRemoteAssetItems(managedUploadRemoteState[key], config.kind || config.previewKind || 'image') : [];
}

function setManagedUploadRemoteItems(config, value) {
  if (!config) return;
  const items = normalizeRemoteAssetItems(value, config.kind || config.previewKind || 'image');
  if (typeof config.setRemoteItems === 'function') {
    config.setRemoteItems(config.multiple ? items : (items[0] || null));
    return;
  }
  if (config.remoteUrlInputId) {
    setManagedUploadRemoteUrl(config, items[0] ? items[0].url : '');
    return;
  }
  const key = getManagedUploadStateKey(config);
  if (key) managedUploadRemoteState[key] = config.multiple ? items : (items[0] ? [items[0]] : []);
}

function getManagedUploadRemoteUrl(config) {
  if (!config || !config.remoteUrlInputId) return '';
  const remoteInput = qs(config.remoteUrlInputId);
  return remoteInput ? String(remoteInput.value || '').trim() : '';
}

function setManagedUploadRemoteUrl(config, value) {
  if (!config || !config.remoteUrlInputId) return;
  const remoteInput = qs(config.remoteUrlInputId);
  if (!remoteInput) return;
  remoteInput.value = value || '';
  remoteInput.dispatchEvent(new Event('input', { bubbles: true }));
  remoteInput.dispatchEvent(new Event('change', { bubbles: true }));
}

function getManagedUploadLabel(config, files) {
  if (!config) return '';
  const remoteItems = getManagedUploadRemoteItems(config);
  if (!files.length && remoteItems.length > 0) {
    const kind = config.kind || config.previewKind || 'file';
    const singleKey = config.selectedSingleKey || (kind === 'image' ? 'upload_selected_image' : kind === 'video' ? 'upload_selected_video' : kind === 'audio' ? 'upload_selected_audio' : 'upload_selected_file');
    return getI18nText(singleKey, 'Selected file');
  }
  const totalItems = files.length + remoteItems.length;
  if (totalItems === 0) return getI18nText(config.emptyKey, config.emptyFallback || '');
  const kind = config.kind || config.previewKind || 'file';
  if (config.multiple) {
    const multiKey = config.selectedMultiKey || (kind === 'image' ? 'upload_selected_images' : 'upload_selected_files');
    return getI18nText(multiKey, 'Selected items').replace('{n}', totalItems);
  }
  const singleKey = config.selectedSingleKey || (kind === 'image' ? 'upload_selected_image' : kind === 'video' ? 'upload_selected_video' : kind === 'audio' ? 'upload_selected_audio' : 'upload_selected_file');
  const prefix = getI18nText(singleKey, 'Selected file');
  const firstItem = remoteItems[0] || files[0];
  return config.showFileName ? `${prefix}: ${getAssetItemName(firstItem, 'file')}` : prefix;
}

function cleanupCompactPreviewHost(host) {
  if (!host) return;
  if (Array.isArray(host._blobUrls)) {
    host._blobUrls.forEach((url) => URL.revokeObjectURL(url));
  }
  host._blobUrls = [];
  host.innerHTML = '';
}

function ensureCompactPreviewHost(inputEl) {
  if (!inputEl) return null;
  if (inputEl._compactPreviewHost && inputEl._compactPreviewHost.isConnected) return inputEl._compactPreviewHost;
  const zone = inputEl.closest('.upload-zone, .upload-area');
  if (!zone || !zone.parentElement) return null;
  const selector = `.compact-upload-preview[data-input-id="${inputEl.id}"]`;
  let host = zone.parentElement.querySelector(selector);
  if (!host) {
    host = document.createElement('div');
    host.className = 'compact-upload-preview';
    host.dataset.inputId = inputEl.id;
    zone.insertAdjacentElement('afterend', host);
  }
  inputEl._compactPreviewHost = host;
  return host;
}

function detectPreviewKind(file, config) {
  if (config && config.previewKind) return config.previewKind;
  const type = String((file && file.type) || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return null;
}

function renderCompactPreviewForInput(inputEl, config) {
  if (!inputEl || !config) return;
  const host = ensureCompactPreviewHost(inputEl);
  if (!host) return;
  cleanupCompactPreviewHost(host);

  const files = getManagedUploadFiles(config);
  const remoteItems = getManagedUploadRemoteItems(config);
  if (!files.length && !remoteItems.length) {
    host.style.display = 'none';
    return;
  }

  const previewable = files.some((file) => !!detectPreviewKind(file, config))
    || remoteItems.some((item) => {
      const assetType = item && item.assetType ? item.assetType : (config.previewKind || config.kind || '');
      return assetType === 'image' || assetType === 'video' || assetType === 'audio';
    });
  if (!previewable) {
    host.style.display = 'none';
    return;
  }

  host.style.display = 'flex';
  const grid = document.createElement('div');
  grid.className = 'compact-upload-preview-grid';

  const entries = [
    ...remoteItems.map((item, index) => ({
      file: item,
      index,
      kind: item && item.assetType ? item.assetType : config.previewKind,
      isRemote: true,
      src: item.url,
    })),
    ...files.map((file, index) => ({
      file,
      index: remoteItems.length + index,
      kind: detectPreviewKind(file, config),
      isRemote: false,
      src: '',
    })),
  ];

  entries.forEach((entry) => {
    const { file, index, kind, isRemote, src } = entry;
    if (!kind) return;

    const tile = document.createElement('div');
    tile.className = 'compact-upload-preview-item';
    tile.title = isRemote ? src : file.name;

    const previewSrc = isRemote ? src : URL.createObjectURL(file);
    if (!isRemote && kind !== 'audio') host._blobUrls.push(previewSrc);

    if (kind === 'video') {
      const video = document.createElement('video');
      video.src = previewSrc;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.addEventListener('loadeddata', () => {
        try { video.currentTime = Math.min(0.15, video.duration || 0); } catch (_) {}
        video.play().catch(() => {});
      }, { once: true });
      tile.appendChild(video);
    } else if (kind === 'audio') {
      const img = document.createElement('img');
      img.src = createAudioPlaceholderDataUrl('AUDIO');
      img.alt = getAssetItemName(file, config.kind || 'audio');
      tile.appendChild(img);
    } else {
      const img = document.createElement('img');
      img.src = previewSrc;
      img.alt = isRemote ? getAssetItemName(file, config.kind || 'asset') : file.name;
      tile.appendChild(img);
    }

    if (config.multiple) {
      const badge = document.createElement('span');
      badge.className = 'img-num-badge';
      badge.textContent = index + 1;
      tile.appendChild(badge);
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'compact-upload-preview-remove';
    removeBtn.setAttribute('aria-label', getI18nText('btn_remove', 'Remove'));
    removeBtn.title = getI18nText('btn_remove', 'Remove');
    removeBtn.textContent = 'x';
    removeBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isRemote) {
        const nextRemote = config.multiple
          ? getManagedUploadRemoteItems(config).filter((_, remoteIndex) => remoteIndex !== index)
          : [];
        setManagedUploadRemoteItems(config, nextRemote);
        if (!config.multiple) config.setFiles(null);
        refreshManagedUploadUi(inputEl);
        return;
      }
      const nextFiles = config.multiple ? files.filter((_, fileIndex) => fileIndex !== index) : [];
      if (typeof inputEl._assignDroppedFiles === 'function') {
        inputEl._assignDroppedFiles(nextFiles, { append: false, reason: 'remove' });
      }
    });
    tile.appendChild(removeBtn);
    grid.appendChild(tile);
  });

  if (!grid.children.length) {
    host.style.display = 'none';
    return;
  }

  host.appendChild(grid);
}

function refreshManagedUploadUi(inputEl) {
  if (!inputEl || !inputEl._uploadConfig) return;
  const config = inputEl._uploadConfig;
  const files = getManagedUploadFiles(config);
  const labelEl = config.labelId ? qs(config.labelId) : null;
  if (labelEl) labelEl.textContent = getManagedUploadLabel(config, files);
  renderCompactPreviewForInput(inputEl, config);
  if (inputEl.id === 'toolsUtilityImageInput' || inputEl.id === 'toolsUtilityAudioInput' || inputEl.id === 'toolsUtilityVideoInput') refreshToolsUtilitySourceUi();
  if (inputEl.id === 'seedance2ReferenceImagesInput' || inputEl.id === 'seedance2ReferenceVideosInput' || inputEl.id === 'seedance2ReferenceAudiosInput') updateSeedance2ReferenceUi();
}

function bindManagedUploadInput(inputEl, config) {
  if (!inputEl || !config) return;
  inputEl._uploadConfig = { ...config, inputId: config.inputId || inputEl.id, stateKey: config.stateKey || inputEl.id };
  inputEl._assignDroppedFiles = (files, opts = {}) => {
    const runtimeConfig = inputEl._uploadConfig;
    const incoming = Array.from(files || []).filter(Boolean);
    const nextFiles = runtimeConfig.multiple && opts.append ? [...getManagedUploadFiles(runtimeConfig), ...incoming] : incoming;
    if (incoming.length && (!opts.append || !runtimeConfig.multiple)) {
      setManagedUploadRemoteItems(runtimeConfig, runtimeConfig.multiple && opts.append ? getManagedUploadRemoteItems(runtimeConfig) : []);
    }
    if (runtimeConfig.multiple) runtimeConfig.setFiles(nextFiles);
    else runtimeConfig.setFiles(nextFiles[0] || null);
    refreshManagedUploadUi(inputEl);
  };
  if (!inputEl._managedUploadBound) {
    inputEl._managedUploadBound = true;
    inputEl.addEventListener('change', (event) => {
      inputEl._assignDroppedFiles(Array.from(event.target.files || []), { append: false, reason: 'picker' });
      event.target.value = '';
    });
  }
  if (inputEl._uploadConfig.remoteUrlInputId && !inputEl._managedUploadRemoteBound) {
    inputEl._managedUploadRemoteBound = true;
    const remoteInput = qs(inputEl._uploadConfig.remoteUrlInputId);
    if (remoteInput) {
      const syncRemotePreview = () => refreshManagedUploadUi(inputEl);
      remoteInput.addEventListener('input', syncRemotePreview);
      remoteInput.addEventListener('change', syncRemotePreview);
    }
  }
  refreshManagedUploadUi(inputEl);
}

function bindManagedUploadById(inputId) {
  const inputEl = qs(inputId);
  const config = MANAGED_UPLOADS[inputId];
  if (inputEl && config) bindManagedUploadInput(inputEl, config);
}

function refreshAllManagedUploads() {
  Object.keys(MANAGED_UPLOADS).forEach((inputId) => {
    const inputEl = qs(inputId);
    if (inputEl && inputEl._uploadConfig) refreshManagedUploadUi(inputEl);
  });
}

function createInternalAssetPayload(item) {
  if (!item || (item.type !== 'image' && item.type !== 'video' && item.type !== 'audio')) return null;
  const meta = item && item.meta && typeof item.meta === 'object' ? item.meta : null;
  const resolvedUrl = getHistoryPrimaryUrl(item);
  if (!resolvedUrl) return null;
  const fallbackExt = item.type === 'video' ? 'mp4' : item.type === 'audio' ? (meta && meta.outputFormat ? String(meta.outputFormat).toLowerCase() : 'wav') : 'png';
  const filename = deriveFilenameFromUrl(resolvedUrl, fallbackExt);
  return {
    type: item.type,
    url: resolvedUrl,
    filename,
    mimeHint: inferMimeTypeFromName(filename, item.type === 'video' ? 'video/mp4' : item.type === 'audio' ? 'audio/wav' : 'image/png'),
  };
}

let activeTouchAssetDrag = null;
const TOUCH_ASSET_DRAG_HOLD_MS = 220;
const TOUCH_ASSET_DRAG_MOVE_SLOP_PX = 12;
let touchAssetDragCleanupSuspendUntil = 0;

function suspendTouchAssetDragCleanup(ms = 420) {
  touchAssetDragCleanupSuspendUntil = Date.now() + Math.max(0, ms);
}

function removeTouchAssetGhosts() {
  document.querySelectorAll('.touch-drag-ghost').forEach((ghost) => ghost.remove());
}

function clearTouchAssetHoverZone() {
  if (activeTouchAssetDrag && activeTouchAssetDrag.hoverZone) {
    activeTouchAssetDrag.hoverZone.classList.remove('drag-over');
    activeTouchAssetDrag.hoverZone = null;
  }
}

function flushTouchAssetDragPosition(clientX, clientY) {
  if (!activeTouchAssetDrag) return;
  positionTouchAssetGhost(clientX, clientY);
  const lastHoverX = Number.isFinite(activeTouchAssetDrag.hoverX) ? activeTouchAssetDrag.hoverX : null;
  const lastHoverY = Number.isFinite(activeTouchAssetDrag.hoverY) ? activeTouchAssetDrag.hoverY : null;
  if (
    lastHoverX === null
    || lastHoverY === null
    || Math.abs(clientX - lastHoverX) >= 8
    || Math.abs(clientY - lastHoverY) >= 8
  ) {
    activeTouchAssetDrag.hoverX = clientX;
    activeTouchAssetDrag.hoverY = clientY;
    updateTouchAssetHoverZone(clientX, clientY);
  }
}

function scheduleTouchAssetDragPosition(clientX, clientY) {
  if (!activeTouchAssetDrag) return;
  activeTouchAssetDrag.pendingX = clientX;
  activeTouchAssetDrag.pendingY = clientY;
  if (activeTouchAssetDrag.moveRaf) return;
  activeTouchAssetDrag.moveRaf = requestAnimationFrame(() => {
    if (!activeTouchAssetDrag) return;
    activeTouchAssetDrag.moveRaf = 0;
    flushTouchAssetDragPosition(activeTouchAssetDrag.pendingX, activeTouchAssetDrag.pendingY);
  });
}

function cleanupTouchAssetDrag() {
  const dragState = activeTouchAssetDrag;
  clearTouchAssetHoverZone();
  if (dragState && dragState.moveRaf) {
    cancelAnimationFrame(dragState.moveRaf);
    dragState.moveRaf = 0;
  }
  if (activeTouchAssetDrag && activeTouchAssetDrag.ghost && activeTouchAssetDrag.ghost.parentNode) {
    activeTouchAssetDrag.ghost.parentNode.removeChild(activeTouchAssetDrag.ghost);
  }
  activeTouchAssetDrag = null;
  removeTouchAssetGhosts();
  document.body.classList.remove('dragging-internal-asset', 'dragging-internal-asset-touch');
  if (dragState && dragState.deferHistoryDrawerClose) {
    closeHistoryDrawer();
  }
}

function getUploadSurfaceAtPoint(clientX, clientY) {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit || typeof hit.closest !== 'function') return null;
  const surface = hit.closest('.upload-zone, .upload-area');
  return surface && surface._dropInput ? surface : null;
}

function updateTouchAssetHoverZone(clientX, clientY) {
  if (!activeTouchAssetDrag) return null;
  const nextZone = getUploadSurfaceAtPoint(clientX, clientY);
  if (activeTouchAssetDrag.hoverZone === nextZone) return nextZone;
  clearTouchAssetHoverZone();
  if (nextZone) {
    nextZone.classList.add('drag-over');
    activeTouchAssetDrag.hoverZone = nextZone;
  }
  return nextZone;
}

function createTouchAssetGhost(payload) {
  removeTouchAssetGhosts();
  const ghost = document.createElement('div');
  ghost.className = 'touch-drag-ghost';
  ghost.dataset.assetType = payload.type || 'image';
  ghost.innerHTML = `<span>${payload.type === 'video' ? 'VIDEO' : 'IMAGE'}</span>`;
  document.body.appendChild(ghost);
  return ghost;
}

function positionTouchAssetGhost(clientX, clientY) {
  if (!activeTouchAssetDrag || !activeTouchAssetDrag.ghost) return;
  activeTouchAssetDrag.ghost.style.transform = `translate3d(${clientX}px, ${clientY}px, 0) translate(-50%, -50%)`;
}

function finishTouchAssetDrag(clientX, clientY) {
  if (!activeTouchAssetDrag) return;
  const dragState = activeTouchAssetDrag;
  const zoneEl = updateTouchAssetHoverZone(clientX, clientY) || dragState.hoverZone;
  cleanupTouchAssetDrag();

  if (zoneEl && zoneEl._dropInput && dragState.payload) {
    void applyInternalAssetPayloadToInput(zoneEl._dropInput, dragState.payload, {
      append: !!zoneEl._dropInput.multiple,
      zoneEl,
      reason: 'touch-drop',
    });
  }
}

function setInternalAssetData(dt, payload) {
  if (!dt || !payload || !payload.url) return;
  dt.effectAllowed = 'copy';
  dt.setData(INTERNAL_ASSET_MIME, JSON.stringify(payload));
  dt.setData('text/uri-list', payload.url);
  dt.setData('text/plain', payload.url);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) cleanupTouchAssetDrag();
}, true);
['pagehide', 'blur'].forEach((eventName) => {
  window.addEventListener(eventName, () => {
    cleanupTouchAssetDrag();
  }, true);
});
document.addEventListener('scroll', () => {
  if (activeTouchAssetDrag) {
    if (activeTouchAssetDrag.ignoreScrollCleanup || Date.now() < touchAssetDragCleanupSuspendUntil) return;
    cleanupTouchAssetDrag();
  }
}, true);
document.addEventListener('pointerdown', () => {
  if (activeTouchAssetDrag) cleanupTouchAssetDrag();
}, true);

function bindAssetDragSource(el, item, options = {}) {
  if (!el) return;
  const payload = createInternalAssetPayload(item);
  if (el._touchAssetStartHandler) {
    el.removeEventListener('touchstart', el._touchAssetStartHandler, true);
    el._touchAssetStartHandler = null;
  }
  if (el._touchAssetContextMenuHandler) {
    el.removeEventListener('contextmenu', el._touchAssetContextMenuHandler, true);
    el._touchAssetContextMenuHandler = null;
  }
  if (!payload) {
    el.draggable = false;
    el.classList.remove('draggable-asset');
    el.classList.remove('drag-source-touch');
    el.removeAttribute('data-drag-hint');
    el.removeAttribute('title');
    el.ondragstart = null;
    el.ondragend = null;
    return;
  }
  const touchSource = isPrimaryCoarsePointer();
  const useNativeDrag = !touchSource;
  el.draggable = useNativeDrag;
  el.classList.add('draggable-asset');
  el.classList.toggle('drag-source-touch', touchSource);
  if (options.badge !== false) {
    el.setAttribute('data-drag-hint', getI18nText('drag_asset_badge', 'Drag'));
  }
  el.title = getI18nText('drag_asset_hint', 'Drag into an upload area');
  const handleDragStartSideEffects = () => {
    if (typeof options.onDragStart === 'function') {
      options.onDragStart();
    }
  };
  const handleTouchDragStartSideEffects = () => {
    if (typeof options.onTouchDragStart === 'function') {
      options.onTouchDragStart();
      return;
    }
    handleDragStartSideEffects();
  };
  el.ondragstart = useNativeDrag ? (event) => {
    if (!event.dataTransfer) return;
    setInternalAssetData(event.dataTransfer, payload);
    document.body.classList.add('dragging-internal-asset');
    setTimeout(handleDragStartSideEffects, 0);
  } : null;
  el.ondragend = useNativeDrag ? (() => {
    document.body.classList.remove('dragging-internal-asset');
    if (typeof options.onDragEnd === 'function') {
      options.onDragEnd();
    }
  }) : null;
  if (touchSource) {
    const handleContextMenu = (event) => {
      event.preventDefault();
    };
    el._touchAssetContextMenuHandler = handleContextMenu;
    el.addEventListener('contextmenu', handleContextMenu, true);
  }
  const onTouchStart = (startEvent) => {
    if (!startEvent.touches || startEvent.touches.length !== 1) return;
    const startTouch = startEvent.touches[0];
    const startX = startTouch.clientX;
    const startY = startTouch.clientY;
    let activated = false;
    let pressTimer = null;
    let latestX = startX;
    let latestY = startY;

    const clearPressTimer = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    const teardown = () => {
      clearPressTimer();
      document.removeEventListener('touchmove', handleMove);
      document.removeEventListener('touchend', handleEnd);
      document.removeEventListener('touchcancel', handleCancel);
    };

    const activateTouchDrag = () => {
      if (activated) return;
      activated = true;
      cleanupTouchAssetDrag();
      activeTouchAssetDrag = {
        payload,
        sourceEl: el,
        hoverZone: null,
        ghost: createTouchAssetGhost(payload),
        moveRaf: 0,
        pendingX: latestX,
        pendingY: latestY,
        ignoreScrollCleanup: true,
      };
      document.body.classList.add('dragging-internal-asset', 'dragging-internal-asset-touch');
      flushTouchAssetDragPosition(latestX, latestY);
      handleTouchDragStartSideEffects();
      if (navigator.vibrate) navigator.vibrate(10);
    };

    const handleMove = (moveEvent) => {
      const touch = moveEvent.touches && moveEvent.touches[0];
      if (!touch) return;
      latestX = touch.clientX;
      latestY = touch.clientY;
      const distance = Math.hypot(latestX - startX, latestY - startY);

      if (!activated) {
        if (distance > TOUCH_ASSET_DRAG_MOVE_SLOP_PX) {
          teardown();
          cleanupTouchAssetDrag();
        }
        return;
      }

      moveEvent.preventDefault();
      scheduleTouchAssetDragPosition(latestX, latestY);
    };

    const handleEnd = (endEvent) => {
      teardown();
      if (!activated) return;
      const touch = (endEvent.changedTouches && endEvent.changedTouches[0]) || startTouch;
      endEvent.preventDefault();
      finishTouchAssetDrag(touch.clientX, touch.clientY);
    };

    const handleCancel = () => {
      teardown();
      if (activated) cleanupTouchAssetDrag();
    };

    pressTimer = setTimeout(activateTouchDrag, touchSource ? 180 : TOUCH_ASSET_DRAG_HOLD_MS);
    document.addEventListener('touchmove', handleMove, { passive: false });
    document.addEventListener('touchend', handleEnd, { passive: false });
    document.addEventListener('touchcancel', handleCancel, { passive: false });
  };
  el._touchAssetStartHandler = onTouchStart;
  el.addEventListener('touchstart', onTouchStart, { passive: false, capture: true });
}
async function reuseFromHistory(index) {
  const item = history[index];
  if (!item) return;

  const ctx = item.genCtx;

  // If no saved context, just restore the prompt
  if (!ctx) {
    if (item.prompt) {
      const pi = qs('promptInput');
      if (pi) { pi.value = item.prompt; pi.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    showToast(window.I18N ? I18N.t('toast_prompt_restored_no_settings') : 'Prompt restored (no saved settings for this item)');
    return;
  }

  // 1. Switch to the correct mode
  const normalizedMode = ctx.mode === 'kling3' ? 'video' : ctx.mode;
  if (normalizedMode) switchMode(normalizedMode);
  if (normalizedMode === 'tools' && ctx.toolsTool) {
    switchToolsTool(ctx.toolsTool, { skipSave: true, force: true });
  }

  // 2. Restore all select values
  if (ctx.selects) {
    for (const [id, val] of Object.entries(ctx.selects)) {
      const el = qs(id);
      if (el) {
        el.value = val;
        if (!el.value && el.options && el.options.length > 0) el.value = el.options[0].value;
      }
    }
  }

  // 3. Restore all input values
  if (ctx.inputs) {
    for (const [id, val] of Object.entries(ctx.inputs)) {
      const el = qs(id);
      if (el) el.value = val || '';
    }
  }

  // 4. Restore prompt
  const pi = qs('promptInput');
  if (pi) {
    pi.value = ctx.prompt || item.prompt || '';
    pi.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // 5. Navigate to the correct sub-section
  if (normalizedMode === '3d') {
    update3dUiVisibility();
  }
  if (normalizedMode === 'tools') {
    updateToolsEnhancerUi();
    if (ctx.toolsTool === 'sam-audio' && Array.isArray(ctx.samAudioSpans)) {
      restoreToolsSamAudioSpanState(ctx.samAudioSpans);
    }
    updateToolsSamAudioUi();
    updateToolsHeygenUi();
    refreshToolsUtilitySourceUi();
  }
  if (normalizedMode === 'video') {
    await ensureVideoModelsReady();
    const desiredVideoTab = ctx.videoTab || getVideoTabForKling3Tab(ctx.kling3Tab);
    if (desiredVideoTab) switchVideoTab(desiredVideoTab);

    const desiredVideoModelId = ctx.selects && (ctx.selects.videoModel || ctx.selects.kling3Model)
      ? String(ctx.selects.videoModel || ctx.selects.kling3Model)
      : '';

    if (desiredVideoModelId && qs('videoModel')) {
      refreshVideoModelDropdown(desiredVideoModelId);
      const videoSelect = qs('videoModel');
      if (videoSelect && Array.from(videoSelect.options || []).some((opt) => opt.value === desiredVideoModelId)) {
        videoSelect.value = desiredVideoModelId;
      }
      if (isKling3VideoModelId(desiredVideoModelId)) {
        syncKling3StateFromVideoModelId(desiredVideoModelId, { skipSave: true });
      }
    } else if (ctx.kling3Tab) {
      switchKling3Tab(ctx.kling3Tab, { skipSave: true });
    }

    updateVideoUiVisibility();
    renderVideoOptionsUI();
  }

  // 6. Save restored state
  if (typeof saveAppState === 'function') saveAppState();

  // 7. Scroll to the prompt input
  setTimeout(() => {
    const promptArea = qs('promptInput');
    if (promptArea) scrollElementWithinContainer(promptArea, { behavior: 'smooth', block: 'center' });
  }, 150);

  showToast(window.I18N ? I18N.t('toast_settings_restored') : 'Settings restored! Ready to generate.');
}
window.reuseFromHistory = reuseFromHistory;

function reuseCurrentPreview() {
  if (!currentPreview) { showToast(window.I18N ? I18N.t('toast_no_preview') : 'No preview to reuse', 'error'); return; }
  const idx = history.findIndex(h => h && h.timestamp === currentPreview.timestamp && h.url === currentPreview.url);
  if (idx >= 0) {
    closeMediaModal();
    reuseFromHistory(idx);
  } else if (currentPreview.genCtx) {
    closeMediaModal();
    // Directly reuse from the preview object
    const fakeIdx = history.length;
    history.push(currentPreview);
    reuseFromHistory(fakeIdx);
    history.pop();
  } else if (currentPreview.prompt) {
    closeMediaModal();
    const pi = qs('promptInput');
    if (pi) { pi.value = currentPreview.prompt; pi.dispatchEvent(new Event('input', { bubbles: true })); }
    showToast(window.I18N ? I18N.t('toast_prompt_restored') : 'Prompt restored');
  } else {
    showToast(window.I18N ? I18N.t('toast_no_settings') : 'No saved settings for this item', 'error');
  }
}
window.reuseCurrentPreview = reuseCurrentPreview;

function useCurrentPreviewAsAsset(anchorEl) {
  if (!currentPreview) { showToast(window.I18N ? I18N.t('toast_no_preview_use') : 'No preview to use', 'error'); return; }
  showAssetMenu(anchorEl, currentPreview);
}
window.useCurrentPreviewAsAsset = useCurrentPreviewAsAsset;

function useHistoryAsAsset(index, anchorEl) {
  const item = history[index];
  if (!item) return;
  showAssetMenu(anchorEl, item);
}
window.useHistoryAsAsset = useHistoryAsAsset;

async function editCurrentImage() {
  if (!currentPreview || (currentPreview.type && currentPreview.type !== 'image')) {
    showToast(window.I18N ? I18N.t('toast_no_preview_use') : 'No image to edit', 'error');
    return;
  }
  const url = currentPreview.url;
  if (!url) return;

  // 1. Switch to Edit tab
  switchMode('image');

  // 2. Set model to GPT Image 2 edit
  const modelSel = qs('imageModelEdit');
  if (modelSel) {
    modelSel.value = GPT_IMAGE_2_EDIT_MODEL_ID;
    modelSel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 3. Wait for DOM to settle
  await new Promise(r => setTimeout(r, 180));

  // 4. Fetch image, apply source-aware GPT size, and inject into imageInput
  try {
    showToast(window.I18N ? I18N.t('toast_setting_asset') : 'Setting image…');
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    let filename = 'edit-source.png';
    try { filename = new URL(url).pathname.split('/').pop() || filename; } catch(_) {}
    const file = new File([blob], filename, { type: blob.type || 'image/png' });

    let sourceWidth = null;
    let sourceHeight = null;
    try {
      const decoded = await decodeImageForUpload(file);
      sourceWidth = decoded && decoded.width ? decoded.width : null;
      sourceHeight = decoded && decoded.height ? decoded.height : null;
      if (decoded && typeof decoded.cleanup === 'function') decoded.cleanup();
    } catch (_) {
      // If dimension detection fails, GPT Image 2 edit falls back to its current size setting.
    }

    const editSizeSel = qs('editImageSize');
    const widthEl = qs('editImageWidth');
    const heightEl = qs('editImageHeight');
    const widthValueEl = qs('editImageWidthValue');
    const heightValueEl = qs('editImageHeightValue');
    if (editSizeSel && widthEl && heightEl && sourceWidth && sourceHeight) {
      editSizeSel.value = 'custom';
      widthEl.value = String(sourceWidth);
      heightEl.value = String(sourceHeight);
      if (widthValueEl) widthValueEl.value = String(sourceWidth);
      if (heightValueEl) heightValueEl.value = String(sourceHeight);
      updateGptEditControls();
    }

    const inputEl = qs('imageInput');
    if (!inputEl) { showToast(window.I18N ? I18N.t('toast_input_not_found') : 'Input not found', 'error'); return; }
    const dt = new DataTransfer();
    dt.items.add(file);
    inputEl.files = dt.files;
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));

    // Scroll controls panel to top so settings are visible
    setTimeout(() => {
      const panel = document.querySelector('.controls-scroll');
      if (panel) panel.scrollTo({ top: 0, behavior: 'smooth' });
    }, 200);

    showToast(window.I18N ? I18N.t('toast_asset_applied') : 'Ready to edit!');
  } catch (e) {
    console.error('editCurrentImage failed:', e);
    showToast((window.I18N ? I18N.t('toast_failed_asset') : 'Failed: ') + (e.message || e), 'error');
  }
}
window.editCurrentImage = editCurrentImage;

function showToast(message, kind = 'info') {
  const toast = qs('statusToast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.display = 'block';
  toast.style.opacity = '1';

  toast.style.borderColor = kind === 'error' ? '#d33' : 'rgba(255,255,255,0.12)';

  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => {
      toast.style.display = 'none';
    }, 200);
  }, 2800);
}

// Toggle history / news drawers
let _historyRendered = false;

function closeHistoryDrawer() {
  const drawer = qs('historyDrawer');
  const overlay = qs('drawerOverlay');
  if (drawer) drawer.classList.remove('drag-hidden');
  if (overlay) overlay.classList.remove('drag-hidden');
  if (drawer) drawer.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
}

function closeHistoryDrawerDuringTouchDrag() {
  suspendTouchAssetDragCleanup(420);
  const drawer = qs('historyDrawer');
  const overlay = qs('drawerOverlay');
  if (activeTouchAssetDrag) {
    activeTouchAssetDrag.deferHistoryDrawerClose = true;
  }
  if (drawer) drawer.classList.add('drag-hidden');
  if (overlay) overlay.classList.add('drag-hidden');
}

function closeHistoryDrawerDuringNativeDrag() {
  const drawer = qs('historyDrawer');
  const overlay = qs('drawerOverlay');
  if (drawer) drawer.classList.add('drag-hidden');
  if (overlay) overlay.classList.add('drag-hidden');
}

function finalizeHistoryDrawerAfterNativeDrag() {
  closeHistoryDrawer();
}

function closeNewsDrawer() {
  const drawer = qs('newsDrawer');
  const overlay = qs('newsOverlay');
  if (drawer) drawer.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
}

function toggleHistory() {
  const drawer = qs('historyDrawer');
  const overlay = qs('drawerOverlay');
  if (!drawer) return;

  const opening = !drawer.classList.contains('open');
  if (opening) closeNewsDrawer();

  drawer.classList.toggle('open', opening);
  if (overlay) overlay.classList.toggle('open', opening);

  // Lazy render: build history DOM only when first opened, deferred so animation is not blocked
  if (opening && !_historyRendered) {
    _historyRendered = true;
    requestAnimationFrame(() => updateHistoryUI());
  }
}
window.toggleHistory = toggleHistory;

function toggleProfileMenu() {
  const dropdown = document.getElementById('profileDropdown');
  const btn = document.getElementById('profileBtn');
  if (!dropdown || !btn) return;
  const isOpen = dropdown.classList.contains('open');
  if (isOpen) {
    dropdown.classList.remove('open');
    btn.classList.remove('active');
  } else {
    dropdown.classList.add('open');
    btn.classList.add('active');
  }
}
window.toggleProfileMenu = toggleProfileMenu;

// Close profile dropdown when clicking outside
document.addEventListener('click', function(e) {
  const wrap = document.querySelector('.profile-menu-wrap');
  if (wrap && !wrap.contains(e.target)) {
    const dropdown = document.getElementById('profileDropdown');
    const btn = document.getElementById('profileBtn');
    if (dropdown) dropdown.classList.remove('open');
    if (btn) btn.classList.remove('active');
  }
});

function parseNewsTimestamp(value) {
  if (!value) return NaN;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const ts = Date.parse(String(value));
  return Number.isFinite(ts) ? ts : NaN;
}

function getVideoTabForModelKind(kind) {
  const k = String(kind || '').trim();
  if (!k) return null;
  if (k === 'kling3-text-to-video') return 'text-to-video';
  if (k === 'kling3-image-to-video') return 'image-to-video';
  if (k === 'kling3-reference-to-video') return 'reference-to-video';
  if (k === 'kling3-video-to-video' || k === 'kling3-motion-control') return 'video-to-video';
  if (k === 'text-to-video') return 'text-to-video';
  if (k === 'image-to-video') return 'image-to-video';
  if (k === 'audio-to-video') return 'audio-to-video';
  if (k === 'reference-to-video') return 'reference-to-video';
  if (k === 'video-to-video' || k === 'motion-control' || k === 'video-id-to-video') return 'video-to-video';
  return null;
}

function collectModelNewsEntries() {
  const map = new Map();

  function pushEntry(model, meta) {
    if (!model || !model.id) return;
    const addedAt = parseNewsTimestamp(model.addedAt);
    if (!Number.isFinite(addedAt)) return;

    const mode = meta && meta.mode ? meta.mode : '';
    const key = `${mode}:${model.id}`;
    const next = {
      id: model.id,
      label: model.label || model.id,
      addedAt,
      mode,
      selectId: meta && meta.selectId ? meta.selectId : null,
      videoTab: meta && meta.videoTab ? meta.videoTab : null,
      kling3Tab: meta && meta.kling3Tab ? meta.kling3Tab : null,
      kling3Family: meta && meta.kling3Family ? meta.kling3Family : null,
      newsDescription: model.newsDescription || '',
      newsDescriptionKey: model.newsDescriptionKey || null,
    };

    const prev = map.get(key);
    if (!prev || next.addedAt >= prev.addedAt) {
      map.set(key, next);
    }
  }

  for (const m of IMAGE_MODELS_TEXT) {
    pushEntry(m, { mode: 'text', selectId: 'imageModelText' });
  }
  for (const m of IMAGE_MODELS_EDIT) {
    pushEntry(m, { mode: 'image', selectId: 'imageModelEdit' });
  }
  for (const m of THREE_D_MODELS) {
    pushEntry(m, { mode: '3d', selectId: 'threeDModel' });
  }

  for (const [tab, models] of Object.entries(KLING3_MODELS)) {
    const videoTab = getVideoTabForKling3Tab(tab);
    if (!videoTab) continue;
    for (const m of models || []) {
      pushEntry(m, {
        mode: 'video',
        selectId: 'videoModel',
        videoTab,
        kling3Tab: tab,
        kling3Family: getKling3FamilyForTab(tab),
      });
    }
  }

  for (const m of VIDEO_MODELS) {
    const videoTab = getVideoTabForModelKind(m.kind);
    if (!videoTab) continue;
    pushEntry(m, {
      mode: 'video',
      selectId: 'videoModel',
      videoTab,
    });
  }

  return Array.from(map.values()).sort((a, b) => b.addedAt - a.addedAt);
}

function getRecentModelNewsEntries() {
  const now = Date.now();
  const cutoff = now - NEWS_WINDOW_MS;
  return collectModelNewsEntries().filter((item) => item.addedAt >= cutoff && item.addedAt <= now);
}

function resolveModelNewsDescription(item) {
  if (!item) return '';
  if (item.newsDescriptionKey && window.I18N) {
    const translated = I18N.t(item.newsDescriptionKey);
    if (translated && translated !== item.newsDescriptionKey) return translated;
  }
  return item.newsDescription || '';
}

function updateNewsBadge(items) {
  const badge = qs('newsBadge');
  const profileBadge = document.getElementById('profileBadge');
  const count = Array.isArray(items) ? items.length : 0;
  if (badge) {
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  }
  if (profileBadge) {
    profileBadge.style.display = count > 0 ? 'block' : 'none';
  }
}

function renderModelNews(itemsArg = null) {
  const list = qs('newsList');
  const empty = qs('emptyNews');
  if (!list || !empty) return;

  const items = Array.isArray(itemsArg) ? itemsArg : getRecentModelNewsEntries();
  updateNewsBadge(items);

  list.innerHTML = '';
  if (items.length === 0) {
    list.style.display = 'none';
    empty.style.display = 'flex';
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      requestAnimationFrame(() => window.lucide.createIcons());
    }
    return;
  }

  list.style.display = 'flex';
  empty.style.display = 'none';

  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'news-card';

    const head = document.createElement('div');
    head.className = 'news-card-head';

    const title = document.createElement('h4');
    title.className = 'news-card-title';
    title.textContent = item.label;

    const date = document.createElement('span');
    date.className = 'news-card-date';
    date.textContent = new Date(item.addedAt).toLocaleDateString(window.I18N ? I18N.lang : undefined, {
      month: 'short',
      day: 'numeric',
    });

    head.appendChild(title);
    head.appendChild(date);

    const desc = document.createElement('p');
    desc.className = 'news-card-desc';
    desc.textContent = resolveModelNewsDescription(item);

    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'news-open-btn';
    const openModelLabel = window.I18N ? I18N.t('news_open_model') : 'Open model';
    actionBtn.innerHTML = `<span>${escapeHtml(openModelLabel)}</span><i data-lucide="arrow-up-right"></i>`;
    actionBtn.addEventListener('click', () => { void openNewsModel(item); });

    card.appendChild(head);
    card.appendChild(desc);
    card.appendChild(actionBtn);
    list.appendChild(card);
  }

  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    requestAnimationFrame(() => window.lucide.createIcons());
  }
}
window.renderModelNews = renderModelNews;

function refreshModelNews(forceRender = false) {
  const items = getRecentModelNewsEntries();
  const drawer = qs('newsDrawer');
  const shouldRender = forceRender || (drawer && drawer.classList.contains('open'));
  if (shouldRender) {
    renderModelNews(items);
  } else {
    updateNewsBadge(items);
  }
}

async function openNewsModel(item) {
  if (!item || !item.mode) return;

  if (item.mode === 'kling3' || item.mode === 'video') {
    switchMode('video');
    await ensureVideoModelsReady();
    const desiredVideoTab = item.videoTab || getVideoTabForKling3Tab(item.kling3Tab);
    if (desiredVideoTab) switchVideoTab(desiredVideoTab);
    if (item.kling3Tab) {
      switchKling3Tab(item.kling3Tab, {
        preferredModelId: item.id,
        skipSave: true,
      });
    }
  } else {
    switchMode(item.mode);
  }

  const modelSelect = item.selectId ? qs(item.selectId) : null;
  if (modelSelect) {
    const hasOption = Array.from(modelSelect.options || []).some((opt) => opt.value === item.id);
    if (hasOption) {
      modelSelect.value = item.id;
      modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    setTimeout(() => {
      const scrollTarget = modelSelect.closest('.field') || modelSelect;
      if (scrollTarget && typeof scrollTarget.scrollIntoView === 'function') {
        scrollElementWithinContainer(scrollTarget, { behavior: 'smooth', block: 'center' });
      }
    }, 120);
  }

  closeNewsDrawer();
}
window.openNewsModel = openNewsModel;

function toggleNews() {
  const drawer = qs('newsDrawer');
  const overlay = qs('newsOverlay');
  if (!drawer) return;

  const opening = !drawer.classList.contains('open');
  if (opening) closeHistoryDrawer();

  drawer.classList.toggle('open', opening);
  if (overlay) overlay.classList.toggle('open', opening);

  refreshModelNews(opening);
}
window.toggleNews = toggleNews;

// Open fullscreen preview
function openFullscreen() {
  if (currentPreview) {
    openMediaModal(currentPreview);
  }
}
window.openFullscreen = openFullscreen;

function substituteSeedanceReferenceRefs(text) {
  return String(text || '').replace(/@(?!Image|Video|Audio)(1[0-2]|[1-9])\b/g, (m, n) => `@Image${parseInt(n, 10)}`);
}

// Substitute @1..@14 with "Image 1".."Image 14" in prompt text for models that expect human-readable refs.
function substituteImageRefs(text) {
  return String(text || '').replace(/@(1[0-4]|[1-9])\b/g, (m, n) => `Image ${parseInt(n, 10)}`);
}

function normalizePromptRefsForCurrentContext(text) {
  const raw = String(text || '');
  if (currentMode === 'video') {
    const modelMeta = getSelectedVideoModel();
    if (modelMeta && isSeedance2VideoModelId(modelMeta.id) && getSeedance2FamilyForModelId(modelMeta.id) === 'reference-to-video') {
      return substituteSeedanceReferenceRefs(raw);
    }
  }
  return substituteImageRefs(raw);
}

// Update image upload preview with thumbnails
function updateImagePreview() {
  const grid = qs('imagePreviewGrid');
  if (!grid) return;
  clearPreviewBlobUrls(grid);

  const max = editMaxImages();

  // Clamp array if model was switched to a lower limit
  if (uploadedImageFiles.length > max) {
    uploadedImageFiles = uploadedImageFiles.slice(0, max);
  }

  grid.innerHTML = '';

  if (uploadedImageFiles.length === 0) {
    _updateEditDropzoneHint(max);
    return;
  }

  // Count badge
  const badge = document.createElement('div');
  badge.className = 'edit-img-count';
  badge.textContent = `${uploadedImageFiles.length} / ${max}`;
  grid.appendChild(badge);

  uploadedImageFiles.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'upload-preview-item';

    const img = document.createElement('img');
    img.src = getPreviewSrcForAssetItem(file, grid);
    img.alt = getAssetItemName(file, 'image');
    item.appendChild(img);

    // Number badge
    const numBadge = document.createElement('span');
    numBadge.className = 'img-num-badge';
    numBadge.textContent = index + 1;
    item.appendChild(numBadge);

    // Action overlay (pen-tool + remove)
    const actions = document.createElement('div');
    actions.className = 'tools-img-actions';
    const sketchBtn = document.createElement('button');
    sketchBtn.type = 'button'; sketchBtn.className = 'tools-img-action-btn'; sketchBtn.title = 'Edit / Sketch';
    sketchBtn.innerHTML = '<i data-lucide="pen-tool"></i>';
    sketchBtn.onclick = () => openSketchEditor(index, uploadedImageFiles, updateImagePreview);
    actions.appendChild(sketchBtn);
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button'; removeBtn.className = 'tools-img-action-btn'; removeBtn.title = 'Remove';
    removeBtn.innerHTML = '<i data-lucide="x"></i>';
    removeBtn.onclick = (e) => { e.stopPropagation(); uploadedImageFiles.splice(index, 1); updateImagePreview(); };
    actions.appendChild(removeBtn);
    item.appendChild(actions);

    grid.appendChild(item);
  });

  _updateEditDropzoneHint(max);
  requestAnimationFrame(() => { if (window.lucide) window.lucide.createIcons(); });
}

function _updateEditDropzoneHint(max) {
  const zone = qs('imageDropzone');
  if (!zone) return;
  let hint = zone.querySelector('.edit-max-hint');
  if (uploadedImageFiles.length < max) {
    if (!hint) {
      hint = document.createElement('span');
      hint.className = 'edit-max-hint';
      zone.appendChild(hint);
    }
    hint.textContent = window.I18N ? `${I18N.t('upload_click_drag')} (≤ ${max})` : `Click or drag images (≤ ${max})`;
  } else {
    if (hint) hint.remove();
  }
}

function compactHistoryItemForStorage(item) {
  if (!item || typeof item !== 'object') return item;
  const copy = { ...normalizeHistoryItemForRuntime({ ...item, meta: item.meta && typeof item.meta === 'object' ? { ...item.meta } : item.meta }) };
  delete copy.__accountPersistQueued;
  if (copy.thumbnailUrl && copy.thumbnailUrl === copy.url) delete copy.thumbnailUrl;
  if (copy.thumbnailUrl && /^data:image\//i.test(String(copy.thumbnailUrl))) delete copy.thumbnailUrl;
  if (copy.thumbnailUrl && String(copy.thumbnailUrl).length > 2048) delete copy.thumbnailUrl;
  return copy;
}

function compactHistoryValueForAccountSync(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^blob:/i.test(trimmed)) return null;
    if (/^data:/i.test(trimmed) && trimmed.length > ACCOUNT_HISTORY_SYNC_INLINE_DATA_LIMIT) return null;
    if (trimmed.length > ACCOUNT_HISTORY_SYNC_STRING_LIMIT) return trimmed.slice(0, ACCOUNT_HISTORY_SYNC_STRING_LIMIT);
    return trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, 40)
      .map((entry) => compactHistoryValueForAccountSync(entry, depth + 1))
      .filter((entry) => entry !== null && entry !== undefined);
  }
  if (typeof value === 'object') {
    const next = {};
    Object.entries(value).forEach(([key, entry]) => {
      if (key.startsWith('__')) return;
      const compacted = compactHistoryValueForAccountSync(entry, depth + 1);
      if (compacted !== null && compacted !== undefined && compacted !== '') next[key] = compacted;
    });
    return next;
  }
  return null;
}

function compactHistoryItemForAccountSync(item) {
  if (!item || typeof item !== 'object') return null;
  const normalized = normalizeHistoryItemForRuntime({
    ...item,
    meta: item.meta && typeof item.meta === 'object' ? { ...item.meta } : item.meta,
    genCtx: item.genCtx && typeof item.genCtx === 'object' ? { ...item.genCtx } : item.genCtx,
  });
  const compact = {
    id: normalized.id || null,
    type: normalized.type || 'image',
    prompt: normalized.prompt || '',
    timestamp: normalized.timestamp || Date.now(),
    url: compactHistoryValueForAccountSync(normalized.url),
    thumbnailUrl: compactHistoryValueForAccountSync(normalized.thumbnailUrl),
    modelDownloadUrl: compactHistoryValueForAccountSync(normalized.modelDownloadUrl),
    residualUrl: compactHistoryValueForAccountSync(normalized.residualUrl),
    duration: Number.isFinite(Number(normalized.duration)) ? Number(normalized.duration) : null,
    sampleRate: Number.isFinite(Number(normalized.sampleRate)) ? Number(normalized.sampleRate) : null,
    modelFormat: compactHistoryValueForAccountSync(normalized.modelFormat),
    model_urls: compactHistoryValueForAccountSync(normalized.model_urls),
    glbUrl: compactHistoryValueForAccountSync(normalized.glbUrl),
    outputFormat: compactHistoryValueForAccountSync(normalized.outputFormat),
    genCtx: compactHistoryValueForAccountSync(normalized.genCtx),
    meta: compactHistoryValueForAccountSync(normalized.meta),
  };
  if (compact.thumbnailUrl && compact.thumbnailUrl === compact.url) delete compact.thumbnailUrl;
  if (!compact.modelDownloadUrl && compact.glbUrl) compact.modelDownloadUrl = compact.glbUrl;
  Object.keys(compact).forEach((key) => {
    if (compact[key] === null || compact[key] === undefined || compact[key] === '') delete compact[key];
  });
  return compact;
}

function getAccountHistorySyncPayload(items) {
  const list = Array.isArray(items) ? items : [items];
  return list.map((item) => compactHistoryItemForAccountSync(item)).filter(Boolean);
}

function saveHistory() {
  const key = getScopedStorageKey('nano_history');
  history = dedupeHistoryItems(history).map((item) => {
    if (!item || typeof item !== 'object') return item;
    delete item.__accountPersistQueued;
    return normalizeHistoryItemForRuntime(item);
  });

  let persistedHistory = history.slice(0, LOCAL_HISTORY_CACHE_LIMIT).map((item) => compactHistoryItemForStorage(item));
  try {
    localStorage.setItem(key, JSON.stringify(persistedHistory));
    persistHistoryCacheMeta(history, undefined, { persistedCount: persistedHistory.length });
  } catch (e) {
    while (persistedHistory.length > 1) {
      persistedHistory.pop();
      try {
        localStorage.setItem(key, JSON.stringify(persistedHistory));
        persistHistoryCacheMeta(history, undefined, { persistedCount: persistedHistory.length });
        return;
      } catch (_) { /* keep trimming */ }
    }
    persistHistoryCacheMeta(history, undefined, { persistedCount: persistedHistory.length });
  }
}

const TASK_STORAGE_FAILED_RETENTION_MS = 15 * 60 * 1000;
const TASK_STORAGE_MAX_TERMINAL = 20;

function isTaskActiveForStorage(task) {
  return !!(task && (task.status === 'QUEUED' || task.status === 'SUBMITTING' || task.status === 'RUNNING'));
}

function shouldPersistTask(task, now = Date.now()) {
  if (!task || !task.id) return false;
  if (isTaskActiveForStorage(task)) return true;
  if (task.status === 'COMPLETED') return !task.savedToHistory;
  if (task.status === 'FAILED') {
    const failedAge = Math.max(0, now - (task.failedAt || task.createdAt || now));
    return failedAge <= TASK_STORAGE_FAILED_RETENTION_MS;
  }
  return false;
}

function compactTaskForStorage(task) {
  if (!task || typeof task !== 'object') return null;
  const compact = {
    id: task.id,
    mode: task.mode,
    prompt: task.prompt || '',
    model_id: task.model_id || null,
    status: task.status || null,
    createdAt: task.createdAt || null,
    startedAt: task.startedAt || null,
    completedAt: task.completedAt || null,
    failedAt: task.failedAt || null,
    status_url: task.status_url || null,
    response_url: task.response_url || null,
    error: task.error || null,
    retryCount: Number.isFinite(Number(task.retryCount)) ? Number(task.retryCount) : 0,
    savedToHistory: !!task.savedToHistory,
  };

  if (task.status === 'COMPLETED' && !task.savedToHistory) {
    compact.mediaUrl = task.mediaUrl || null;
    compact.thumbUrl = task.thumbUrl || null;
    compact.model_urls = task.model_urls || null;
    compact.modelFormat = task.modelFormat || null;
  }

  if (isTaskActiveForStorage(task)) {
    compact.genCtx = task.genCtx || null;
  }

  return compact;
}

function buildPersistedTasksSnapshot() {
  const now = Date.now();
  const active = [];
  const terminal = [];

  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!shouldPersistTask(task, now)) continue;
    if (isTaskActiveForStorage(task) || (task.status === 'COMPLETED' && !task.savedToHistory)) active.push(task);
    else terminal.push(task);
  }

  terminal.sort((a, b) => {
    const at = Number(a && (a.failedAt || a.createdAt || 0)) || 0;
    const bt = Number(b && (b.failedAt || b.createdAt || 0)) || 0;
    return bt - at;
  });

  const keptTasks = [...active, ...terminal.slice(0, TASK_STORAGE_MAX_TERMINAL)];
  return keptTasks.map(compactTaskForStorage).filter(Boolean);
}

function saveTasks() {
  const key = getScopedStorageKey('nano_tasks');
  const persistedTasks = buildPersistedTasksSnapshot();

  if (persistedTasks.length !== tasks.length) {
    const persistedIds = new Set(persistedTasks.map((task) => task.id));
    tasks = tasks.filter((task) => task && persistedIds.has(task.id));
  }

  try {
    localStorage.setItem(key, JSON.stringify(persistedTasks));
  } catch (error) {
    const activeOnly = persistedTasks.filter((task) => isTaskActiveForStorage(task) || (task.status === 'COMPLETED' && !task.savedToHistory));
    tasks = tasks.filter((task) => task && activeOnly.some((entry) => entry.id === task.id));
    localStorage.setItem(key, JSON.stringify(activeOnly));
    console.warn('Task storage quota exceeded; pruned terminal tasks from local cache', error);
  }
}

function isTransientPollError(err) {
  if (!err) return false;
  if (err && err.__transient) return true;
  const msg = err && err.message ? String(err.message) : String(err);
  return /failed to fetch/i.test(msg) || /networkerror/i.test(msg) || /network error/i.test(msg);
}

const MAX_POLL_RETRIES = 30;

function computeRetryDelayMs(retryCount) {
  const n = Math.max(0, Math.min(10, Number.isFinite(retryCount) ? retryCount : 0));
  const ms = 2000 * Math.pow(2, Math.max(0, n - 1));
  return Math.max(2000, Math.min(30000, ms));
}

function schedulePoll(taskId, delayMs) {
  if (pollTimers.has(taskId)) {
    clearTimeout(pollTimers.get(taskId));
  }
  const h = setTimeout(() => {
    pollTimers.delete(taskId);
    pollTask(taskId);
  }, Math.max(0, delayMs || 0));
  pollTimers.set(taskId, h);
}

function parseJsonMaybe(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractDetailMessage(details) {
  const src = typeof details === 'string' ? (parseJsonMaybe(details) || details) : details;
  if (!src) return '';

  if (typeof src === 'string') {
    return src.trim();
  }

  if (Array.isArray(src)) {
    for (const entry of src) {
      const msg = extractDetailMessage(entry);
      if (msg) return msg;
    }
    return '';
  }

  if (typeof src !== 'object') return '';

  if (Array.isArray(src.detail)) {
    for (const entry of src.detail) {
      if (entry && typeof entry === 'object') {
        const msg = (typeof entry.msg === 'string' ? entry.msg.trim() : '') ||
          (typeof entry.message === 'string' ? entry.message.trim() : '');
        if (msg) return msg;
      }
      const nested = extractDetailMessage(entry);
      if (nested) return nested;
    }
  }

  if (typeof src.msg === 'string' && src.msg.trim()) return src.msg.trim();
  if (typeof src.message === 'string' && src.message.trim()) return src.message.trim();
  if (typeof src.error === 'string' && src.error.trim()) return src.error.trim();

  if (src.details) return extractDetailMessage(src.details);
  if (src.detail) return extractDetailMessage(src.detail);

  return '';
}

function i18nText(key, fallback) {
  if (window.I18N && typeof I18N.t === 'function') {
    const translated = I18N.t(key);
    if (translated && translated !== key) return translated;
  }
  return fallback;
}

function localizeErrorLine(line) {
  const src = String(line || '').trim();
  if (!src) return '';

  if (/^generation failed$/i.test(src)) return i18nText('err_generation_failed', 'Generation failed');
  if (/^request expired or invalid/i.test(src)) return i18nText('err_expired', 'Request expired or invalid. Please re-generate.');
  if (/^connection lost after multiple retries/i.test(src)) return i18nText('err_connection_lost', 'Connection lost after multiple retries. Please try again.');
  if (/^temporary connection issue\. retrying/i.test(src)) return i18nText('err_retrying_connection', 'Temporary connection issue. Retrying…');
  if (/^task expired after being active too long/i.test(src)) return i18nText('err_task_expired', 'Task expired after being active too long. Please try again.');
  if (/^interrupted - please try again$/i.test(src)) return i18nText('err_interrupted', 'Interrupted - please try again');
  if (/video duration can(?:not| not)?(?: be)? longer than 30s/i.test(src)) {
    return i18nText('err_kling_duration_limit_video', 'Video duration cannot be longer than 30s.');
  }
  if (/video duration can(?:not| not)?(?: be)? longer than 10s/i.test(src)) {
    return i18nText('err_kling_duration_limit_image', 'Video duration cannot be longer than 10s when orientation is image.');
  }
  if (/element binding is only supported when character_orientation is ['\"]video['\"]/i.test(src)) {
    return i18nText('err_kling_element_video_only', "Element binding works only when Character Orientation is set to 'Video'.");
  }
  if (/only 1 element is supported/i.test(src) || /supports only one element/i.test(src)) {
    return i18nText('err_kling_one_element_only', 'Only one element is supported for Kling 3 motion-control.');
  }
  return src;
}

function formatErrorForDisplay(message) {
  const raw = String(message || '').trim();
  if (!raw) return '';

  const lines = raw
    .split(/\n+/)
    .map((line) => localizeErrorLine(line))
    .filter(Boolean);

  let output = lines.join('\n');
  if (/video duration can(?:not| not)?(?: be)? longer than 30s/i.test(raw)) {
    const tip = i18nText(
      'err_kling_motion_duration_tip',
      "Tip: Motion-control videos must be <= 30s with orientation 'video' (<= 10s with orientation 'image')."
    );
    if (!output.includes(tip)) output += '\n' + tip;
  }

  return output;
}

function getTaskStatusLabel(status) {
  const keyMap = {
    QUEUED: 'task_status_queued',
    SUBMITTING: 'task_status_submitting',
    RUNNING: 'task_status_running',
    FAILED: 'task_status_failed',
    COMPLETED: 'task_status_completed',
  };
  const fallbackMap = {
    QUEUED: 'Queued',
    SUBMITTING: 'Submitting',
    RUNNING: 'Running',
    FAILED: 'Failed',
    COMPLETED: 'Completed',
  };
  const s = String(status || '').toUpperCase();
  const key = keyMap[s];
  if (!key) return status || '';
  return i18nText(key, fallbackMap[s] || s);
}

function normalizeErrorMessageFromPayload(payload, fallbackMessage = '') {
  const src = typeof payload === 'string' ? (parseJsonMaybe(payload) || { error: payload }) : payload;
  const primary = src && typeof src === 'object'
    ? ((typeof src.error === 'string' && src.error.trim()) ? src.error.trim() :
      ((typeof src.message === 'string' && src.message.trim()) ? src.message.trim() : ''))
    : '';

  const detail = extractDetailMessage(src && typeof src === 'object' ? (src.details || src.detail) : src);

  const isGeneric = !primary || /status check failed:/i.test(primary) || /unprocessable entity/i.test(primary) || /^generation failed$/i.test(primary);

  let message = primary;
  if (isGeneric && detail) {
    message = detail;
  } else if (detail && primary && !primary.toLowerCase().includes(detail.toLowerCase())) {
    message = primary + '\n' + detail;
  }

  if (!message) {
    message = fallbackMessage || 'Generation failed';
  }

  return message;
}

function getErrorMessage(error, fallbackMessage = '') {
  if (error && typeof error === 'object') {
    if (error.__payload) return normalizeErrorMessageFromPayload(error.__payload, fallbackMessage || error.message || '');
    if (typeof error.message === 'string') return normalizeErrorMessageFromPayload(error.message, fallbackMessage);
    return normalizeErrorMessageFromPayload(error, fallbackMessage);
  }
  return normalizeErrorMessageFromPayload(error, fallbackMessage);
}

async function createResponseError(res, fallbackPrefix = 'Request failed') {
  let rawText = '';
  try {
    rawText = await res.text();
  } catch {
    rawText = '';
  }

  const parsed = parseJsonMaybe(rawText);
  const payload = parsed || (rawText ? { error: rawText } : { error: fallbackPrefix + ': ' + res.status + ' ' + res.statusText });
  const fallbackMessage = fallbackPrefix + ': ' + res.status + ' ' + res.statusText;

  const err = new Error(normalizeErrorMessageFromPayload(payload, fallbackMessage));
  err.__httpStatus = res.status;
  err.__payload = payload;
  err.__transient = res.status === 429 || res.status >= 500;
  return err;
}

async function ensureOkJsonResponse(res, fallbackPrefix = 'Request failed') {
  if (!res.ok) throw await createResponseError(res, fallbackPrefix);
  return await res.json();
}

async function fetchFalViaStatusProxy(url) {
  const res = await fetch(`/api/status?statusUrl=${encodeURIComponent(url)}`);
  return await ensureOkJsonResponse(res, 'Status check failed');
}

function getActiveTaskCount() {
  return tasks.filter((t) => t && (t.status === 'SUBMITTING' || t.status === 'RUNNING')).length;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function setSelectOptions(selectEl, items) {
  if (!selectEl) return;
  const prev = selectEl.value;
  selectEl.innerHTML = '';
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = it.id;
    opt.textContent = it.label;
    selectEl.appendChild(opt);
  }
  if (prev) selectEl.value = prev;
  if (typeof queueApplyPendingPersistedControls === 'function') queueApplyPendingPersistedControls();
}

function getSelected3dModelId() {
  const sel = qs('threeDModel');
  return sel ? String(sel.value || '').trim() : '';
}

function getSelected3dModelMeta() {
  const id = getSelected3dModelId();
  if (!id) return null;
  return THREE_D_MODELS.find((m) => m && m.id === id) || null;
}

let VIDEO_OPTION_DEFS = {};

async function loadVideoModels() {
  if (videoModelsLoaded) return;
  if (!videoModelsPromise) {
    videoModelsPromise = (async () => {
      const res = await fetch('/api/video-generate');
      if (!res.ok) throw await createResponseError(res, 'Failed to load video models');
      const json = await res.json();
      const models = Array.isArray(json && json.models) ? json.models : [];
      VIDEO_MODELS = models.map((m) => ({
        id: m.id,
        label: m.label || m.id,
        kind: m.kind || '',
        selectorRank: Number.isFinite(Number(m.selectorRank)) ? Number(m.selectorRank) : DEFAULT_VIDEO_SELECTOR_RANK,
        requiresImage: m && Object.prototype.hasOwnProperty.call(m, 'requiresImage') ? m.requiresImage : true,
        supportsVideoUrls: !!(m && m.supportsVideoUrls),
        supportsAudioUrls: !!(m && m.supportsAudioUrls),
        maxImageUrls: Number.isFinite(Number(m && m.maxImageUrls)) ? Number(m.maxImageUrls) : null,
        maxVideoUrls: Number.isFinite(Number(m && m.maxVideoUrls)) ? Number(m.maxVideoUrls) : null,
        maxAudioUrls: Number.isFinite(Number(m && m.maxAudioUrls)) ? Number(m.maxAudioUrls) : null,
        maxTotalReferences: Number.isFinite(Number(m && m.maxTotalReferences)) ? Number(m.maxTotalReferences) : null,
        addedAt: m.addedAt || null,
        newsDescription: m.newsDescription || '',
        newsDescriptionKey: m.newsDescriptionKey || null,
      }));
      VIDEO_MODEL_MAP = new Map(models.map((m) => [m.id, m]));
      VIDEO_OPTION_DEFS = (json && json.optionDefs) ? json.optionDefs : {};
      videoModelsLoaded = true;
      refreshModelNews();
    })().finally(() => {
      videoModelsPromise = null;
    });
  }
  await videoModelsPromise;
}

function getSelectedVideoModel() {
  const id = qs('videoModel') ? qs('videoModel').value : '';
  return id ? (VIDEO_MODEL_MAP.get(id) || null) : null;
}

function getVideoFamilyPriority(model) {
  if (model && model.kind && isKling3VideoKind(model.kind)) return 0;
  if (model && model.id && isSeedance2VideoModelId(model.id)) return 1;
  if (model && model.id && isLtx23VideoModelId(model.id)) return 2;
  return 3;
}

function getVideoModelsForTab(tab) {
  const t = String(tab || '').trim();
  if (!t) return VIDEO_MODELS;

  return VIDEO_MODELS.filter((m) => {
    const k = m && m.kind ? m.kind : '';
    return getVideoTabForModelKind(k) === t;
  }).sort((a, b) => {
    const familyDiff = getVideoFamilyPriority(a) - getVideoFamilyPriority(b);
    if (familyDiff !== 0) return familyDiff;
    const rankDiff = (Number.isFinite(Number(a && a.selectorRank)) ? Number(a.selectorRank) : DEFAULT_VIDEO_SELECTOR_RANK)
      - (Number.isFinite(Number(b && b.selectorRank)) ? Number(b.selectorRank) : DEFAULT_VIDEO_SELECTOR_RANK);
    if (rankDiff !== 0) return rankDiff;
    return String(a && a.label || '').localeCompare(String(b && b.label || ''));
  });
}

function refreshVideoModelDropdown(preferredId = '') {
  const sel = qs('videoModel');
  if (!sel) return;
  const prev = sel.value;
  const items = getVideoModelsForTab(currentVideoTab);
  setSelectOptions(sel, items);
  if (preferredId && Array.isArray(items) && items.some((m) => m.id === preferredId)) {
    sel.value = preferredId;
  } else if (prev && Array.isArray(items) && items.some((m) => m.id === prev)) {
    sel.value = prev;
  } else if (!sel.value && items[0]) {
    sel.value = items[0].id;
  }
}

function getLtx23ModelsForFamily(family) {
  return LTX23_MODELS[family] || [];
}

function refreshLtx23ModelDropdown(preferredId = '') {
  const sel = qs('ltx23Model');
  if (!sel) return;
  const prev = sel.value;
  const items = getLtx23ModelsForFamily(currentLtx23Family);
  setSelectOptions(sel, items);
  const remembered = ltx23SelectedModelByFamily[currentLtx23Family];
  if (preferredId && Array.isArray(items) && items.some((m) => m.id === preferredId)) {
    sel.value = preferredId;
  } else if (remembered && Array.isArray(items) && items.some((m) => m.id === remembered)) {
    sel.value = remembered;
  } else if (prev && Array.isArray(items) && items.some((m) => m.id === prev)) {
    sel.value = prev;
  } else if (items[0]) {
    sel.value = items[0].id;
  }
}

function renderLtx23VariantTabs(preferredId = '') {
  const host = qs('ltx23VariantTabs');
  if (!host) return;
  const models = getLtx23ModelsForFamily(currentLtx23Family);
  const activeId = getSelectedLtx23ModelId(preferredId) || ltx23SelectedModelByFamily[currentLtx23Family] || (models[0] && models[0].id) || '';
  host.innerHTML = models.map((model) => `
    <button class="sub-tab ${model.id === activeId ? 'active' : ''}" type="button" onclick="selectLtx23Model('${model.id}')">
      ${escapeHtml(model.label)}
    </button>
  `).join('');
}

function syncLtx23FamilyButtons() {
  const familyIds = {
    'text-to-video': 'ltx23family-text',
    'image-to-video': 'ltx23family-image',
    'video-to-video': 'ltx23family-video',
    'audio-to-video': 'ltx23family-audio',
  };
  Object.entries(familyIds).forEach(([family, id]) => {
    const el = qs(id);
    if (el) el.classList.toggle('active', family === currentLtx23Family);
  });
}

function ensureLtx23EmbeddedSection() {
  const videoHost = qs('videoUploadGroup');
  const ltxSection = qs('ltx23UploadGroup');
  if (!videoHost || !ltxSection) return;

  const videoControls = qs('videoControls');
  const desiredInsertBefore = videoControls && videoControls.nextSibling ? videoControls.nextSibling : null;
  if (ltxSection.parentElement !== videoHost) {
    if (desiredInsertBefore) videoHost.insertBefore(ltxSection, desiredInsertBefore);
    else videoHost.appendChild(ltxSection);
  } else if (videoControls && ltxSection.previousElementSibling !== videoControls) {
    if (desiredInsertBefore && desiredInsertBefore !== ltxSection) {
      videoHost.insertBefore(ltxSection, desiredInsertBefore);
    } else {
      videoHost.appendChild(ltxSection);
    }
  }

  ltxSection.classList.add('video-ltx-embedded');
  if (ltxSection.dataset.ready !== 'true') {
    const ltxModelSel = qs('ltx23Model');
    if (ltxModelSel) {
      ltxModelSel.addEventListener('change', () => {
        if (ltxModelSel.value) selectLtx23Model(ltxModelSel.value);
      });
    }
    ltxSection.dataset.ready = 'true';
  }
  syncLtx23FamilyButtons();
  refreshLtx23ModelDropdown();
  renderLtx23VariantTabs();
}

function syncLtx23StateFromVideoModelId(modelId, options = {}) {
  const family = getLtx23FamilyForModelId(modelId);
  if (!family) return false;
  currentLtx23Family = family;
  ltx23SelectedModelByFamily[family] = modelId;
  ensureLtx23EmbeddedSection();
  syncLtx23FamilyButtons();
  refreshLtx23ModelDropdown(modelId);
  renderLtx23VariantTabs(modelId);
  if (!options.skipSave && typeof saveAppState === 'function') saveAppState();
  return true;
}

function selectLtx23Model(modelId, options = {}) {
  const family = getLtx23FamilyForModelId(modelId);
  if (!family) return;
  currentLtx23Family = family;
  ltx23SelectedModelByFamily[family] = modelId;
  if (currentVideoTab !== family) {
    currentVideoTab = family;
    setActiveVideoTabButtonState(currentVideoTab);
  }
  refreshVideoModelDropdown(modelId);
  refreshLtx23ModelDropdown(modelId);
  const videoSel = qs('videoModel');
  if (videoSel) videoSel.value = modelId;
  ensureLtx23EmbeddedSection();
  updateVideoUiVisibility();
  renderVideoOptionsUI();
  if (!options.skipSave && typeof saveAppState === 'function') saveAppState();
  try { refreshVideo3TierUi(); } catch (_) {}
}
window.selectLtx23Model = selectLtx23Model;

function switchLtx23Family(family, options = {}) {
  if (!LTX23_MODELS[family]) return;
  currentLtx23Family = family;
  const remembered = ltx23SelectedModelByFamily[family];
  const models = getLtx23ModelsForFamily(family);
  const preferredId = (options.preferredModelId && isLtx23VideoModelId(options.preferredModelId))
    ? options.preferredModelId
    : (remembered || (models[0] && models[0].id) || '');
  selectLtx23Model(preferredId, options);
}
window.switchLtx23Family = switchLtx23Family;

function getSelectedSeedance2ModelId(fallback = '') {
  if (fallback && isSeedance2VideoModelId(fallback)) return fallback;
  const videoModelId = qs('videoModel') ? String(qs('videoModel').value || '').trim() : '';
  if (isSeedance2VideoModelId(videoModelId)) return videoModelId;
  const seedanceModelId = qs('seedance2Model') ? String(qs('seedance2Model').value || '').trim() : '';
  if (isSeedance2VideoModelId(seedanceModelId)) return seedanceModelId;
  return '';
}

function getSeedance2ModelsForFamily(family) {
  return SEEDANCE2_MODELS[family] || [];
}

function refreshSeedance2ModelDropdown(preferredId = '') {
  const sel = qs('seedance2Model');
  if (!sel) return;
  const prev = sel.value;
  const items = getSeedance2ModelsForFamily(currentSeedance2Family);
  setSelectOptions(sel, items);
  const remembered = seedance2SelectedModelByFamily[currentSeedance2Family];
  if (preferredId && Array.isArray(items) && items.some((m) => m.id === preferredId)) {
    sel.value = preferredId;
  } else if (remembered && Array.isArray(items) && items.some((m) => m.id === remembered)) {
    sel.value = remembered;
  } else if (prev && Array.isArray(items) && items.some((m) => m.id === prev)) {
    sel.value = prev;
  } else if (items[0]) {
    sel.value = items[0].id;
  }
}

function renderSeedance2VariantTabs(preferredId = '') {
  const host = qs('seedance2VariantTabs');
  if (!host) return;
  const models = getSeedance2ModelsForFamily(currentSeedance2Family);
  const activeId = getSelectedSeedance2ModelId(preferredId) || seedance2SelectedModelByFamily[currentSeedance2Family] || (models[0] && models[0].id) || '';
  host.innerHTML = models.map((model) => `
    <button class="sub-tab ${model.id === activeId ? 'active' : ''}" type="button" onclick="selectSeedance2Model('${model.id}')">
      ${escapeHtml(model.label)}
    </button>
  `).join('');
}

function syncSeedance2FamilyButtons() {
  const familyIds = {
    'text-to-video': 'seedance2family-text',
    'image-to-video': 'seedance2family-image',
    'reference-to-video': 'seedance2family-reference',
  };
  Object.entries(familyIds).forEach(([family, id]) => {
    const el = qs(id);
    if (el) el.classList.toggle('active', family === currentSeedance2Family);
  });
}

function getSeedance2ReferenceSources() {
  return {
    images: [
      ...getManagedUploadRemoteItems(MANAGED_UPLOADS.seedance2ReferenceImagesInput),
      ...(Array.isArray(uploadedSeedanceReferenceImages) ? uploadedSeedanceReferenceImages : []),
    ],
    videos: [
      ...getManagedUploadRemoteItems(MANAGED_UPLOADS.seedance2ReferenceVideosInput),
      ...(Array.isArray(uploadedSeedanceReferenceVideos) ? uploadedSeedanceReferenceVideos : []),
    ],
    audios: [
      ...getManagedUploadRemoteItems(MANAGED_UPLOADS.seedance2ReferenceAudiosInput),
      ...(Array.isArray(uploadedSeedanceReferenceAudios) ? uploadedSeedanceReferenceAudios : []),
    ],
  };
}

function buildSeedance2TokenPill(token, title) {
  return `<span class="seedance-token-pill" title="${escapeHtml(title)}"><strong>${escapeHtml(token)}</strong><em>${escapeHtml(title)}</em></span>`;
}

function updateSeedance2ReferenceUi() {
  const modelMeta = getSelectedVideoModel();
  const isSeedance = !!(modelMeta && isSeedance2VideoModelId(modelMeta.id));
  const noteEl = qs('seedance2ModelNote');
  if (noteEl) {
    const key = currentSeedance2Family === 'image-to-video'
      ? 'seedance2_note_image'
      : currentSeedance2Family === 'reference-to-video'
        ? 'seedance2_note_reference'
        : 'seedance2_note_text';
    const fallback = currentSeedance2Family === 'image-to-video'
      ? 'Animate a start image or transition into an end frame with cinematic motion and native audio.'
      : currentSeedance2Family === 'reference-to-video'
        ? 'Blend image, video, and audio references in one prompt. Use @1 for image refs, @Video1 for video refs, and @Audio1 for audio refs.'
        : 'High-end cinematic text-to-video with native audio, physical motion, and strong camera direction.';
    noteEl.textContent = toolsUiText(key, fallback);
  }

  const refGroup = qs('seedance2ReferenceGroup');
  if (refGroup) refGroup.style.display = isSeedance && currentSeedance2Family === 'reference-to-video' ? 'block' : 'none';

  const tipEl = qs('seedance2ReferenceTip');
  if (tipEl) {
    tipEl.textContent = getI18nText(
      'seedance2_reference_tip',
      'Use @1 for image 1, @2 for image 2, @Video1 for video 1, and @Audio1 for audio 1.'
    );
  }

  const board = qs('seedance2ReferenceTokenBoard');
  if (!board) return;
  const refs = getSeedance2ReferenceSources();
  const pills = [];

  refs.images.forEach((_, index) => {
    const idx = index + 1;
    pills.push(buildSeedance2TokenPill(`@${idx}`, `Image ${idx}`));
    pills.push(buildSeedance2TokenPill(`@Image${idx}`, `Image ${idx}`));
  });
  refs.videos.forEach((_, index) => {
    const idx = index + 1;
    pills.push(buildSeedance2TokenPill(`@Video${idx}`, `Video ${idx}`));
  });
  refs.audios.forEach((_, index) => {
    const idx = index + 1;
    pills.push(buildSeedance2TokenPill(`@Audio${idx}`, `Audio ${idx}`));
  });

  board.innerHTML = pills.length
    ? pills.join('')
    : `<span class="seedance-token-empty">${escapeHtml(getI18nText('seedance2_reference_empty', 'Upload references to get prompt tokens here.'))}</span>`;
}

function ensureSeedance2EmbeddedSection() {
  const videoHost = qs('videoUploadGroup');
  const seedanceSection = qs('seedance2UploadGroup');
  if (!videoHost || !seedanceSection) return;

  const videoControls = qs('videoControls');
  const desiredInsertBefore = videoControls || null;
  if (seedanceSection.parentElement !== videoHost) {
    if (desiredInsertBefore) videoHost.insertBefore(seedanceSection, desiredInsertBefore);
    else videoHost.appendChild(seedanceSection);
  } else if (videoControls && seedanceSection.nextElementSibling !== videoControls) {
    videoHost.insertBefore(seedanceSection, desiredInsertBefore);
  }

  seedanceSection.classList.add('video-seedance-embedded');
  if (seedanceSection.dataset.ready !== 'true') {
    const seedanceModelSel = qs('seedance2Model');
    if (seedanceModelSel) {
      seedanceModelSel.addEventListener('change', () => {
        if (seedanceModelSel.value) selectSeedance2Model(seedanceModelSel.value);
      });
    }
    seedanceSection.dataset.ready = 'true';
  }

  syncSeedance2FamilyButtons();
  refreshSeedance2ModelDropdown();
  renderSeedance2VariantTabs();
  updateSeedance2ReferenceUi();
}

function syncSeedance2StateFromVideoModelId(modelId, options = {}) {
  const family = getSeedance2FamilyForModelId(modelId);
  if (!family) return false;
  currentSeedance2Family = family;
  seedance2SelectedModelByFamily[family] = modelId;
  ensureSeedance2EmbeddedSection();
  syncSeedance2FamilyButtons();
  refreshSeedance2ModelDropdown(modelId);
  renderSeedance2VariantTabs(modelId);
  updateSeedance2ReferenceUi();
  if (!options.skipSave && typeof saveAppState === 'function') saveAppState();
  return true;
}

function selectSeedance2Model(modelId, options = {}) {
  const family = getSeedance2FamilyForModelId(modelId);
  if (!family) return;
  currentSeedance2Family = family;
  seedance2SelectedModelByFamily[family] = modelId;
  if (currentVideoTab !== family) {
    currentVideoTab = family;
    setActiveVideoTabButtonState(currentVideoTab);
  }
  refreshVideoModelDropdown(modelId);
  refreshSeedance2ModelDropdown(modelId);
  const videoSel = qs('videoModel');
  if (videoSel) videoSel.value = modelId;
  ensureSeedance2EmbeddedSection();
  updateVideoUiVisibility();
  renderVideoOptionsUI();
  updateSeedance2ReferenceUi();
  if (!options.skipSave && typeof saveAppState === 'function') saveAppState();
  try { refreshVideo3TierUi(); } catch (_) {}
}
window.selectSeedance2Model = selectSeedance2Model;

function switchSeedance2Family(family, options = {}) {
  if (!SEEDANCE2_MODELS[family]) return;
  currentSeedance2Family = family;
  const remembered = seedance2SelectedModelByFamily[family];
  const models = getSeedance2ModelsForFamily(family);
  const preferredId = (options.preferredModelId && isSeedance2VideoModelId(options.preferredModelId))
    ? options.preferredModelId
    : (remembered || (models[0] && models[0].id) || '');
  selectSeedance2Model(preferredId, options);
}
window.switchSeedance2Family = switchSeedance2Family;

function ensureKling3EmbeddedSection() {
  const videoHost = qs('videoUploadGroup');
  const klingSection = qs('kling3UploadGroup');
  if (!videoHost || !klingSection) return;

  if (klingSection.parentElement !== videoHost) {
    videoHost.appendChild(klingSection);
  }

  klingSection.classList.add('video-kling-embedded');
  klingSection.style.marginTop = '0.75rem';

  const klingModelRow = qs('kling3Model') ? qs('kling3Model').closest('.settings-row') : null;
  if (klingModelRow) klingModelRow.style.display = 'none';

  if (!kling3ControlsInitialized) {
    initKling3Controls();
    kling3ControlsInitialized = true;
  }

  if (klingSection.dataset.embeddedReady !== 'true') {
    switchKling3Tab(currentKling3Tab, {
      skipVideoSelectionSync: true,
      skipSave: true,
      preferredModelId: getSelectedKling3ModelId(),
    });
    klingSection.dataset.embeddedReady = 'true';
  }
}

async function ensureVideoModelsReady() {
  ensureVideoControls();
  await loadVideoModels();
}

function coerceBoolFromUi(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v || '').trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

const VIDEO_OPTION_LABEL_KEYS = {
  acceleration: 'label_acceleration',
  adjust_fps_for_interpolation: 'label_adjust_fps_for_interpolation',
  audio_url: 'label_audio_url',
  auto_fix: 'label_auto_fix_prompt',
  camera_fixed: 'label_fixed_camera',
  cfg_scale: 'label_cfg_scale',
  cfg_scale_framepack: 'label_cfg_scale',
  character_orientation: 'label_character_orientation_mode',
  character_orientation_kling3_motion: 'label_character_orientation_mode',
  delete_video: 'label_delete_after',
  detect_and_block_ip: 'label_block_ip_content',
  effect_pixverse: 'label_effect',
  enable_output_safety_checker_off: 'label_output_safety',
  enable_prompt_expansion: 'label_expand_prompt',
  enable_prompt_expansion_on: 'label_expand_prompt',
  enable_safety_checker: 'label_safety_check',
  enable_safety_checker_off: 'label_safety_check',
  first_n_seconds: 'label_source_seconds',
  fps_animatediff: 'label_fps',
  fps_ltx2: 'label_fps',
  fps_ltx23: 'label_fps',
  frames_per_second: 'label_frames_per_second',
  generate_audio: 'label_generate_audio',
  generate_audio_on: 'label_generate_audio',
  generate_audio_switch: 'label_generate_audio',
  generate_multi_clip_switch: 'label_multi_clip',
  guidance_scale_2: 'label_guidance_scale_2',
  guidance_scale_animatediff: 'label_guidance_scale',
  guidance_scale_framepack: 'label_guidance_scale',
  guidance_scale_ltx23_audio: 'label_guidance_scale',
  guidance_scale_ltx_video: 'label_guidance_scale',
  guidance_scale_wan22: 'label_guidance_scale',
  guidance_scale_wan_move: 'label_guidance_scale',
  interpolator_model: 'label_interpolator',
  keep_audio: 'label_keep_audio',
  keep_audio_on: 'label_keep_audio',
  keep_original_sound: 'label_keep_original_sound',
  motions: 'label_motions',
  multi_shots: 'label_multi_shots',
  multi_shots_on: 'label_multi_shots',
  negative_prompt: 'label_negative_prompt',
  negative_prompt_animatediff: 'label_negative_prompt',
  negative_prompt_kling: 'label_negative_prompt',
  negative_prompt_ltx_video: 'label_negative_prompt',
  num_frames: 'label_frames',
  num_frames_framepack: 'label_frames',
  num_frames_hunyuan: 'label_frames',
  num_inference_steps_animatediff: 'label_inference_steps',
  num_inference_steps_ltx_video: 'label_inference_steps',
  num_inference_steps_wan22: 'label_inference_steps',
  num_inference_steps_wan_move: 'label_inference_steps',
  num_interpolated_frames: 'label_interpolated_frames',
  pro_mode: 'label_pro_mode',
  prompt_optimizer: 'label_optimize_prompt',
  resample_fps: 'label_resample_fps',
  return_frames_zip: 'label_return_frames_zip',
  safety_tolerance_veo31: 'label_safety_tolerance',
  seed: 'label_seed',
  shift: 'label_shift',
  shot_type_customize: 'label_shot_type',
  shot_type_v3: 'label_shot_type',
  strength_animatediff: 'label_strength',
  strength_wan22: 'label_strength',
  style_pixverse: 'label_style',
  sync_mode: 'label_sync_mode',
  thinking_type: 'label_thinking_type',
  use_turbo: 'label_turbo_mode',
  video_quality: 'label_video_quality',
  video_write_mode: 'label_write_mode',
  voice_ids: 'label_voice_ids_simple',
};

const VIDEO_OPTION_VALUE_KEYS = {
  auto: 'opt_auto',
  true: 'opt_on',
  false: 'opt_off',
  image: 'opt_image',
  video: 'opt_video',
  customize: 'opt_customize',
  intelligent: 'opt_intelligent',
  full: 'opt_full',
  preview: 'opt_preview',
  high: 'opt_high',
  medium: 'opt_medium',
  low: 'opt_low',
  realistic: 'opt_realistic',
  sculpture: 'opt_sculpture',
  triangle: 'opt_triangle',
  quadrilateral: 'opt_quad',
  quad: 'opt_quad',
  normal: 'opt_normal',
  lowpoly: 'opt_lowpoly',
  geometry: 'opt_geometry',
  random: 'opt_random',
  yes: 'opt_yes',
  no: 'opt_no',
  on: 'opt_on',
  off: 'opt_off',
};

function humanizeVideoOptionKey(key) {
  return String(key || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getVideoOptionLabelKey(key, def) {
  if (VIDEO_OPTION_LABEL_KEYS[key]) return VIDEO_OPTION_LABEL_KEYS[key];
  if (/^aspect_ratio_/.test(key)) return 'label_aspect_ratio';
  if (/^duration_/.test(key)) return def && /sec/i.test(def.label || '') ? 'label_duration_seconds' : 'label_duration';
  if (/^resolution_/.test(key)) return 'label_resolution';
  return null;
}

function getVideoOptionLabelText(key, def) {
  const labelKey = getVideoOptionLabelKey(key, def);
  if (labelKey) return getI18nText(labelKey, def && def.label ? def.label : humanizeVideoOptionKey(key));
  return def && def.label ? def.label : humanizeVideoOptionKey(key);
}

function getVideoOptionValueText(key, value) {
  const raw = String(value);
  const valueKey = VIDEO_OPTION_VALUE_KEYS[raw.toLowerCase()];
  if (valueKey) return getI18nText(valueKey, raw);
  return raw;
}

function getVideoOptionPlaceholderText(key, def) {
  if (def && Object.prototype.hasOwnProperty.call(def, 'default') && def.default !== null && def.default !== '') {
    return String(def.default);
  }
  return getVideoOptionLabelText(key, def);
}

function localizeVideoOptionFields(root) {
  if (!root) return;
  root.querySelectorAll('[data-video-opt-key]').forEach((field) => {
    const key = field.dataset.videoOptKey;
    const def = VIDEO_OPTION_DEFS[key] || null;
    const label = field.querySelector(':scope > label');
    if (label) label.textContent = getVideoOptionLabelText(key, def);
    const control = field.querySelector('[data-opt-key]');
    if (!control) return;
    if (control.tagName === 'SELECT') {
      Array.from(control.options).forEach((option) => {
        if (option.dataset.empty === 'true') option.textContent = getI18nText('opt_default', 'Default');
        else option.textContent = getVideoOptionValueText(key, option.value);
      });
      return;
    }
    control.placeholder = getVideoOptionPlaceholderText(key, def);
  });
}

function buildVideoOptionInput(key, modelMeta) {
  const def = VIDEO_OPTION_DEFS[key] || null;

  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.dataset.videoOptKey = key;

  const label = document.createElement('label');
  label.textContent = getVideoOptionLabelText(key, def);
  wrap.appendChild(label);

  const optType = def ? def.type : null;
  const hasDefault = !!(def && Object.prototype.hasOwnProperty.call(def, 'default'));

  if (optType === 'select' && Array.isArray(def.values)) {
    const sel = document.createElement('select');
    sel.dataset.optKey = key;

    if (def.allowEmpty) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.dataset.empty = 'true';
      empty.textContent = getI18nText('opt_default', def.emptyLabel || 'Default');
      if (!hasDefault || def.default === null || def.default === '') {
        empty.selected = true;
      }
      sel.appendChild(empty);
    }

    for (const v of def.values) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = getVideoOptionValueText(key, v);
      if (hasDefault && String(def.default) === String(v)) {
        o.selected = true;
      }
      sel.appendChild(o);
    }
    wrap.appendChild(sel);
    return wrap;
  }

  if (optType === 'bool') {
    const sel = document.createElement('select');
    sel.dataset.optKey = key;
    const defVal = def.default === true ? 'true' : 'false';
    ['false', 'true'].forEach((v) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = getVideoOptionValueText(key, v);
      if (v === defVal) o.selected = true;
      sel.appendChild(o);
    });
    wrap.appendChild(sel);
    return wrap;
  }

  if (optType === 'number') {
    const input = document.createElement('input');
    input.dataset.optKey = key;
    input.type = 'number';
    if (def.min !== undefined) input.min = def.min;
    if (def.max !== undefined) input.max = def.max;
    if (def.step !== undefined) input.step = def.step;
    input.placeholder = getVideoOptionPlaceholderText(key, def);
    wrap.appendChild(input);
    return wrap;
  }

  const input = document.createElement('input');
  input.dataset.optKey = key;
  input.type = 'text';
  input.placeholder = getVideoOptionPlaceholderText(key, def);
  wrap.appendChild(input);
  return wrap;
}

// Per-model memory of dynamic video options so each model remembers its last
// settings across reloads. Keyed by video model id; values are { key: value }.
let videoOptionsByModel = {};

function captureVideoOptionsToMemory() {
  const sel = qs('videoModel');
  const modelId = sel ? String(sel.value || '').trim() : '';
  if (!modelId) return;
  const host = qs('videoOptionsDynamic');
  if (!host) return;
  const els = host.querySelectorAll('[data-opt-key]');
  if (!els || !els.length) return;
  const map = {};
  els.forEach((el) => {
    const k = el.dataset.optKey;
    if (!k) return;
    if (el.type === 'checkbox') { map[k] = !!el.checked; return; }
    if ('value' in el) map[k] = el.value;
  });
  videoOptionsByModel[modelId] = map;
}

function applyVideoOptionsFromMemory() {
  const sel = qs('videoModel');
  const modelId = sel ? String(sel.value || '').trim() : '';
  if (!modelId) return;
  const map = videoOptionsByModel[modelId];
  if (!map || typeof map !== 'object') return;
  const host = qs('videoOptionsDynamic');
  if (!host) return;
  const els = host.querySelectorAll('[data-opt-key]');
  els.forEach((el) => {
    const k = el.dataset.optKey;
    if (!k || !Object.prototype.hasOwnProperty.call(map, k)) return;
    const v = map[k];
    if (el.type === 'checkbox') { el.checked = !!v; return; }
    if ('value' in el) el.value = (v == null ? '' : String(v));
  });
}

function renderVideoOptionsUI() {
  const host = qs('videoOptionsDynamic');
  if (!host) return;

  // Hook delegated change/input listeners once so per-model option changes persist.
  if (!host.dataset.persistHooked) {
    host.dataset.persistHooked = 'true';
    const onOptionChange = () => {
      try { captureVideoOptionsToMemory(); } catch (_) {}
      if (typeof saveAppState === 'function') saveAppState();
    };
    host.addEventListener('change', onOptionChange);
    host.addEventListener('input', onOptionChange);
  }

  host.innerHTML = '';

  const modelMeta = getSelectedVideoModel();
  if (!modelMeta) return;
  if (isKling3VideoKind(modelMeta.kind)) return;

  const allowed = Array.isArray(modelMeta.allowedOptions) ? modelMeta.allowedOptions : [];
  if (allowed.length === 0) return;

  const grid = document.createElement('div');
  grid.className = 'settings-grid';
  grid.style.marginTop = '0.5rem';

  for (const key of allowed) {
    grid.appendChild(buildVideoOptionInput(key, modelMeta));
  }

  host.appendChild(grid);
  localizeVideoOptionFields(host);
  try { applyVideoOptionsFromMemory(); } catch (_) {}
  queueApplyPendingPersistedControls();
}

function collectVideoOptionsFromUI() {
  const modelMeta = getSelectedVideoModel();
  if (!modelMeta) return { options: {}, top: {} };

  const allowed = new Set(Array.isArray(modelMeta.allowedOptions) ? modelMeta.allowedOptions : []);
  const optionTypes = (modelMeta.optionTypes && typeof modelMeta.optionTypes === 'object') ? modelMeta.optionTypes : {};
  const els = Array.from(document.querySelectorAll('[data-opt-key]'));

  const options = {};
  const top = {};

  for (const el of els) {
    const key = el.dataset.optKey;
    if (!key || !allowed.has(key)) continue;
    const def = VIDEO_OPTION_DEFS[key] || null;
    let v = (el && 'value' in el) ? el.value : null;
    if (v === null || typeof v === 'undefined') continue;
    if (String(v).trim() === '') continue;

    if (key === 'voice_ids') {
      const arr = String(v).split(',').map((s) => s.trim()).filter(Boolean);
      if (arr.length > 0) options[key] = arr;
      continue;
    }

    if (key === 'motions') {
      const arr = String(v).split(/[\\n,]/).map((s) => s.trim()).filter(Boolean);
      if (arr.length > 0) options[key] = arr;
      continue;
    }

    if (def && def.type === 'bool') {
      const b = coerceBoolFromUi(v);
      if (b !== null) v = b;
    }

    if ((def && def.type === 'number') || optionTypes[key] === 'number') {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) v = n;
    }

    if (key === 'duration' || key === 'aspect_ratio' || key === 'keep_audio' || key === 'video_id') {
      top[key] = v;
    } else {
      options[key] = v;
    }
  }

  return { options, top };
}

function ensureVideoControls() {
  const host = qs('videoUploadGroup');
  if (!host) return;
  if (qs('videoModel')) {
    ensureSeedance2EmbeddedSection();
    ensureLtx23EmbeddedSection();
    ensureKling3EmbeddedSection();
    return;
  }

  const wrap = document.createElement('div');
  wrap.id = 'videoControls';

  wrap.innerHTML = `
    <div class="settings-row" style="margin-top:0.75rem;">
      <div class="field" style="flex:2;">
        <label data-i18n="label_model">${getI18nText('label_model', 'Model')}</label>
        <select id="videoModel"></select>
      </div>
    </div>

    <div class="settings-row" style="margin-top:0.5rem;" id="videoUrlGroup">
      <div class="field">
        <label data-i18n="label_video_url">${getI18nText('label_video_url', 'Video URL')}</label>
        <input id="videoUrlInput" type="text" data-i18n-placeholder="placeholder_video_url" placeholder="${getI18nText('placeholder_video_url', 'https://...mp4')}" />
      </div>
    </div>

    <div class="settings-row" style="margin-top:0.5rem;">
      <div class="field" id="videoFileGroup">
        <label data-i18n="label_upload_video">${getI18nText('label_upload_video', 'Upload Video')}</label>
        <div class="upload-zone small" onclick="document.getElementById('videoInput').click()">
          <i data-lucide="film"></i>
          <span id="videoFileLabel">${getI18nText('upload_video', 'Upload video')}</span>
          <input id="videoInput" type="file" accept="video/*" hidden />
        </div>
      </div>
      <div class="field" id="videoImageFileGroup">
        <label data-i18n="label_upload_image">${getI18nText('label_upload_image', 'Upload Image')}</label>
        <div class="upload-zone small" onclick="document.getElementById('videoImageInput').click()">
          <i data-lucide="image"></i>
          <span id="videoImageLabel">${getI18nText('select_image', 'Select image')}</span>
          <input id="videoImageInput" type="file" accept="image/*" hidden />
        </div>
      </div>
    </div>

    <div class="field" id="referenceImagesGroup" style="margin-top:0.5rem;">
      <label data-i18n="label_reference_images_video">${getI18nText('label_reference_images_video', 'Reference Images (1-7)')}</label>
      <div class="upload-zone small" onclick="document.getElementById('referenceImagesInput').click()">
        <i data-lucide="images"></i>
        <span id="refImagesLabel">${getI18nText('select_images', 'Select images')}</span>
        <input id="referenceImagesInput" type="file" accept="image/*" multiple hidden />
      </div>
    </div>

    <div class="settings-row" style="margin-top:0.5rem;" id="videoEndImageGroup">
      <div class="field">
        <label data-i18n="label_end_frame_optional">${getI18nText('label_end_frame_optional', 'End Frame (optional)')}</label>
        <div class="upload-zone small" onclick="document.getElementById('videoEndImageInput').click()">
          <i data-lucide="image"></i>
          <span id="endImageLabel">${getI18nText('select_image', 'Select image')}</span>
          <input id="videoEndImageInput" type="file" accept="image/*" hidden />
        </div>
      </div>
    </div>

    <div class="settings-row" style="margin-top:0.5rem;" id="videoIdGroup">
      <div class="field">
        <label data-i18n="label_video_id">${getI18nText('label_video_id', 'Video ID')}</label>
        <input id="videoIdInput" type="text" data-i18n-placeholder="placeholder_video_id" placeholder="${getI18nText('placeholder_video_id', 'Enter video ID')}" />
      </div>
    </div>

    <div class="settings-row" style="margin-top:0.5rem;" id="audioFileGroup">
      <div class="field">
        <label data-i18n="label_audio_file">${getI18nText('label_audio_file', 'Audio File')}</label>
        <div class="upload-zone small" onclick="document.getElementById('audioInput').click()">
          <i data-lucide="music"></i>
          <span id="audioFileLabel">${getI18nText('select_audio', 'Select audio')}</span>
          <input id="audioInput" type="file" accept="audio/*" hidden />
        </div>
      </div>
    </div>

    <div id="videoOptionsDynamic"></div>
  `;

  host.appendChild(wrap);
  ensureSeedance2EmbeddedSection();
  ensureLtx23EmbeddedSection();
  ensureKling3EmbeddedSection();
  if (window.I18N && typeof window.I18N.applyLocale === 'function') {
    window.I18N.applyLocale();
  }

  const modelSel = qs('videoModel');

  loadVideoModels()
    .then(() => {
      // If a video restore is pending (saved state from a previous session),
      // let applyVideoRestore handle the dropdown selection so we don't
      // accidentally pick the family-priority default (Kling) on first open.
      if (window._pendingVideoRestore && typeof window.applyVideoRestore === 'function') {
        window.applyVideoRestore().then(() => { try { refreshVideo3TierUi(); } catch (_) {} });
        return;
      }
      refreshVideoModelDropdown();
      const items = getVideoModelsForTab(currentVideoTab);
      if (modelSel && (!modelSel.value || !items.some((m) => m.id === modelSel.value)) && items[0]) {
        modelSel.value = items[0].id;
      }
      updateVideoUiVisibility();
      renderVideoOptionsUI();
      try { refreshVideo3TierUi(); } catch (_) {}
    })
    .catch((e) => {
      showToast(e && e.message ? e.message : String(e), 'error');
    });

  if (modelSel && !modelSel.dataset.persistHooked) {
    modelSel.dataset.persistHooked = 'true';
    modelSel.addEventListener('change', () => {
      // User changed video model via the native dropdown: derive all related
      // state (tab, family, remembered selection) and persist it so a reload
      // restores the exact choice, not whichever dropdown item is first.
      // User has made a fresh selection: invalidate the saved-state shadow
      // so the boot/navigation watchdog stops trying to reassert the old id.
      if (window._savedVideoState) window._savedVideoState = null;
      try {
        const newId = String(modelSel.value || '').trim();
        if (newId) {
          if (isLtx23VideoModelId(newId)) {
            selectLtx23Model(newId, { skipSave: true });
          } else if (isSeedance2VideoModelId(newId)) {
            selectSeedance2Model(newId, { skipSave: true });
          } else if (isKling3VideoModelId(newId)) {
            const klingTab = getKling3TabForModelId(newId);
            if (klingTab) {
              switchKling3Tab(klingTab, { skipSave: true, skipVideoSelectionSync: false, preferredModelId: newId });
            }
          } else {
            const meta = VIDEO_MODEL_MAP.get(newId);
            const targetTab = meta && meta.kind ? getVideoTabForModelKind(meta.kind) : '';
            if (targetTab && targetTab !== currentVideoTab) {
              currentVideoTab = targetTab;
              setActiveVideoTabButtonState(targetTab);
            }
          }
        }
      } catch (_) {}
      updateVideoUiVisibility();
      renderVideoOptionsUI();
      updateSeedance2ReferenceUi();
      try { refreshVideo3TierUi(); } catch (_) {}
      if (typeof saveAppState === 'function') saveAppState();
    });
  }

  ['videoInput', 'videoImageInput', 'referenceImagesInput', 'videoEndImageInput', 'audioInput', 'seedance2ReferenceImagesInput', 'seedance2ReferenceVideosInput', 'seedance2ReferenceAudiosInput'].forEach((inputId) => {
    bindManagedUploadById(inputId);
    const inputEl = qs(inputId);
    if (inputEl) setupDropZone(inputEl.closest('.upload-zone'), inputEl);
  });

  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}
function updateVideoUiVisibility() {
  ensureVideoControls();
  ensureSeedance2EmbeddedSection();
  ensureLtx23EmbeddedSection();
  ensureKling3EmbeddedSection();
  const modelMeta = getSelectedVideoModel();
  const kind = (modelMeta && modelMeta.kind) ? modelMeta.kind : currentVideoTab;
  const isKlingModel = !!(modelMeta && isKling3VideoKind(modelMeta.kind));
  const isSeedance2Model = !!(modelMeta && isSeedance2VideoModelId(modelMeta.id));
  const isSeedance2ReferenceModel = !!(modelMeta && getSeedance2FamilyForModelId(modelMeta.id) === 'reference-to-video');
  const isLtx23Model = !!(modelMeta && isLtx23VideoModelId(modelMeta.id));
  const supportsReferenceImages = !modelMeta || modelMeta.usesImageUrls !== false;

  const showVideo = !isKlingModel && (kind === 'video-to-video' || kind === 'motion-control' || kind === 'video-id-to-video');
  const showImage = !isKlingModel && !isSeedance2ReferenceModel && (kind === 'image-to-video' || kind === 'audio-to-video' || kind === 'motion-control' || kind === 'reference-to-video');
  const showRefs = !isKlingModel && !isSeedance2ReferenceModel && supportsReferenceImages && (kind === 'reference-to-video' || kind === 'video-to-video');
  const showAudioModelRow = true;

  if (qs('videoUrlGroup')) qs('videoUrlGroup').style.display = showVideo ? 'block' : 'none';
  if (qs('videoFileGroup')) qs('videoFileGroup').style.display = showVideo ? 'block' : 'none';
  if (qs('videoImageFileGroup')) qs('videoImageFileGroup').style.display = showImage ? 'block' : 'none';
  if (qs('referenceImagesGroup')) qs('referenceImagesGroup').style.display = showRefs ? 'block' : 'none';

  const videoModelRow = qs('videoModel') ? qs('videoModel').closest('.settings-row') : null;
  if (videoModelRow) videoModelRow.style.display = showAudioModelRow ? '' : 'none';

  const showEndImage = !!(!isKlingModel && modelMeta && modelMeta.supportsEndImage && kind === 'image-to-video');
  if (qs('videoEndImageGroup')) qs('videoEndImageGroup').style.display = showEndImage ? 'block' : 'none';

  const showVideoId = !isKlingModel && kind === 'video-id-to-video';
  if (qs('videoIdGroup')) qs('videoIdGroup').style.display = showVideoId ? 'block' : 'none';

  // Show audio file upload for models that support audio_url
  const allowedOpts = (modelMeta && Array.isArray(modelMeta.allowedOptions)) ? modelMeta.allowedOptions : [];
  const showAudio = !isKlingModel && allowedOpts.includes('audio_url');
  if (qs('audioFileGroup')) qs('audioFileGroup').style.display = showAudio ? 'block' : 'none';

  const videoOptionsHost = qs('videoOptionsDynamic');
  if (videoOptionsHost) videoOptionsHost.style.display = isKlingModel ? 'none' : '';

  const seedanceSection = qs('seedance2UploadGroup');
  if (seedanceSection) seedanceSection.style.display = isSeedance2Model ? 'block' : 'none';

  const ltxSection = qs('ltx23UploadGroup');
  if (ltxSection) ltxSection.style.display = isLtx23Model ? 'block' : 'none';

  const klingSection = qs('kling3UploadGroup');
  if (klingSection) klingSection.style.display = isKlingModel ? 'block' : 'none';

  if (isSeedance2Model) {
    syncSeedance2StateFromVideoModelId(modelMeta.id, { skipSave: true });
    updateSeedance2ReferenceUi();
  }

  if (isLtx23Model) {
    syncLtx23StateFromVideoModelId(modelMeta.id, { skipSave: true });
  }

  if (isKlingModel) {
    syncKling3StateFromVideoModelId(modelMeta.id, { skipSave: true });
    updateKling3UiVisibility();
  }
}

function update3dUiVisibility() {
  const meta = getSelected3dModelMeta();

  const imageWrap = qs('threeDImageUploadWrap');
  const showImageUpload = meta && meta.kind === 'image-to-3d';
  if (imageWrap) {
    const wasHidden = imageWrap.style.display === 'none';
    imageWrap.style.display = showImageUpload ? 'block' : 'none';
    if (showImageUpload && wasHidden) {
      const grid = imageWrap.querySelector('.upload-grid');
      if (grid) {
        grid.classList.remove('grid-enter');
        void grid.offsetWidth;
        grid.classList.add('grid-enter');
      }
    }
  }

  const showMultiView = meta && meta.id === 'fal-ai/hunyuan3d-v3/image-to-3d';
  const multiViewIds = ['threeDBackUploadItem', 'threeDLeftUploadItem', 'threeDRightUploadItem'];
  for (const mvId of multiViewIds) {
    const el = qs(mvId);
    if (el) el.style.display = showMultiView ? 'block' : 'none';
  }

  const isHunyuan = meta && (meta.id === 'fal-ai/hunyuan3d-v3/image-to-3d' || meta.id === 'fal-ai/hunyuan3d-v3/text-to-3d');
  const isMeshy = meta && (meta.id === 'fal-ai/meshy/v6-preview/image-to-3d' || meta.id === 'fal-ai/meshy/v6-preview/text-to-3d');
  const isRapid = meta && meta.id === 'fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d';
  const isTopology = meta && meta.id === 'fal-ai/hunyuan-3d/v3.1/smart-topology';
  const isRetexture = meta && meta.id === 'fal-ai/meshy/v5/retexture';

  const hunyuanWrap = qs('threeDHunyuanSettings');
  if (hunyuanWrap) {
    const wasHidden = hunyuanWrap.style.display === 'none';
    hunyuanWrap.style.display = isHunyuan ? 'grid' : 'none';
    if (isHunyuan && wasHidden) {
      hunyuanWrap.classList.remove('grid-enter');
      void hunyuanWrap.offsetWidth;
      hunyuanWrap.classList.add('grid-enter');
    }
  }

  const meshyWrap = qs('threeDMeshySettings');
  if (meshyWrap) {
    const wasHidden = meshyWrap.style.display === 'none';
    meshyWrap.style.display = isMeshy ? 'block' : 'none';
    if (isMeshy && wasHidden) {
      meshyWrap.querySelectorAll('.settings-grid').forEach(grid => {
        grid.classList.remove('grid-enter');
        void grid.offsetWidth;
        grid.classList.add('grid-enter');
      });
    }
  }

  const rapidWrap = qs('threeDRapidSettings');
  if (rapidWrap) {
    const wasHidden = rapidWrap.style.display === 'none';
    rapidWrap.style.display = isRapid ? 'grid' : 'none';
    if (isRapid && wasHidden) {
      rapidWrap.classList.remove('grid-enter');
      void rapidWrap.offsetWidth;
      rapidWrap.classList.add('grid-enter');
    }
  }

  const topoWrap = qs('threeDTopologySettings');
  if (topoWrap) {
    const wasHidden = topoWrap.style.display === 'none';
    topoWrap.style.display = isTopology ? 'block' : 'none';
    if (isTopology && wasHidden) {
      topoWrap.querySelectorAll('.settings-grid').forEach(grid => {
        grid.classList.remove('grid-enter');
        void grid.offsetWidth;
        grid.classList.add('grid-enter');
      });
    }
  }

  const retexWrap = qs('threeDRetextureSettings');
  if (retexWrap) {
    const wasHidden = retexWrap.style.display === 'none';
    retexWrap.style.display = isRetexture ? 'block' : 'none';
    if (isRetexture && wasHidden) {
      retexWrap.querySelectorAll('.settings-grid').forEach(grid => {
        grid.classList.remove('grid-enter');
        void grid.offsetWidth;
        grid.classList.add('grid-enter');
      });
    }
  }

  const isMeshyText = meta && meta.id === 'fal-ai/meshy/v6-preview/text-to-3d';
  const isMeshyImage = meta && meta.id === 'fal-ai/meshy/v6-preview/image-to-3d';
  const showIds = (ids, show) => {
    for (const id of ids) {
      const el = qs(id);
      if (el) el.style.display = show ? 'block' : 'none';
    }
  };
  showIds(['threeDMeshyTextOnly', 'threeDMeshyTextOnly2', 'threeDMeshyTextOnly3', 'threeDMeshyTextOnly4'], !!isMeshyText);
  showIds(['threeDMeshyImageOnly'], !!isMeshyImage);

  const typeEl = qs('threeDGenerateType');
  const polyEl = qs('threeDPolygonType');
  if (typeEl && polyEl) {
    const gt = String(typeEl.value || 'Normal');
    polyEl.disabled = gt !== 'LowPoly';
  }
}

function setActiveVideoTabButtonState(tab) {
  const ids = ['vtab-text', 'vtab-image', 'vtab-video', 'vtab-reference', 'vtab-audio'];
  for (const id of ids) {
    const el = qs(id);
    if (el) el.classList.remove('active');
  }
  const map = {
    'text-to-video': 'vtab-text',
    'image-to-video': 'vtab-image',
    'video-to-video': 'vtab-video',
    'reference-to-video': 'vtab-reference',
    'audio-to-video': 'vtab-audio',
  };
  if (map[tab] && qs(map[tab])) qs(map[tab]).classList.add('active');
}

function switchVideoTab(tab) {
  currentVideoTab = tab;
  setActiveVideoTabButtonState(tab);

  ensureVideoControls();
  if (videoModelsLoaded) {
    refreshVideoModelDropdown();
    updateVideoUiVisibility();
    renderVideoOptionsUI();
  } else {
    updateVideoUiVisibility();
  }
  
  // Animate video controls section
  const videoControls = qs('videoControlsContainer');
  if (videoControls) {
    videoControls.querySelectorAll('.settings-grid').forEach(grid => {
      grid.classList.remove('grid-enter');
      void grid.offsetWidth;
      grid.classList.add('grid-enter');
    });
  }

  if (typeof saveAppState === 'function') saveAppState();
  try { refreshVideo3TierUi(); } catch (_) {}
}

// Helper to animate a settings grid
function animateGrid(el) {
  if (!el) return;
  el.classList.remove('grid-enter');
  void el.offsetWidth;
  el.classList.add('grid-enter');
}

// ==================== VIDEO 3-TIER UI CONTROLLER ====================
// Dynamic engine discovery from loaded VIDEO_MODELS. Engines are grouped
// by brand family. The bar, mode row, and variant chips are fully JS-rendered.

var VIDEO_ENGINE_REGISTRY = [
  { id: 'kling',    label: 'Kling',    tag: '3.0 / O3',  order: 1 },
  { id: 'veo',      label: 'Veo',      tag: '3.1',        order: 2 },
  { id: 'sora',     label: 'Sora',     tag: '2',          order: 3 },
  { id: 'hailuo',   label: 'Hailuo',   tag: '2.3',        order: 4 },
  { id: 'seedance', label: 'Seedance', tag: '2.0',        order: 5 },
  { id: 'ltx',      label: 'LTX',      tag: '2.3',        order: 6 },
  { id: 'pixverse', label: 'PixVerse', tag: 'v5.5',       order: 7 },
  { id: 'wan',      label: 'Wan',      tag: 'v2.6',       order: 8 },
  { id: 'hunyuan',  label: 'Hunyuan',  tag: '',            order: 9 },
  { id: 'grok',     label: 'Grok',     tag: '',            order: 10 },
  { id: 'alibaba',  label: 'Alibaba',  tag: 'Happy Horse', order: 11 },
  { id: 'other',    label: 'Other',    tag: '...', order: 99 },
];
var VIDEO_ENGINE_MAP = new Map(VIDEO_ENGINE_REGISTRY.map(function(e) { return [e.id, e]; }));

var ALL_VIDEO_MODES = ['text-to-video','image-to-video','video-to-video','reference-to-video','audio-to-video'];

var VIDEO_MODE_META = {
  'text-to-video':      { icon: 'type',   label: 'Text',  i18n: 'vtab_text' },
  'image-to-video':     { icon: 'image',  label: 'Image', i18n: 'vtab_image' },
  'video-to-video':     { icon: 'film',   label: 'Video', i18n: 'vtab_video' },
  'reference-to-video': { icon: 'layers', label: 'Ref',   i18n: 'vtab_ref' },
  'audio-to-video':     { icon: 'music',  label: 'Audio', i18n: 'vtab_audio' },
};

function getEngineForModelId(modelId) {
  if (!modelId) return null;
  var id = String(modelId);
  if (isKling3VideoModelId(id)) return 'kling';
  if (isLtx23VideoModelId(id)) return 'ltx';
  if (isSeedance2VideoModelId(id)) return 'seedance';
  if (id.startsWith('kling-')) return 'kling';
  if (id.startsWith('ltx-')) return 'ltx';
  if (id.startsWith('seedance-')) return 'seedance';
  if (id.startsWith('veo')) return 'veo';
  if (id.startsWith('sora-')) return 'sora';
  if (id.startsWith('hailuo-')) return 'hailuo';
  if (id.startsWith('pixverse-')) return 'pixverse';
  if (id.startsWith('wan-')) return 'wan';
  if (id.startsWith('hunyuan-')) return 'hunyuan';
  if (id.startsWith('grok-')) return 'grok';
  if (id.startsWith('happy-horse-') || id.startsWith('alibaba-')) return 'alibaba';
  return 'other';
}

function getCurrentVideoEngine() {
  var sel = qs('videoModel');
  var id = sel ? String(sel.value || '').trim() : '';
  var fromModel = getEngineForModelId(id);
  if (fromModel) return fromModel;
  if (window._currentVideoEngine && VIDEO_ENGINE_MAP.has(window._currentVideoEngine)) {
    return window._currentVideoEngine;
  }
  return 'kling';
}

function getVideoModelsForEngineMode(engine, mode) {
  if (!Array.isArray(VIDEO_MODELS)) return [];
  return VIDEO_MODELS.filter(function(m) {
    if (!m || !m.id) return false;
    var eng = getEngineForModelId(m.id);
    if (eng !== engine) return false;
    var tab = getVideoTabForModelKind(m.kind || '');
    return tab === mode;
  }).sort(function(a, b) {
    var ra = Number.isFinite(Number(a && a.selectorRank)) ? Number(a.selectorRank) : DEFAULT_VIDEO_SELECTOR_RANK;
    var rb = Number.isFinite(Number(b && b.selectorRank)) ? Number(b.selectorRank) : DEFAULT_VIDEO_SELECTOR_RANK;
    if (ra !== rb) return ra - rb;
    return String(a && a.label || '').localeCompare(String(b && b.label || ''));
  });
}

function getActiveEngines() {
  if (!Array.isArray(VIDEO_MODELS) || !VIDEO_MODELS.length) {
    return VIDEO_ENGINE_REGISTRY.filter(function(e) { return e.id === 'kling' || e.id === 'ltx' || e.id === 'seedance'; });
  }
  var seen = new Set();
  VIDEO_MODELS.forEach(function(m) {
    if (m && m.id) seen.add(getEngineForModelId(m.id));
  });
  return VIDEO_ENGINE_REGISTRY.filter(function(e) { return seen.has(e.id); }).sort(function(a, b) { return a.order - b.order; });
}

function getModesForEngine(engine) {
  var modes = [];
  ALL_VIDEO_MODES.forEach(function(mode) {
    if (getVideoModelsForEngineMode(engine, mode).length > 0) modes.push(mode);
  });
  return modes;
}

function getShortVariantLabel(model) {
  if (!model) return '';
  var id = String(model.id || '');
  var lbl = String(model.label || id);
  if (isKling3VideoModelId(id)) {
    var isO3 = id.indexOf('o3') >= 0;
    var tier = id.indexOf('pro') >= 0 ? 'Pro' : (id.indexOf('standard') >= 0 ? 'Std' : '');
    var motion = id.indexOf('motion') >= 0 ? ' Motion' : '';
    var v2vKind = id.indexOf('v2v-edit') >= 0 ? ' Edit' : (id.indexOf('v2v-ref') >= 0 ? ' Ref' : '');
    return (isO3 ? 'O3 ' : 'V3 ') + (tier || 'Pro') + motion + v2vKind;
  }
  if (isLtx23VideoModelId(id)) {
    var ltxFamily = LTX23_MODEL_TO_FAMILY.get(id);
    if (ltxFamily) {
      var ltxEntry = (LTX23_MODELS[ltxFamily] || []).find(function(x) { return x.id === id; });
      if (ltxEntry && ltxEntry.label) return String(ltxEntry.label);
    }
  }
  if (isSeedance2VideoModelId(id)) {
    var sdFamily = SEEDANCE2_MODEL_TO_FAMILY.get(id);
    if (sdFamily) {
      var sdEntry = (SEEDANCE2_MODELS[sdFamily] || []).find(function(x) { return x.id === id; });
      if (sdEntry && sdEntry.label) return String(sdEntry.label);
    }
  }
  lbl = lbl.replace(/\s*\([^)]*\)\s*$/g, '').replace(/\s*\[[^\]]*\]\s*$/g, '').trim();
  var engine = getEngineForModelId(id);
  var reg = VIDEO_ENGINE_MAP.get(engine);
  if (reg && reg.label) {
    lbl = lbl.replace(new RegExp('^' + reg.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s-]*', 'i'), '');
  }
  lbl = lbl.replace(/\s*\([^)]*\)\s*$/g, '').replace(/\s*\[[^\]]*\]\s*$/g, '').trim();
  if (!lbl) lbl = model.label || id;
  return lbl;
}

function renderVideoEngineBar() {
  var bar = qs('videoEngineBar');
  if (!bar) return;
  var engine = getCurrentVideoEngine();
  window._currentVideoEngine = engine;
  var engines = getActiveEngines();
  bar.innerHTML = engines.map(function(eng) {
    var isActive = eng.id === engine;
    var tag = eng.tag ? '<span class="video-engine-pill-tag">' + escapeHtml(eng.tag) + '</span>' : '';
    return '<button class="video-engine-pill' + (isActive ? ' active' : '') + '" type="button" data-engine="' + eng.id + '" role="tab" aria-selected="' + isActive + '">' +
      '<span class="video-engine-pill-name">' + escapeHtml(eng.label) + '</span>' + tag + '</button>';
  }).join('');
  if (!bar.dataset.bound) {
    bar.dataset.bound = 'true';
    bar.addEventListener('click', function(ev) {
      var btn = ev.target.closest('.video-engine-pill');
      if (!btn) return;
      var nextEngine = btn.dataset.engine;
      if (!nextEngine || nextEngine === window._currentVideoEngine) return;
      switchVideoEngine(nextEngine);
    });
  }
}

function renderVideoModeBar() {
  var bar = qs('videoModeBar');
  if (!bar) return;
  var engine = getCurrentVideoEngine();
  var activeModes = getModesForEngine(engine);
  var activeSet = new Set(activeModes);
  bar.innerHTML = ALL_VIDEO_MODES.map(function(mode) {
    var meta = VIDEO_MODE_META[mode] || {};
    var visible = activeSet.has(mode);
    var isActive = visible && mode === currentVideoTab;
    return '<button class="video-mode-pill' + (isActive ? ' active' : '') + '"' +
      ' type="button" data-mode="' + mode + '" role="tab"' +
      ' aria-selected="' + isActive + '"' +
      ' title="' + escapeHtml(meta.label || mode) + '"' +
      (visible ? '' : ' hidden') + '>' +
      '<i data-lucide="' + (meta.icon || 'circle') + '"></i>' +
      '<span class="video-mode-pill-label">' + escapeHtml(meta.label || mode) + '</span>' +
      '</button>';
  }).join('');
  var visibleCount = activeModes.length;
  if (visibleCount > 0) {
    bar.style.gridTemplateColumns = 'repeat(' + visibleCount + ', minmax(0, 1fr))';
  }
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    try { window.lucide.createIcons({ attrs: { class: '' }, nameAttr: 'data-lucide' }); } catch (_) {}
  }
  if (!bar.dataset.bound) {
    bar.dataset.bound = 'true';
    bar.addEventListener('click', function(ev) {
      var btn = ev.target.closest('.video-mode-pill');
      if (!btn || btn.hidden) return;
      var m = btn.dataset.mode;
      if (!m) return;
      switchVideoEngineMode(window._currentVideoEngine || getCurrentVideoEngine(), m);
    });
  }
}

function renderVideoVariantRow() {
  var row = qs('videoVariantRow');
  if (!row) return;
  var engine = getCurrentVideoEngine();
  var mode = currentVideoTab;
  var models = getVideoModelsForEngineMode(engine, mode);
  if (!models.length) { row.hidden = true; row.innerHTML = ''; return; }
  if (models.length === 1) {
    var sel = qs('videoModel');
    if (sel && sel.value !== models[0].id) {
      setTimeout(function() { selectVideoModelById(models[0].id); }, 0);
    }
    row.hidden = true; row.innerHTML = '';
    return;
  }
  var sel2 = qs('videoModel');
  var currentId = sel2 ? String(sel2.value || '').trim() : '';
  row.hidden = false;
  row.innerHTML = models.map(function(m) {
    var label = escapeHtml(getShortVariantLabel(m));
    var active = m.id === currentId ? ' active' : '';
    return '<button class="video-variant-chip' + active + '" type="button" data-model-id="' + escapeHtml(m.id) + '" title="' + escapeHtml(m.label || m.id) + '">' + label + '</button>';
  }).join('');
  if (!row.dataset.bound) {
    row.dataset.bound = 'true';
    row.addEventListener('click', function(ev) {
      var btn = ev.target.closest('.video-variant-chip');
      if (!btn) return;
      var id = btn.dataset.modelId;
      if (id) selectVideoModelById(id);
    });
  }
}

function selectVideoModelById(id) {
  if (!id) return;
  if (isLtx23VideoModelId(id)) {
    selectLtx23Model(id);
  } else if (isSeedance2VideoModelId(id)) {
    selectSeedance2Model(id);
  } else if (isKling3VideoModelId(id)) {
    var klingTab = getKling3TabForModelId(id);
    if (klingTab) {
      switchKling3Tab(klingTab, { skipVideoSelectionSync: false, preferredModelId: id });
    }
  } else {
    var meta = VIDEO_MODEL_MAP.get(id);
    var targetTab = meta && meta.kind ? getVideoTabForModelKind(meta.kind) : '';
    if (targetTab && targetTab !== currentVideoTab) {
      currentVideoTab = targetTab;
      setActiveVideoTabButtonState(targetTab);
    }
    refreshVideoModelDropdown(id);
    var sel = qs('videoModel');
    if (sel) sel.value = id;
    updateVideoUiVisibility();
    renderVideoOptionsUI();
    if (typeof saveAppState === 'function') saveAppState();
  }
  refreshVideo3TierUi();
}
window.selectVideoModelById = selectVideoModelById;

function switchVideoEngine(nextEngine) {
  if (!nextEngine || !VIDEO_ENGINE_MAP.has(nextEngine)) return;
  window._currentVideoEngine = nextEngine;
  var allowedModes = getModesForEngine(nextEngine);
  var nextMode = allowedModes.indexOf(currentVideoTab) >= 0 ? currentVideoTab : '';
  if (!nextMode || !getVideoModelsForEngineMode(nextEngine, nextMode).length) {
    nextMode = allowedModes.find(function(m) { return getVideoModelsForEngineMode(nextEngine, m).length; }) || allowedModes[0];
  }
  switchVideoEngineMode(nextEngine, nextMode);
}
window.switchVideoEngine = switchVideoEngine;

function switchVideoEngineMode(engine, mode) {
  if (!engine || !mode) return;
  window._currentVideoEngine = engine;
  var models = getVideoModelsForEngineMode(engine, mode);
  if (!models.length) {
    currentVideoTab = mode;
    setActiveVideoTabButtonState(mode);
    refreshVideo3TierUi();
    return;
  }
  var preferred = '';
  if (engine === 'kling') {
    var candidateKlingTabs = Object.keys(KLING3_TAB_TO_VIDEO_TAB).filter(function(kt) { return KLING3_TAB_TO_VIDEO_TAB[kt] === mode; });
    for (var ci = 0; ci < candidateKlingTabs.length; ci++) {
      var kt = candidateKlingTabs[ci];
      if (kling3SelectedModelByTab[kt] && models.some(function(m) { return m.id === kling3SelectedModelByTab[kt]; })) {
        preferred = kling3SelectedModelByTab[kt]; break;
      }
    }
  } else if (engine === 'ltx') {
    if (ltx23SelectedModelByFamily[mode] && models.some(function(m) { return m.id === ltx23SelectedModelByFamily[mode]; })) {
      preferred = ltx23SelectedModelByFamily[mode];
    }
  } else if (engine === 'seedance') {
    if (seedance2SelectedModelByFamily[mode] && models.some(function(m) { return m.id === seedance2SelectedModelByFamily[mode]; })) {
      preferred = seedance2SelectedModelByFamily[mode];
    }
  }
  var targetId = preferred || models[0].id;
  selectVideoModelById(targetId);
}
window.switchVideoEngineMode = switchVideoEngineMode;

function refreshVideo3TierUi() {
  try { renderVideoEngineBar(); } catch (_) {}
  try { renderVideoModeBar(); } catch (_) {}
  try { renderVideoVariantRow(); } catch (_) {}
}
window.refreshVideo3TierUi = refreshVideo3TierUi;


// ==================== KLING 3 FUNCTIONS ====================
function getKling3ModelsForTab(tab) {
  return KLING3_MODELS[tab] || [];
}

function refreshKling3ModelDropdown(preferredId = '') {
  const sel = qs('kling3Model');
  if (!sel) return;
  const prev = sel.value;
  const items = getKling3ModelsForTab(currentKling3Tab);
  setSelectOptions(sel, items);
  const remembered = kling3SelectedModelByTab[currentKling3Tab];
  if (preferredId && Array.isArray(items) && items.some((m) => m.id === preferredId)) {
    sel.value = preferredId;
  } else if (remembered && Array.isArray(items) && items.some((m) => m.id === remembered)) {
    sel.value = remembered;
  } else if (prev && Array.isArray(items) && items.some((m) => m.id === prev)) {
    sel.value = prev;
  } else if (items[0]) {
    sel.value = items[0].id;
  }
}

function syncKling3StateFromVideoModelId(modelId, options = {}) {
  const klingTab = getKling3TabForModelId(modelId);
  if (!klingTab) return false;
  const klingSelect = qs('kling3Model');
  const currentKlingModelId = klingSelect ? String(klingSelect.value || '').trim() : '';
  if (currentKling3Tab === klingTab && currentKlingModelId === modelId) {
    kling3SelectedModelByTab[klingTab] = modelId;
    return true;
  }
  switchKling3Tab(klingTab, {
    skipVideoSelectionSync: true,
    skipSave: options.skipSave === true,
    preferredModelId: modelId,
  });
  return true;
}

function switchKling3Tab(tab, options = {}) {
  const prevTab = currentKling3Tab;
  const modelSel = qs('kling3Model');
  if (modelSel && prevTab) {
    kling3SelectedModelByTab[prevTab] = modelSel.value;
  }
  currentKling3Tab = tab;
  if (tab.startsWith('v3-')) {
    currentKling3Family = 'v3';
    kling3LastTabByFamily.v3 = tab;
  } else if (tab.startsWith('o3-')) {
    currentKling3Family = 'o3';
    kling3LastTabByFamily.o3 = tab;
  }
  const tabIds = ['k3tab-v3-text', 'k3tab-v3-image', 'k3tab-v3-motion', 'k3tab-o3-text', 'k3tab-o3-image', 'k3tab-o3-ref', 'k3tab-o3-v2v'];
  for (const id of tabIds) {
    const el = qs(id);
    if (el) el.classList.remove('active');
  }
  const map = {
    'v3-text-to-video': 'k3tab-v3-text',
    'v3-image-to-video': 'k3tab-v3-image',
    'v3-motion-control': 'k3tab-v3-motion',
    'o3-text-to-video': 'k3tab-o3-text',
    'o3-image-to-video': 'k3tab-o3-image',
    'o3-reference-to-video': 'k3tab-o3-ref',
    'o3-video-to-video': 'k3tab-o3-v2v',
  };
  if (map[tab] && qs(map[tab])) qs(map[tab]).classList.add('active');

  const v3Tabs = qs('kling3ModeTabsV3');
  const o3Tabs = qs('kling3ModeTabsO3');
  if (v3Tabs) v3Tabs.style.display = currentKling3Family === 'v3' ? 'flex' : 'none';
  if (o3Tabs) o3Tabs.style.display = currentKling3Family === 'o3' ? 'flex' : 'none';

  const v3Family = qs('k3family-v3');
  const o3Family = qs('k3family-o3');
  if (v3Family) v3Family.classList.toggle('active', currentKling3Family === 'v3');
  if (o3Family) o3Family.classList.toggle('active', currentKling3Family === 'o3');

  refreshKling3ModelDropdown(options.preferredModelId || '');
  if (modelSel && modelSel.value) {
    kling3SelectedModelByTab[currentKling3Tab] = modelSel.value;
  }

  if (!options.skipVideoSelectionSync) {
    const preferredVideoModelId = (modelSel && modelSel.value) ? modelSel.value : (options.preferredModelId || '');
    const nextVideoTab = getVideoTabForKling3Tab(tab);
    if (nextVideoTab) {
      currentVideoTab = nextVideoTab;
      setActiveVideoTabButtonState(nextVideoTab);
      if (qs('videoModel')) {
        refreshVideoModelDropdown(preferredVideoModelId);
      }
    }
  }

  updateKling3UiVisibility();
  if (!options.skipVideoSelectionSync) {
    updateVideoUiVisibility();
    renderVideoOptionsUI();
  }
  if (!options.skipSave && typeof saveAppState === 'function') saveAppState();
  try { refreshVideo3TierUi(); } catch (_) {}
}
window.switchKling3Tab = switchKling3Tab;

function switchKling3Family(family, options = {}) {
  if (family !== 'v3' && family !== 'o3') return;
  currentKling3Family = family;
  const nextTab = kling3LastTabByFamily[family] || (family === 'v3' ? 'v3-text-to-video' : 'o3-text-to-video');
  switchKling3Tab(nextTab, options);
}
window.switchKling3Family = switchKling3Family;

function updateKling3UiVisibility() {
  const tab = currentKling3Tab;
  const isT2V = tab === 'v3-text-to-video' || tab === 'o3-text-to-video';
  const isI2V = tab === 'v3-image-to-video' || tab === 'o3-image-to-video';
  const isRef = tab === 'o3-reference-to-video';
  const isV2V = tab === 'o3-video-to-video';
  const isMotionTab = tab === 'v3-motion-control';
  const isV3 = tab.startsWith('v3-');
  const selectedModelId = getSelectedKling3ModelId();
  const isV2VEdit = selectedModelId === 'kling-o3-pro-v2v-edit';
  const isV2VRef = selectedModelId === 'kling-o3-pro-v2v-ref';
  const isMotionModel = isKling3MotionModelId(selectedModelId);
  const showMotionControls = isMotionTab || isMotionModel;
  const showMotionElements = showMotionControls && isKling3MotionOrientationVideo();
  const isV3Classic = isV3 && !showMotionControls;

  // Start image (for I2V, Ref and Motion modes)
  if (qs('kling3StartImageGroup')) qs('kling3StartImageGroup').style.display = (isI2V || isRef || showMotionControls) ? 'block' : 'none';
  // End image (for I2V and O3 Ref modes)
  if (qs('kling3EndImageGroup')) qs('kling3EndImageGroup').style.display = (isI2V || isRef) ? 'block' : 'none';
  // Video upload (for V2V and Motion modes)
  if (qs('kling3VideoGroup')) qs('kling3VideoGroup').style.display = (isV2V || showMotionControls) ? 'block' : 'none';
  // Reference images (for Ref and V2V modes)
  if (qs('kling3RefImagesGroup')) qs('kling3RefImagesGroup').style.display = (isRef || isV2V) ? 'block' : 'none';
  // Elements (for V3 I2V, O3 Ref/V2V, and V3 motion with video orientation)
  if (qs('kling3ElementsGroup')) qs('kling3ElementsGroup').style.display = ((isV3 && isI2V) || isRef || isV2V || showMotionElements) ? 'block' : 'none';

  if (showMotionControls && kling3Elements.length > 1) {
    kling3Elements = kling3Elements.slice(0, 1);
    renderKling3Elements();
  }

  // Motion-specific settings
  if (qs('kling3MotionSettings')) qs('kling3MotionSettings').style.display = showMotionControls ? 'grid' : 'none';

  // Shot type - V3 T2V has intelligent option, others only customize
  const shotTypeGroup = qs('kling3ShotTypeGroup');
  const shotTypeSel = qs('kling3ShotType');
  if (shotTypeGroup && shotTypeSel) {
    shotTypeGroup.style.display = (isT2V || isI2V || isRef || isV2V) ? 'block' : 'none';
    if (tab === 'v3-text-to-video') {
      shotTypeSel.innerHTML = '<option value="customize" selected>Customize</option><option value="intelligent">Intelligent</option>';
    } else {
      shotTypeSel.innerHTML = '<option value="customize" selected>Customize</option>';
    }
  }

  // CFG Scale / Negative prompt (classic V3 only)
  if (qs('kling3CfgScaleGroup')) qs('kling3CfgScaleGroup').style.display = isV3Classic ? 'block' : 'none';
  if (qs('kling3NegativePromptGroup')) qs('kling3NegativePromptGroup').style.display = isV3Classic ? 'block' : 'none';

  // Duration/Aspect for V2V: only V2V Reference supports these; hidden for motion-control
  if (qs('kling3DurationGroup')) {
    qs('kling3DurationGroup').style.display = (showMotionControls || (isV2V && isV2VEdit)) ? 'none' : 'block';
  }
  if (qs('kling3AspectRatioGroup')) {
    qs('kling3AspectRatioGroup').style.display = (showMotionControls || (isV2V && isV2VEdit)) ? 'none' : 'block';
  }

  // Audio settings (not for motion-control)
  const showAudioSettings = !showMotionControls && (isV3Classic || isT2V || isRef || tab === 'o3-image-to-video' || isV2V);
  if (qs('kling3AudioSettings')) qs('kling3AudioSettings').style.display = showAudioSettings ? 'grid' : 'none';
  if (qs('kling3KeepAudioGroup')) qs('kling3KeepAudioGroup').style.display = isV2V ? 'block' : 'none';

  // Voice IDs (V3 classic + O3 T2V)
  if (qs('kling3VoiceGroup')) qs('kling3VoiceGroup').style.display = (isV3Classic || tab === 'o3-text-to-video') ? 'block' : 'none';

  // Aspect ratio with auto option for O3 V2V
  const arSel = qs('kling3AspectRatio');
  if (arSel) {
    if (isV2V && isV2VRef) {
      const hasAuto = Array.from(arSel.options).some(o => o.value === 'auto');
      if (!hasAuto) {
        const opt = document.createElement('option');
        opt.value = 'auto';
        opt.textContent = 'Auto';
        arSel.insertBefore(opt, arSel.firstChild);
        arSel.value = 'auto';
      }
    } else {
      const autoOpt = Array.from(arSel.options).find(o => o.value === 'auto');
      if (autoOpt) arSel.removeChild(autoOpt);
      if (arSel.value === 'auto') arSel.value = '16:9';
    }
  }

  // Multi-prompt section (not for motion-control)
  if (qs('kling3MultiPromptSection')) {
    qs('kling3MultiPromptSection').style.display = (isT2V || isI2V) ? 'block' : 'none';
  }

  // Animate
  const controls = qs('kling3Controls');
  if (controls) {
    controls.querySelectorAll('.settings-grid').forEach(grid => animateGrid(grid));
  }
}
function initKling3Controls() {
  ['kling3StartImageInput', 'kling3EndImageInput', 'kling3VideoInput', 'kling3RefImagesInput'].forEach((inputId) => {
    bindManagedUploadById(inputId);
  });

  const multiPromptCheck = qs('kling3UseMultiPrompt');
  if (multiPromptCheck) {
    multiPromptCheck.addEventListener('change', () => {
      const container = qs('kling3MultiPromptContainer');
      if (container) {
        container.style.display = multiPromptCheck.checked ? 'block' : 'none';
        if (multiPromptCheck.checked && kling3MultiPrompts.length === 0) {
          addKling3MultiPromptItem();
        }
      }
    });
  }

  const modelSel = qs('kling3Model');
  if (modelSel) {
    modelSel.addEventListener('change', () => {
      kling3SelectedModelByTab[currentKling3Tab] = modelSel.value;
      if (qs('videoModel') && isKling3VideoModelId(modelSel.value)) {
        const nextVideoTab = getVideoTabForKling3Tab(currentKling3Tab);
        if (nextVideoTab) currentVideoTab = nextVideoTab;
        refreshVideoModelDropdown(modelSel.value);
        updateVideoUiVisibility();
        renderVideoOptionsUI();
      }
      updateKling3UiVisibility();
    });
  }

  const motionOrientationSel = qs('kling3MotionOrientation');
  if (motionOrientationSel) {
    motionOrientationSel.addEventListener('change', () => {
      updateKling3UiVisibility();
    });
  }
  ['kling3StartImageInput', 'kling3EndImageInput', 'kling3VideoInput', 'kling3RefImagesInput'].forEach((inputId) => {
    const inputEl = qs(inputId);
    if (inputEl) setupDropZone(inputEl.closest('.upload-zone'), inputEl);
  });
}

function addKling3MultiPromptItem() {
  const id = Date.now();
  kling3MultiPrompts.push({ id, prompt: '', duration: '5' });
  renderKling3MultiPrompts();
  if (typeof saveAppState === 'function') saveAppState();
}
window.addKling3MultiPromptItem = addKling3MultiPromptItem;

function removeKling3MultiPromptItem(id) {
  kling3MultiPrompts = kling3MultiPrompts.filter(p => p.id !== id);
  renderKling3MultiPrompts();
  if (typeof saveAppState === 'function') saveAppState();
}
window.removeKling3MultiPromptItem = removeKling3MultiPromptItem;

function renderKling3MultiPrompts() {
  const list = qs('kling3MultiPromptList');
  if (!list) return;

  list.innerHTML = kling3MultiPrompts.map((item, idx) => `
    <div class="multi-prompt-item" data-id="${item.id}" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:0.5rem;margin-bottom:0.5rem;">
      <div class="field">
        <label>Shot ${idx + 1} Prompt *</label>
        <textarea class="k3-mp-prompt" data-id="${item.id}" rows="2" style="width:100%;resize:vertical;" placeholder="Describe this shot...">${escapeHtml(item.prompt)}</textarea>
      </div>
      <div style="display:flex;gap:0.5rem;align-items:flex-end;margin-top:0.35rem;">
        <div class="field" style="flex:1;">
          <label>Duration</label>
          <select class="k3-mp-duration" data-id="${item.id}">
            ${[3,4,5,6,7,8,9,10,11,12,13,14,15].map(d => `<option value="${d}" ${String(item.duration) === String(d) ? 'selected' : ''}>${d}s</option>`).join('')}
          </select>
        </div>
        <button type="button" onclick="removeKling3MultiPromptItem(${item.id})" style="background:var(--error);border:none;color:#fff;padding:0.4rem 0.6rem;border-radius:var(--radius-xs);cursor:pointer;">
          <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
        </button>
      </div>
    </div>
  `).join('');

  // Re-attach event listeners
  list.querySelectorAll('.k3-mp-prompt').forEach(el => {
    el.addEventListener('input', (e) => {
      const id = Number(e.target.dataset.id);
      const item = kling3MultiPrompts.find(p => p.id === id);
      if (item) item.prompt = e.target.value;
      if (typeof saveAppState === 'function') saveAppState();
    });
  });
  list.querySelectorAll('.k3-mp-duration').forEach(el => {
    el.addEventListener('change', (e) => {
      const id = Number(e.target.dataset.id);
      const item = kling3MultiPrompts.find(p => p.id === id);
      if (item) item.duration = e.target.value;
      if (typeof saveAppState === 'function') saveAppState();
    });
  });

  if (window.lucide) window.lucide.createIcons();
}

// Elements handling for Kling 3
function addKling3Element() {
  const selectedModelId = getSelectedKling3ModelId();
  if (isKling3MotionModelId(selectedModelId) && kling3Elements.length >= 1) {
    showToast(window.I18N ? I18N.t('toast_kling3_motion_one_element') : 'Kling 3 motion-control supports only one element.', 'error');
    return;
  }
  const id = Date.now();
  kling3Elements.push({ id, frontalImageFile: null, referenceImageFiles: [], videoFile: null });
  renderKling3Elements();
}
window.addKling3Element = addKling3Element;

function removeKling3Element(id) {
  kling3Elements = kling3Elements.filter(e => e.id !== id);
  renderKling3Elements();
}
window.removeKling3Element = removeKling3Element;

function handleElementFrontalUpload(id, file) {
  const item = kling3Elements.find(e => e.id === id);
  if (item) {
    item.frontalImageFile = file;
    renderKling3Elements();
  }
}

function handleElementRefUpload(id, files) {
  const item = kling3Elements.find(e => e.id === id);
  if (item) {
    item.referenceImageFiles = Array.from(files);
    renderKling3Elements();
  }
}

function handleElementVideoUpload(id, file) {
  const item = kling3Elements.find(e => e.id === id);
  if (item) {
    item.videoFile = file;
    renderKling3Elements();
  }
}

function renderKling3Elements() {
  const list = qs('kling3ElementsList');
  if (!list) return;

  const selectedModelId = getSelectedKling3ModelId();
  const isMotionModel = isKling3MotionModelId(selectedModelId);
  if (isMotionModel && kling3Elements.length > 1) {
    kling3Elements = kling3Elements.slice(0, 1);
  }
  const displayElements = isMotionModel ? kling3Elements.slice(0, 1) : kling3Elements;

  list.innerHTML = displayElements.map((item, idx) => {
    const gridColumns = isMotionModel ? '1fr 1fr' : '1fr 1fr 1fr';
    const videoFieldHtml = isMotionModel ? '' : `
        <div class="field">
          <label style="font-size:0.65rem;">${getI18nText('label_video_optional', 'Video (opt)')}</label>
          <div class="upload-zone small" onclick="document.getElementById('k3-el-video-${item.id}').click()" style="padding:0.3rem;font-size:0.65rem;">
            <i data-lucide="film" style="width:12px;height:12px;"></i>
            <span id="k3-el-video-label-${item.id}" style="font-size:0.6rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60px;">${escapeHtml(getI18nText('upload_video', 'Upload video'))}</span>
            <input type="file" id="k3-el-video-${item.id}" data-id="${item.id}" accept="video/*" hidden class="k3-el-video-input" />
          </div>
        </div>
    `;

    return `
    <div class="multi-prompt-item" data-id="${item.id}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.35rem;">
        <strong style="font-size:0.75rem;">@Element${idx + 1}</strong>
        <button type="button" onclick="removeKling3Element(${item.id})" title="${escapeHtml(getI18nText('btn_remove', 'Remove'))}" style="background:var(--error);border:none;color:#fff;padding:0.25rem 0.4rem;border-radius:var(--radius-xs);cursor:pointer;font-size:0.7rem;">
          <i data-lucide="trash-2" style="width:12px;height:12px;"></i>
        </button>
      </div>
      <div style="display:grid;grid-template-columns:${gridColumns};gap:0.35rem;">
        <div class="field">
          <label style="font-size:0.65rem;">${getI18nText('label_frontal_image', 'Frontal Image')}</label>
          <div class="upload-zone small" onclick="document.getElementById('k3-el-frontal-${item.id}').click()" style="padding:0.3rem;font-size:0.65rem;">
            <i data-lucide="image" style="width:12px;height:12px;"></i>
            <span id="k3-el-frontal-label-${item.id}" style="font-size:0.6rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60px;">${escapeHtml(getI18nText('upload_frontal', 'Upload frontal'))}</span>
            <input type="file" id="k3-el-frontal-${item.id}" data-id="${item.id}" accept="image/*" hidden class="k3-el-frontal-input" />
          </div>
        </div>
        <div class="field">
          <label style="font-size:0.65rem;">${getI18nText('label_ref_images_short', 'Ref Images')}</label>
          <div class="upload-zone small" onclick="document.getElementById('k3-el-refs-${item.id}').click()" style="padding:0.3rem;font-size:0.65rem;">
            <i data-lucide="images" style="width:12px;height:12px;"></i>
            <span id="k3-el-refs-label-${item.id}" style="font-size:0.6rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60px;">${escapeHtml(getI18nText('upload_refs', 'Upload refs'))}</span>
            <input type="file" id="k3-el-refs-${item.id}" data-id="${item.id}" accept="image/*" multiple hidden class="k3-el-refs-input" />
          </div>
        </div>
        ${videoFieldHtml}
      </div>
    </div>
  `;
  }).join('');

  displayElements.forEach((item) => {
    const frontalInput = qs(`k3-el-frontal-${item.id}`);
    if (frontalInput) {
      bindManagedUploadInput(frontalInput, {
        labelId: `k3-el-frontal-label-${item.id}`,
        emptyKey: 'upload_frontal',
        previewKind: 'image',
        kind: 'image',
        multiple: false,
        getFiles: () => {
          const current = kling3Elements.find((entry) => entry.id === item.id);
          return current && current.frontalImageFile ? [current.frontalImageFile] : [];
        },
        getRemoteItems: () => {
          const current = kling3Elements.find((entry) => entry.id === item.id);
          return current && current.frontalImageUrl ? [current.frontalImageUrl] : [];
        },
        setFiles: (next) => {
          const current = kling3Elements.find((entry) => entry.id === item.id);
          if (current) current.frontalImageFile = next || null;
        },
        setRemoteItems: (next) => {
          const current = kling3Elements.find((entry) => entry.id === item.id);
          if (current) current.frontalImageUrl = next && next.url ? next.url : '';
        },
      });
      setupDropZone(frontalInput.closest('.upload-zone'), frontalInput);
    }

    const refsInput = qs(`k3-el-refs-${item.id}`);
    if (refsInput) {
      bindManagedUploadInput(refsInput, {
        labelId: `k3-el-refs-label-${item.id}`,
        emptyKey: 'upload_refs',
        previewKind: 'image',
        kind: 'image',
        multiple: true,
        getFiles: () => {
          const current = kling3Elements.find((entry) => entry.id === item.id);
          return current ? current.referenceImageFiles : [];
        },
        getRemoteItems: () => {
          const current = kling3Elements.find((entry) => entry.id === item.id);
          return current ? current.referenceImageUrls || [] : [];
        },
        setFiles: (next) => {
          const current = kling3Elements.find((entry) => entry.id === item.id);
          if (current) current.referenceImageFiles = next;
        },
        setRemoteItems: (next) => {
          const current = kling3Elements.find((entry) => entry.id === item.id);
          if (current) current.referenceImageUrls = Array.isArray(next) ? next.map((entry) => entry.url).filter(Boolean) : [];
        },
      });
      setupDropZone(refsInput.closest('.upload-zone'), refsInput);
    }

    const videoInput = qs(`k3-el-video-${item.id}`);
    if (videoInput) {
      bindManagedUploadInput(videoInput, {
        labelId: `k3-el-video-label-${item.id}`,
        emptyKey: 'upload_video',
        previewKind: 'video',
        kind: 'video',
        multiple: false,
        getFiles: () => {
          const current = kling3Elements.find((entry) => entry.id === item.id);
          return current && current.videoFile ? [current.videoFile] : [];
        },
        getRemoteItems: () => {
          const current = kling3Elements.find((entry) => entry.id === item.id);
          return current && current.videoUrl ? [current.videoUrl] : [];
        },
        setFiles: (next) => {
          const current = kling3Elements.find((entry) => entry.id === item.id);
          if (current) current.videoFile = next || null;
        },
        setRemoteItems: (next) => {
          const current = kling3Elements.find((entry) => entry.id === item.id);
          if (current) current.videoUrl = next && next.url ? next.url : '';
        },
      });
      setupDropZone(videoInput.closest('.upload-zone'), videoInput);
    }
  });

  if (window.lucide) window.lucide.createIcons();
}

function collectKling3Options() {
  const options = {};
  const currentTab = currentKling3Tab || 'v3-text-to-video';
  const isMotion = currentTab === 'v3-motion-control';

  if (!isMotion) {
    // Use the specific option keys that match allowedOptions in VIDEO_MODELS
    const duration = qs('kling3Duration') ? qs('kling3Duration').value : '5';
    options.duration_kling3 = duration;

    const aspectRatio = qs('kling3AspectRatio') ? qs('kling3AspectRatio').value : '16:9';
    options.aspect_ratio_kling3 = aspectRatio;

    // Shot type - V3 T2V uses shot_type_v3 (customize/intelligent), others use shot_type_customize
    const shotType = qs('kling3ShotType') ? qs('kling3ShotType').value : 'customize';
    if (currentTab === 'v3-text-to-video') {
      options.shot_type_v3 = shotType;
    } else {
      options.shot_type_customize = shotType;
    }

    // O3 V2V uses aspect_ratio_o3_v2v with 'auto' option
    if (currentTab === 'o3-video-to-video') {
      options.aspect_ratio_o3_v2v = aspectRatio;
    }

    const cfgScale = qs('kling3CfgScale') ? qs('kling3CfgScale').value : '';
    if (cfgScale) options.cfg_scale = Number(cfgScale);

    const negPrompt = qs('kling3NegativePrompt') ? qs('kling3NegativePrompt').value.trim() : '';
    if (negPrompt) options.negative_prompt = negPrompt;

    const genAudio = qs('kling3GenerateAudio') ? qs('kling3GenerateAudio').value : 'true';
    options.generate_audio = genAudio === 'true';

    const keepAudio = qs('kling3KeepAudio') ? qs('kling3KeepAudio').value : 'true';
    options.keep_audio = keepAudio === 'true';

    const voiceIds = qs('kling3VoiceIds') ? qs('kling3VoiceIds').value.trim() : '';
    if (voiceIds) {
      options.voice_ids = voiceIds.split(',').map(s => s.trim()).filter(Boolean).slice(0, 2);
    }
  } else {
    const orientation = qs('kling3MotionOrientation') ? qs('kling3MotionOrientation').value : 'video';
    options.character_orientation_kling3_motion = orientation || 'video';

    const keepOriginalSound = qs('kling3KeepOriginalSound') ? qs('kling3KeepOriginalSound').value : 'true';
    options.keep_original_sound = keepOriginalSound === 'true';
  }

  // Elements will be handled separately in submitKling3Request (file uploads)
  const validElements = kling3Elements.filter((e) => (
    e.frontalImageFile
    || e.frontalImageUrl
    || (Array.isArray(e.referenceImageFiles) && e.referenceImageFiles.length > 0)
    || (Array.isArray(e.referenceImageUrls) && e.referenceImageUrls.length > 0)
    || e.videoFile
    || e.videoUrl
  ));
  if (validElements.length > 0) {
    options.hasElements = true;
  }

  return options;
}
async function submitKling3Request(task) {
  const modelId = getSelectedKling3ModelId(task && task.model_id ? task.model_id : '');
  const prompt = task.prompt;
  const options = collectKling3Options();

  const body = { model_id: modelId };

  // Check for multi-prompt mode
  const isMotionModel = isKling3MotionModelId(modelId);
  const useMultiPrompt = !isMotionModel && qs('kling3UseMultiPrompt') && qs('kling3UseMultiPrompt').checked;
  if (useMultiPrompt && kling3MultiPrompts.length > 0) {
    const validPrompts = kling3MultiPrompts.filter(p => p.prompt.trim());
    if (validPrompts.length === 0) throw new Error('At least one multi-prompt shot is required');
    body.multi_prompt = validPrompts.map(p => ({
      prompt: p.prompt.trim(),
      duration: p.duration,
    }));
  } else {
    if (!prompt && !isMotionModel) throw new Error('Prompt is required');
    if (prompt) body.prompt = prompt;
  }

  // Pass all options via body.options - backend will filter based on allowedOptions
  const mergedOptions = { ...options };
  
  // keep_audio goes directly on body for V2V models
  if (options.keep_audio !== undefined) {
    body.keep_audio = options.keep_audio;
    delete mergedOptions.keep_audio;
  }
  
  // Remove hasElements marker from options (we'll handle it below)
  delete mergedOptions.hasElements;

  if (Object.keys(mergedOptions).length > 0) body.options = mergedOptions;
  // Upload element files and build elements array
  const motionOrientation = qs('kling3MotionOrientation') ? qs('kling3MotionOrientation').value : 'video';
  const includeElements = !isMotionModel || motionOrientation === 'video';
  const sourceElements = isMotionModel ? kling3Elements.slice(0, 1) : kling3Elements;

  if (options.hasElements && sourceElements.length > 0 && includeElements) {
    const elementsArray = [];
    for (const el of sourceElements) {
      const hasRefImages = (Array.isArray(el.referenceImageFiles) && el.referenceImageFiles.length > 0)
        || (Array.isArray(el.referenceImageUrls) && el.referenceImageUrls.length > 0);
      if (isMotionModel) {
        if (!el.frontalImageFile && !el.frontalImageUrl && !hasRefImages) continue;
      } else if (!el.frontalImageFile && !el.frontalImageUrl && !el.videoFile && !el.videoUrl && !hasRefImages) {
        continue;
      }

      const elementObj = {};

      // Upload frontal image
      const frontalSource = (el.frontalImageUrl && createRemoteAssetItem({ url: el.frontalImageUrl, type: 'image' })) || el.frontalImageFile;
      if (frontalSource) {
        const u = await resolveUploadItemUrl(frontalSource, 'kling3-el-frontal', task);
        if (u) elementObj.frontal_image_url = u;
      }

      // Upload reference images
      const elementRefSources = [
        ...normalizeRemoteAssetItems(el.referenceImageUrls, 'image'),
        ...(Array.isArray(el.referenceImageFiles) ? el.referenceImageFiles : []),
      ];
      if (elementRefSources.length > 0) {
        const refUrls = await resolveUploadItemUrls(elementRefSources, 'kling3-el-ref', task, isMotionModel ? 3 : Infinity);
        if (refUrls.length > 0) elementObj.reference_image_urls = refUrls;
      }

      // Upload video (not supported for Kling 3 motion-control elements)
      const elementVideoSource = (el.videoUrl && createRemoteAssetItem({ url: el.videoUrl, type: 'video' })) || el.videoFile;
      if (!isMotionModel && elementVideoSource) {
        const u = await resolveUploadItemUrl(elementVideoSource, 'kling3-el-video', task);
        if (u) elementObj.video_url = u;
      }

      if (Object.keys(elementObj).length > 0) {
        elementsArray.push(elementObj);
      }
    }
    if (elementsArray.length > 0) {
      body.elements = elementsArray;
    }
  }

  // Upload images
  const kling3StartSource = getManagedUploadRemoteItems(MANAGED_UPLOADS.kling3StartImageInput)[0] || uploadedKling3StartImage;
  if (kling3StartSource) {
    const u = await resolveUploadItemUrl(kling3StartSource, 'kling3-start', task);
    if (u) body.image_url = u;
  }

  const kling3EndSource = getManagedUploadRemoteItems(MANAGED_UPLOADS.kling3EndImageInput)[0] || uploadedKling3EndImage;
  if (kling3EndSource) {
    const u = await resolveUploadItemUrl(kling3EndSource, 'kling3-end', task);
    if (u) body.end_image_url = u;
  }

  // Video URL or upload
  const videoUrl = qs('kling3VideoUrlInput') ? qs('kling3VideoUrlInput').value.trim() : '';
  if (videoUrl) body.video_url = videoUrl;
  const kling3VideoSource = getManagedUploadRemoteItems(MANAGED_UPLOADS.kling3VideoInput)[0] || uploadedKling3Video;
  if (kling3VideoSource) {
    const u = await resolveUploadItemUrl(kling3VideoSource, 'kling3-video', task);
    if (u) body.video_url = u;
  }

  // Reference images
  const kling3RefSources = [
    ...getManagedUploadRemoteItems(MANAGED_UPLOADS.kling3RefImagesInput),
    ...(Array.isArray(uploadedKling3RefImages) ? uploadedKling3RefImages : []),
  ];
  if (kling3RefSources.length > 0) {
    const imageUrls = await resolveUploadItemUrls(kling3RefSources, 'kling3-ref', task, 4);
    if (imageUrls.length > 0) body.image_urls = imageUrls;
  }

  const res = await fetch('/api/video-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await createResponseError(res, 'Video generation failed');
  return await res.json();
}

function replaceSelectOptions(selectEl, options, fallbackValue) {
  if (!selectEl) return;
  const currentValue = String(selectEl.value || '').trim();
  const nextValue = options.some((option) => option.value === currentValue)
    ? currentValue
    : (options.some((option) => option.value === fallbackValue) ? fallbackValue : (options[0] && options[0].value ? options[0].value : ''));
  selectEl.innerHTML = '';
  options.forEach((option) => {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    selectEl.appendChild(opt);
  });
  if (nextValue) selectEl.value = nextValue;
  if (typeof queueApplyPendingPersistedControls === 'function') queueApplyPendingPersistedControls();
}

function parseGptImageDimension(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num);
}

function updateGptSizeRangeFill(rangeEl) {
  if (!rangeEl) return;
  const min = Number(rangeEl.min) || 0;
  const max = Number(rangeEl.max) || 100;
  const val = Number(rangeEl.value) || min;
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 50;
  rangeEl.style.setProperty('--range-fill', Math.max(0, Math.min(100, pct)) + '%');
}

function bindGptSizePair(rangeId) {
  const rangeEl = qs(rangeId);
  const inputEl = qs(rangeId + 'Value');
  if (!rangeEl || !inputEl) return;
  const onRange = () => {
    inputEl.value = rangeEl.value;
    updateGptSizeRangeFill(rangeEl);
    if (typeof saveAppState === 'function') saveAppState();
  };
  rangeEl.addEventListener('input', onRange);
  rangeEl.addEventListener('change', onRange);
  const onInput = () => {
    const v = parseGptImageDimension(inputEl.value);
    if (v !== null) {
      const mn = Number(rangeEl.min) || 1;
      const mx = Number(rangeEl.max) || 4096;
      rangeEl.value = String(Math.max(mn, Math.min(mx, v)));
      updateGptSizeRangeFill(rangeEl);
    }
    if (typeof saveAppState === 'function') saveAppState();
  };
  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('change', onInput);
  updateGptSizeRangeFill(rangeEl);
}

function bindGptImage2CustomSizePair(widthId, heightId, hintId, selectId) {
  bindGptSizePair(widthId);
  bindGptSizePair(heightId);
}

function buildGptImageSizePayload(selectId, widthId, heightId, hintId, modelId) {
  const selectEl = qs(selectId);
  const sizeValue = selectEl ? String(selectEl.value || '').trim() : '';
  if (!sizeValue) return null;
  if (modelId !== GPT_IMAGE_2_TEXT_MODEL_ID && modelId !== GPT_IMAGE_2_EDIT_MODEL_ID) {
    return sizeValue;
  }
  if (sizeValue !== 'custom') return sizeValue;
  const inputW = qs(widthId + 'Value');
  const inputH = qs(heightId + 'Value');
  const rangeW = qs(widthId);
  const rangeH = qs(heightId);
  const rawWidth = parseGptImageDimension((inputW && inputW.value) || (rangeW && rangeW.value));
  const rawHeight = parseGptImageDimension((inputH && inputH.value) || (rangeH && rangeH.value));
  return { width: rawWidth, height: rawHeight };
}

function syncGptImage2CustomSizeFields(widthId, heightId, hintId, visible) {
  const rangeW = qs(widthId);
  const rangeH = qs(heightId);
  const inputW = qs(widthId + 'Value');
  const inputH = qs(heightId + 'Value');
  if (rangeW) updateGptSizeRangeFill(rangeW);
  if (rangeH) updateGptSizeRangeFill(rangeH);
}

function updateGptTextControls() {
  const modelSel = qs('imageModelText');
  const modelId = modelSel ? modelSel.value : '';
  const isGpt15 = modelId === GPT_IMAGE_15_TEXT_MODEL_ID;
  const isGpt2 = modelId === GPT_IMAGE_2_TEXT_MODEL_ID;
  const sizeSelect = qs('gptImageSize');
  const bgField = qs('gptBackgroundField');
  const customFields = qs('gptTextCustomSizeFields');

  if (sizeSelect) {
    const options = isGpt2 ? GPT_IMAGE_2_TEXT_SIZE_OPTIONS : GPT_IMAGE_15_TEXT_SIZE_OPTIONS;
    const fallback = isGpt2 ? GPT_IMAGE_2_TEXT_DEFAULT_SIZE : GPT_IMAGE_15_TEXT_SIZE_OPTIONS[0].value;
    replaceSelectOptions(sizeSelect, options, fallback);
  }
  if (bgField) bgField.style.display = isGpt15 ? '' : 'none';
  const customVisible = !!(isGpt2 && sizeSelect && sizeSelect.value === 'custom');
  if (customFields) customFields.style.display = customVisible ? 'grid' : 'none';
  syncGptImage2CustomSizeFields('gptImageWidth', 'gptImageHeight', 'gptTextCustomSizeHint', customVisible);
}

function updateGptEditControls() {
  const modelSel = qs('imageModelEdit');
  const modelId = modelSel ? modelSel.value : '';
  const isGpt15 = modelId === GPT_IMAGE_15_EDIT_MODEL_ID;
  const isGpt2 = modelId === GPT_IMAGE_2_EDIT_MODEL_ID;
  const sizeSelect = qs('editImageSize');
  const bgField = qs('editBackgroundField');
  const fidelityField = qs('editInputFidelityField');
  const customFields = qs('gptEditCustomSizeFields');

  if (sizeSelect) {
    const options = isGpt2 ? GPT_IMAGE_2_EDIT_SIZE_OPTIONS : GPT_IMAGE_15_EDIT_SIZE_OPTIONS;
    const fallback = isGpt2 ? GPT_IMAGE_2_EDIT_DEFAULT_SIZE : GPT_IMAGE_15_EDIT_SIZE_OPTIONS[0].value;
    replaceSelectOptions(sizeSelect, options, fallback);
  }
  if (bgField) bgField.style.display = isGpt15 ? '' : 'none';
  if (fidelityField) fidelityField.style.display = isGpt15 ? '' : 'none';
  const customVisible = !!(isGpt2 && sizeSelect && sizeSelect.value === 'custom');
  if (customFields) customFields.style.display = customVisible ? 'grid' : 'none';
  syncGptImage2CustomSizeFields('editImageWidth', 'editImageHeight', 'gptEditCustomSizeHint', customVisible);
}

function updateToolsGptControls() {
  const modelSel = qs('toolsModel');
  const modelId = modelSel ? modelSel.value : DEFAULT_TOOLS_MODEL;
  const isGpt15 = modelId === GPT_IMAGE_15_EDIT_MODEL_ID;
  const isGpt2 = modelId === GPT_IMAGE_2_EDIT_MODEL_ID;
  const wrap = qs('toolsGptImageOptions');
  const sizeSelect = qs('toolsGptImageSize');
  const customFields = qs('toolsGptCustomSizeFields');
  const bgField = qs('toolsGptBackgroundField');
  const fidelityField = qs('toolsGptFidelityField');

  if (wrap) wrap.style.display = (isGpt15 || isGpt2) ? 'grid' : 'none';
  if (sizeSelect) {
    const lastModelId = String(sizeSelect.dataset.modelId || '');
    const options = isGpt2 ? GPT_IMAGE_2_EDIT_SIZE_OPTIONS : GPT_IMAGE_15_EDIT_SIZE_OPTIONS;
    const fallback = isGpt2 ? GPT_IMAGE_2_TOOLS_DEFAULT_SIZE : '1024x1536';
    replaceSelectOptions(sizeSelect, options, fallback);
    if (((lastModelId && lastModelId !== modelId) || !lastModelId) && isGpt2) sizeSelect.value = GPT_IMAGE_2_TOOLS_DEFAULT_SIZE;
    sizeSelect.dataset.modelId = modelId;
  }
  if (isGpt2) {
    const widthInput = qs('toolsGptImageWidth');
    const heightInput = qs('toolsGptImageHeight');
    if (widthInput && (!String(widthInput.value || '').trim() || String(widthInput.dataset.modelId || '') !== modelId)) {
      widthInput.value = String(GPT_IMAGE_2_TOOLS_DEFAULT_WIDTH);
    }
    if (heightInput && (!String(heightInput.value || '').trim() || String(heightInput.dataset.modelId || '') !== modelId)) {
      heightInput.value = String(GPT_IMAGE_2_TOOLS_DEFAULT_HEIGHT);
    }
    if (widthInput) widthInput.dataset.modelId = modelId;
    if (heightInput) heightInput.dataset.modelId = modelId;
  }
  if (bgField) bgField.style.display = isGpt15 ? '' : 'none';
  if (fidelityField) fidelityField.style.display = isGpt15 ? '' : 'none';
  const customVisible = !!(isGpt2 && sizeSelect && sizeSelect.value === 'custom');
  if (customFields) customFields.style.display = customVisible ? 'grid' : 'none';
  syncGptImage2CustomSizeFields('toolsGptImageWidth', 'toolsGptImageHeight', 'toolsGptCustomSizeHint', customVisible);
}

function updateTextModelOptions() {
  const modelSel = qs('imageModelText');
  const modelId = modelSel ? modelSel.value : '';
  
  const fluxOpts = qs('fluxAdvancedOptions');
  const gptOpts = qs('gptImageOptions');
  const nanoOpts = qs('nanoBananaOptions');
  const nano2Opts = qs('nanoBanana2Options');
  const aspectGroup = qs('aspectRatioBaseGroup');
  const outputFormatSel = qs('textOutputFormat');
  
  const isFlux = modelId === 'flux-pro-v1.1-ultra';
  const isGpt = GPT_IMAGE_TEXT_MODEL_IDS.has(modelId);
  const isNano = modelId === 'nano-banana-pro';
  const isNano2 = modelId === 'nano-banana-2';

  if (outputFormatSel) {
    replaceSelectOptions(outputFormatSel, isGpt ? GPT_TEXT_OUTPUT_FORMAT_OPTIONS : TEXT_OUTPUT_FORMAT_OPTIONS, isGpt ? 'png' : 'jpeg');
  }
  
  if (fluxOpts) {
    fluxOpts.style.display = isFlux ? 'grid' : 'none';
    if (isFlux) animateGrid(fluxOpts);
  }
  if (gptOpts) {
    gptOpts.style.display = isGpt ? 'grid' : 'none';
    if (isGpt) {
      updateGptTextControls();
      animateGrid(gptOpts);
    }
  }
  if (nanoOpts) {
    nanoOpts.style.display = isNano ? 'grid' : 'none';
    if (isNano) animateGrid(nanoOpts);
  }
  if (nano2Opts) {
    nano2Opts.style.display = isNano2 ? 'grid' : 'none';
    if (isNano2) animateGrid(nano2Opts);
  }
  if (aspectGroup) aspectGroup.style.display = isGpt ? 'none' : 'block';
}

function updateEditModelOptions() {
  const modelSel = qs('imageModelEdit');
  const modelId = modelSel ? modelSel.value : '';
  
  const gptEditOpts = qs('gptEditOptions');
  const nanoEditOpts = qs('nanoEditOptions');
  const nano2EditOpts = qs('nano2EditOptions');
  
  const isGpt = GPT_IMAGE_EDIT_MODEL_IDS.has(modelId);
  const isNano = modelId === 'nano-banana-pro/edit';
  const isNano2 = modelId === 'nano-banana-2/edit';
  
  if (gptEditOpts) {
    gptEditOpts.style.display = isGpt ? 'block' : 'none';
    if (isGpt) {
      updateGptEditControls();
      animateGrid(gptEditOpts);
    }
  }
  if (nanoEditOpts) {
    nanoEditOpts.style.display = isNano ? 'block' : 'none';
    if (isNano) animateGrid(nanoEditOpts);
  }
  if (nano2EditOpts) {
    nano2EditOpts.style.display = isNano2 ? 'block' : 'none';
    if (isNano2) animateGrid(nano2EditOpts);
  }
}

// Animate section entrance
function animateSection(el) {
  if (!el) return;
  el.classList.remove('section-enter');
  // Force reflow to restart animation
  void el.offsetWidth;
  el.classList.add('section-enter');
  
  // Animate child grids
  el.querySelectorAll('.settings-grid').forEach(grid => {
    grid.classList.remove('grid-enter');
    void grid.offsetWidth;
    grid.classList.add('grid-enter');
  });
  el.querySelectorAll('.upload-grid').forEach(grid => {
    grid.classList.remove('grid-enter');
    void grid.offsetWidth;
    grid.classList.add('grid-enter');
  });
  el.querySelectorAll('.sub-tabs').forEach(tabs => {
    tabs.classList.remove('sub-tabs-enter');
    void tabs.offsetWidth;
    tabs.classList.add('sub-tabs-enter');
  });
}

function switchMode(mode) {
  if (mode === 'kling3') mode = 'video';
  if (mode !== 'tools') mode = 'tools';
  currentMode = mode;

  const modeIds = ['mode-text', 'mode-image', 'mode-video', 'mode-kling3', 'mode-3d', 'mode-tools'];
  for (const id of modeIds) {
    const el = qs(id);
    if (el) el.classList.remove('active');
  }
  const activeBtn = qs(`mode-${mode}`);
  if (activeBtn) activeBtn.classList.add('active');

  // Hide all sections first
  const sections = ['imageUploadGroup', 'videoUploadGroup', 'kling3UploadGroup', 'threeDUploadGroup', 'basicOptions', 'toolsSection'];
  sections.forEach(id => {
    const el = qs(id);
    if (el) {
      el.style.display = 'none';
      el.classList.remove('section-enter');
    }
  });

  // Show and animate the active section
  if (mode === 'text') {
    const el = qs('basicOptions');
    if (el) {
      el.style.display = 'block';
      animateSection(el);
    }
    updateTextModelOptions();
  }
  if (mode === 'image') {
    const el = qs('imageUploadGroup');
    if (el) {
      el.style.display = 'block';
      animateSection(el);
    }
    updateEditModelOptions();
  }
  if (mode === 'video') {
    const el = qs('videoUploadGroup');
    if (el) {
      el.style.display = 'block';
      animateSection(el);
    }
    ensureVideoControls();
    updateVideoUiVisibility();
    try { refreshVideo3TierUi(); } catch (_) {}
    // Re-arm the watchdog so a saved selection from a previous session is
    // reasserted if anything in the (re)open path overwrites it.
    if (typeof window.scheduleVideoRestoreWatchdog === 'function') {
      try { window.scheduleVideoRestoreWatchdog(); } catch (_) {}
    }
  }
  if (mode === '3d') {
    const el = qs('threeDUploadGroup');
    if (el) {
      el.style.display = 'block';
      animateSection(el);
    }
    update3dUiVisibility();
  }
  if (mode === 'tools') {
    const el = qs('toolsSection');
    if (el) {
      el.style.display = 'block';
      animateSection(el);
    }
    initToolsControls();
    switchToolsTool(currentToolsTool, { skipSave: true, force: true });
  } else {
    exitWizFullscreen();
  }

  // Hide/show prompt group & generate btn (tools mode has its own)
  const promptGroup = qs('promptGroup');
  if (promptGroup) promptGroup.style.display = mode === 'tools' ? 'none' : '';
  const genBtn = qs('generateBtn');
  if (genBtn) genBtn.style.display = mode === 'tools' ? 'none' : '';
  // Show @1/@2 reference hint only in image-edit mode
  const imgRefHint = qs('promptImgRefHint');
  if (imgRefHint) imgRefHint.style.display = mode === 'image' ? '' : 'none';

  requestAnimationFrame(() => {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  });

  if (typeof saveAppState === 'function') saveAppState();
}

// Make functions available to inline HTML handlers
window.switchMode = switchMode;
window.switchVideoTab = switchVideoTab;

// ---- TOOLS WIZARD ----
const WIZ_TOTAL = 6;
let _wizStep = 0;
let _wizAnimating = false;
let _toolsInitialized = false;

// Max images per model
const WIZ_MAX_IMAGES = { ...EDIT_MAX_IMAGES, 'nano-banana-2': 14 };
function wizMaxImages() {
  const m = qs('toolsModel') ? qs('toolsModel').value : DEFAULT_TOOLS_MODEL;
  return WIZ_MAX_IMAGES[m] || WIZ_MAX_IMAGES[DEFAULT_TOOLS_MODEL] || 4;
}
// --- Translated chip data ---
const WIZ_TITLE_CHIPS = {
  en: ['Premium Quality','Best Seller','New Season','Best Choice','Top Sales','Ideal Gift','Maximum Comfort','Stylish Design'],
  es: ['Calidad Premium','Más vendido','Novedad de temporada','Mejor elección','Top ventas','Regalo ideal','Máximo confort','Diseño elegante'],
  zh: ['优质品质','畅销热品','新品上市','最佳选择','销量冠军','理想礼物','极致舒适','时尚设计'],
  ar: ['جودة ممتازة','الأكثر مبيعًا','جديد الموسم','الخيار الأفضل','الأعلى مبيعًا','هدية مثالية','راحة قصوى','تصميم أنيق'],
  fr: ['Qualité Premium','Best-seller','Nouveauté saison','Meilleur choix','Top ventes','Cadeau idéal','Confort maximal','Design élégant'],
  ru: ['Премиум качество','Хит продаж','Новинка сезона','Лучший выбор','Топ продаж','Идеальный подарок','Максимальный комфорт','Стильный дизайн'],
  pt: ['Qualidade Premium','Mais vendido','Novidade da temporada','Melhor escolha','Top vendas','Presente ideal','Máximo conforto','Design elegante'],
  de: ['Premium Qualität','Bestseller','Neuheit der Saison','Beste Wahl','Top Verkäufe','Ideales Geschenk','Maximaler Komfort','Stilvolles Design'],
  ja: ['プレミアム品質','大人気商品','新作','ベストチョイス','売上トップ','理想のギフト','最高の快適さ','スタイリッシュデザイン'],
  ko: ['프리미엄 품질','베스트셀러','신상품','최고의 선택','판매 1위','이상적인 선물','최고의 편안함','스타일리시 디자인'],
};
const WIZ_CHAR_CHIPS = {
  en: ['Natural materials','Size: S-XXL','Waterproof','Hypoallergenic','Handmade','Quality guarantee','Eco-friendly','High durability','Easy care','Premium packaging','Thermal insulation','Lightweight'],
  es: ['Materiales naturales','Talla: S-XXL','Impermeable','Hipoalergénico','Hecho a mano','Garantía de calidad','Ecológico','Alta durabilidad','Fácil cuidado','Embalaje premium','Aislamiento térmico','Ligero'],
  zh: ['天然材料','尺码: S-XXL','防水','低敏','手工制作','品质保证','环保','高耐久','易打理','精美包装','隔热','轻量'],
  ar: ['مواد طبيعية','المقاس: S-XXL','مقاوم للماء','مضاد للحساسية','صناعة يدوية','ضمان الجودة','صديق للبيئة','متانة عالية','سهل العناية','تغليف فاخر','عزل حراري','خفيف الوزن'],
  fr: ['Matériaux naturels','Taille: S-XXL','Imperméable','Hypoallergénique','Fait main','Garantie qualité','Écologique','Haute durabilité','Entretien facile','Emballage premium','Isolation thermique','Léger'],
  ru: ['Натуральные материалы','Размер: S-XXL','Водонепроницаемый','Гипоаллергенный','Ручная работа','Гарантия качества','Экологичный','Высокая прочность','Лёгкий уход','Премиум упаковка','Термоизоляция','Лёгкий вес'],
  pt: ['Materiais naturais','Tamanho: S-XXL','Impermeável','Hipoalergênico','Feito à mão','Garantia de qualidade','Ecológico','Alta durabilidade','Fácil manutenção','Embalagem premium','Isolamento térmico','Leve'],
  de: ['Naturmaterialien','Größe: S-XXL','Wasserdicht','Hypoallergen','Handarbeit','Qualitätsgarantie','Umweltfreundlich','Hohe Haltbarkeit','Pflegeleicht','Premium-Verpackung','Wärmedämmung','Leichtgewicht'],
  ja: ['天然素材','サイズ: S-XXL','防水','低アレルギー','ハンドメイド','品質保証','エコフレンドリー','高耐久性','お手入れ簡単','プレミアム梱包','断熱性','軽量'],
  ko: ['천연 소재','사이즈: S-XXL','방수','저자극성','수제','품질 보증','친환경','높은 내구성','관리 용이','프리미엄 포장','단열','경량'],
};

// --- Font style data (name, CSS inline style, prompt value) ---
const WIZ_FONTS = [
  { name: 'Bold Sans', css: 'font-weight:900;letter-spacing:-0.03em;font-family:var(--font-body);', val: 'wiz_font_bold_sans' },
  { name: 'Elegant Serif', css: 'font-family:var(--font-display);font-style:italic;font-weight:400;', val: 'wiz_font_elegant_serif' },
  { name: 'Geometric', css: 'font-weight:600;letter-spacing:0.12em;text-transform:uppercase;font-size:0.95rem;', val: 'wiz_font_geometric' },
  { name: 'Soft Rounded', css: 'font-weight:500;letter-spacing:0.04em;font-family:var(--font-body);', val: 'wiz_font_soft_rounded' },
  { name: 'Classic', css: 'font-weight:700;font-family:var(--font-display);letter-spacing:0.02em;', val: 'wiz_font_classic' },
  { name: 'Handwritten', css: "font-family:'Segoe Script','Bradley Hand',cursive;", val: 'wiz_font_handwritten' },
  { name: 'Thin Light', css: 'font-weight:300;letter-spacing:0.06em;font-family:var(--font-body);', val: 'wiz_font_thin_light' },
  { name: 'Monospace', css: "font-family:'Courier New',Courier,monospace;font-weight:700;", val: 'wiz_font_monospace' },
  { name: 'Display Bold', css: 'font-weight:700;font-family:var(--font-display);font-size:1.5rem;letter-spacing:-0.03em;', val: 'wiz_font_display_bold' },
  { name: 'Condensed', css: 'font-weight:600;letter-spacing:-0.06em;font-stretch:condensed;font-family:var(--font-body);', val: 'wiz_font_condensed' },
  { name: 'Extra Bold', css: 'font-weight:800;font-family:var(--font-body);letter-spacing:0.02em;', val: 'wiz_font_extra_bold' },
  { name: 'Thin Serif', css: 'font-weight:200;font-family:var(--font-display);letter-spacing:0.04em;', val: 'wiz_font_thin_serif' },
  { name: 'Wide Caps', css: 'font-weight:600;letter-spacing:0.25em;text-transform:uppercase;font-size:0.8rem;', val: 'wiz_font_wide_caps' },
  { name: 'Italic Classic', css: 'font-style:italic;font-weight:700;font-family:var(--font-display);', val: 'wiz_font_italic_classic' },
  { name: 'Script', css: "font-family:'Segoe Script','Brush Script MT',cursive;font-weight:400;font-size:1.3rem;", val: 'wiz_font_script' },
  { name: 'Stencil', css: 'font-weight:900;letter-spacing:0.15em;text-transform:uppercase;font-family:var(--font-body);', val: 'wiz_font_stencil' },
  { name: 'Rounded Bold', css: 'font-weight:700;letter-spacing:0.03em;font-family:var(--font-body);', val: 'wiz_font_rounded_bold' },
  { name: 'Slab Serif', css: "font-weight:700;font-family:'Rockwell','Courier New',serif;letter-spacing:0.01em;", val: 'wiz_font_slab_serif' },
  { name: 'Neon Glow', css: 'font-weight:400;font-family:var(--font-body);letter-spacing:0.08em;text-shadow:0 0 4px var(--accent-bright);', val: 'wiz_font_neon_glow' },
  { name: 'Retro', css: "font-weight:700;font-family:'Courier New',monospace;letter-spacing:0.1em;text-transform:uppercase;font-size:0.85rem;", val: 'wiz_font_retro' },
  { name: 'Minimalist', css: 'font-weight:400;font-family:var(--font-body);letter-spacing:0.08em;', val: 'wiz_font_minimalist' },
  { name: 'Black Impact', css: "font-weight:900;font-family:'Impact','Arial Black',sans-serif;letter-spacing:0.01em;", val: 'wiz_font_black_impact' },
  { name: 'Calligraphy', css: "font-family:'Segoe Script','Palatino',cursive;font-weight:300;font-style:italic;font-size:1.2rem;", val: 'wiz_font_calligraphy' },
  { name: 'Futuristic', css: 'font-weight:600;letter-spacing:0.18em;text-transform:uppercase;font-family:var(--font-body);font-size:0.75rem;', val: 'wiz_font_futuristic' },
  { name: 'Art Deco', css: 'font-weight:700;letter-spacing:0.1em;font-family:var(--font-display);text-transform:uppercase;font-size:0.9rem;', val: 'wiz_font_art_deco' },
  { name: 'Playful', css: "font-weight:700;font-family:'Comic Sans MS','Segoe UI',sans-serif;letter-spacing:0.02em;", val: 'wiz_font_playful' },
  { name: 'Newspaper', css: "font-weight:700;font-family:'Times New Roman',Times,serif;font-style:italic;", val: 'wiz_font_newspaper' },
  { name: 'Gothic', css: "font-weight:900;font-family:'Trebuchet MS',var(--font-body);letter-spacing:-0.02em;text-transform:uppercase;", val: 'wiz_font_gothic' },
  { name: 'Brush Stroke', css: "font-family:'Segoe Script','Bradley Hand',cursive;font-weight:700;font-size:1.4rem;", val: 'wiz_font_brush_stroke' },
  { name: 'Tech Narrow', css: "font-weight:500;font-family:'Arial Narrow',var(--font-body);letter-spacing:0.04em;font-stretch:condensed;", val: 'wiz_font_tech_narrow' },
  { name: 'Vintage Label', css: "font-weight:700;font-family:'Georgia',serif;letter-spacing:0.08em;text-transform:uppercase;font-size:0.85rem;border-bottom:2px solid currentColor;padding-bottom:2px;", val: 'wiz_font_vintage_label' },
  { name: 'Luxury Thin', css: "font-weight:200;font-family:'Didot','Georgia',serif;letter-spacing:0.15em;text-transform:uppercase;font-size:0.8rem;", val: 'wiz_font_luxury_thin' },
  { name: 'Grunge Bold', css: "font-weight:900;font-family:'Impact','Arial Black',sans-serif;letter-spacing:-0.02em;text-transform:uppercase;", val: 'wiz_font_grunge_bold' },
  { name: 'Elegant Italic', css: "font-weight:300;font-family:'Palatino','Georgia',serif;font-style:italic;letter-spacing:0.04em;font-size:1.15rem;", val: 'wiz_font_elegant_italic' },
  { name: 'Tech Mono', css: "font-weight:600;font-family:'Consolas','Courier New',monospace;letter-spacing:0.06em;font-size:0.85rem;", val: 'wiz_font_tech_mono' },
  { name: 'Rounded Soft', css: "font-weight:500;font-family:'Trebuchet MS',var(--font-body);letter-spacing:0.06em;", val: 'wiz_font_rounded_soft' },
  { name: 'Stamp', css: "font-weight:900;letter-spacing:0.12em;text-transform:uppercase;font-size:0.78rem;border:2px solid currentColor;padding:2px 6px;display:inline-block;", val: 'wiz_font_stamp' },
  { name: 'Handprint', css: "font-family:'Comic Sans MS','Segoe Script',cursive;font-weight:400;letter-spacing:0.02em;font-size:1.1rem;", val: 'wiz_font_handprint' },
  { name: 'Corporate', css: "font-weight:600;font-family:'Cambria','Georgia',serif;letter-spacing:0.03em;", val: 'wiz_font_corporate' },
  { name: 'Poster Bold', css: "font-weight:900;font-family:var(--font-body);letter-spacing:-0.04em;font-size:1.6rem;line-height:1;", val: 'wiz_font_poster_bold' },
  { name: 'Whisper Light', css: "font-weight:100;font-family:var(--font-body);letter-spacing:0.12em;font-size:0.9rem;", val: 'wiz_font_whisper_light' },
  { name: 'Typewriter', css: "font-weight:400;font-family:'Courier New',monospace;letter-spacing:0.08em;font-size:0.82rem;", val: 'wiz_font_typewriter' },
  { name: 'Magazine', css: "font-weight:700;font-family:'Georgia',serif;font-size:1.3rem;letter-spacing:-0.01em;font-style:italic;", val: 'wiz_font_magazine' },
  { name: 'Clean Modern', css: "font-weight:500;font-family:'Segoe UI','Helvetica',sans-serif;letter-spacing:0.04em;", val: 'wiz_font_clean_modern' },
  { name: 'Heavy Shadow', css: "font-weight:900;font-family:var(--font-body);letter-spacing:0.02em;text-shadow:2px 2px 0 rgba(0,0,0,0.2);font-size:1.2rem;", val: 'wiz_font_heavy_shadow' },
  { name: 'Outline', css: "font-weight:700;font-family:var(--font-body);letter-spacing:0.06em;-webkit-text-stroke:1px currentColor;color:transparent;font-size:1.2rem;", val: 'wiz_font_outline' },
  { name: 'Small Caps', css: "font-weight:600;font-family:'Georgia',serif;font-variant:small-caps;letter-spacing:0.08em;font-size:0.95rem;", val: 'wiz_font_small_caps' },
  { name: 'Sporty', css: "font-weight:800;font-family:'Impact','Arial Black',sans-serif;font-style:italic;letter-spacing:0.02em;font-size:1.15rem;", val: 'wiz_font_sporty' },
  { name: 'Chalk', css: "font-weight:400;font-family:'Segoe Script','Bradley Hand',cursive;letter-spacing:0.03em;font-size:1.1rem;opacity:0.9;", val: 'wiz_font_chalk' },
];

function getToolsUtilitySource() {
  return getManagedUploadPrimarySource(MANAGED_UPLOADS.toolsUtilityImageInput, uploadedToolsUtilityImage);
}

function getToolsUtilityAudioSource() {
  return getManagedUploadPrimarySource(MANAGED_UPLOADS.toolsUtilityAudioInput, uploadedToolsUtilityAudio);
}

function getToolsUtilityVideoSource() {
  return getManagedUploadPrimarySource(MANAGED_UPLOADS.toolsUtilityVideoInput, uploadedToolsUtilityVideo);
}

function getActiveToolsModelId() {
  if (currentToolsTool === 'enhancer') return TOOLS_TOOL_MODEL_IDS.enhancer;
  if (currentToolsTool === 'background-removal') return TOOLS_TOOL_MODEL_IDS['background-removal'];
  if (currentToolsTool === 'sam-audio') {
    return qs('toolsSamAudioModel') ? qs('toolsSamAudioModel').value : TOOLS_TOOL_MODEL_IDS['sam-audio'];
  }
  if (currentToolsTool === 'heygen-translate') return TOOLS_TOOL_MODEL_IDS['heygen-translate'];
  return qs('toolsModel') ? qs('toolsModel').value : DEFAULT_TOOLS_MODEL;
}

function refreshToolsUtilitySourceUi() {
  const imageConfig = MANAGED_UPLOADS.toolsUtilityImageInput;
  const source = getToolsUtilitySource();
  const labelText = getManagedUploadLabel(imageConfig, getManagedUploadFiles(imageConfig));
  const idleLabel = toolsUiText('tools_utility_idle_label', 'Click or drag a source image');
  const hintText = source
    ? toolsUiText('tools_utility_ready_hint', 'Shared source image is ready for every utility tool.')
    : toolsUiText('tools_utility_idle_hint', 'PNG, JPG, WebP, HEIC');

  const enhancerLabel = qs('toolsUtilityImageLabel');
  if (enhancerLabel) enhancerLabel.textContent = labelText || idleLabel;
  const enhancerHint = qs('toolsUtilityImageHint');
  if (enhancerHint) enhancerHint.textContent = hintText;

  const bgLabel = qs('toolsBgRemovalImageLabel');
  if (bgLabel) bgLabel.textContent = source ? toolsUiText('tools_cutout_ready_label', 'Source image ready for cutout') : idleLabel;
  const bgHint = qs('toolsBgRemovalImageHint');
  if (bgHint) {
    bgHint.textContent = source
      ? toolsUiText('tools_cutout_ready_hint', 'You can switch between Enhancer and Cutout without re-uploading.')
      : toolsUiText('tools_cutout_idle_hint', 'Drop once, then switch between utility tools freely');
  }

  ['toolsUtilityImageDropzone', 'toolsBgRemovalDropzone'].forEach((zoneId) => {
    const zone = qs(zoneId);
    if (zone) zone.classList.toggle('is-loaded', !!source);
  });

  const audioConfig = MANAGED_UPLOADS.toolsUtilityAudioInput;
  const audioSource = getToolsUtilityAudioSource();
  const audioLabel = qs('toolsUtilityAudioLabel');
  if (audioLabel) audioLabel.textContent = getManagedUploadLabel(audioConfig, getManagedUploadFiles(audioConfig));
  const audioHint = qs('toolsUtilityAudioHint');
  if (audioHint) {
    audioHint.textContent = audioSource
      ? toolsUiText('tools_sam_audio_ready_hint', 'Audio source is ready for separation.')
      : toolsUiText('tools_sam_audio_idle_hint', 'WAV, MP3, FLAC');
  }
  const audioZone = qs('toolsUtilityAudioDropzone');
  if (audioZone) audioZone.classList.toggle('is-loaded', !!audioSource);

  const videoConfig = MANAGED_UPLOADS.toolsUtilityVideoInput;
  const videoSource = getToolsUtilityVideoSource();
  const videoLabel = qs('toolsUtilityVideoLabel');
  if (videoLabel) videoLabel.textContent = getManagedUploadLabel(videoConfig, getManagedUploadFiles(videoConfig));
  const videoHint = qs('toolsUtilityVideoHint');
  if (videoHint) {
    videoHint.textContent = videoSource
      ? toolsUiText('tools_heygen_ready_hint', 'Source video is ready for translation.')
      : toolsUiText('tools_heygen_idle_hint', 'MP4, MOV, WebM');
  }
  const videoZone = qs('toolsUtilityVideoDropzone');
  if (videoZone) videoZone.classList.toggle('is-loaded', !!videoSource);
}

function clampEnhancerValue(value, meta) {
  if (!meta) return value;
  const min = Number(meta.min);
  const max = Number(meta.max);
  const step = Number(meta.step) || 1;
  const precision = Number.isFinite(meta.precision) ? meta.precision : (String(step).includes('.') ? String(step).split('.')[1].length : 0);
  let next = Number(value);
  if (!Number.isFinite(next)) next = Number.isFinite(min) ? min : 0;
  if (Number.isFinite(min)) next = Math.max(min, next);
  if (Number.isFinite(max)) next = Math.min(max, next);
  if (step > 0 && Number.isFinite(min)) {
    next = min + Math.round((next - min) / step) * step;
  }
  next = Number(next.toFixed(precision));
  return next;
}

function formatEnhancerValue(value, meta) {
  const precision = Number.isFinite(meta && meta.precision)
    ? meta.precision
    : (meta && String(meta.step || '').includes('.') ? String(meta.step).split('.')[1].length : 0);
  return precision > 0 ? Number(value).toFixed(precision) : String(Math.round(Number(value)));
}

function syncEnhancerRangeControl(meta, source = 'input', emit = false) {
  if (!meta) return;
  const inputEl = qs(meta.inputId);
  const rangeEl = qs(meta.rangeId);
  if (!inputEl || !rangeEl) return;
  const rawValue = source === 'range' ? rangeEl.value : inputEl.value;
  const next = clampEnhancerValue(rawValue, meta);
  const nextStr = formatEnhancerValue(next, meta);
  inputEl.value = nextStr;
  rangeEl.value = nextStr;
  const min = Number(meta.min);
  const max = Number(meta.max);
  const percent = Number.isFinite(min) && Number.isFinite(max) && max > min
    ? ((next - min) / (max - min)) * 100
    : 0;
  rangeEl.style.setProperty('--range-fill', `${Math.max(0, Math.min(100, percent))}%`);
  if (emit) {
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function initToolsEnhancerRanges() {
  TOPAZ_RANGE_CONTROLS.forEach((meta) => {
    const inputEl = qs(meta.inputId);
    const rangeEl = qs(meta.rangeId);
    if (!inputEl || !rangeEl || rangeEl._topazBound) return;
    rangeEl._topazBound = true;

    syncEnhancerRangeControl(meta, 'input', false);

    rangeEl.addEventListener('input', () => syncEnhancerRangeControl(meta, 'range', true));
    rangeEl.addEventListener('change', () => syncEnhancerRangeControl(meta, 'range', true));
    inputEl.addEventListener('input', () => syncEnhancerRangeControl(meta, 'input', false));
    inputEl.addEventListener('change', () => syncEnhancerRangeControl(meta, 'input', false));
    inputEl.addEventListener('blur', () => syncEnhancerRangeControl(meta, 'input', false));
  });
}

function closeToolsHelpPopover() {
  if (activeToolsHelpButton) {
    activeToolsHelpButton.setAttribute('aria-expanded', 'false');
    activeToolsHelpButton = null;
  }
  if (toolsHelpPopoverEl) {
    toolsHelpPopoverEl.classList.remove('is-open');
  }
}

function ensureToolsHelpPopover() {
  bindGlobalToolsHelpInteractions();
  if (toolsHelpPopoverEl) return toolsHelpPopoverEl;
  const pop = document.createElement('div');
  pop.className = 'tools-help-popover';
  pop.innerHTML = `<div class="tools-help-popover-title">${toolsUiText('tools_help_title', 'Setting Help')}</div><div class="tools-help-popover-copy"></div>`;
  document.body.appendChild(pop);
  toolsHelpPopoverEl = pop;

  document.addEventListener('click', (event) => {
    if (!toolsHelpPopoverEl || !toolsHelpPopoverEl.classList.contains('is-open')) return;
    const target = event.target;
    if (toolsHelpPopoverEl.contains(target)) return;
    if (activeToolsHelpButton && activeToolsHelpButton.contains(target)) return;
    closeToolsHelpPopover();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeToolsHelpPopover();
  });
  window.addEventListener('resize', closeToolsHelpPopover);
  window.addEventListener('scroll', closeToolsHelpPopover, true);

  return pop;
}

function positionToolsHelpPopover(anchorEl) {
  if (!anchorEl || !toolsHelpPopoverEl) return;
  const rect = anchorEl.getBoundingClientRect();
  const popRect = toolsHelpPopoverEl.getBoundingClientRect();
  const margin = 10;
  let left = rect.left + rect.width / 2 - popRect.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));

  let top = rect.bottom + 10;
  if (top + popRect.height > window.innerHeight - margin) {
    top = rect.top - popRect.height - 10;
  }
  top = Math.max(margin, top);

  toolsHelpPopoverEl.style.left = `${left}px`;
  toolsHelpPopoverEl.style.top = `${top}px`;
}

function openToolsHelpPopover(buttonEl, key, titleText) {
  const pop = ensureToolsHelpPopover();
  const copyEl = pop.querySelector('.tools-help-popover-copy');
  const titleEl = pop.querySelector('.tools-help-popover-title');
  if (!copyEl || !titleEl) return;

  if (activeToolsHelpButton === buttonEl && pop.classList.contains('is-open')) {
    closeToolsHelpPopover();
    return;
  }

  if (activeToolsHelpButton) activeToolsHelpButton.setAttribute('aria-expanded', 'false');
  activeToolsHelpButton = buttonEl;
  activeToolsHelpButton.setAttribute('aria-expanded', 'true');
  titleEl.textContent = titleText || toolsUiText('tools_help_title', 'Setting Help');
  copyEl.textContent = toolsUiText(TOPAZ_HELP_TEXT[key], toolsUiText('tools_help_fallback', 'No description is available for this setting yet.'));
  pop.classList.add('is-open');
  requestAnimationFrame(() => positionToolsHelpPopover(buttonEl));
}

function bindToolsHelpButton(buttonEl, targetSpec, resolveTitleText, fallbackTitle = '') {
  if (!buttonEl || !targetSpec) return;
  const nextTitle = typeof resolveTitleText === 'function' ? resolveTitleText() : fallbackTitle;
  buttonEl.dataset.helpKey = targetSpec.key;
  buttonEl._resolveToolsHelpTitle = resolveTitleText;
  buttonEl.setAttribute('aria-label', toolsHelpAria(nextTitle));
  buttonEl.setAttribute('aria-expanded', buttonEl.getAttribute('aria-expanded') || 'false');
  buttonEl.title = nextTitle;
  if (buttonEl._toolsHelpBound) return;
  buttonEl._toolsHelpBound = true;
  buttonEl.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const title = typeof buttonEl._resolveToolsHelpTitle === 'function' ? buttonEl._resolveToolsHelpTitle() : fallbackTitle;
    openToolsHelpPopover(buttonEl, targetSpec.key, title);
  });
}

function attachTopazHelpButton(targetSpec) {
  if (!targetSpec || !targetSpec.selector) return;
  const baseTarget = qs(targetSpec.selector);
  if (!baseTarget) return;

  let mountEl = baseTarget;
  let titleText = '';

  if (targetSpec.placement === 'toggle') {
    const toggleLabel = baseTarget.closest('label.tools-utility-toggle');
    if (!toggleLabel) return;
    let copyWrap = toggleLabel.querySelector('.tools-toggle-copy');
    const labelSpan = toggleLabel.querySelector('.tools-toggle-copy > span[data-i18n], .tools-toggle-copy > span, span[data-i18n], span');
    if (!copyWrap && labelSpan) {
      copyWrap = document.createElement('span');
      copyWrap.className = 'tools-toggle-copy';
      labelSpan.parentNode.insertBefore(copyWrap, labelSpan);
      copyWrap.appendChild(labelSpan);
    }
    mountEl = copyWrap || toggleLabel;
    titleText = labelSpan ? labelSpan.textContent.trim() : toolsUiText('tools_help_title', 'Setting Help');
  } else {
    mountEl = baseTarget;
    titleText = baseTarget.textContent.trim() || toolsUiText('tools_help_title', 'Setting Help');
    mountEl.classList.add('tools-setting-head');
  }

  if (!mountEl) return;

  const resolveTitleText = () => {
    if (targetSpec.placement === 'toggle') {
      const labelSpan = baseTarget.closest('label.tools-utility-toggle')?.querySelector('.tools-toggle-copy > span[data-i18n], .tools-toggle-copy > span, span[data-i18n], span');
      return (labelSpan ? labelSpan.textContent : '').trim() || toolsUiText('tools_help_title', 'Setting Help');
    }
    const labelSpan = baseTarget.querySelector('span[data-i18n], span');
    if (labelSpan) return (labelSpan.textContent || '').trim() || toolsUiText('tools_help_title', 'Setting Help');
    const plainText = Array.from(baseTarget.childNodes || [])
      .filter((node) => !(node.nodeType === 1 && node.classList && node.classList.contains('tools-help-btn')))
      .map((node) => node.textContent || '')
      .join(' ')
      .trim();
    return plainText || toolsUiText('tools_help_title', 'Setting Help');
  };

  const existingBtn = mountEl.querySelector(`.tools-help-btn[data-help-key="${targetSpec.key}"]`);
  if (existingBtn) {
    bindToolsHelpButton(existingBtn, targetSpec, resolveTitleText, titleText);
    return;
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tools-help-btn';
  btn.textContent = '?';
  bindToolsHelpButton(btn, targetSpec, resolveTitleText, titleText);

  mountEl.appendChild(btn);
}

function initTopazHelpButtons() {
  bindGlobalToolsHelpInteractions();
  TOPAZ_HELP_TARGETS.forEach(attachTopazHelpButton);
}

function updateToolsEnhancerUi() {
  const model = qs('toolsEnhancerModel') ? qs('toolsEnhancerModel').value : 'Standard V2';
  const showSubject = TOPAZ_SUBJECT_MODELS.has(model);
  const showFace = TOPAZ_FACE_MODELS.has(model);
  const faceEnabled = !!(showFace && qs('toolsEnhancerFaceEnhancement') && qs('toolsEnhancerFaceEnhancement').checked);
  const showSharpenDenoise = TOPAZ_SHARPEN_DENOISE_MODELS.has(model);
  const showFixCompression = TOPAZ_FIX_COMPRESSION_MODELS.has(model);
  const showStrength = model === 'Text Refine';
  const showDetail = model === 'Recovery V2';
  const showGenerative = model === 'Redefine';

  const setVisible = (id, visible) => {
    const el = qs(id);
    if (el) el.style.display = visible ? '' : 'none';
  };

  setVisible('toolsEnhancerSubjectField', showSubject);
  setVisible('toolsEnhancerFaceToggleField', showFace);
  setVisible('toolsEnhancerFaceStrengthField', faceEnabled);
  setVisible('toolsEnhancerFaceCreativityField', faceEnabled);
  setVisible('toolsEnhancerSharpenField', showSharpenDenoise);
  setVisible('toolsEnhancerDenoiseField', showSharpenDenoise);
  setVisible('toolsEnhancerFixCompressionField', showFixCompression);
  setVisible('toolsEnhancerStrengthField', showStrength);
  setVisible('toolsEnhancerDetailField', showDetail);
  setVisible('toolsEnhancerCreativityField', showGenerative);
  setVisible('toolsEnhancerTextureField', showGenerative);
  setVisible('toolsEnhancerAutopromptField', showGenerative);
  setVisible('toolsEnhancerPromptField', showGenerative);

  const noteEl = qs('toolsEnhancerModelNote');
  if (noteEl) {
    const noteKey = TOPAZ_MODEL_NOTES[model] || 'tools_enhancer_note_fallback';
    noteEl.textContent = toolsUiText(noteKey, 'Only settings supported by the selected Topaz model are shown below.');
  }

  if (activeToolsHelpButton) {
    const hiddenField = activeToolsHelpButton.closest('.field, .tools-utility-toggle, .group-label');
    if (!document.body.contains(activeToolsHelpButton) || (hiddenField && hiddenField.offsetParent === null)) {
      closeToolsHelpPopover();
    }
  }
  TOPAZ_RANGE_CONTROLS.forEach((meta) => syncEnhancerRangeControl(meta, 'input', false));
}

function getToolsSamAudioModelId() {
  return qs('toolsSamAudioModel') ? qs('toolsSamAudioModel').value : TOOLS_TOOL_MODEL_IDS['sam-audio'];
}

function createToolsSamAudioSpanRow(span = {}) {
  const row = document.createElement('div');
  row.className = 'tools-sam-span-row';
  row.innerHTML =
    `<div class="field">` +
      `<label>${toolsUiText('tools_sam_audio_span_start', 'Start (s)')}</label>` +
      `<input type="number" class="tools-sam-span-start" min="0" step="0.1" value="${escapeHtml(String(Number.isFinite(Number(span.start)) ? Number(span.start) : 0))}">` +
    `</div>` +
    `<div class="field">` +
      `<label>${toolsUiText('tools_sam_audio_span_end', 'End (s)')}</label>` +
      `<input type="number" class="tools-sam-span-end" min="0" step="0.1" value="${escapeHtml(String(Number.isFinite(Number(span.end)) ? Number(span.end) : 10))}">` +
    `</div>` +
    `<label class="tools-utility-toggle tools-sam-span-toggle" for="">` +
      `<span class="tools-toggle-copy"><span>${toolsUiText('tools_sam_audio_span_include', 'Include')}</span></span>` +
      `<input type="checkbox" class="tools-sam-span-include"${span.include === false ? '' : ' checked'}>` +
    `</label>` +
    `<button type="button" class="tools-sam-span-remove" aria-label="${escapeHtml(getI18nText('btn_remove', 'Remove'))}" title="${escapeHtml(getI18nText('btn_remove', 'Remove'))}"><i data-lucide="x"></i></button>`;
  const removeBtn = row.querySelector('.tools-sam-span-remove');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      row.remove();
      saveAppState();
      requestAnimationFrame(() => {
        if (window.lucide && typeof window.lucide.createIcons === 'function') {
          window.lucide.createIcons();
        }
      });
    });
  }
  row.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', saveAppState);
    input.addEventListener('change', saveAppState);
  });
  return row;
}

function getToolsSamAudioSpanState() {
  const list = qs('toolsSamAudioSpansList');
  if (!list) return [];
  return Array.from(list.querySelectorAll('.tools-sam-span-row')).map((row) => {
    const start = Number(row.querySelector('.tools-sam-span-start')?.value);
    const end = Number(row.querySelector('.tools-sam-span-end')?.value);
    const include = !!row.querySelector('.tools-sam-span-include')?.checked;
    return { start, end, include };
  }).filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end));
}

function restoreToolsSamAudioSpanState(spans) {
  const list = qs('toolsSamAudioSpansList');
  if (!list) return;
  list.innerHTML = '';
  const nextSpans = Array.isArray(spans) ? spans : [];
  nextSpans.forEach((span) => list.appendChild(createToolsSamAudioSpanRow(span)));
  requestAnimationFrame(() => {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  });
}

function ensureToolsSamAudioSpanRows() {
  const list = qs('toolsSamAudioSpansList');
  if (!list) return;
  if (!list.querySelector('.tools-sam-span-row')) {
    list.appendChild(createToolsSamAudioSpanRow());
  }
  requestAnimationFrame(() => {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  });
}

function toolsAddSamAudioSpan(span = {}) {
  const list = qs('toolsSamAudioSpansList');
  if (!list) return;
  list.appendChild(createToolsSamAudioSpanRow(span));
  saveAppState();
  requestAnimationFrame(() => {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  });
}
window.toolsAddSamAudioSpan = toolsAddSamAudioSpan;

function collectToolsSamAudioSpans() {
  return getToolsSamAudioSpanState()
    .map((span) => ({
      start: Math.max(0, Number(span.start) || 0),
      end: Math.max(0, Number(span.end) || 0),
      include: span.include !== false,
    }))
    .filter((span) => span.end > span.start);
}

function updateToolsSamAudioUi() {
  const modelId = getToolsSamAudioModelId();
  const isSpanMode = modelId === 'fal-ai/sam-audio/span-separate';
  const setVisible = (id, visible) => {
    const el = qs(id);
    if (el) el.style.display = visible ? '' : 'none';
  };

  setVisible('toolsSamAudioPredictSpansField', !isSpanMode);
  setVisible('toolsSamAudioSpansField', isSpanMode);
  setVisible('toolsSamAudioSoundActivityField', isSpanMode);
  setVisible('toolsSamAudioTrimField', isSpanMode);

  if (isSpanMode) ensureToolsSamAudioSpanRows();

  const noteEl = qs('toolsSamAudioModelNote');
  if (noteEl) {
    const noteKey = SAM_AUDIO_MODEL_NOTES[modelId] || 'tools_sam_audio_note_fallback';
    noteEl.textContent = toolsUiText(noteKey, 'Only settings that apply to the selected SAM Audio mode are shown.');
  }

  if (activeToolsHelpButton) {
    const hiddenField = activeToolsHelpButton.closest('.field, .tools-utility-toggle, .group-label');
    if (!document.body.contains(activeToolsHelpButton) || (hiddenField && hiddenField.offsetParent === null)) {
      closeToolsHelpPopover();
    }
  }

  TOPAZ_RANGE_CONTROLS.forEach((meta) => syncEnhancerRangeControl(meta, 'input', false));
}

function populateHeygenLanguageOptions() {
  const select = qs('toolsHeygenOutputLanguage');
  if (!select) return;
  const preferred = String(select.dataset.pendingValue || select.value || HEYGEN_TRANSLATE_DEFAULT_LANGUAGE || '').trim();
  select.innerHTML = '';
  HEYGEN_TRANSLATE_LANGUAGES.forEach((language) => {
    const option = document.createElement('option');
    option.value = language;
    option.textContent = language;
    select.appendChild(option);
  });
  select.value = HEYGEN_TRANSLATE_LANGUAGES.includes(preferred) ? preferred : HEYGEN_TRANSLATE_DEFAULT_LANGUAGE;
  delete select.dataset.pendingValue;
}

function updateToolsHeygenUi() {
  populateHeygenLanguageOptions();
  const noteEl = qs('toolsHeygenModelNote');
  if (noteEl) {
    noteEl.textContent = toolsUiText(
      'tools_heygen_note_precision',
      'Extreme-precision video translation with lip-sync aware dubbing and optional voice-only translation.',
    );
  }

  if (activeToolsHelpButton) {
    const hiddenField = activeToolsHelpButton.closest('.field, .tools-utility-toggle, .group-label');
    if (!document.body.contains(activeToolsHelpButton) || (hiddenField && hiddenField.offsetParent === null)) {
      closeToolsHelpPopover();
    }
  }
}

function switchToolsTool(tool, options = {}) {
  const nextTool = TOOLS_TOOL_IDS.has(tool) ? tool : 'card-studio';
  if (!options.force && currentToolsTool === nextTool) {
    if (currentMode === 'tools') {
      if (nextTool === 'card-studio') enterWizFullscreen();
      else exitWizFullscreen();
    }
    return;
  }
  currentToolsTool = nextTool;

  document.querySelectorAll('[data-tools-tool]').forEach((btn) => {
    btn.classList.toggle('tools-suite-tab-active', btn.dataset.toolsTool === currentToolsTool);
  });

  const workspaces = {
    'card-studio': qs('toolsCardStudioWorkspace'),
    enhancer: qs('toolsEnhancerWorkspace'),
    'background-removal': qs('toolsBgRemovalWorkspace'),
    'sam-audio': qs('toolsSamAudioWorkspace'),
    'heygen-translate': qs('toolsHeygenWorkspace'),
  };

  Object.entries(workspaces).forEach(([id, el]) => {
    if (!el) return;
    const isActive = id === currentToolsTool;
    el.classList.toggle('tools-workspace-active', isActive);
    el.style.display = isActive ? 'block' : 'none';
  });

  initTopazHelpButtons();

  if (currentMode === 'tools') {
    if (currentToolsTool === 'card-studio') enterWizFullscreen();
    else exitWizFullscreen();
  }

  updateToolsEnhancerUi();
  updateToolsSamAudioUi();
  updateToolsHeygenUi();
  refreshToolsUtilitySourceUi();
  if (!options.skipSave) saveAppState();
  requestAnimationFrame(() => {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  });
}
window.switchToolsTool = switchToolsTool;

function initToolsUtilityControls() {
  const utilityInput = qs('toolsUtilityImageInput');
  const utilityAudioInput = qs('toolsUtilityAudioInput');
  const utilityVideoInput = qs('toolsUtilityVideoInput');
  if (!utilityInput || !utilityAudioInput || !utilityVideoInput || utilityInput._toolsUtilityBound) {
    initTopazHelpButtons();
    initToolsEnhancerRanges();
    refreshToolsUtilitySourceUi();
    updateToolsEnhancerUi();
    updateToolsSamAudioUi();
    updateToolsHeygenUi();
    return;
  }

  utilityInput._toolsUtilityBound = true;
  utilityAudioInput._toolsUtilityBound = true;
  utilityVideoInput._toolsUtilityBound = true;
  bindManagedUploadById('toolsUtilityImageInput');
  bindManagedUploadById('toolsUtilityAudioInput');
  bindManagedUploadById('toolsUtilityVideoInput');
  setupDropZone(qs('toolsUtilityImageDropzone'), utilityInput);
  setupDropZone(qs('toolsBgRemovalDropzone'), utilityInput);
  setupDropZone(qs('toolsUtilityAudioDropzone'), utilityAudioInput);
  setupDropZone(qs('toolsUtilityVideoDropzone'), utilityVideoInput);

  const enhancerModel = qs('toolsEnhancerModel');
  if (enhancerModel) enhancerModel.addEventListener('change', () => {
    updateToolsEnhancerUi();
    saveAppState();
  });
  const enhancerFace = qs('toolsEnhancerFaceEnhancement');
  if (enhancerFace) enhancerFace.addEventListener('change', () => {
    updateToolsEnhancerUi();
    saveAppState();
  });
  const samModel = qs('toolsSamAudioModel');
  if (samModel) samModel.addEventListener('change', () => {
    updateToolsSamAudioUi();
    saveAppState();
  });

  if (Array.isArray(window._samAudioRestoredSpans)) {
    restoreToolsSamAudioSpanState(window._samAudioRestoredSpans);
    window._samAudioRestoredSpans = null;
  }

  initTopazHelpButtons();
  initToolsEnhancerRanges();
  refreshToolsUtilitySourceUi();
  updateToolsEnhancerUi();
  updateToolsSamAudioUi();
  updateToolsHeygenUi();
}

function initToolsControls() {
  if (_toolsInitialized) return;
  _toolsInitialized = true;

  const imgInput = qs('toolsImageInput');
  if (imgInput) {
    imgInput.addEventListener('change', (e) => {
      const newFiles = Array.from(e.target.files || []);
      const max = wizMaxImages();
      uploadedToolsImages = [...uploadedToolsImages, ...newFiles].slice(0, max);
      if (uploadedToolsImages.length >= max) {
        showToast(window.I18N ? I18N.t('wiz_max_images').replace('{n}', max) : `Maximum ${max} images`);
      }
      updateToolsImagePreview();
      saveAppState();
      e.target.value = '';
    });
  }

  const dropzone = qs('toolsImageDropzone');
  if (dropzone && imgInput) setupDropZone(dropzone, imgInput);

  const toolsGptSizeSel = qs('toolsGptImageSize');
  if (toolsGptSizeSel) toolsGptSizeSel.addEventListener('change', updateToolsGptControls);
  bindGptImage2CustomSizePair('toolsGptImageWidth', 'toolsGptImageHeight', 'toolsGptCustomSizeHint', 'toolsGptImageSize');

  wizBuildTitleChips();
  wizBuildCharChips();
  wizBuildFontCards();
  wizLoadInspoPresets();
  wizLoadFontPresets();
  wizInitInspoUpload();
  wizUpdateToolsSettings();
  initToolsUtilityControls();

  // Hook into locale application (covers both init() and setLang()) to rebuild chips
  if (!window._wizLangHooked && window.I18N && window.I18N.applyLocale) {
    window._wizLangHooked = true;
    const _origApply = window.I18N.applyLocale.bind(window.I18N);
    window.I18N.applyLocale = function() {
      _origApply.call(this);
      if (_toolsInitialized) {
        wizBuildTitleChips();
        wizBuildCharChips();
      }
    };
  }

  // Restore wizard state if available
  const rs = window._wizRestoredState;
  if (rs) {
    // Restore characteristics
    if (rs.chars && rs.chars.length > 0) {
      const list = qs('toolsCharList');
      if (list) list.innerHTML = '';
      rs.chars.forEach(c => toolsAddChar(c));
    }
    // Auto-resize title if restored
    requestAnimationFrame(() => { const t = qs('toolsTitleInput'); if (t) wizAutoResize(t); });
    // Restore selected presets (after presets are loaded)
    if (rs.selectedPresets && rs.selectedPresets.length > 0 && !hasStoredInspoSelectedPresets()) {
      const waitPresets = () => {
        if (_wizInspoPresets.length > 0 || document.querySelector('.wiz-inspo-empty')) {
          _wizSelectedPresets = new Set(rs.selectedPresets);
          persistInspoSelectedPresets();
          const container = document.getElementById('wizInspoPresets');
          if (container) container.querySelectorAll('.wiz-inspo-card').forEach(c => c.classList.toggle('wiz-inspo-on', _wizSelectedPresets.has(c.dataset.presetId)));
        } else {
          setTimeout(waitPresets, 100);
        }
      };
      setTimeout(waitPresets, 200);
    }
    // Restore step (jump without animation)
    if (typeof rs.step === 'number' && rs.step > 0 && rs.step < WIZ_TOTAL) {
      _wizStep = rs.step;
      const panels = document.querySelectorAll('[data-wiz-panel]');
      panels.forEach(p => { p.style.display = 'none'; p.style.opacity = ''; p.classList.remove('wiz-panel-active','wiz-panel-intro'); });
      const target = document.querySelector(`[data-wiz-panel="${rs.step}"]`);
      if (target) { target.style.display = 'block'; target.style.opacity = '1'; target.classList.add('wiz-panel-active'); }
    } else {
      _wizStep = 0;
    }
    delete window._wizRestoredState;
  } else {
    _wizStep = 0;
  }
  wizUpdateUI();

  // Restore images from IndexedDB
  wizIdbRestoreImages();

  requestAnimationFrame(() => { if (window.lucide) window.lucide.createIcons(); });
}

// --- Wizard fullscreen ---
function enterWizFullscreen() {
  document.body.classList.add('wiz-fullscreen');
}
function exitWizFullscreen() {
  document.body.classList.remove('wiz-fullscreen');
}
window.enterWizFullscreen = enterWizFullscreen;
window.exitWizFullscreen = exitWizFullscreen;

// --- Wizard navigation ---
function wizGoTo(step) {
  if (_wizAnimating || step === _wizStep || step < 0 || step >= WIZ_TOTAL) return;
  // Only allow jumping to completed steps or next
  if (step > _wizStep + 1) return;
  enterWizFullscreen();
  const dir = step > _wizStep ? 'fwd' : 'bwd';
  _wizTransition(_wizStep, step, dir);
}
window.wizGoTo = wizGoTo;

function wizNext() {
  if (_wizStep >= WIZ_TOTAL - 1) {
    handleGenerate();
    exitWizFullscreen();
    return;
  }
  wizGoTo(_wizStep + 1);
}
window.wizNext = wizNext;

function wizPrev() {
  wizGoTo(_wizStep - 1);
}
window.wizPrev = wizPrev;

function _wizTransition(from, to, dir) {
  _wizAnimating = true;
  const panels = document.querySelectorAll('[data-wiz-panel]');
  const fromEl = document.querySelector(`[data-wiz-panel="${from}"]`);
  const toEl = document.querySelector(`[data-wiz-panel="${to}"]`);
  if (!fromEl || !toEl) { _wizAnimating = false; return; }

  // Remove all state classes
  panels.forEach(p => p.classList.remove('wiz-panel-active','wiz-exit-fwd','wiz-exit-bwd','wiz-enter-fwd','wiz-enter-bwd'));

  // Animate out (keep inline opacity so exit starts visible)
  fromEl.style.display = 'block';
  fromEl.classList.add(dir === 'fwd' ? 'wiz-exit-fwd' : 'wiz-exit-bwd');
  // Animate in — clear inline styles so CSS class applies
  toEl.style.display = '';
  toEl.style.opacity = '';
  toEl.classList.add(dir === 'fwd' ? 'wiz-enter-fwd' : 'wiz-enter-bwd');

  _wizStep = to;
  wizUpdateUI();
  saveAppState();

  // After animation, clean up
  setTimeout(() => {
    panels.forEach(p => {
      p.classList.remove('wiz-panel-active','wiz-panel-intro','wiz-exit-fwd','wiz-exit-bwd','wiz-enter-fwd','wiz-enter-bwd');
      p.style.display = 'none';
      p.style.opacity = '';
    });
    toEl.style.display = 'block';
    toEl.style.opacity = '1';
    toEl.classList.add('wiz-panel-active');
    _wizAnimating = false;
    requestAnimationFrame(() => { if (window.lucide) window.lucide.createIcons(); });
  }, 450);
}

function wizUpdateUI() {
  // Progress bar fill
  const fill = qs('wizFill');
  if (fill) fill.style.width = `${(_wizStep / (WIZ_TOTAL - 1)) * 100}%`;

  // Dots
  document.querySelectorAll('[data-wiz-dot]').forEach(dot => {
    const s = Number(dot.dataset.wizDot);
    dot.classList.remove('wiz-dot-active', 'wiz-dot-done');
    if (s === _wizStep) dot.classList.add('wiz-dot-active');
    else if (s < _wizStep) dot.classList.add('wiz-dot-done');
  });

  // Counter
  const counter = qs('wizCounter');
  if (counter) counter.textContent = `${_wizStep + 1} / ${WIZ_TOTAL}`;

  // Back button
  const backBtn = qs('wizBackBtn');
  if (backBtn) backBtn.setAttribute('data-hidden', _wizStep === 0 ? 'true' : 'false');

  // Next button: last step = Generate
  const nextBtn = qs('wizNextBtn');
  if (nextBtn) {
    const _t = (k, fb) => window.I18N ? I18N.t(k) : fb;
    if (_wizStep === WIZ_TOTAL - 1) {
      nextBtn.innerHTML = `<i data-lucide="sparkles"></i><span>${_t('wiz_btn_generate','Generate')}</span>`;
      nextBtn.classList.add('wiz-gen-btn');
    } else {
      nextBtn.innerHTML = `<span>${_t('wiz_btn_next','Next')}</span><i data-lucide="arrow-right"></i>`;
      nextBtn.classList.remove('wiz-gen-btn');
    }
  }

  // Image strip (visible on steps 1+)
  updateWizImgStrip();

  // Disable generate button when no images uploaded
  wizUpdateGenBtn();

  requestAnimationFrame(() => { if (window.lucide) window.lucide.createIcons(); });
}

function wizUpdateGenBtn() {
  const nextBtn = qs('wizNextBtn');
  if (!nextBtn) return;
  const isLastStep = _wizStep === WIZ_TOTAL - 1;
  const noImages = uploadedToolsImages.length === 0;
  const shouldDisable = isLastStep && noImages;
  nextBtn.disabled = shouldDisable;
  nextBtn.classList.toggle('wiz-btn-disabled', shouldDisable);
}
window.wizUpdateGenBtn = wizUpdateGenBtn;


// --- Image strip ---
function updateWizImgStrip() {
  const strip = qs('wizImgStrip');
  if (!strip) return;
  clearPreviewBlobUrls(strip);
  strip.innerHTML = '';
  if (uploadedToolsImages.length === 0 || _wizStep === 0) return;

  uploadedToolsImages.forEach((file, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'wiz-img-thumb';
    const img = document.createElement('img');
    img.src = getPreviewSrcForAssetItem(file, strip);
    thumb.appendChild(img);

    const acts = document.createElement('div');
    acts.className = 'wiz-img-thumb-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button'; editBtn.className = 'wiz-img-thumb-btn'; editBtn.title = 'Sketch';
    editBtn.innerHTML = '<i data-lucide="pen-tool"></i>';
    editBtn.onclick = (e) => { e.stopPropagation(); openSketchEditor(i); };
    acts.appendChild(editBtn);
    const rmBtn = document.createElement('button');
    rmBtn.type = 'button'; rmBtn.className = 'wiz-img-thumb-btn'; rmBtn.title = 'Remove';
    rmBtn.innerHTML = '<i data-lucide="x"></i>';
    rmBtn.onclick = (e) => { e.stopPropagation(); uploadedToolsImages.splice(i, 1); updateToolsImagePreview(); saveAppState(); };
    acts.appendChild(rmBtn);
    thumb.appendChild(acts);
    strip.appendChild(thumb);
  });

  // Add "+" button to strip if under max
  if (uploadedToolsImages.length < wizMaxImages()) {
    const addThumb = document.createElement('div');
    addThumb.className = 'wiz-img-thumb wiz-img-add';
    addThumb.innerHTML = '<i data-lucide="plus"></i>';
    addThumb.onclick = () => { const inp = qs('toolsImageInput'); if (inp) inp.click(); };
    strip.appendChild(addThumb);
  }
}

// --- Preset storage helpers ---
const TITLE_PRESETS_KEY = 'nano_title_presets';
const CHAR_PRESETS_KEY  = 'nano_char_presets';

function _getStoreForKey(key) {
  const scopedKey = getScopedStorageKey(key);
  try { return JSON.parse(localStorage.getItem(scopedKey) || '{}'); } catch(_) { return {}; }
}
function _saveStoreForKey(key, store) {
  try { localStorage.setItem(getScopedStorageKey(key), JSON.stringify(store)); } catch(_) {}
  if (key === TITLE_PRESETS_KEY || key === CHAR_PRESETS_KEY) queueAccountTextPresetSync();
}
function _getLangData(key, lang) {
  const store = _getStoreForKey(key);
  if (!store[lang]) store[lang] = { removed: [], custom: [] };
  if (!Array.isArray(store[lang].removed)) store[lang].removed = [];
  if (!Array.isArray(store[lang].custom)) store[lang].custom = [];
  return store[lang];
}

function _getPresetStore()         { return _getStoreForKey(TITLE_PRESETS_KEY); }
function _savePresetStore(store)   { _saveStoreForKey(TITLE_PRESETS_KEY, store); }
function _getLangPresets(lang)     { return _getLangData(TITLE_PRESETS_KEY, lang); }
function _getLangCharPresets(lang) { return _getLangData(CHAR_PRESETS_KEY, lang); }

function getUserTitlePresets(lang) {
  const { removed, custom } = _getLangPresets(lang);
  const defaults = WIZ_TITLE_CHIPS[lang] || WIZ_TITLE_CHIPS['en'];
  return [...defaults.filter(t => !removed.includes(t)), ...custom];
}
function getUserCharPresets(lang) {
  const { removed, custom } = _getLangCharPresets(lang);
  const defaults = WIZ_CHAR_CHIPS[lang] || WIZ_CHAR_CHIPS['en'];
  return [...defaults.filter(t => !removed.includes(t)), ...custom];
}

// --- Build title chips dynamically ---
function wizBuildTitleChips() {
  const container = document.getElementById('wizTitleChips');
  if (!container) return;
  const lang = window.I18N ? I18N.lang : 'en';
  const chips = getUserTitlePresets(lang);
  const currentVal = document.getElementById('toolsTitleInput') ? document.getElementById('toolsTitleInput').value : '';
  container.innerHTML = '';
  chips.forEach(text => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wiz-chip' + (text === currentVal ? ' wiz-chip-on' : '');
    btn.textContent = text;
    btn.onclick = function() { wizPickChip('toolsTitleInput', this); };
    container.appendChild(btn);
  });
}
window.wizBuildTitleChips = wizBuildTitleChips;

// --- Preset Manager (context-aware: 'title' | 'char') ---
let _pmContext = 'title';

function openPresetManager(ctx) {
  _pmContext = ctx || 'title';
  // Update panel title
  const titleEl = document.getElementById('presetManagerPanel')?.querySelector('.pm-title');
  if (titleEl && window.I18N) {
    titleEl.textContent = I18N.t(_pmContext === 'char' ? 'wiz_char_preset_title' : 'wiz_preset_title');
  }
  _pmRender();
  document.getElementById('presetManagerBackdrop')?.classList.add('pm-backdrop--open');
  document.getElementById('presetManagerPanel')?.classList.add('pm-panel--open');
  setTimeout(() => { document.getElementById('pmAddInput')?.focus(); }, 320);
}
window.openPresetManager = openPresetManager;

function closePresetManager() {
  document.getElementById('presetManagerBackdrop')?.classList.remove('pm-backdrop--open');
  document.getElementById('presetManagerPanel')?.classList.remove('pm-panel--open');
}
window.closePresetManager = closePresetManager;

function _pmGetDefaults(lang) {
  return _pmContext === 'char'
    ? (WIZ_CHAR_CHIPS[lang] || WIZ_CHAR_CHIPS['en'])
    : (WIZ_TITLE_CHIPS[lang] || WIZ_TITLE_CHIPS['en']);
}
function _pmGetLangData(lang) {
  return _pmContext === 'char' ? _getLangCharPresets(lang) : _getLangPresets(lang);
}
function _pmGetStore() {
  return _getStoreForKey(_pmContext === 'char' ? CHAR_PRESETS_KEY : TITLE_PRESETS_KEY);
}
function _pmSaveStore(store) {
  _saveStoreForKey(_pmContext === 'char' ? CHAR_PRESETS_KEY : TITLE_PRESETS_KEY, store);
}
function _pmRebuildChips() {
  if (_pmContext === 'char') wizBuildCharChips();
  else wizBuildTitleChips();
}

function _pmMakeChip(text, onDelete) {
  const chip = document.createElement('div');
  chip.className = 'pm-chip';
  const label = document.createElement('span');
  label.textContent = text;
  label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'pm-chip-del';
  del.innerHTML = '&#x2715;';
  del.onclick = (e) => { e.stopPropagation(); onDelete(); };
  chip.onclick = () => {
    if (_pmContext === 'char') {
      toolsAddChar(text);
    } else {
      const inp = document.getElementById('toolsTitleInput');
      if (inp) { inp.value = text; inp.dispatchEvent(new Event('input')); saveAppState(); }
    }
    closePresetManager();
    _pmRebuildChips();
  };
  chip.appendChild(label);
  chip.appendChild(del);
  return chip;
}

function _pmRender() {
  const lang = window.I18N ? I18N.lang : 'en';
  const { removed, custom } = _pmGetLangData(lang);
  const defaults = _pmGetDefaults(lang);
  const body = document.getElementById('presetManagerBody');
  if (!body) return;
  const t = (key) => window.I18N ? I18N.t(key) : key;
  body.innerHTML = '';

  // Quick picks section
  const sec1 = document.createElement('div');
  const lbl1 = document.createElement('div');
  lbl1.className = 'pm-section-label';
  lbl1.textContent = t('wiz_preset_defaults');
  sec1.appendChild(lbl1);
  const grid1 = document.createElement('div');
  grid1.className = 'pm-chips-grid';
  const activeDefaults = defaults.filter(d => !removed.includes(d));
  if (activeDefaults.length === 0) {
    const e = document.createElement('div');
    e.className = 'pm-empty'; e.textContent = '—';
    grid1.appendChild(e);
  } else {
    activeDefaults.forEach(text => grid1.appendChild(_pmMakeChip(text, () => pmRemoveDefault(text))));
  }
  sec1.appendChild(grid1);
  if (removed.length > 0) {
    const rb = document.createElement('button');
    rb.type = 'button'; rb.className = 'pm-restore-btn';
    rb.innerHTML = '<i data-lucide="rotate-ccw"></i> ' + t('wiz_preset_reset_defaults');
    rb.onclick = pmRestoreDefaults;
    sec1.appendChild(rb);
  }
  body.appendChild(sec1);

  // My presets section
  const sec2 = document.createElement('div');
  const lbl2 = document.createElement('div');
  lbl2.className = 'pm-section-label';
  lbl2.textContent = t('wiz_preset_custom');
  sec2.appendChild(lbl2);
  const grid2 = document.createElement('div');
  grid2.className = 'pm-chips-grid';
  if (custom.length === 0) {
    const e = document.createElement('div');
    e.className = 'pm-empty'; e.textContent = t('wiz_preset_empty_custom');
    grid2.appendChild(e);
  } else {
    custom.forEach((text, idx) => grid2.appendChild(_pmMakeChip(text, () => pmDeleteCustom(idx))));
  }
  sec2.appendChild(grid2);
  body.appendChild(sec2);

  if (window.lucide) lucide.createIcons({ attrs: { 'stroke-width': '1.5' } });
}
window.renderPresetManager = _pmRender;

function pmRemoveDefault(text) {
  const lang = window.I18N ? I18N.lang : 'en';
  const store = _pmGetStore();
  if (!store[lang]) store[lang] = { removed: [], custom: [] };
  if (!store[lang].removed.includes(text)) store[lang].removed.push(text);
  _pmSaveStore(store);
  _pmRender(); _pmRebuildChips();
}
window.pmRemoveDefault = pmRemoveDefault;

function pmDeleteCustom(idx) {
  const lang = window.I18N ? I18N.lang : 'en';
  const store = _pmGetStore();
  if (store[lang]?.custom) store[lang].custom.splice(idx, 1);
  _pmSaveStore(store);
  _pmRender(); _pmRebuildChips();
}
window.pmDeleteCustom = pmDeleteCustom;

function pmRestoreDefaults() {
  const lang = window.I18N ? I18N.lang : 'en';
  const store = _pmGetStore();
  if (store[lang]) store[lang].removed = [];
  _pmSaveStore(store);
  _pmRender(); _pmRebuildChips();
}
window.pmRestoreDefaults = pmRestoreDefaults;

function pmAddPreset() {
  const inp = document.getElementById('pmAddInput');
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) return;
  const lang = window.I18N ? I18N.lang : 'en';
  const store = _pmGetStore();
  if (!store[lang]) store[lang] = { removed: [], custom: [] };
  if (!store[lang].custom) store[lang].custom = [];
  if (!store[lang].custom.includes(text)) {
    store[lang].custom.push(text);
    _pmSaveStore(store);
    _pmRebuildChips();
  }
  inp.value = '';
  _pmRender();
  inp.focus();
}
window.pmAddPreset = pmAddPreset;

// --- Build characteristic chips dynamically ---
function wizBuildCharChips() {
  const container = document.getElementById('wizCharChips');
  if (!container) return;
  const lang = window.I18N ? I18N.lang : 'en';
  const chips = getUserCharPresets(lang);
  // Remember which texts are already used
  const usedTexts = new Set();
  document.querySelectorAll('.tools-char-item input[type="text"], .tools-char-item textarea.wiz-char-input').forEach(inp => {
    if (inp.value.trim()) usedTexts.add(inp.value.trim());
  });
  container.innerHTML = '';
  chips.forEach(text => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wiz-chip-sm';
    if (usedTexts.has(text)) btn.classList.add('wiz-chip-used');
    btn.textContent = text;
    btn.onclick = function() { wizQuickChar(this); };
    container.appendChild(btn);
  });
}
window.wizBuildCharChips = wizBuildCharChips;

// --- Build font cards dynamically ---
function wizBuildFontCards(filter) {
  const track = document.getElementById('wizFontTrack');
  if (!track) return;
  const previewInput = qs('wizFontPreviewText');
  const previewText = previewInput ? (previewInput.value.trim() || 'Aa') : 'Aa';
  const currentVal = qs('toolsFontInput') ? qs('toolsFontInput').value : '';
  const q = (filter || '').toLowerCase();
  track.innerHTML = '';
  WIZ_FONTS.forEach(f => {
    if (q && !f.name.toLowerCase().includes(q)) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wiz-font-card';
    const promptVal = window.I18N ? I18N.t(f.val) : f.name;
    btn.dataset.val = promptVal;
    if (currentVal === promptVal) btn.classList.add('wiz-font-on');
    btn.innerHTML = `<span class="wiz-font-preview" style="${f.css}">${previewText}</span><span class="wiz-font-name">${f.name}</span>`;
    btn.onclick = function() { wizPickFont(this); };
    track.appendChild(btn);
  });
  requestAnimationFrame(() => {
    wizInitFontScrollbar();
    wizSyncFontScrollbar();
    if (window.lucide) window.lucide.createIcons({ el: document.querySelector('.wiz-font-scroll-hint-line') });
  });
}
window.wizBuildFontCards = wizBuildFontCards;

function wizFilterFonts() {
  const search = qs('wizFontSearch');
  wizBuildFontCards(search ? search.value.trim() : '');
}
window.wizFilterFonts = wizFilterFonts;

// --- Chip/preset pickers ---
function wizPickChip(inputId, btn) {
  const input = qs(inputId);
  if (!input || !btn) return;
  input.value = btn.textContent.trim();
  const parent = btn.closest('.wiz-chips');
  if (parent) parent.querySelectorAll('.wiz-chip').forEach(c => c.classList.remove('wiz-chip-on'));
  btn.classList.add('wiz-chip-on');
}
window.wizPickChip = wizPickChip;

function wizPickFont(btn) {
  if (!btn) return;
  const val = btn.dataset.val || btn.textContent.trim();
  const input = qs('toolsFontInput');
  if (input) input.value = val;
  document.querySelectorAll('.wiz-font-card').forEach(c => c.classList.remove('wiz-font-on'));
  btn.classList.add('wiz-font-on');
}
window.wizPickFont = wizPickFont;

function wizUpdateFontPreview() {
  const input = qs('wizFontPreviewText');
  const text = input ? input.value.trim() : '';
  const display = text || 'Aa';
  document.querySelectorAll('.wiz-font-preview').forEach(el => {
    el.textContent = display;
  });
}
window.wizUpdateFontPreview = wizUpdateFontPreview;

function wizSyncFontScrollbar() {
  const scroll = document.getElementById('wizFontScroll');
  const thumb = document.getElementById('wizFontScrollThumb');
  if (!scroll || !thumb) return;
  const maxScroll = scroll.scrollWidth - scroll.clientWidth;
  if (maxScroll <= 0) {
    thumb.style.width = '100%';
    thumb.style.left = '0%';
    return;
  }
  const ratio = scroll.scrollLeft / maxScroll;
  const thumbPct = Math.max(12, Math.min(80, (scroll.clientWidth / scroll.scrollWidth) * 100));
  const maxLeft = 100 - thumbPct;
  thumb.style.width = thumbPct + '%';
  thumb.style.left = (ratio * maxLeft) + '%';
}
window.wizSyncFontScrollbar = wizSyncFontScrollbar;

function wizInitFontScrollbar() {
  const scroll = document.getElementById('wizFontScroll');
  if (!scroll || scroll._sbInited) return;
  scroll._sbInited = true;
  scroll.addEventListener('scroll', () => requestAnimationFrame(wizSyncFontScrollbar), { passive: true });
  if (window.ResizeObserver) {
    new ResizeObserver(() => requestAnimationFrame(wizSyncFontScrollbar)).observe(scroll);
  }
  /* PC drag-to-scroll */
  let isDragging = false, dragStartX = 0, scrollStartX = 0;
  scroll.addEventListener('mousedown', e => {
    isDragging = true;
    dragStartX = e.clientX;
    scrollStartX = scroll.scrollLeft;
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!isDragging) return;
    scroll.scrollLeft = scrollStartX - (e.clientX - dragStartX);
  });
  document.addEventListener('mouseup', () => { isDragging = false; });
}
window.wizInitFontScrollbar = wizInitFontScrollbar;

function wizQuickChar(btn) {
  if (!btn) return;
  const text = btn.textContent.trim();
  btn.classList.add('wiz-chip-used');
  toolsAddChar(text);
}
window.wizQuickChar = wizQuickChar;

// --- Model-aware settings visibility ---
function wizUpdateToolsSettings() {
  const model = qs('toolsModel') ? qs('toolsModel').value : DEFAULT_TOOLS_MODEL;
  const isGpt = GPT_IMAGE_EDIT_MODEL_IDS.has(model);

  // Resolution: available for nano models only
  const fRes = document.getElementById('toolsFieldResolution');
  if (fRes) fRes.style.display = isGpt ? 'none' : '';

  // Aspect: nano models only, GPT models use image_size presets
  const fAsp = document.getElementById('toolsFieldAspect');
  if (fAsp) fAsp.style.display = isGpt ? 'none' : '';

  const fOut = document.getElementById('toolsFieldOutputFormat');
  if (fOut) fOut.style.display = isGpt ? 'none' : '';

  const fWeb = document.getElementById('toolsFieldWebSearch');
  if (fWeb) fWeb.style.display = 'none';

  const fGoogle = document.getElementById('toolsFieldGoogleSearch');
  if (fGoogle) fGoogle.style.display = 'none';

  const fSeed = document.getElementById('toolsFieldSeed');
  if (fSeed) fSeed.style.display = 'none';

  updateToolsGptControls();

  // Enforce image limit for model change
  const max = wizMaxImages();
  if (uploadedToolsImages.length > max) {
    uploadedToolsImages = uploadedToolsImages.slice(0, max);
    updateToolsImagePreview();
  }
  // Update upload hint
  const hint = document.querySelector('.wiz-drop-hint');
  if (hint) hint.textContent = `PNG, JPG ${window.I18N ? I18N.t('wiz_upload_hint_up_to') : 'up to'} ${max} ${window.I18N ? I18N.t('wiz_upload_hint_images') : 'images'}`;
}
window.wizUpdateToolsSettings = wizUpdateToolsSettings;

// --- Auto-resize helper for growing textareas ---
function wizAutoResize(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function autoResizePromptInput() {
  const promptInput = qs('promptInput');
  if (!promptInput) return;
  wizAutoResize(promptInput);
}

// Delegate auto-resize to all .wiz-input-grow and .wiz-char-input textareas
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t && (t.id === 'promptInput' || t.classList.contains('wiz-input-grow') || t.classList.contains('wiz-char-input'))) {
    wizAutoResize(t);
  }
});

window.addEventListener('resize', autoResizePromptInput);

// --- Simplified char items (no inline select) ---
function toolsAddChar(prefill) {
  const list = qs('toolsCharsList');
  if (!list) return;
  toolsCharsCount++;
  const idx = toolsCharsCount;
  const item = document.createElement('div');
  item.className = 'tools-char-item';
  item.id = `toolsChar-${idx}`;
  const charPh = window.I18N ? I18N.t('wiz_char_placeholder') : 'e.g. Natural materials';
  item.innerHTML = `
    <textarea id="toolsCharInput-${idx}" class="wiz-char-input" placeholder="${charPh}" rows="1">${prefill ? prefill.replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''}</textarea>
    <button type="button" class="tools-char-remove" onclick="toolsRemoveChar('toolsChar-${idx}')" style="align-self:flex-start;margin-top:2px">
      <i data-lucide="x"></i>
    </button>
  `;
  list.appendChild(item);
  // Expand to fit prefilled text immediately
  requestAnimationFrame(() => {
    const ta = item.querySelector('.wiz-char-input');
    if (ta) wizAutoResize(ta);
    if (window.lucide) window.lucide.createIcons();
  });
}
window.toolsAddChar = toolsAddChar;

function toolsRemoveChar(id) {
  const el = document.getElementById(id);
  if (el) {
    const input = el.querySelector('input[type="text"], textarea.wiz-char-input');
    if (input && input.value.trim()) {
      const text = input.value.trim();
      document.querySelectorAll('.wiz-chip-sm.wiz-chip-used').forEach(chip => {
        if (chip.textContent.trim() === text) chip.classList.remove('wiz-chip-used');
      });
    }
    el.remove();
  }
}
window.toolsRemoveChar = toolsRemoveChar;

// --- Image preview (step 0 grid + strip) ---
function updateToolsImagePreview() {
  const grid = qs('toolsImagePreviewGrid');
  const label = qs('toolsImageLabel');
  if (!grid) return;
  clearPreviewBlobUrls(grid);
  grid.innerHTML = '';
  if (label) label.textContent = uploadedToolsImages.length > 0
    ? `${uploadedToolsImages.length} image(s)` : (window.I18N ? I18N.t('wiz_upload_text') : 'Click or drag product images');

  uploadedToolsImages.forEach((file, i) => {
    const item = document.createElement('div');
    item.className = 'upload-preview-item';
    item.style.position = 'relative';
    const img = document.createElement('img');
    img.src = getPreviewSrcForAssetItem(file, grid);
    img.alt = getAssetItemName(file, 'image');
    item.appendChild(img);

    // Number badge
    const numBadge = document.createElement('span');
    numBadge.className = 'img-num-badge';
    numBadge.textContent = i + 1;
    item.appendChild(numBadge);

    const actions = document.createElement('div');
    actions.className = 'tools-img-actions';
    const sketchBtn = document.createElement('button');
    sketchBtn.type = 'button'; sketchBtn.className = 'tools-img-action-btn'; sketchBtn.title = 'Edit / Sketch';
    sketchBtn.innerHTML = '<i data-lucide="pen-tool"></i>';
    sketchBtn.onclick = () => openSketchEditor(i, uploadedToolsImages, updateToolsImagePreview);
    actions.appendChild(sketchBtn);
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button'; removeBtn.className = 'tools-img-action-btn'; removeBtn.title = 'Remove';
    removeBtn.innerHTML = '<i data-lucide="x"></i>';
    removeBtn.onclick = () => { uploadedToolsImages.splice(i, 1); updateToolsImagePreview(); saveAppState(); };
    actions.appendChild(removeBtn);
    item.appendChild(actions);
    grid.appendChild(item);
  });

  // Also update floating strip
  updateWizImgStrip();
  wizUpdateGenBtn();
  requestAnimationFrame(() => { if (window.lucide) window.lucide.createIcons(); });
}

// ---- DESIGN INSPIRATION ----
let _wizInspoPresets = [];         // built-in presets from presets.json
let _wizCustomPresets = [];        // user-added presets {id, name, dataUrl|src, addedAt|createdAt, storagePath}
let _wizSelectedPresets = new Set();
let _wizFontBuiltins = [];         // built-in font presets from presets.json
let _wizFontCustomPresets = [];    // user-added font presets {id, name, dataUrl|src, addedAt|createdAt, storagePath}
let _wizSelectedFontPresets = new Set();
let _wizHiddenBuiltins = new Set(); // built-in preset IDs hidden by user
let _wizPresetNameOverrides = {};   // {presetId: overriddenName}
let uploadedInspoImages = [];       // kept for backwards compat

// --- Storage keys ---
const INSPO_HIDDEN_KEY  = 'nano_inspo_hidden';
const INSPO_NAMES_KEY   = 'nano_inspo_names';
const INSPO_STATE_META_KEY = 'nano_inspo_state_meta';
const INSPO_SELECTED_KEY = 'nano_inspo_selected';
const FONT_SELECTED_KEY = 'nano_font_selected';
const INSPO_IDB_NAME    = 'nano_custom_presets_db';
const INSPO_IDB_STORE   = 'presets';
const PRESET_BUCKET_INSPO = 'inspo';
const PRESET_BUCKET_FONT = 'font';
const FONT_PRESET_ID_PREFIX = 'fontpreset_';

function normalizePresetBucket(bucket) {
  return bucket === PRESET_BUCKET_FONT ? PRESET_BUCKET_FONT : PRESET_BUCKET_INSPO;
}

function isFontCustomPresetId(id) {
  return String(id || '').startsWith(FONT_PRESET_ID_PREFIX);
}

function isUuidLike(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function stableUuidFromString(value) {
  const source = String(value || 'preset');
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x9e3779b9 >>> 0;
  let h3 = 0x85ebca6b >>> 0;
  let h4 = 0xc2b2ae35 >>> 0;
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ ((code << 7) | (code >>> 9)), 2246822519) >>> 0;
    h3 = Math.imul(h3 ^ ((code << 11) | (code >>> 5)), 3266489917) >>> 0;
    h4 = Math.imul(h4 ^ ((code << 15) | (code >>> 3)), 668265263) >>> 0;
  }
  const hex = [h1, h2, h3, h4].map((num) => (num >>> 0).toString(16).padStart(8, '0')).join('').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function normalizeCustomPresetId(id, fallbackPrefix = 'preset') {
  const raw = typeof id === 'string' ? id.trim() : '';
  if (isUuidLike(raw)) return raw.toLowerCase();
  if (raw) return stableUuidFromString(`${fallbackPrefix}:${raw}`);
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return stableUuidFromString(`${fallbackPrefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`);
}

function normalizeStoredCustomSelectionIds(stored, availableIds, fallbackPrefix) {
  if (!Array.isArray(stored)) return [];
  return stored
    .map((id) => {
      if (typeof id !== 'string') return null;
      if (availableIds.has(id)) return id;
      const normalized = normalizeCustomPresetId(id, fallbackPrefix);
      return availableIds.has(normalized) ? normalized : null;
    })
    .filter(Boolean);
}

async function migratePresetCollectionIds(presets, bucket = PRESET_BUCKET_INSPO) {
  const ownerKey = getInspoPresetOwnerKey();
  const fallbackPrefix = bucket === PRESET_BUCKET_FONT ? 'font-preset' : 'custom-preset';
  const normalized = (Array.isArray(presets) ? presets : []).map((preset) => {
    if (!preset || typeof preset !== 'object') return null;
    return {
      ...preset,
      id: normalizeCustomPresetId(preset.id, fallbackPrefix),
      bucket: normalizePresetBucket(preset.bucket || bucket),
      ownerKey: preset.ownerKey || ownerKey,
    };
  }).filter(Boolean);
  const changed = normalized.some((preset, index) => preset.id !== String((presets[index] && presets[index].id) || ''));
  if (changed) {
    await _inspoIdbReplaceAllForOwner(ownerKey, normalized, bucket);
  }
  return normalized;
}

// --- IndexedDB helpers for custom presets ---
function _inspoIdbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(INSPO_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(INSPO_IDB_STORE))
        req.result.createObjectStore(INSPO_IDB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror  = () => reject(req.error);
  });
}
function getInspoPresetOwnerKey(explicitScope) {
  const scope = explicitScope === undefined ? getActiveAccountStorageScope() : explicitScope;
  return scope ? String(scope) : '__guest__';
}

function normalizeInspoStateMeta(raw) {
  return {
    updatedAt: Number.isFinite(Number(raw && raw.updatedAt)) ? Number(raw.updatedAt) : 0,
    lastSyncedAt: Number.isFinite(Number(raw && raw.lastSyncedAt)) ? Number(raw.lastSyncedAt) : 0,
    dirty: !!(raw && raw.dirty),
  };
}

function readInspoLocalStateMeta(explicitScope) {
  return normalizeInspoStateMeta(readStoredJson(getScopedStorageKey(INSPO_STATE_META_KEY, explicitScope), {}));
}

function writeInspoLocalStateMeta(meta, explicitScope) {
  try {
    localStorage.setItem(
      getScopedStorageKey(INSPO_STATE_META_KEY, explicitScope),
      JSON.stringify(normalizeInspoStateMeta(meta)),
    );
  } catch (_) {}
}

function markInspoLocalStateDirty(explicitScope) {
  const current = readInspoLocalStateMeta(explicitScope);
  writeInspoLocalStateMeta({
    updatedAt: Date.now(),
    lastSyncedAt: current.lastSyncedAt || 0,
    dirty: true,
  }, explicitScope);
}

function markInspoLocalStateClean(explicitScope) {
  const current = readInspoLocalStateMeta(explicitScope);
  writeInspoLocalStateMeta({
    updatedAt: current.updatedAt || Date.now(),
    lastSyncedAt: Date.now(),
    dirty: false,
  }, explicitScope);
}

function hasDesignPresetStateContent(state) {
  const nextState = state || {};
  return !!(
    (Array.isArray(nextState.hiddenBuiltins) && nextState.hiddenBuiltins.length > 0)
    || (nextState.nameOverrides && typeof nextState.nameOverrides === 'object' && Object.keys(nextState.nameOverrides).length > 0)
    || (Array.isArray(nextState.customPresets) && nextState.customPresets.length > 0)
    || (Array.isArray(nextState.fontCustomPresets) && nextState.fontCustomPresets.length > 0)
  );
}

async function _inspoIdbSave(preset, bucket = PRESET_BUCKET_INSPO) {
  const db = await _inspoIdbOpen();
  const nextPreset = {
    ...preset,
    bucket: normalizePresetBucket(preset && preset.bucket ? preset.bucket : bucket),
    ownerKey: preset && preset.ownerKey ? preset.ownerKey : getInspoPresetOwnerKey(),
  };
  return new Promise((res, rej) => {
    const tx = db.transaction(INSPO_IDB_STORE, 'readwrite');
    tx.objectStore(INSPO_IDB_STORE).put(nextPreset);
    tx.oncomplete = () => { queueAccountDesignPresetSync(); res(); };
    tx.onerror = rej;
  });
}
async function _inspoIdbDelete(id) {
  const db = await _inspoIdbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(INSPO_IDB_STORE, 'readwrite');
    tx.objectStore(INSPO_IDB_STORE).delete(id);
    tx.oncomplete = () => { queueAccountDesignPresetSync(); res(); };
    tx.onerror = rej;
  });
}
async function _inspoIdbLoadAll(explicitOwnerKey, bucket = PRESET_BUCKET_INSPO) {
  const db = await _inspoIdbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(INSPO_IDB_STORE, 'readonly');
    const req = tx.objectStore(INSPO_IDB_STORE).getAll();
    req.onsuccess = () => {
      const ownerKey = getInspoPresetOwnerKey(explicitOwnerKey);
      const normalizedBucket = normalizePresetBucket(bucket);
      const items = Array.isArray(req.result) ? req.result : [];
      res(items.filter((item) => (
        getInspoPresetOwnerKey(item && item.ownerKey ? item.ownerKey : null) === ownerKey
        && normalizePresetBucket(item && item.bucket ? item.bucket : PRESET_BUCKET_INSPO) === normalizedBucket
      )));
    };
    req.onerror = rej;
  });
}
async function _inspoIdbReplaceAllForOwner(ownerKey, presets, bucket = PRESET_BUCKET_INSPO) {
  const db = await _inspoIdbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(INSPO_IDB_STORE, 'readwrite');
    const store = tx.objectStore(INSPO_IDB_STORE);
    const normalizedBucket = normalizePresetBucket(bucket);
    const req = store.getAll();
    req.onsuccess = () => {
      const all = Array.isArray(req.result) ? req.result : [];
      all.forEach((item) => {
        if (
          getInspoPresetOwnerKey(item && item.ownerKey ? item.ownerKey : null) === ownerKey
          && normalizePresetBucket(item && item.bucket ? item.bucket : PRESET_BUCKET_INSPO) === normalizedBucket
        ) {
          store.delete(item.id);
        }
      });
      (presets || []).forEach((preset) => {
        store.put({ ...preset, bucket: normalizedBucket, ownerKey });
      });
    };
    req.onerror = rej;
    tx.oncomplete = res;
    tx.onerror = rej;
  });
}
// --- localStorage helpers ---
function inspoLoadLocalMeta() {
  try { _wizHiddenBuiltins = new Set(JSON.parse(localStorage.getItem(getScopedStorageKey(INSPO_HIDDEN_KEY)) || '[]')); } catch(_) { _wizHiddenBuiltins = new Set(); }
  try { _wizPresetNameOverrides = JSON.parse(localStorage.getItem(getScopedStorageKey(INSPO_NAMES_KEY)) || '{}'); } catch(_) { _wizPresetNameOverrides = {}; }
}

function getAvailableInspoPresetIds() {
  const ids = new Set();
  (_wizInspoPresets || []).forEach((preset) => {
    if (preset && preset.id && preset.thumb && !_wizHiddenBuiltins.has(preset.id)) ids.add(preset.id);
  });
  (_wizCustomPresets || []).forEach((preset) => {
    if (preset && preset.id) ids.add(preset.id);
  });
  return ids;
}

function getAvailableFontPresetIds() {
  const ids = new Set();
  (_wizFontBuiltins || []).forEach((preset) => {
    if (preset && preset.id && preset.thumb && !_wizHiddenBuiltins.has(preset.id)) ids.add(preset.id);
  });
  (_wizFontCustomPresets || []).forEach((preset) => {
    if (preset && preset.id) ids.add(preset.id);
  });
  return ids;
}

function persistInspoSelectedPresets(explicitScope) {
  const availableIds = getAvailableInspoPresetIds();
  const nextSelected = Array.from(_wizSelectedPresets || []).filter((id) => availableIds.has(id));
  _wizSelectedPresets = new Set(nextSelected);
  try {
    localStorage.setItem(getScopedStorageKey(INSPO_SELECTED_KEY, explicitScope), JSON.stringify(nextSelected));
  } catch (_) {}
}

function hasStoredInspoSelectedPresets(explicitScope) {
  try {
    return Array.isArray(JSON.parse(localStorage.getItem(getScopedStorageKey(INSPO_SELECTED_KEY, explicitScope)) || 'null'));
  } catch (_) {
    return false;
  }
}

function restoreInspoSelectedPresets(explicitScope) {
  let stored = [];
  try {
    stored = JSON.parse(localStorage.getItem(getScopedStorageKey(INSPO_SELECTED_KEY, explicitScope)) || '[]');
  } catch (_) {
    stored = [];
  }
  const availableIds = getAvailableInspoPresetIds();
  const nextSelected = normalizeStoredCustomSelectionIds(stored, availableIds, 'custom-preset');
  _wizSelectedPresets = new Set(nextSelected);
  if (Array.isArray(stored) && nextSelected.length !== stored.length) {
    persistInspoSelectedPresets(explicitScope);
  }
}

function persistFontSelectedPresets(explicitScope) {
  const availableIds = getAvailableFontPresetIds();
  const nextSelected = Array.from(_wizSelectedFontPresets || []).filter((id) => availableIds.has(id));
  _wizSelectedFontPresets = new Set(nextSelected);
  try {
    localStorage.setItem(getScopedStorageKey(FONT_SELECTED_KEY, explicitScope), JSON.stringify(nextSelected));
  } catch (_) {}
}

function restoreFontSelectedPresets(explicitScope) {
  let stored = [];
  try {
    stored = JSON.parse(localStorage.getItem(getScopedStorageKey(FONT_SELECTED_KEY, explicitScope)) || '[]');
  } catch (_) {
    stored = [];
  }
  const availableIds = getAvailableFontPresetIds();
  const nextSelected = normalizeStoredCustomSelectionIds(stored, availableIds, 'font-preset');
  _wizSelectedFontPresets = new Set(nextSelected);
  if (Array.isArray(stored) && nextSelected.length !== stored.length) {
    persistFontSelectedPresets(explicitScope);
  }
}

function inspoSaveLocalMeta(options = {}) {
  try {
    localStorage.setItem(getScopedStorageKey(INSPO_HIDDEN_KEY), JSON.stringify([..._wizHiddenBuiltins]));
    localStorage.setItem(getScopedStorageKey(INSPO_NAMES_KEY), JSON.stringify(_wizPresetNameOverrides));
  } catch(_) {}
  if (options.markDirty !== false) {
    markInspoLocalStateDirty(options.explicitScope);
  }
  queueAccountDesignPresetSync();
}

// --- Load everything and render ---
async function wizLoadInspoPresets() {
  inspoLoadLocalMeta();
  try {
    const res = await fetch('/design-presets/presets.json');
    if (res.ok) _wizInspoPresets = await res.json();
  } catch(e) { console.warn('Failed to load built-in presets', e); }
  try {
    _wizCustomPresets = await _inspoIdbLoadAll();
    _wizCustomPresets = await migratePresetCollectionIds(_wizCustomPresets, PRESET_BUCKET_INSPO);
    _wizCustomPresets.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  } catch(e) { console.warn('Failed to load custom presets', e); }
  restoreInspoSelectedPresets();
  wizRenderInspoPresets();
}

// --- Render presets grid ---
function wizRenderInspoPresets() {
  const container = document.getElementById('wizInspoPresets');
  if (!container) return;
  container.innerHTML = '';
  const _t = (k, fb) => window.I18N ? I18N.t(k) : fb;

  const visibleBuiltins = _wizInspoPresets.filter(p => p.thumb && !_wizHiddenBuiltins.has(p.id));
  const allCards = [
    ...visibleBuiltins.map(p => ({ id: p.id, name: _wizPresetNameOverrides[p.id] || p.name || '', src: p.thumb, isCustom: false })),
    ..._wizCustomPresets.map(p => ({ id: p.id, name: _wizPresetNameOverrides[p.id] || p.name || '', src: p.src || p.dataUrl, isCustom: true })),
  ];

  allCards.forEach(p => {
    const isOn = _wizSelectedPresets.has(p.id);
    const imgSrc = p.isCustom ? p.src : (p.src.startsWith('http') ? p.src : window.location.origin + p.src);

    const wrap = document.createElement('div');
    wrap.className = 'wiz-inspo-wrap';

    const card = document.createElement('div');
    card.className = 'wiz-inspo-card' + (isOn ? ' wiz-inspo-on' : '');
    card.dataset.presetId = p.id;
    card.title = p.name;

    // Thumbnail
    const img = document.createElement('img');
    img.className = 'wiz-inspo-card-thumb';
    img.src = imgSrc;
    img.alt = p.name;
    img.loading = 'lazy';
    card.appendChild(img);

    // Action buttons (top-right, shown on hover)
    const actions = document.createElement('div');
    actions.className = 'wiz-inspo-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'wiz-inspo-action-btn';
    editBtn.title = 'Rename';
    editBtn.innerHTML = '<i data-lucide="pencil"></i>';
    editBtn.onclick = (e) => { e.stopPropagation(); inspoStartRename(p.id, nameEl, p.isCustom); };
    actions.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'wiz-inspo-action-btn wiz-inspo-del-btn';
    delBtn.title = 'Delete preset';
    delBtn.innerHTML = '<i data-lucide="trash-2"></i>';
    delBtn.onclick = (e) => { e.stopPropagation(); inspoDeletePreset(p.id, p.isCustom); };
    actions.appendChild(delBtn);
    card.appendChild(actions);

    // Selected checkmark
    const check = document.createElement('div');
    check.className = 'wiz-inspo-check';
    check.innerHTML = '<i data-lucide="check"></i>';
    card.appendChild(check);

    // Name label (inline-editable)
    const nameEl = document.createElement('span');
    nameEl.className = 'wiz-inspo-card-name';
    nameEl.textContent = p.name;
    card.appendChild(nameEl);

    // Toggle selection on click (not on action buttons)
    card.onclick = () => {
      if (_wizSelectedPresets.has(p.id)) _wizSelectedPresets.delete(p.id);
      else _wizSelectedPresets.add(p.id);
      card.classList.toggle('wiz-inspo-on', _wizSelectedPresets.has(p.id));
      persistInspoSelectedPresets();
      saveAppState();
    };
    wrap.appendChild(card);

    // Full-view button below card
    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'wiz-inspo-view-btn';
    viewBtn.innerHTML = `<i data-lucide="expand"></i><span>${_t('wiz_inspo_full_view', 'Full View')}</span>`;
    viewBtn.onclick = (e) => { e.stopPropagation(); wizOpenLightbox(imgSrc); };
    wrap.appendChild(viewBtn);
    container.appendChild(wrap);
  });

  // "+" Add custom preset card
  const addWrap = document.createElement('div');
  addWrap.className = 'wiz-inspo-wrap';
  const addCard = document.createElement('button');
  addCard.type = 'button';
  addCard.className = 'wiz-inspo-add-card';
  addCard.innerHTML = `<i data-lucide="image-plus"></i><span>${_t('wiz_inspo_add_preset', 'Add Preset')}</span>`;
  addCard.onclick = () => inspoPickAndAddPreset();
  addWrap.appendChild(addCard);
  container.appendChild(addWrap);

  requestAnimationFrame(() => { if (window.lucide) window.lucide.createIcons(); });
}

async function wizLoadFontPresets() {
  inspoLoadLocalMeta();
  try {
    const res = await fetch('/font-presets/presets.json');
    if (res.ok) _wizFontBuiltins = await res.json();
    else _wizFontBuiltins = [];
  } catch (e) {
    _wizFontBuiltins = [];
    console.warn('Failed to load built-in font presets', e);
  }
  try {
    _wizFontCustomPresets = await _inspoIdbLoadAll(undefined, PRESET_BUCKET_FONT);
    _wizFontCustomPresets = await migratePresetCollectionIds(_wizFontCustomPresets, PRESET_BUCKET_FONT);
    _wizFontCustomPresets.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  } catch (e) {
    console.warn('Failed to load font presets', e);
  }
  restoreFontSelectedPresets();
  wizRenderFontPresets();
}

function wizRenderFontPresets() {
  const container = document.getElementById('wizFontPresets');
  if (!container) return;
  container.innerHTML = '';
  const _t = (k, fb) => window.I18N ? I18N.t(k) : fb;

  const cards = [
    ...(_wizFontBuiltins || [])
      .filter((preset) => preset && preset.id && preset.thumb && !_wizHiddenBuiltins.has(preset.id))
      .map((preset) => ({
        id: preset.id,
        name: _wizPresetNameOverrides[preset.id] || preset.name || '',
        src: preset.thumb.startsWith('http') ? preset.thumb : `${window.location.origin}${preset.thumb}`,
        isCustom: false,
      })),
    ...(_wizFontCustomPresets || []).map((preset) => ({
      id: preset.id,
      name: preset.name || '',
      src: preset.src || preset.dataUrl || '',
      isCustom: true,
    })).filter((preset) => preset.id && preset.src),
  ];

  cards.forEach((preset) => {
    const isOn = _wizSelectedFontPresets.has(preset.id);
    const wrap = document.createElement('div');
    wrap.className = 'wiz-inspo-wrap';

    const card = document.createElement('div');
    card.className = 'wiz-inspo-card' + (isOn ? ' wiz-inspo-on' : '');
    card.dataset.fontPresetId = preset.id;
    card.title = preset.name;

    const img = document.createElement('img');
    img.className = 'wiz-inspo-card-thumb';
    img.src = preset.src;
    img.alt = preset.name;
    img.loading = 'lazy';
    card.appendChild(img);

    const actions = document.createElement('div');
    actions.className = 'wiz-inspo-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'wiz-inspo-action-btn';
    editBtn.title = 'Rename';
    editBtn.innerHTML = '<i data-lucide="pencil"></i>';
    actions.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'wiz-inspo-action-btn wiz-inspo-del-btn';
    delBtn.title = preset.isCustom ? 'Delete' : 'Hide';
    delBtn.innerHTML = '<i data-lucide="trash-2"></i>';
    delBtn.onclick = (e) => { e.stopPropagation(); fontDeletePreset(preset.id, preset.isCustom); };
    actions.appendChild(delBtn);

    card.appendChild(actions);

    const check = document.createElement('div');
    check.className = 'wiz-inspo-check';
    check.innerHTML = '<i data-lucide="check"></i>';
    card.appendChild(check);

    const nameEl = document.createElement('div');
    nameEl.className = 'wiz-inspo-card-name';
    nameEl.textContent = preset.name;
    card.appendChild(nameEl);
    editBtn.onclick = (e) => { e.stopPropagation(); fontStartRename(preset.id, nameEl, preset.isCustom); };

    card.onclick = () => {
      if (_wizSelectedFontPresets.has(preset.id)) _wizSelectedFontPresets.delete(preset.id);
      else _wizSelectedFontPresets.add(preset.id);
      card.classList.toggle('wiz-inspo-on', _wizSelectedFontPresets.has(preset.id));
      persistFontSelectedPresets();
      saveAppState();
    };

    wrap.appendChild(card);

    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'wiz-inspo-view-btn';
    viewBtn.innerHTML = `<i data-lucide="expand"></i><span>${_t('wiz_inspo_full_view', 'Full View')}</span>`;
    viewBtn.onclick = (e) => { e.stopPropagation(); wizOpenLightbox(preset.src); };
    wrap.appendChild(viewBtn);
    container.appendChild(wrap);
  });

  const addWrap = document.createElement('div');
  addWrap.className = 'wiz-inspo-wrap';
  const addCard = document.createElement('button');
  addCard.type = 'button';
  addCard.className = 'wiz-inspo-add-card';
  addCard.innerHTML = `<i data-lucide="image-plus"></i><span>${_t('wiz_font_add_preset', 'Add Font Preset')}</span>`;
  addCard.onclick = () => fontPickAndAddPreset();
  addWrap.appendChild(addCard);
  container.appendChild(addWrap);

  requestAnimationFrame(() => { if (window.lucide) window.lucide.createIcons(); });
}

// --- Add custom preset flow ---
function inspoPickAndAddPreset() {
  const input = document.getElementById('wizInspoFileInput');
  if (!input) return;
  input.onchange = async (e) => {
    const file = (e.target.files || [])[0];
    if (!file) return;
    e.target.value = '';
    const dataUrl = await _fileToDataUrl(file);
    const suggestedName = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
    inspoShowNameModal(dataUrl, suggestedName);
  };
  input.click();
}

function _fileToDataUrl(file) {
  return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
}

function inspoShowNameModal(dataUrl, suggestedName) {
  const overlay = document.createElement('div');
  overlay.className = 'inspo-name-overlay';
  overlay.innerHTML = `
    <div class="inspo-name-modal">
      <img src="${dataUrl}" class="inspo-name-preview" alt="" />
      <div class="inspo-name-body">
        <div class="inspo-name-label">Name your preset</div>
        <input type="text" class="inspo-name-input" value="${suggestedName}" placeholder="e.g. Minimalist White..." maxlength="50" />
        <div class="inspo-name-actions">
          <button type="button" class="inspo-name-cancel">Cancel</button>
          <button type="button" class="inspo-name-save"><i data-lucide="check"></i> Save Preset</button>
        </div>
      </div>
    </div>`;
  const inp  = overlay.querySelector('.inspo-name-input');
  const save = overlay.querySelector('.inspo-name-save');
  const cancel = overlay.querySelector('.inspo-name-cancel');
  cancel.onclick = () => { overlay.classList.remove('inspo-name-open'); setTimeout(() => overlay.remove(), 220); };
  overlay.onclick = (e) => { if (e.target === overlay) cancel.onclick(); };
  save.onclick = async () => {
    const name = inp.value.trim() || suggestedName || 'Custom Preset';
    const id = (window.crypto && typeof window.crypto.randomUUID === 'function')
      ? window.crypto.randomUUID()
      : normalizeCustomPresetId('', 'custom-preset');
    const preset = { id, name, dataUrl, addedAt: Date.now(), ownerKey: getInspoPresetOwnerKey() };
    _wizCustomPresets.push(preset);
    try { await _inspoIdbSave(preset); } catch(e) { console.warn('Failed to save preset to IDB', e); }
    markInspoLocalStateDirty();
    persistInspoSelectedPresets();
    cancel.onclick();
    wizRenderInspoPresets();
    saveAppState();
    showToast(`Preset "${name}" saved`, 'info');
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') save.onclick(); if (e.key === 'Escape') cancel.onclick(); };
  document.body.appendChild(overlay);
  requestAnimationFrame(() => {
    overlay.classList.add('inspo-name-open');
    if (window.lucide) window.lucide.createIcons();
    inp.focus(); inp.select();
  });
}

// --- Rename a preset inline ---
function inspoStartRename(id, nameEl, isCustom) {
  const current = nameEl.textContent;
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'wiz-inspo-rename-input';
  inp.value = current; inp.maxLength = 50;
  const finish = async (save) => {
    const newName = inp.value.trim() || current;
    nameEl.textContent = save ? newName : current;
    inp.replaceWith(nameEl);
    if (!save) return;
    if (isCustom) {
      const cp = _wizCustomPresets.find(p => p.id === id);
      if (cp) {
        cp.name = newName;
        try { await _inspoIdbSave(cp); } catch(_) {}
        markInspoLocalStateDirty();
      }
    } else {
      _wizPresetNameOverrides[id] = newName;
      inspoSaveLocalMeta();
    }
  };
  inp.onblur = () => finish(true);
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') { finish(false); }
  };
  nameEl.replaceWith(inp);
  inp.focus(); inp.select();
}

// --- Delete a preset ---
async function inspoDeletePreset(id, isCustom) {
  if (isCustom) {
    const idx = _wizCustomPresets.findIndex(p => p.id === id);
    if (idx !== -1) _wizCustomPresets.splice(idx, 1);
    try { await _inspoIdbDelete(id); } catch(e) { console.warn('Failed to delete preset from IDB', e); }
    markInspoLocalStateDirty();
  } else {
    _wizHiddenBuiltins.add(id);
  }
  _wizSelectedPresets.delete(id);
  delete _wizPresetNameOverrides[id];
  inspoSaveLocalMeta();
  persistInspoSelectedPresets();
  wizRenderInspoPresets();
  saveAppState();
}

function fontPickAndAddPreset() {
  const input = document.getElementById('wizFontPresetFileInput');
  if (!input) return;
  input.onchange = async (e) => {
    const file = (e.target.files || [])[0];
    if (!file) return;
    e.target.value = '';
    const dataUrl = await _fileToDataUrl(file);
    const suggestedName = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
    fontShowNameModal(dataUrl, suggestedName);
  };
  input.click();
}

function fontShowNameModal(dataUrl, suggestedName) {
  const overlay = document.createElement('div');
  overlay.className = 'inspo-name-overlay';
  overlay.innerHTML = `
    <div class="inspo-name-modal">
      <img src="${dataUrl}" class="inspo-name-preview" alt="" />
      <div class="inspo-name-body">
        <div class="inspo-name-label">${escapeHtml(toolsUiText('wiz_font_modal_title', 'Name your font preset'))}</div>
        <input type="text" class="inspo-name-input" value="${escapeHtml(suggestedName)}" placeholder="${escapeHtml(toolsUiText('wiz_font_modal_placeholder', 'e.g. Luxury gold serif...'))}" maxlength="50" />
        <div class="inspo-name-actions">
          <button type="button" class="inspo-name-cancel">${escapeHtml(toolsUiText('cancel', 'Cancel'))}</button>
          <button type="button" class="inspo-name-save"><i data-lucide="check"></i> ${escapeHtml(toolsUiText('wiz_font_modal_save', 'Save Font Preset'))}</button>
        </div>
      </div>
    </div>`;
  const inp = overlay.querySelector('.inspo-name-input');
  const save = overlay.querySelector('.inspo-name-save');
  const cancel = overlay.querySelector('.inspo-name-cancel');
  cancel.onclick = () => { overlay.classList.remove('inspo-name-open'); setTimeout(() => overlay.remove(), 220); };
  overlay.onclick = (e) => { if (e.target === overlay) cancel.onclick(); };
  save.onclick = async () => {
    const name = inp.value.trim() || suggestedName || 'Font Preset';
    const id = (window.crypto && typeof window.crypto.randomUUID === 'function')
      ? window.crypto.randomUUID()
      : normalizeCustomPresetId('', 'font-preset');
    const preset = { id, name, dataUrl, addedAt: Date.now(), ownerKey: getInspoPresetOwnerKey(), bucket: PRESET_BUCKET_FONT };
    _wizFontCustomPresets.push(preset);
    try { await _inspoIdbSave(preset, PRESET_BUCKET_FONT); } catch (e) { console.warn('Failed to save font preset to IDB', e); }
    markInspoLocalStateDirty();
    persistFontSelectedPresets();
    cancel.onclick();
    wizRenderFontPresets();
    saveAppState();
    showToast(`Preset "${name}" saved`, 'info');
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') save.onclick(); if (e.key === 'Escape') cancel.onclick(); };
  document.body.appendChild(overlay);
  requestAnimationFrame(() => {
    overlay.classList.add('inspo-name-open');
    if (window.lucide) window.lucide.createIcons();
    inp.focus();
    inp.select();
  });
}

function fontStartRename(id, nameEl, isCustom) {
  const current = nameEl.textContent;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'wiz-inspo-rename-input';
  inp.value = current;
  inp.maxLength = 50;
  const finish = async (save) => {
    const newName = inp.value.trim() || current;
    nameEl.textContent = save ? newName : current;
    inp.replaceWith(nameEl);
    if (!save) return;
    if (isCustom) {
      const preset = _wizFontCustomPresets.find((item) => item.id === id);
      if (preset) {
        preset.name = newName;
        try { await _inspoIdbSave(preset, PRESET_BUCKET_FONT); } catch (_) {}
        markInspoLocalStateDirty();
      }
    } else {
      _wizPresetNameOverrides[id] = newName;
      inspoSaveLocalMeta();
    }
  };
  inp.onblur = () => finish(true);
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') finish(false);
  };
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();
}

async function fontDeletePreset(id, isCustom) {
  if (isCustom) {
    const idx = _wizFontCustomPresets.findIndex((preset) => preset.id === id);
    if (idx !== -1) _wizFontCustomPresets.splice(idx, 1);
    try { await _inspoIdbDelete(id); } catch (e) { console.warn('Failed to delete font preset from IDB', e); }
  } else {
    _wizHiddenBuiltins.add(id);
  }
  _wizSelectedFontPresets.delete(id);
  delete _wizPresetNameOverrides[id];
  markInspoLocalStateDirty();
  inspoSaveLocalMeta();
  persistFontSelectedPresets();
  wizRenderFontPresets();
  saveAppState();
}

function wizOpenLightbox(src) {
  const lb = document.getElementById('wizLightbox');
  const img = document.getElementById('wizLightboxImg');
  if (!lb || !img) return;
  img.src = src;
  lb.style.display = 'flex';
  requestAnimationFrame(() => lb.classList.add('wiz-lightbox-open'));
}
function wizCloseLightbox() {
  const lb = document.getElementById('wizLightbox');
  if (!lb) return;
  lb.classList.remove('wiz-lightbox-open');
  setTimeout(() => { lb.style.display = 'none'; }, 250);
}
window.wizCloseLightbox = wizCloseLightbox;

// wizInitInspoUpload is now a no-op (file input triggered programmatically)
function wizInitInspoUpload() {}

function wizRenderInspoThumbs() {}  // kept for backwards compat

function getInspoPresetSources() {
  const sources = [];
  _wizSelectedPresets.forEach((id) => {
    const builtin = _wizInspoPresets.find((x) => x.id === id);
    if (builtin && builtin.thumb) {
      const absoluteUrl = builtin.thumb.startsWith('http') ? builtin.thumb : `${window.location.origin}${builtin.thumb}`;
      sources.push(createRemoteAssetItem({
        url: absoluteUrl,
        type: 'image',
        filename: deriveFilenameFromUrl(absoluteUrl, 'jpg'),
      }));
      return;
    }
    const custom = _wizCustomPresets.find((x) => x.id === id);
    if (!custom) return;
    const src = custom.src || custom.dataUrl || null;
    if (!src) return;
    sources.push(createRemoteAssetItem({
      url: src,
      type: 'image',
      filename: `${custom.name || custom.id || 'preset'}.png`,
      mimeHint: 'image/png',
    }));
  });
  return sources.filter(Boolean);
}

function getFontPresetSources() {
  const sources = [];
  _wizSelectedFontPresets.forEach((id) => {
    const builtin = _wizFontBuiltins.find((item) => item.id === id);
    if (builtin && builtin.thumb && !_wizHiddenBuiltins.has(id)) {
      const absoluteUrl = builtin.thumb.startsWith('http') ? builtin.thumb : `${window.location.origin}${builtin.thumb}`;
      sources.push(createRemoteAssetItem({
        url: absoluteUrl,
        type: 'image',
        filename: deriveFilenameFromUrl(absoluteUrl, 'jpg'),
      }));
      return;
    }
    const preset = _wizFontCustomPresets.find((item) => item.id === id);
    if (!preset) return;
    const src = preset.src || preset.dataUrl || null;
    if (!src) return;
    sources.push(createRemoteAssetItem({
      url: src,
      type: 'image',
      filename: `${preset.name || preset.id || 'font-preset'}.png`,
      mimeHint: 'image/png',
    }));
  });
  return sources.filter(Boolean);
}

// ---- WB CARD PROMPT ASSEMBLY ----
function assembleWbCardPrompt(productImageCount) {
  const formatImageRange = (start, count) => {
    if (!count || count < 1) return '';
    return count === 1 ? `Image ${start}` : `Images ${start}-${start + count - 1}`;
  };
  const formatOrderedRole = (start, count, singularLabel, pluralLabel, tail) => {
    if (!count || count < 1) return '';
    const range = formatImageRange(start, count);
    const label = count === 1 ? singularLabel : pluralLabel;
    return `${range} - ${label}: ${tail}`;
  };
  const quoteExact = (value) => JSON.stringify(String(value == null ? '' : value));
  const title = (qs('toolsTitleInput') ? qs('toolsTitleInput').value.trim() : '') || 'Premium Quality';
  const charItems = document.querySelectorAll('.tools-char-item');
  const chars = [];
  charItems.forEach(item => {
    const input = item.querySelector('input[type="text"], textarea.wiz-char-input');
    if (input && input.value.trim()) chars.push(input.value.trim());
  });
  const rawFontStyle = (qs('toolsFontInput') ? qs('toolsFontInput').value.trim() : '');
  // The font picker stores a localized label (e.g. "Мягкий округлый") in toolsFontInput.
  // For the prompt we always need the canonical English label so the model never sees
  // translated UI strings like "Мягкий" inside the typography style guide.
  const fontStyleEnglish = (() => {
    if (!rawFontStyle) return '';
    if (typeof WIZ_FONTS === 'undefined' || !Array.isArray(WIZ_FONTS)) return rawFontStyle;
    const enDict = (window.TRANSLATIONS && window.TRANSLATIONS.en) ? window.TRANSLATIONS.en : null;
    for (const f of WIZ_FONTS) {
      const enLabel = enDict && enDict[f.val] ? enDict[f.val] : f.name;
      const localizedLabel = (window.I18N && typeof I18N.t === 'function') ? I18N.t(f.val) : f.name;
      if (rawFontStyle === enLabel || rawFontStyle === localizedLabel || rawFontStyle === f.name) {
        return enLabel;
      }
    }
    return rawFontStyle;
  })();
  const fontStyle = fontStyleEnglish || 'Bold minimalist sans-serif';
  const wishes = (qs('toolsWishesInput') ? qs('toolsWishesInput').value.trim() : '') || '';
  const featureLines = chars.length > 0 ? chars : ['Natural materials', 'Premium quality', 'Guaranteed'];
  const charsBlock = featureLines.map(c => `  • ${c}`).join('\n');
  const exactTitle = quoteExact(title);
  const exactFeatureBlock = featureLines.map((c, index) => `${index + 1}. ${quoteExact(c)}`).join('\n');
  const alwaysOnWildberriesGuideline = 'Creat product desighn profesional eye cating , for wildberis do serch how to do good cards for wildberis';
  const textOverlays = skGetTextOverlaysForPrompt();
  const inspoPresetCount = getInspoPresetSources().length;
  const inspoUploadCount = uploadedInspoImages.length;
  const totalInspoCount = inspoPresetCount + inspoUploadCount;
  const fontPresetCount = getFontPresetSources().length;
  const prodCount = productImageCount || 0;
  const hasInspo = totalInspoCount > 0;
  const hasFontPresetRefs = fontPresetCount > 0;
  const alignBgWithProductStyle = !!(qs('toolsInspoMatchBg') && qs('toolsInspoMatchBg').checked);
  const bgStyleHarmonyBlock = alignBgWithProductStyle
    ? `

═══ BACKGROUND STYLE ALIGNMENT (enabled) ═══
Ensure the background, scene styling, color palette, props, and decorative details match the product's overall style, material character, and brand mood so the final card feels cohesive.`
    : '';

  const fontRefStart = prodCount + 1;
  const designRefStart = prodCount + fontPresetCount + 1;
  const designReferenceAuthorityLine = hasFontPresetRefs
    ? 'Transfer the NON-TYPOGRAPHIC design language from the design reference(s): scene, palette, composition, crop, negative space, panels, badges, frames, supporting text placement, icon language, transparency boxes, borders, shadows, overlays, and decorative motifs. Use them for where text sits and how the card is structured, but do not let them override the headline treatment defined by the typography reference(s).'
    : 'Transfer the full visual language from the design reference(s): scene, palette, composition, crop, negative space, panels, badges, frames, typography treatment, icon language, transparency boxes, borders, shadows, overlays, and decorative motifs. Recreate the same design family with high fidelity.';
  const fontReferenceRolesBlock = hasFontPresetRefs
    ? `\n`
      + (fontPresetCount === 1
          ? `Image ${fontRefStart} - TYPOGRAPHY REFERENCE: This image is authority for the MAIN HEADLINE treatment.\n`
          : `Images ${fontRefStart}-${fontRefStart + fontPresetCount - 1} - TYPOGRAPHY REFERENCES: These images are authority for the MAIN HEADLINE treatment.\n`)
      + `Study the typography reference(s) as headline treatment guides. Match with high fidelity: letterform family, proportions, weight, width, stroke contrast, case handling, spacing, curvature, slant, distortion, perspective, rotation, color, gradients, metallic/foil/glass feel, transparency/opacity, texture, outline, bevel, emboss, glow, shadow, and the overall silhouette and energy of the headline block.\nTransfer the style system, not the literal words shown inside the reference image(s). If multiple typography references conflict, follow the clearest shared direction or the strongest single reference instead of averaging unrelated styles.\nUse the typography reference(s) ONLY for the headline treatment and its text effects. Do NOT copy their background scene, product arrangement, or unrelated objects.`
    : '';
  const fontDirectionBlock = hasFontPresetRefs
    ? 'Use the uploaded typography reference image(s) as the strongest authority for the headline block. Match not only the font family, but also the headline color treatment, gradients, transparency, texture, outline, glow, shadow, depth, curvature, and graphic presence. Keep the exact user-provided headline words. Supporting bullet text should harmonize with that system, but stay simpler and highly readable.'
    : `HEADING TYPOGRAPHY STYLE GUIDE: ${fontStyle}\nUse this as the direction for the headline treatment. Also decide tasteful headline color, texture, transparency, and supporting text styling that fit the overall card.`;
  const referencePriorityBlock = (() => {
    const lines = ['═══ REFERENCE PRIORITY (follow strictly) ═══'];
    if (prodCount > 0) {
      lines.push(`1. ${formatOrderedRole(1, prodCount, 'PRODUCT PHOTO', 'PRODUCT PHOTOS', 'Use these as the source of truth for the product. Preserve exact shape, color, material, texture, proportions, and real-world scale.')}`);
    }
    if (hasFontPresetRefs) {
      lines.push(`${lines.length}. ${formatOrderedRole(fontRefStart, fontPresetCount, 'TYPOGRAPHY REFERENCE', 'TYPOGRAPHY REFERENCES', 'Use these as the source of truth for headline lettering style and text effects only.')}`);
    }
    if (hasInspo) {
      lines.push(`${lines.length}. ${formatOrderedRole(designRefStart, totalInspoCount, 'DESIGN REFERENCE', 'DESIGN REFERENCES', 'Use these as the source of truth for composition, layout, palette, background, decorative framing, and non-typographic visual language.')}`);
    }
    if (hasFontPresetRefs && hasInspo) {
      lines.push('If the font reference(s) and design reference(s) disagree about typography, follow the font reference(s) for letterforms and text effects, and follow the design reference(s) for placement, composition, background, and overall art direction.');
    }
    if (prodCount > 0 && (hasFontPresetRefs || hasInspo)) {
      lines.push('If any other reference conflicts with the product photo(s), preserve the product photo(s).');
    }
    return lines.join('\n');
  })();

  const quotedTextRulesBlock = `═══ TEXT TO RENDER (quoted text is immutable) ═══
Headline — render exactly once:
${exactTitle}

Feature bullets — render each exactly once, each with one matching icon:
${exactFeatureBlock}

Never paraphrase, translate, reorder, merge, or duplicate the quoted text. If a feature needs multiple lines, keep the wording character-for-character identical.`;

  const creativeSynthesisBlock = hasInspo
    ? `═══ CREATIVE SYNTHESIS ═══
Create one fresh, premium Wildberries hero card in the SAME design family as the reference image(s), not a literal pixel copy and not a collage. Preserve the reference hierarchy, layout logic, and styling cues, but adapt them intelligently to this exact product and this exact text.

If the design reference(s) show translucent text panels, frosted boxes, sticker shapes, glow bars, borders, frames, layered shadows, or angled text blocks, adapt those treatments where they strengthen readability and visual impact.`
    : `═══ CREATIVE SYNTHESIS ═══
Design an original premium Wildberries hero card with strong hierarchy, believable lifestyle staging, polished text panels, and tasteful decorative framing where needed. The result should feel art-directed, not templated.`;

  const productPreservationBlock = `═══ PRODUCT PRESERVATION (critical — zero deviation) ═══
• Preserve the product’s exact shape, color, material, proportions, texture, and scale from the product photo(s).
• Do NOT add text, logos, labels, patterns, or extra details directly on the product itself.
• Keep the product physically grounded with believable perspective, contact shadows, and real-world scale.
• If any reference conflicts with the product photo(s), preserve the product photo(s).`;

  const typographyTransferBlock = `═══ TYPOGRAPHY & TEXT-STYLING TRANSFER ═══
${fontDirectionBlock}
${hasInspo
    ? 'Use the design reference(s) for text placement, layout hierarchy, supporting panels, margin rhythm, and icon positioning.'
    : 'Create an elegant, high-contrast text layout with a clear headline zone and supporting feature bullets that feel premium and easy to scan.'}
If typography reference(s) are present, they control how the main headline looks: letterforms, styling, transparency, colors, gradients, texture, effects, and graphic attitude. ${hasInspo ? 'The design reference(s) control where the text group sits in the composition and how the surrounding card is structured.' : 'Build the surrounding card structure to support that headline treatment.'}
Keep the headline visually dominant. Supporting feature text should harmonize with the headline system, but remain cleaner and more legible.`;

  const qualityBlock = `═══ FORBIDDEN ═══
✗ Prices, discount tags, promo stickers, star ratings, barcodes
✗ Wildberries or WB logos, watermarks, or any unrelated branding
✗ Duplicate text, duplicated icons, or copied words from the typography reference image(s)

═══ QUALITY BAR ═══
Premium e-commerce art direction · strong visual hierarchy · high readability · cinematic but commercially clean lighting · coherent palette · polished composition · 4K-ready detail · no sloppy collage look`;

  if (hasInspo) {
    let imageRolesBlock = `═══ IMAGE ROLES (follow strictly) ═══\n`;
    if (prodCount > 0) {
      imageRolesBlock += (prodCount === 1
        ? 'Image 1 — PRODUCT PHOTO: Reproduce the product’s exact shape, color, material, and texture faithfully. Do NOT alter it.'
        : `Images 1-${prodCount} - PRODUCT PHOTOS: Reproduce the product’s exact shape, color, material, and texture faithfully. Do NOT alter it.`) + '\n';
    }
    if (hasFontPresetRefs) imageRolesBlock += fontReferenceRolesBlock + '\n';
    imageRolesBlock += (totalInspoCount === 1
      ? `Image ${designRefStart} - DESIGN REFERENCE: This image is the authority for the overall card art direction.`
      : `Images ${designRefStart}-${designRefStart + totalInspoCount - 1} - DESIGN REFERENCES: These images are the authority for the overall card art direction.`)
      + `\n${designReferenceAuthorityLine}\nDo NOT take products or literal objects from the design reference(s) - only transfer the intended visual language.`;

    return `Create one premium Wildberries marketplace product card from the uploaded references.

Goal: make an original, conversion-focused hero card that feels creatively art-directed from the references while keeping the product exact and the user text exact.

═══ MAIN GUIDELINE ═══
${alwaysOnWildberriesGuideline}

═══ CANVAS ═══
Portrait 3:4. Premium commercial product-card aesthetic. Ultra-sharp, 4K-ready, polished, high-end, coherent.

${referencePriorityBlock}

${imageRolesBlock}

${creativeSynthesisBlock}

${productPreservationBlock}

${quotedTextRulesBlock}

${typographyTransferBlock}

═══ LAYOUT & READABILITY ═══
Keep the headline, feature bullets, icons, and supporting panels in the same hierarchy and placement logic as the design reference(s). Match spacing, alignment, panel treatment, transparency strategy, and contrast style so the text is both beautiful and instantly readable.
The headline is the visual hero among all text. The feature bullets must support it without competing with it.

${qualityBlock}${bgStyleHarmonyBlock}${wishes ? `\n\n═══ USER WISHES ═══\n${wishes}` : ''}${textOverlays ? `\n\n═══ EXTRA TEXT TO RENDER (quoted content remains exact) ═══\n${textOverlays}` : ''}`;
  }

  const sceneBlock = `═══ SCENE ═══
Full-background lifestyle scene thematically matched to the product — NOT a flat studio cutout or template banner.
Shot: medium to medium-close. Composition: rule of thirds with product as clear focal point.
Lighting: professional studio-lifestyle blend — soft diffused key light, warm subtle fill, clean sharp shadows, slight depth of field (product sharp, background slightly soft).
Include scale-anchoring context objects (table / shelf / hands / interior surfaces) so the product size reads naturally.

Scene type — apply whichever matches the product:
→ Wearable / accessory / clothing → shown worn on person or mannequin; face optional; product is hero
→ Kitchenware / cookware / food → elegant table or kitchen scene, real-world scale
→ Cosmetics / beauty / skincare → vanity or bathroom surface, no competitor branding
→ Electronics / gadgets → active-use scenario (desk / hands / home), no third-party logos
→ Home décor / furniture / textiles → interior scene where scale reads naturally`;

  const textBlock = `${quotedTextRulesBlock}

═══ TEXT PLACEMENT ═══
HEADLINE — positioned at the TOP CENTER or the strongest premium headline zone in the composition.
FEATURE BULLETS — placed on LEFT and RIGHT sides or in balanced supporting positions around the product, each with a small matching icon.
All text must remain immediately legible with strong contrast and clean support panels where needed.`;

  const iconAndTypoBlock = `═══ ICON & TYPOGRAPHY STYLE ═══
Icons: each feature bullet should have ONE matching icon. All icons must belong to one coherent visual family and feel intentionally designed for this card.

${typographyTransferBlock}`;

  let imageRolesBlock = '';
  if (prodCount > 0 || hasFontPresetRefs) {
    imageRolesBlock = `\n\n═══ REFERENCE IMAGE ROLES (critical — follow strictly) ═══`;
    if (prodCount > 0) {
      const prodRange = prodCount === 1 ? 'Image 1 is a' : `Images 1-${prodCount} are`;
      imageRolesBlock += `\n${prodRange} PRODUCT PHOTO(S): Use these to understand the product’s exact appearance, shape, color, material, and texture. Reproduce the product faithfully.`;
    }
    if (hasFontPresetRefs) imageRolesBlock += fontReferenceRolesBlock;
  }

  return `Create one premium Wildberries marketplace product card. This is a structured edit-and-design task: preserve the product exactly, render the text exactly, and build a fresh premium card around it.

═══ MAIN GUIDELINE ═══
${alwaysOnWildberriesGuideline}

═══ CANVAS ═══
Format: portrait 3:4 ratio. Style: photorealistic commercial product photography. Quality: ultra-sharp, 4K resolution, award-winning composition, cinematic lighting, masterpiece.

${referencePriorityBlock}

${creativeSynthesisBlock}

${productPreservationBlock}

${sceneBlock}

${textBlock}

${iconAndTypoBlock}

${qualityBlock}${imageRolesBlock}${bgStyleHarmonyBlock}${wishes ? `\n\n═══ USER REQUESTS ═══\n${wishes}` : ''}${textOverlays ? `\n\n═══ EXTRA TEXT TO RENDER (quoted content remains exact) ═══\n${textOverlays}` : ''}`;
}

function assembleWbCardPromptGptImage2(productImageCount) {
  const formatImageRange = (start, count) => {
    if (!count || count < 1) return '';
    return count === 1 ? `Image ${start}` : `Images ${start}-${start + count - 1}`;
  };
  const quoteExact = (value) => JSON.stringify(String(value == null ? '' : value));
  const title = (qs('toolsTitleInput') ? qs('toolsTitleInput').value.trim() : '') || 'Premium Quality';
  const charItems = document.querySelectorAll('.tools-char-item');
  const chars = [];
  charItems.forEach(item => {
    const input = item.querySelector('input[type="text"], textarea.wiz-char-input');
    if (input && input.value.trim()) chars.push(input.value.trim());
  });
  const wishes = (qs('toolsWishesInput') ? qs('toolsWishesInput').value.trim() : '') || '';
  const featureLines = chars.length > 0 ? chars : ['Natural materials', 'Premium quality', 'Guaranteed'];
  const exactTitle = quoteExact(title);
  const exactFeatureBlock = featureLines.map((c, index) => `${index + 1}. ${quoteExact(c)}`).join('\n');
  const alwaysOnWildberriesGuideline = 'Creat product desighn profesional eye cating , for wildberis do serch how to do good cards for wildberis';
  const textOverlays = skGetTextOverlaysForPrompt();
  const inspoPresetCount = getInspoPresetSources().length;
  const inspoUploadCount = uploadedInspoImages.length;
  const totalInspoCount = inspoPresetCount + inspoUploadCount;
  const fontPresetCount = getFontPresetSources().length;
  const prodCount = productImageCount || 0;
  const hasInspo = totalInspoCount > 0;
  const hasFontPresetRefs = fontPresetCount > 0;
  const fontRefStart = prodCount + 1;
  const designRefStart = prodCount + fontPresetCount + 1;
  const sections = [
    'Create a professional Wildberries product card.',
    '',
    alwaysOnWildberriesGuideline,
    '',
    'Format: portrait 3:4.',
    '',
    'PRODUCT',
    'Use the uploaded product image(s) as the source of truth for the product.',
    'Keep the product exact: shape, color, material, texture, proportions, and overall appearance.',
    '',
    'TEXT TO RENDER EXACTLY',
    'Headline:',
    exactTitle,
    '',
    'Feature text:',
    exactFeatureBlock,
    '',
    'ONLY USER-PROVIDED TEXT',
    'Render only text explicitly provided by the user in this tool section.',
    'Allowed text sources: the Headline, the Feature text, the EXTRA TEXT TO RENDER EXACTLY block, and any new text explicitly requested by the user in USER WISHES.',
    'Do not copy, paraphrase, translate, infer, or borrow any text, letters, words, numbers, slogans, labels, or captions from typography references, design references, product images, or any other reference image.',
  ];
  if (hasFontPresetRefs) {
    sections.push(
      '',
      'TYPOGRAPHY REFERENCES',
      `${formatImageRange(fontRefStart, fontPresetCount)} are typography reference(s). Use them for the headline style.`
    );
  }
  if (hasInspo) {
    sections.push(
      '',
      'DESIGN REFERENCES',
      `${formatImageRange(designRefStart, totalInspoCount)} are design reference(s).`,
      'Use them for the card layout, composition, positioning, background style, palette, spacing, panels, framing, and overall visual direction.'
    );
  }
  if (hasFontPresetRefs && hasInspo) {
    sections.push(
      '',
      'REFERENCE PRIORITY',
      'Product images control the product.',
      'Typography references control the headline appearance.',
      'Design references control the layout, placement, palette, and card structure.'
    );
  }
  sections.push(
    '',
    'OUTPUT GOAL',
    'Create a professional, eye-catching product design for Wildberries. Research how to design high-converting product cards for the platform.'
  );
  if (wishes) {
    sections.push('', 'USER WISHES', wishes);
  }
  if (textOverlays) {
    sections.push('', 'EXTRA TEXT TO RENDER EXACTLY', textOverlays);
  }
  return sections.join('\n');
}

async function submitToolsRequest(task) {
  if (task && task.toolsTool === 'enhancer') {
    const imageSource = getToolsUtilitySource();
    const imageUrl = await resolveUploadItemUrl(imageSource, 'tools-enhancer-image', task);
    if (!imageUrl) throw new Error(window.I18N ? I18N.t('select_image') : 'Select image');

    const enhancerModel = qs('toolsEnhancerModel') ? qs('toolsEnhancerModel').value : 'Standard V2';
    const enhancerBody = {
      model_id: TOOLS_TOOL_MODEL_IDS.enhancer,
      image_url: imageUrl,
      model: enhancerModel,
      upscale_factor: Number(qs('toolsEnhancerUpscaleFactor') ? qs('toolsEnhancerUpscaleFactor').value : 2) || 2,
      crop_to_fill: !!(qs('toolsEnhancerCropToFill') && qs('toolsEnhancerCropToFill').checked),
      output_format: qs('toolsEnhancerOutputFormat') ? qs('toolsEnhancerOutputFormat').value : 'jpeg',
    };

    if (TOPAZ_SUBJECT_MODELS.has(enhancerModel)) {
      enhancerBody.subject_detection = qs('toolsEnhancerSubjectDetection') ? qs('toolsEnhancerSubjectDetection').value : 'All';
    }
    if (TOPAZ_FACE_MODELS.has(enhancerModel)) {
      enhancerBody.face_enhancement = !!(qs('toolsEnhancerFaceEnhancement') && qs('toolsEnhancerFaceEnhancement').checked);
      if (enhancerBody.face_enhancement) {
        enhancerBody.face_enhancement_creativity = Number(qs('toolsEnhancerFaceCreativity') ? qs('toolsEnhancerFaceCreativity').value : 0) || 0;
        enhancerBody.face_enhancement_strength = Number(qs('toolsEnhancerFaceStrength') ? qs('toolsEnhancerFaceStrength').value : 0.8) || 0.8;
      }
    }
    if (TOPAZ_SHARPEN_DENOISE_MODELS.has(enhancerModel)) {
      enhancerBody.sharpen = Number(qs('toolsEnhancerSharpen') ? qs('toolsEnhancerSharpen').value : 0) || 0;
      enhancerBody.denoise = Number(qs('toolsEnhancerDenoise') ? qs('toolsEnhancerDenoise').value : 0) || 0;
    }
    if (TOPAZ_FIX_COMPRESSION_MODELS.has(enhancerModel)) {
      enhancerBody.fix_compression = Number(qs('toolsEnhancerFixCompression') ? qs('toolsEnhancerFixCompression').value : 0) || 0;
    }
    if (enhancerModel === 'Text Refine') {
      enhancerBody.strength = Number(qs('toolsEnhancerStrength') ? qs('toolsEnhancerStrength').value : 0.5) || 0.5;
    }
    if (enhancerModel === 'Redefine') {
      enhancerBody.creativity = Number(qs('toolsEnhancerCreativity') ? qs('toolsEnhancerCreativity').value : 3) || 3;
      enhancerBody.texture = Number(qs('toolsEnhancerTexture') ? qs('toolsEnhancerTexture').value : 3) || 3;
      const redefinePrompt = qs('toolsEnhancerPrompt') ? qs('toolsEnhancerPrompt').value.trim() : '';
      if (redefinePrompt) enhancerBody.prompt = redefinePrompt;
      if (qs('toolsEnhancerAutoprompt') && qs('toolsEnhancerAutoprompt').checked) enhancerBody.autoprompt = true;
    }
    if (enhancerModel === 'Recovery V2') {
      enhancerBody.detail = Number(qs('toolsEnhancerDetail') ? qs('toolsEnhancerDetail').value : 0.5) || 0.5;
    }

    const enhancerRes = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enhancerBody),
    });
    if (!enhancerRes.ok) throw await createResponseError(enhancerRes, 'Image enhancement failed');
    return await enhancerRes.json();
  }

  if (task && task.toolsTool === 'background-removal') {
    const imageSource = getToolsUtilitySource();
    const imageUrl = await resolveUploadItemUrl(imageSource, 'tools-cutout-image', task);
    if (!imageUrl) throw new Error(window.I18N ? I18N.t('select_image') : 'Select image');

    const bgBody = {
      model_id: TOOLS_TOOL_MODEL_IDS['background-removal'],
      image_url: imageUrl,
      output_format: qs('toolsBgOutputFormat') ? qs('toolsBgOutputFormat').value : 'rgba',
      sync_mode: !!(qs('toolsBgSyncMode') && qs('toolsBgSyncMode').value === 'true'),
    };

    const bgRes = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bgBody),
    });
    if (!bgRes.ok) throw await createResponseError(bgRes, 'Background removal failed');
    return await bgRes.json();
  }

  if (task && task.toolsTool === 'sam-audio') {
    const audioSource = getToolsUtilityAudioSource();
    const audioUrl = await resolveUploadItemUrl(audioSource, 'tools-sam-audio-source', task);
    if (!audioUrl) throw new Error(window.I18N ? I18N.t('select_audio') : 'Select audio');

    const modelId = getToolsSamAudioModelId();
    const isSpanMode = modelId === 'fal-ai/sam-audio/span-separate';
    const prompt = qs('toolsSamAudioPrompt') ? qs('toolsSamAudioPrompt').value.trim() : '';
    const body = {
      model_id: modelId,
      audio_url: audioUrl,
      reranking_candidates: Math.max(1, Math.min(7, Number(qs('toolsSamAudioRerankingCandidates') ? qs('toolsSamAudioRerankingCandidates').value : 1) || 1)),
      acceleration: qs('toolsSamAudioAcceleration') ? qs('toolsSamAudioAcceleration').value : 'balanced',
      max_chunk_duration: Math.max(10, Math.min(60, Number(qs('toolsSamAudioMaxChunkDuration') ? qs('toolsSamAudioMaxChunkDuration').value : 60) || 60)),
      chunk_overlap: Math.max(0, Math.min(30, Number(qs('toolsSamAudioChunkOverlap') ? qs('toolsSamAudioChunkOverlap').value : 5) || 0)),
      output_format: qs('toolsSamAudioOutputFormat') ? qs('toolsSamAudioOutputFormat').value : 'wav',
    };

    if (prompt) body.prompt = prompt;

    if (isSpanMode) {
      const spans = collectToolsSamAudioSpans();
      if (!spans.length) throw new Error(toolsUiText('tools_sam_audio_error_spans', 'Add at least one valid span.'));
      body.spans = spans;
      body.use_sound_activity_ranking = !!(qs('toolsSamAudioUseSoundActivityRanking') && qs('toolsSamAudioUseSoundActivityRanking').checked);
      body.trim_to_span = !!(qs('toolsSamAudioTrimToSpan') && qs('toolsSamAudioTrimToSpan').checked);
      if (!prompt && !body.use_sound_activity_ranking && body.reranking_candidates > 1) {
        body.reranking_candidates = 1;
      }
    } else {
      body.predict_spans = !!(qs('toolsSamAudioPredictSpans') && qs('toolsSamAudioPredictSpans').checked);
    }

    const samRes = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!samRes.ok) throw await createResponseError(samRes, 'SAM Audio separation failed');
    return await samRes.json();
  }

  if (task && task.toolsTool === 'heygen-translate') {
    const videoSource = getToolsUtilityVideoSource();
    const videoUrl = await resolveUploadItemUrl(videoSource, 'tools-heygen-video', task);
    if (!videoUrl) throw new Error(window.I18N ? I18N.t('upload_video') : 'Upload video');

    const outputLanguage = qs('toolsHeygenOutputLanguage')
      ? String(qs('toolsHeygenOutputLanguage').value || '').trim()
      : HEYGEN_TRANSLATE_DEFAULT_LANGUAGE;
    if (!outputLanguage) throw new Error(toolsUiText('tools_heygen_error_language', 'Select a target language.'));

    const speakerValue = qs('toolsHeygenSpeakerNum') ? String(qs('toolsHeygenSpeakerNum').value || '').trim() : '';
    const body = {
      model_id: TOOLS_TOOL_MODEL_IDS['heygen-translate'],
      video_url: videoUrl,
      output_language: outputLanguage,
      translate_audio_only: !!(qs('toolsHeygenTranslateAudioOnly') && qs('toolsHeygenTranslateAudioOnly').checked),
      enable_dynamic_duration: !(qs('toolsHeygenEnableDynamicDuration') && !qs('toolsHeygenEnableDynamicDuration').checked),
    };
    if (speakerValue) {
      const speakerNum = Math.max(1, Math.round(Number(speakerValue) || 1));
      body.speaker_num = speakerNum;
    }

    const heygenRes = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!heygenRes.ok) throw await createResponseError(heygenRes, 'Heygen translation failed');
    return await heygenRes.json();
  }

  const modelId = qs('toolsModel') ? qs('toolsModel').value : DEFAULT_TOOLS_MODEL;
  const isNano2 = modelId === 'nano-banana-2' || modelId === 'nano-banana-2/edit';
  const isGpt = GPT_IMAGE_EDIT_MODEL_IDS.has(modelId);
  const isGpt15 = modelId === GPT_IMAGE_15_EDIT_MODEL_ID;
  const body = { model_id: modelId, prompt: task.prompt };

  const imageUrls = await resolveUploadItemKieInputs(uploadedToolsImages, 'tools-ref', task);
  const fontPresetSources = getFontPresetSources();
  const fontPresetUrls = await resolveUploadItemKieInputs(fontPresetSources, 'tools-font-preset', task);
  const presetSources = getInspoPresetSources();
  const presetUrls = await resolveUploadItemKieInputs(presetSources, 'tools-inspo-preset', task);
  imageUrls.push(...fontPresetUrls);
  imageUrls.push(...presetUrls);
  for (const f of uploadedInspoImages) {
    const u = await resolveUploadItemKieInput(f, 'tools-inspo', task);
    if (u) imageUrls.push(u);
  }
  if (imageUrls.length > 0) body.image_urls = imageUrls;

  if (!isGpt) {
    const resolution = qs('toolsResolution') ? qs('toolsResolution').value : '2K';
    if (resolution) body.resolution = resolution;
  }

  if (!isGpt) {
    const aspectRatio = qs('toolsAspectRatio') ? qs('toolsAspectRatio').value : '3:4';
    if (aspectRatio) body.aspect_ratio = aspectRatio;

    const outputFormat = qs('toolsOutputFormat') ? qs('toolsOutputFormat').value : 'png';
    if (outputFormat) body.output_format = outputFormat;
  } else {
    const imageSize = buildGptImageSizePayload('toolsGptImageSize', 'toolsGptImageWidth', 'toolsGptImageHeight', 'toolsGptCustomSizeHint', modelId);
    if (imageSize) body.image_size = imageSize;

    const quality = qs('toolsGptQuality') ? qs('toolsGptQuality').value : 'high';
    if (quality) body.quality = quality;

    const outputFormat = qs('toolsGptOutputFormat') ? qs('toolsGptOutputFormat').value : 'png';
    if (outputFormat) body.output_format = outputFormat;

    if (isGpt15) {
      const background = qs('toolsGptBackground') ? qs('toolsGptBackground').value : 'auto';
      if (background) body.background = background;

      const fidelity = qs('toolsGptFidelity') ? qs('toolsGptFidelity').value : 'high';
      if (fidelity) body.input_fidelity = fidelity;
    }
  }

  if (!isGpt) {
    const webSearch = qs('toolsWebSearch') ? qs('toolsWebSearch').value : 'false';
    if (webSearch === 'true') body.enable_web_search = true;
  }

  if (isNano2) {
    const googleSearch = qs('toolsGoogleSearch') ? qs('toolsGoogleSearch').value : 'false';
    if (googleSearch === 'true') body.enable_google_search = true;

    const seed = qs('toolsSeed') ? String(qs('toolsSeed').value || '').trim() : '';
    if (seed) body.seed = Number(seed);
  }

  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await createResponseError(res, 'Image generation failed');
  return await res.json();
}

// ---- PROFESSIONAL IMAGE EDITOR ----
let SK = {
  ctx: null, canvas: null, tool: 'move', drawing: false, imgIndex: -1,
  history: [], redoStack: [], startPos: null, shapePreview: null,
  zoom: 1, bgImage: null, drawCanvas: null, drawCtx: null,
  layerVisible: { background: true, drawing: true },
  textOverlays: [], selectedTextId: null, dragTextOffset: null,
  textBold: false, textItalic: false, textIdCounter: 0,
  sourceArray: null, updateFn: null,
  layers: [], activeLayerId: null, layerCounter: 0,
};

async function openSketchEditor(imageIndex, sourceArr, updateFn) {
  SK.imgIndex = imageIndex;
  SK.sourceArray = sourceArr || uploadedToolsImages;
  SK.updateFn = updateFn || updateToolsImagePreview;
  const sourceItem = SK.sourceArray[imageIndex];
  if (!sourceItem) return;
  const modal = qs('sketchModal');
  if (!modal) return;
  modal.style.display = 'flex';
  SK.textOverlays = []; SK.selectedTextId = null;
  SK.textBold = false; SK.textItalic = false; SK.textIdCounter = 0;
  SK.zoom = 1; SK.redoStack = [];

  const canvas = qs('sketchCanvas');
  if (!canvas) return;
  let file = sourceItem;
  try {
    file = await ensureFileLikeAssetItem(sourceItem);
  } catch (error) {
    console.error('Failed to load asset for sketch editor', error);
    closeSketchEditor();
    showToast(getI18nText('drop_fetch_asset_failed', 'Failed to load the dragged asset.'), 'error');
    return;
  }
  const img = new Image();
  const imgUrl = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(imgUrl);
    const maxW = 1200, maxH = 900;
    let w = img.naturalWidth, h = img.naturalHeight;
    if (w > maxW) { h = h * maxW / w; w = maxW; }
    if (h > maxH) { w = w * maxH / h; h = maxH; }
    canvas.width = Math.round(w); canvas.height = Math.round(h);
    SK.ctx = canvas.getContext('2d'); SK.canvas = canvas;
    SK.bgImage = img;
    SK.drawCanvas = document.createElement('canvas');
    SK.drawCanvas.width = canvas.width;
    SK.drawCanvas.height = canvas.height;
    SK.drawCtx = SK.drawCanvas.getContext('2d');
    SK.layerVisible = { background: true };
    SK.layerCounter = 1;
    SK.layers = [{ id: 'layer-1', name: 'Drawing', canvas: SK.drawCanvas, ctx: SK.drawCtx, visible: true }];
    SK.activeLayerId = 'layer-1';
    SK.history = [skSnapshotLayers()]; SK.drawing = false;
    SK.startPos = null; SK.shapePreview = null;
    skSetTool('move');
    skSetupEvents(canvas);
    skSetupZoom();
    skSetupKeyboard();
    skRedrawCanvas();
    _skApplyZoom();
    skUpdateZoomLabel();
    skRenderTextOverlays();
    skRenderTextList();
    skRenderLayersPanel();
    skUpdatePropsBar();
    // Size/opacity listeners
    const sizeR = qs('sketchSize'); const sizeV = qs('skSizeVal');
    if (sizeR && sizeV) { sizeR.oninput = () => { sizeV.textContent = sizeR.value; }; }
    const opR = qs('sketchOpacity'); const opV = qs('skOpacityVal');
    if (opR && opV) { opR.oninput = () => { opV.textContent = opR.value + '%'; }; }
  };
  img.src = imgUrl;
  requestAnimationFrame(() => { if (window.lucide) window.lucide.createIcons(); });
}
window.openSketchEditor = openSketchEditor;

// --- Snapshot all layer canvases for history ---
function skSnapshotLayers() {
  return SK.layers.map(l => ({ id: l.id, data: l.canvas.toDataURL() }));
}

// --- Apply current SK.zoom to canvas and text overlay DOM ---
function _skApplyZoom() {
  const wrap = qs('skCanvasWrap');
  const canvas = SK.canvas;
  if (!wrap || !canvas) return;
  const z = SK.zoom;
  canvas.style.transformOrigin = '0 0';
  canvas.style.transform = `scale(${z})`;
  const overlays = qs('skTextOverlays');
  if (overlays) {
    overlays.style.transformOrigin = '0 0';
    overlays.style.transform = `scale(${z})`;
    overlays.style.width = canvas.width + 'px';
    overlays.style.height = canvas.height + 'px';
  }
  // Set wrap dimensions = natural size * zoom so the scroller knows how big to scroll
  wrap.style.width = (canvas.width * z) + 'px';
  wrap.style.height = (canvas.height * z) + 'px';
}

// --- Apply zoom by a factor, keeping focalScrollX/Y fixed on screen ---
function skZoomBy(factor, focalScrollX, focalScrollY) {
  const sc = qs('skCanvasScroller');
  const oldZoom = SK.zoom;
  SK.zoom = Math.max(0.08, Math.min(12, SK.zoom * factor));
  _skApplyZoom();
  if (sc && focalScrollX != null) {
    sc.scrollLeft = focalScrollX * (SK.zoom / oldZoom) - (focalScrollX - sc.scrollLeft);
    sc.scrollTop  = focalScrollY * (SK.zoom / oldZoom) - (focalScrollY - sc.scrollTop);
  }
  skUpdateZoomLabel();
}
window.skZoomBy = skZoomBy;

// --- Attach wheel (trackpad pinch) + two-touch pinch zoom to canvas scroller ---
function skSetupZoom() {
  const sc = qs('skCanvasScroller') || qs('skCanvasArea');
  if (!sc || sc._skZoomReady) return;
  sc._skZoomReady = true;

  // Wheel: ctrl/meta = pinch-zoom; plain = pass through (scroll naturally)
  sc.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = sc.getBoundingClientRect();
      const fx = e.clientX - rect.left + sc.scrollLeft;
      const fy = e.clientY - rect.top  + sc.scrollTop;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      skZoomBy(factor, fx, fy);
    }
  }, { passive: false });

  // Two-finger touch pinch
  let _pinch = null;
  sc.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const t0 = e.touches[0], t1 = e.touches[1];
      _pinch = {
        dist: Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY),
        zoom: SK.zoom,
        midX: (t0.clientX + t1.clientX) / 2,
        midY: (t0.clientY + t1.clientY) / 2,
        scrollX: sc.scrollLeft,
        scrollY: sc.scrollTop,
      };
      e.preventDefault();
    }
  }, { passive: false });

  sc.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && _pinch) {
      e.preventDefault();
      const t0 = e.touches[0], t1 = e.touches[1];
      const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      const newZoom = Math.max(0.08, Math.min(12, _pinch.zoom * (dist / _pinch.dist)));
      const rect = sc.getBoundingClientRect();
      const curMidX = (t0.clientX + t1.clientX) / 2 - rect.left;
      const curMidY = (t0.clientY + t1.clientY) / 2 - rect.top;
      const focalX = _pinch.scrollX + (_pinch.midX - rect.left);
      const focalY = _pinch.scrollY + (_pinch.midY - rect.top);
      const oldZoom = SK.zoom;
      SK.zoom = newZoom;
      _skApplyZoom();
      sc.scrollLeft = focalX * (SK.zoom / _pinch.zoom) - curMidX;
      sc.scrollTop  = focalY * (SK.zoom / _pinch.zoom) - curMidY;
      skUpdateZoomLabel();
    }
  }, { passive: false });

  sc.addEventListener('touchend',   () => { _pinch = null; });
  sc.addEventListener('touchcancel',() => { _pinch = null; });
}

// --- Layer management ---
function skRenderLayersPanel() {
  const list = qs('skLayersList');
  if (!list) return;
  list.innerHTML = '';

  // Background row (non-drawable, always at bottom of stack)
  const bgRow = document.createElement('div');
  bgRow.className = 'sk-layer';
  bgRow.style.opacity = '0.65';
  bgRow.innerHTML = `<button class="sk-layer-vis" title="Toggle background"><i data-lucide="${SK.layerVisible.background !== false ? 'eye' : 'eye-off'}"></i></button><span class="sk-layer-name">Background</span><span class="sk-layer-type">BG</span>`;
  bgRow.querySelector('.sk-layer-vis').onclick = (e) => {
    e.stopPropagation();
    SK.layerVisible.background = !SK.layerVisible.background;
    skRenderLayersPanel();
    skRedrawCanvas();
  };
  list.appendChild(bgRow);

  // Drawing layers — top layer shown first
  [...SK.layers].reverse().forEach(layer => {
    const row = document.createElement('div');
    row.className = 'sk-layer' + (layer.id === SK.activeLayerId ? ' sk-layer-active' : '');
    row.innerHTML = `<button class="sk-layer-vis" title="Toggle visibility"><i data-lucide="${layer.visible !== false ? 'eye' : 'eye-off'}"></i></button><span class="sk-layer-name">${layer.name}</span>${SK.layers.length > 1 ? `<button class="sk-layer-del" title="Delete"><i data-lucide="trash-2"></i></button>` : ''}`;
    row.querySelector('.sk-layer-vis').onclick = (e) => {
      e.stopPropagation();
      layer.visible = layer.visible === false ? true : false;
      skRenderLayersPanel();
      skRedrawCanvas();
    };
    const del = row.querySelector('.sk-layer-del');
    if (del) del.onclick = (e) => { e.stopPropagation(); skDeleteLayer(layer.id); };
    row.onclick = (e) => {
      if (e.target.closest('.sk-layer-vis') || e.target.closest('.sk-layer-del')) return;
      skSelectLayer(layer.id);
    };
    list.appendChild(row);
  });
  requestAnimationFrame(() => { if (window.lucide) window.lucide.createIcons(); });
}

function skSelectLayer(id) {
  SK.activeLayerId = id;
  const layer = SK.layers.find(l => l.id === id);
  if (layer) {
    // Keep SK.drawCtx / SK.drawCanvas pointing to active layer for backwards compat
    SK.drawCtx = layer.ctx;
    SK.drawCanvas = layer.canvas;
  }
  skRenderLayersPanel();
}
window.skSelectLayer = skSelectLayer;

function skAddLayer() {
  if (!SK.canvas) return;
  SK.layerCounter++;
  const nc = document.createElement('canvas');
  nc.width = SK.canvas.width; nc.height = SK.canvas.height;
  const nctx = nc.getContext('2d');
  const layer = { id: 'layer-' + SK.layerCounter, name: 'Layer ' + SK.layerCounter, canvas: nc, ctx: nctx, visible: true };
  SK.layers.push(layer);
  skSelectLayer(layer.id);
  skPushHistory();
  showToast('Layer added', 'info');
}
window.skAddLayer = skAddLayer;

function skDeleteLayer(id) {
  if (SK.layers.length <= 1) return;
  const idx = SK.layers.findIndex(l => l.id === id);
  if (idx === -1) return;
  SK.layers.splice(idx, 1);
  if (SK.activeLayerId === id) {
    skSelectLayer(SK.layers[Math.min(idx, SK.layers.length - 1)].id);
  } else {
    skRenderLayersPanel();
  }
  skPushHistory();
  skRedrawCanvas();
}
window.skDeleteLayer = skDeleteLayer;

function skToggleLayersPanel() {
  const panel = qs('skRightPanel');
  if (panel) panel.classList.toggle('sk-panel-open');
}
window.skToggleLayersPanel = skToggleLayersPanel;

// --- Keyboard shortcuts ---
let _skKbReady = false;
function skSetupKeyboard() {
  if (_skKbReady) return;
  _skKbReady = true;
  document.addEventListener('keydown', (e) => {
    const modal = qs('sketchModal');
    if (!modal || modal.style.display === 'none') return;
    const tag = (e.target || {}).tagName || '';
    const inInput = /^(INPUT|TEXTAREA|SELECT)$/i.test(tag);
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); sketchUndo(); return; }
      if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); sketchRedo(); return; }
      if (e.key === '=' || e.key === '+') { e.preventDefault(); skZoom(1); return; }
      if (e.key === '-') { e.preventDefault(); skZoom(-1); return; }
      if (e.key === '0') { e.preventDefault(); skZoom(0); return; }
    }
    if (e.key === 'Escape') { closeSketchEditor(); return; }
    if (e.key === 'Delete' && SK.selectedTextId && !inInput) {
      skRemoveTextOverlay(SK.selectedTextId); return;
    }
    if (!e.ctrlKey && !e.metaKey && !inInput) {
      const map = { v:'move', p:'pen', e:'eraser', r:'rect', c:'circle', l:'line', t:'text', a:'arrow', s:'select' };
      if (map[e.key]) skSetTool(map[e.key]);
    }
  });
}

function closeSketchEditor() {
  const modal = qs('sketchModal');
  if (modal) modal.style.display = 'none';
  SK.ctx = null; SK.canvas = null; SK.history = []; SK.redoStack = [];
  SK.drawCanvas = null; SK.drawCtx = null; SK.bgImage = null;
  SK.shapePreview = null; SK.startPos = null;
  SK.textOverlays = []; SK.selectedTextId = null;
  SK.layers = []; SK.activeLayerId = null;
  SK.zoom = 1;
  // Reset scroller position
  const sc = qs('skCanvasScroller'); if (sc) { sc.scrollLeft = 0; sc.scrollTop = 0; }
  const wrap = qs('skCanvasWrap'); if (wrap) { wrap.style.width = ''; wrap.style.height = ''; }
}
window.closeSketchEditor = closeSketchEditor;

function skSetTool(tool) {
  SK.tool = tool;
  document.querySelectorAll('.sk-tool[data-sktool]').forEach(b => {
    b.classList.toggle('active', b.dataset.sktool === tool);
  });
  const c = SK.canvas;
  if (c) {
    const cursors = { move:'default', pen:'crosshair', eraser:'crosshair', line:'crosshair',
      rect:'crosshair', circle:'crosshair', arrow:'crosshair', text:'text',
      select:'crosshair', eyedropper:'crosshair' };
    c.style.cursor = cursors[tool] || 'crosshair';
  }
  skUpdatePropsBar();
}

function skUpdateLayerButtonIcon(btn, visible) {
  if (!btn) return;
  btn.classList.toggle('sk-vis-off', !visible);
  btn.innerHTML = `<i data-lucide="${visible ? 'eye' : 'eye-off'}"></i>`;
  if (window.lucide) window.lucide.createIcons();
}
// Toolbar click delegation
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.sk-tool[data-sktool]');
  if (btn) { e.preventDefault(); skSetTool(btn.dataset.sktool); }
  // (layer visibility now handled inline in skRenderLayersPanel)
});

function skUpdatePropsBar() {
  const drawProps = qs('skPropsBar');
  const textProps = qs('skTextPropsBar');
  if (!drawProps || !textProps) return;
  const isText = SK.tool === 'text';
  drawProps.style.display = isText ? 'none' : '';
  textProps.style.display = isText ? '' : 'none';
}


function sketchUndo() {
  if (SK.history.length <= 1) return;
  SK.redoStack.push(SK.history.pop());
  skRestoreFromHistory(SK.history[SK.history.length - 1]);
}
window.sketchUndo = sketchUndo;

function sketchRedo() {
  if (SK.redoStack.length === 0) return;
  const snap = SK.redoStack.pop();
  SK.history.push(snap);
  skRestoreFromHistory(snap);
}
window.sketchRedo = sketchRedo;

function skRestoreFromHistory(snap) {
  if (!snap || !SK.drawCanvas) return;
  if (typeof snap === 'string') {
    // Legacy single-string format
    const img = new Image();
    img.onload = () => { if(SK.drawCtx){SK.drawCtx.clearRect(0,0,SK.drawCanvas.width,SK.drawCanvas.height); SK.drawCtx.drawImage(img,0,0);} skRedrawCanvas(); };
    img.src = snap; return;
  }
  // Multi-layer format: [{id, data}, ...]
  let done = 0; const total = snap.length;
  if (total === 0) { skRedrawCanvas(); return; }
  snap.forEach(s => {
    const layer = SK.layers.find(l => l.id === s.id);
    if (!layer) { done++; if (done === total) skRedrawCanvas(); return; }
    const img = new Image();
    img.onload = () => {
      layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      layer.ctx.drawImage(img, 0, 0);
      done++; if (done === total) skRedrawCanvas();
    };
    img.src = s.data;
  });
}

function skPushHistory() {
  if (!SK.drawCanvas) return;
  SK.redoStack = [];
  SK.history.push(skSnapshotLayers());
}

function sketchClear() {
  if (!SK.drawCanvas) return;
  SK.layers.forEach(layer => {
    if (layer.ctx) layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  });
  SK.history = [skSnapshotLayers()];
  SK.redoStack = [];
  SK.shapePreview = null;
  skRedrawCanvas();
}
window.sketchClear = sketchClear;

function skRedrawCanvas() {
  if (!SK.canvas || !SK.ctx) return;
  const c = SK.canvas, ctx = SK.ctx;
  ctx.clearRect(0, 0, c.width, c.height);
  if (SK.layerVisible.background && SK.bgImage) {
    ctx.drawImage(SK.bgImage, 0, 0, c.width, c.height);
  }
  // Draw all drawing layers in order (bottom to top)
  SK.layers.forEach(layer => {
    if (layer.visible !== false && layer.canvas) {
      ctx.drawImage(layer.canvas, 0, 0);
    }
  });

  // Live preview overlays for selection and shape tools
  if (SK.drawing && SK.shapePreview) {
    if (SK.shapePreview.type === 'select') {
      const { x, y, w, h } = SK.shapePreview;
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    } else if (SK.shapePreview.from && SK.shapePreview.to) {
      const color = qs('sketchColor')?.value || '#ff0000';
      const size = Number(qs('sketchSize')?.value || 4);
      const opacity = Number(qs('sketchOpacity')?.value || 100) / 100;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = size;
      ctx.lineCap = 'round';
      ctx.globalAlpha = opacity;
      skDrawShape(ctx, SK.shapePreview.type, SK.shapePreview.from, SK.shapePreview.to, size);
      ctx.restore();
    }
  }
}

function saveSketch() {
  if (!SK.canvas) return;
  const out = document.createElement('canvas');
  out.width = SK.canvas.width;
  out.height = SK.canvas.height;
  const ctx = out.getContext('2d');
  if (!ctx) return;

  if (SK.layerVisible.background && SK.bgImage) {
    ctx.drawImage(SK.bgImage, 0, 0, out.width, out.height);
  }
  // Composite all visible drawing layers
  SK.layers.forEach(layer => {
    if (layer.visible !== false && layer.canvas) {
      ctx.drawImage(layer.canvas, 0, 0);
    }
  });

  SK.textOverlays.forEach(t => {
    const weight = t.bold ? 'bold' : 'normal';
    const style = t.italic ? 'italic' : 'normal';
    ctx.save();
    ctx.font = `${style} ${weight} ${t.size}px "${t.font}"`;
    ctx.fillStyle = t.color;
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'top';
    // Convert overlay position from % to canvas pixels
    const cx = (t.xPct / 100) * out.width;
    const cy = (t.yPct / 100) * out.height;
    ctx.fillText(t.text, cx, cy);
    ctx.restore();
  });
  out.toBlob((blob) => {
    if (!blob) return;
    const file = new File([blob], `edited-${Date.now()}.png`, { type: 'image/png' });
    const arr = SK.sourceArray || uploadedToolsImages;
    const upd = SK.updateFn || updateToolsImagePreview;
    if (SK.imgIndex >= 0 && SK.imgIndex < arr.length) {
      arr[SK.imgIndex] = file;
    } else {
      arr.push(file);
    }
    window._lastEditorTextOverlays = SK.textOverlays.map(t => ({ text: t.text, font: t.font }));
    upd();
    closeSketchEditor();
    showToast(window.I18N ? I18N.t('toast_sketch_saved') : 'Image saved', 'info');
  }, 'image/png');
}
window.saveSketch = saveSketch;

// --- Zoom ---
function skZoom(dir) {
  if (dir === 0) { SK.zoom = 1; }
  else if (dir > 0) { SK.zoom = Math.min(SK.zoom * 1.25, 12); }
  else { SK.zoom = Math.max(SK.zoom / 1.25, 0.08); }
  _skApplyZoom();
  skUpdateZoomLabel();
}
window.skZoom = skZoom;
function skUpdateZoomLabel() {
  const el = qs('skZoomLabel');
  if (el) el.textContent = Math.round(SK.zoom * 100) + '%';
}

// --- Text Overlays ---
function skAddTextOverlay(x, y) {
  SK.textIdCounter++;
  const id = 'sktxt-' + SK.textIdCounter;
  const font = qs('skTextFont') ? qs('skTextFont').value : 'Arial';
  const size = qs('skTextSize') ? Number(qs('skTextSize').value) : 36;
  const color = qs('skTextColor') ? qs('skTextColor').value : '#ffffff';
  const xPct = x != null ? x : 10;
  const yPct = y != null ? y : 10;
  const overlay = { id, text: 'Text', font, size, color, bold: SK.textBold, italic: SK.textItalic, xPct, yPct };
  SK.textOverlays.push(overlay);
  SK.selectedTextId = id;
  skRenderTextOverlays();
  skRenderTextList();
  // Prompt edit
  setTimeout(() => {
    const el = document.getElementById(id);
    if (el) { skStartInlineEdit(el, overlay); }
  }, 50);
}
window.skAddTextOverlay = skAddTextOverlay;

function skRemoveTextOverlay(id) {
  SK.textOverlays = SK.textOverlays.filter(t => t.id !== id);
  if (SK.selectedTextId === id) SK.selectedTextId = null;
  skRenderTextOverlays();
  skRenderTextList();
}
window.skRemoveTextOverlay = skRemoveTextOverlay;

function skRenderTextOverlays() {
  const container = qs('skTextOverlays');
  if (!container || !SK.canvas) return;
  container.innerHTML = '';
  SK.textOverlays.forEach(t => {
    const div = document.createElement('div');
    div.className = 'sk-text-overlay' + (t.id === SK.selectedTextId ? ' sk-text-selected' : '');
    div.id = t.id;
    div.style.left = t.xPct + '%'; div.style.top = t.yPct + '%';
    const weight = t.bold ? 'bold' : 'normal';
    const style = t.italic ? 'italic' : 'normal';
    div.style.font = `${style} ${weight} ${t.size}px "${t.font}"`;
    div.style.color = t.color;
    div.textContent = t.text;
    div.ondblclick = (e) => { e.stopPropagation(); skStartInlineEdit(div, t); };
    div.onmousedown = (e) => { if (SK.tool === 'move' || SK.tool === 'text') skStartDragText(e, t); };
    div.ontouchstart = (e) => { if (SK.tool === 'move' || SK.tool === 'text') skStartDragText(e, t); };
    container.appendChild(div);
  });
}

function skStartInlineEdit(el, overlay) {
  SK.selectedTextId = overlay.id;
  skRenderTextList();
  const input = document.createElement('input');
  input.type = 'text'; input.value = overlay.text;
  input.className = 'sk-inline-edit';
  input.style.cssText = `position:absolute;left:${overlay.xPct}%;top:${overlay.yPct}%;font:${el.style.font};color:${overlay.color};background:rgba(0,0,0,0.6);border:1px solid var(--accent-bright);border-radius:3px;padding:2px 4px;outline:none;z-index:5;pointer-events:all;min-width:60px;`;
  const container = qs('skTextOverlays');
  el.style.display = 'none';
  container.appendChild(input);
  input.focus(); input.select();
  const finish = () => {
    overlay.text = input.value || 'Text';
    input.remove();
    skRenderTextOverlays();
    skRenderTextList();
  };
  input.onblur = finish;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(); } };
}

function skStartDragText(e, overlay) {
  e.preventDefault(); e.stopPropagation();
  SK.selectedTextId = overlay.id;
  skRenderTextOverlays();
  skRenderTextList();
  const container = qs('skTextOverlays');
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const cx = e.touches ? e.touches[0].clientX : e.clientX;
  const cy = e.touches ? e.touches[0].clientY : e.clientY;
  const startXPct = overlay.xPct, startYPct = overlay.yPct;
  const startCx = cx, startCy = cy;
  const onMove = (ev) => {
    const mx = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const my = ev.touches ? ev.touches[0].clientY : ev.clientY;
    const dx = ((mx - startCx) / rect.width) * 100;
    const dy = ((my - startCy) / rect.height) * 100;
    overlay.xPct = Math.max(0, Math.min(95, startXPct + dx));
    overlay.yPct = Math.max(0, Math.min(95, startYPct + dy));
    const el = document.getElementById(overlay.id);
    if (el) { el.style.left = overlay.xPct + '%'; el.style.top = overlay.yPct + '%'; }
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp);
}

function skRenderTextList() {
  const list = qs('skTextList');
  if (!list) return;
  if (SK.textOverlays.length === 0) {
    list.innerHTML = '<div class="sk-text-empty">Click + or use Text tool to add text</div>';
    return;
  }
  list.innerHTML = '';
  SK.textOverlays.forEach(t => {
    const item = document.createElement('div');
    item.className = 'sk-text-item' + (t.id === SK.selectedTextId ? ' sk-text-item-active' : '');
    item.innerHTML = `<span class="sk-text-item-preview">"${t.text}"</span><span class="sk-text-item-font">${t.font}</span><button class="sk-text-item-del" onclick="skRemoveTextOverlay('${t.id}')"><i data-lucide="x"></i></button>`;
    item.onclick = (e) => {
      if (e.target.closest('.sk-text-item-del')) return;
      SK.selectedTextId = t.id;
      skRenderTextOverlays(); skRenderTextList();
    };
    list.appendChild(item);
  });
  requestAnimationFrame(() => { if (window.lucide) window.lucide.createIcons(); });
}

function skToggleBold() {
  SK.textBold = !SK.textBold;
  const btn = qs('skTextBold');
  if (btn) btn.classList.toggle('active', SK.textBold);
  if (SK.selectedTextId) {
    const t = SK.textOverlays.find(o => o.id === SK.selectedTextId);
    if (t) { t.bold = SK.textBold; skRenderTextOverlays(); }
  }
}
window.skToggleBold = skToggleBold;

function skToggleItalic() {
  SK.textItalic = !SK.textItalic;
  const btn = qs('skTextItalic');
  if (btn) btn.classList.toggle('active', SK.textItalic);
  if (SK.selectedTextId) {
    const t = SK.textOverlays.find(o => o.id === SK.selectedTextId);
    if (t) { t.italic = SK.textItalic; skRenderTextOverlays(); }
  }
}
window.skToggleItalic = skToggleItalic;

// --- Canvas Event Setup ---
function skSetupEvents(canvas) {
  const c = canvas.cloneNode(true);
  c.id = 'sketchCanvas';
  canvas.parentNode.replaceChild(c, canvas);
  SK.ctx = c.getContext('2d'); SK.canvas = c;
  skRedrawCanvas();

  const getPos = (e) => {
    const rect = c.getBoundingClientRect();
    const sx = c.width / rect.width, sy = c.height / rect.height;
    const touch = e.touches && e.touches[0] ? e.touches[0] : (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : null);
    const cx = touch ? touch.clientX : e.clientX;
    const cy = touch ? touch.clientY : e.clientY;
    return { x: (cx - rect.left) * sx, y: (cy - rect.top) * sy };
  };

  const getPctPos = (e) => {
    const container = qs('skTextOverlays');
    if (!container) return { xPct: 10, yPct: 10 };
    const rect = container.getBoundingClientRect();
    const touch = e.touches && e.touches[0] ? e.touches[0] : (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : null);
    const cx = touch ? touch.clientX : e.clientX;
    const cy = touch ? touch.clientY : e.clientY;
    return { xPct: ((cx - rect.left) / rect.width) * 100, yPct: ((cy - rect.top) / rect.height) * 100 };
  };

  const getColor = () => qs('sketchColor')?.value || '#ff0000';
  const getSize = () => Number(qs('sketchSize')?.value || 4);
  const getOpacity = () => Number(qs('sketchOpacity')?.value || 100) / 100;

  const startDraw = (e) => {
    if (SK.tool === 'move') return;
    if (SK.tool === 'text') {
      e.preventDefault();
      const p = getPctPos(e);
      skAddTextOverlay(p.xPct, p.yPct);
      return;
    }
    if (SK.tool === 'eyedropper') {
      e.preventDefault();
      const pos = getPos(e);
      const px = SK.ctx.getImageData(Math.round(pos.x), Math.round(pos.y), 1, 1).data;
      const hex = '#' + [px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, '0')).join('');
      const ci = qs('sketchColor'); if (ci) ci.value = hex;
      return;
    }
    e.preventDefault();
    SK.drawing = true;
    const pos = getPos(e);
    SK.startPos = pos;
    SK.shapePreview = null;

    if (SK.tool === 'select') {
      SK.shapePreview = { type: 'select', x: pos.x, y: pos.y, w: 0, h: 0 };
      skRedrawCanvas();
      return;
    }
    if (['line', 'rect', 'circle', 'arrow'].includes(SK.tool)) {
      SK.shapePreview = { type: SK.tool, from: pos, to: pos };
      skRedrawCanvas();
      return;
    }

    const dctx = SK.drawCtx;
    if (!dctx) return;
    dctx.beginPath();
    dctx.moveTo(pos.x, pos.y);
    dctx.lineWidth = getSize();
    dctx.lineCap = 'round';
    dctx.lineJoin = 'round';
    dctx.globalAlpha = getOpacity();
    if (SK.tool === 'eraser') {
      dctx.globalCompositeOperation = 'destination-out';
      dctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      dctx.globalCompositeOperation = 'source-over';
      dctx.strokeStyle = getColor();
    }
  };

  const moveDraw = (e) => {
    if (!SK.drawing || SK.tool === 'move') return;
    e.preventDefault();
    const pos = getPos(e);

    // Select area preview
    if (SK.tool === 'select' && SK.startPos) {
      const x = Math.min(SK.startPos.x, pos.x);
      const y = Math.min(SK.startPos.y, pos.y);
      const w = Math.abs(pos.x - SK.startPos.x);
      const h = Math.abs(pos.y - SK.startPos.y);
      SK.shapePreview = { type: 'select', x, y, w, h };
      skRedrawCanvas();
      return;
    }

    // Shape preview (line/rect/circle/arrow)
    if (['line', 'rect', 'circle', 'arrow'].includes(SK.tool) && SK.startPos) {
      SK.shapePreview = { type: SK.tool, from: SK.startPos, to: pos };
      skRedrawCanvas();
      return;
    }

    // Pen/eraser continuous stroke
    if (!SK.drawCtx) return;
    SK.drawCtx.lineTo(pos.x, pos.y);
    SK.drawCtx.stroke();
    skRedrawCanvas();
  };

  const endDraw = (e) => {
    if (!SK.drawing) return;
    SK.drawing = false;
    const pos = e && (e.changedTouches || e.clientX !== undefined) ? getPos(e) : SK.startPos;

    // Select: fill white on drawing layer
    if (SK.tool === 'select' && SK.shapePreview && SK.drawCtx) {
      const { x, y, w, h } = SK.shapePreview;
      SK.drawCtx.save();
      SK.drawCtx.globalCompositeOperation = 'source-over';
      SK.drawCtx.globalAlpha = 1;
      SK.drawCtx.fillStyle = '#ffffff';
      SK.drawCtx.fillRect(x, y, w, h);
      SK.drawCtx.restore();
      SK.startPos = null;
      SK.shapePreview = null;
      skPushHistory();
      skRedrawCanvas();
      return;
    }

    // Shapes: commit
    if (['line', 'rect', 'circle', 'arrow'].includes(SK.tool) && SK.startPos && pos && SK.drawCtx) {
      SK.drawCtx.save();
      SK.drawCtx.globalCompositeOperation = 'source-over';
      SK.drawCtx.strokeStyle = getColor();
      SK.drawCtx.fillStyle = getColor();
      SK.drawCtx.lineWidth = getSize();
      SK.drawCtx.lineCap = 'round';
      SK.drawCtx.globalAlpha = getOpacity();
      skDrawShape(SK.drawCtx, SK.tool, SK.startPos, pos, getSize());
      SK.drawCtx.restore();
      SK.startPos = null;
      SK.shapePreview = null;
      skPushHistory();
      skRedrawCanvas();
      return;
    }

    // Pen/eraser: commit
    if (SK.drawCtx) {
      SK.drawCtx.globalCompositeOperation = 'source-over';
      SK.drawCtx.globalAlpha = 1;
    }
    SK.startPos = null;
    SK.shapePreview = null;
    skPushHistory();
    skRedrawCanvas();
  };

  c.addEventListener('mousedown', startDraw);
  c.addEventListener('mousemove', moveDraw);
  c.addEventListener('mouseup', endDraw);
  c.addEventListener('mouseleave', endDraw);
  // Only handle single-touch; two-finger events are for pinch zoom
  c.addEventListener('touchstart', (e) => { if (e.touches.length === 1) startDraw(e); }, { passive: false });
  c.addEventListener('touchmove',  (e) => { if (e.touches.length === 1) moveDraw(e); else if (SK.drawing) { SK.drawing = false; skPushHistory(); skRedrawCanvas(); } }, { passive: false });
  c.addEventListener('touchend', endDraw);
  c.addEventListener('touchcancel', endDraw);
}

function skDrawShape(ctx, tool, from, to, size) {
  if (tool === 'line') {
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  } else if (tool === 'rect') {
    const x = Math.min(from.x, to.x), y = Math.min(from.y, to.y);
    const w = Math.abs(to.x - from.x), h = Math.abs(to.y - from.y);
    ctx.strokeRect(x, y, w, h);
  } else if (tool === 'circle') {
    const cx = (from.x + to.x) / 2, cy = (from.y + to.y) / 2;
    const rx = Math.abs(to.x - from.x) / 2, ry = Math.abs(to.y - from.y) / 2;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  } else if (tool === 'arrow') {
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    // Arrowhead
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const headLen = size * 3;
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - headLen * Math.cos(angle - Math.PI / 6), to.y - headLen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - headLen * Math.cos(angle + Math.PI / 6), to.y - headLen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  }
}

// --- Get editor text overlays for prompt ---
function skGetTextOverlaysForPrompt() {
  const overlays = window._lastEditorTextOverlays || [];
  if (overlays.length === 0) return '';
  return overlays.map(t => `"${t.text}" (font: ${t.font})`).join(', ');
}

function onMediaModalBackdropClick(e) {
  if (!e || !e.target) return;
  if (e.target.id === 'mediaModal') closeMediaModal();
}
window.onMediaModalBackdropClick = onMediaModalBackdropClick;

function openMediaModal(item) {
  const modal = qs('mediaModal');
  const body = qs('mediaModalBody');
  const title = qs('mediaModalTitle');
  const dl = qs('mediaModalDownload');
  if (!modal || !body || !title) return;

  currentPreview = item;
  body.innerHTML = '';

  title.textContent = (item && item.prompt) ? item.prompt : (item.type === 'video' ? 'Video' : (item.type === 'audio' ? 'Audio' : (item.type === '3d' ? '3D Model' : 'Image')));

  const hasUrl = item && (item.url || item.glbUrl || item.modelDownloadUrl);
  if (dl) {
    dl.style.display = hasUrl ? 'inline-flex' : 'none';
    if (item && item.type === '3d') {
      const dlUrl3d = item.modelDownloadUrl || item.glbUrl;
      const dlExt3d = item.modelFormat || 'glb';
      dl.dataset.dlUrl = dlUrl3d;
      dl.dataset.dlName = `model-${item.timestamp || Date.now()}.${dlExt3d}`;
    } else if (item && item.type === 'video') {
      dl.dataset.dlUrl = item.url;
      dl.dataset.dlName = `generation-${item.timestamp || Date.now()}.mp4`;
    } else if (item && item.type === 'audio') {
      const ext = deriveFilenameFromUrl(item.url || '', (item.meta && item.meta.outputFormat) || 'wav').split('.').pop() || 'wav';
      dl.dataset.dlUrl = item.url;
      dl.dataset.dlName = `generation-${item.timestamp || Date.now()}.${ext}`;
    } else if (item) {
      dl.dataset.dlUrl = item.url;
      dl.dataset.dlName = `generation-${item.timestamp || Date.now()}.png`;
    }
  }
  const modalAssetBtn = qs('mediaModalUseAsset');
  if (modalAssetBtn) modalAssetBtn.style.display = hasUrl ? 'inline-flex' : 'none';
  const modalReuseBtn = qs('mediaModalReuse');
  if (modalReuseBtn) modalReuseBtn.style.display = (item.genCtx || item.prompt) ? 'inline-flex' : 'none';

  if (item.type === 'video') {
    const v = document.createElement('video');
    v.controls = true;
    v.playsInline = true;
    v.src = item.url;
    body.appendChild(v);
  } else if (item.type === 'audio') {
    const wrap = document.createElement('div');
    wrap.className = 'result-audio-grid';

    const targetCard = document.createElement('div');
    targetCard.className = 'result-audio-card';
    targetCard.innerHTML = `<div class="result-audio-card-title"><i data-lucide="audio-lines"></i><span>${escapeHtml(toolsUiText('tools_sam_audio_result_target', 'Isolated Target'))}</span></div>`;
    const targetAudio = document.createElement('audio');
    targetAudio.controls = true;
    targetAudio.preload = 'metadata';
    targetAudio.src = item.url;
    targetAudio.className = 'result-audio-player';
    targetCard.appendChild(targetAudio);
    wrap.appendChild(targetCard);

    const residualUrl = item.residualUrl || (item.meta && (item.meta.residualUrl || item.meta.originalResidualUrl)) || '';
    if (residualUrl) {
      const residualCard = document.createElement('div');
      residualCard.className = 'result-audio-card';
      residualCard.innerHTML = `<div class="result-audio-card-title"><i data-lucide="waves"></i><span>${escapeHtml(toolsUiText('tools_sam_audio_result_residual', 'Residual Mix'))}</span></div>`;
      const residualAudio = document.createElement('audio');
      residualAudio.controls = true;
      residualAudio.preload = 'metadata';
      residualAudio.src = residualUrl;
      residualAudio.className = 'result-audio-player';
      residualCard.appendChild(residualAudio);
      wrap.appendChild(residualCard);
    }
    body.appendChild(wrap);
  } else if (item.type === '3d' && item.glbUrl) {
    const mv = document.createElement('model-viewer');
    mv.setAttribute('camera-controls', '');
    mv.setAttribute('auto-rotate', '');
    mv.setAttribute('rotation-per-second', '20deg');
    mv.setAttribute('shadow-intensity', '1');
    mv.setAttribute('exposure', '1.2');
    mv.setAttribute('environment-image', 'neutral');
    mv.setAttribute('tone-mapping', 'commerce');
    if (item.thumbUrl || item.url) mv.setAttribute('poster', item.thumbUrl || item.url);
    mv.setAttribute('loading', 'eager');
    mv.src = item.glbUrl;
    body.appendChild(mv);
  } else if (item.type === '3d') {
    // OBJ-only: show thumbnail image
    const img = document.createElement('img');
    img.src = item.url || '';
    img.alt = '3D Model (OBJ)';
    body.appendChild(img);
  } else {
    const img = document.createElement('img');
    img.src = item.url;
    body.appendChild(img);
  }

  bindAssetDragSource(body, item);
  const modalMedia = body.querySelector('img, video, audio');
  if (modalMedia) bindAssetDragSource(modalMedia, item, { badge: false });

  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function closeMediaModal() {
  closeAssetMenu();
  const modal = qs('mediaModal');
  const body = qs('mediaModalBody');
  const dl = qs('mediaModalDownload');
  const modalAssetBtn = qs('mediaModalUseAsset');
  const modalReuseBtn = qs('mediaModalReuse');
  if (body) {
    bindAssetDragSource(body, null);
    body.innerHTML = '';
  }
  if (dl) dl.style.display = 'none';
  if (modalAssetBtn) modalAssetBtn.style.display = 'none';
  if (modalReuseBtn) modalReuseBtn.style.display = 'none';
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
}

window.closeMediaModal = closeMediaModal;

window.addEventListener('keydown', (e) => {
  if (e && e.key === 'Escape') {
    const modal = qs('mediaModal');
    if (modal && modal.style.display && modal.style.display !== 'none') {
      closeMediaModal();
    }
  }
});

// Inline SVG icons for history items — avoids expensive global lucide.createIcons() scan
const _historyIcons = {
  play: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>',
  audio: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6v12"></path><path d="M8 8v8"></path><path d="M16 8v8"></path><path d="M4 10v4"></path><path d="M20 10v4"></path></svg>',
  box: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"></path><path d="m3.3 7 8.7 5 8.7-5"></path><path d="M12 22V12"></path></svg>',
  image: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path></svg>',
  'repeat-2': '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 9 3-3 3 3"></path><path d="M13 18H7a2 2 0 0 1-2-2V6"></path><path d="m22 15-3 3-3-3"></path><path d="M11 6h6a2 2 0 0 1 2 2v10"></path></svg>',
  'package-plus': '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16h6"></path><path d="M19 13v6"></path><path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14"></path><path d="m7.5 4.27 9 5.15"></path><polyline points="3.29 7 12 12 20.71 7"></polyline><line x1="12" x2="12" y1="22" y2="12"></line></svg>',
  download: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" x2="12" y1="15" y2="3"></line></svg>',
  'trash-2': '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path><line x1="10" x2="10" y1="11" y2="17"></line><line x1="14" x2="14" y1="11" y2="17"></line></svg>',
};
function _hIcon(name) { return _historyIcons[name] || ''; }

// Debounce helper for performance
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const MAX_HISTORY_RENDER = 100; // cap rendered items for performance
const HISTORY_SEARCH_DEBOUNCE_MS = 140;
let _historyControlsBound = false;
let _historySearchInputHandler = null;

function getHistoryFilterConfig(filterId = historyViewState.type) {
  return HISTORY_FILTERS.find((filter) => filter.id === filterId) || HISTORY_FILTERS[0];
}

function getHistoryPromptText(item) {
  return item && item.prompt ? String(item.prompt).trim() : '';
}

function getHistoryFallbackLabel(item) {
  if (item && item.type === 'video') return i18nText('opt_video', 'Video');
  if (item && item.type === 'audio') return i18nText('opt_audio', 'Audio');
  if (item && item.type === '3d') return i18nText('tab_3d', '3D');
  return i18nText('opt_image', 'Image');
}

// Get appropriate thumbnail for history item — prefer small thumbnailUrl over full-res url
function getHistoryThumb(item) {
  const meta = item && item.meta && typeof item.meta === 'object' ? item.meta : null;
  if (item.type === 'video') {
    return pickHistoryPreviewCandidate(item, [
      item.thumbnailUrl,
      meta && meta.thumbnail_fallback,
      meta && meta.previewUrl,
    ]) || `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect fill="#1a1a2e" width="64" height="64" rx="8"/><polygon fill="#fff" points="26,20 26,44 46,32"/></svg>')}`;
  }
  if (item.type === 'audio') {
    return pickHistoryPreviewCandidate(item, [
      item.thumbnailUrl,
      meta && meta.previewUrl,
      meta && meta.thumbnail_fallback,
    ]) || createAudioPlaceholderDataUrl('AUDIO');
  }
  if (item.type === '3d') {
    return pickHistoryPreviewCandidate(item, [
      item.thumbnailUrl,
      meta && meta.thumbnail_fallback,
      meta && meta.previewUrl,
      meta && meta.placeholderUrl,
      item.url,
    ]) || `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect fill="#1a1a2e" width="64" height="64" rx="8"/><path fill="#fff" d="M32 16L48 26V42L32 52L16 42V26L32 16Z" stroke="#fff" stroke-width="2" fill="none"/></svg>')}`;
  }
  return pickHistoryPreviewCandidate(item, [
    item.thumbnailUrl,
    meta && meta.thumbnail_fallback,
    meta && meta.previewUrl,
  ]) || item.url || `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect fill="#1a1a2e" width="64" height="64" rx="8"/><path fill="#fff" d="M15 45L26 31L34 39L43 28L52 45H15Z" opacity="0.9"/><circle cx="24" cy="21" r="5" fill="#fff" opacity="0.95"/></svg>')}`;
}

function updateHistoryClearButtons() {
  const disabled = historyClearInFlight || !Array.isArray(history) || history.length === 0;
  ['historyClearAllBtn', 'fhgClearAllBtn'].forEach((id) => {
    const btn = qs(id);
    if (!btn) return;
    btn.disabled = disabled;
    btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  });
}

function getHistoryQueryTerms(query) {
  return String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
}

function matchesHistoryFilter(item, filterId) {
  const filter = getHistoryFilterConfig(filterId);
  return !filter.types || filter.types.includes(item.type);
}

function isHistoryViewFiltered() {
  return getHistoryFilterConfig().id !== HISTORY_FILTERS[0].id || getHistoryQueryTerms(historyViewState.query).length > 0;
}

function getFilteredHistoryItems() {
  const terms = getHistoryQueryTerms(historyViewState.query);

  return history.reduce((items, item, index) => {
    if (!item) return items;
    if (!matchesHistoryFilter(item, historyViewState.type)) return items;

    if (terms.length > 0) {
      const prompt = getHistoryPromptText(item).toLowerCase();
      if (!terms.every((term) => prompt.includes(term))) return items;
    }

    items.push({ item, index });
    return items;
  }, []);
}

const historyThumbnailPendingKeys = new Set();
const historyThumbnailQueue = [];
let historyThumbnailTimer = null;
let historyThumbnailRunning = false;
let historyClearInFlight = false;

function queueHistoryThumbnailForItem(item, index = 0) {
  if (!canGenerateClientHistoryThumbnail(item)) return;
  const key = getHistoryIdentityKey(item, index);
  if (!key || historyThumbnailPendingKeys.has(key)) return;
  historyThumbnailPendingKeys.add(key);
  historyThumbnailQueue.push({ item, key });
  if (!historyThumbnailTimer && !historyThumbnailRunning) {
    historyThumbnailTimer = setTimeout(processHistoryThumbnailQueue, 60);
  }
}

function queueVisibleHistoryThumbnails(entries) {
  (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    if (!entry || !entry.item) return;
    queueHistoryThumbnailForItem(entry.item, Number.isFinite(Number(entry.index)) ? Number(entry.index) : index);
  });
}

async function processHistoryThumbnailQueue() {
  historyThumbnailTimer = null;
  if (shouldSkipClientHistoryThumbnailWork()) return;
  if (historyThumbnailRunning) return;
  historyThumbnailRunning = true;
  let changed = false;
  let processed = 0;
  const maxPerPass = isPrimaryCoarsePointer() ? 1 : 2;

  while (historyThumbnailQueue.length > 0 && processed < maxPerPass) {
    const work = historyThumbnailQueue.shift();
    if (!work || !work.item) continue;
    const { item, key } = work;
    try {
      let thumb = null;
      if (item.type === 'video') {
        thumb = await generateVideoThumbnail(item.url);
      } else if (item.type === 'image') {
        thumb = await generateImageThumbnail(item.url);
      }
      if (thumb && !hasUsableHistoryPreview(item)) {
        item.thumbnailUrl = thumb;
        changed = true;
      }
    } catch (_) {
      // Ignore thumbnail generation failures and keep the lightweight placeholder.
    } finally {
      historyThumbnailPendingKeys.delete(key);
    }
    processed += 1;
  }

  historyThumbnailRunning = false;
  if (changed) {
    _pendingHistorySave = true;
    debouncedSaveHistory();
    scheduleHistoryUIUpdate();
    if (_fhgState.open) renderFhgGallery();
  }
  if (historyThumbnailQueue.length > 0 && !historyThumbnailTimer) {
    historyThumbnailTimer = setTimeout(processHistoryThumbnailQueue, 90);
  }
}

function setHistoryHydrating(loading) {
  const next = !!loading;
  if (historyHydrating === next) return;
  historyHydrating = next;
  scheduleHistoryUIUpdate();
  if (_fhgState.open) renderFhgGallery();
}

function appendHistoryMetaLoading(text) {
  if (!historyHydrating) return text;
  const loadingText = i18nText('history_syncing', 'Syncing history...');
  return text ? `${text} · ${loadingText}` : loadingText;
}
function updateHistorySearchUi(inputValue = null) {
  const searchInput = qs('historySearchInput');
  const clearBtn = qs('historySearchClear');
  const rawValue = inputValue !== null ? String(inputValue) : (searchInput ? searchInput.value : String(historyViewState.query || ''));

  if (searchInput && inputValue === null && searchInput.value !== historyViewState.query) {
    searchInput.value = historyViewState.query || '';
  }
  if (clearBtn) clearBtn.hidden = rawValue.length === 0;
}

function updateHistoryFilterUi() {
  const filterBar = qs('historyFilterBar');
  if (!filterBar) return;

  const activeId = getHistoryFilterConfig().id;
  filterBar.querySelectorAll('[data-history-filter]').forEach((btn) => {
    const isActive = btn.dataset.historyFilter === activeId;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function clearHistorySearch(shouldFocus = false) {
  const searchInput = qs('historySearchInput');
  if (searchInput) searchInput.value = '';
  historyViewState.query = '';
  updateHistorySearchUi('');
  if (_historyRendered) updateHistoryUI();
  if (shouldFocus && searchInput) searchInput.focus();
}

function initHistoryControls() {
  if (_historyControlsBound) return;

  const searchInput = qs('historySearchInput');
  const clearBtn = qs('historySearchClear');
  const filterBar = qs('historyFilterBar');
  if (!searchInput || !clearBtn || !filterBar) return;

  if (!_historySearchInputHandler) {
    _historySearchInputHandler = debounce(() => {
      historyViewState.query = searchInput.value || '';
      if (_historyRendered) updateHistoryUI();
    }, HISTORY_SEARCH_DEBOUNCE_MS);
  }

  searchInput.addEventListener('input', () => {
    updateHistorySearchUi(searchInput.value || '');
    _historySearchInputHandler();
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && searchInput.value) {
      event.preventDefault();
      clearHistorySearch(true);
    }
  });

  clearBtn.addEventListener('click', () => clearHistorySearch(true));

  filterBar.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-history-filter]');
    if (!btn) return;

    const nextFilter = getHistoryFilterConfig(btn.dataset.historyFilter).id;
    if (historyViewState.type === nextFilter) return;

    historyViewState.type = nextFilter;
    updateHistoryUI();
  });

  _historyControlsBound = true;
  updateHistoryFilterUi();
  updateHistorySearchUi();
}

function formatHistoryMeta(totalCount, shownCount) {
  if (totalCount === 0 && !isHistoryViewFiltered()) return '';

  if (isHistoryViewFiltered()) {
    if (totalCount > shownCount) {
      return i18nText('history_results_matches_capped', 'Showing {shown} of {count} matches')
        .replace('{shown}', shownCount)
        .replace('{count}', totalCount);
    }
    return i18nText('history_results_matches', '{count} matches').replace('{count}', totalCount);
  }

  if (history.length > shownCount) {
    return i18nText('history_results_total_capped', 'Showing {shown} of {count} items')
      .replace('{shown}', shownCount)
      .replace('{count}', history.length);
  }

  return i18nText('history_results_total', '{count} items').replace('{count}', history.length);
}

function updateHistoryEmptyState(emptyEl, textEl, message) {
  if (textEl) textEl.textContent = message;
  emptyEl.style.display = 'flex';
}

function updateHistoryUI() {
  const list = qs('historyList');
  const empty = qs('emptyHistory');
  const emptyText = qs('emptyHistoryText');
  const meta = qs('historyResultsMeta');
  const searchInput = qs('historySearchInput');
  if (!list || !empty || !emptyText || !meta) return;
  updateHistoryClearButtons();

  if (searchInput && searchInput.value !== historyViewState.query) {
    historyViewState.query = searchInput.value || '';
  }

  updateHistoryFilterUi();
  updateHistorySearchUi();

  if (!history || history.length === 0) {
    list.innerHTML = '';
    meta.textContent = appendHistoryMetaLoading('');
    updateHistoryEmptyState(
      empty,
      emptyText,
      historyHydrating
        ? i18nText('history_loading', 'Loading history...')
        : i18nText('history_empty', 'No creations yet')
    );
    return;
  }

  const filteredHistory = getFilteredHistoryItems();
  const renderItems = filteredHistory.slice(0, MAX_HISTORY_RENDER);
  meta.textContent = appendHistoryMetaLoading(formatHistoryMeta(filteredHistory.length, renderItems.length));

  if (filteredHistory.length === 0) {
    list.innerHTML = '';
    updateHistoryEmptyState(empty, emptyText, i18nText('history_empty_filtered', 'No history items match the current search or filter'));
    return;
  }

  empty.style.display = 'none';

  // Build HTML string — much faster than N createElement + innerHTML calls
  const parts = [];
  for (const entry of renderItems) {
    const item = entry.item;
    const idx = entry.index;
    const icon = item.type === 'video' ? 'play' : (item.type === 'audio' ? 'audio' : (item.type === '3d' ? 'box' : 'image'));
    const thumbSrc = getHistoryThumb(item);
    const promptText = getHistoryPromptText(item) || getHistoryFallbackLabel(item);
    const timeText = item && item.timestamp
      ? new Date(item.timestamp).toLocaleTimeString(window.I18N ? I18N.lang : undefined)
      : '';

    parts.push(`<div class="history-item" data-index="${idx}"><div class="history-content"><div class="history-thumb-wrap"><img src="${escapeHtml(thumbSrc)}" class="history-thumb" loading="lazy" decoding="async" fetchpriority="low" draggable="false" alt=""><div class="history-icon">${_hIcon(icon)}</div></div><div class="history-info"><div class="history-prompt">${escapeHtml(promptText)}</div><div class="history-time">${escapeHtml(timeText)}</div></div></div><div class="history-actions"><button class="history-action-btn" data-action="reuse" title="Reuse Prompt & Settings">${_hIcon('repeat-2')}</button><button class="history-action-btn" data-action="use-asset" title="Use as Asset">${_hIcon('package-plus')}</button><button class="history-action-btn" data-action="download" title="Download">${_hIcon('download')}</button><button class="history-action-btn history-action-btn--danger" data-action="delete" title="Delete">${_hIcon('trash-2')}</button></div></div>`);
  }

  list.innerHTML = parts.join('');

  // Single event listener for all history items (event delegation)
  list.onclick = handleHistoryClick;
  list.querySelectorAll('.history-thumb-wrap').forEach((thumb) => {
    const itemEl = thumb.closest('.history-item');
    const idx = itemEl ? Number(itemEl.dataset.index) : -1;
    bindAssetDragSource(thumb, idx >= 0 ? history[idx] : null, {
      onDragStart: closeHistoryDrawerDuringNativeDrag,
      onDragEnd: finalizeHistoryDrawerAfterNativeDrag,
      onTouchDragStart: closeHistoryDrawerDuringTouchDrag,
    });
  });
  queueVisibleHistoryThumbnails(renderItems);

  // No lucide.createIcons() needed — all icons are inline SVGs
}

function handleHistoryClick(e) {
  const actionBtn = e.target.closest('.history-action-btn');
  const historyItem = e.target.closest('.history-item');

  if (!historyItem) return;

  const idx = parseInt(historyItem.dataset.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= history.length) return;

  if (actionBtn) {
    e.stopPropagation();
    const action = actionBtn.dataset.action;
    if (action === 'reuse') {
      e.stopPropagation();
      reuseFromHistory(idx);
    } else if (action === 'use-asset') {
      e.stopPropagation();
      useHistoryAsAsset(idx, actionBtn);
    } else if (action === 'download') {
      downloadFromHistory(idx, e);
    } else if (action === 'delete') {
      deleteFromHistory(idx, e);
    }
    return;
  }

  // Click on item itself - display it
  const item = history[idx];
  if (!item) return;

  exitWizFullscreen();
  galleryItems = [item];
  galleryIndex = 0;
  currentPreview = item;
  displayResult(item);

  // Close drawer on mobile
  const drawer = qs('historyDrawer');
  const overlay = qs('drawerOverlay');
  if (drawer && window.innerWidth <= 900) {
    drawer.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
  }
}

function addToHistory(item) {
  ensureHistoryItemIdentity(item);
  history.unshift(item);
  queueHistoryThumbnailForItem(item, 0);
  saveHistory();
  scheduleHistoryUIUpdate();
  queueAccountHistoryPersist(item);
}

function createTaskHistoryItemId(task, suffix) {
  const taskId = task && task.id ? String(task.id) : createHistoryClientId();
  const safeSuffix = suffix ? String(suffix) : 'output';
  return `task_${taskId}_${safeSuffix}`;
}

function buildTaskHistoryItem(task, type, url, options = {}) {
  const suffix = options.suffix || (type === '3d' ? '3d' : 'output');
  const meta = options.meta && typeof options.meta === 'object' ? { ...options.meta } : {};
  meta.clientId = meta.clientId || createTaskHistoryItemId(task, suffix);
  meta.taskId = meta.taskId || (task && task.id ? String(task.id) : null);
  if (Number.isFinite(Number(options.outputIndex))) meta.outputIndex = Number(options.outputIndex);
  return {
    id: meta.clientId,
    type,
    url,
    prompt: task && task.prompt ? task.prompt : '',
    timestamp: Number.isFinite(Number(options.timestamp)) ? Number(options.timestamp) : Date.now(),
    genCtx: task && task.genCtx ? task.genCtx : null,
    meta,
  };
}

// ===== FULLSCREEN HISTORY GALLERY =====
let _fhgState = { filter: 'all', query: '', open: false, searchHandler: null };

function openFullHistory() {
  const el = qs('fullHistoryGallery');
  if (!el) return;

  // Close the side drawer first
  const drawer = qs('historyDrawer');
  const overlay = qs('drawerOverlay');
  if (drawer) drawer.classList.remove('open');
  if (overlay) overlay.classList.remove('open');

  _fhgState.open = true;
  _fhgState.filter = 'all';
  _fhgState.query = '';
  _fhgFirstRender = true;
  el.style.display = 'flex';
  el.classList.remove('fhg-closing');
  document.body.style.overflow = 'hidden';
  const grid = qs('fhgGrid');
  if (grid) grid.classList.remove('fhg-no-anim');

  // Reset search input and filter buttons
  const searchInput = qs('fhgSearchInput');
  if (searchInput) searchInput.value = '';
  const filterBar = qs('fhgFilterBar');
  if (filterBar) {
    filterBar.querySelectorAll('.fhg-filter').forEach(b => b.classList.toggle('active', b.dataset.fhgFilter === 'all'));
  }

  // Re-apply i18n to gallery elements
  if (window.I18N && typeof I18N.t === 'function') {
    el.querySelectorAll('[data-i18n]').forEach(e => { e.textContent = I18N.t(e.dataset.i18n); });
    el.querySelectorAll('[data-i18n-placeholder]').forEach(e => { e.placeholder = I18N.t(e.dataset.i18nPlaceholder); });
  }

  initFhgControls();
  renderFhgGallery();

  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    requestAnimationFrame(() => window.lucide.createIcons({ nameAttr: 'data-lucide' }));
  }
}
window.openFullHistory = openFullHistory;

function closeFullHistory() {
  const el = qs('fullHistoryGallery');
  if (!el) return;
  _fhgState.open = false;
  el.classList.add('fhg-closing');
  document.body.style.overflow = '';
  setTimeout(() => {
    el.style.display = 'none';
    el.classList.remove('fhg-closing');
  }, 300);
}
window.closeFullHistory = closeFullHistory;

let _fhgControlsBound = false;
function initFhgControls() {
  if (_fhgControlsBound) return;
  const searchInput = qs('fhgSearchInput');
  const filterBar = qs('fhgFilterBar');

  if (searchInput) {
    _fhgState.searchHandler = debounce(() => {
      _fhgState.query = searchInput.value || '';
      renderFhgGallery();
    }, 160);
    searchInput.addEventListener('input', _fhgState.searchHandler);
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && searchInput.value) {
        e.preventDefault();
        e.stopPropagation();
        searchInput.value = '';
        _fhgState.query = '';
        renderFhgGallery();
      }
    });
  }

  if (filterBar) {
    filterBar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-fhg-filter]');
      if (!btn) return;
      const next = btn.dataset.fhgFilter;
      if (_fhgState.filter === next) return;
      _fhgState.filter = next;
      filterBar.querySelectorAll('.fhg-filter').forEach(b => b.classList.toggle('active', b.dataset.fhgFilter === next));
      renderFhgGallery();
    });
  }

  _fhgControlsBound = true;
}

function getFhgFilteredItems() {
  const terms = _fhgState.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return history.reduce((out, item, index) => {
    if (!item) return out;
    if (!matchesHistoryFilter(item, _fhgState.filter)) return out;
    if (terms.length > 0) {
      const prompt = getHistoryPromptText(item).toLowerCase();
      if (!terms.every(t => prompt.includes(t))) return out;
    }
    out.push({ item, index });
    return out;
  }, []);
}

let _fhgFirstRender = true;

function renderFhgGallery() {
  const grid = qs('fhgGrid');
  const empty = qs('fhgEmpty');
  const meta = qs('fhgMeta');
  if (!grid) return;
  updateHistoryClearButtons();

  // Skip animations on filter/search updates (not the first open)
  const skipAnim = !_fhgFirstRender;
  if (skipAnim) grid.classList.add('fhg-no-anim');

  const filtered = getFhgFilteredItems();
  const maxItems = 200;
  const items = filtered.slice(0, maxItems);

  if (meta) {
    if (filtered.length === 0 && history.length === 0) {
      meta.textContent = appendHistoryMetaLoading('');
    } else if (filtered.length > maxItems) {
      meta.textContent = appendHistoryMetaLoading((i18nText('history_results_matches_capped', 'Showing {shown} of {count} matches') || 'Showing {shown} of {count}')
        .replace('{shown}', maxItems).replace('{count}', filtered.length));
    } else {
      meta.textContent = appendHistoryMetaLoading((i18nText('history_results_total', '{count} items') || '{count} items')
        .replace('{count}', filtered.length));
    }
  }

  if (items.length === 0) {
    grid.innerHTML = '';
    if (empty) {
      empty.style.display = 'flex';
      if (window.lucide && typeof window.lucide.createIcons === 'function') {
        requestAnimationFrame(() => window.lucide.createIcons({ nameAttr: 'data-lucide' }));
      }
    }
    _fhgFirstRender = false;
    return;
  }

  if (empty) empty.style.display = 'none';

  const parts = [];
  for (const entry of items) {
    const item = entry.item;
    const idx = entry.index;
    const icon = item.type === 'video' ? 'play' : (item.type === 'audio' ? 'audio' : (item.type === '3d' ? 'box' : 'image'));
    const thumbSrc = getHistoryThumb(item);
    const promptText = getHistoryPromptText(item) || getHistoryFallbackLabel(item);
    const timeText = item && item.timestamp
      ? new Date(item.timestamp).toLocaleString(window.I18N ? I18N.lang : undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';

    parts.push(
      `<div class="fhg-card" data-index="${idx}">` +
        `<img class="fhg-card-img" src="${escapeHtml(thumbSrc)}" loading="lazy" decoding="async" fetchpriority="low" alt="">` +
        `<div class="fhg-card-type">${_hIcon(icon)}</div>` +
        `<div class="fhg-card-actions">` +
          `<button class="fhg-card-action" data-action="download" title="Download">${_hIcon('download')}</button>` +
          `<button class="fhg-card-action fhg-card-action--danger" data-action="delete" title="Delete">${_hIcon('trash-2')}</button>` +
        `</div>` +
        `<div class="fhg-card-info">` +
          `<div class="fhg-card-prompt">${escapeHtml(promptText)}</div>` +
          `<div class="fhg-card-time">${escapeHtml(timeText)}</div>` +
        `</div>` +
      `</div>`
    );
  }

  grid.innerHTML = parts.join('');
  grid.onclick = handleFhgClick;
  queueVisibleHistoryThumbnails(items);
  _fhgFirstRender = false;
}

function handleFhgClick(e) {
  const actionBtn = e.target.closest('.fhg-card-action');
  const card = e.target.closest('.fhg-card');
  if (!card) return;

  const idx = parseInt(card.dataset.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= history.length) return;

  if (actionBtn) {
    e.stopPropagation();
    const action = actionBtn.dataset.action;
    if (action === 'download') {
      downloadFromHistory(idx, e);
    } else if (action === 'delete') {
      deleteFromHistory(idx, e);
      renderFhgGallery();
    }
    return;
  }

  // Click on card: show it and close gallery
  const item = history[idx];
  if (!item) return;
  exitWizFullscreen();
  galleryItems = [item];
  galleryIndex = 0;
  currentPreview = item;
  displayResult(item);
  closeFullHistory();
}

// Escape key closes fullscreen gallery
const _origKeydownForFhg = window.addEventListener('keydown', function _fhgEsc(e) {
  if (e.key === 'Escape' && _fhgState.open) {
    const searchInput = qs('fhgSearchInput');
    if (searchInput && searchInput.value) return; // let search clear handler handle it
    closeFullHistory();
  }
}, true);

// Silent version: adds to array without triggering save/UI (for batch inserts)
function addToHistorySilent(item) {
  ensureHistoryItemIdentity(item);
  history.unshift(item);
  queueHistoryThumbnailForItem(item, 0);
}

// Debounced history save — coalesces multiple thumbnail saves into one write
let _pendingHistorySave = false;
let _historySaveTimer = null;
function debouncedSaveHistory() {
  if (_historySaveTimer) return;
  _historySaveTimer = setTimeout(() => {
    _historySaveTimer = null;
    if (_pendingHistorySave) {
      _pendingHistorySave = false;
      saveHistory();
    }
  }, 500);
}

// Debounced history UI refresh — prevents cascade of full DOM rebuilds
let _historyUITimer = null;
function scheduleHistoryUIUpdate() {
  // If drawer hasn't been opened yet, just mark it dirty so next open rebuilds
  if (!_historyRendered) return;
  if (_historyUITimer) return; // already scheduled
  _historyUITimer = requestAnimationFrame(() => {
    _historyUITimer = null;
    updateHistoryUI();
  });
}

function deleteFromHistory(index, event) {
  event.stopPropagation();
  const removed = history[index] || null;
  history.splice(index, 1);
  saveHistory();
  updateHistoryUI();
  if (removed) queueAccountHistoryDelete(removed);
}
window.deleteFromHistory = deleteFromHistory;

async function clearAllHistory(event) {
  if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
  if (historyClearInFlight) return;
  if (!Array.isArray(history) || history.length === 0) return;

  const confirmText = i18nText('history_clear_all_confirm', 'Remove all history items? This cannot be undone.');
  if (!window.confirm(confirmText)) return;

  const previousHistory = history.slice();
  historyClearInFlight = true;
  history = [];
  saveHistory();
  scheduleHistoryUIUpdate();
  if (_fhgState.open) renderFhgGallery();
  updateHistoryClearButtons();

  try {
    const bridge = window.NanoAccountBridge || null;
    if (bridge && typeof bridge.clearHistory === 'function') {
      await bridge.clearHistory();
    }
    showToast(i18nText('toast_history_cleared', 'History cleared'));
  } catch (error) {
    console.error('clear history failed', error);
    history = previousHistory;
    saveHistory();
    scheduleHistoryUIUpdate();
    if (_fhgState.open) renderFhgGallery();
    showToast((i18nText('toast_history_clear_failed', 'Failed to clear history: ') || 'Failed to clear history: ') + (error && error.message ? error.message : error), 'error');
  } finally {
    historyClearInFlight = false;
    updateHistoryClearButtons();
  }
}
window.clearAllHistory = clearAllHistory;

function downloadFromHistory(index, event) {
  event.stopPropagation();
  const item = history[index];
  if (!item) return;
  let url, name;
  if (item.type === '3d') {
    url = item.modelDownloadUrl || item.glbUrl;
    const ext = item.modelFormat || 'glb';
    name = `model-${item.timestamp || Date.now()}.${ext}`;
  } else if (item.type === 'video') {
    url = item.url;
    name = `generation-${item.timestamp || Date.now()}.mp4`;
  } else if (item.type === 'audio') {
    url = item.url;
    const ext = deriveFilenameFromUrl(item.url || '', (item.meta && item.meta.outputFormat) || 'wav').split('.').pop() || 'wav';
    name = `generation-${item.timestamp || Date.now()}.${ext}`;
  } else {
    url = item.url;
    name = `generation-${item.timestamp || Date.now()}.png`;
  }
  forceDownload(url, name);
}
window.downloadFromHistory = downloadFromHistory;

function renderAudioPreview(item) {
  const pane = qs('resultAudioPane');
  if (!pane) return;
  const meta = item && item.meta && typeof item.meta === 'object' ? item.meta : {};
  const residualUrl = item && (item.residualUrl || meta.residualUrl || meta.originalResidualUrl) ? String(item.residualUrl || meta.residualUrl || meta.originalResidualUrl) : '';
  const duration = Number.isFinite(Number(item && item.duration)) ? Number(item.duration) : (Number.isFinite(Number(meta.duration)) ? Number(meta.duration) : null);
  const sampleRate = Number.isFinite(Number(item && item.sampleRate)) ? Number(item.sampleRate) : (Number.isFinite(Number(meta.sampleRate)) ? Number(meta.sampleRate) : null);
  const outputFormat = (meta.outputFormat || deriveFilenameFromUrl(item && item.url ? item.url : '', 'wav').split('.').pop() || 'wav').toString().toUpperCase();
  const chips = [
    outputFormat,
    duration ? `${duration.toFixed(1)}s` : null,
    sampleRate ? `${sampleRate} Hz` : null,
  ].filter(Boolean);

  pane.innerHTML =
    `<div class="result-audio-grid">` +
      `<div class="result-audio-card">` +
        `<div class="result-audio-card-head">` +
          `<div class="result-audio-card-title"><i data-lucide="audio-lines"></i><span>${escapeHtml(toolsUiText('tools_sam_audio_result_target', 'Isolated Target'))}</span></div>` +
          `<button type="button" class="result-audio-download" data-audio-download="${escapeHtml(item.url || '')}" data-audio-name="${escapeHtml(deriveFilenameFromUrl(item.url || '', 'wav'))}" title="${escapeHtml(getI18nText('download', 'Download'))}"><i data-lucide="download"></i></button>` +
        `</div>` +
        `<audio class="result-audio-player" controls preload="metadata" src="${escapeHtml(item.url || '')}"></audio>` +
        `<div class="result-audio-meta">${chips.map((chip) => `<span class="result-audio-chip">${escapeHtml(chip)}</span>`).join('')}</div>` +
      `</div>` +
      (residualUrl
        ? `<div class="result-audio-card">` +
            `<div class="result-audio-card-head">` +
              `<div class="result-audio-card-title"><i data-lucide="waves"></i><span>${escapeHtml(toolsUiText('tools_sam_audio_result_residual', 'Residual Mix'))}</span></div>` +
              `<button type="button" class="result-audio-download" data-audio-download="${escapeHtml(residualUrl)}" data-audio-name="${escapeHtml(deriveFilenameFromUrl(residualUrl, 'wav'))}" title="${escapeHtml(getI18nText('download', 'Download'))}"><i data-lucide="download"></i></button>` +
            `</div>` +
            `<audio class="result-audio-player" controls preload="metadata" src="${escapeHtml(residualUrl)}"></audio>` +
            `<div class="result-audio-meta"><span class="result-audio-chip">${escapeHtml(toolsUiText('tools_sam_audio_result_residual_hint', 'Everything except the isolated sound'))}</span></div>` +
          `</div>`
        : '') +
    `</div>`;

  pane.querySelectorAll('[data-audio-download]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      forceDownload(btn.dataset.audioDownload, btn.dataset.audioName);
    });
  });
}

function displayResult(item) {
  currentPreview = item;

  const img = qs('resultImage');
  const vid = qs('resultVideo');
  const audioPane = qs('resultAudioPane');
  const model = qs('resultModel');
  const placeholder = qs('placeholder');
  const dl = qs('downloadBtn');

  if (placeholder) placeholder.style.display = 'none';
  const assetBtn = qs('useAsAssetBtn');

  if (item.type === 'video') {
    if (audioPane) { audioPane.style.display = 'none'; audioPane.innerHTML = ''; }
    if (img) img.style.display = 'none';
    if (model) model.style.display = 'none';
    if (vid) {
      vid.style.display = 'block';
      vid.poster = item.thumbnailUrl || '';
      vid.src = item.url;
    }
    if (dl) {
      dl.style.display = 'inline-flex';
      dl.dataset.dlUrl = item.url;
      dl.dataset.dlName = `generation-${item.timestamp || Date.now()}.mp4`;
    }
  } else if (item.type === 'audio') {
    if (vid) { if (typeof vid.pause === 'function') vid.pause(); vid.style.display = 'none'; vid.removeAttribute('src'); vid.removeAttribute('poster'); }
    if (img) img.style.display = 'none';
    if (model) model.style.display = 'none';
    if (audioPane) {
      renderAudioPreview(item);
      audioPane.style.display = 'block';
    }
    if (dl) {
      const ext = deriveFilenameFromUrl(item.url || '', (item.meta && item.meta.outputFormat) || 'wav').split('.').pop() || 'wav';
      dl.style.display = 'inline-flex';
      dl.dataset.dlUrl = item.url;
      dl.dataset.dlName = `generation-${item.timestamp || Date.now()}.${ext}`;
    }
  } else if (item.type === '3d') {
    if (audioPane) { audioPane.style.display = 'none'; audioPane.innerHTML = ''; }
    if (vid) vid.style.display = 'none';
    const dlUrl = item.modelDownloadUrl || item.glbUrl;
    const dlExt = item.modelFormat || 'glb';
    if (item.glbUrl) {
      if (img) img.style.display = 'none';
      if (model) { model.style.display = 'block'; model.src = item.glbUrl; }
    } else {
      // OBJ-only: show thumbnail, hide model-viewer
      if (model) model.style.display = 'none';
      if (img) { img.style.display = 'block'; img.src = item.url || ''; }
    }
    if (dl) {
      dl.style.display = 'inline-flex';
      dl.dataset.dlUrl = dlUrl;
      dl.dataset.dlName = `model-${item.timestamp || Date.now()}.${dlExt}`;
    }
  } else {
    if (audioPane) { audioPane.style.display = 'none'; audioPane.innerHTML = ''; }
    if (vid) vid.style.display = 'none';
    if (model) model.style.display = 'none';
    if (img) {
      img.style.display = 'block';
      img.src = item.url;
    }
    if (dl) {
      dl.style.display = 'inline-flex';
      dl.dataset.dlUrl = item.url;
      dl.dataset.dlName = `generation-${item.timestamp || Date.now()}.png`;
    }
  }

  if (assetBtn) assetBtn.style.display = dl && dl.style.display !== 'none' ? 'inline-flex' : 'none';

  const editBtn = qs('editImageBtn');
  const isImage = item.type === 'image' || (!item.type);
  if (editBtn) editBtn.style.display = isImage ? 'inline-flex' : 'none';

  const previewArea = qs('previewArea');
  if (previewArea) bindAssetDragSource(previewArea, item);
  if (img) bindAssetDragSource(img, item.type === 'image' ? item : null, { badge: false });
  if (vid) bindAssetDragSource(vid, item.type === 'video' ? item : null, { badge: false });
  if (audioPane) bindAssetDragSource(audioPane, item.type === 'audio' ? item : null, { badge: false });

  updateGalleryNav();

  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function setGalleryItems(items) {
  galleryItems = items || [];
  galleryIndex = 0;
  if (galleryItems.length > 0) {
    displayResult(galleryItems[0]);
  }
}

function showGalleryItem(index) {
  if (index < 0 || index >= galleryItems.length) return;
  galleryIndex = index;
  displayResult(galleryItems[galleryIndex]);
}

function galleryPrev() {
  if (galleryIndex > 0) {
    showGalleryItem(galleryIndex - 1);
  }
}

function galleryNext() {
  if (galleryIndex < galleryItems.length - 1) {
    showGalleryItem(galleryIndex + 1);
  }
}

window.galleryPrev = galleryPrev;
window.galleryNext = galleryNext;

function updateGalleryNav() {
  let nav = qs('galleryNav');
  const previewArea = qs('previewArea');
  
  if (galleryItems.length <= 1) {
    if (nav) nav.style.display = 'none';
    return;
  }
  
  if (!nav && previewArea) {
    nav = document.createElement('div');
    nav.id = 'galleryNav';
    nav.className = 'gallery-nav';
    nav.innerHTML = `
      <button class="gallery-nav-btn" onclick="galleryPrev()" id="galleryPrevBtn">
        <i data-lucide="chevron-left"></i>
      </button>
      <span class="gallery-counter" id="galleryCounter">1 / 1</span>
      <button class="gallery-nav-btn" onclick="galleryNext()" id="galleryNextBtn">
        <i data-lucide="chevron-right"></i>
      </button>
    `;
    previewArea.appendChild(nav);
    if (window.lucide) window.lucide.createIcons();
  }
  
  if (nav) {
    nav.style.display = 'flex';
    const counter = qs('galleryCounter');
    const prevBtn = qs('galleryPrevBtn');
    const nextBtn = qs('galleryNextBtn');
    
    if (counter) counter.textContent = `${galleryIndex + 1} / ${galleryItems.length}`;
    if (prevBtn) prevBtn.disabled = galleryIndex === 0;
    if (nextBtn) nextBtn.disabled = galleryIndex === galleryItems.length - 1;
  }
}

const TASK_QUEUE_STALE_MS = 15 * 1000;
const TASK_SUBMITTING_STALE_MS = 8 * 60 * 1000;
const TASK_FAILED_VISIBLE_MS = 15 * 60 * 1000;

function markTaskActivity(task) {
  if (!task || typeof task !== 'object') return;
  task.lastActivityAt = Date.now();
}

function normalizeTasksForDisplay() {
  const now = Date.now();
  let changed = false;
  const seenIds = new Set();
  const nextTasks = [];

  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || !task.id) {
      changed = true;
      continue;
    }
    if (seenIds.has(task.id)) {
      changed = true;
      continue;
    }
    seenIds.add(task.id);

    const age = Math.max(0, now - (task.lastActivityAt || task.startedAt || task.createdAt || now));
    if (task.status === 'QUEUED' && age > TASK_QUEUE_STALE_MS) {
      task.status = 'FAILED';
      task.failedAt = task.failedAt || now;
      task.error = task.error || 'Interrupted - please try again';
      changed = true;
    }
    if (task.status === 'SUBMITTING' && age > TASK_SUBMITTING_STALE_MS) {
      task.status = 'FAILED';
      task.failedAt = task.failedAt || now;
      task.error = task.error || 'Task expired after being active too long. Please try again.';
      changed = true;
    }

    const failedAge = Math.max(0, now - (task.failedAt || task.createdAt || now));
    if (task.status === 'FAILED' && failedAge > TASK_FAILED_VISIBLE_MS) {
      changed = true;
      continue;
    }

    nextTasks.push(task);
  }

  if (changed) {
    tasks = nextTasks;
    saveTasks();
  }
}

function removeTask(taskId) {
  if (pollTimers.has(taskId)) {
    clearTimeout(pollTimers.get(taskId));
    pollTimers.delete(taskId);
  }

  const removedTasks = tasks.filter((t) => t && t.id === taskId);
  if (!removedTasks.length) return;

  tasks = tasks.filter((t) => !t || t.id !== taskId);
  saveTasks();
  renderTasks();

  removedTasks.forEach((task) => {
    if (!task || task.blobCleanupDone) return;
    cleanupTaskUploads(task)
      .then(() => {
        if (task.blobCleanupError) {
          console.warn('Task upload cleanup issue:', task.blobCleanupError);
        }
      })
      .catch((e) => {
        console.warn('Task upload cleanup failed:', e && e.message ? e.message : e);
      });
  });
}
window.removeTask = removeTask;

function renderTasks() {
  const panel = qs('generationsPanel');
  if (!panel) return;

  normalizeTasksForDisplay();

  const active = tasks.filter((t) => t && t.status && t.status !== 'COMPLETED');
  if (active.length === 0) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  panel.style.display = 'block';
  panel.innerHTML = active
    .slice(0, 10)
    .map((t) => {
      const age = Math.max(0, Date.now() - (t.startedAt || t.createdAt || Date.now()));
      const secs = (age / 1000).toFixed(1);
      const status = escapeHtml(getTaskStatusLabel(t.status));
      const prompt = escapeHtml((t.prompt || '').slice(0, 120));
      const errText = formatErrorForDisplay(t.error || '');
      const err = errText ? `<div class="task-error">${escapeHtml(errText)}</div>` : '';
      const isFailed = t.status === 'FAILED';
      const canDismiss = t.status !== 'COMPLETED';
      const actionLabel = isFailed
        ? i18nText('task_action_dismiss', 'Dismiss')
        : i18nText('task_action_cancel', 'Cancel');
      const removeBtn = canDismiss
        ? `<button class="task-remove" onclick="removeTask('${t.id}')" title="${escapeHtml(actionLabel)}" aria-label="${escapeHtml(actionLabel)}">&times;</button>`
        : '';
      return `
        <div class="task-card ${isFailed ? 'task-failed' : 'task-running'}">
          <div class="task-row">
            <div class="task-status-label">${status}</div>
            <div class="task-meta">
              <span class="task-time">${secs}s</span>
              ${removeBtn}
            </div>
          </div>
          <div class="task-prompt">${prompt}</div>
          ${err}
        </div>
      `;
    })
    .join('');
}
async function readFileAsDataUri(file) {
  if (!file) return null;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function generateVideoThumbnail(videoUrl) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'metadata';
    
    video.onloadeddata = () => {
      video.currentTime = 0.1;
    };
    
    video.onseeked = () => {
      try {
        const MAX = 88;
        let w = video.videoWidth || 320, h = video.videoHeight || 180;
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, w, h);
        const thumbnail = canvas.toDataURL('image/jpeg', 0.6);
        resolve(thumbnail);
      } catch (e) {
        resolve(null);
      }
      video.src = '';
      video.load();
    };
    
    video.onerror = () => resolve(null);
    
    setTimeout(() => resolve(null), 8000);
    
    video.src = videoUrl;
    video.load();
  });
}

// Generate a small thumbnail data URI from an image URL (88px max, JPEG)
function generateImageThumbnail(imageUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const MAX = 88; // 2× the 44px display size for retina
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.6));
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    setTimeout(() => resolve(null), 8000);
    img.src = imageUrl;
  });
}

function extractMediaUrl(data, type) {
  if (type === 'video') {
    return (
      (data && data.video && data.video.url) ||
      (Array.isArray(data && data.videos) && data.videos[0] && data.videos[0].url) ||
      null
    );
  }
  return (
    (data && data.image && data.image.url) ||
    (Array.isArray(data && data.images) && data.images[0] && data.images[0].url) ||
    null
  );
}

function extractAllMediaUrls(data, type) {
  const urls = [];
  const pushUnique = (url) => {
    const next = String(url || '').trim();
    if (!next || urls.includes(next)) return;
    urls.push(next);
  };
  if (type === 'video') {
    if (data && data.video && data.video.url) pushUnique(data.video.url);
    if (Array.isArray(data && data.videos)) {
      for (const v of data.videos) {
        if (v && v.url) pushUnique(v.url);
      }
    }
  } else {
    if (data && data.image && data.image.url) pushUnique(data.image.url);
    if (Array.isArray(data && data.images)) {
      for (const img of data.images) {
        if (img && img.url) pushUnique(img.url);
      }
    }
  }
  return urls;
}

function extractSamAudioOutput(data) {
  if (!data || typeof data !== 'object') return null;
  const targetUrl = data && data.target && data.target.url ? String(data.target.url) : '';
  const residualUrl = data && data.residual && data.residual.url ? String(data.residual.url) : '';
  if (!targetUrl) return null;
  return {
    targetUrl,
    residualUrl: residualUrl || null,
    duration: Number.isFinite(Number(data.duration)) ? Number(data.duration) : null,
    sampleRate: Number.isFinite(Number(data.sample_rate)) ? Number(data.sample_rate) : null,
  };
}

function isGlbFile(fileObj) {
  if (!fileObj || !fileObj.url) return false;
  const ct = (fileObj.content_type || '').toLowerCase();
  const fn = (fileObj.file_name || fileObj.url || '').toLowerCase();
  if (ct.includes('gltf') || ct.includes('glb')) return true;
  if (fn.endsWith('.glb') || fn.endsWith('.gltf')) return true;
  return false;
}

function extract3dOutput(resultJson) {
  if (!resultJson || typeof resultJson !== 'object') return null;
  const modelUrls = (resultJson.model_urls && typeof resultJson.model_urls === 'object') ? resultJson.model_urls : null;
  const thumbnailUrl = (resultJson.thumbnail && resultJson.thumbnail.url) ? resultJson.thumbnail.url : null;

  // Try to find a real GLB URL
  let glbUrl = null;
  // Check model_urls.glb first (most reliable)
  if (modelUrls && modelUrls.glb && modelUrls.glb.url && isGlbFile(modelUrls.glb)) {
    glbUrl = modelUrls.glb.url;
  }
  // Check model_glb only if it's actually a GLB (Rapid model returns OBJ here)
  if (!glbUrl && resultJson.model_glb && resultJson.model_glb.url && isGlbFile(resultJson.model_glb)) {
    glbUrl = resultJson.model_glb.url;
  }

  // Best downloadable model URL (GLB preferred, then OBJ, then whatever model_glb has)
  let modelDownloadUrl = glbUrl;
  let modelFormat = glbUrl ? 'glb' : null;
  if (!modelDownloadUrl) {
    if (modelUrls && modelUrls.obj && modelUrls.obj.url) {
      modelDownloadUrl = modelUrls.obj.url;
      modelFormat = 'obj';
    } else if (resultJson.model_glb && resultJson.model_glb.url) {
      modelDownloadUrl = resultJson.model_glb.url;
      const fn = (resultJson.model_glb.file_name || resultJson.model_glb.url || '').toLowerCase();
      modelFormat = fn.endsWith('.obj') ? 'obj' : (fn.endsWith('.fbx') ? 'fbx' : 'glb');
    }
  }

  return { glbUrl, modelDownloadUrl, modelFormat, thumbnailUrl, modelUrls };
}

function sanitizePathPart(s) {
  return String(s || '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 80);
}

const MIME_BY_EXT = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'application/octet-stream',
  '.fbx': 'application/octet-stream',
  '.stl': 'application/octet-stream',
  '.usdz': 'application/octet-stream',
};

function resolveMime(file) {
  if (file.type) return file.type;
  const name = (file.name || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot !== -1) {
    const ext = name.slice(dot);
    if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  }
  return 'application/octet-stream';
}

function ensureTaskUploadList(task) {
  if (!task || typeof task !== 'object') return null;
  if (!Array.isArray(task.uploadedBlobUrls)) {
    task.uploadedBlobUrls = [];
  }
  return task.uploadedBlobUrls;
}

function registerTaskBlobUrl(task, url) {
  if (!task || !url) return;
  const list = ensureTaskUploadList(task);
  if (!list) return;
  // Keep only a tiny bounded record for legacy task compatibility.
  if (!list.includes(url) && list.length < 4) list.push(url);
}

async function cleanupTaskUploads(task) {
  if (!task || typeof task !== 'object') return;
  if (task.blobCleanupDone) return;

  task.uploadedBlobUrls = [];
  task.blobCleanupDone = true;
  task.blobCleanupAt = Date.now();
  task.blobCleanupError = null;
}

function isDirectRemoteUrl(value) {
  return typeof value === 'string' && /^(https?:)?\/\//i.test(value.trim());
}

function canPassThroughRemoteUrl(value) {
  if (!isDirectRemoteUrl(value)) return false;
  try {
    const url = new URL(String(value).trim(), window.location.href);
    // Same-origin assets on this private app are not publicly reachable by Fal.
    return url.origin !== window.location.origin;
  } catch (_) {
    return false;
  }
}

const VIDEO_IMAGE_UPLOAD_FOLDERS = new Set([
  'video-image',
  'video-end-image',
]);
const VIDEO_IMAGE_UPLOAD_MAX_EDGE_PX = 2048;
const VIDEO_IMAGE_UPLOAD_MAX_BYTES = 6 * 1024 * 1024;
const VIDEO_IMAGE_UPLOAD_LARGE_BYTES = 4 * 1024 * 1024;

function shouldOptimizeVideoUploadImage(file, folder) {
  if (!file || !(file instanceof Blob)) return false;
  if (!VIDEO_IMAGE_UPLOAD_FOLDERS.has(String(folder || ''))) return false;
  const type = String(file.type || '').toLowerCase();
  if (!type.startsWith('image/')) return false;
  if (type.includes('svg')) return false;
  return true;
}

function getOptimizedImageExtension(type, fallbackName = 'upload') {
  const normalized = String(type || '').toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/avif') return '.avif';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  const match = String(fallbackName || '').match(/(\.[a-z0-9]+)$/i);
  return match ? match[1] : '.jpg';
}

function buildOptimizedImageFilename(name, type) {
  const base = String(name || 'upload')
    .replace(/(\.[a-z0-9]+)$/i, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'upload';
  return `${base}${getOptimizedImageExtension(type, name)}`;
}

function createUploadCanvas(width, height) {
  const safeWidth = Math.max(1, Math.round(Number(width) || 1));
  const safeHeight = Math.max(1, Math.round(Number(height) || 1));
  const canvas = document.createElement('canvas');
  canvas.width = safeWidth;
  canvas.height = safeHeight;
  return canvas;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    if (!canvas || typeof canvas.toBlob !== 'function') {
      reject(new Error('Canvas export unavailable'));
      return;
    }
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Canvas export failed'));
    }, type, quality);
  });
}

async function decodeImageForUpload(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup() {
          if (typeof bitmap.close === 'function') bitmap.close();
        },
      };
    } catch (_) {
      // Fall back to Image element below.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.decoding = 'async';
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Image decode failed'));
      el.src = objectUrl;
    });
    return {
      source: img,
      width: img.naturalWidth || img.width || 0,
      height: img.naturalHeight || img.height || 0,
      cleanup() {
        URL.revokeObjectURL(objectUrl);
      },
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function detectImageHasAlpha(source) {
  try {
    const sampleCanvas = createUploadCanvas(32, 32);
    const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.clearRect(0, 0, sampleCanvas.width, sampleCanvas.height);
    ctx.drawImage(source, 0, 0, sampleCanvas.width, sampleCanvas.height);
    const pixels = ctx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] < 250) return true;
    }
  } catch (_) {
    return false;
  }
  return false;
}

async function optimizeImageForVideoUpload(file, folder) {
  if (!shouldOptimizeVideoUploadImage(file, folder)) return file;

  let decoded = null;
  try {
    decoded = await decodeImageForUpload(file);
    const width = Number(decoded.width) || 0;
    const height = Number(decoded.height) || 0;
    if (!width || !height) return file;

    const longestEdge = Math.max(width, height);
    const needsResize = longestEdge > VIDEO_IMAGE_UPLOAD_MAX_EDGE_PX;
    const isLargeFile = Number(file.size) > VIDEO_IMAGE_UPLOAD_LARGE_BYTES;
    if (!needsResize && !isLargeFile) return file;

    const scale = Math.min(1, VIDEO_IMAGE_UPLOAD_MAX_EDGE_PX / longestEdge);
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = createUploadCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.clearRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(decoded.source, 0, 0, targetWidth, targetHeight);

    const hasAlpha = detectImageHasAlpha(decoded.source);
    const attempts = hasAlpha
      ? [
          { type: 'image/webp', quality: 0.92 },
          { type: 'image/webp', quality: 0.84 },
          { type: 'image/png' },
        ]
      : [
          { type: 'image/jpeg', quality: 0.9 },
          { type: 'image/jpeg', quality: 0.82 },
          { type: 'image/webp', quality: 0.84 },
          { type: 'image/jpeg', quality: 0.74 },
        ];

    let bestBlob = null;
    for (const attempt of attempts) {
      let blob = null;
      try {
        blob = await canvasToBlob(canvas, attempt.type, attempt.quality);
      } catch (_) {
        blob = null;
      }
      if (!blob) continue;
      if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;
      if (blob.size <= VIDEO_IMAGE_UPLOAD_MAX_BYTES) {
        bestBlob = blob;
        break;
      }
    }

    if (!bestBlob) return file;
    const optimizedType = bestBlob.type || (hasAlpha ? 'image/webp' : 'image/jpeg');
    const optimizedFile = new File(
      [bestBlob],
      buildOptimizedImageFilename(file.name, optimizedType),
      { type: optimizedType, lastModified: Date.now() }
    );

    // Only replace when we materially improve upload cost or dimensions.
    if (optimizedFile.size >= file.size * 0.97 && !needsResize) return file;
    return optimizedFile;
  } catch (error) {
    console.warn('Video upload image optimization skipped:', error);
    return file;
  } finally {
    if (decoded && typeof decoded.cleanup === 'function') decoded.cleanup();
  }
}

let _falStorageClientPromise = null;

async function getFalStorageClient() {
  if (_falStorageClientPromise) return _falStorageClientPromise;
  _falStorageClientPromise = (async () => {
    let mod = null;
    try {
      mod = await import('https://esm.sh/@fal-ai/client@1.9.5?bundle');
    } catch (_) {
      mod = await import('https://esm.sh/@fal-ai/client@1.9.5');
    }
    const fal = mod && mod.fal ? mod.fal : null;
    if (!fal || typeof fal.config !== 'function' || !fal.storage || typeof fal.storage.upload !== 'function') {
      throw new Error('fal upload client not available');
    }
    fal.config({ proxyUrl: '/api/fal/proxy' });
    return fal.storage;
  })();
  return _falStorageClientPromise;
}

async function uploadFileToFal(file, folder, task) {
  if (!file) return null;
  const preparedFile = await optimizeImageForVideoUpload(file, folder);
  const storage = await getFalStorageClient();
  let url = null;
  try {
    markTaskActivity(task);
    url = await storage.upload(preparedFile, {
      lifecycle: {
        expiresIn: '1d',
      },
    });
  } catch (error) {
    if (preparedFile !== file) {
      console.warn('Optimized video image upload failed, retrying original file:', error);
      markTaskActivity(task);
      url = await storage.upload(file, {
        lifecycle: {
          expiresIn: '1d',
        },
      });
    } else {
      throw error;
    }
  }
  if (url) {
    markTaskActivity(task);
    registerTaskBlobUrl(task, url);
  }
  return url;
}

async function resolveUploadItemUrl(item, folder, task) {
  if (!item) return null;
  markTaskActivity(task);
  if (typeof item === 'string' && isDirectRemoteUrl(item)) {
    if (canPassThroughRemoteUrl(item)) return item.trim();
    const file = await fetchUrlAsFile(item.trim(), {});
    return uploadFileToFal(file, folder, task);
  }
  if (isRemoteAssetItem(item)) {
    if (canPassThroughRemoteUrl(item.url)) return item.url || null;
    const file = await ensureFileLikeAssetItem(item);
    return uploadFileToFal(file, folder, task);
  }
  return uploadFileToFal(item, folder, task);
}

async function resolveUploadItemUrls(items, folder, task, limit = Infinity) {
  const source = Array.isArray(items) ? items.filter(Boolean).slice(0, limit) : [];
  const urls = [];
  for (const item of source) {
    const url = await resolveUploadItemUrl(item, folder, task);
    if (url) urls.push(url);
  }
  return urls;
}

async function resolveUploadItemKieInput(item, folder, task) {
  if (!item) return null;
  markTaskActivity(task);
  if (typeof item === 'string') {
    const value = item.trim();
    if (!value) return null;
    if (/^data:image\//i.test(value)) return value;
    if (isDirectRemoteUrl(value) && canPassThroughRemoteUrl(value)) return value;
    const file = await fetchUrlAsFile(value, { type: 'image' });
    return readFileAsDataUri(file);
  }
  if (isRemoteAssetItem(item)) {
    if (canPassThroughRemoteUrl(item.url)) return item.url || null;
    const file = await ensureFileLikeAssetItem(item);
    return readFileAsDataUri(file);
  }
  const file = await ensureFileLikeAssetItem(item);
  return readFileAsDataUri(file);
}

async function resolveUploadItemKieInputs(items, folder, task, limit = Infinity) {
  const source = Array.isArray(items) ? items.filter(Boolean).slice(0, limit) : [];
  const urls = [];
  for (const item of source) {
    const url = await resolveUploadItemKieInput(item, folder, task);
    if (url) urls.push(url);
  }
  return urls;
}

async function submitImageRequest(task) {
  const prompt = task.prompt;
  const modelId = task.model_id;

  const body = {
    model_id: modelId,
    prompt,
  };

  if (task.mode === 'text') {
    // Common settings
    const isGptTextModel = GPT_IMAGE_TEXT_MODEL_IDS.has(modelId);
    const aspect = qs('aspectRatioBase') ? qs('aspectRatioBase').value : '';
    if (!isGptTextModel && aspect) body.aspect_ratio = aspect;

    const numImages = qs('textNumImages') ? qs('textNumImages').value : '1';
    body.num_images = Number(numImages) || 1;

    const outputFormat = qs('textOutputFormat') ? qs('textOutputFormat').value : '';
    if (outputFormat) body.output_format = outputFormat;

    // Flux Pro specific settings
    if (modelId === 'flux-pro-v1.1-ultra') {
      const safetyTolerance = qs('textSafetyTolerance') ? qs('textSafetyTolerance').value : '';
      if (safetyTolerance) body.safety_tolerance = safetyTolerance;

      const enhancePrompt = qs('textEnhancePrompt') ? qs('textEnhancePrompt').value : '';
      if (enhancePrompt === 'true') body.enhance_prompt = true;

      const rawMode = qs('textRawMode') ? qs('textRawMode').value : '';
      if (rawMode === 'true') body.raw = true;

      const seed = qs('textSeed') ? String(qs('textSeed').value || '').trim() : '';
      if (seed) body.seed = Number(seed);
    }

    // GPT Image specific settings
    if (modelId === GPT_IMAGE_15_TEXT_MODEL_ID) {
      const imageSize = buildGptImageSizePayload('gptImageSize', 'gptImageWidth', 'gptImageHeight', 'gptTextCustomSizeHint', modelId);
      if (imageSize) body.image_size = imageSize;

      const quality = qs('gptQuality') ? qs('gptQuality').value : '';
      if (quality) body.quality = quality;

      const background = qs('gptBackground') ? qs('gptBackground').value : '';
      if (background) body.background = background;

      const syncMode = qs('gptSyncMode') ? qs('gptSyncMode').value : 'false';
      if (syncMode === 'true') body.sync_mode = true;
    }

    if (modelId === GPT_IMAGE_2_TEXT_MODEL_ID) {
      const imageSize = buildGptImageSizePayload('gptImageSize', 'gptImageWidth', 'gptImageHeight', 'gptTextCustomSizeHint', modelId);
      if (imageSize) body.image_size = imageSize;

      const quality = qs('gptQuality') ? qs('gptQuality').value : '';
      if (quality) body.quality = quality;

      const syncMode = qs('gptSyncMode') ? qs('gptSyncMode').value : 'false';
      if (syncMode === 'true') body.sync_mode = true;
    }

    // Nano Banana Pro specific settings
    if (modelId === 'nano-banana-pro') {
      const resolution = qs('nanoResolution') ? qs('nanoResolution').value : '';
      if (resolution) body.resolution = resolution;

      const webSearch = qs('nanoWebSearch') ? qs('nanoWebSearch').value : '';
      if (webSearch === 'true') body.enable_web_search = true;
    }

    // Nano Banana 2 specific settings
    if (modelId === 'nano-banana-2') {
      const resolution = qs('nano2Resolution') ? qs('nano2Resolution').value : '';
      if (resolution) body.resolution = resolution;

      const safetyTolerance = qs('nano2SafetyTolerance') ? qs('nano2SafetyTolerance').value : '';
      if (safetyTolerance) body.safety_tolerance = safetyTolerance;

      const seed = qs('nano2Seed') ? String(qs('nano2Seed').value || '').trim() : '';
      if (seed) body.seed = Number(seed);

      const webSearch = qs('nano2WebSearch') ? qs('nano2WebSearch').value : '';
      if (webSearch === 'true') body.enable_web_search = true;

      const googleSearch = qs('nano2GoogleSearch') ? qs('nano2GoogleSearch').value : '';
      if (googleSearch === 'true') body.enable_google_search = true;
    }
  } else {
    // Image editing mode
    const imageUrls = await resolveUploadItemUrls(uploadedImageFiles, 'image-input', task);
    if (imageUrls.length === 0) throw new Error(window.I18N ? I18N.t('toast_upload_image') : 'Upload at least one image for Style mode');
    body.image_urls = imageUrls;

    // GPT Image 1.5 Edit settings
    if (modelId === GPT_IMAGE_15_EDIT_MODEL_ID) {
      const imageSize = buildGptImageSizePayload('editImageSize', 'editImageWidth', 'editImageHeight', 'gptEditCustomSizeHint', modelId);
      if (imageSize) body.image_size = imageSize;

      const quality = qs('editQuality') ? qs('editQuality').value : '';
      if (quality) body.quality = quality;

      const background = qs('editBackground') ? qs('editBackground').value : '';
      if (background) body.background = background;

      const inputFidelity = qs('editInputFidelity') ? qs('editInputFidelity').value : '';
      if (inputFidelity) body.input_fidelity = inputFidelity;

      const syncMode = qs('editSyncMode') ? qs('editSyncMode').value : 'false';
      if (syncMode === 'true') body.sync_mode = true;

      const maskSource = getManagedUploadRemoteItems(MANAGED_UPLOADS.maskInput)[0] || uploadedMaskFile;
      if (maskSource) {
        const mu = await resolveUploadItemUrl(maskSource, 'mask', task);
        if (mu) body.mask_image_url = mu;
      }
    }

    if (modelId === GPT_IMAGE_2_EDIT_MODEL_ID) {
      const imageSize = buildGptImageSizePayload('editImageSize', 'editImageWidth', 'editImageHeight', 'gptEditCustomSizeHint', modelId);
      if (imageSize) body.image_size = imageSize;

      const quality = qs('editQuality') ? qs('editQuality').value : '';
      if (quality) body.quality = quality;

      const syncMode = qs('editSyncMode') ? qs('editSyncMode').value : 'false';
      if (syncMode === 'true') body.sync_mode = true;

      const maskSource = getManagedUploadRemoteItems(MANAGED_UPLOADS.maskInput)[0] || uploadedMaskFile;
      if (maskSource) {
        const mu = await resolveUploadItemUrl(maskSource, 'mask', task);
        if (mu) body.mask_url = mu;
      }
    }

    // Nano Banana Pro Edit settings
    if (modelId === 'nano-banana-pro/edit') {
      const resolution = qs('editNanoResolution') ? qs('editNanoResolution').value : '';
      if (resolution) body.resolution = resolution;

      const webSearch = qs('editNanoWebSearch') ? qs('editNanoWebSearch').value : '';
      if (webSearch === 'true') body.enable_web_search = true;

      const aspectRatio = qs('editNanoAspectRatio') ? qs('editNanoAspectRatio').value : '';
      if (aspectRatio) body.aspect_ratio = aspectRatio;
    }

    // Nano Banana 2 Edit settings
    if (modelId === 'nano-banana-2/edit') {
      const resolution = qs('editNano2Resolution') ? qs('editNano2Resolution').value : '';
      if (resolution) body.resolution = resolution;

      const safetyTolerance = qs('editNano2SafetyTolerance') ? qs('editNano2SafetyTolerance').value : '';
      if (safetyTolerance) body.safety_tolerance = safetyTolerance;

      const seed = qs('editNano2Seed') ? String(qs('editNano2Seed').value || '').trim() : '';
      if (seed) body.seed = Number(seed);

      const webSearch = qs('editNano2WebSearch') ? qs('editNano2WebSearch').value : '';
      if (webSearch === 'true') body.enable_web_search = true;

      const googleSearch = qs('editNano2GoogleSearch') ? qs('editNano2GoogleSearch').value : '';
      if (googleSearch === 'true') body.enable_google_search = true;

      const aspectRatio = qs('editNano2AspectRatio') ? qs('editNano2AspectRatio').value : '';
      if (aspectRatio) body.aspect_ratio = aspectRatio;
    }

    const outputFormat = qs('editOutputFormat') ? qs('editOutputFormat').value : '';
    if (outputFormat) body.output_format = outputFormat;
  }

  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await createResponseError(res, 'Image generation failed');
  return await res.json();
}

async function submit3dRequest(task) {
  const modelId = getSelected3dModelId() || 'fal-ai/hunyuan3d-v3/image-to-3d';

  const body = {
    model_id: modelId,
  };

  const front3dSource = getManagedUploadRemoteItems(MANAGED_UPLOADS.threeDFrontInput)[0] || uploaded3dFrontFile;
  const back3dSource = getManagedUploadRemoteItems(MANAGED_UPLOADS.threeDBackInput)[0] || uploaded3dBackFile;
  const left3dSource = getManagedUploadRemoteItems(MANAGED_UPLOADS.threeDLeftInput)[0] || uploaded3dLeftFile;
  const right3dSource = getManagedUploadRemoteItems(MANAGED_UPLOADS.threeDRightInput)[0] || uploaded3dRightFile;
  const meshyTextureSource = getManagedUploadRemoteItems(MANAGED_UPLOADS.threeDMeshyTextureImageInput)[0] || uploaded3dMeshyTextureImageFile;
  const retextureStyleSource = getManagedUploadRemoteItems(MANAGED_UPLOADS.threeDRetextureStyleImageInput)[0] || uploaded3dRetextureStyleImageFile;

  if (modelId === 'fal-ai/hunyuan3d-v3/image-to-3d') {
    if (!front3dSource) throw new Error('Front image is required for 3D generation');
    body.input_image_url = await resolveUploadItemUrl(front3dSource, '3d-front', task);
    body.generate_type = qs('threeDGenerateType') ? qs('threeDGenerateType').value : 'Normal';
    body.enable_pbr = (qs('threeDEnablePbr') ? qs('threeDEnablePbr').value : 'false') === 'true';
    body.polygon_type = qs('threeDPolygonType') ? qs('threeDPolygonType').value : 'triangle';

    const faceCount = qs('threeDFaceCount') ? String(qs('threeDFaceCount').value || '').trim() : '';
    if (faceCount) body.face_count = Number(faceCount);

    if (back3dSource) body.back_image_url = await resolveUploadItemUrl(back3dSource, '3d-back', task);
    if (left3dSource) body.left_image_url = await resolveUploadItemUrl(left3dSource, '3d-left', task);
    if (right3dSource) body.right_image_url = await resolveUploadItemUrl(right3dSource, '3d-right', task);
  }

  if (modelId === 'fal-ai/hunyuan3d-v3/text-to-3d') {
    const prompt = String(task && task.prompt ? task.prompt : '').trim();
    if (!prompt) throw new Error('Prompt is required for Hunyuan3D Text to 3D');
    body.prompt = prompt;
    body.generate_type = qs('threeDGenerateType') ? qs('threeDGenerateType').value : 'Normal';
    body.enable_pbr = (qs('threeDEnablePbr') ? qs('threeDEnablePbr').value : 'false') === 'true';
    body.polygon_type = qs('threeDPolygonType') ? qs('threeDPolygonType').value : 'triangle';

    const faceCount = qs('threeDFaceCount') ? String(qs('threeDFaceCount').value || '').trim() : '';
    if (faceCount) body.face_count = Number(faceCount);
  }

  if (modelId === 'fal-ai/meshy/v6-preview/image-to-3d') {
    if (!front3dSource) throw new Error('Front image is required for 3D generation');
    body.image_url = await resolveUploadItemUrl(front3dSource, '3d-front', task);
    body.topology = qs('threeDMeshyTopology') ? qs('threeDMeshyTopology').value : 'triangle';
    body.symmetry_mode = qs('threeDMeshySymmetryMode') ? qs('threeDMeshySymmetryMode').value : 'auto';
    body.should_remesh = (qs('threeDMeshyShouldRemesh') ? qs('threeDMeshyShouldRemesh').value : 'true') === 'true';
    body.should_texture = (qs('threeDMeshyShouldTexture') ? qs('threeDMeshyShouldTexture').value : 'true') === 'true';
    body.enable_pbr = (qs('threeDMeshyEnablePbr') ? qs('threeDMeshyEnablePbr').value : 'false') === 'true';
    body.is_a_t_pose = (qs('threeDMeshyIsATPose') ? qs('threeDMeshyIsATPose').value : 'false') === 'true';
    body.enable_safety_checker = (qs('threeDMeshyEnableSafetyChecker') ? qs('threeDMeshyEnableSafetyChecker').value : 'true') === 'true';

    const poly = qs('threeDMeshyTargetPolycount') ? String(qs('threeDMeshyTargetPolycount').value || '').trim() : '';
    if (poly) body.target_polycount = Number(poly);

    const tp = qs('threeDMeshyTexturePrompt') ? String(qs('threeDMeshyTexturePrompt').value || '').trim() : '';
    if (tp) body.texture_prompt = tp;

    const tUrl = qs('threeDMeshyTextureImageUrl') ? String(qs('threeDMeshyTextureImageUrl').value || '').trim() : '';
    if (tUrl) body.texture_image_url = tUrl;
    if (meshyTextureSource) body.texture_image_url = await resolveUploadItemUrl(meshyTextureSource, '3d-texture', task);
  }

  if (modelId === 'fal-ai/meshy/v6-preview/text-to-3d') {
    const prompt = String(task && task.prompt ? task.prompt : '').trim();
    if (!prompt) throw new Error('Prompt is required for Meshy Text to 3D');
    body.prompt = prompt;
    body.mode = qs('threeDMeshyMode') ? qs('threeDMeshyMode').value : 'full';
    body.art_style = qs('threeDMeshyArtStyle') ? qs('threeDMeshyArtStyle').value : 'realistic';
    body.topology = qs('threeDMeshyTopology') ? qs('threeDMeshyTopology').value : 'triangle';
    body.symmetry_mode = qs('threeDMeshySymmetryMode') ? qs('threeDMeshySymmetryMode').value : 'auto';
    body.should_remesh = (qs('threeDMeshyShouldRemesh') ? qs('threeDMeshyShouldRemesh').value : 'true') === 'true';
    body.enable_pbr = (qs('threeDMeshyEnablePbr') ? qs('threeDMeshyEnablePbr').value : 'false') === 'true';
    body.is_a_t_pose = (qs('threeDMeshyIsATPose') ? qs('threeDMeshyIsATPose').value : 'false') === 'true';
    body.enable_prompt_expansion = (qs('threeDMeshyEnablePromptExpansion') ? qs('threeDMeshyEnablePromptExpansion').value : 'false') === 'true';
    body.enable_safety_checker = (qs('threeDMeshyEnableSafetyChecker') ? qs('threeDMeshyEnableSafetyChecker').value : 'true') === 'true';

    const poly = qs('threeDMeshyTargetPolycount') ? String(qs('threeDMeshyTargetPolycount').value || '').trim() : '';
    if (poly) body.target_polycount = Number(poly);

    const seed = qs('threeDMeshySeed') ? String(qs('threeDMeshySeed').value || '').trim() : '';
    if (seed) body.seed = Number(seed);

    const tp = qs('threeDMeshyTexturePrompt') ? String(qs('threeDMeshyTexturePrompt').value || '').trim() : '';
    if (tp) body.texture_prompt = tp;

    const tUrl = qs('threeDMeshyTextureImageUrl') ? String(qs('threeDMeshyTextureImageUrl').value || '').trim() : '';
    if (tUrl) body.texture_image_url = tUrl;
    if (meshyTextureSource) body.texture_image_url = await resolveUploadItemUrl(meshyTextureSource, '3d-texture', task);
  }

  if (modelId === 'fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d') {
    if (!front3dSource) throw new Error('Front image is required for Rapid Image to 3D');
    body.input_image_url = await resolveUploadItemUrl(front3dSource, '3d-rapid-front', task);
    body.enable_pbr = (qs('threeDRapidEnablePbr') ? qs('threeDRapidEnablePbr').value : 'false') === 'true';
    body.enable_geometry = (qs('threeDRapidEnableGeometry') ? qs('threeDRapidEnableGeometry').value : 'false') === 'true';
  }

  if (modelId === 'fal-ai/hunyuan-3d/v3.1/smart-topology') {
    if (!uploaded3dTopologyFile) throw new Error('3D file (GLB/OBJ) is required for Smart Topology');
    body.input_file_url = await uploadFileToFal(uploaded3dTopologyFile, '3d-topology', task);
    // Auto-detect file type from extension, fallback to dropdown
    const topoFileName = (uploaded3dTopologyFile.name || '').toLowerCase();
    const autoType = topoFileName.endsWith('.obj') ? 'obj' : (topoFileName.endsWith('.glb') ? 'glb' : null);
    body.input_file_type = autoType || (qs('threeDTopologyFileType') ? qs('threeDTopologyFileType').value : 'glb');
    body.polygon_type = qs('threeDTopologyPolygonType') ? qs('threeDTopologyPolygonType').value : 'triangle';
    body.face_level = qs('threeDTopologyFaceLevel') ? qs('threeDTopologyFaceLevel').value : 'medium';
  }

  if (modelId === 'fal-ai/meshy/v5/retexture') {
    if (!uploaded3dRetextureModelFile) throw new Error('3D model file is required for Retexture');
    body.model_url = await uploadFileToFal(uploaded3dRetextureModelFile, '3d-retexture-model', task);

    const stylePrompt = qs('threeDRetextureStylePrompt') ? String(qs('threeDRetextureStylePrompt').value || '').trim() : '';
    if (stylePrompt) body.text_style_prompt = stylePrompt;

    if (retextureStyleSource) {
      body.image_style_url = await resolveUploadItemUrl(retextureStyleSource, '3d-retexture-style', task);
    }

    if (!stylePrompt && !body.image_style_url) {
      throw new Error('Either a style prompt or style image is required for Retexture');
    }

    body.enable_original_uv = (qs('threeDRetextureOriginalUv') ? qs('threeDRetextureOriginalUv').value : 'true') === 'true';
    body.enable_pbr = (qs('threeDRetextureEnablePbr') ? qs('threeDRetextureEnablePbr').value : 'false') === 'true';
    body.enable_safety_checker = (qs('threeDRetextureEnableSafety') ? qs('threeDRetextureEnableSafety').value : 'true') === 'true';
  }

  const res = await fetch('/api/3d-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await createResponseError(res, '3D generation failed');
  return await res.json();
}

async function submitVideoRequest(task) {
  ensureVideoControls();
  const modelId = qs('videoModel') ? qs('videoModel').value : '';
  const modelMeta = modelId ? (VIDEO_MODEL_MAP.get(modelId) || null) : null;
  if (modelMeta && isKling3VideoKind(modelMeta.kind)) {
    syncKling3StateFromVideoModelId(modelId, { skipSave: true });
    return submitKling3Request({ ...task, model_id: modelId });
  }
  const prompt = task.prompt;

  const body = { model_id: modelId, prompt };
  const isSeedance2ReferenceModel = !!(modelMeta && isSeedance2VideoModelId(modelMeta.id) && getSeedance2FamilyForModelId(modelMeta.id) === 'reference-to-video');

  const { options, top } = collectVideoOptionsFromUI();
  // Pass duration variants to backend options so it can map them correctly
  if (top.duration != null) body.duration = top.duration;
  if (top.aspect_ratio != null) body.aspect_ratio = top.aspect_ratio;
  if (top.keep_audio != null) body.keep_audio = top.keep_audio;

  // Merge options and duration variants
  const mergedOptions = { ...(options || {}) };
  if (top.duration_sora != null) mergedOptions.duration_sora = top.duration_sora;
  if (top.duration_hailuo != null) mergedOptions.duration_hailuo = top.duration_hailuo;
  if (Object.keys(mergedOptions).length > 0) body.options = mergedOptions;

  if (modelMeta && modelMeta.kind === 'video-id-to-video') {
    const vid = qs('videoIdInput') ? String(qs('videoIdInput').value || '').trim() : '';
    if (vid) body.video_id = vid;
  }

  const videoUrl = qs('videoUrlInput') ? String(qs('videoUrlInput').value || '').trim() : '';
  if (videoUrl) body.video_url = videoUrl;

  const videoSource = getManagedUploadPrimarySource(MANAGED_UPLOADS.videoInput, uploadedVideoFile);
  const videoImageSource = getManagedUploadPrimarySource(MANAGED_UPLOADS.videoImageInput, uploadedVideoImageFile);

  const endImageSource = getManagedUploadPrimarySource(MANAGED_UPLOADS.videoEndImageInput, uploadedEndImageFile);

  const referenceSources = [
    ...getManagedUploadRemoteItems(MANAGED_UPLOADS.referenceImagesInput),
    ...(Array.isArray(uploadedReferenceImages) ? uploadedReferenceImages : []),
  ];

  const audioSource = getManagedUploadPrimarySource(MANAGED_UPLOADS.audioInput, uploadedAudioFile);
  const seedanceRefs = isSeedance2ReferenceModel ? getSeedance2ReferenceSources() : null;

  if (videoSource) {
    const vu = await resolveUploadItemUrl(videoSource, 'video', task);
    if (vu) body.video_url = vu;
  }

  if (!isSeedance2ReferenceModel && videoImageSource) {
    const iu = await resolveUploadItemUrl(videoImageSource, 'video-image', task);
    if (iu) body.image_url = iu;
  }
  if (
    modelMeta
    && modelMeta.requiresImage !== false
    && !isSeedance2ReferenceModel
    && ['image-to-video', 'audio-to-video', 'reference-to-video', 'motion-control'].includes(modelMeta.kind)
    && !body.image_url
  ) {
    throw new Error('Failed to attach the start image for this video model. Please reselect the image and try again.');
  }

  if (!isSeedance2ReferenceModel && endImageSource) {
    const eu = await resolveUploadItemUrl(endImageSource, 'video-end-image', task);
    if (eu) body.end_image_url = eu;
  }

  if (!isSeedance2ReferenceModel && referenceSources.length > 0) {
    const imageUrls = await resolveUploadItemUrls(referenceSources, 'video-reference', task);
    if (imageUrls.length > 0) body.image_urls = imageUrls;
  }

  if (!isSeedance2ReferenceModel && audioSource) {
    const au = await resolveUploadItemUrl(audioSource, 'audio', task);
    if (au) body.audio_url = au;
  }

  if (isSeedance2ReferenceModel && seedanceRefs) {
    const imageUrls = await resolveUploadItemUrls(seedanceRefs.images, 'seedance-reference-image', task, 9);
    const videoUrls = await resolveUploadItemUrls(seedanceRefs.videos, 'seedance-reference-video', task, 3);
    const audioUrls = await resolveUploadItemUrls(seedanceRefs.audios, 'seedance-reference-audio', task, 3);
    if (imageUrls.length > 0) body.image_urls = imageUrls;
    if (videoUrls.length > 0) body.video_urls = videoUrls;
    if (audioUrls.length > 0) body.audio_urls = audioUrls;
  }

  const res = await fetch('/api/video-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await createResponseError(res, 'Video generation failed');
  return await res.json();
}

async function pollTask(taskId) {
  const t = tasks.find((x) => x && x.id === taskId);
  if (!t || t.status !== 'RUNNING' || !t.status_url) return;

  try {
    const data = await fetchFalViaStatusProxy(t.status_url);
    t.retryCount = 0;
    t.error = null;

    if (data.status === 'COMPLETED') {
      if (!t.response_url) throw new Error('Missing response_url');

      const out = await fetchFalViaStatusProxy(t.response_url);

      if (t.mode === '3d') {
        const o = extract3dOutput(out);
        if (!o || !o.modelDownloadUrl) throw new Error('No 3D model URL in response');
        t.status = 'COMPLETED';
        t.completedAt = Date.now();
        t.mediaUrl = o.glbUrl || o.modelDownloadUrl;
        t.thumbUrl = o.thumbnailUrl || null;
        t.model_urls = o.modelUrls || null;
        t.modelFormat = o.modelFormat || 'glb';

        if (!t.savedToHistory) {
          const placeholder3d = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#000"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="#fff" font-family="Arial" font-size="14">3D</text></svg>')}`;
          const item = buildTaskHistoryItem(t, '3d', t.thumbUrl || placeholder3d, {
            suffix: '3d',
            timestamp: t.completedAt,
            meta: {
              glbUrl: o.glbUrl || null,
              modelDownloadUrl: o.modelDownloadUrl,
              modelFormat: o.modelFormat || 'glb',
              model_urls: t.model_urls || null,
            },
          });
          item.glbUrl = o.glbUrl || null;
          item.modelDownloadUrl = o.modelDownloadUrl;
          item.modelFormat = o.modelFormat || 'glb';
          item.model_urls = t.model_urls || null;
          t.savedToHistory = true;
          addToHistory(item);
          displayResult(item);
          // Generate small thumbnail for the 3D item
          if (item.url && !item.url.startsWith('data:') && !isPrimaryCoarsePointer()) {
            generateImageThumbnail(item.url).then((thumb) => {
              if (thumb) {
                item.thumbnailUrl = thumb;
                _pendingHistorySave = true;
                debouncedSaveHistory();
              }
            });
          }
        }
      } else if (t.mode === 'tools' && t.toolsTool === 'sam-audio') {
        const audioOut = extractSamAudioOutput(out);
        if (!audioOut || !audioOut.targetUrl) throw new Error('No audio URL in response');
        t.status = 'COMPLETED';
        t.completedAt = Date.now();
        t.mediaUrl = audioOut.targetUrl;
        t.secondaryMediaUrl = audioOut.residualUrl || null;

        if (!t.savedToHistory) {
          const item = buildTaskHistoryItem(t, 'audio', audioOut.targetUrl, {
            suffix: 'audio',
            timestamp: t.completedAt,
            meta: {
              residualUrl: audioOut.residualUrl || null,
              duration: audioOut.duration,
              sampleRate: audioOut.sampleRate,
              outputFormat: qs('toolsSamAudioOutputFormat') ? qs('toolsSamAudioOutputFormat').value : 'wav',
              previewUrl: createAudioPlaceholderDataUrl('AUDIO'),
            },
          });
          item.thumbnailUrl = createAudioPlaceholderDataUrl('AUDIO');
          item.residualUrl = audioOut.residualUrl || null;
          item.duration = audioOut.duration;
          item.sampleRate = audioOut.sampleRate;
          t.savedToHistory = true;
          addToHistory(item);
          displayResult(item);
        }
      } else if (t.mode === 'tools' && t.toolsTool === 'heygen-translate') {
        const translatedVideoUrl = extractMediaUrl(out, 'video');
        if (!translatedVideoUrl) throw new Error('No translated video URL in response');
        t.status = 'COMPLETED';
        t.completedAt = Date.now();
        t.mediaUrl = translatedVideoUrl;

        if (!t.savedToHistory) {
          const outputLanguage = qs('toolsHeygenOutputLanguage')
            ? String(qs('toolsHeygenOutputLanguage').value || '').trim()
            : HEYGEN_TRANSLATE_DEFAULT_LANGUAGE;
          const item = buildTaskHistoryItem(t, 'video', translatedVideoUrl, {
            suffix: 'heygen_video',
            timestamp: t.completedAt,
            meta: {
              outputLanguage,
              translateAudioOnly: !!(qs('toolsHeygenTranslateAudioOnly') && qs('toolsHeygenTranslateAudioOnly').checked),
              speakerNum: qs('toolsHeygenSpeakerNum') ? (String(qs('toolsHeygenSpeakerNum').value || '').trim() || null) : null,
              enableDynamicDuration: !(qs('toolsHeygenEnableDynamicDuration') && !qs('toolsHeygenEnableDynamicDuration').checked),
              sourceTool: 'heygen-translate',
            },
          });
          t.savedToHistory = true;
          addToHistory(item);
          displayResult(item);
          queueHistoryThumbnailForItem(item, 0);
        }
      } else {
        const isVideoMode = t.mode === 'video' || t.mode === 'kling3';
        const urls = extractAllMediaUrls(out, isVideoMode ? 'video' : 'image');
        if (!urls || urls.length === 0) throw new Error('No media URL in response');
        t.status = 'COMPLETED';
        t.completedAt = Date.now();
        t.mediaUrl = urls[0];
        t.allMediaUrls = urls;

        if (!t.savedToHistory) {
          t.savedToHistory = true;
          // Build gallery items for all outputs — batch insert (single save + single UI update)
          const items = [];
          for (let i = 0; i < urls.length; i++) {
            const item = buildTaskHistoryItem(t, isVideoMode ? 'video' : 'image', urls[i], {
              suffix: (isVideoMode ? 'video' : 'image') + '_' + i,
              timestamp: t.completedAt + i,
              outputIndex: i,
            });
            addToHistorySilent(item);
            items.push(item);
            if (isVideoMode) queueHistoryThumbnailForItem(item, i);
          }
          // Single save + single UI update for the whole batch
          saveHistory();
          scheduleHistoryUIUpdate();
          queueAccountHistoryPersist(items);
          // Set gallery items for navigation
          setGalleryItems(items);
        }
      }

      await cleanupTaskUploads(t);
      saveTasks();
      renderTasks();
      showToast(window.I18N ? I18N.t('toast_complete') : 'Masterpiece ready!', 'info');
      return;
    }

    if (data.status === 'FAILED') {
      t.status = 'FAILED';
      t.failedAt = Date.now();
      t.error = normalizeErrorMessageFromPayload(data, 'Generation failed');
      await cleanupTaskUploads(t);
      saveTasks();
      renderTasks();
      showToast(formatErrorForDisplay(t.error), 'error');
      return;
    }

    saveTasks();
    renderTasks();
    schedulePoll(taskId, 2000);
  } catch (e) {
    if (isTransientPollError(e)) {
      t.retryCount = (Number.isFinite(t.retryCount) ? t.retryCount : 0) + 1;
      if (t.retryCount > MAX_POLL_RETRIES) {
        t.status = 'FAILED';
        t.failedAt = Date.now();
        t.error = 'Connection lost after multiple retries. Please try again.';
        await cleanupTaskUploads(t);
        saveTasks();
        renderTasks();
        showToast(formatErrorForDisplay(t.error), 'error');
        return;
      }
      const delay = computeRetryDelayMs(t.retryCount);
      t.error = 'Temporary connection issue. Retrying…';
      saveTasks();
      renderTasks();
      schedulePoll(taskId, delay);
      return;
    }

    t.status = 'FAILED';
    t.failedAt = Date.now();
    t.error = getErrorMessage(e, 'Generation failed');
    await cleanupTaskUploads(t);
    saveTasks();
    renderTasks();
    showToast(formatErrorForDisplay(t.error), 'error');
  }
}

async function startTask(taskId) {
  const t = tasks.find((x) => x && x.id === taskId);
  if (!t) return;
  t.status = 'SUBMITTING';
  t.error = null;
  t.startedAt = Date.now();
  t.lastActivityAt = t.startedAt;
  saveTasks();
  renderTasks();

  try {
    let res;
    if (t.mode === 'tools') res = await submitToolsRequest(t);
    else if (t.mode === 'video') res = await submitVideoRequest(t);
    else if (t.mode === '3d') res = await submit3dRequest(t);
    else if (t.mode === 'kling3') res = await submitKling3Request(t);
    else res = await submitImageRequest(t);

    if (res && res.completed && res.result) {
      const isVideoMode = t.mode === 'video' || t.mode === 'kling3';
      const urls = extractAllMediaUrls(res.result, isVideoMode ? 'video' : 'image');
      if (!urls || urls.length === 0) throw new Error('No media URL in response');
      t.status = 'COMPLETED';
      t.completedAt = Date.now();
      t.mediaUrl = urls[0];
      t.allMediaUrls = urls;
      t.savedToHistory = true;
      const items = [];
      for (let i = 0; i < urls.length; i++) {
        const item = buildTaskHistoryItem(t, isVideoMode ? 'video' : 'image', urls[i], {
          suffix: (isVideoMode ? 'video' : 'image') + '_' + i,
          timestamp: t.completedAt + i,
          outputIndex: i,
        });
        addToHistorySilent(item);
        items.push(item);
        if (isVideoMode) queueHistoryThumbnailForItem(item, i);
      }
      saveHistory();
      scheduleHistoryUIUpdate();
      queueAccountHistoryPersist(items);
      setGalleryItems(items);
      await cleanupTaskUploads(t);
      saveTasks();
      renderTasks();
      showToast(window.I18N ? I18N.t('toast_complete') : 'Masterpiece ready!', 'info');
      return;
    }

    t.status = 'RUNNING';
    t.status_url = res.status_url;
    t.response_url = res.response_url || null;
    markTaskActivity(t);
    saveTasks();
    renderTasks();

    pollTask(t.id);
  } catch (e) {
    t.status = 'FAILED';
    t.failedAt = Date.now();
    t.error = getErrorMessage(e, 'Generation failed');
    await cleanupTaskUploads(t);
    saveTasks();
    renderTasks();
    showToast(formatErrorForDisplay(t.error), 'error');
  }
}

function captureGenerationContext() {
  const ctx = {
    mode: currentMode === 'kling3' ? 'video' : currentMode,
    videoTab: currentVideoTab,
    kling3Family: currentKling3Family,
    kling3Tab: currentKling3Tab,
    toolsTool: currentToolsTool,
    prompt: qs('promptInput') ? qs('promptInput').value : '',
    selects: {},
    inputs: {},
  };
  for (const id of PERSISTED_SELECTS) {
    const el = qs(id);
    if (el) ctx.selects[id] = el.value;
  }
  for (const id of PERSISTED_INPUTS) {
    const el = qs(id);
    if (el) ctx.inputs[id] = el.value;
  }
  const klingModelId = getSelectedKling3ModelId();
  if (klingModelId) ctx.selects.kling3Model = klingModelId;
  if (currentMode === 'tools' && currentToolsTool === 'sam-audio') {
    ctx.samAudioSpans = getToolsSamAudioSpanState();
  }
  return ctx;
}

async function handleGenerate() {
  const activeCount = getActiveTaskCount();
  if (activeCount >= MAX_CONCURRENT_TASKS) {
    showToast((window.I18N ? I18N.t('toast_max_tasks') : 'Maximum {n} generations at once. Please wait.').replace('{n}', MAX_CONCURRENT_TASKS), 'error');
    return;
  }

  // Tools mode: assemble prompt from form fields instead of promptInput
  let prompt;
  if (currentMode === 'tools') {
    if (currentToolsTool === 'card-studio') {
      const toolsModelId = qs('toolsModel') ? qs('toolsModel').value : DEFAULT_TOOLS_MODEL;
      prompt = '/' + (toolsModelId === GPT_IMAGE_2_EDIT_MODEL_ID
        ? assembleWbCardPromptGptImage2(uploadedToolsImages.length)
        : assembleWbCardPrompt(uploadedToolsImages.length));
    } else if (currentToolsTool === 'enhancer') {
      const model = qs('toolsEnhancerModel') ? qs('toolsEnhancerModel').value : 'Standard V2';
      const factor = qs('toolsEnhancerUpscaleFactor') ? qs('toolsEnhancerUpscaleFactor').value : '2';
      prompt = `Topaz Enhancer · ${model} · ${factor}x`;
    } else if (currentToolsTool === 'sam-audio') {
      const modelId = getToolsSamAudioModelId();
      const promptValue = qs('toolsSamAudioPrompt') ? qs('toolsSamAudioPrompt').value.trim() : '';
      const label = modelId === 'fal-ai/sam-audio/span-separate'
        ? toolsUiText('tools_sam_audio_model_span', 'Span Separation')
        : toolsUiText('tools_sam_audio_model_separate', 'Prompt Separation');
      prompt = `SAM Audio · ${label}${promptValue ? ` · ${promptValue}` : ''}`;
    } else if (currentToolsTool === 'heygen-translate') {
      const outputLanguage = qs('toolsHeygenOutputLanguage')
        ? String(qs('toolsHeygenOutputLanguage').value || '').trim()
        : HEYGEN_TRANSLATE_DEFAULT_LANGUAGE;
      const audioOnly = !!(qs('toolsHeygenTranslateAudioOnly') && qs('toolsHeygenTranslateAudioOnly').checked);
      prompt = `Heygen Translate · ${outputLanguage || HEYGEN_TRANSLATE_DEFAULT_LANGUAGE}${audioOnly ? ' · Voice Only' : ''}`;
    } else {
      const format = qs('toolsBgOutputFormat') ? qs('toolsBgOutputFormat').value : 'rgba';
      prompt = `Background Removal · ${format}`;
    }
  } else {
    const _rawPrompt = qs('promptInput') ? normalizePromptRefsForCurrentContext(qs('promptInput').value.trim()) : '';
    prompt = _rawPrompt ? `/${_rawPrompt}` : '';
  }
  const currentVideoModelMeta = currentMode === 'video' ? getSelectedVideoModel() : null;
  const currentVideoUsesKling3 = !!(currentVideoModelMeta && isKling3VideoKind(currentVideoModelMeta.kind));
  if (currentMode === 'video' && !currentVideoUsesKling3 && !prompt) {
    if (!(currentVideoModelMeta && currentVideoModelMeta.requiresPrompt === false)) {
      showToast(window.I18N ? I18N.t('toast_enter_prompt') : 'Please enter a prompt', 'error');
      return;
    }
  }
  if (currentMode === 'video' && currentVideoModelMeta && currentVideoModelMeta.kind === 'audio-to-video') {
    const manualAudioUrlInput = document.querySelector('#videoOptionsDynamic [data-opt-key="audio_url"]');
    const hasAudioUrl = !!(manualAudioUrlInput && String(manualAudioUrlInput.value || '').trim());
    const hasAudioSource = !!(getManagedUploadPrimarySource(MANAGED_UPLOADS.audioInput, uploadedAudioFile) || hasAudioUrl);
    const hasGuideImage = !!getManagedUploadPrimarySource(MANAGED_UPLOADS.videoImageInput, uploadedVideoImageFile);
    if (!hasAudioSource) {
      showToast(window.I18N ? I18N.t('select_audio') : 'Select audio', 'error');
      return;
    }
    if (!prompt && !hasGuideImage) {
      showToast(window.I18N ? I18N.t('toast_enter_prompt') : 'Please enter a prompt', 'error');
      return;
    }
  }
  if (currentMode === 'video' && currentVideoModelMeta && !currentVideoUsesKling3) {
    const kind = currentVideoModelMeta.kind;
    const isSeedance2ReferenceModel = isSeedance2VideoModelId(currentVideoModelMeta.id) && getSeedance2FamilyForModelId(currentVideoModelMeta.id) === 'reference-to-video';
    const needsStartImage =
      currentVideoModelMeta.requiresImage !== false
      && !isSeedance2ReferenceModel
      && (kind === 'image-to-video' || kind === 'audio-to-video' || kind === 'reference-to-video' || kind === 'motion-control');
    if (needsStartImage && !getManagedUploadPrimarySource(MANAGED_UPLOADS.videoImageInput, uploadedVideoImageFile)) {
      showToast(window.I18N ? I18N.t('select_image') : 'Select image', 'error');
      return;
    }
    if (isSeedance2ReferenceModel) {
      const refs = getSeedance2ReferenceSources();
      const imageCount = refs.images.length;
      const videoCount = refs.videos.length;
      const audioCount = refs.audios.length;
      const maxImageCount = Number.isFinite(Number(currentVideoModelMeta.maxImageUrls)) ? Number(currentVideoModelMeta.maxImageUrls) : 9;
      const maxVideoCount = Number.isFinite(Number(currentVideoModelMeta.maxVideoUrls)) ? Number(currentVideoModelMeta.maxVideoUrls) : 3;
      const maxAudioCount = Number.isFinite(Number(currentVideoModelMeta.maxAudioUrls)) ? Number(currentVideoModelMeta.maxAudioUrls) : 3;
      const maxTotalCount = Number.isFinite(Number(currentVideoModelMeta.maxTotalReferences)) ? Number(currentVideoModelMeta.maxTotalReferences) : 12;
      if (imageCount > maxImageCount) {
        showToast(`Seedance supports up to ${maxImageCount} reference images.`, 'error');
        return;
      }
      if (videoCount > maxVideoCount) {
        showToast(`Seedance supports up to ${maxVideoCount} reference videos.`, 'error');
        return;
      }
      if (audioCount > maxAudioCount) {
        showToast(`Seedance supports up to ${maxAudioCount} reference audio files.`, 'error');
        return;
      }
      if (imageCount + videoCount + audioCount > maxTotalCount) {
        showToast(`Seedance supports up to ${maxTotalCount} total reference files.`, 'error');
        return;
      }
      if (audioCount > 0 && imageCount === 0 && videoCount === 0) {
        showToast(getI18nText('seedance2_audio_requires_visual_ref', 'Add at least one image or video reference when using audio references.'), 'error');
        return;
      }
    }
  }
  // Kling 3 mode - check for prompt or multi-prompt
  if (currentMode === 'kling3' || currentVideoUsesKling3) {
    const selectedModelId = getSelectedKling3ModelId(currentVideoModelMeta ? currentVideoModelMeta.id : '');
    const isMotion = isKling3MotionModelId(selectedModelId) || currentKling3Tab === 'v3-motion-control';
    const useMultiPrompt = !isMotion && qs('kling3UseMultiPrompt') && qs('kling3UseMultiPrompt').checked;
    if (!isMotion && !useMultiPrompt && !prompt) {
      showToast(window.I18N ? I18N.t('toast_enter_prompt') : 'Please enter a prompt', 'error');
      return;
    }
    if (useMultiPrompt && kling3MultiPrompts.filter(p => p.prompt.trim()).length === 0) {
      showToast(window.I18N ? I18N.t('toast_add_shot') : 'Please add at least one shot prompt', 'error');
      return;
    }
    // Check for required media based on tab/model
    const tab = currentKling3Tab;
    const isI2V = tab === 'v3-image-to-video' || tab === 'o3-image-to-video';
    const isRef = tab === 'o3-reference-to-video';
    const isV2V = tab === 'o3-video-to-video';
    if ((isI2V || isRef || isMotion) && !(getManagedUploadRemoteItems(MANAGED_UPLOADS.kling3StartImageInput)[0] || uploadedKling3StartImage)) {
      showToast(window.I18N ? I18N.t('toast_upload_start') : 'Please upload a start image', 'error');
      return;
    }
    if ((isV2V || isMotion) && !(getManagedUploadRemoteItems(MANAGED_UPLOADS.kling3VideoInput)[0] || uploadedKling3Video) && !qs('kling3VideoUrlInput')?.value.trim()) {
      showToast(window.I18N ? I18N.t('toast_upload_video') : 'Please upload a video or enter a video URL', 'error');
      return;
    }
  }

  if (currentMode !== '3d' && currentMode !== 'video' && currentMode !== 'kling3' && currentMode !== 'tools' && !prompt) {
    showToast(window.I18N ? I18N.t('toast_enter_prompt') : 'Please enter a prompt', 'error');
    return;
  }

  if (currentMode === '3d') {
    const meta = getSelected3dModelMeta();
    if (meta && meta.kind === 'text-to-3d' && !prompt) {
      showToast(window.I18N ? I18N.t('toast_enter_prompt') : 'Please enter a prompt', 'error');
      return;
    }
    if (meta && meta.kind === 'image-to-3d' && !(getManagedUploadRemoteItems(MANAGED_UPLOADS.threeDFrontInput)[0] || uploaded3dFrontFile)) {
      showToast(window.I18N ? I18N.t('toast_upload_front') : 'Please upload a front image', 'error');
      return;
    }
    if (meta && meta.kind === 'topology' && !uploaded3dTopologyFile) {
      showToast(window.I18N ? I18N.t('toast_upload_3d_file') : 'Please upload a 3D file (GLB/OBJ)', 'error');
      return;
    }
    if (meta && meta.kind === 'retexture' && !uploaded3dRetextureModelFile) {
      showToast(window.I18N ? I18N.t('toast_upload_3d_model') : 'Please upload a 3D model file', 'error');
      return;
    }
    if (meta && meta.kind === 'retexture') {
      const sp = qs('threeDRetextureStylePrompt') ? qs('threeDRetextureStylePrompt').value.trim() : '';
      if (!sp && !(getManagedUploadRemoteItems(MANAGED_UPLOADS.threeDRetextureStyleImageInput)[0] || uploaded3dRetextureStyleImageFile)) {
        showToast(window.I18N ? I18N.t('toast_style_or_image') : 'Please provide a style prompt or style image', 'error');
        return;
      }
    }
  }

  if (currentMode === 'tools') {
    if (currentToolsTool === 'enhancer' || currentToolsTool === 'background-removal') {
      if (!getToolsUtilitySource()) {
        showToast(window.I18N ? I18N.t('select_image') : 'Select image', 'error');
        return;
      }
    } else if (currentToolsTool === 'sam-audio') {
      const modelId = getToolsSamAudioModelId();
      const promptValue = qs('toolsSamAudioPrompt') ? qs('toolsSamAudioPrompt').value.trim() : '';
      if (!getToolsUtilityAudioSource()) {
        showToast(window.I18N ? I18N.t('select_audio') : 'Select audio', 'error');
        return;
      }
      if (modelId === 'fal-ai/sam-audio/separate' && !promptValue) {
        showToast(window.I18N ? I18N.t('toast_enter_prompt') : 'Please enter a prompt', 'error');
        return;
      }
      if (modelId === 'fal-ai/sam-audio/span-separate' && !collectToolsSamAudioSpans().length) {
        showToast(toolsUiText('tools_sam_audio_error_spans', 'Add at least one valid span.'), 'error');
        return;
      }
    } else if (currentToolsTool === 'heygen-translate') {
      const outputLanguage = qs('toolsHeygenOutputLanguage')
        ? String(qs('toolsHeygenOutputLanguage').value || '').trim()
        : '';
      if (!getToolsUtilityVideoSource()) {
        showToast(window.I18N ? I18N.t('upload_video') : 'Upload video', 'error');
        return;
      }
      if (!outputLanguage) {
        showToast(toolsUiText('tools_heygen_error_language', 'Select a target language.'), 'error');
        return;
      }
    }
  }

  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  let model_id;
  if (currentMode === 'tools') model_id = getActiveToolsModelId();
  else if (currentMode === 'text') model_id = qs('imageModelText') ? qs('imageModelText').value : DEFAULT_IMAGE_TEXT_MODEL;
  else if (currentMode === 'image') model_id = qs('imageModelEdit') ? qs('imageModelEdit').value : DEFAULT_IMAGE_EDIT_MODEL;
  else if (currentMode === 'video') model_id = qs('videoModel') ? qs('videoModel').value : '';
  else if (currentMode === 'kling3') model_id = getSelectedKling3ModelId();
  else if (currentMode === '3d') model_id = qs('threeDModel') ? qs('threeDModel').value : DEFAULT_3D_MODEL;

  const task = {
    id,
    mode: currentMode,
    toolsTool: currentMode === 'tools' ? currentToolsTool : null,
    prompt,
    model_id,
    status: 'QUEUED',
    createdAt: Date.now(),
    startedAt: null,
    status_url: null,
    response_url: null,
    error: null,
    retryCount: 0,
    savedToHistory: false,
    genCtx: captureGenerationContext(),
  };

  tasks.unshift(task);
  saveTasks();
  renderTasks();
  startTask(id);
}

window.handleGenerate = handleGenerate;

function initModels() {
  const textSel = qs('imageModelText');
  if (textSel) {
    setSelectOptions(textSel, IMAGE_MODELS_TEXT);
    if (!textSel.value) textSel.value = DEFAULT_IMAGE_TEXT_MODEL;
  }

  const editSel = qs('imageModelEdit');
  if (editSel) {
    setSelectOptions(editSel, IMAGE_MODELS_EDIT);
    if (!editSel.value) editSel.value = DEFAULT_IMAGE_EDIT_MODEL;
  }

  const toolsSel = qs('toolsModel');
  if (toolsSel) {
    setSelectOptions(toolsSel, TOOLS_MODELS);
    if (!toolsSel.value) toolsSel.value = DEFAULT_TOOLS_MODEL;
  }

  const threeDSel = qs('threeDModel');
  if (threeDSel) {
    setSelectOptions(threeDSel, THREE_D_MODELS);
    if (!threeDSel.value) threeDSel.value = DEFAULT_3D_MODEL;
  }

  if (_toolsInitialized) wizUpdateToolsSettings();
  refreshModelNews();
}
function initInputs() {
  const imageInput = qs('imageInput');
  if (imageInput) {
    imageInput.addEventListener('change', (e) => {
      const newFiles = Array.from(e.target.files || []);
      const max = editMaxImages();
      const remaining = max - uploadedImageFiles.length;
      if (remaining <= 0) {
        showToast(window.I18N ? I18N.t('wiz_max_images').replace('{n}', max) : `Maximum ${max} images allowed`, 'error');
        e.target.value = '';
        return;
      }
      uploadedImageFiles = [...uploadedImageFiles, ...newFiles.slice(0, remaining)];
      if (uploadedImageFiles.length >= max) {
        showToast(window.I18N ? I18N.t('wiz_max_images').replace('{n}', max) : `Maximum ${max} images allowed`);
      }
      updateImagePreview();
      e.target.value = '';
    });
  }

  ['maskInput', 'threeDFrontInput', 'threeDBackInput', 'threeDLeftInput', 'threeDRightInput', 'threeDMeshyTextureImageInput', 'threeDTopologyFileInput', 'threeDRetextureModelInput', 'threeDRetextureStyleImageInput'].forEach((inputId) => {
    bindManagedUploadById(inputId);
  });
  const m = qs('threeDModel');
  if (m) m.addEventListener('change', update3dUiVisibility);

  const gt = qs('threeDGenerateType');
  if (gt) gt.addEventListener('change', update3dUiVisibility);
  const pbr = qs('threeDEnablePbr');
  if (pbr) pbr.addEventListener('change', update3dUiVisibility);

  // Text model selector - update options when model changes
  const textModelSel = qs('imageModelText');
  if (textModelSel) textModelSel.addEventListener('change', updateTextModelOptions);
  const gptTextSizeSel = qs('gptImageSize');
  if (gptTextSizeSel) gptTextSizeSel.addEventListener('change', updateGptTextControls);
  bindGptImage2CustomSizePair('gptImageWidth', 'gptImageHeight', 'gptTextCustomSizeHint', 'gptImageSize');

  // Edit model selector - update options and re-clamp images when model changes
  const editModelSel = qs('imageModelEdit');
  if (editModelSel) editModelSel.addEventListener('change', () => {
    updateEditModelOptions();
    updateImagePreview(); // re-clamp if new limit is lower
  });
  const gptEditSizeSel = qs('editImageSize');
  if (gptEditSizeSel) gptEditSizeSel.addEventListener('change', updateGptEditControls);
  bindGptImage2CustomSizePair('editImageWidth', 'editImageHeight', 'gptEditCustomSizeHint', 'editImageSize');

  // --- Download buttons (forceDownload) ---
  const dlBtn = qs('downloadBtn');
  if (dlBtn) dlBtn.addEventListener('click', () => {
    forceDownload(dlBtn.dataset.dlUrl, dlBtn.dataset.dlName);
  });
  const modalDlBtn = qs('mediaModalDownload');
  if (modalDlBtn) modalDlBtn.addEventListener('click', () => {
    forceDownload(modalDlBtn.dataset.dlUrl, modalDlBtn.dataset.dlName);
  });

  // --- Drag & Drop for all static upload zones ---
  setupDropZone(qs('imageDropzone'), qs('imageInput'));
  setupDropZone(qs('maskDropzone'), qs('maskInput'));
  setupDropZone(qs('threeDFrontDropzone'), qs('threeDFrontInput'));
  setupDropZone(qs('threeDBackDropzone'), qs('threeDBackInput'));
  setupDropZone(qs('threeDLeftDropzone'), qs('threeDLeftInput'));
  setupDropZone(qs('threeDRightDropzone'), qs('threeDRightInput'));
  setupDropZone(qs('threeDMeshyTextureImageDropzone'), qs('threeDMeshyTextureImageInput'));
  setupDropZone(qs('threeDTopologyFileDropzone'), qs('threeDTopologyFileInput'));
  setupDropZone(qs('threeDRetextureModelDropzone'), qs('threeDRetextureModelInput'));
  setupDropZone(qs('threeDRetextureStyleImageDropzone'), qs('threeDRetextureStyleImageInput'));
}

function initTasks() {
  let changed = false;

  // Handle interrupted submissions - mark QUEUED/SUBMITTING as FAILED on page reload
  for (const t of tasks) {
    if (!t) continue;
    if (t.status === 'QUEUED' || t.status === 'SUBMITTING') {
      t.status = 'FAILED';
      t.failedAt = Date.now();
      t.error = 'Interrupted - please try again';
      changed = true;
    }
  }

  // Finalize any previously uploaded transient task assets for tasks already in terminal states.
  for (const t of tasks) {
    if (!t) continue;
    if ((t.status === 'COMPLETED' || t.status === 'FAILED') && !t.blobCleanupDone) {
      cleanupTaskUploads(t)
        .then(() => {
          saveTasks();
          renderTasks();
        })
        .catch(() => {
          saveTasks();
        });
    }
  }

  for (const t of tasks) {
    if (!t) continue;

    if (t.status === 'COMPLETED' && !t.savedToHistory) {
      if (t.mode === '3d' && t.mediaUrl) {
        const placeholder3d = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#000"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="#fff" font-family="Arial" font-size="14">3D</text></svg>')}`;
        const fmt = t.modelFormat || 'glb';
        const item = buildTaskHistoryItem(t, '3d', t.thumbUrl || placeholder3d, {
          suffix: '3d',
          timestamp: t.completedAt || Date.now(),
          meta: {
            glbUrl: fmt === 'glb' ? t.mediaUrl : null,
            modelDownloadUrl: t.mediaUrl,
            modelFormat: fmt,
            model_urls: t.model_urls || null,
          },
        });
        item.glbUrl = fmt === 'glb' ? t.mediaUrl : null;
        item.modelDownloadUrl = t.mediaUrl;
        item.modelFormat = fmt;
        item.model_urls = t.model_urls || null;
        t.savedToHistory = true;
        addToHistory(item);
        changed = true;
      }
      if (t.mode !== '3d' && t.mediaUrl) {
        const isToolsSamAudio = t.mode === 'tools' && t.toolsTool === 'sam-audio';
        const isToolsHeygen = t.mode === 'tools' && t.toolsTool === 'heygen-translate';
        const itemType = isToolsSamAudio ? 'audio' : ((t.mode === 'video' || isToolsHeygen) ? 'video' : 'image');
        const item = buildTaskHistoryItem(t, itemType, t.mediaUrl, {
          suffix: itemType,
          timestamp: t.completedAt || Date.now(),
          meta: isToolsSamAudio ? {
            residualUrl: t.secondaryMediaUrl || null,
            outputFormat: qs('toolsSamAudioOutputFormat') ? qs('toolsSamAudioOutputFormat').value : 'wav',
            previewUrl: createAudioPlaceholderDataUrl('AUDIO'),
          } : (isToolsHeygen ? {
            outputLanguage: qs('toolsHeygenOutputLanguage') ? String(qs('toolsHeygenOutputLanguage').value || '').trim() : HEYGEN_TRANSLATE_DEFAULT_LANGUAGE,
            translateAudioOnly: !!(qs('toolsHeygenTranslateAudioOnly') && qs('toolsHeygenTranslateAudioOnly').checked),
            speakerNum: qs('toolsHeygenSpeakerNum') ? (String(qs('toolsHeygenSpeakerNum').value || '').trim() || null) : null,
            enableDynamicDuration: !(qs('toolsHeygenEnableDynamicDuration') && !qs('toolsHeygenEnableDynamicDuration').checked),
            sourceTool: 'heygen-translate',
          } : {}),
        });
        if (isToolsSamAudio) {
          item.thumbnailUrl = createAudioPlaceholderDataUrl('AUDIO');
          item.residualUrl = t.secondaryMediaUrl || null;
        }
        t.savedToHistory = true;
        addToHistory(item);
        changed = true;
      }
    }
  }

  const MAX_TASK_AGE_MS = 60 * 60 * 1000; // 1 hour max age for running tasks

  for (const t of tasks) {
    if (!t) continue;
    const age = Date.now() - (t.startedAt || t.createdAt || Date.now());

    // Kill tasks that are too old
    if (t.status === 'RUNNING' && age > MAX_TASK_AGE_MS) {
      t.status = 'FAILED';
      t.failedAt = Date.now();
      t.error = 'Task expired after being active too long. Please try again.';
      changed = true;
      continue;
    }

    if (t.status === 'FAILED' && t.status_url && isTransientPollError(t.error || '')) {
      if (age > MAX_TASK_AGE_MS) continue; // don't resurrect old tasks
      t.status = 'RUNNING';
      t.error = null;
      t.failedAt = null;
      // preserve retryCount so the 30-retry limit isn't reset across reloads
      changed = true;
    }

    if (t.status === 'RUNNING' && t.status_url) {
      pollTask(t.id);
    }
  }

  if (changed) saveTasks();
}

// Wire global mode buttons if user clicks without inline handler (defensive)
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t) return;
  const btn = t.closest && t.closest('button');
  if (!btn) return;
  if (btn.id === 'mode-text') switchMode('text');
  if (btn.id === 'mode-image') switchMode('image');
  if (btn.id === 'mode-video') switchMode('video');
  if (btn.id === 'mode-3d') switchMode('3d');
});

// Generate thumbnails for history items that don't have them (video + image)
async function generateMissingThumbnails(items = null) {
  if (shouldSkipClientHistoryThumbnailWork()) return;
  const source = Array.isArray(items) && items.length
    ? items
    : history.slice(0, Math.min(history.length, 24)).map((item, index) => ({ item, index }));
  queueVisibleHistoryThumbnails(source);
}

// Prevent model-viewer from opening new windows on touch/click
function initModelViewerTouchFix() {
  document.addEventListener('click', (e) => {
    const mv = e.target.closest && e.target.closest('model-viewer');
    if (mv) {
      // Prevent any default link behavior
      if (e.target.tagName === 'A' || e.target.closest('a')) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }, true);

  // Block context menu on model-viewer (long press on mobile)
  document.addEventListener('contextmenu', (e) => {
    const mv = e.target.closest && e.target.closest('model-viewer');
    if (mv) {
      e.preventDefault();
    }
  });

  // Prevent touch events from triggering navigation
  document.addEventListener('touchstart', (e) => {
    const mv = e.target.closest && e.target.closest('model-viewer');
    if (mv) {
      // Let model-viewer handle camera controls but prevent navigation
      e.target.style.touchAction = 'pan-x pan-y';
    }
  }, { passive: true });
}

// ---- IndexedDB image persistence ----
const WIZ_IDB_NAME = 'nano_wiz_images';
const WIZ_IDB_VER = 1;
function _wizIdbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(WIZ_IDB_NAME, WIZ_IDB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function wizIdbSaveImages() {
  try {
    const toB64 = (f) => new Promise((res) => {
      if (isRemoteAssetItem(f)) {
        res({ __remoteAsset: true, url: f.url, name: f.name, type: f.type, assetType: f.assetType || 'image' });
        return;
      }
      const r = new FileReader(); r.onload = () => res({ name: f.name, type: f.type, data: r.result }); r.readAsDataURL(f);
    });
    const safeB64 = (src) => src ? toB64(src) : Promise.resolve(null);
    const safeB64Arr = (arr) => Promise.all((arr || []).map(toB64));
    // Convert ALL files BEFORE opening the transaction to avoid TransactionInactiveError
    const prodArr = await safeB64Arr(uploadedToolsImages);
    const inspoArr = await safeB64Arr(uploadedInspoImages);
    const editArr = await safeB64Arr(uploadedImageFiles);
    const utilitySource = getToolsUtilitySource();
    const utilityAudioSource = getToolsUtilityAudioSource();
    const utilityVideoSource = getToolsUtilityVideoSource();
    const utilityItem = await safeB64(utilitySource);
    const utilityAudioItem = await safeB64(utilityAudioSource);
    const utilityVideoItem = isRemoteAssetItem(utilityVideoSource) ? await toB64(utilityVideoSource) : null;
    const managedData = {};
    const managedKeys = [
      'maskInput', 'videoInput', 'videoImageInput', 'referenceImagesInput',
      'videoEndImageInput', 'audioInput',
      'kling3StartImageInput', 'kling3EndImageInput', 'kling3VideoInput', 'kling3RefImagesInput',
      'seedance2ReferenceImagesInput', 'seedance2ReferenceVideosInput', 'seedance2ReferenceAudiosInput',
      'threeDFrontInput', 'threeDBackInput', 'threeDLeftInput', 'threeDRightInput',
      'threeDMeshyTextureImageInput', 'threeDTopologyFileInput',
      'threeDRetextureModelInput', 'threeDRetextureStyleImageInput',
    ];
    for (const key of managedKeys) {
      const config = MANAGED_UPLOADS[key];
      if (!config) continue;
      const localFiles = toManagedFileArray(config.getFiles ? config.getFiles() : []);
      const remoteFiles = getManagedUploadRemoteItems(config);
      const allFiles = [...localFiles, ...remoteFiles].filter(Boolean);
      if (allFiles.length > 0) managedData[key] = await safeB64Arr(allFiles);
    }
    const db = await _wizIdbOpen();
    const tx = db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    store.put(prodArr, 'productImages');
    store.put(inspoArr, 'inspoImages');
    store.put(editArr, 'editImages');
    store.put(utilityItem, 'utilityImage');
    store.put(utilityAudioItem, 'utilityAudio');
    store.put(utilityVideoItem, 'utilityVideo');
    store.put(managedData, 'managedUploads');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
  } catch (e) { console.warn('IDB save failed', e); }
}
async function wizIdbRestoreImages() {
  try {
    const db = await _wizIdbOpen();
    const idbKeys = ['productImages', 'inspoImages', 'editImages', 'utilityImage', 'utilityAudio', 'utilityVideo', 'managedUploads'];
    const results = await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readonly');
      const store = tx.objectStore('files');
      const out = {};
      let pending = idbKeys.length;
      for (const key of idbKeys) {
        const req = store.get(key);
        req.onsuccess = () => { out[key] = req.result || null; if (--pending === 0) resolve(out); };
        req.onerror = () => { out[key] = null; if (--pending === 0) resolve(out); };
      }
      tx.onerror = reject;
    });
    db.close();
    const b64ToFile = (item) => {
      if (item && item.__remoteAsset && item.url) {
        return createRemoteAssetItem(item);
      }
      if (!item || !item.data) return null;
      const arr = item.data.split(','); const mime = arr[0].match(/:(.*?);/)[1];
      const bstr = atob(arr[1]); const u8 = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
      return new File([u8], item.name || 'image.jpg', { type: mime });
    };
    if (Array.isArray(results.productImages)) {
      uploadedToolsImages = results.productImages.map(b64ToFile).filter(Boolean);
      updateToolsImagePreview();
    }
    if (Array.isArray(results.inspoImages)) {
      uploadedInspoImages = results.inspoImages.map(b64ToFile).filter(Boolean);
      wizRenderInspoThumbs();
    }
    if (Array.isArray(results.editImages)) {
      uploadedImageFiles = results.editImages.map(b64ToFile).filter(Boolean);
      if (typeof updateImagePreview === 'function') updateImagePreview();
    }
    const restoreSingleManagedUpload = (idbItem, config, localSetter) => {
      const restored = b64ToFile(idbItem);
      if (isRemoteAssetItem(restored)) {
        setManagedUploadRemoteItems(config, restored);
        if (localSetter) localSetter(null);
      } else {
        setManagedUploadRemoteItems(config, []);
        if (localSetter) localSetter(restored);
      }
      const inputEl = config.inputId ? qs(config.inputId) : null;
      if (inputEl && inputEl._uploadConfig) refreshManagedUploadUi(inputEl);
    };
    restoreSingleManagedUpload(results.utilityImage, MANAGED_UPLOADS.toolsUtilityImageInput, (v) => { uploadedToolsUtilityImage = v; });
    restoreSingleManagedUpload(results.utilityAudio, MANAGED_UPLOADS.toolsUtilityAudioInput, (v) => { uploadedToolsUtilityAudio = v; });
    restoreSingleManagedUpload(results.utilityVideo, MANAGED_UPLOADS.toolsUtilityVideoInput, (v) => { uploadedToolsUtilityVideo = v; });
    const managedData = results.managedUploads;
    if (managedData && typeof managedData === 'object') {
      const managedSetters = {
        maskInput: (v) => { uploadedMaskFile = v; },
        videoInput: (v) => { uploadedVideoFile = v; },
        videoImageInput: (v) => { uploadedVideoImageFile = v; },
        referenceImagesInput: (v) => { uploadedReferenceImages = v; },
        videoEndImageInput: (v) => { uploadedEndImageFile = v; },
        audioInput: (v) => { uploadedAudioFile = v; },
        kling3StartImageInput: (v) => { uploadedKling3StartImage = v; },
        kling3EndImageInput: (v) => { uploadedKling3EndImage = v; },
        kling3VideoInput: (v) => { uploadedKling3Video = v; },
        kling3RefImagesInput: (v) => { uploadedKling3RefImages = v; },
        seedance2ReferenceImagesInput: (v) => { uploadedSeedanceReferenceImages = v; },
        seedance2ReferenceVideosInput: (v) => { uploadedSeedanceReferenceVideos = v; },
        seedance2ReferenceAudiosInput: (v) => { uploadedSeedanceReferenceAudios = v; },
        threeDFrontInput: (v) => { uploaded3dFrontFile = v; },
        threeDBackInput: (v) => { uploaded3dBackFile = v; },
        threeDLeftInput: (v) => { uploaded3dLeftFile = v; },
        threeDRightInput: (v) => { uploaded3dRightFile = v; },
        threeDMeshyTextureImageInput: (v) => { uploaded3dMeshyTextureImageFile = v; },
        threeDTopologyFileInput: (v) => { uploaded3dTopologyFile = v; },
        threeDRetextureModelInput: (v) => { uploaded3dRetextureModelFile = v; },
        threeDRetextureStyleImageInput: (v) => { uploaded3dRetextureStyleImageFile = v; },
      };
      for (const [key, setter] of Object.entries(managedSetters)) {
        const savedArr = managedData[key];
        if (!Array.isArray(savedArr) || savedArr.length === 0) continue;
        const config = MANAGED_UPLOADS[key];
        if (!config) continue;
        const restored = savedArr.map(b64ToFile).filter(Boolean);
        const localFiles = restored.filter((f) => !isRemoteAssetItem(f));
        const remoteFiles = restored.filter((f) => isRemoteAssetItem(f));
        if (remoteFiles.length > 0) setManagedUploadRemoteItems(config, config.multiple ? remoteFiles : remoteFiles[0]);
        if (config.multiple) {
          setter(localFiles);
        } else {
          setter(localFiles[0] || null);
        }
        const inputEl = config.inputId ? qs(config.inputId) : null;
        if (inputEl && inputEl._uploadConfig) refreshManagedUploadUi(inputEl);
      }
    }
  } catch (e) { console.warn('IDB restore failed', e); }
}

// ---- localStorage Persistence ----
const APP_STATE_KEY = 'nano_app_state';
const APP_STATE_VERSION = 2;

const PERSISTED_SELECTS = [
  'imageModelText', 'imageModelEdit', 'editOutputFormat', 'editImageSize', 'editQuality',
  'gptImageSize', 'gptQuality', 'gptBackground', 'gptSyncMode', 'editSyncMode',
  'editBackground', 'editInputFidelity', 'editNanoResolution', 'editNanoWebSearch', 'editNanoAspectRatio',
  'nano2Resolution', 'nano2SafetyTolerance', 'nano2WebSearch', 'nano2GoogleSearch',
  'editNano2Resolution', 'editNano2SafetyTolerance', 'editNano2WebSearch', 'editNano2GoogleSearch', 'editNano2AspectRatio',
  'threeDModel', 'threeDGenerateType', 'threeDEnablePbr', 'threeDPolygonType',
  'threeDMeshyMode', 'threeDMeshyArtStyle', 'threeDMeshyTopology', 'threeDMeshySymmetryMode',
  'threeDMeshyShouldRemesh', 'threeDMeshyShouldTexture', 'threeDMeshyEnablePbr',
  'threeDMeshyIsATPose', 'threeDMeshyEnablePromptExpansion', 'threeDMeshyEnableSafetyChecker',
  'threeDRapidEnablePbr', 'threeDRapidEnableGeometry',
  'threeDTopologyFileType', 'threeDTopologyPolygonType', 'threeDTopologyFaceLevel',
  'threeDRetextureOriginalUv', 'threeDRetextureEnablePbr', 'threeDRetextureEnableSafety',
  'videoModel',
  'kling3Duration', 'kling3AspectRatio', 'kling3ShotType', 'kling3CfgScale',
  'kling3GenerateAudio', 'kling3KeepAudio',
  'kling3MotionOrientation', 'kling3KeepOriginalSound',
  'toolsHeygenOutputLanguage',
  'aspectRatioBase', 'toolsOutputFormat',
  'toolsModel', 'toolsResolution', 'toolsAspectRatio', 'toolsWebSearch', 'toolsGoogleSearch',
  'toolsGptImageSize', 'toolsGptQuality', 'toolsGptOutputFormat', 'toolsGptBackground', 'toolsGptFidelity',
  'toolsEnhancerModel', 'toolsEnhancerOutputFormat', 'toolsEnhancerSubjectDetection', 'toolsEnhancerCreativity', 'toolsEnhancerTexture',
  'toolsSamAudioModel', 'toolsSamAudioOutputFormat', 'toolsSamAudioAcceleration',
  'toolsBgOutputFormat', 'toolsBgSyncMode',
];

const PERSISTED_INPUTS = [
  'promptInput',
  'threeDFaceCount', 'threeDMeshyTargetPolycount', 'threeDMeshySeed',
  'threeDMeshyTexturePrompt', 'threeDMeshyTextureImageUrl',
  'threeDRetextureStylePrompt',
  'kling3VoiceIds', 'kling3NegativePrompt', 'kling3VideoUrlInput',
  'nano2Seed', 'editNano2Seed',
  'gptImageWidth', 'gptImageHeight', 'editImageWidth', 'editImageHeight',
  'toolsTitleInput', 'toolsFontInput', 'toolsWishesInput', 'toolsSeed', 'toolsGptImageWidth', 'toolsGptImageHeight',
  'toolsEnhancerUpscaleFactor', 'toolsEnhancerFaceStrength', 'toolsEnhancerFaceCreativity',
  'toolsEnhancerSharpen', 'toolsEnhancerDenoise', 'toolsEnhancerFixCompression',
  'toolsEnhancerStrength', 'toolsEnhancerDetail', 'toolsEnhancerPrompt',
  'toolsSamAudioPrompt', 'toolsSamAudioRerankingCandidates', 'toolsSamAudioMaxChunkDuration', 'toolsSamAudioChunkOverlap',
  'toolsHeygenSpeakerNum',
];

const PERSISTED_CHECKBOXES = [
  'toolsInspoMatchBg',
  'toolsEnhancerCropToFill', 'toolsEnhancerFaceEnhancement', 'toolsEnhancerAutoprompt',
  'toolsSamAudioPredictSpans', 'toolsSamAudioUseSoundActivityRanking', 'toolsSamAudioTrimToSpan',
  'toolsHeygenTranslateAudioOnly', 'toolsHeygenEnableDynamicDuration',
];

const APP_STATE_CONTROL_SELECTOR = 'select[id], textarea[id], input[id]';
const APP_STATE_TRANSIENT_CONTROL_IDS = new Set([
  'historySearchInput',
  'fhgSearchInput',
  'pmAddInput',
  'wizFontSearch',
]);
let _appPersistenceHooked = false;
let _pendingAppControlApplyFrame = null;
let _appPersistenceMutationObserver = null;

function isPersistableAppControl(el) {
  if (!el || !el.id || APP_STATE_TRANSIENT_CONTROL_IDS.has(el.id)) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag !== 'SELECT' && tag !== 'TEXTAREA' && tag !== 'INPUT') return false;
  if (tag === 'INPUT') {
    const type = String(el.type || 'text').toLowerCase();
    if (type === 'file' || type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return false;
  }
  return true;
}

function readPersistableControlValue(el) {
  if (!isPersistableAppControl(el)) return undefined;
  const tag = String(el.tagName || '').toUpperCase();
  const type = String(el.type || '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') return !!el.checked;
  if (tag === 'SELECT' && el.multiple) return Array.from(el.selectedOptions || []).map((option) => option.value);
  if (tag === 'SELECT' && el.options && el.options.length === 0 && !el.value) return undefined;
  return el.value;
}

function dispatchPersistedControlEvents(el, changed, includeInput = false) {
  if (!changed) return;
  if (includeInput) el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function writePersistableControlValue(el, value) {
  if (!isPersistableAppControl(el)) return true;
  const tag = String(el.tagName || '').toUpperCase();
  const type = String(el.type || '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') {
    const nextChecked = !!value;
    const changed = el.checked !== nextChecked;
    el.checked = nextChecked;
    dispatchPersistedControlEvents(el, changed, false);
    return true;
  }
  if (tag === 'SELECT') {
    if (el.options && el.options.length === 0) return false;
    if (el.multiple && Array.isArray(value)) {
      const selected = new Set(value.map((entry) => String(entry)));
      let changed = false;
      Array.from(el.options || []).forEach((option) => {
        const nextSelected = selected.has(option.value);
        if (option.selected !== nextSelected) changed = true;
        option.selected = nextSelected;
      });
      dispatchPersistedControlEvents(el, changed, false);
      return true;
    }
    const nextValue = value == null ? '' : String(value);
    const hasOption = !el.options || el.options.length === 0 || Array.from(el.options).some((option) => option.value === nextValue);
    if (!hasOption && nextValue !== '') return true;
    const changed = el.value !== nextValue;
    el.value = nextValue;
    dispatchPersistedControlEvents(el, changed, false);
    return true;
  }
  const nextValue = value == null ? '' : String(value);
  const changed = el.value !== nextValue;
  el.value = nextValue;
  dispatchPersistedControlEvents(el, changed, true);
  return true;
}

function mergeLegacyControlState(state) {
  const controls = state && state.controls && typeof state.controls === 'object' ? { ...state.controls } : {};
  const buckets = [state && state.selects, state && state.inputs, state && state.checkboxes];
  buckets.forEach((bucket) => {
    if (!bucket || typeof bucket !== 'object') return;
    Object.entries(bucket).forEach(([id, value]) => {
      if (controls[id] === undefined) controls[id] = value;
    });
  });
  return controls;
}

function capturePersistedControls(state, previousState) {
  const controls = previousState && previousState.controls && typeof previousState.controls === 'object'
    ? { ...previousState.controls }
    : {};
  document.querySelectorAll(APP_STATE_CONTROL_SELECTOR).forEach((el) => {
    const value = readPersistableControlValue(el);
    if (value !== undefined) {
      controls[el.id] = value;
      if (window._pendingAppControlState && typeof window._pendingAppControlState === 'object') {
        window._pendingAppControlState[el.id] = value;
      }
    }
  });
  state.controls = controls;
}

function applyPendingPersistedControls() {
  const pending = window._pendingAppControlState;
  if (!pending || typeof pending !== 'object') return;
  Object.keys(pending).forEach((id) => {
    const el = qs(id);
    if (!el) return;
    writePersistableControlValue(el, pending[id]);
  });
}

function queueApplyPendingPersistedControls() {
  if (_pendingAppControlApplyFrame !== null) return;
  const apply = () => {
    _pendingAppControlApplyFrame = null;
    applyPendingPersistedControls();
  };
  if (window.requestAnimationFrame) _pendingAppControlApplyFrame = window.requestAnimationFrame(apply);
  else _pendingAppControlApplyFrame = window.setTimeout(apply, 0);
}

function restorePersistedControls(state) {
  window._pendingAppControlState = mergeLegacyControlState(state);
  applyPendingPersistedControls();
}

function handlePersistableControlEvent(event) {
  const el = event && event.target;
  if (!isPersistableAppControl(el)) return;
  if (typeof saveAppState === 'function') saveAppState();
}
function applyCardStudioToolsDefaultsToState(state, options = {}) {
  const force = !!(options && options.force);
  const currentVersion = Number(state && state.version) || 0;
  if (!force && currentVersion >= APP_STATE_VERSION) return false;
  if (!state || typeof state !== 'object') return false;
  if (!state.selects || typeof state.selects !== 'object') state.selects = {};
  if (!state.inputs || typeof state.inputs !== 'object') state.inputs = {};
  state.selects.toolsModel = DEFAULT_TOOLS_MODEL;
  state.selects.toolsGptImageSize = GPT_IMAGE_2_TOOLS_DEFAULT_SIZE;
  state.selects.toolsGptQuality = 'high';
  state.selects.toolsGptOutputFormat = 'png';
  state.inputs.toolsGptImageWidth = String(GPT_IMAGE_2_TOOLS_DEFAULT_WIDTH);
  state.inputs.toolsGptImageHeight = String(GPT_IMAGE_2_TOOLS_DEFAULT_HEIGHT);
  state.version = APP_STATE_VERSION;
  return true;
}

let _appStateRestoring = true;
function saveAppState() {
  if (_appStateRestoring) return;
  // Only clear the saved-state shadow when the user is actually in the video
  // section, the live DOM holds the real value, AND no async video restore is
  // still pending. While _pendingVideoRestore is set the videoModel <select>
  // exists but has no options yet, so we must keep the shadow intact.
  if (window._savedVideoState && currentMode === 'video' && !window._pendingVideoRestore) {
    window._savedVideoState = null;
  }
  try {
    // Read previously saved state so we can preserve values for DOM elements
    // that don't exist in the current mode (e.g. video controls when in text mode).
    let _prevSaved = null;
    try { _prevSaved = JSON.parse(localStorage.getItem(APP_STATE_KEY) || 'null'); } catch (_) {}
    const state = {
      version: APP_STATE_VERSION,
      mode: currentMode,
      videoTab: currentVideoTab,
      kling3Family: currentKling3Family,
      kling3Tab: currentKling3Tab,
      ltx23Family: currentLtx23Family,
      seedance2Family: currentSeedance2Family,
      kling3LastTabByFamily: Object.assign({}, kling3LastTabByFamily),
      toolsTool: currentToolsTool,
      videoEngine: window._currentVideoEngine || (_prevSaved && _prevSaved.videoEngine) || '',
      selects: {},
      inputs: {},
      checkboxes: {},
    };
    for (const id of PERSISTED_SELECTS) {
      const el = qs(id);
      if (el && !(el.options && el.options.length === 0 && !el.value)) { state.selects[id] = el.value; }
      else if (_prevSaved && _prevSaved.selects && _prevSaved.selects[id] !== undefined) {
        state.selects[id] = _prevSaved.selects[id];
      }
    }
    for (const id of PERSISTED_INPUTS) {
      const el = qs(id);
      if (el) { state.inputs[id] = el.value; }
      else if (_prevSaved && _prevSaved.inputs && _prevSaved.inputs[id] !== undefined) {
        state.inputs[id] = _prevSaved.inputs[id];
      }
    }
    for (const id of PERSISTED_CHECKBOXES) {
      const el = qs(id);
      if (el) { state.checkboxes[id] = !!el.checked; }
      else if (_prevSaved && _prevSaved.checkboxes && _prevSaved.checkboxes[id] !== undefined) {
        state.checkboxes[id] = _prevSaved.checkboxes[id];
      }
    }
    capturePersistedControls(state, _prevSaved);
    // Only save kling3Model if the current video selection actually is a Kling model.
    const currentVideoModelEl = qs('videoModel');
    const currentVideoModelId = currentVideoModelEl ? String(currentVideoModelEl.value || '').trim() : '';
    const isCurrentKling = currentVideoModelId && isKling3VideoModelId(currentVideoModelId);
    if (isCurrentKling) {
      state.selects.kling3Model = currentVideoModelId;
    } else {
      // Strip any stale kling3Model so it doesn't auto-restore Kling later.
      delete state.selects.kling3Model;
    }
    if (Object.keys(kling3SelectedModelByTab).length) state.kling3SelectedModelByTab = Object.assign({}, kling3SelectedModelByTab);
    if (Object.keys(ltx23SelectedModelByFamily).length) state.ltx23SelectedModelByFamily = Object.assign({}, ltx23SelectedModelByFamily);
    if (Object.keys(seedance2SelectedModelByFamily).length) state.seedance2SelectedModelByFamily = Object.assign({}, seedance2SelectedModelByFamily);
    // Capture latest dynamic video option values for the current model before persisting.
    try { captureVideoOptionsToMemory(); } catch (_) {}
    if (videoOptionsByModel && Object.keys(videoOptionsByModel).length) {
      try { state.videoOptionsByModel = JSON.parse(JSON.stringify(videoOptionsByModel)); } catch (_) {}
    }
    if (currentPreview && typeof currentPreview === 'object') {
      try { state.currentPreview = JSON.parse(JSON.stringify(currentPreview)); } catch (_) {}
    }
    if (galleryItems.length > 0) {
      try { state.galleryItems = JSON.parse(JSON.stringify(galleryItems)); } catch (_) {}
      state.galleryIndex = galleryIndex;
    }
    // Wizard-specific state
    if (typeof _wizStep === 'number') state.wizStep = _wizStep;
    // Characteristics
    const charEls = document.querySelectorAll('.tools-char-item input[type="text"], .tools-char-item textarea.wiz-char-input');
    const charVals = [];
    charEls.forEach(inp => { if (inp.value.trim()) charVals.push(inp.value.trim()); });
    if (charVals.length) state.wizChars = charVals;
    // Selected inspiration presets
    if (_wizSelectedPresets && _wizSelectedPresets.size > 0) {
      state.wizSelectedPresets = Array.from(_wizSelectedPresets);
    }
    const samAudioSpans = getToolsSamAudioSpanState();
    if (samAudioSpans.length) {
      state.samAudioSpans = samAudioSpans;
    }
    if (Array.isArray(kling3MultiPrompts) && kling3MultiPrompts.length) {
      state.kling3MultiPrompts = kling3MultiPrompts
        .map((item) => ({ id: item && item.id ? item.id : Date.now(), prompt: String(item && item.prompt || ''), duration: String(item && item.duration || '5') }))
        .filter((item) => item.prompt || item.duration);
    }
    localStorage.setItem(APP_STATE_KEY, JSON.stringify(state));
    wizIdbSaveImages();
  } catch (e) { /* quota exceeded or private mode */ }
}

function restoreAppState() {
  try {
    const raw = localStorage.getItem(APP_STATE_KEY);
    if (!raw) return false;
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object') return false;
    const migrated = applyCardStudioToolsDefaultsToState(state);
    if (migrated) {
      try {
        localStorage.setItem(APP_STATE_KEY, JSON.stringify(state));
      } catch (e) { /* ignore persistence errors */ }
    }

    // Restore select values
    if (state.selects) {
      for (const [id, val] of Object.entries(state.selects)) {
        const el = qs(id);
        if (el) {
          el.value = val;
          if (!el.value && el.options && el.options.length > 0) {
            el.value = el.options[0].value;
          }
        }
      }
      const heygenLanguageSelect = qs('toolsHeygenOutputLanguage');
      if (heygenLanguageSelect && state.selects.toolsHeygenOutputLanguage) {
        heygenLanguageSelect.dataset.pendingValue = String(state.selects.toolsHeygenOutputLanguage);
      }
    }

    // Restore input values
    if (state.inputs) {
      for (const [id, val] of Object.entries(state.inputs)) {
        const el = qs(id);
        if (el) el.value = val || '';
      }
    }

    // Restore checkbox values
    if (state.checkboxes) {
      for (const [id, val] of Object.entries(state.checkboxes)) {
        const el = qs(id);
        if (el) el.checked = !!val;
      }
    }

    restorePersistedControls(state);

    // Restore mode and tabs
    if (state.videoTab) currentVideoTab = state.videoTab;
    if (state.kling3Family) currentKling3Family = state.kling3Family;
    if (state.kling3Tab) currentKling3Tab = state.kling3Tab;
    if (state.toolsTool && TOOLS_TOOL_IDS.has(state.toolsTool)) currentToolsTool = state.toolsTool;
    if (state.ltx23Family) currentLtx23Family = state.ltx23Family;
    if (state.seedance2Family) currentSeedance2Family = state.seedance2Family;
    if (state.videoEngine) window._currentVideoEngine = state.videoEngine;
    if (state.kling3LastTabByFamily && typeof state.kling3LastTabByFamily === 'object') {
      Object.assign(kling3LastTabByFamily, state.kling3LastTabByFamily);
    }
    if (state.kling3SelectedModelByTab && typeof state.kling3SelectedModelByTab === 'object') {
      Object.assign(kling3SelectedModelByTab, state.kling3SelectedModelByTab);
    }
    if (state.ltx23SelectedModelByFamily && typeof state.ltx23SelectedModelByFamily === 'object') {
      Object.assign(ltx23SelectedModelByFamily, state.ltx23SelectedModelByFamily);
    }
    if (state.videoOptionsByModel && typeof state.videoOptionsByModel === 'object') {
      videoOptionsByModel = state.videoOptionsByModel;
    }
    if (state.seedance2SelectedModelByFamily && typeof state.seedance2SelectedModelByFamily === 'object') {
      Object.assign(seedance2SelectedModelByFamily, state.seedance2SelectedModelByFamily);
    }
    if (Array.isArray(state.kling3MultiPrompts)) {
      kling3MultiPrompts = state.kling3MultiPrompts.map((item, index) => ({
        id: item && item.id ? item.id : Date.now() + index,
        prompt: String(item && item.prompt || ''),
        duration: String(item && item.duration || '5'),
      }));
      if (typeof renderKling3MultiPrompts === 'function') renderKling3MultiPrompts();
    }
    window._restoredPreviewState = {
      preview: state.currentPreview || null,
      gallery: state.galleryItems || null,
      galleryIndex: typeof state.galleryIndex === 'number' ? state.galleryIndex : 0,
    };
    // Determine the effective video model ID from saved state (videoModel is the source of truth).
    const savedVideoModelId = String(
      (state.selects && state.selects.videoModel !== undefined ? state.selects.videoModel : null)
      || (state.controls && state.controls.videoModel !== undefined ? state.controls.videoModel : '')
      || ''
    ).trim();
    // Only sync Kling state if the saved video model is actually a Kling model.
    if (savedVideoModelId && isKling3VideoModelId(savedVideoModelId)) {
      const klingTab = getKling3TabForModelId(savedVideoModelId);
      if (klingTab) {
        currentKling3Tab = klingTab;
        currentKling3Family = getKling3FamilyForTab(klingTab);
        kling3SelectedModelByTab[klingTab] = savedVideoModelId;
        if (!state.videoTab) {
          const mappedVideoTab = getVideoTabForKling3Tab(klingTab);
          if (mappedVideoTab) currentVideoTab = mappedVideoTab;
        }
      }
    } else if (!state.videoTab && state.kling3Tab) {
      // Only fall back to Kling tab if we have no videoTab AND no concrete saved video model.
      const mappedVideoTab = getVideoTabForKling3Tab(state.kling3Tab);
      if (mappedVideoTab) currentVideoTab = mappedVideoTab;
    }

    // Stash wizard state for initToolsControls to pick up
    window._wizRestoredState = {
      step: typeof state.wizStep === 'number' ? state.wizStep : null,
      chars: Array.isArray(state.wizChars) ? state.wizChars : null,
      selectedPresets: Array.isArray(state.wizSelectedPresets) ? state.wizSelectedPresets : null,
    };
    window._samAudioRestoredSpans = Array.isArray(state.samAudioSpans) ? state.samAudioSpans : null;

    requestAnimationFrame(autoResizePromptInput);

    return 'tools';
  } catch (e) {
    return false;
  }
}

function hookPersistence() {
  if (_appPersistenceHooked) return;
  _appPersistenceHooked = true;
  document.addEventListener('input', handlePersistableControlEvent, true);
  document.addEventListener('change', handlePersistableControlEvent, true);
  if (window.MutationObserver && document.body) {
    _appPersistenceMutationObserver = new MutationObserver((mutations) => {
      if (!window._pendingAppControlState) return;
      for (const mutation of mutations) {
        if (mutation.addedNodes && mutation.addedNodes.length) {
          queueApplyPendingPersistedControls();
          return;
        }
      }
    });
    _appPersistenceMutationObserver.observe(document.body, { childList: true, subtree: true });
  }
  queueApplyPendingPersistedControls();
}

function refreshLocalizedDynamicUi() {
  closeToolsHelpPopover();
  initTopazHelpButtons();
  wizRenderInspoPresets();
  wizRenderFontPresets();
  refreshAllManagedUploads();
  updateSeedance2ReferenceUi();
  refreshToolsUtilitySourceUi();
  updateToolsEnhancerUi();
  const samAudioSpans = getToolsSamAudioSpanState();
  if (samAudioSpans.length) restoreToolsSamAudioSpanState(samAudioSpans);
  updateToolsSamAudioUi();
  updateToolsHeygenUi();
  localizeVideoOptionFields(qs('videoOptionsDynamic'));
  if (typeof renderKling3Elements === 'function') renderKling3Elements();

  const previewArea = qs('previewArea');
  if (previewArea) bindAssetDragSource(previewArea, currentPreview);
  const img = qs('resultImage');
  if (img) bindAssetDragSource(img, currentPreview && currentPreview.type === 'image' ? currentPreview : null, { badge: false });
  const vid = qs('resultVideo');
  if (vid) bindAssetDragSource(vid, currentPreview && currentPreview.type === 'video' ? currentPreview : null, { badge: false });
  const audioPane = qs('resultAudioPane');
  if (currentPreview && currentPreview.type === 'audio' && audioPane) {
    renderAudioPreview(currentPreview);
  }
  if (audioPane) bindAssetDragSource(audioPane, currentPreview && currentPreview.type === 'audio' ? currentPreview : null, { badge: false });

  const modalBody = qs('mediaModalBody');
  if (modalBody) {
    bindAssetDragSource(modalBody, currentPreview);
    const modalMedia = modalBody.querySelector('img, video, audio');
    if (modalMedia) bindAssetDragSource(modalMedia, currentPreview, { badge: false });
  }
}

function hookNewsLocaleUpdates() {
  if (!window.I18N || !window.I18N.applyLocale || window._localeUiHooked) return;
  window._localeUiHooked = true;
  const originalApplyLocale = window.I18N.applyLocale.bind(window.I18N);
  window.I18N.applyLocale = function() {
    originalApplyLocale.call(this);
    refreshModelNews(true);
    renderTasks();
    if (typeof updateHistoryUI === 'function') updateHistoryUI();
    refreshLocalizedDynamicUi();
  };
}

function clearPreviewDisplay() {
  currentPreview = null;
  galleryItems = [];
  galleryIndex = 0;
  const img = qs('resultImage');
  const vid = qs('resultVideo');
  const audioPane = qs('resultAudioPane');
  const model = qs('resultModel');
  const placeholder = qs('placeholder');
  const dl = qs('downloadBtn');
  const assetBtn = qs('useAsAssetBtn');
  if (img) { img.style.display = 'none'; img.removeAttribute('src'); }
  if (vid) { if (typeof vid.pause === 'function') vid.pause(); vid.style.display = 'none'; vid.removeAttribute('src'); vid.removeAttribute('poster'); }
  if (audioPane) { audioPane.style.display = 'none'; audioPane.innerHTML = ''; }
  if (model) { model.style.display = 'none'; model.removeAttribute('src'); }
  if (placeholder) placeholder.style.display = 'flex';
  if (dl) dl.style.display = 'none';
  if (assetBtn) assetBtn.style.display = 'none';
}

function getTextPresetStoresSnapshot() {
  return {
    titleStore: _getStoreForKey(TITLE_PRESETS_KEY),
    charStore: _getStoreForKey(CHAR_PRESETS_KEY),
  };
}

function normalizePresetCreatedAt(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return new Date().toISOString();
    if (/^\d{10,17}$/.test(trimmed)) {
      const numeric = Number(trimmed);
      const date = new Date(numeric);
      return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function normalizeCustomPresetForState(preset) {
  if (!preset) return null;
  const fallbackPrefix = isFontCustomPresetId(preset.id) || preset.bucket === PRESET_BUCKET_FONT ? 'font-preset' : 'custom-preset';
  return {
    id: normalizeCustomPresetId(preset.id, fallbackPrefix),
    name: preset.name || 'Custom Preset',
    dataUrl: preset.dataUrl || null,
    src: preset.src || preset.dataUrl || null,
    storagePath: preset.storagePath || null,
    createdAt: normalizePresetCreatedAt(preset.createdAt || preset.addedAt),
  };
}

function getDesignPresetStateSnapshot() {
  return {
    hiddenBuiltins: [..._wizHiddenBuiltins],
    nameOverrides: { ..._wizPresetNameOverrides },
    customPresets: _wizCustomPresets.map((preset) => normalizeCustomPresetForState(preset)).filter(Boolean),
    fontCustomPresets: _wizFontCustomPresets.map((preset) => normalizeCustomPresetForState(preset)).filter(Boolean),
  };
}

async function getLegacyCustomPresets(bucket = PRESET_BUCKET_INSPO) {
  const items = await _inspoIdbLoadAll('__guest__', bucket);
  return items.map((preset) => normalizeCustomPresetForState(preset)).filter(Boolean);
}

function getLegacyStoreForKey(key) {
  const store = readStoredJson(key, {});
  return store && typeof store === 'object' ? store : {};
}

async function getLegacyMigrationPayload() {
  const historyItems = readStoredJson('nano_history', []);
  const titleStore = getLegacyStoreForKey(TITLE_PRESETS_KEY);
  const charStore = getLegacyStoreForKey(CHAR_PRESETS_KEY);
  const hiddenBuiltinsRaw = readStoredJson(INSPO_HIDDEN_KEY, []);
  const hiddenBuiltins = Array.isArray(hiddenBuiltinsRaw) ? hiddenBuiltinsRaw : [];
  const nameOverrides = readStoredJson(INSPO_NAMES_KEY, {});
  const customPresets = await getLegacyCustomPresets(PRESET_BUCKET_INSPO);
  const fontCustomPresets = await getLegacyCustomPresets(PRESET_BUCKET_FONT);
  return {
    history: Array.isArray(historyItems) ? historyItems : [],
    titleStore,
    charStore,
    designPresetState: {
      hiddenBuiltins,
      nameOverrides: nameOverrides && typeof nameOverrides === 'object' ? nameOverrides : {},
      customPresets,
      fontCustomPresets,
    },
  };
}

async function clearLegacyMigrationData(markerUserId) {
  ['nano_history', 'nano_tasks', TITLE_PRESETS_KEY, CHAR_PRESETS_KEY, INSPO_HIDDEN_KEY, INSPO_NAMES_KEY, INSPO_STATE_META_KEY, INSPO_SELECTED_KEY, FONT_SELECTED_KEY].forEach((key) => localStorage.removeItem(key));
  try {
    await _inspoIdbReplaceAllForOwner('__guest__', [], PRESET_BUCKET_INSPO);
    await _inspoIdbReplaceAllForOwner('__guest__', [], PRESET_BUCKET_FONT);
  } catch (error) {
    console.warn('Failed to clear guest design preset cache', error);
  }
  localStorage.setItem('nano_account_migration', JSON.stringify({
    consumed: true,
    userId: markerUserId || null,
    consumedAt: new Date().toISOString(),
  }));
}

function applyTextPresetStores(titleStore, charStore) {
  withAccountSyncSuspended(() => {
    _saveStoreForKey(TITLE_PRESETS_KEY, titleStore || {});
    _saveStoreForKey(CHAR_PRESETS_KEY, charStore || {});
  });
}

async function applyDesignPresetState(state) {
  const nextState = state || {};
  const ownerKey = getInspoPresetOwnerKey();
  withAccountSyncSuspended(() => {
    _wizHiddenBuiltins = new Set(Array.isArray(nextState.hiddenBuiltins) ? nextState.hiddenBuiltins : []);
    _wizPresetNameOverrides = nextState.nameOverrides && typeof nextState.nameOverrides === 'object' ? { ...nextState.nameOverrides } : {};
    _wizCustomPresets = (Array.isArray(nextState.customPresets) ? nextState.customPresets : []).map((preset) => ({
      ...normalizeCustomPresetForState(preset),
      ownerKey,
      bucket: PRESET_BUCKET_INSPO,
    })).filter(Boolean);
    _wizFontCustomPresets = (Array.isArray(nextState.fontCustomPresets) ? nextState.fontCustomPresets : []).map((preset) => ({
      ...normalizeCustomPresetForState(preset),
      ownerKey,
      bucket: PRESET_BUCKET_FONT,
    })).filter(Boolean);
    inspoSaveLocalMeta({ markDirty: false });
    restoreInspoSelectedPresets();
    restoreFontSelectedPresets();
  });
  try {
    await _inspoIdbReplaceAllForOwner(ownerKey, _wizCustomPresets, PRESET_BUCKET_INSPO);
    await _inspoIdbReplaceAllForOwner(ownerKey, _wizFontCustomPresets, PRESET_BUCKET_FONT);
  } catch (error) {
    console.warn('Failed to cache scoped design presets', error);
  }
  wizRenderInspoPresets();
  wizRenderFontPresets();
}

function mergePersistedHistoryItems(localItems, savedItems) {
  const list = Array.isArray(localItems) ? localItems : [localItems];
  const saved = Array.isArray(savedItems) ? savedItems : [savedItems];
  saved.forEach((savedItem, index) => {
    const target = list[index];
    if (!target || !savedItem) return;
    const preservedThumbnail = hasUsableHistoryPreview(target) ? target.thumbnailUrl : null;
    Object.assign(target, savedItem, { cloud: true });
    if (preservedThumbnail && !hasUsableHistoryPreview(target)) {
      target.thumbnailUrl = preservedThumbnail;
    }
    delete target.__accountPersistQueued;
    if (currentPreview === target) displayResult(target);
    if (!hasUsableHistoryPreview(target)) queueHistoryThumbnailForItem(target, index);
  });
  saveHistory();
  scheduleHistoryUIUpdate();
}

function replaceHistoryFromAccount(items, options = {}) {
  const persist = options.persist !== false;
  history = dedupeHistoryItems(Array.isArray(items) ? items.slice() : []);
  if (persist) saveHistory();
  else persistHistoryCacheMeta(history, undefined, { persistedCount: Math.min(Array.isArray(history) ? history.length : 0, LOCAL_HISTORY_CACHE_LIMIT) });
  scheduleHistoryUIUpdate();
  if (_fhgState.open) renderFhgGallery();
  generateMissingThumbnails();
}

function appendHistoryFromAccount(items, options = {}) {
  if (!Array.isArray(items) || !items.length) return;
  const persist = options.persist !== false;
  const previousKeys = new Set((Array.isArray(history) ? history : []).map((item, index) => getHistoryIdentityKey(item, index)));
  history = dedupeHistoryItems([...(Array.isArray(history) ? history : []), ...items]);
  const changed = items.some((incoming) => !previousKeys.has(getHistoryIdentityKey(incoming))) || history.length !== previousKeys.size;
  if (!changed) {
    if (!persist) persistHistoryCacheMeta(history, undefined, { persistedCount: Math.min(Array.isArray(history) ? history.length : 0, LOCAL_HISTORY_CACHE_LIMIT) });
    return;
  }
  if (persist) saveHistory();
  else persistHistoryCacheMeta(history, undefined, { persistedCount: Math.min(Array.isArray(history) ? history.length : 0, LOCAL_HISTORY_CACHE_LIMIT) });
  scheduleHistoryUIUpdate();
  if (_fhgState.open) renderFhgGallery();
  generateMissingThumbnails();
}

function replaceTasksFromScopedStorage() {
  tasks = loadStoredArray('nano_tasks');
  initTasks();
  renderTasks();
}

function setAccountStorageScope(userId, options = {}) {
  const previousScope = getActiveAccountStorageScope();
  setActiveAccountStorageScope(userId);
  const nextScope = getActiveAccountStorageScope();
  if (previousScope !== nextScope) {
    wizLoadInspoPresets().catch((error) => {
      console.warn('Failed to refresh inspiration presets for storage scope', error);
    });
    wizLoadFontPresets().catch((error) => {
      console.warn('Failed to refresh font presets for storage scope', error);
    });
  }
  if (options.loadHistory) replaceHistoryFromAccount(loadStoredArray('nano_history'), { persist: false });
  if (options.loadTasks !== false) replaceTasksFromScopedStorage();
}

function readScopedStoreSnapshot(baseKey, scope) {
  const store = readStoredJson(getScopedStorageKey(baseKey, scope), {});
  return store && typeof store === 'object' ? store : {};
}

function countScopedCustomEntries(store) {
  return Object.values(store || {}).reduce((sum, entry) => sum + (Array.isArray(entry && entry.custom) ? entry.custom.length : 0), 0);
}

async function getScopedLocalAccountData(userId, options = {}) {
  const scope = userId ? String(userId) : null;
  const includeHistory = options.includeHistory !== false;
  const historyItems = includeHistory ? readStoredJson(getScopedStorageKey('nano_history', scope), []) : [];
  const historyMeta = getScopedHistoryCacheMeta(scope);
  const titleStore = readScopedStoreSnapshot(TITLE_PRESETS_KEY, scope);
  const charStore = readScopedStoreSnapshot(CHAR_PRESETS_KEY, scope);
  const hiddenBuiltinsRaw = readStoredJson(getScopedStorageKey(INSPO_HIDDEN_KEY, scope), []);
  const nameOverridesRaw = readStoredJson(getScopedStorageKey(INSPO_NAMES_KEY, scope), {});
  const designMeta = readInspoLocalStateMeta(scope);
  let customPresets = [];
  let fontCustomPresets = [];
  try {
    customPresets = await _inspoIdbLoadAll(getInspoPresetOwnerKey(scope), PRESET_BUCKET_INSPO);
    fontCustomPresets = await _inspoIdbLoadAll(getInspoPresetOwnerKey(scope), PRESET_BUCKET_FONT);
  } catch (error) {
    console.warn('Failed to read scoped local account preset cache', error);
  }
  const designPresetState = {
    hiddenBuiltins: Array.isArray(hiddenBuiltinsRaw) ? hiddenBuiltinsRaw : [],
    nameOverrides: nameOverridesRaw && typeof nameOverridesRaw === 'object' ? nameOverridesRaw : {},
    customPresets: customPresets.map((preset) => normalizeCustomPresetForState(preset)).filter(Boolean),
    fontCustomPresets: fontCustomPresets.map((preset) => normalizeCustomPresetForState(preset)).filter(Boolean),
    meta: designMeta,
  };
  const normalizedHistory = Array.isArray(historyItems) ? dedupeHistoryItems(historyItems) : [];
  return {
    history: normalizedHistory,
    historyMeta,
    titlePresetStore: titleStore,
    charPresetStore: charStore,
    designPresetState,
    summary: {
      historyCount: Number.isFinite(Number(historyMeta && historyMeta.count))
        ? Number(historyMeta.count)
        : normalizedHistory.length,
      presetCount: countScopedCustomEntries(titleStore) + countScopedCustomEntries(charStore),
      customDesignPresetCount: designPresetState.customPresets.length + designPresetState.fontCustomPresets.length,
    },
  };
}

async function applyAccountData(data, options = {}) {
  const skipHistory = !!options.skipHistory;
  applyTextPresetStores(data && data.titlePresetStore ? data.titlePresetStore : {}, data && data.charPresetStore ? data.charPresetStore : {});
  await applyDesignPresetState(data && data.designPresetState ? data.designPresetState : {});
  if (!skipHistory) replaceHistoryFromAccount(data && Array.isArray(data.history) ? data.history : []);
  wizBuildTitleChips();
  wizBuildCharChips();
  if (typeof _pmRender === 'function') _pmRender();
  refreshLocalizedDynamicUi();
}

async function hydrateHistoryFromScopedCache(userId) {
  const cached = await getScopedLocalAccountData(userId, { includeHistory: true });
  replaceHistoryFromAccount(Array.isArray(cached.history) ? cached.history : [], { persist: false });
  return cached;
}

function persistHistoryCache() {
  saveHistory();
}

async function clearSignedInAccountData() {
  withAccountSyncSuspended(() => {
    _wizHiddenBuiltins = new Set();
    _wizPresetNameOverrides = {};
    _wizCustomPresets = [];
    _wizFontCustomPresets = [];
    _wizSelectedPresets = new Set();
    _wizSelectedFontPresets = new Set();
  });
  wizRenderInspoPresets();
  wizRenderFontPresets();
  history = [];
  scheduleHistoryUIUpdate();
  if (_fhgState.open) renderFhgGallery();
  tasks = [];
  initTasks();
  renderTasks();
  clearPreviewDisplay();
}

function getAccountSummarySnapshot() {
  const { titleStore, charStore } = getTextPresetStoresSnapshot();
  const titleCustom = Object.values(titleStore || {}).reduce((sum, entry) => sum + (Array.isArray(entry && entry.custom) ? entry.custom.length : 0), 0);
  const charCustom = Object.values(charStore || {}).reduce((sum, entry) => sum + (Array.isArray(entry && entry.custom) ? entry.custom.length : 0), 0);
  const designPresetCount = (Array.isArray(_wizCustomPresets) ? _wizCustomPresets.length : 0) + (Array.isArray(_wizFontCustomPresets) ? _wizFontCustomPresets.length : 0);
  return {
    historyCount: Array.isArray(history) ? history.length : 0,
    presetCount: titleCustom + charCustom,
    customDesignPresetCount: designPresetCount,
  };
}

window.NanoApp = {
  setAccountStorageScope,
  applyAccountData,
  clearSignedInAccountData,
  getLegacyMigrationPayload,
  clearLegacyMigrationData,
  getTextPresetStoresSnapshot,
  getDesignPresetStateSnapshot,
  hasDesignPresetStateContent,
  getScopedLocalAccountData,
  getScopedHistoryCacheMeta,
  hydrateHistoryFromScopedCache,
  persistHistoryCache,
  getAccountHistorySyncPayload,
  markDesignPresetSyncClean: markInspoLocalStateClean,
  mergePersistedHistoryItems,
  getAccountSummarySnapshot,
  replaceHistoryFromAccount,
  appendHistoryFromAccount,
  replaceTasksFromScopedStorage,
  setHistoryHydrating,
  clearPreviewDisplay,
};
// Init
initModels();
initInputs();
initModelViewerTouchFix();
initHistoryControls();
initGlobalImagePaste();
// History UI is lazy — built on first drawer open (see toggleHistory)
renderTasks();
initTasks();
generateMissingThumbnails();
requestAnimationFrame(autoResizePromptInput);

// Restore saved state or default
const savedMode = restoreAppState();
hookPersistence();
taskTicker = setInterval(renderTasks, 1500);

// Capture the saved video state BEFORE switchMode runs (which may overwrite some values).
const _savedVideoState = (function readSavedVideoState() {
  try {
    const raw = localStorage.getItem(APP_STATE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return null;
    return {
      videoModelId: String(
        (s.selects && s.selects.videoModel !== undefined ? s.selects.videoModel : null)
        || (s.controls && s.controls.videoModel !== undefined ? s.controls.videoModel : '')
        || ''
      ).trim(),
      videoTab: String(s.videoTab || '').trim(),
      ltx23Family: String(s.ltx23Family || '').trim(),
      seedance2Family: String(s.seedance2Family || '').trim(),
      kling3Tab: String(s.kling3Tab || '').trim(),
      videoEngine: String(s.videoEngine || '').trim(),
    };
  } catch (_) { return null; }
})();
// Pending video restore: armed whenever we have ANY saved video state, even
// when the user reloaded outside the video section. Cleared the first time
// applyVideoRestore() actually applies it (e.g. when the user navigates back).
window._pendingVideoRestore = !!(_savedVideoState && (_savedVideoState.videoModelId || _savedVideoState.videoTab));
window._savedVideoState = _savedVideoState;

if (savedMode) {
  switchMode(savedMode);
  // For non-video tab restoration, sync the tab buttons but DEFER actual model selection.
  if (savedMode === 'video' && currentVideoTab) {
    setActiveVideoTabButtonState(currentVideoTab);
  }
  if (savedMode === '3d') {
    update3dUiVisibility();
  }
} else {
  switchMode('tools');
}

// Restore preview & gallery from persisted state
if (window._restoredPreviewState) {
  const rps = window._restoredPreviewState;
  if (Array.isArray(rps.gallery) && rps.gallery.length > 0) {
    galleryItems = rps.gallery;
    galleryIndex = typeof rps.galleryIndex === 'number' ? Math.min(rps.galleryIndex, galleryItems.length - 1) : 0;
    displayResult(galleryItems[galleryIndex]);
  } else if (rps.preview) {
    displayResult(rps.preview);
  }
  delete window._restoredPreviewState;
}

// Atomic video restore: runs once after video models have loaded.
// Idempotent — can be re-invoked to reassert the saved selection if anything
// downstream tries to overwrite it (e.g. ensureKling3EmbeddedSection setup).
async function applyVideoRestore(_savedOverride) {
  // Idempotent boot-time and on-demand video restore.
  const savedFromGlobal = window._savedVideoState || _savedVideoState;
  const saved = _savedOverride || savedFromGlobal;
  if (!saved) { delete window._pendingVideoRestore; return; }
  try {
    // Make sure the video controls exist (videoModel select is dynamic).
    try { ensureVideoControls(); } catch (_) {}
    await loadVideoModels();
    // Restore the 3-tier engine selection.
    if (saved.videoEngine && VIDEO_ENGINE_MAP.has(saved.videoEngine)) {
      window._currentVideoEngine = saved.videoEngine;
    } else if (saved.videoModelId) {
      var derivedEngine = getEngineForModelId(saved.videoModelId);
      if (derivedEngine) window._currentVideoEngine = derivedEngine;
    }
    const modelId = saved.videoModelId;
    if (modelId && VIDEO_MODEL_MAP.has(modelId)) {
      if (isLtx23VideoModelId(modelId)) {
        selectLtx23Model(modelId, { skipSave: true });
      } else if (isSeedance2VideoModelId(modelId)) {
        selectSeedance2Model(modelId, { skipSave: true });
      } else if (isKling3VideoModelId(modelId)) {
        const klingTab = getKling3TabForModelId(modelId);
        if (klingTab) {
          switchKling3Tab(klingTab, { skipSave: true, skipVideoSelectionSync: false, preferredModelId: modelId });
        }
      } else {
        const meta = VIDEO_MODEL_MAP.get(modelId);
        const targetTab = meta && meta.kind ? getVideoTabForModelKind(meta.kind) : '';
        if (targetTab && targetTab !== currentVideoTab) {
          currentVideoTab = targetTab;
          setActiveVideoTabButtonState(targetTab);
        }
        refreshVideoModelDropdown(modelId);
        const sel = qs('videoModel');
        if (sel && sel.value !== modelId) sel.value = modelId;
      }
    } else if (saved.videoTab) {
      currentVideoTab = saved.videoTab;
      setActiveVideoTabButtonState(saved.videoTab);
      refreshVideoModelDropdown();
    }
    updateVideoUiVisibility();
    renderVideoOptionsUI();
    try { refreshVideo3TierUi(); } catch (_) {}
    // Final assertion: if the dropdown still doesn't match the saved id, force it.
    if (modelId) {
      const sel2 = qs('videoModel');
      if (sel2 && sel2.value !== modelId && Array.from(sel2.options).some((o) => o.value === modelId)) {
        sel2.value = modelId;
        updateVideoUiVisibility();
        renderVideoOptionsUI();
      }
    }
  } catch (e) {
    console.warn('applyVideoRestore failed', e);
  } finally {
    delete window._pendingVideoRestore;
  }
}

// Watchdog: if anything mutates the video model away from the saved id within
// the first second after boot, reassert it. This catches late async paths
// (e.g. account-bridge hydration or i18n re-renders) that could clobber state.
window.applyVideoRestore = applyVideoRestore;
function scheduleVideoRestoreWatchdog() {
  if (!window._savedVideoState || !window._savedVideoState.videoModelId) return;
  // The watchdog only operates while a saved selection exists. It is one-shot;
  // a fresh user selection clears window._savedVideoState so the watchdog stops.
  const targetId = window._savedVideoState.videoModelId;
  let attempts = 0;
  const maxAttempts = 8; // ~1.2s
  const tick = () => {
    if (currentMode !== 'video') return; // not in video right now; abort silently
    if (!window._savedVideoState || window._savedVideoState.videoModelId !== targetId) return;
    attempts++;
    const sel = qs('videoModel');
    if (sel && sel.value && sel.value !== targetId && Array.from(sel.options).some((o) => o.value === targetId)) {
      applyVideoRestore({ videoModelId: targetId, videoTab: window._savedVideoState.videoTab, videoEngine: window._savedVideoState.videoEngine });
    }
    if (attempts < maxAttempts) setTimeout(tick, 150);
  };
  setTimeout(tick, 150);
}
window.scheduleVideoRestoreWatchdog = scheduleVideoRestoreWatchdog;

// Release the boot-time saveAppState guard once async restoration is complete.
(function releaseRestoreGuardWhenReady() {
  const release = () => {
    _appStateRestoring = false;
    try { saveAppState(); } catch (_) {}
    try { scheduleVideoRestoreWatchdog(); } catch (_) {}
  };
  // Only run applyVideoRestore at boot when the user reloaded INSIDE the
  // video section. When they reloaded elsewhere, restore is deferred until
  // they navigate back to video (handled by ensureVideoControls hook).
  if (savedMode === 'video') {
    applyVideoRestore().then(() => setTimeout(release, 50)).catch(() => setTimeout(release, 50));
  } else {
    setTimeout(release, 50);
  }
})();

// Apply i18n LAST — after all selects and models are populated
hookNewsLocaleUpdates();
if (window.I18N) window.I18N.init();
refreshModelNews(true);























