/*
 * YouTube Auto Translate Comments
 *
 * Clicks YouTube's own "Translate" control for comments that are currently
 * visible in the viewport. It never calls a translation API and never reads
 * or stores comment text.
 */
(() => {
  'use strict';

  const COMMENT_SELECTOR = 'ytd-comment-view-model, ytd-comment-renderer';
  const CONTROL_SELECTOR = 'button, [role="button"]';
  const DEFAULT_ENABLED = true;
  const MIN_CLICK_DELAY_MS = 350;
  const MAX_CLICK_DELAY_MS = 800;
  const MAX_QUEUE_SIZE = 100;

  // YouTube localises the native translate control. The #translate-button id is
  // language-independent when present; these patterns are the fallback for
  // layouts where the id is missing or moves.
  const TRANSLATE_LABEL_PATTERNS = [
    /^translate\b/i,
    /^translation\b/i,
    /^traduc/i,
    /^traduire\b/i,
    /^übersetzen\b/i,
    /^перевести\b/i,
    /^перекласти\b/i,
    /^翻译/,
    /^翻譯/,
    /^翻訳/,
    /^번역/,
    /^çevir\b/i,
    /^dịch\b/i,
    /^terjemahkan\b/i,
    /^ترجمة/,
    /^अनुवाद/,
    /^แปล/,
    /^vertalen\b/i,
    /^przetłumacz\b/i,
    /^översätt\b/i,
    /^přeložit\b/i,
    /^μετάφραση/,
    /^תרגם/,
    /^fordítás\b/i,
    /^käännä\b/i,
    /^oversett\b/i,
    /^oversæt\b/i,
  ];

  // After a comment is translated YouTube changes the control to "Show
  // original" (or a localised equivalent). Do not click that.
  const ORIGINAL_LABEL_PATTERNS = [
    /^(show|view|see)\s+original\b/i,
    /^(afficher|voir)\s+l['’]original\b/i,
    /^原文/,
    /^查看原文/,
    /^查看原始/,
    /^显示原文/,
    /^顯示原文/,
    /^原文を表示/,
    /^元の(テキスト|原文|コメント)/,
    /^원문/,
    /^원본/,
    /^ver\s+original\b/i,
    /^original\s+anzeigen\b/i,
    /^mostrar\s+original\b/i,
    /^показать\s+оригинал\b/i,
    /^mostra\s+originale\b/i,
    /^orijinali\s+göster\b/i,
    /^xem\s+bản\s+gốc\b/i,
    /^tampilkan\s+asli\b/i,
    /^عرض\s+الأصل/,
  ];

  let enabled = false;
  let queue = [];
  let processing = false;
  let translatedCount = 0;
  let pageGeneration = 0;
  let lastNavigationFinishAt = 0;

  let clicked = new WeakSet();
  let queued = new WeakSet();
  let observed = new WeakSet();

  let intersectionObserver = null;
  let mutationObserver = null;

  function normalizeLabel(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  function getLabel(element) {
    const ariaLabel = element.getAttribute('aria-label') || '';
    const text = element.textContent || '';
    return normalizeLabel(`${ariaLabel} ${text}`);
  }

  function matchesAny(patterns, label) {
    return patterns.some((pattern) => pattern.test(label));
  }

  function isShowOriginalLabel(label) {
    return matchesAny(ORIGINAL_LABEL_PATTERNS, label);
  }

  function isTranslateControl(element) {
    if (!(element instanceof Element)) return false;

    const label = getLabel(element);
    if (isShowOriginalLabel(label)) return false;

    // The id is the most reliable signal and survives UI language changes.
    if (element.id === 'translate-button') return true;

    return matchesAny(TRANSLATE_LABEL_PATTERNS, label);
  }

  function resolveControl(element) {
    if (!element) return null;
    if (element.matches(CONTROL_SELECTOR)) return element;
    return element.querySelector(CONTROL_SELECTOR) || element;
  }

  function findTranslateButton(comment) {
    const direct = comment.querySelector('#translate-button');
    if (direct && direct.closest(COMMENT_SELECTOR) === comment) {
      const control = resolveControl(direct);
      if (
        control &&
        control.closest(COMMENT_SELECTOR) === comment &&
        isTranslateControl(control)
      ) {
        return control;
      }
    }

    // Fallback for layouts that do not expose #translate-button. Filter by
    // ownership so a parent comment never clicks a nested reply's button.
    for (const control of comment.querySelectorAll(CONTROL_SELECTOR)) {
      if (control.closest(COMMENT_SELECTOR) !== comment) continue;
      if (isTranslateControl(control)) return control;
    }

    return null;
  }

  function isInViewport(element) {
    if (!element || !element.isConnected) return false;

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function randomClickDelay() {
    return (
      MIN_CLICK_DELAY_MS +
      Math.random() * (MAX_CLICK_DELAY_MS - MIN_CLICK_DELAY_MS)
    );
  }

  function notifyStats() {
    try {
      chrome.runtime.sendMessage(
        { type: 'YTAT_STATS', enabled, translatedCount },
        () => void chrome.runtime.lastError
      );
    } catch (_error) {
      // The extension may have been reloaded while this page stayed open.
    }
  }

  function createIntersectionObserver() {
    return new IntersectionObserver(
      (entries) => {
        if (!enabled) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          tryQueueComment(entry.target);
        }
      },
      {
        root: null,
        rootMargin: '0px',
        threshold: 0,
      }
    );
  }

  function observeComment(comment) {
    if (!(comment instanceof Element) || observed.has(comment)) return;
    observed.add(comment);
    if (intersectionObserver) intersectionObserver.observe(comment);
  }

  function tryQueueComment(comment) {
    if (!enabled || !(comment instanceof Element)) return;
    if (clicked.has(comment) || queued.has(comment)) return;
    if (queue.length >= MAX_QUEUE_SIZE) return;
    if (!isInViewport(comment)) return;
    if (!findTranslateButton(comment)) return;

    queued.add(comment);
    queue.push(comment);
    void pumpQueue();
  }

  async function pumpQueue() {
    if (processing || !enabled) return;
    processing = true;

    try {
      while (queue.length > 0 && enabled) {
        const comment = queue.shift();

        if (
          !comment.isConnected ||
          clicked.has(comment) ||
          !isInViewport(comment)
        ) {
          queued.delete(comment);
          continue;
        }

        if (!findTranslateButton(comment)) {
          queued.delete(comment);
          continue;
        }

        const generation = pageGeneration;
        await sleep(randomClickDelay());

        // Re-check every condition after the human-like delay. The user may
        // have scrolled away, disabled the extension or changed video.
        if (
          !enabled ||
          generation !== pageGeneration ||
          !comment.isConnected ||
          clicked.has(comment) ||
          !isInViewport(comment)
        ) {
          queued.delete(comment);
          continue;
        }

        const button = findTranslateButton(comment);
        if (!button) {
          queued.delete(comment);
          continue;
        }

        clicked.add(comment);
        queued.delete(comment);

        try {
          button.click();
          translatedCount += 1;
          notifyStats();
        } catch (error) {
          clicked.delete(comment);
          tryQueueComment(comment);
          console.warn('[YouTube Auto Translate] Could not click translate:', error);
        }

        // Space out requests so a screen full of comments does not fire them
        // all at once.
        await sleep(180);
      }
    } finally {
      processing = false;
      if (enabled && queue.length > 0) void pumpQueue();
    }
  }

  function refreshVisibleComments() {
    for (const comment of document.querySelectorAll(COMMENT_SELECTOR)) {
      observeComment(comment);
      if (isInViewport(comment)) tryQueueComment(comment);
    }
  }

  function setEnabled(nextEnabled) {
    const next = nextEnabled !== false;
    if (enabled === next) return;

    enabled = next;

    if (!enabled) {
      queue = [];
      queued = new WeakSet();
    } else {
      refreshVisibleComments();
    }

    notifyStats();
  }

  function collectComments(node) {
    const comments = [];
    if (!(node instanceof Element)) return comments;

    if (node.matches(COMMENT_SELECTOR)) comments.push(node);
    for (const comment of node.querySelectorAll(COMMENT_SELECTOR)) {
      comments.push(comment);
    }
    return comments;
  }

  function handleAddedNode(node) {
    if (!(node instanceof Element)) return;

    for (const comment of collectComments(node)) {
      observeComment(comment);
      if (enabled && isInViewport(comment)) tryQueueComment(comment);
    }

    if (!enabled) return;

    // The action row (and therefore the translate control) can render after
    // the comment text. Only inspect controls that live inside a comment; this
    // keeps large YouTube layout mutations cheap.
    const ownerComment = node.closest(COMMENT_SELECTOR);
    if (!ownerComment) return;

    const controls = [];
    if (node.matches(CONTROL_SELECTOR)) controls.push(node);
    for (const control of node.querySelectorAll(CONTROL_SELECTOR)) {
      controls.push(control);
    }

    for (const control of controls) {
      if (!isTranslateControl(control)) continue;
      const comment = control.closest(COMMENT_SELECTOR);
      if (comment && isInViewport(comment)) tryQueueComment(comment);
    }
  }

  function handleMutations(mutations) {
    if (!enabled) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        handleAddedNode(node);
      }
    }
  }

  function handleNavigationStart() {
    pageGeneration += 1;
    queue = [];
    queued = new WeakSet();
  }

  function handleNavigationFinish() {
    // YouTube dispatches the SPA events on window; listening on document as
    // well makes this resilient to older layouts. Ignore the duplicate.
    const now = Date.now();
    if (now - lastNavigationFinishAt < 150) return;
    lastNavigationFinishAt = now;

    pageGeneration += 1;
    queue = [];
    queued = new WeakSet();
    clicked = new WeakSet();
    observed = new WeakSet();
    translatedCount = 0;

    if (intersectionObserver) intersectionObserver.disconnect();
    intersectionObserver = createIntersectionObserver();

    refreshVisibleComments();
    notifyStats();
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== 'sync' || !changes.enabled) return;
    setEnabled(changes.enabled.newValue !== false);
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'YTAT_GET_STATUS') {
      sendResponse({
        enabled,
        translatedCount,
        version: chrome.runtime.getManifest().version,
      });
      return;
    }

    if (message.type === 'YTAT_SET_ENABLED') {
      setEnabled(message.enabled !== false);
      sendResponse({ enabled, translatedCount });
    }
  }

  function init() {
    intersectionObserver = createIntersectionObserver();

    mutationObserver = new MutationObserver(handleMutations);
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    window.addEventListener('yt-navigate-start', handleNavigationStart);
    window.addEventListener('yt-navigate-finish', handleNavigationFinish);
    document.addEventListener('yt-navigate-start', handleNavigationStart);
    document.addEventListener('yt-navigate-finish', handleNavigationFinish);
    window.addEventListener('resize', () => {
      if (enabled) refreshVisibleComments();
    });

    chrome.storage.onChanged.addListener(handleStorageChange);
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);

    chrome.storage.sync.get(
      { enabled: DEFAULT_ENABLED },
      (result) => {
        if (chrome.runtime.lastError || !result) {
          setEnabled(DEFAULT_ENABLED);
          return;
        }
        setEnabled(result.enabled !== false);
      }
    );

    // Observe comments that already exist; visibility is handled by the
    // IntersectionObserver's initial callback (and by refreshVisibleComments
    // once the saved setting has loaded).
    for (const comment of document.querySelectorAll(COMMENT_SELECTOR)) {
      observeComment(comment);
    }
  }

  init();
})();
