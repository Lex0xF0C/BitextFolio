/**
 * Deterministic blank-line block splitter, list block detector, and EN->JA pair builder.
 * Zero DOM dependencies.
 */

import { classifyLanguage } from './lang-classifier.js';

const LIST_LINE_RE =
  /^\s*(?:[-*+]\s+|[・•●■▪▫◆◇▶▷※\u2460-\u2473]\s*|(?:(?:\d{1,3}|[A-Za-z])[.)])\s+|(?:[（(]\d{1,3}[）)]|\d{1,3}）)\s*|\d{1,3}．(?![\d０-９]+(?:\s|$|[%％.,．]))\s*)/;

/**
 * Checks whether a single line starts with a bullet or numbered list marker.
 * @param {string} line
 * @returns {boolean}
 */
export function isListLine(line) {
  return LIST_LINE_RE.test(line);
}

/**
 * Determines whether a multi-line block should be treated as a list block
 * where each item line becomes a separate sentence unit.
 * @param {string} rawText
 * @returns {boolean}
 */
export function isListBlock(rawText) {
  const lines = String(rawText || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  if (lines.length === 1) return isListLine(lines[0]);
  let listCount = 0;
  for (const line of lines) {
    if (isListLine(line)) listCount += 1;
  }
  return listCount >= 2 || (listCount >= 1 && isListLine(lines[0]));
}

/**
 * Splits UTF-8 input text by blank lines into classified raw blocks.
 * @param {string} inputText
 * @returns {Array<{
 *   rawIndex: number,
 *   rawText: string,
 *   langInfo: ReturnType<typeof classifyLanguage>,
 *   effectiveLang: 'en'|'ja'|'ambiguous',
 *   isList: boolean
 * }>}
 */
export function splitIntoRawBlocks(inputText) {
  const normalized = String(inputText || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!normalized) return [];

  const chunks = normalized.split(/\n(?:[ \t]*\n)+/);
  return chunks
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((rawText, rawIndex) => {
      const langInfo = classifyLanguage(rawText);
      return {
        rawIndex,
        rawText,
        langInfo,
        effectiveLang: langInfo.lang,
        isList: isListBlock(rawText),
      };
    });
}

/**
 * Pairs raw blocks expecting alternating EN -> JA order.
 * Preserves anomalies by creating provisional pairs with explicit structural warnings.
 * @param {Array<{
 *   rawIndex: number,
 *   rawText: string,
 *   langInfo: ReturnType<typeof classifyLanguage>,
 *   effectiveLang: 'en'|'ja'|'ambiguous',
 *   isList: boolean
 * }>} rawBlocks
 * @returns {Array<{
 *   enRaw: string,
 *   jaRaw: string,
 *   enLang: 'en'|'ja'|'ambiguous'|null,
 *   jaLang: 'en'|'ja'|'ambiguous'|null,
 *   enConfidence: number,
 *   jaConfidence: number,
 *   warnings: string[]
 * }>}
 */
export function pairClassifiedBlocks(rawBlocks) {
  const pairs = [];
  let i = 0;

  while (i < rawBlocks.length) {
    const current = rawBlocks[i];
    const next = i + 1 < rawBlocks.length ? rawBlocks[i + 1] : null;
    const warnings = [];

    if (current.effectiveLang === 'en') {
      if (next && next.effectiveLang === 'ja') {
        if (current.langInfo.confidence < 0.72 || next.langInfo.confidence < 0.72) {
          warnings.push('AMBIGUOUS_LANG');
        }
        pairs.push({
          enRaw: current.rawText,
          jaRaw: next.rawText,
          enLang: current.effectiveLang,
          jaLang: next.effectiveLang,
          enConfidence: current.langInfo.confidence,
          jaConfidence: next.langInfo.confidence,
          warnings,
        });
        i += 2;
      } else if (next && next.effectiveLang === 'en') {
        warnings.push('CONSECUTIVE_EN');
        pairs.push({
          enRaw: current.rawText,
          jaRaw: '',
          enLang: current.effectiveLang,
          jaLang: null,
          enConfidence: current.langInfo.confidence,
          jaConfidence: 0,
          warnings,
        });
        i += 1;
      } else if (next && next.effectiveLang === 'ambiguous') {
        warnings.push('AMBIGUOUS_LANG');
        pairs.push({
          enRaw: current.rawText,
          jaRaw: next.rawText,
          enLang: current.effectiveLang,
          jaLang: next.effectiveLang,
          enConfidence: current.langInfo.confidence,
          jaConfidence: next.langInfo.confidence,
          warnings,
        });
        i += 2;
      } else {
        warnings.push('TRAILING_EN');
        pairs.push({
          enRaw: current.rawText,
          jaRaw: '',
          enLang: current.effectiveLang,
          jaLang: null,
          enConfidence: current.langInfo.confidence,
          jaConfidence: 0,
          warnings,
        });
        i += 1;
      }
    } else if (current.effectiveLang === 'ja') {
      warnings.push(pairs.length === 0 ? 'LEADING_JA' : 'CONSECUTIVE_JA');
      pairs.push({
        enRaw: '',
        jaRaw: current.rawText,
        enLang: null,
        jaLang: current.effectiveLang,
        enConfidence: 0,
        jaConfidence: current.langInfo.confidence,
        warnings,
      });
      i += 1;
    } else {
      // current is ambiguous
      warnings.push('AMBIGUOUS_LANG');
      if (next && next.effectiveLang === 'ja') {
        pairs.push({
          enRaw: current.rawText,
          jaRaw: next.rawText,
          enLang: current.effectiveLang,
          jaLang: next.effectiveLang,
          enConfidence: current.langInfo.confidence,
          jaConfidence: next.langInfo.confidence,
          warnings,
        });
        i += 2;
      } else {
        pairs.push({
          enRaw: current.rawText,
          jaRaw: '',
          enLang: current.effectiveLang,
          jaLang: null,
          enConfidence: current.langInfo.confidence,
          jaConfidence: 0,
          warnings,
        });
        i += 1;
      }
    }
  }

  return pairs;
}

/**
 * Treats every non-empty raw block as an independent English paragraph
 * with an empty Japanese side to be filled incrementally later.
 * @param {Array<{
 *   rawIndex: number,
 *   rawText: string,
 *   langInfo: ReturnType<typeof classifyLanguage>,
 *   effectiveLang: 'en'|'ja'|'ambiguous',
 *   isList: boolean
 * }>} rawBlocks
 */
export function buildEnglishOnlyPairs(rawBlocks) {
  return rawBlocks.map((blk) => ({
    enRaw: blk.rawText,
    jaRaw: '',
    enLang: 'en',
    jaLang: null,
    enConfidence: blk.langInfo.confidence,
    jaConfidence: 0,
    warnings: [],
  }));
}
