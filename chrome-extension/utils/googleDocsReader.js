// Google Docs text extraction utilities
// Modern Google Docs renders text on canvas tiles — no text nodes exist in the DOM.
// document.execCommand('selectAll') triggers Google Docs' internal select-all handler,
// which exposes the full document text via getSelection().toString().
// All three selection steps are synchronous so no repaint occurs — the user sees nothing.

window.getDocText = function getDocText() {
  const editor = document.querySelector('.kix-appview-editor');
  if (!editor) return '';

  const sel = window.getSelection();

  document.execCommand('selectAll');
  const raw = sel.toString();
  sel.removeAllRanges();

  // Strip the static Google Docs accessibility banner that appears in the selection.
  const cleaned = raw
    .replace(/Turn on screen reader support[\s\S]*?⌘slash\n?/g, '')
    .replace(/Banner hidden\s*/g, '')
    // Strip our own sidebar text in case it gets captured.
    .replace(/THINKING PROBE[\s\S]*$/, '')
    .trim();

  const words = cleaned.split(/\s+/).filter(Boolean);
  // Return last ~300 words
  return words.slice(-300).join(' ');
};

window.countWords = function countWords(text) {
  if (!text || !text.trim()) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
};
