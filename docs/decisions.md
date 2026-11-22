# Design Decisions (`docs/decisions.md`)

Architectural and algorithmic decisions for BitextFolio, including rationale, numeric thresholds, false-positive trade-offs, and rejected alternatives.

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
