/**
 * Character-ratio-based deterministic language classifier for EN / JA blocks.
 * Zero DOM dependencies.
 */

import { stripInlineMarkup } from './markup.js';

const JA_CHAR_RE =
  /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF\u3001\u3002\u300A\u300B\u300C\u300D\u300E\u300F\u3010\u3011\u30FB\uFF01\uFF08\uFF09\uFF0C\uFF0E\uFF1A\uFF1B\uFF1F\uFF5E]/g;
const LATIN_CHAR_RE = /[A-Za-z]/g;
const URL_RE = /https?:\/\/\S+/gi;

/**
 * Classifies a text block as 'en', 'ja', or 'ambiguous'.
 * @param {string} rawText
 * @returns {{
 *   lang: 'en'|'ja'|'ambiguous',
 *   enCount: number,
 *   jaCount: number,
 *   enRatio: number,
 *   jaRatio: number,
 *   confidence: number,
 *   reason: string
 * }}
 */
export function classifyLanguage(rawText) {
  const plain = stripInlineMarkup(rawText || '').trim();
  if (!plain) {
    return {
      lang: 'ambiguous',
      enCount: 0,
      jaCount: 0,
      enRatio: 0,
      jaRatio: 0,
      confidence: 0,
      reason: 'empty',
    };
  }

  const withoutUrls = plain.replace(URL_RE, ' ').trim();
  const sample = withoutUrls || plain;
  const jaMatches = sample.match(JA_CHAR_RE);
  const enMatches = sample.match(LATIN_CHAR_RE);
  const jaCount = jaMatches ? jaMatches.length : 0;
  const enCount = enMatches ? enMatches.length : 0;
  const total = jaCount + enCount;

  if (total === 0) {
    return {
      lang: 'ambiguous',
      enCount: 0,
      jaCount: 0,
      enRatio: 0,
      jaRatio: 0,
      confidence: 0,
      reason: 'no_alpha_or_kana',
    };
  }

  const jaRatio = jaCount / total;
  const enRatio = enCount / total;

  // Japanese blocks often contain Latin technical terms/acronyms, while EN blocks
  // contain at most occasional glosses. Note: 1 Japanese char carries more information
  // than 1 Latin letter, so >= 28% Japanese chars with >= 3 chars strongly indicates JA
  // unless EN dominates overwhelmingly.
  if (jaRatio >= 0.45 || (jaCount >= 3 && jaRatio >= 0.28 && enCount < jaCount * 2.5)) {
    const confidence = Math.min(1, 0.5 + jaRatio * 0.5);
    return {
      lang: 'ja',
      enCount,
      jaCount,
      enRatio,
      jaRatio,
      confidence,
      reason: jaRatio >= 0.65 ? 'clear_ja' : 'mixed_ja_dominant',
    };
  }

  if (enRatio >= 0.72) {
    const confidence = Math.min(1, 0.5 + enRatio * 0.5);
    return {
      lang: 'en',
      enCount,
      jaCount,
      enRatio,
      jaRatio,
      confidence,
      reason: enRatio >= 0.88 ? 'clear_en' : 'mixed_en_dominant',
    };
  }

  return {
    lang: 'ambiguous',
    enCount,
    jaCount,
    enRatio,
    jaRatio,
    confidence: Math.abs(enRatio - jaRatio),
    reason: 'mixed_ambiguous',
  };
}
