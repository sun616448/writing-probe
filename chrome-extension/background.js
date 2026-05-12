// Background service worker — handles text extraction and all Claude API calls.
// Text extraction runs in the page's main world via chrome.scripting.executeScript
// because Google Docs renders text on canvas; document.execCommand('selectAll') only
// works correctly when called from the main world (not the content script isolated world).

const PROBE_MODEL = 'claude-haiku-4-5-20251001';
const EDIT_MODEL = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MIN_TOTAL_WORDS = 20;
const MIN_DELTA_WORDS = 5;
const MAX_PARA_PROBES = 6;

// Per-tab state: word-count delta tracking + set of already-probed paragraph fingerprints
const tabState = new Map();

// First 80 chars of a paragraph — stable enough to detect "same paragraph" across triggers
function paraKey(p) {
  return p.slice(0, 80);
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[TP bg] message:', message.type, 'tab:', sender.tab?.id);

  if (message.type === 'PROBE_TRIGGER') {
    const tabId = sender.tab?.id;
    if (tabId) triggerMultiProbe(tabId, false);
    return false;
  }

  if (message.type === 'PROBE_TRIGGER_PARA') {
    const tabId = sender.tab?.id;
    if (tabId) setTimeout(() => triggerMultiProbe(tabId, true), 300);
    return false;
  }

  if (message.type === 'PROBE_REFRESH') {
    const tabId = sender.tab?.id;
    // Don't clear probedParas — triggerMultiProbe will skip already-seen paragraphs
    // and auto-reset the cycle only when all paragraphs are exhausted
    if (tabId) triggerMultiProbe(tabId, true, true);
    return false;
  }

  if (message.type === 'RESPONSE_SUBMITTED') {
    // Reset word-count baseline but keep probedParas — don't re-surface questions the user already saw
    const tabId = sender.tab?.id;
    if (tabId) {
      const prev = tabState.get(tabId);
      tabState.set(tabId, { lastWordCount: 0, probedParas: prev?.probedParas || new Set() });
    }
    handleEditSuggestion(message.passage, message.question, message.userResponse, sendResponse);
    return true;
  }

  if (message.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
});

// --- Multi-probe trigger ---

async function triggerMultiProbe(tabId, skipDelta, replace = !skipDelta) {
  try {
    const raw = await extractDocText(tabId);

    // Google Docs body is canvas-rendered; text is only DOM-accessible with screen reader support on.
    // Detect this by checking whether the raw selection contains the screen reader prompt.
    if (raw.includes('Turn on screen reader support')) {
      push(tabId, { type: 'PROBE_ERROR', error: 'need_screen_reader' });
      return;
    }

    const text = cleanDocText(raw);
    const totalWords = countWords(text);

    const state = tabState.get(tabId) || { lastWordCount: 0, probedParas: new Set() };
    if (totalWords < MIN_TOTAL_WORDS) return;
    if (!skipDelta && totalWords - state.lastWordCount < MIN_DELTA_WORDS) return;

    state.lastWordCount = totalWords;
    tabState.set(tabId, state);
    push(tabId, { type: 'PROBE_STARTED' });

    const { apiKey } = await chrome.storage.local.get('apiKey');
    if (!apiKey) {
      console.warn('[TP bg] no API key');
      push(tabId, { type: 'PROBE_ERROR', error: 'no_api_key' });
      return;
    }

    // Fetch a larger pool so we have unprobed candidates after filtering
    const allParas = extractLastParagraphs(text, MAX_PARA_PROBES * 3);
    let newParas = allParas.filter(p => !state.probedParas.has(paraKey(p)));

    // All paragraphs exhausted — reset cycle so refresh keeps rotating through new questions
    if (newParas.length === 0 && allParas.length > 0) {
      state.probedParas.clear();
      newParas = allParas;
    }

    const paragraphs = newParas.slice(-MAX_PARA_PROBES);

    console.log('[TP bg] paragraphs to probe:', paragraphs.length,
      '(', allParas.length - paragraphs.length, 'already probed, skipped)');

    if (paragraphs.length === 0) {
      console.log('[TP bg] skipped: no qualifying paragraphs found');
      return;
    }

    // Mark in-flight immediately — prevents a second concurrent trigger from re-sending the same paragraphs
    for (const p of paragraphs) state.probedParas.add(paraKey(p));

    const probes = await callClaudeForMultiProbe(paragraphs, apiKey);

    console.log('[TP bg] probes ready:', probes.length);
    push(tabId, { type: 'PROBES_READY', probes, replace });
  } catch (err) {
    console.error('[TP bg] error:', err);
    push(tabId, { type: 'PROBE_ERROR', error: err.message });
  }
}

