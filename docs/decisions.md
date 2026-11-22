# Design Decisions (`docs/decisions.md`)

Architectural and algorithmic decisions for BitextFolio, including rationale, numeric thresholds, false-positive trade-offs, and rejected alternatives.

---

## 2026-11-22 — XLIFF 2.1 Data Interchange, JSON Schema (`v2`), and Stepwise Migrations (`js/core/schema.js`, `js/core/xliff.js`)

- **Decision**:
  1. Add OASIS XLIFF 2.1 (`urn:oasis:names:tc:xliff:document:2.0`, `version="2.1"`) bilingual export and import via a DOM-free, DTD/ENTITY-rejecting XML parser in `js/core/xliff.js`. Enforce XLIFF 2.1 constraints: `state="initial"` on segments without `<target>` (§4.3.1.31), `canResegment="no"` + `bitextfolio:alignmentNote` for `n:m` groups (`enIds.length !== jaIds.length`, Option B as approved by owner), `<cp hex="..."/>` for XML-invalid chars including `U+FFFE`/`U+FFFF` (§4.2.3.1), custom annotation `type="bitextfolio:marker"` (§4.3.1.40 / §4.7.3.1.4), percent-encoded IRI `original` (§4.3.1.25), conditional `trgLang` (§4.2.2.1), `<target order>` reordering (§4.3.1.24), fresh unique group IDs across `<file>` elements, strict root `xmlns` and `en -> ja` direction validation, `xml:space` normalization (§4.3.2.2), and P2 toast notification for non-roundtrippable XLIFF features.
  2. Keep external XLIFF `state="final"` mapping to `'verified'` (reviewed and explicitly approved by owner on 2026-11-22).
  3. Set `literalText: true` on XLIFF-imported `SentenceItem`s (and preserve across split/merge/edit/schema normalization) so plain-text structured imports skip inline Markdown stripping (`stripInlineMarkup`) and inline tokenization (`tokenizeInlineMarkup`), protecting `snake_case` underscores and literal asterisks from corruption and marker offset drift (Option (b) approved by owner on 2026-11-22).
  4. Define `schemas/bitextfolio-export.schema.json` (`schemaVersion: 2`) and implement handwritten deterministic schema validation + stepwise `vN -> vN+1` migrations (`migrateProject`, `migrateExportPayload`, `parseAndValidateImportPayload`) in `js/core/schema.js`, applied on both JSON import and IndexedDB load.
- **Reason**:
  - Keeping per-sentence `<segment>`s with `canResegment="no"` and an explanatory `bitextfolio:alignmentNote` (Option B) preserves exact sentence granularity for BitextFolio round-trips while explicitly communicating `n:m` group boundaries to external CAT tools without leaking structural notes into user `memo`s.
  - Preserving `state="final"` → `'verified'` matches the owner's XLIFF CAT workflow expectations (`final` signifies completed review in external CAT tools), while `reviewed` and `translated` continue to map to `'read'`.
  - Using per-sentence `literalText: true` rather than changing global Markdown parsing avoids breaking existing Markdown-formatted `.txt`/`.md` documents while keeping XLIFF plain text exact.
  - Using a pure JS XML parser and handwritten schema validator satisfies `P4` (zero external network/DTD fetching), `P5` (zero `innerHTML`), `P6` (zero dependencies/build steps), and the DOM-free `js/core/` boundary.
- **Rejected options**: Switching to Option A single-`<segment>` `n:m` concatenation (loses direct segment-level mapping in CAT UIs), downgrading `state="final"` without `subState` to `'read'`, rewriting global `INLINE_TOKEN_RE` regex (Option (a)), adding `ajv`/`fast-xml-parser` npm dependencies (`P6`), or using `DOMParser` in `js/core/`.

---

## 2026-11-22 — 7-Gram Term Candidate Extraction & Configurable Display Limit (`40` / `200` / `500`)

