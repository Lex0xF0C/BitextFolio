# AGENTS.md

Guidance for **every coding agent (Google AI Studio, Claude Code, or any other) and every human** making changes to BitextFolio, an English-Japanese bilingual translation review workbench.

- Last audited: 2026-11-22 (update this date whenever you perform an audit)
- This file is in English. The product UI text is Japanese and must stay Japanese.

---

## 0. How to use this file

- **This file is the source of truth for principles and their reasons.** Design decisions and their rationale go in `docs/decisions.md`; change history goes in `CHANGELOG.md`. Create either file on your first change if it does not exist.
- **Never change or weaken the Tier 1 principles (§2) on your own.** If you think one should change, do not implement it. Explain why and ask the owner. This includes editing AGENTS.md itself to "match the implementation" by loosening a principle.
- **What is deliberately not written here:** file-tree diagrams, test counts, feature lists. They rot as the code changes. Use `ls` for structure, `node --test` for tests, and `CHANGELOG.md` / `README.md` for features.
- Rules without reasons cause bad judgment in edge cases. Every principle below has a **Why**. When in doubt, reason from the Why.

---

## 1. Purpose

BitextFolio supports a **human reviewer** who reads an English paragraph and its Japanese translation closely. It helps check accuracy, omissions, unmatched or contaminated text (typos, copy-paste mistakes), and terminology consistency. **The final judgment on correctness is always made by a human.**

### The core design goal is explainability and verifiability

All judgments are made by JavaScript rules and algorithms, never by an LLM or machine translation. The reason: a human must be able to trace **why a warning appeared** and **verify whether it is right**.

### The main risk is automation bias

Rule-based tools look plain and old-fashioned next to LLMs. Yet an "OK" or a green check on screen can lead a user to think "a smart AI checked this for me." Therefore:

- **The tool is an attention-prompter, not a judge.**
- **No warning does not mean no problem.** Missed issues (false negatives) always exist.

### Secondary purpose

Input documents may be confidential. Nothing is sent outside the browser. The app must remain deployable as static files on GitHub Pages.

---

## 2. Tier 1: inviolable principles

Breaking these defeats the purpose of the tool. Any change requires **explicit approval from the owner**.

### P1. Separate human judgment from machine suggestion in wording, appearance, and data

| Layer | Rule |
|---|---|
| Wording | State what was observed and which rule applied. Do not assert right or wrong (vocabulary in §4). |
| Appearance | Green, check marks, and "confirmed/OK" cues are reserved for states **set by a human**. Machine-derived information uses a neutral "info" look. |
| Data | Never mix human-set values with machine-derived ones. Never store a machine guess under a name that sounds like a human decision. |

- **Invariant:** `status === 'verified'` is set only by an explicit human action. No function in `js/core/` may set it automatically.
- **Why:** if a machine result looks the same as a human confirmation, it triggers automation bias.

### P2. Every warning shows its basis and can be dismissed

- A warning must say **what was detected and by which rule** (the existing `title` / `detail` / `diffSummary` fields are the model). Never output a bare score.
- Do not assert; use phrasing such as "suspected" or "not found".
- Numeric thresholds (e.g., up to 2 edits for terms of 9+ characters) must have a **recorded reason** (a code comment or `docs/decisions.md`). Unexplained magic numbers are holes in explainability.
- Every warning needs a **dismissal path** ("allow / hide"), and dismissals must be restorable.
- When adding a detection rule, record in the decision log **how false positives will appear and how users dismiss them**. Too many warnings cause alert fatigue and bury real ones.
- **Why:** a warning a human cannot verify only adds machine authority.

### P3. No LLMs, machine learning, or machine translation in judgments

- Allowed: rules, algorithms (character n-grams, edit distance, DP alignment, etc.), and **user-authored** glossaries.
- **Do not bundle dictionaries, corpora, or datasets** (except the few sample glossary entries). If you feel one is needed, do not add it; ask the owner.
- **Why:** a judgment whose internals a human cannot inspect defeats explainability. A small local ML model violates this principle even though it makes no network calls.

### P4. Never send input documents outside the browser

