/**
 * Deterministic English and Japanese sentence splitters.
 * Handles abbreviations, version numbers, decimals, quotes/brackets, and list items.
 * Zero DOM dependencies.
 */

import { isListBlock, isListLine } from './block-parser.js';

export const DEFAULT_ABBREVIATIONS = [
  'e.g.',
  'i.e.',
  'et al.',
  'Fig.',
  'Figs.',
  'No.',
  'Nos.',
  'vs.',
  'approx.',
  'etc.',
  'Dr.',
  'Mr.',
  'Mrs.',
  'Ms.',
  'Prof.',
  'Inc.',
  'Ltd.',
  'Corp.',
  'Vol.',
  'Sec.',
  'Ch.',
  'Art.',
  'Ref.',
  'p.',
  'pp.',
  'cf.',
  'U.S.',
  'U.K.',
  'St.',
  'ver.',
  'rev.',
  'ed.',
  'eq.',
  'Tab.',
  'Jan.',
  'Feb.',
  'Mar.',
  'Apr.',
  'Aug.',
  'Sept.',
  'Oct.',
  'Nov.',
  'Dec.',
];

/**
 * Splits a list block by lines, keeping indented continuation lines attached to the previous item.
 * @param {string} rawText
 * @returns {string[]}
 */
export function splitListBlockLines(rawText) {
  const lines = String(rawText || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const items = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (isListLine(rawLine) || items.length === 0) {
      items.push(trimmed);
    } else {
      // Continuation line of previous bullet
      const sep = /[\u3040-\u30FF\u4E00-\u9FFF]$/.test(items[items.length - 1]) ? '' : ' ';
      items[items.length - 1] = `${items[items.length - 1]}${sep}${trimmed}`;
    }
  }
  return items;
}

/**
 * Unwraps line breaks inside a prose paragraph cleanly.
 * For English, newlines become spaces. For Japanese, newlines between Japanese chars join directly.
 * @param {string} rawText
 * @param {'en'|'ja'} lang
 * @returns {string}
 */
