const COPY = {
  en: {
    profile_menu: 'Local profile',
    profile_menu_button: 'Local profile menu',
    profile_back: 'Back',
    profile_kicker: 'Local storage',
    profile_title: 'Local profile',
    profile_history_label: 'History items',
    profile_preset_label: 'Text presets',
    profile_inspiration_label: 'Inspiration presets',
    profile_future_credits_label: 'Storage',
    profile_future_credits_body: 'Saved in this browser with local storage and IndexedDB.',
    profile_future_subscription_label: 'Account',
    profile_future_subscription_body: 'No remote account is required.',
    profile_created_prefix: 'Mode',
    profile_migration_none: 'Local-only saving is active',
  },
  ru: {
    profile_menu: 'Локальный профиль',
    profile_menu_button: 'Меню локального профиля',
    profile_back: 'Назад',
    profile_kicker: 'Локальное хранилище',
    profile_title: 'Локальный профиль',
    profile_history_label: 'Элементы истории',
    profile_preset_label: 'Текстовые пресеты',
    profile_inspiration_label: 'Пресеты вдохновения',
    profile_future_credits_label: 'Хранилище',
    profile_future_credits_body: 'Сохраняется в этом браузере через localStorage и IndexedDB.',
    profile_future_subscription_label: 'Аккаунт',
    profile_future_subscription_body: 'Удаленный аккаунт не нужен.',
    profile_created_prefix: 'Режим',
    profile_migration_none: 'Включено локальное сохранение',
  },
};

function qs(id) {
  return document.getElementById(id);
}

function getLang() {
  return window.I18N && window.I18N.lang ? window.I18N.lang : 'en';
}

function tr(key) {
  const lang = getLang();
  const bundle = COPY[lang] || COPY.en;
  return bundle[key] || COPY.en[key] || key;
}

function setText(id, value) {
  const el = qs(id);
  if (el) el.textContent = value;
}

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    requestAnimationFrame(() => window.lucide.createIcons());
  }
}

function getSummarySnapshot() {
  if (window.NanoApp && typeof window.NanoApp.getAccountSummarySnapshot === 'function') {
    return window.NanoApp.getAccountSummarySnapshot() || {};
  }
  return {};
}

function paintAvatar(el) {
  if (!el) return;
  el.textContent = 'L';
  el.style.backgroundImage = '';
}

function hideLocalOverlays() {
  const overlay = qs('sessionCheckOverlay');
  if (overlay) overlay.classList.remove('is-active');
}

function renderStaticCopy() {
  setText('profileMenuLabel', tr('profile_menu'));
  setText('profileBackLabel', tr('profile_back'));
  setText('profileKicker', tr('profile_kicker'));
  setText('profilePageTitle', tr('profile_title'));
  setText('profileHistoryLabel', tr('profile_history_label'));
  setText('profilePresetLabel', tr('profile_preset_label'));
  setText('profileInspirationLabel', tr('profile_inspiration_label'));
  setText('profileFutureLabelCredits', tr('profile_future_credits_label'));
  setText('profileFutureBodyCredits', tr('profile_future_credits_body'));
  setText('profileFutureLabelSubscription', tr('profile_future_subscription_label'));
  setText('profileFutureBodySubscription', tr('profile_future_subscription_body'));

  const profileBtn = qs('profileBtn');
  if (profileBtn) profileBtn.title = tr('profile_menu_button');
}

function updateHeaderIdentity() {
  const profileBtn = qs('profileBtn');
  const profileBtnAvatar = qs('profileBtnAvatar');
  const profileBtnIcon = qs('profileBtnIcon');
  const summary = qs('accountMenuSummary');
  const openEntry = qs('profileOpenDropdown');

  if (profileBtn) profileBtn.classList.add('has-avatar');
  if (profileBtnAvatar) {
    profileBtnAvatar.style.display = 'flex';
    paintAvatar(profileBtnAvatar);
  }
  if (profileBtnIcon) profileBtnIcon.style.display = 'none';
  if (summary) summary.style.display = 'flex';
  paintAvatar(qs('accountMenuAvatar'));
  setText('accountMenuName', 'Local Studio');
  setText('accountMenuEmail', 'Saved in this browser');
  if (openEntry) openEntry.disabled = false;
}

function updateProfileView() {
  const summary = getSummarySnapshot();
  paintAvatar(qs('profileAvatar'));
  setText('profileName', 'Local Studio');
  setText('profileEmail', 'Saved in this browser');
  setText('profileHistoryCount', String(summary.historyCount || 0));
  setText('profilePresetCount', String(summary.presetCount || 0));
  setText('profileInspirationCount', String(summary.customDesignPresetCount || 0));
  setText('profileCreatedAt', `${tr('profile_created_prefix')} local`);
  setText('profileMigrationState', tr('profile_migration_none'));

}

function refreshAccountUi() {
  hideLocalOverlays();
  renderStaticCopy();
  updateHeaderIdentity();
  updateProfileView();
  refreshIcons();
}

function openProfilePage() {
  refreshAccountUi();
  const page = qs('profilePage');
  if (!page) return;
  page.style.display = 'block';
  page.classList.add('is-open');
  document.body.style.overflow = 'hidden';
}

function closeProfilePage() {
  const page = qs('profilePage');
  if (!page) return;
  page.classList.remove('is-open');
  page.style.display = 'none';
  document.body.style.overflow = '';
}

function queueUiRefresh() {
  window.clearTimeout(queueUiRefresh.timer);
  queueUiRefresh.timer = window.setTimeout(refreshAccountUi, 80);
}

function activateLocalStorageScope(attempt = 0) {
  if (!window.NanoApp || typeof window.NanoApp.setAccountStorageScope !== 'function') {
    if (attempt < 20) {
      window.setTimeout(() => activateLocalStorageScope(attempt + 1), 50);
    } else {
      refreshAccountUi();
    }
    return;
  }

  window.NanoApp.setAccountStorageScope(null, { loadHistory: true, loadTasks: true });
  refreshAccountUi();
}

window.openProfilePage = openProfilePage;
window.closeProfilePage = closeProfilePage;

window.NanoAccountBridge = {
  getScopedUserId: () => null,
  queueTextPresetSync: queueUiRefresh,
  queueDesignPresetSync: queueUiRefresh,
  queueHistoryPersist: queueUiRefresh,
  queueHistoryDelete: queueUiRefresh,
  clearHistory: async () => {
    queueUiRefresh();
    return true;
  },
};

function hookLocaleUpdates() {
  if (!window.I18N || !window.I18N.applyLocale || window.__accountLocaleHooked) return;
  window.__accountLocaleHooked = true;
  const originalApplyLocale = window.I18N.applyLocale.bind(window.I18N);
  window.I18N.applyLocale = function() {
    originalApplyLocale.call(this);
    refreshAccountUi();
  };
}

function init() {
  hookLocaleUpdates();
  activateLocalStorageScope();
  window.addEventListener('storage', queueUiRefresh);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeProfilePage();
  });
}

init();