- Forbidden: `fetch()`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon()`, external CDNs, external web fonts, analytics/telemetry, external AI or MT APIs.
- Do not loosen the CSP in `index.html` (`default-src 'self'; connect-src 'none'; ...`).
- **Why:** inputs may be confidential, and users must be able to rely on no data leaving the browser.

### P5. CSP-safe DOM construction

- Forbidden: inline `<script>` / `<style>`, `style="..."` attributes, `on*="..."` attributes, `innerHTML` / `outerHTML` / `insertAdjacentHTML`, `eval()`, `new Function`, `document.write`.
- Build dynamic DOM with `document.createElement`, `createTextNode`, `textContent`, or `el()` from `js/ui/render-helpers.js`.
- Load CSS only via `<link rel="stylesheet" href="./styles/app.css" />` in `index.html`. Do not import `.css` from JS.
- **Allowed:** CSSOM assignments such as `element.style.height = ...` are not blocked by CSP and are used (e.g., virtual scrolling, context menu positioning). Forbidden are HTML `style` attributes and `setAttribute('style', ...)`. Do not over-read this rule and break virtual scrolling.

### P6. Zero-build static delivery

- Production loads `<script type="module" src="./js/main.js">` directly. Do not require Node.js, bundlers, transpilers, or GitHub Actions build steps.
- `package.json`, `vite.config.ts`, and `tsconfig.json` are **development aids only**. Do not "improve" the project by switching delivery to a built `dist/`.
- Use relative paths only (`./`, `../`). Root-absolute paths break under GitHub Pages subpaths.
- Keep `.nojekyll` at the repository root.

---

## 3. Tier 2: strong conventions

Not immediately fatal if broken, but do not depart from them without a reason.

- **Layer boundary:** `js/core/` is DOM-free (no `window`, `document`, `localStorage`, `indexedDB`). Every new core algorithm gets tests in `tests/core.test.js`.
- **Immutable updates:** `core/` functions are pure and return new objects via spread. `workspace.js` decides whether to re-render by reference comparison, so replace `Set`s and objects in `store.state` with **new instances**; avoid in-place mutation such as `.add()`.
- **UI:** never convey state by color alone (pair with icon and text). Preserve focus and cursor position of active `<textarea>`/`<input>` across re-renders. No placeholder or dead buttons. Keep the light-first design with manual dark mode (`html.dark`).
- **Data compatibility:** do not break saved IndexedDB data or JSON backups. When adding a field, make old data (without it) still load; add an old-format fixture test where possible. When adding an IndexedDB store, bump `DB_VERSION`, guard creation with `objectStoreNames.contains(...)` inside `onupgradeneeded`, and update the `localStorage` fallback too.
- **Input handling:** strip a leading BOM (`\uFEFF`) and normalize `\r\n` / `\r` to `\n` for `.txt`, `.md`, `.csv`, `.tsv`, and `.json` inputs.
- **Keep changes small:** one feature per task. The bigger the diff, the more likely review and documentation updates are missed.
- **Needs owner approval first:** introducing a framework, converting to TypeScript, adding dependencies, or any big-bang rewrite. (Incremental extraction from `workspace.js` per §5 is wanted and does not need separate approval, but each step must be reported per §7.)
- **Domain terms (keep UI text consistent):** block = a blank-line-separated EN/JA paragraph pair; group = an alignment frame linking sentences (n:m); clause comparison (文節対比) = a temporary side-by-side aid for long sentences; "allow / hide" (許容・非表示) = dismissing a warning.

---

## 4. Vocabulary and visuals (making P1 concrete)

| Machine may use | Machine must not use |
|---|---|
| "not found", "detected", "suspected", "candidate", "hint", "matched" (statements of fact) | "correct", "no problem", "OK", "passed", "approved", "auto-verified", "inconsistent" as a bare conclusion |

- Buttons that represent a **human action** ("Mark verified", "✓ clauses match") may use confirming words, because the human is acting.
- Green and `✓` (`--status-verified-*`) are **reserved for human-set states**. Never use them for machine findings such as glossary matches.
- Labels containing "auto" (e.g., "auto-align with hints") must make clear the result is a **suggestion** only.
- Keep a permanent, visible note that "no warnings does not mean no problems" (e.g., at the top of the help dialog).

---

## 5. Maintainability of the UI layer (`js/ui/workspace.js`)

**Status (2026-11-21):** `workspace.js` is roughly 2,000 lines and by far the largest file; `js/ui/modals.js` is also large. The owner wants maintainability improved. This is a goal, but it must be pursued safely, because the UI layer has **no automated tests**.

### Why it hurts

- One closure, `mountWorkspace`, holds nearly all ephemeral UI state (drag payload, block heights, quick-register state, text drafts, and more) and every renderer. A change anywhere can affect unrelated behavior.
- `renderBlockSection` is a very large function that inlines sentence editing, the clause workbench, the quick-register bar, glossary/hint strips, the footer, and the memo area.
- Rendering tears down and rebuilds the visible window; focus is preserved by a hand-maintained list of tracked inputs in `render()`.
- Machine-generated hints are rendered in several places, so the P1/§4 wording and visual rules can drift.
- Term-underline wrapping logic is duplicated in `renderRichSentenceFragment` and `renderClauseFragment`.
- Very large files are hard for agents to read in full and edit precisely, which leads to partial edits and unnoticed regressions.

### Rules

1. **No net growth.** Put new UI features in new modules under `js/ui/`. Add to `workspace.js` only when unavoidable. Do not mix refactoring with feature work in one task.
2. **Extract incrementally and preserve behavior.** One extraction per task, reported per §7. No big-bang rewrite.
3. **Preferred order (lowest risk first):**
   1. **Pure computation to `js/core/`** (DOM-free, with tests): e.g., the virtual-window range calculation from block heights and scroll position; scroll-anchoring math.
   2. **DOM utilities that hold no app state**, in their own modules: e.g., selection-offset helpers, the context menu.
   3. **Render functions that take explicit parameters** (data plus callbacks) instead of closing over shared state: e.g., sentence node, glossary/hint strips, clause workbench, quick-register bar.
   4. **Only after step 3,** move ephemeral UI state (drafts, quick-register state, drag payload) into an explicit object passed around, or into the store.
4. **Centralize machine-hint rendering in one module** (do this when extracting the glossary/hint strips) so P1 and §4 are enforced in one place.
5. **Remove the duplicated term-wrapping logic** in `render-helpers.js` behind one shared helper.
6. **Respect P5 and P6.** Use native ES modules with relative paths including the `.js` extension. No bundler, no new dependencies. Many small modules are fine.
7. **Compensate for missing UI tests.** Before and after each extraction, run the manual smoke checklist (§6, item 4). Where a DOM-free seam exists, add a core test. Adding a DOM test library (e.g., jsdom) is a new dev dependency and needs owner approval.
8. **Keep focus restoration working.** Any new `<textarea>` / `<input>` that holds user text must be registered in the focus-restoration logic in `render()` (a `data-*` attribute plus a restore selector), or typing will lose focus on re-render.
9. **Soft size guideline.** Mention in your report any file over about 600 lines or function over about 150 lines that you touched, and do not create new ones.

---

## 6. Verification (run on every change)

Requires Node.js 20+. Do not test via `file://` (ES Modules fail to load); serve over HTTP (`npm run dev` or `python -m http.server 8080`).

