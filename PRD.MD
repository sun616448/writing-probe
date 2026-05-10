# PRD: Thinking Probe — Chrome Extension
**Version:** 1.0  
**Status:** Draft  
**Last updated:** April 15, 2026

---

## 1. Problem Statement

Writing is thinking made visible — but most writing tools optimize for *how* something is written, not *what* is being said. Grammar checkers (Grammarly et al.) are commoditized and solve a surface problem. The deeper problem is that writers often don't interrogate their own reasoning as they write: claims go unsupported, assumptions go unexamined, and arguments have logical gaps the author can't see because they're too close to the work.

**Thinking Probe** is a Chrome extension that acts as a Socratic co-writer: it reads what you're writing in real-time, surfaces targeted questions that probe the quality of your thinking, and when you respond to a question, suggests concrete edits to your writing that reflect your refined thinking.

---

## 2. Goal

Build a v1 Chrome extension that works on **Google Docs** and:
1. Monitors writing in real-time using a debounced trigger
2. Surfaces inline highlights on weak or under-examined passages
3. Shows a Socratic probe question in a sidebar panel
4. Accepts a user response to the question
5. Suggests specific edits to the document text based on that response

---

## 3. Non-Goals (v1)

- Grammar/spelling correction (this is not Grammarly)
- Support for sites other than Google Docs
- User accounts, login, or data persistence beyond the session
- Mobile support
- Team / collaborative features
- A settings UI (hardcode sensible defaults)

---

## 4. Core User Flow

```
User writes in Google Docs
        ↓
[2-3s pause in typing detected]
        ↓
Extension sends last ~300 words to Claude API
        ↓
Claude returns: (a) highlighted passage + (b) probe question
        ↓
Sidebar shows question; corresponding text is underlined/highlighted inline
        ↓
User reads question → types a response in the sidebar
        ↓
Extension sends (original passage + probe question + user response) to Claude
        ↓
Claude returns suggested edits to the highlighted passage
        ↓
Sidebar shows suggested edit with Accept / Dismiss buttons
        ↓
[If Accepted] Extension replaces text in Google Docs
```

---

## 5. Features

### 5.1 Real-Time Monitoring
- Observe the Google Docs editor for text changes via MutationObserver on the `.kix-appview-editor` DOM element
- Debounce: wait **2500ms** after the last keystroke before triggering analysis
- **Minimum delta threshold:** Only send a new API call if ≥ 25 new words have been written since the last call (prevents rapid re-triggering and controls API cost)
- Do not trigger if the document has fewer than 50 words total (not enough context)

### 5.2 Inline Highlight
- When a probe is generated, highlight the relevant passage in the Google Docs document using a yellow background highlight via the Docs API / DOM injection
- Highlight should be subtle, not alarming (think: light amber underline, not red)
- Only one highlight active at a time; previous highlight is cleared when a new probe is generated

### 5.3 Sidebar Panel
- Injected into the Google Docs page as a fixed right-side panel (320px wide)
- Contains:
  - **Question area:** Displays the current Socratic probe question
  - **Response input:** A textarea where the user types their answer
  - **Submit button:** Sends response + triggers edit suggestion
  - **Edit suggestion area:** Shows the suggested edit to the highlighted text
  - **Accept / Dismiss buttons**
  - **Toggle button:** Collapse/expand the sidebar entirely
- Should not interfere with normal Google Docs UI (toolbar, comments, etc.)

### 5.4 Probe Question Generation (Claude API)
**Trigger prompt (System):**
```
You are a Socratic writing coach. You read a user's draft writing and identify the single most important passage where their thinking is weakest, least examined, or most assumptive. You surface ONE focused question — not a list — that challenges the writer to think more rigorously. Questions should feel like a sharp, smart colleague asking "wait, have you actually thought about...?" NOT like a teacher giving homework. Keep questions under 25 words. Be specific to the text, never generic.
```

**User message format:**
```
Here is what the writer has written so far. Identify the passage that most needs interrogation, and ask one focused question about it.

<writing>
{last 300 words of document}
</writing>

Respond ONLY in this JSON format:
{
  "passage": "the exact text string you want to highlight (max 2 sentences)",
  "question": "your probe question"
}
```

### 5.5 Edit Suggestion Generation (Claude API)
**Triggered after user responds to the probe question.**

**User message format:**
```
A writer was asked to examine the following passage from their work:

<passage>
{highlighted passage}
</passage>

The probe question was:
"{probe question}"

The writer's response was:
"{user response}"

Based on the writer's response, suggest a concrete revision to the passage that incorporates their refined thinking. Return ONLY the revised passage text — no preamble, no explanation. Match the writer's existing tone and style.
```

