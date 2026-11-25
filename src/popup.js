'use strict';

const GITHUB_URL = 'https://github.com/BearingSteel/Ext-youtube-auto-click-translate';
const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur']);

const elements = {
  body: document.body,
  toggle: document.getElementById('toggle'),
  statusText: document.getElementById('statusText'),
  hint: document.getElementById('hint'),
  count: document.getElementById('count'),
  pageNotice: document.getElementById('pageNotice'),
  github: document.getElementById('github'),
  version: document.getElementById('version'),
};

let enabled = true;
let translatedCount = 0;
let activeTabId = null;
let pageAvailable = null;

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || '';
}

function applyI18n() {
  const uiLanguage = chrome.i18n.getUILanguage() || 'en';
  const shortLanguage = uiLanguage.split(/[-_]/)[0].toLowerCase();

  document.documentElement.lang = uiLanguage.replace(/_/g, '-');
  document.documentElement.dir = RTL_LANGUAGES.has(shortLanguage) ? 'rtl' : 'ltr';

  for (const element of document.querySelectorAll('[data-i18n]')) {
    const message = t(element.dataset.i18n);
    if (message) element.textContent = message;
  }

  const title = t('popupTitle');
  if (title) document.title = title;

  elements.github.href = GITHUB_URL;
}

function render() {
  elements.body.classList.toggle('is-on', enabled);

  elements.toggle.setAttribute('aria-checked', String(enabled));
  elements.statusText.textContent = enabled ? t('statusOn') : t('statusOff');
  elements.hint.textContent = enabled ? t('hintOn') : t('hintOff');

  const countMessage = t('sessionCount', [String(translatedCount)]);
  if (countMessage) {
    elements.count.textContent = countMessage;
  }

  const version = chrome.runtime.getManifest().version;
  const versionMessage = t('versionLabel', [version]);
  elements.version.textContent = versionMessage || `v${version}`;

  // null means "not checked yet"; only show the notice once we know the
  // current tab cannot talk to the content script.
  elements.pageNotice.hidden = pageAvailable !== false;
}

async function loadSetting() {
  try {
    const result = await chrome.storage.sync.get({ enabled: true });
    enabled = result.enabled !== false;
  } catch (_error) {
    enabled = true;
  }
}

async function refreshStatus() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || typeof tab.id !== 'number') {
      pageAvailable = false;
      render();
      return;
    }

    activeTabId = tab.id;
    const status = await chrome.tabs.sendMessage(tab.id, {
      type: 'YTAT_GET_STATUS',
    });

    if (!status) throw new Error('No status returned');

    enabled = status.enabled !== false;
    translatedCount = Number(status.translatedCount) || 0;
    pageAvailable = true;
  } catch (_error) {
    pageAvailable = false;
  }

  render();
}

async function toggleEnabled() {
  enabled = !enabled;
  render();

  try {
    await chrome.storage.sync.set({ enabled });
  } catch (_error) {
    // The switch still applies to this popup session; storage may be
    // unavailable only in unusual managed environments.
  }

  if (activeTabId !== null) {
    try {
      await chrome.tabs.sendMessage(activeTabId, {
        type: 'YTAT_SET_ENABLED',
        enabled,
      });
    } catch (_error) {
      // No content script on this tab; the saved setting applies next reload.
    }
  }
}

function handleRuntimeMessage(message, sender) {
  if (!message || message.type !== 'YTAT_STATS') return;

  if (
    activeTabId !== null &&
    sender &&
    sender.tab &&
    typeof sender.tab.id === 'number' &&
    sender.tab.id !== activeTabId
  ) {
    return;
  }

  enabled = message.enabled !== false;
  translatedCount = Number(message.translatedCount) || 0;
  pageAvailable = true;
  render();
}

async function init() {
  applyI18n();
  await loadSetting();
  render();

  elements.toggle.addEventListener('click', () => {
    void toggleEnabled();
  });

  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  await refreshStatus();
}

void init();