1. **Unit tests**
   ```bash
   node --test tests/core.test.js
   ```
2. **Invariant audit**
   - If `tests/invariants.test.js` exists, run `node --test tests/*.test.js`. **If it does not exist, creating it is recommended** (checks for P3-P5, no automatic `verified`, and a required basis on every warning).
   - Until then, use the commands below. Expected result: **nothing outside the allowlist**.

   Unix-like:
   ```bash
   grep -rnE 'fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon' index.html styles js
   grep -rnE 'https?://' index.html styles js
   grep -rnE 'innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|document\.write' index.html js
   grep -rnE "setAttribute\(['\"](on|style)|import\(" index.html js
   ```
   Windows (PowerShell):
   ```powershell
   Get-ChildItem -Recurse index.html, js, styles -File | Select-String -Pattern 'fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon'
   Get-ChildItem -Recurse index.html, js, styles -File | Select-String -Pattern 'https?://'
   Get-ChildItem -Recurse index.html, js -File | Select-String -Pattern 'innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|document\.write'
   Get-ChildItem -Recurse index.html, js -File | Select-String -Pattern "setAttribute\(['""](on|style)|import\("
   ```
   **Allowlist (with reasons):**
   - `http://www.w3.org/2000/svg` inside the favicon data URI in `index.html` (an SVG namespace, not a network call).
   - The word `innerHTML` in the header comment of `js/ui/render-helpers.js` (it says the code does *not* use it).
   - Anything else must be investigated, not waved through. If you extend the allowlist, add the reason here.
