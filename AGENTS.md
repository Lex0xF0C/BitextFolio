# AGENTS.md

Guidelines for coding agents and contributors working on this repository.

## 1. Project Mission & Non-Negotiable Principles

**BitextFolio** is a **browser-only, zero-build, deterministic English-Japanese bilingual translation review workbench** designed for direct deployment on **GitHub Pages** (`Settings > Pages > Deploy from a branch > /(root)`).

Every change MUST preserve these core invariants:

1. **Zero External Network Communication**:
   - All text processing, persistence, and exports run 100% locally in the user's browser.
   - **NEVER** introduce `fetch()`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon()`, external CDNs, external Web Fonts, analytics/telemetry scripts, or external AI / machine-translation API calls.
2. **Strict Content Security Policy (CSP) Compliance**:
   - `index.html` enforces:
     `default-src 'self'; connect-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none';`
   - **NEVER** add inline `<script>`, inline `<style>`, `style="..."` HTML attributes, `on*="..."` HTML event attributes, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval()`, or `new Function()`.
   - **NEVER** import `.css` files from `.js` modules (keep CSS loaded solely via `<link rel="stylesheet" href="./styles/app.css" />` in `index.html`).
   - Construct all dynamic DOM nodes safely using `document.createElement`, `document.createTextNode`, `textContent`, or `el()` from `js/ui/render-helpers.js`.
3. **Zero-Build GitHub Pages Compatibility**:
   - Production execution must NOT require Node.js, bundlers, transpilers, or GitHub Actions build steps.
   - `index.html` must directly load native ES Modules (`<script type="module" src="./js/main.js"></script>`).
   - Always use **relative paths** (`./...` or `../...`) rather than root-absolute paths (`/...`) so deployment under a GitHub Pages subpath (`https://<user>.github.io/<repo>/`) works identically to root hosting.
   - Keep `.nojekyll` at the repository root so GitHub Pages serves ES Modules and files verbatim.
4. **Deterministic Behavior Only (No AI / MT)**:
   - Sentence splitting, alignment hints, glossary matching, translation memory similarity (character n-gram Jaccard), term candidate extraction, and omission/contamination detection must remain strictly deterministic and reproducible.
   - The tool assists human reviewers with hints and state tracking; it must never auto-judge translation accuracy via LLMs.

---

## 2. Architecture & Layer Boundaries

```text
index.html                  # Entry point with strict CSP & relative asset links
styles/app.css              # Design tokens, light/dark themes, layout & component styles
js/
├── main.js                 # App bootstrap & global keyboard shortcuts
├── core/                   # PURE domain modules (ZERO DOM / browser API dependencies)
│   ├── lang-classifier.js  # Kana/kanji vs Latin ratio classification
│   ├── markers.js          # Sentence marker intervals, split/merge remapping, token slicing
│   ├── markup.js           # Inline markup tokenization/stripping, deterministic FNV hashing
│   ├── block-parser.js     # Blank-line block parsing, alternating & English-only pairing
│   ├── sentence-splitter.js# EN/JA deterministic sentence splitting & list-line splitting
│   ├── alignment.js        # n:m group operations, anchor hints, DP alignment
│   ├── clauses.js          # Non-destructive ad-hoc clause comparison pairs & chunker
│   ├── hash-diff.js        # Source-replacement hash reconciliation
│   ├── glossary.js         # EN inflection + manual variants, JA normalization, CSV/TSV
│   ├── tm.js               # Char n-gram TM, discrepancy detection, TMX 1.4b, term extraction
│   ├── hints.js            # Number/URL/acronym omission, contamination & copy-paste checks
│   └── document-builder.js # Project/block construction, stats, inline text editing
├── storage/                # Browser-local persistence & local file I/O
│   ├── indexed-db.js       # IndexedDB (with localStorage fallback); bump DB_VERSION on new stores
│   └── json-io.js          # UTF-8 FileReader & Blob downloads (JSON / CSV / TSV / TMX)
├── state/
│   └── store.js            # Reactive store, debounced auto-save, actions
└── ui/
    ├── render-helpers.js   # Safe DOM builder `el()`, filter predicates, status labels
    ├── workspace.js        # Virtualized review workspace, D&D, context menu, inline editors
    └── modals.js           # Import/replace, JSON backup, glossary, TM/candidates, settings
tests/
└── core.test.js            # Node.js built-in test suite (`node --test`)
```

### Layering Rules
- **`js/core/` MUST stay DOM-free**: Never reference `window`, `document`, `localStorage`, or `indexedDB` inside `js/core/`. Every new core algorithm must be exported cleanly and covered by tests in `tests/core.test.js`.
- **IndexedDB Migrations**: When adding an object store in `js/storage/indexed-db.js`, increment `DB_VERSION`, create the store inside `onupgradeneeded` only if `!db.objectStoreNames.contains(...)`, and update the `localStorage` fallback helpers to match.
- **UI & Accessibility**:
  - Preserve high-contrast light-first editorial styling with manual dark mode toggle (`html.dark`).
  - Never convey state by color alone—pair status colors with icons and explicit text labels.
  - Preserve focus and cursor positions when re-rendering active `<textarea>`/`<input>` controls.
  - Ensure every UI control in `workspace.js` and `modals.js` is wired to a real action (no placeholder/dead buttons).

---

## 3. Windows & Cross-Platform Input Handling

- Parsers must normalize `\r\n` / `\r` line endings to `\n` and strip leading UTF-8 BOM (`\uFEFF`) on `.txt`, `.md`, `.csv`, `.tsv`, and `.json` inputs.
- Avoid platform-specific path assumptions.

---

## 4. Verification Checklist (Run Before Every Commit / Push)

1. **Run unit tests** (requires Node.js 20+, zero npm dependencies needed):
   ```bash
   node --test tests/core.test.js
   ```
2. **Audit network & CSP safety** (confirm zero network calls, zero external URLs, and zero unsafe DOM injection):
   ```bash
   grep -rnE 'fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon' index.html styles js
   grep -rnE 'https?://' index.html styles js
   grep -rnE 'innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function' index.html js
   ```
   - Expected: zero network API calls, zero external HTTP(S) URLs (only standard SVG `xmlns` data-URI or regex literals if present), and zero unsafe HTML/eval usage.
3. **Optional type/lint check** (if `npm install` has been run locally):
   ```bash
   npm run lint
   ```
4. **Browser smoke test**:
   - Serve over HTTP (e.g., `npm run dev` or `python -m http.server 8080`)—do not test with `file://` due to browser ES Module CORS restrictions.
   - Check DevTools Console and Network tab: confirm **0 external requests** and **0 CSP errors**.
