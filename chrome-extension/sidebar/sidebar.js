// Sidebar content script — manages sidebar UI interactions.
// Runs in the same page context as content.js.
// Communicates with content.js via CustomEvents on document.
// Communicates with background.js via chrome.runtime.sendMessage.

(function initSidebar() {
  const MAX_WAIT_MS = 10000;
  const POLL_INTERVAL = 100;
  let elapsed = 0;

  const poll = setInterval(() => {
    elapsed += POLL_INTERVAL;
    if (document.getElementById('tp-sidebar')) {
      clearInterval(poll);
      setupSidebar();
    } else if (elapsed >= MAX_WAIT_MS) {
      clearInterval(poll);
    }
  }, POLL_INTERVAL);
})();

function setupSidebar() {
  const sidebar = document.getElementById('tp-sidebar');
  const toggleBtn = document.getElementById('tp-toggle-btn');
  const refreshBtn = document.getElementById('tp-refresh-btn');
  const statusEl = document.getElementById('tp-status');
  const spinner = document.getElementById('tp-spinner');
  const probesList = document.getElementById('tp-probes-list');
  const toastEl = document.getElementById('tp-toast');

  let isCollapsed = false;

  chrome.storage.local.get('apiKey', ({ apiKey }) => {
    if (!apiKey) {
      setStatus('Add your API key in the extension options to get started.');
    }
  });

  // --- Refresh: clear probed state and trigger a fresh scan ---
  refreshBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'PROBE_REFRESH' }, () => void chrome.runtime.lastError);
  });

  // --- Toggle panel ---
  toggleBtn.addEventListener('click', () => {
    isCollapsed = !isCollapsed;
    sidebar.classList.toggle('collapsed', isCollapsed);
    toggleBtn.textContent = isCollapsed ? 'show' : 'hide';
  });

  // --- Probes ready: render card list ---
  document.addEventListener('tp:probes-ready', (e) => {
    const { probes, replace } = e.detail;
    hideSpinner();
    setStatus('');
    renderProbeCards(probes, replace);
    if (isCollapsed) {
      isCollapsed = false;
      sidebar.classList.remove('collapsed');
      toggleBtn.textContent = 'hide';
    }
  });

  // --- Probe loading state ---
  document.addEventListener('tp:probe-loading', () => {
    showSpinner();
    setStatus('Analysing…');
  });

  // --- Errors ---
  document.addEventListener('tp:error', (e) => {
    hideSpinner();
    const { code } = e.detail;
    if (code === 'no_api_key') {
      setStatus('Add your API key in the extension options to get started.');
    } else if (code === 'need_screen_reader') {
      setStatus('One-time setup needed: in Google Docs open Tools → Accessibility settings → turn on "Screen reader support", then reload this page.');
    } else {
      setStatus(`Error: ${e.detail.message}`);
    }
  });

  // --- Toast notifications ---
  document.addEventListener('tp:toast', (e) => {
    showToast(e.detail.message);
  });

  // --- Probe card rendering ---

  function renderProbeCards(probes, replace) {
    if (replace) {
      // Keep cards the user has already copied — only clear unactioned ones
      const unactioned = probesList.querySelectorAll('.tp-probe-card:not(.tp-card-kept)');
      unactioned.forEach(el => el.remove());
    }
    probes.forEach(probe => probesList.appendChild(createProbeCard(probe)));
  }

  function createProbeCard({ passage, question }) {
    const card = document.createElement('div');
    card.className = 'tp-probe-card';

    // Dismiss card button
    const dismissCardBtn = document.createElement('button');
    dismissCardBtn.className = 'tp-card-close';
    dismissCardBtn.textContent = '×';
    dismissCardBtn.addEventListener('click', () => card.remove());

    // Passage quote
    const passageEl = document.createElement('blockquote');
    passageEl.className = 'tp-card-passage';
    passageEl.textContent = passage;

    // Probe question
    const questionEl = document.createElement('div');
    questionEl.className = 'tp-card-question';
    questionEl.textContent = question;

    // Response textarea
    const responseInput = document.createElement('textarea');
    responseInput.className = 'tp-card-response';
    responseInput.placeholder = 'Your thoughts…';
    responseInput.rows = 3;

    // Submit button
    const submitBtn = document.createElement('button');
    submitBtn.className = 'tp-card-submit';
    submitBtn.textContent = 'Submit';

    // Suggestion area (shown after submit)
    const suggestionArea = document.createElement('div');
    suggestionArea.className = 'tp-card-suggestion-area';
    suggestionArea.hidden = true;

    const suggestionEl = document.createElement('div');
    suggestionEl.className = 'tp-card-suggestion';

    const editActions = document.createElement('div');
    editActions.className = 'tp-card-edit-actions';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'tp-card-accept';
    acceptBtn.textContent = 'Copy & Paste';

    const dismissEditBtn = document.createElement('button');
    dismissEditBtn.className = 'tp-card-dismiss-edit';
    dismissEditBtn.textContent = 'Dismiss';

    editActions.appendChild(acceptBtn);
    editActions.appendChild(dismissEditBtn);
    suggestionArea.appendChild(suggestionEl);
    suggestionArea.appendChild(editActions);

    card.appendChild(dismissCardBtn);
    card.appendChild(passageEl);
    card.appendChild(questionEl);
    card.appendChild(responseInput);
    card.appendChild(submitBtn);
    card.appendChild(suggestionArea);

    // Current suggestion for accept/dismiss handlers
    let currentSuggestion = null;

    acceptBtn.addEventListener('click', () => {
      if (!currentSuggestion) return;
      document.dispatchEvent(new CustomEvent('tp:accept-edit', {
        detail: { original: passage, suggestion: currentSuggestion },
      }));
      // Mark card so it survives the next full-scan replacement
      card.classList.add('tp-card-kept');
      // Flash confirmation — card stays so user can see what to paste
      acceptBtn.textContent = 'Copied!';
      acceptBtn.disabled = true;
      setTimeout(() => {
        acceptBtn.textContent = 'Copy & Paste';
        acceptBtn.disabled = false;
      }, 2000);
    });

    dismissEditBtn.addEventListener('click', () => {
      card.remove();
    });

    submitBtn.addEventListener('click', () => {
      const userResponse = responseInput.value.trim();
      if (!userResponse) return;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Thinking…';
      suggestionArea.hidden = true;

      chrome.runtime.sendMessage(
        { type: 'RESPONSE_SUBMITTED', passage, question, userResponse },
        (response) => {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit';

          if (!response || response.type === 'EDIT_ERROR') {
            const errMsg = response?.error === 'no_api_key'
              ? 'Add your API key in the extension options.'
              : (response?.error || 'Unknown error');
            showToast(`Couldn't generate suggestion: ${errMsg}`);
            return;
          }

          currentSuggestion = response.suggestion;
          suggestionEl.textContent = currentSuggestion;
          suggestionArea.hidden = false;
        }
      );
    });

    return card;
  }

  // --- Helpers ---

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function showSpinner() {
    spinner.hidden = false;
  }

  function hideSpinner() {
    spinner.hidden = true;
  }

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    setTimeout(() => { toastEl.hidden = true; }, 5000);
  }
}
