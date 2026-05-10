# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Thinking Probe** is a Chrome extension (Manifest V3) that acts as a Socratic co-writer for Google Docs. It monitors writing in real-time, surfaces targeted questions that probe the quality of the user's thinking, and suggests concrete edits based on the user's responses.

The full specification lives in `PRD.MD`.

## Planned File Structure

```
chrome-extension/
├── manifest.json          # MV3 manifest
├── background.js          # Service worker — handles all Claude API calls
├── content.js             # Injected into Google Docs — DOM observer, sidebar injection
├── sidebar/
│   ├── sidebar.html
│   ├── sidebar.css
│   └── sidebar.js         # Sidebar logic and message passing
├── icons/
│   └── icon-*.png
└── utils/
    ├── debounce.js
    └── googleDocsReader.js  # Extracts text from Google Docs DOM
```

## Architecture

### Message Passing Flow
All Claude API calls go through `background.js` (service worker) — never directly from content scripts.

1. `content.js` detects text changes → `{ type: "TEXT_CHANGED", text }` → `background.js`
2. `background.js` calls Claude → `{ type: "PROBE_READY", passage, question }` → `content.js` / `sidebar.js`
3. User submits response → `sidebar.js` sends `{ type: "RESPONSE_SUBMITTED", ... }` → `background.js` → Claude → `{ type: "EDIT_READY", suggestion }`

### Two Claude API Calls (different models)
- **Probe generation** (`claude-haiku-*`): fast, cheap — identifies the weakest passage and returns `{ passage, question }` as JSON
- **Edit suggestion** (`claude-sonnet-*`): higher quality — returns only the revised passage text, no preamble

### Google Docs Text Extraction
Google Docs uses a canvas/DOM hybrid — not a standard `<textarea>`. Extract text via:
```js
document.querySelectorAll('.kix-paragraphrenderer')
```
Watch `.kix-appview-editor` with `MutationObserver`. These class names are brittle and may change — this is the highest-risk part of the implementation.

### Triggering Logic
- Debounce: **2500ms** after last keystroke
- Minimum delta: **≥ 25 new words** since last API call
- Minimum document size: **≥ 50 words** total
- Only send the **last ~300 words**, not the full document
- Cache last analysis hash to skip unchanged content

### API Key
- Stored in `chrome.storage.local` (user provides their own Anthropic key)
- Prompt for key on first install; show "Add API key to get started" in sidebar if missing

## Key Constraints

- **One active probe at a time** — clear previous highlight before setting a new one
- **Highlight style:** subtle light amber underline, not alarming red
- **Sidebar:** 320px fixed right panel; must not interfere with Google Docs toolbar or native sidebar
- **MV3:** API calls must route through the background service worker due to MV3 CSP restrictions

## Manifest Permissions

```json
{
  "permissions": ["storage", "activeTab", "scripting"],
  "host_permissions": [
    "https://docs.google.com/*",
    "https://api.anthropic.com/*"
  ]
}
```

## Loading the Extension for Development

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `chrome-extension/` directory
4. Open a Google Doc to test

After any code change, click the refresh icon on the extension card in `chrome://extensions`, then reload the Google Doc tab.