3. **Browser smoke test:** no CSP errors in the DevTools Console, and **zero external requests** in the Network tab.
4. **Manual UI checklist** (after any change under `js/ui/`):
   - Open the sample document; move between groups with `j` / `k`; set verified / read / needs-review with `v` / `r` / `f`.
   - Select text and apply / remove a marker (`h`, `Shift+h`, context menu).
   - Split, merge, and move a sentence (buttons and drag-and-drop); use "edit sentence".
   - Open the clause workbench, create a pair with `c`, toggle "✓ clauses match".
   - Type in a memo, the Japanese-paragraph editor, and the sentence editor; confirm values are shown and focus survives a re-render.
   - Register a term from the context menu; confirm the underline and warning strips appear.
   - Import dialog, replace-source dialog, JSON export/import, theme toggle, search and filters.

---

## 7. Definition of done and report format

A change that alters features or behavior is done only when the following are satisfied. **Every completion report must include these items:**

```text
[Summary]       What changed and why
[Principles]    Does it touch P1-P6? If so, why, and was it approved?
[Docs updated]
  - CHANGELOG.md: the 1-2 lines added (required for any behavior or feature change)
  - AGENTS.md: does it affect principles, conventions, or known gaps (§8)?
  - README.md: does it affect user-facing descriptions?
  - docs/decisions.md: any new design decision (date, decision, reason, rejected options)
[Verification]  Commands run and results (if not run, say so and why)
[Concerns]      Anything a human should look at; files over the size guideline (§5)
```

- `CHANGELOG.md`: append-only, newest first. Use it as a **history of changes**, not a feature list.
- `docs/decisions.md`: collect the **reasons** that cannot be read from code, e.g., why no dictionaries are bundled, why a threshold has its value, how false positives are tolerated.

---

## 8. Known gaps (as of 2026-11-22; delete each item once resolved)

These are places where the principles and the implementation diverge. If you find one, **do not silently fix it**; report it and confirm with the owner.

1. **`workspace.js` and `modals.js` size** (see §5): `workspace.js` is ~2,980 lines and `modals.js` is ~1,350 lines. (Incremental extraction started on 2026-11-22: term-wrapping deduplicated in `render-helpers.js`, and virtual-window/scroll-anchoring pure math extracted to `js/core/virtual-window.js`.)

*(Note: `confirmedAlignment` initial 1:1 behavior was reviewed with the owner on 2026-11-22 and intentionally kept as-is; see `docs/decisions.md`.)*

---

## 9. Handing over between agents (e.g., AI Studio to Claude Code)

1. **Start with an acceptance test.** Before any change, ask the new agent:
   > Read the repository and list, without guessing or filling gaps: (1) the tool's purpose and the principles to protect, (2) what must not be changed, (3) any mismatches between the documents and the code.

   If the summary is wrong, that is a **defect in the documents**; fix the documents.
2. **Audit leftovers from the previous tool.** Label files that came from a specific tool (e.g., `metadata.json`) as "intentional / leftover / unknown". Ask the owner about the unknown ones.
3. **Bridge instruction files.** If the new tool does not read AGENTS.md automatically, make its own instruction file point to this one. Keep **this file as the single source of truth**; do not duplicate its content. Check the new tool's official documentation for the exact mechanism.
4. **Write conversation decisions into the repository.** Conversations are lost when agents change. Only what is written in `docs/decisions.md` survives.