export function unwrapProseLines(rawText, lang) {
  const lines = String(rawText || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';
  if (lang === 'en') {
    return lines.join(' ').replace(/[ \t]+/g, ' ').trim();
  }
  let out = lines[0];
  for (let i = 1; i < lines.length; i += 1) {
    const prevLast = out[out.length - 1] || '';
    const currFirst = lines[i][0] || '';
    const bothAscii = /[A-Za-z0-9.,;:!?)]/.test(prevLast) && /[A-Za-z0-9(]/.test(currFirst);
    out += (bothAscii ? ' ' : '') + lines[i];
  }
  return out.trim();
}

function buildAbbreviationSet(abbreviations) {
  const set = new Set();
  for (const abbr of abbreviations || DEFAULT_ABBREVIATIONS) {
    const clean = String(abbr || '').trim().toLowerCase();
    if (clean) set.add(clean);
  }
  return set;
}

function isAbbreviationAtDot(text, dotIndex, abbrSet) {
  // Look backward up to 28 chars to match single or multi-word abbreviations like "et al." or "e.g."
  const windowStart = Math.max(0, dotIndex - 28);
  const slice = text.slice(windowStart, dotIndex + 1).toLowerCase();

  for (const abbr of abbrSet) {
    if (slice.endsWith(abbr)) {
      const charBeforeIdx = slice.length - abbr.length - 1;
      if (charBeforeIdx < 0 || /[\s("“\[/]/.test(slice[charBeforeIdx])) {
        return true;
      }
    }
  }

  // Single uppercase initial like "J." followed by whitespace and name/initial
  if (dotIndex >= 1 && /[A-Z]/.test(text[dotIndex - 1])) {
    const beforeChar = dotIndex >= 2 ? text[dotIndex - 2] : ' ';
    if (/[\s("“]/.test(beforeChar)) {
      return true;
    }
  }

  // Dotted acronym like "U.S." or "e.g." even if not in list
  if (dotIndex >= 3 && /[A-Za-z]\.[A-Za-z]\./.test(text.slice(dotIndex - 3, dotIndex + 1))) {
    return true;
  }

  return false;
}

function isDecimalOrVersionDot(text, dotIndex) {
  const prev = dotIndex > 0 ? text[dotIndex - 1] : '';
  const next = dotIndex + 1 < text.length ? text[dotIndex + 1] : '';

  // Decimal or version like 2.0, 3.14, v1.2.3
  if (/\d/.test(prev) && /\d/.test(next)) {
    return true;
  }
  // Domain / path / file extension like example.com or foo.txt (dot followed by non-space alphanumeric)
  if (/[A-Za-z0-9_-]/.test(prev) && /[A-Za-z0-9_-]/.test(next)) {
    return true;
  }
  // Ellipsis "..."
  if (prev === '.' || next === '.') {
    return true;
  }
  return false;
}

/**
 * Splits English prose or list block into sentences.
 * @param {string} rawText
 * @param {{ abbreviations?: string[] }} [options]
 * @returns {string[]}
 */
export function splitEnglishSentences(rawText, options = {}) {
  const input = String(rawText || '').trim();
  if (!input) return [];

  if (isListBlock(input)) {
    return splitListBlockLines(input);
  }

  const text = unwrapProseLines(input, 'en');
  if (!text) return [];

  const abbrSet = buildAbbreviationSet(options.abbreviations);
  const sentences = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let inDoubleQuote = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (ch === '(') {
      parenDepth += 1;
      continue;
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }
    if (ch === '[') {
      bracketDepth += 1;
      continue;
    }
    if (ch === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (ch === '“') {
      inDoubleQuote = true;
      continue;
    }
    if (ch === '”') {
      inDoubleQuote = false;
      continue;
    }

    if (ch !== '.' && ch !== '!' && ch !== '?') {
      continue;
    }

    // Consume consecutive !? if any (e.g., "?!")
    let endPunctIdx = i;
    while (
      endPunctIdx + 1 < text.length &&
      (text[endPunctIdx + 1] === '!' || text[endPunctIdx + 1] === '?')
    ) {
      endPunctIdx += 1;
    }

    if (ch === '.') {
      if (isDecimalOrVersionDot(text, i)) {
        continue;
      }
      if (isAbbreviationAtDot(text, i, abbrSet)) {
        continue;
      }
    }

    // Check trailing closing quotes or parentheses immediately after punctuation
    let cutIdx = endPunctIdx + 1;
    let closedQuoteHere = false;
    let closedParenHere = false;

    while (cutIdx < text.length && /["”’')\]*]/.test(text[cutIdx])) {
      const closing = text[cutIdx];
      if (closing === '"' || closing === '”') {
        inDoubleQuote = false;
        closedQuoteHere = true;
      } else if (closing === ')' && parenDepth > 0) {
        parenDepth -= 1;
        closedParenHere = true;
      } else if (closing === ']' && bracketDepth > 0) {
        bracketDepth -= 1;
      }
      cutIdx += 1;
    }

    // If still inside parentheses or brackets, don't split inside them
    if (parenDepth > 0 || bracketDepth > 0) {
      i = endPunctIdx;
      continue;
    }

    // Look ahead after trailing closers
    const after = text.slice(cutIdx);
    const wsMatch = after.match(/^(\s+)(.*)$/);
    if (!wsMatch) {
      // End of string (or no whitespace follows, e.g., attached token)
      if (cutIdx >= text.length) {
        break;
      }
      i = endPunctIdx;
      continue;
    }

    const restTrimmed = wsMatch[2];
    if (!restTrimmed) {
      break;
    }

    // If punctuation was inside quotes ("Wait." and left) or ended right before lowercase continuation
    if (inDoubleQuote) {
      // Inside open quote: only split if next token clearly begins a new quoted sentence
      if (!/^[A-Z0-9"“(\[]/.test(restTrimmed)) {
        i = endPunctIdx;
        continue;
      }
    }

    if ((closedQuoteHere || closedParenHere) && /^[a-z]/.test(restTrimmed)) {
      // e.g., He said "Wait." and walked away.
      i = endPunctIdx;
      continue;
    }

    // Normally, English sentence boundaries are followed by uppercase, digit, quote, paren, or markup
    if (!/^[A-Z0-9"“'‘(\[*`—]/.test(restTrimmed)) {
      i = endPunctIdx;
      continue;
    }

    const segment = text.slice(start, cutIdx).trim();
    if (segment) {
      sentences.push(segment);
    }
    start = cutIdx + wsMatch[1].length;
    i = start - 1;
  }

  const tail = text.slice(start).trim();
  if (tail) {
    sentences.push(tail);
  }
  return sentences;
}

const JA_CLOSING_BRACKETS_RE = /^[」』）)】〕〉》”’"')\]*]+/;

/**
 * Splits Japanese prose or list block into sentences.
 * Keeps immediately trailing closing brackets/quotes attached to the preceding sentence.
 * @param {string} rawText
 * @returns {string[]}
 */
export function splitJapaneseSentences(rawText) {
  const input = String(rawText || '').trim();
  if (!input) return [];

  if (isListBlock(input)) {
    return splitListBlockLines(input);
  }

  const text = unwrapProseLines(input, 'ja');
  if (!text) return [];

  const sentences = [];
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '。' && ch !== '！' && ch !== '？') {
      continue;
    }

    // Consume consecutive sentence-end punctuation
    let cutIdx = i + 1;
    while (cutIdx < text.length && /[。！？!?]/.test(text[cutIdx])) {
      cutIdx += 1;
    }

    // Attach immediately following closing brackets / quotes (e.g., 」。 』）)
    const afterPunct = text.slice(cutIdx);
    const closerMatch = afterPunct.match(JA_CLOSING_BRACKETS_RE);
    if (closerMatch) {
      cutIdx += closerMatch[0].length;
    }

    const segment = text.slice(start, cutIdx).trim();
    if (segment) {
      sentences.push(segment);
    }

    // Skip whitespace after sentence break
    while (cutIdx < text.length && /\s/.test(text[cutIdx])) {
      cutIdx += 1;
    }
    start = cutIdx;
    i = cutIdx - 1;
  }

  const tail = text.slice(start).trim();
  if (tail) {
    sentences.push(tail);
  }
  return sentences;
}
