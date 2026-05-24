/* ── Nano Banana Studio – i18n Engine ────────────────────────────────────────
 * HOW TO ADD NEW TRANSLATABLE TEXT:
 *
 *   A) HTML static unique elements (buttons, headings, one-off spans):
 *      Add  data-i18n="your_key"  to the element. Engine handles it.
 *
 *   B) HTML placeholders:
 *      Add  data-i18n-placeholder="your_key"  to the input/textarea.
 *
 *   C) Field <label> elements (most common — paired with a <select>/<input>):
 *      Add an entry to LABEL_FOR_SELECT or LABEL_FOR_INPUT below.
 *      Format:  'elementId': 'i18n_key'
 *
 *   D) <select> option text:
 *      Add an entry to OPTIONS_MAP below.
 *      Format:  'selectId': { 'optionValue': 'i18n_key', ... }
 *
 *   E) JS dynamic strings (toasts, errors, etc.):
 *      Use  I18N.t('your_key')  instead of a hardcoded string.
 *      Use  I18N.t('key').replace('{n}', value)  for interpolation.
 *
 *   Always add the key+value to TRANSLATIONS['en'] in translations.js first.
 *   Other locales fall back to English automatically if the key is missing.
 * ─────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  const STORAGE_KEY = 'nb_locale';
  const DEFAULT_LANG = 'en';
  const RTL_LANGS = new Set(['ar']);

  function isCorruptedTranslation(value) {
    if (typeof value !== 'string') return false;
    const compact = value.replace(/[\s0-9{}()[\].,:/\\_-]+/g, '');
    if (!compact) return false;
    const questionMarks = compact.match(/\?/g);
    if (!questionMarks || questionMarks.length === 0) return false;
    return questionMarks.length / compact.length >= 0.4;
  }

  const LANGUAGES = [
    { code: 'en', native: 'English',    english: 'English',    flag: '🇺🇸' },
    { code: 'es', native: 'Español',    english: 'Spanish',    flag: '🇪🇸' },
    { code: 'zh', native: '中文',        english: 'Chinese',    flag: '🇨🇳' },
    { code: 'ar', native: 'العربية',    english: 'Arabic',     flag: '🇸🇦' },
    { code: 'fr', native: 'Français',   english: 'French',     flag: '🇫🇷' },
    { code: 'ru', native: 'Русский',    english: 'Russian',    flag: '🇷🇺' },
    { code: 'pt', native: 'Português',  english: 'Portuguese', flag: '🇧🇷' },
    { code: 'de', native: 'Deutsch',    english: 'German',     flag: '🇩🇪' },
    { code: 'ja', native: '日本語',      english: 'Japanese',   flag: '🇯🇵' },
    { code: 'ko', native: '한국어',      english: 'Korean',     flag: '🇰🇷' },
  ];

  /* ── MAP: selectId → label i18n key ─────────────────────────────────────
   * To add a new field label: just add one line here.                       */
  const LABEL_FOR_SELECT = {
    imageModelEdit:    'label_model',  imageModelText:    'label_model',
    editOutputFormat:  'label_format', textOutputFormat:  'label_format',
    editImageSize:     'label_size',   gptImageSize:      'label_size',
    editQuality:       'label_quality',gptQuality:        'label_quality',
    editBackground:    'label_background', gptBackground: 'label_background',
    editInputFidelity: 'label_fidelity',
    editNanoResolution:'label_resolution', nanoResolution:  'label_resolution',
    editNano2Resolution:'label_resolution',nano2Resolution: 'label_resolution',
    editNanoWebSearch: 'label_web_search', nanoWebSearch:   'label_web_search',
    editNano2WebSearch:'label_web_search', nano2WebSearch:  'label_web_search',
    editNano2GoogleSearch:'label_google_search', nano2GoogleSearch:'label_google_search',
    editNanoAspectRatio:'label_ratio', editNano2AspectRatio:'label_ratio',
    aspectRatioBase:   'label_ratio',
    editNano2SafetyTolerance:'label_safety', nano2SafetyTolerance:'label_safety',
    textSafetyTolerance:'label_safety',
    textEnhancePrompt: 'label_enhance',
    textRawMode:       'label_raw_mode',
    textNumImages:     'label_count',
    threeDModel:       'label_3d_model',
    threeDGenerateType:'label_type',
    threeDEnablePbr:   'label_pbr',
    threeDPolygonType: 'label_polygon',
    threeDMeshyMode:   'label_mode',
    threeDMeshyArtStyle:'label_style',
    threeDMeshyTopology:'label_topology',
    threeDMeshySymmetryMode:'label_symmetry',
    threeDMeshyShouldRemesh:'label_remesh',
    threeDMeshyShouldTexture:'label_texture',
    threeDMeshyEnablePbr:'label_pbr',
    threeDMeshyIsATPose:'label_at_pose',
    threeDMeshyEnablePromptExpansion:'label_expand',
    threeDMeshyEnableSafetyChecker:'label_safety',
    threeDRapidEnablePbr:'label_pbr',
    threeDRapidEnableGeometry:'label_geometry_only',
    threeDTopologyFileType:'label_file_type',
    threeDTopologyPolygonType:'label_polygon',
    threeDTopologyFaceLevel:'label_detail_level',
    threeDRetextureOriginalUv:'label_original_uv',
    threeDRetextureEnablePbr:'label_pbr',
    threeDRetextureEnableSafety:'label_safety',
    videoModel:        'label_video_model',
    kling3Model:       'label_model',
    kling3Duration:    'label_duration',
    kling3AspectRatio: 'label_aspect_ratio',
    kling3ShotType:    'label_shot_type',
    kling3CfgScale:    'label_cfg_scale',
    kling3GenerateAudio:'label_generate_audio',
    kling3KeepAudio:   'label_keep_audio',
    kling3MotionOrientation:'label_character_orientation_mode',
    kling3KeepOriginalSound:'label_keep_original_sound',
  };

  /* ── MAP: inputId → label i18n key ──────────────────────────────────── */
  const LABEL_FOR_INPUT = {
    threeDFaceCount:   'label_faces',
    threeDMeshyTargetPolycount:'label_polycount',
    threeDMeshySeed:   'label_seed',
    threeDMeshyTexturePrompt:'label_texture_prompt',
    threeDMeshyTextureImageUrl:'label_texture_url',
    threeDRetextureStylePrompt:'label_style_prompt',
    textSeed:          'label_seed',
    nano2Seed:         'label_seed',
    editNano2Seed:     'label_seed',
    kling3VoiceIds:    'label_voice_ids',
    kling3NegativePrompt:'label_negative_prompt',
    kling3VideoUrlInput:'label_video_url_upload',
    kling3StartImageInput:'label_start_image',
    kling3EndImageInput:'label_end_image',
    kling3VideoInput:'label_video_url_upload',
    kling3RefImagesInput:'label_ref_images',
    threeDMeshyTextureImageInput:'label_texture_image',
    threeDTopologyFileInput:'label_3d_file',
    threeDRetextureModelInput:'label_3d_model_file',
    threeDRetextureStyleImageInput:'label_style_image',
    videoUrlInput:'label_video_url',
    videoInput:'label_upload_video',
    videoImageInput:'label_upload_image',
    referenceImagesInput:'label_reference_images_video',
    videoEndImageInput:'label_end_frame_optional',
    videoIdInput:'label_video_id',
    audioInput:'label_audio_file',
  };

  /* ── MAP: selectId → { optionValue: i18n_key } ───────────────────────
   * To add options for a new select: add one object here.                  */
  const OPTIONS_MAP = {
    editQuality:       { high:'opt_high', medium:'opt_medium', low:'opt_low' },
    gptQuality:        { high:'opt_high', medium:'opt_medium', low:'opt_low' },
    editInputFidelity: { high:'opt_high', low:'opt_low' },
    editBackground:    { auto:'opt_auto', opaque:'opt_opaque', transparent:'opt_transparent' },
    gptBackground:     { auto:'opt_auto', opaque:'opt_opaque', transparent:'opt_transparent' },
    editNanoWebSearch: { false:'opt_off', true:'opt_on' },
    editNano2WebSearch:{ false:'opt_off', true:'opt_on' },
    editNano2GoogleSearch:{ false:'opt_off', true:'opt_on' },
    nanoWebSearch:     { false:'opt_off', true:'opt_on' },
    nano2WebSearch:    { false:'opt_off', true:'opt_on' },
    nano2GoogleSearch: { false:'opt_off', true:'opt_on' },
    textEnhancePrompt: { false:'opt_off', true:'opt_on' },
    textRawMode:       { false:'opt_off', true:'opt_on' },
    textSafetyTolerance:{ '2':'opt_standard','1':'opt_strict','3':'opt_relaxed','4':'opt_permissive','5':'opt_very_permissive' },
    threeDEnablePbr:   { false:'opt_off', true:'opt_on' },
    threeDGenerateType:{ Normal:'opt_normal', LowPoly:'opt_lowpoly', Geometry:'opt_geometry' },
    threeDPolygonType: { triangle:'opt_triangle', quadrilateral:'opt_quad' },
    threeDMeshyMode:   { full:'opt_full', preview:'opt_preview' },
    threeDMeshyArtStyle:{ realistic:'opt_realistic', sculpture:'opt_sculpture' },
    threeDMeshyTopology:{ triangle:'opt_triangle', quad:'opt_quad' },
    threeDMeshySymmetryMode:{ auto:'opt_auto', off:'opt_off', on:'opt_on' },
    threeDMeshyShouldRemesh:{ true:'opt_yes', false:'opt_no' },
    threeDMeshyShouldTexture:{ true:'opt_yes', false:'opt_no' },
    threeDMeshyEnablePbr:{ false:'opt_off', true:'opt_on' },
    threeDMeshyIsATPose:{ false:'opt_no', true:'opt_yes' },
    threeDMeshyEnablePromptExpansion:{ false:'opt_off', true:'opt_on' },
    threeDMeshyEnableSafetyChecker:{ true:'opt_on', false:'opt_off' },
    threeDRapidEnablePbr:{ false:'opt_off', true:'opt_on' },
    threeDRapidEnableGeometry:{ false:'opt_off', true:'opt_on' },
    threeDRetextureOriginalUv:{ true:'opt_yes', false:'opt_no' },
    threeDRetextureEnablePbr:{ false:'opt_off', true:'opt_on' },
    threeDRetextureEnableSafety:{ true:'opt_on', false:'opt_off' },
    kling3ShotType:    { customize:'opt_customize', intelligent:'opt_intelligent' },
    kling3GenerateAudio:{ true:'opt_on', false:'opt_off' },
    kling3KeepAudio:   { true:'opt_on', false:'opt_off' },
    kling3MotionOrientation:{ image:'opt_image', video:'opt_video' },
    kling3KeepOriginalSound:{ true:'opt_on', false:'opt_off' },
    toolsEnhancerOutputFormat:{ jpeg:'tools_opt_jpeg', png:'tools_opt_png' },
    toolsEnhancerSubjectDetection:{ All:'tools_opt_subject_all', Foreground:'tools_opt_subject_foreground', Background:'tools_opt_subject_background' },
    toolsBgOutputFormat:{ rgba:'tools_cutout_opt_rgba', alpha:'tools_cutout_opt_alpha' },
    toolsBgSyncMode:{ false:'tools_cutout_opt_stored_url', true:'tools_cutout_opt_data_url' },
  };

  /* ── MAP: upload item label next to upload-area in 3D mode ─────────────
   * These are static text labels above upload dropzones.                   */
  const UPLOAD_ITEM_LABELS = [
    // [closest-parent-selector, label-text-selector, i18n-key]
    ['#threeDImageUploadWrap .upload-item:nth-child(1)', 'label', 'label_front'],
    ['#threeDImageUploadWrap .upload-item:nth-child(2)', 'label', 'label_back'],
    ['#threeDImageUploadWrap .upload-item:nth-child(3)', 'label', 'label_left'],
    ['#threeDImageUploadWrap .upload-item:nth-child(4)', 'label', 'label_right'],
  ];

  /* ────────────────────────────────────────────────────────────────────── */

  const I18N = {
    lang: DEFAULT_LANG,
    languages: LANGUAGES,

    /* ── Core lookup ─────────────────────────────────────────────────── */
    t(key) {
      const tr = window.TRANSLATIONS;
      if (!tr) return key;
      const locale = tr[this.lang];
      if (locale && locale[key] !== undefined && !isCorruptedTranslation(locale[key])) return locale[key];
      const fallback = tr[DEFAULT_LANG];
      if (fallback && fallback[key] !== undefined) return fallback[key];
      return key;
    },

    /* ── Apply translations to the entire DOM ────────────────────────── */
    applyLocale() {
      const isRTL = RTL_LANGS.has(this.lang);
      document.documentElement.setAttribute('lang', this.lang);
      document.documentElement.setAttribute('dir', isRTL ? 'rtl' : 'ltr');

      // 1. data-i18n text content
      document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = this.t(el.dataset.i18n);
      });

      // 2. data-i18n-placeholder
      document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = this.t(el.dataset.i18nPlaceholder);
      });

      // 3. data-i18n-title (tooltip)
      document.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.title = this.t(el.dataset.i18nTitle);
      });

      // 4. Labels for select elements
      for (const [id, key] of Object.entries(LABEL_FOR_SELECT)) {
        const el = document.getElementById(id);
        if (!el) continue;
        const field = el.closest('.field') || el.closest('.upload-item');
        if (!field) continue;
        const lbl = field.querySelector(':scope > label');
        // Only update if the label has no interactive child elements
        if (lbl && lbl.querySelector('input, select, button') === null) {
          lbl.textContent = this.t(key);
        }
      }

      // 5. Labels for input elements
      for (const [id, key] of Object.entries(LABEL_FOR_INPUT)) {
        const el = document.getElementById(id);
        if (!el) continue;
        const field = el.closest('.field') || el.closest('.upload-item');
        if (!field) continue;
        const lbl = field.querySelector(':scope > label');
        if (lbl && lbl.querySelector('input, select, button') === null) {
          lbl.textContent = this.t(key);
        }
      }

      // 6. Select option text
      for (const [selectId, optMap] of Object.entries(OPTIONS_MAP)) {
        const sel = document.getElementById(selectId);
        if (!sel) continue;
        for (const opt of sel.options) {
          const key = optMap[opt.value];
          if (key) opt.textContent = this.t(key);
        }
      }

      // 7. Upload item labels in 3D mode
      for (const [parentSel, labelSel, key] of UPLOAD_ITEM_LABELS) {
        const parent = document.querySelector(parentSel);
        if (!parent) continue;
        const lbl = parent.querySelector(labelSel);
        if (lbl) lbl.textContent = this.t(key);
      }

      // 8. Update lang picker title
      const panelTitle = document.querySelector('.lang-panel-title');
      if (panelTitle) panelTitle.textContent = this.t('lang_title');

      this._updatePickerActiveState();
    },

    /* ── Persist and switch ──────────────────────────────────────────── */
    setLang(code) {
      if (!window.TRANSLATIONS || !window.TRANSLATIONS[code]) return;
      this.lang = code;
      try { localStorage.setItem(STORAGE_KEY, code); } catch (_) {}
      this.applyLocale();
      this.closePicker();
    },

    /* ── Init: restore saved language ───────────────────────────────── */
    init() {
      let saved = DEFAULT_LANG;
      try { saved = localStorage.getItem(STORAGE_KEY) || DEFAULT_LANG; } catch (_) {}
      if (!window.TRANSLATIONS || !window.TRANSLATIONS[saved]) saved = DEFAULT_LANG;
      this.lang = saved;
      this._buildPicker();
      this.applyLocale();
    },

    /* ── Build the language picker panel (once) ─────────────────────── */
    _buildPicker() {
      if (document.getElementById('langPickerPanel')) return;

      const backdrop = document.createElement('div');
      backdrop.id = 'langPickerBackdrop';
      backdrop.className = 'lang-backdrop';
      backdrop.addEventListener('click', () => this.closePicker());
      document.body.appendChild(backdrop);

      const panel = document.createElement('div');
      panel.id = 'langPickerPanel';
      panel.className = 'lang-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');

      const header = document.createElement('div');
      header.className = 'lang-panel-header';

      const title = document.createElement('span');
      title.className = 'lang-panel-title';
      title.textContent = this.t('lang_title');

      const closeBtn = document.createElement('button');
      closeBtn.className = 'lang-panel-close';
      closeBtn.type = 'button';
      closeBtn.innerHTML = '&#x2715;';
      closeBtn.addEventListener('click', () => this.closePicker());

      header.appendChild(title);
      header.appendChild(closeBtn);
      panel.appendChild(header);

      const list = document.createElement('div');
      list.className = 'lang-list';
      list.id = 'langList';

      LANGUAGES.forEach(lang => {
        const btn = document.createElement('button');
        btn.className = 'lang-item';
        btn.dataset.langCode = lang.code;
        btn.type = 'button';
        btn.innerHTML = `<span class="lang-flag">${lang.flag}</span><span class="lang-names"><span class="lang-native">${lang.native}</span><span class="lang-english">${lang.english}</span></span><span class="lang-check">✓</span>`;
        btn.addEventListener('click', () => this.setLang(lang.code));
        list.appendChild(btn);
      });

      panel.appendChild(list);
      document.body.appendChild(panel);
    },

    /* ── Open / close / toggle ───────────────────────────────────────── */
    openPicker() {
      this._updatePickerActiveState();
      document.getElementById('langPickerPanel')?.classList.add('lang-panel--open');
      document.getElementById('langPickerBackdrop')?.classList.add('lang-backdrop--open');
    },
    closePicker() {
      document.getElementById('langPickerPanel')?.classList.remove('lang-panel--open');
      document.getElementById('langPickerBackdrop')?.classList.remove('lang-backdrop--open');
    },
    togglePicker() {
      const panel = document.getElementById('langPickerPanel');
      if (panel?.classList.contains('lang-panel--open')) this.closePicker();
      else this.openPicker();
    },

    _updatePickerActiveState() {
      document.querySelectorAll('#langList .lang-item').forEach(btn => {
        btn.classList.toggle('lang-item--active', btn.dataset.langCode === this.lang);
      });
    },
  };

  window.I18N = I18N;
  window.toggleLangPicker = () => I18N.togglePicker();

})();
