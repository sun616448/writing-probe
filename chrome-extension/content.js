// Content script — injected into Google Docs.
// Responsibilities:
//   1. Inject the sidebar HTML into the page
//   2. Watch for text changes via MutationObserver
//   3. Detect paragraph completions and send PROBE_TRIGGER_PARA (immediate)
//   4. Send PROBE_TRIGGER on debounce for full multi-paragraph scan
//   5. Receive PROBES_STARTED / PROBES_READY / PROBE_ERROR push messages from background
//   6. Apply and clear inline highlights for each probe passage
//   7. Handle accept-edit by copying suggestion to clipboard

(function () {
  'use strict';

  const DEBOUNCE_MS = 2500;
  const PARA_DEBOUNCE_MS = 600;
  const EDITOR_SELECTOR = '.kix-appview-editor';
  const MAX_INIT_WAIT_MS = 15000;
  const POLL_INTERVAL_MS = 500;

  let highlightedEls = [];
  let observer = null;
  let lastParaCount = -1; // -1 = not yet initialized

  // --- Init: wait for Google Docs to finish loading ---
  console.log('[TP] content.js loaded');
  let elapsed = 0;
  const initPoll = setInterval(() => {
    elapsed += POLL_INTERVAL_MS;
    const editor = document.querySelector(EDITOR_SELECTOR);
    if (editor) {
      clearInterval(initPoll);
      console.log('[TP] editor found, initialising');
      init(editor);
    } else if (elapsed >= MAX_INIT_WAIT_MS) {
      clearInterval(initPoll);
      console.warn('[TP] editor not found after', MAX_INIT_WAIT_MS, 'ms');
    }
  }, POLL_INTERVAL_MS);

  function init(editor) {
    injectSidebar();
    startObserver(editor);
    document.addEventListener('tp:accept-edit', handleAcceptEdit);
    console.log('[TP] init complete');
    // Auto-trigger on load — give the doc 3s to finish rendering
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'PROBE_TRIGGER_PARA' }, () => void chrome.runtime.lastError);
    }, 3000);
  }

  // --- Push messages from background ---

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'PROBE_STATUS') {
      return; // diagnostic only, no-op in production
    }
    console.log('[TP] message from background:', message.type, message);
    if (message.type === 'PROBE_STARTED') {
      document.dispatchEvent(new CustomEvent('tp:probe-loading'));
    } else if (message.type === 'PROBES_READY') {
      applyHighlights(message.probes);
      document.dispatchEvent(new CustomEvent('tp:probes-ready', {
        detail: { probes: message.probes, replace: message.replace },
      }));
    } else if (message.type === 'PROBE_ERROR') {
      console.error('[TP] probe error:', message.error);
      document.dispatchEvent(new CustomEvent('tp:error', {
        detail: { message: message.error, code: message.error },
      }));
    }
  });

  // --- Sidebar injection ---

  // Google Docs enforces Trusted Types — DOMParser.parseFromString('…', 'text/html')
  // is a restricted sink and throws. Build the sidebar DOM programmatically instead.
  function injectSidebar() {
    try {
      const container = document.createElement('div');
      container.id = 'tp-sidebar-container';
      container.appendChild(buildSidebarDOM());
      (document.body || document.documentElement).appendChild(container);
    } catch (err) {
      console.error('[ThinkingProbe] Failed to inject sidebar:', err?.message || err, err);
    }
  }

  function buildSidebarDOM() {
    const SVG_NS = 'http://www.w3.org/2000/svg';

    function el(tag, attrs, ...children) {
      const node = document.createElement(tag);
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
          node.setAttribute(k, v);
        }
      }
      for (const child of children) {
        if (typeof child === 'string') node.appendChild(document.createTextNode(child));
        else if (child) node.appendChild(child);
      }
      return node;
    }

    function svg(tag, attrs, ...children) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      for (const child of children) node.appendChild(child);
      return node;
    }

    const spinnerSvg = svg('svg', { width: '12', height: '12', viewBox: '0 0 14 14', fill: 'none', class: 'tp-spin' },
      svg('circle', { cx: '7', cy: '7', r: '5.5', stroke: '#ccc', 'stroke-width': '1.5' }),
      svg('path', { d: 'M7 1.5A5.5 5.5 0 0 1 12.5 7', stroke: '#888', 'stroke-width': '1.5', 'stroke-linecap': 'round' })
    );

    const spinner = el('span', { id: 'tp-spinner', hidden: '' }, spinnerSvg);

    return el('div', { id: 'tp-sidebar' },
      el('button', { id: 'tp-toggle-btn', title: 'Hide Thinking Probe' },
        document.createTextNode('Hide')
      ),
      el('div', { id: 'tp-panel' },
        el('div', { id: 'tp-header' },
          el('span', { id: 'tp-title' }),
          spinner
        ),
        el('div', { id: 'tp-status' }),
        el('div', { id: 'tp-probes-list' }),
        el('div', { id: 'tp-toast', hidden: '' })
      )
    );
  }

  // --- MutationObserver ---

  function startObserver(editor) {
    const debouncedFullScan = window.debounce(checkForChanges, DEBOUNCE_MS);
    const debouncedParaCheck = window.debounce(checkForNewParagraph, PARA_DEBOUNCE_MS);

    observer = new MutationObserver(() => {
      debouncedFullScan();
      debouncedParaCheck();
    });
    observer.observe(editor, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
  }

  function checkForChanges() {
    console.log('[TP] debounce fired → sending PROBE_TRIGGER');
    chrome.runtime.sendMessage({ type: 'PROBE_TRIGGER' }, () => void chrome.runtime.lastError);
  }

  function checkForNewParagraph() {
    const paras = document.querySelectorAll('.kix-paragraphrenderer');
    const count = paras.length;
    console.log('[TP] para check: count=', count, 'last=', lastParaCount);

    if (lastParaCount === -1) {
      lastParaCount = count;
      return;
    }

    if (count > lastParaCount) {
      lastParaCount = count;
      console.log('[TP] new paragraph detected → sending PROBE_TRIGGER_PARA');
      chrome.runtime.sendMessage({ type: 'PROBE_TRIGGER_PARA' }, () => void chrome.runtime.lastError);
    } else {
      lastParaCount = count;
    }
  }

  // --- Inline highlights ---
  // Note: .kix-paragraphrenderer may not exist in fully canvas-rendered docs.
  // Highlights are best-effort; the passage text in the sidebar is authoritative.

  function applyHighlights(probes) {
    clearHighlights();
    if (!probes || probes.length === 0) return;

    const paragraphs = document.querySelectorAll('.kix-paragraphrenderer');
    paragraphs.forEach((p) => {
      const pText = p.innerText || '';
      const matchesAny = probes.some(({ passage }) => {
        const sentences = passage
          .split(/(?<=[.!?])\s+/)
          .map(s => s.trim())
          .filter(s => s.length > 10);
        return sentences.length > 0
          ? sentences.some(s => pText.includes(s))
          : pText.includes(passage.substring(0, 40));
      });

      if (matchesAny) {
        p.style.background = 'rgba(255, 200, 50, 0.35)';
        p.dataset.tpHighlighted = '1';
        highlightedEls.push(p);
      }
    });
  }

  function clearHighlights() {
    highlightedEls.forEach((el) => {
      el.style.background = '';
      delete el.dataset.tpHighlighted;
    });
    highlightedEls = [];
  }

  // --- Accept edit: copy suggestion to clipboard ---

  function handleAcceptEdit(e) {
    const { suggestion } = e.detail;
    clearHighlights();

    // Use a hidden textarea + execCommand — works in content scripts where
    // navigator.clipboard is restricted without explicit user-gesture focus.
    const ta = document.createElement('textarea');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
    ta.value = suggestion;
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);

    document.dispatchEvent(new CustomEvent('tp:toast', {
      detail: {
        message: ok
          ? 'Copied! Select the passage in your doc and paste to replace it.'
          : 'Select the suggestion text above and copy it manually.',
      },
    }));
  }
})();