- **Decision**: Extend `extractTermCandidates` in `js/core/tm.js` from 1–3 word n-grams to 1–7 word n-grams (`minN` / `maxN` configurable in UI as `1〜7語`, `2〜7語`, `4〜7語`), raise default `maxResults` from `40` to `200` (UI selectable: `40件` / `200件` / `500件`), tokenize English sentences individually within each alignment group, cache Japanese co-occurrence extraction after slicing `maxResults`, and require full-span glossary coverage (`sp.start === 0 && sp.end === bestDisplay.length`) for `alreadyInGlossary`.
- **Reason**:
  - Multi-word legal/technical terms frequently span 4–7 words; capping at 3-grams missed longer recurring phrases, while capping output at 40 items sorted by frequency caused 1-grams to crowd out multi-word terms and hid `1回以上出現` candidates whenever 40+ higher-frequency items existed.
  - Using substring glossary matching caused a registered 1-word entry to mark 2–7 word compound phrases containing it as "already registered", pushing them to the bottom of the list.
  - Computing Japanese co-occurrence terms lazily after sorting and slicing keeps `minFreq = 1` + 7-gram + `500件` responsive in the browser.
- **Rejected options**: Unbounded DOM rendering of all `1..7`-grams (would risk UI slowdowns on large documents when `minFreq = 1` produces thousands of unique 7-grams).

---

## 2026-11-22 — Per-Entry Inflection Opt-Out (`exactMatch`) for Glossary / TM Entries

- **Decision**: Add an optional boolean `exactMatch` (`単複・活用を区別する（厳密一致）`, default `false`) per glossary/TM entry, supported in the registration modal, inline quick-register bar, and CSV/TSV I/O (with 6-column legacy CSV fallback).
- **Reason**: Automatic bidirectional stem normalization (`-s`, `-ies` ↔ `-y`, `-ed`, `-ing`, etc.) is convenient for general vocabulary, but causes false missing-translation warnings when singular and plural forms carry distinct legal or technical translations and are registered as separate entries. Making opt-out explicit per entry preserves existing behavior for legacy entries while giving reviewers exact control when needed.
- **Rejected options**: Disabling automatic inflection globally (would break matching of regular verb/noun inflections for existing glossaries), or implicitly suppressing stem matches whenever another exact entry exists (harder for reviewers to predict and inspect).

---

## 2026-11-22 — Virtual-Window Pure Calculation Extraction (`js/core/virtual-window.js`)

- **Decision**: Extract `computeVirtualWindowRange` and `computeAnchoredScrollTop` from `js/ui/workspace.js` into a DOM-free `js/core/virtual-window.js` module with TDD unit tests in `tests/core.test.js` (§5.3 step 1).
- **Reason**: Isolating virtual-scroll indexing and anchor compensation into pure functions makes edge cases (empty lists, overscan bounds, jitter thresholds) testable without a browser DOM and begins shrinking `workspace.js` incrementally with minimal regression risk.
- **Rejected options**: Moving DOM-coupled rendering helpers out of `workspace.js` before extracting pure calculations (higher regression risk without DOM tests).

---

## 2026-11-22 — Owner Decisions on §8 Gaps (`confirmedAlignment`, Glossary Styling/Wording, `metadata.json`)

- **Decision (confirmedAlignment)**: Retain `confirmedAlignment` data model and initial 1:1 assignment behavior as-is (explicitly approved by owner).
- **Reason**: Changing `confirmedAlignment` semantics or renaming the field impacts existing `UNCONFIRMED_GROUP` warnings, block mismatch counters, and saved project compatibility; current behavior matches the reviewer's workflow expectations while `status === 'verified'` remains strictly human-only.
- **Decision (Glossary UI & Wording)**: Replace green/`✓` on `.glossary-ok-line` with neutral info blue (`--status-read-fg`) and `ℹ 登録訳語を検出`, and change warning headings (`用語注意` / `用語不統一`) to factual observation wording (`非推奨訳語の候補を検出` / `登録訳語が未検出` / `用語未一致・非推奨候補`).
- **Decision (`metadata.json`)**: Clear `MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API` (`majorCapabilities: []`) to align manifest metadata with `P3` and `P4`.

---

## 2026-11-22 — Invariant Test Suite & Zero-Build Enforcement

- **Decision**: Enforce P1, P2, P4, P5, P6, and the DOM-free `js/core/` boundary via automated Node.js tests in `tests/invariants.test.js`, alongside `tests/core.test.js`.
- **Reason**: Automated verification catches regressions in CSP compliance, relative-path static delivery, and P1/P2 invariants before release without adding external test frameworks or build tools.
- **Rejected options**: Adding third-party linters or browser test runners (adds dev dependencies and contradicts the lightweight zero-build workflow unless explicitly approved).

---