---

## 6. API Design Considerations

### Cost Management
- Debounce + 25-word minimum delta prevents excessive calls during active typing
- Only the last ~300 words are sent, not the full document
- Cache the last analysis hash — if the content hasn't changed meaningfully, skip the call

### API Key
- For v1: user enters their own Anthropic API key, stored in `chrome.storage.local`
- Display a simple one-time prompt on install to enter the key
- If no key is set, sidebar shows a "Add API key to get started" message

### Model
- Use `claude-haiku-*` for the probe question generation (fast, cheap, good enough)
- Use `claude-sonnet-*` for the edit suggestion (higher quality matters here)

---

## 7. Technical Architecture

```
chrome-extension/
├── manifest.json          # MV3 manifest
├── background.js          # Service worker — handles API calls
├── content.js             # Injected into Google Docs — DOM observer, sidebar injection
├── sidebar/
│   ├── sidebar.html       # Sidebar panel markup
│   ├── sidebar.css        # Sidebar styles
│   └── sidebar.js         # Sidebar logic, message passing
├── icons/
│   └── icon-*.png
└── utils/
    ├── debounce.js
    └── googleDocsReader.js  # Logic for extracting text from Docs DOM
```

### Manifest Permissions
```json
{
  "permissions": ["storage", "activeTab", "scripting"],
  "host_permissions": [
    "https://docs.google.com/*",
    "https://api.anthropic.com/*"
  ]
}
```

### Message Passing
- `content.js` detects text changes → sends `{ type: "TEXT_CHANGED", text: "..." }` to `background.js`
- `background.js` calls Claude API → sends `{ type: "PROBE_READY", passage, question }` back
- `sidebar.js` listens for `PROBE_READY` → renders question
- On user submit, `sidebar.js` sends `{ type: "RESPONSE_SUBMITTED", ... }` → `background.js` → Claude → `{ type: "EDIT_READY", suggestion }`

---

## 8. Google Docs Text Extraction

Google Docs does not use standard `<textarea>` or `contenteditable` elements — it renders text in a custom canvas/DOM hybrid. 

Recommended approach:
- Use `document.querySelectorAll('.kix-paragraphrenderer')` to extract visible paragraph text
- Join paragraphs with newline, take the last ~300 words
- Use `MutationObserver` on `.kix-appview-editor` to detect content changes

> ⚠️ **Known risk:** Google occasionally changes internal class names. This is the most brittle part of the implementation and will need monitoring.

---

## 9. UI/UX Principles

- **Non-intrusive by default.** The sidebar is always visible but quiet when there's no active probe. The highlight is subtle.
- **Never block the writing flow.** Questions appear asynchronously — the user can ignore them and keep writing.
- **One thing at a time.** Only one active probe, one highlight, one question at a time. No stacking.
- **Fast feedback loop.** Debounce target is 2.5s. API response should feel near-instant (target < 3s round-trip).

---

## 10. Success Metrics (v1)

| Metric | Target |
|---|---|
| Probe question relevance (manual review sample) | >70% judged "useful" |
| Time from pause to probe appearing | < 5 seconds |
| Edit suggestion acceptance rate | > 30% |
| API calls per 1000 words written | < 8 |
| Extension crashes / errors per session | 0 |

---

## 11. Out of Scope / Future Versions

| Feature | Version |
|---|---|
| Support for Notion, Gmail, other editors | v2 |
| Probe history / session log | v2 |
| User-configurable probe style (devil's advocate, clarity probe, evidence probe) | v2 |
| Grammar/style suggestions | v3 (maybe never) |
| Sync across devices | v2 |
| Sharing / export of probe session | v3 |

---

## 12. Open Questions

1. **Text extraction reliability:** How stable are Google Docs' internal class names? Should we build a fallback that copies text via `Ctrl+A / Ctrl+C` programmatically?
2. **Highlight injection:** Can we reliably inject highlights into Google Docs' DOM, or do we need to use the Google Docs REST API (which requires OAuth)?
3. **API key UX:** Is asking users to supply their own Anthropic key a conversion killer for non-developers? If so, what's the monetization model?
4. **Sidebar conflicts:** Does the sidebar conflict with Google Docs' own sidebar (outline, comments)?

---

## 13. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Google Docs DOM changes break text extraction | Medium | Monitor + pin to tested selector set; add fallback |
| API costs spiral without proper throttling | Medium | Enforce debounce + word delta + session budget cap |
| Users find probes annoying/interrupting | High | Make sidebar collapsible; add "pause" toggle in v1 |
| Chrome MV3 restrictions block API calls | Low | Route through background service worker |