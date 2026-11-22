# Changelog

All notable changes to BitextFolio are recorded in this file (newest first).

## 2026-11-22

- Made the Translation Memory / Glossary list, candidate extraction results, and reverse-lookup boxes in `modals.js` taller (`420px` default with sticky table headers) and vertically resizable (`resize: vertical`) inside a wider modal (`is-wide`).
- Added per-entry `exactMatch` option (`単複・活用を区別する（厳密一致）`) in glossary/TM entries, quick-register bar, and CSV/TSV import/export to disable automatic plural/inflection stem matching when singular and plural forms require distinct translations.
- Extracted pure virtual-window range and scroll-anchoring math from `js/ui/workspace.js` into `js/core/virtual-window.js` with unit tests (§5.3 step 1).
- Fixed `el()` in `js/ui/render-helpers.js` to set `.value` directly for `<textarea>`, `<input>`, `<select>`, and `<option>` elements so existing memo, sentence-edit, Japanese-block, and abbreviations values populate properly.
- Separated machine glossary match styling and warning wording from human confirmation (`P1` / `§4`): changed `.glossary-ok-line` to neutral info blue (`--status-read-fg`) with `ℹ 登録訳語を検出`, and updated warning labels to factual phrasing (`非推奨訳語の候補を検出`, `登録訳語が未検出`, `用語未一致・非推奨候補`).
- Removed unused `MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API` from `metadata.json` (`P3` / `P4`).
- Added `tests/invariants.test.js`, `tests/render-helpers.test.js`, `CHANGELOG.md`, and `docs/decisions.md` per `AGENTS.md`.
- Fixed in-place `Set` mutation on `state.openMemoGroupIds` in `js/state/store.js` and extracted shared term-wrapping helper `wrapTermHighlightNode` in `js/ui/render-helpers.js`.
- Added 1-click combined block + boundary sentence merge actions (`次ブロック＋境界文結合` on block headers and `次ブロック＋次文結合↓` on the last sentence of a block when the following block has sentences in that language).

## 2026-11-21

- Updated `AGENTS.md` to establish Tier 1 principles (P1–P6), §4 vocabulary/visual rules, UI refactoring constraints, verification checklist, and known gaps.
- Implemented deterministic fuzzy Japanese typo / omission / insertion / adjacent-swap detection (`findJapaneseFuzzyTermSpans` via semi-global Damerau-Levenshtein DP with particle/punctuation boundary guards), ON/OFF toggle, 3-character minimum-length option, wavy red highlight (`.is-typo`), and dismissal/restore support.
- Unified Translation Memory (word/phrase level) with Glossary & Reverse Lookup, stopped auto-saving whole sentences as TM records on `verified`, and added dashed underline highlighting for registered EN/JA terms.
- Added marker support inside Clause Comparison workbench cards and fixed auto-scroll triggering unexpectedly during manual scrolling.