function extractLastParagraphs(text, maxN) {
  return text
    .split(/\n+/)
    .map(p => p.trim())
    .filter(p => countWords(p) >= 10)
    .slice(-maxN);
}

// Runs in the page's main world. Google Docs body text is DOM-accessible only when
// screen reader support is enabled (Tools → Accessibility → Turn on screen reader support).
// Without it, selectAll captures only the document title from the title <div>.
async function extractDocText(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      if (!document.querySelector('.kix-appview-editor')) return '';
      document.execCommand('selectAll');
      const text = window.getSelection().toString();
      window.getSelection().removeAllRanges();
      return text;
    },
  });
  return results?.[0]?.result || '';
}

function cleanDocText(raw) {
  return raw
    .replace(/Turn on screen reader support[\s\S]*?⌘slash\n?/g, '')
    .replace(/Banner hidden\s*/g, '')
    .replace(/THINKING PROBE[\s\S]*$/, '')
    .trim();
}

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function push(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// --- Multi-probe generation (Claude Haiku) ---

const PROBE_SYSTEM =
  'You are a Socratic writing coach. Given paragraphs from a writer\'s draft, generate one focused probe question per paragraph — the question a sharp colleague would ask: "wait, have you actually thought about...?" Questions must be specific to the text (never generic), under 25 words each.';

async function callClaudeForMultiProbe(paragraphs, apiKey) {
  const paragraphsText = paragraphs
    .map((p, i) => `<paragraph index="${i + 1}">\n${p}\n</paragraph>`)
    .join('\n\n');

  const userPrompt =
    `Here are ${paragraphs.length} paragraph(s) from the writer's draft. Generate one probe question per paragraph.\n\n${paragraphsText}\n\nRespond ONLY as a JSON array:\n[\n  { "passage": "key phrase or sentence to highlight (max 2 sentences)", "question": "your probe question" },\n  ...\n]`;

  const result = await callClaude(PROBE_MODEL, PROBE_SYSTEM, userPrompt, apiKey);

  const jsonMatch = result.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array in response');

  const parsed = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed)) throw new Error('Expected array response');

  return parsed.filter(p => p.passage && p.question);
}

// --- Edit suggestion generation (Claude Sonnet) ---

async function handleEditSuggestion(passage, question, userResponse, sendResponse) {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    sendResponse({ type: 'EDIT_ERROR', error: 'no_api_key' });
    return;
  }

  const userPrompt =
    `A writer was asked to examine the following passage from their work:\n\n<passage>\n${passage}\n</passage>\n\nThe probe question was:\n"${question}"\n\nThe writer's response was:\n"${userResponse}"\n\nBased on the writer's response, suggest a concrete revision to the passage that incorporates their refined thinking. Return ONLY the revised passage text — no preamble, no explanation. Match the writer's existing tone and style.`;

  try {
    const result = await callClaude(EDIT_MODEL, null, userPrompt, apiKey);
    sendResponse({ type: 'EDIT_READY', suggestion: result.trim() });
  } catch (err) {
    sendResponse({ type: 'EDIT_ERROR', error: err.message });
  }
}

// --- Shared Claude API fetch ---

async function callClaude(model, systemPrompt, userPrompt, apiKey) {
  const body = {
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: userPrompt }],
  };
  if (systemPrompt) body.system = systemPrompt;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${res.status}`);
  }

  const data = await res.json();
  return data.content[0].text;
}