## 2026-11-22 — Combined Block & Boundary Sentence Merge (`mergeWithNextBlockAndBoundarySentences`)

- **Decision**: Keep two separate user actions: existing `次ブロックと結合` (paragraph-preserving structural merge) and the new `次ブロック＋境界文結合` / `次ブロック＋次文結合↓` (merges adjacent blocks and collapses mid-sentence splits across blank lines for `'both'`, `'en'`, or `'ja'`).
- **Reason**: Blank lines in pasted documents sometimes split a single sentence in half across blocks. Combining both steps preserves existing sentence markers, statuses, and memos without forcing the user to click twice or lose alignment work.
- **Rejected options**: Replacing `次ブロックと結合` with boundary merging by default (would silently fuse distinct paragraphs' boundary sentences when users only want to join two paragraphs into one block).

---

## 2026-11-21 — Deterministic Fuzzy Japanese Typo / Omission / Insertion Check (`findJapaneseFuzzyTermSpans`)

- **Decision**: Detect 1–2 character substitutions, omissions (脱字), insertions (衍字), and adjacent swaps (Damerau-Levenshtein) against registered glossary/TM terms whenever an English term matches in the group and no exact Japanese match is found. Provide an explicit ON/OFF toggle (`fuzzyTypoCheck`), configurable minimum length (`fuzzyMinLength`: 4 default, optional 3), wavy red underline (`.is-typo`), and per-occurrence dismissal (`許容・非表示`).
- **Reason**:
  - **Minimum length (`fuzzyMinLength >= 4` default, optional `3`)**: 1–2 character Japanese words with 1 edit distance produce severe false positives (e.g., matching unrelated particles or common 2-kanji compounds). 4+ characters keep precision high for katakana/kanji technical terms, while offering 3 characters as an opt-in setting for strict terminology review.
  - **Edit budget (`maxEdits = termLen >= 9 ? 2 : 1`)**: Allows 1 edit for terms of length 3–8 and up to 2 edits only for long terms of 9+ normalized characters to avoid spurious matches on medium-length words.
  - **Boundary guards**: Leading/trailing hiragana particles (`は`, `が`, `を`, etc.) and punctuation are blocked from absorbing the edit budget unless they actually belong to the term, preventing unrelated words plus an adjacent particle from matching as a 1-character insertion.
- **How false positives appear & how users dismiss them (P2)**:
  - False positives can occur when a short/medium term shares characters with another phrase in the same sentence, or when an author intentionally paraphrases using a near-homograph.
  - Each warning displays `⚠ 誤記・脱字の疑い`, the detected text, the exact character-level operation (`diffSummary`), and the registered term pair, with a direct `許容・非表示` button (stored by deterministic `hintId` in `project.dismissedHints`, restorable individually or globally) plus a toolbar ON/OFF toggle.
- **Rejected options**:
  - Bundling a Japanese morphological dictionary or phonetic/embedding model (violates P3 and increases bundle size/opacity).
  - Running fuzzy search across all glossary entries regardless of English match (would cause alert fatigue on unrelated Japanese words).

---

## 2026-11-21 — Word/Phrase-Level Translation Memory Unified with Glossary

- **Decision**: Unify Translation Memory, Glossary consistency checking, and JA→EN reverse lookup into a single term/phrase store, and stop automatically saving whole sentences into TM when a group is marked `verified`. Highlight matched registered terms with dashed underlines on both English and Japanese text.
- **Reason**: Storing full sentences on every verification polluted TM with sentence-specific noise and slowed review. Phrase/word entries are reusable across documents and enable exact + fuzzy consistency checks.
- **Rejected options**: Retaining automatic sentence-level TM capture alongside phrase entries (caused redundant UI tabs and noisy suggestions).

---

## 2026-11-21 — Tier 1 Principles: Explainability, Verifiability, and No Automation Bias

- **Decision**: Never bundle dictionaries, corpora, LLMs, or ML models (`P3`); keep all processing 100% browser-local with `connect-src 'none'` (`P4`); use zero-build native ES Modules with relative paths (`P6`); reserve `verified`, green, and `✓` strictly for human actions (`P1`).
- **Reason**: Documents under review may be confidential, and human reviewers must be able to inspect why every warning appeared without being misled by machine-generated "OK" signals.
- **Rejected options**: Using client-side ML weights, external translation APIs, or build-step bundlers required for production deployment.
