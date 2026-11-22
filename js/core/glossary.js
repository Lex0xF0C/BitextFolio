/**
 * Pure deterministic glossary matching, English inflection normalization,
 * Japanese variant normalization, consistency checking, reverse lookup, and CSV/TSV I/O.
 * Zero DOM dependencies.
 */

import { nextLocalId } from './alignment.js';
import { computeDeterministicHash, stripInlineMarkup } from './markup.js';

export const DEFAULT_JA_NORM_OPTIONS = {
  normalizeWidth: true,
  normalizeLongVowel: true,
  normalizeOkurigana: true,
  fuzzyTypoCheck: true,
  fuzzyMinLength: 4,
};

export const SAMPLE_GLOSSARY_ENTRIES = [
  {
    id: 'glo_sample_triage',
    enHeadword: 'triage',
    enVariants: ['triaged', 'triaging'],
    jaAccepted: ['トリアージ'],
    jaDeprecated: ['選別'],
    caseSensitive: false,
    notes: 'インシデント対応ではカタカナ表記「トリアージ」で統一',
  },
  {
    id: 'glo_sample_cvd',
    enHeadword: 'coordinated vulnerability disclosure',
    enVariants: ['CVD'],
    jaAccepted: ['協調的な脆弱性情報開示', '協調的脆弱性情報開示'],
    jaDeprecated: ['脆弱性公開調整'],
    caseSensitive: false,
    notes: '初出時は「協調的な脆弱性情報開示」を使用',
  },
  {
    id: 'glo_sample_advisory',
    enHeadword: 'advisory',
    enVariants: ['advisories'],
    jaAccepted: ['アドバイザリ', 'アドバイザリー'],
    jaDeprecated: ['勧告書'],
    caseSensitive: false,
    notes: 'セキュリティ情報の公式文書を指す',
  },
];

const IRREGULAR_EN_LEMMAS = new Map([
  ['criteria', 'criterion'],
  ['phenomena', 'phenomenon'],
  ['indices', 'index'],
  ['matrices', 'matrix'],
  ['analyses', 'analysis'],
  ['children', 'child'],
  ['people', 'person'],
  ['men', 'man'],
  ['women', 'woman'],
  ['went', 'go'],
  ['gone', 'go'],
  ['written', 'write'],
  ['wrote', 'write'],
  ['taken', 'take'],
  ['took', 'take'],
  ['built', 'build'],
  ['kept', 'keep'],
  ['sent', 'send'],
]);

/**
 * Generates deterministic normalized candidate stems for a single English word.
 * @param {string} word
 * @returns {Set<string>}
 */
export function normalizeEnglishWordToStems(word) {
  const raw = String(word || '').trim().toLowerCase();
  const stems = new Set();
  if (!raw) return stems;
  stems.add(raw);

  if (IRREGULAR_EN_LEMMAS.has(raw)) {
    stems.add(IRREGULAR_EN_LEMMAS.get(raw));
  }

  // Plural / 3rd-person singular rules
  if (raw.length > 4 && raw.endsWith('ies')) {
    stems.add(`${raw.slice(0, -3)}y`);
  }
  if (raw.length > 4 && raw.endsWith('ves')) {
    stems.add(`${raw.slice(0, -3)}f`);
    stems.add(`${raw.slice(0, -3)}fe`);
  }
  if (raw.length > 4 && /(?:ches|shes|xes|zes|sses)$/.test(raw)) {
    stems.add(raw.slice(0, -2));
  }
  if (
    raw.length > 3 &&
    raw.endsWith('s') &&
    !raw.endsWith('ss') &&
    !raw.endsWith('us') &&
    !raw.endsWith('is')
  ) {
    stems.add(raw.slice(0, -1));
  }

  // -ing rules
  if (raw.length > 4 && raw.endsWith('ying')) {
    stems.add(`${raw.slice(0, -4)}ie`);
  }
  if (raw.length > 4 && raw.endsWith('ing')) {
    const base = raw.slice(0, -3);
    stems.add(base);
    if (base.length >= 2) {
      stems.add(`${base}e`);
    }
    if (base.length >= 3 && base[base.length - 1] === base[base.length - 2]) {
      stems.add(base.slice(0, -1));
    }
  }

  // -ed rules
  if (raw.length > 4 && raw.endsWith('ied')) {
    stems.add(`${raw.slice(0, -3)}y`);
  }
  if (raw.length > 3 && raw.endsWith('ed')) {
    const base = raw.slice(0, -2);
    if (base.length >= 2) {
      stems.add(base);
      stems.add(`${base}e`);
    }
    if (base.length >= 3 && base[base.length - 1] === base[base.length - 2]) {
      stems.add(base.slice(0, -1));
    }
  }

  return stems;
}

function tokenizeEnglishWords(text) {
  const tokens = [];
  const re = /[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    tokens.push({
      raw: m[0],
      lower: m[0].toLowerCase(),
      stems: normalizeEnglishWordToStems(m[0]),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return tokens;
}

function wordsOverlap(aWord, bToken, caseSensitive) {
  if (caseSensitive) {
    if (aWord === bToken.raw) return true;
    // Allow inflections matching exact capitalized/lowercase prefix
    const aStems = normalizeEnglishWordToStems(aWord);
    const sameInitialCase =
      (aWord[0] === aWord[0].toUpperCase()) === (bToken.raw[0] === bToken.raw[0].toUpperCase());
    if (!sameInitialCase) return false;
    for (const s of aStems) {
      if (bToken.stems.has(s)) return true;
    }
    return false;
  }
  if (aWord.toLowerCase() === bToken.lower) return true;
  const aStems = normalizeEnglishWordToStems(aWord);
  for (const s of aStems) {
    if (bToken.stems.has(s)) return true;
  }
  return false;
}

function matchEnglishPhrase(textTokens, phrase, caseSensitive, useInflection) {
  const phraseWords = tokenizeEnglishWords(phrase);
  if (phraseWords.length === 0 || textTokens.length < phraseWords.length) {
    return [];
  }
  const matches = [];
  for (let i = 0; i <= textTokens.length - phraseWords.length; i += 1) {
    let ok = true;
    for (let j = 0; j < phraseWords.length; j += 1) {
      const pw = phraseWords[j].raw;
      const tt = textTokens[i + j];
      if (useInflection) {
        if (!wordsOverlap(pw, tt, caseSensitive)) {
          ok = false;
          break;
        }
      } else if (caseSensitive ? pw !== tt.raw : pw.toLowerCase() !== tt.lower) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const first = textTokens[i];
      const last = textTokens[i + phraseWords.length - 1];
      matches.push({ start: first.start, end: last.end });
    }
  }
  return matches;
}

/**
 * Finds exact plainText character spans for an English glossary/TM entry.
 * @param {string} enPlainText
 * @param {{ enHeadword: string, enVariants?: string[], caseSensitive?: boolean }} entry
 * @returns {Array<{ start: number, end: number, text: string }>}
 */
export function findEnglishGlossarySpans(enPlainText, entry) {
  const plain = String(enPlainText || '');
  if (!plain || !entry?.enHeadword) return [];
  const tokens = tokenizeEnglishWords(plain);
  const caseSensitive = Boolean(entry.caseSensitive);
  const useInflection = !entry.exactMatch;
  const rawSpans = [];

  for (const span of matchEnglishPhrase(tokens, entry.enHeadword, caseSensitive, useInflection)) {
    rawSpans.push({ start: span.start, end: span.end, text: plain.slice(span.start, span.end) });
  }

  for (const variant of entry.enVariants || []) {
    const cleanVar = String(variant || '').trim();
    if (!cleanVar) continue;
    for (const span of matchEnglishPhrase(tokens, cleanVar, caseSensitive, false)) {
      rawSpans.push({ start: span.start, end: span.end, text: plain.slice(span.start, span.end) });
    }
  }

  // Deduplicate identical spans
  const seen = new Set();
  const unique = [];
  for (const sp of rawSpans) {
    const key = `${sp.start}:${sp.end}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(sp);
    }
  }
  return unique.sort((a, b) => a.start - b.start || b.end - a.end);
}

/**
 * Checks whether an English glossary entry matches inside plain English text.
 * Supports multi-word phrases, deterministic inflection matching, and manual variants.
 * @param {string} enPlainText
 * @param {{ enHeadword: string, enVariants?: string[], caseSensitive?: boolean }} entry
 */
export function findEnglishGlossaryMatches(enPlainText, entry) {
  return [...new Set(findEnglishGlossarySpans(enPlainText, entry).map((s) => s.text))];
}

/**
 * Normalizes Japanese text for variant-tolerant matching.
 * @param {string} text
 * @param {{ normalizeWidth?: boolean, normalizeLongVowel?: boolean, normalizeOkurigana?: boolean }} [options]
 */
export function normalizeJapaneseText(text, options = DEFAULT_JA_NORM_OPTIONS) {
  let out = String(text || '');
  if (options.normalizeWidth !== false) {
    out = out.normalize('NFKC').replace(/\u3000/g, ' ');
  }
  if (options.normalizeLongVowel !== false) {
    out = out.replace(/([\u30A1-\u30F6])ー+/g, '$1');
  }
  if (options.normalizeOkurigana !== false) {
    // Strip medial okurigana between kanji (e.g., 引き継ぎ -> 引継ぎ, 取り扱い -> 取扱い)
    out = out.replace(/([\u4E00-\u9FFF])[きくぐけしさしすせちつってにのりる](?=[\u4E00-\u9FFF])/g, '$1');
    // Strip trailing nominal okurigana after 2+ consecutive kanji (e.g., 引継ぎ -> 引継, 手続き -> 手続)
    out = out.replace(/([\u4E00-\u9FFF]{2,})[きぎけいしみ](?![\u3041-\u309F])/g, '$1');
  }
  return out.toLowerCase();
}

const MEDIAL_OKURI_RE = /^[きくぐけしさしすせちつってにのりる]$/;
const TRAILING_OKURI_RE = /^[きぎけいしみ]$/;
const KANJI_RE = /^[\u4E00-\u9FFF]$/;
const KATAKANA_RE = /^[\u30A1-\u30F6]$/;
const HIRAGANA_RE = /^[\u3041-\u309F]$/;

function normalizeJapaneseWithMap(plainText, options = DEFAULT_JA_NORM_OPTIONS) {
  const src = String(plainText || '');
  const useWidth = options.normalizeWidth !== false;
  const useLongVowel = options.normalizeLongVowel !== false;
  const useOkuri = options.normalizeOkurigana !== false;

  // Step 1: per-char width & case normalization with exact source [s, e)
  const step1 = [];
  for (let i = 0; i < src.length; i += 1) {
    let chunk = src[i];
    if (useWidth) {
      chunk = chunk.normalize('NFKC').replace(/\u3000/g, ' ');
    }
    chunk = chunk.toLowerCase();
    for (let j = 0; j < chunk.length; j += 1) {
      step1.push({ ch: chunk[j], s: i, e: i + 1 });
    }
  }

  // Step 2: long vowel removal while tracking trailing extensions attached to kept chars
  const step2 = [];
  for (let i = 0; i < step1.length; i += 1) {
    const item = step1[i];
    if (
      useLongVowel &&
      item.ch === 'ー' &&
      step2.length > 0 &&
      KATAKANA_RE.test(step2[step2.length - 1].ch)
    ) {
      step2[step2.length - 1].extEnd = Math.max(step2[step2.length - 1].extEnd || step2[step2.length - 1].e, item.e);
      continue;
    }
    step2.push({ ch: item.ch, s: item.s, e: item.e, extEnd: item.e });
  }

  // Step 3: okurigana normalization
  // 3a: medial okurigana between two kanji (do NOT extend prev char's extEnd, since it sits between kanji)
  const step3a = [];
  for (let i = 0; i < step2.length; i += 1) {
    const prev = step3a.length > 0 ? step3a[step3a.length - 1] : null;
    const curr = step2[i];
    const next = i + 1 < step2.length ? step2[i + 1] : null;
    if (
      useOkuri &&
      prev &&
      next &&
      KANJI_RE.test(prev.ch) &&
      MEDIAL_OKURI_RE.test(curr.ch) &&
      KANJI_RE.test(next.ch)
    ) {
      continue;
    }
    step3a.push({ ...curr });
  }

  // 3b: trailing nominal okurigana after 2+ consecutive kanji (extend preceding kanji's extEnd)
  const finalChars = [];
  let consecutiveKanji = 0;
  for (let i = 0; i < step3a.length; i += 1) {
    const curr = step3a[i];
    const next = i + 1 < step3a.length ? step3a[i + 1] : null;
    if (
      useOkuri &&
      consecutiveKanji >= 2 &&
      TRAILING_OKURI_RE.test(curr.ch) &&
      (!next || !HIRAGANA_RE.test(next.ch)) &&
      finalChars.length > 0
    ) {
      finalChars[finalChars.length - 1].extEnd = Math.max(finalChars[finalChars.length - 1].extEnd, curr.extEnd);
      consecutiveKanji = 0;
      continue;
    }
    finalChars.push(curr);
    consecutiveKanji = KANJI_RE.test(curr.ch) ? consecutiveKanji + 1 : 0;
  }

  return {
    normText: finalChars.map((c) => c.ch).join(''),
    chars: finalChars,
  };
}

/**
 * Finds exact [start, end) character spans in `jaPlainText` matching `term` under `jaNormOptions`.
 * @param {string} jaPlainText
 * @param {string} term
 * @param {{ normalizeWidth?: boolean, normalizeLongVowel?: boolean, normalizeOkurigana?: boolean }} [jaNormOptions]
 * @returns {Array<{ start: number, end: number, text: string }>}
 */
export function findJapaneseTermSpans(jaPlainText, term, jaNormOptions = DEFAULT_JA_NORM_OPTIONS) {
  const plain = String(jaPlainText || '');
  const cleanTerm = String(term || '').trim();
  if (!cleanTerm || !plain) return [];

  const normTerm = normalizeJapaneseText(cleanTerm, jaNormOptions);
  if (!normTerm) return [];

  const { normText, chars } = normalizeJapaneseWithMap(plain, jaNormOptions);
  if (!normText || normText.length < normTerm.length) return [];

  const checkTrailingLongVowel =
    jaNormOptions.normalizeLongVowel === false && /[\u30A1-\u30F6]$/.test(normTerm);

  const spans = [];
  let idx = normText.indexOf(normTerm);
  while (idx !== -1) {
    if (!(checkTrailingLongVowel && normText[idx + normTerm.length] === 'ー')) {
      const first = chars[idx];
      const last = chars[idx + normTerm.length - 1];
      const start = first.s;
      const end = Math.max(last.e, last.extEnd || last.e);
      if (end > start) {
        spans.push({ start, end, text: plain.slice(start, end) });
      }
    }
    idx = normText.indexOf(normTerm, idx + Math.max(1, normTerm.length));
  }
  return spans;
}

/**
 * Checks whether a Japanese term appears inside Japanese plain text under current normalization rules.
 */
export function matchJapaneseTerm(jaPlainText, term, jaNormOptions = DEFAULT_JA_NORM_OPTIONS) {
  return findJapaneseTermSpans(jaPlainText, term, jaNormOptions).length > 0;
}

const CLAUSE_PUNCT_RE = /^[\s、。！？.,:;!?()（）「」『』\[\]{}<>\/\\'"\-–—]$/;
const HIRAGANA_PARTICLE_RE = /^[はがをにのでともへや]$/;

function charScriptGroup(ch) {
  if (/^[\u30A1-\u30F6ー]$/.test(ch)) return 'katakana';
  if (/^[\u4E00-\u9FFF]$/.test(ch)) return 'kanji';
  if (/^[\u3041-\u309F]$/.test(ch)) return 'hiragana';
  if (/^[A-Za-z0-9]$/.test(ch)) return 'alnum';
  if (CLAUSE_PUNCT_RE.test(ch)) return 'punct';
  return 'other';
}

function isTrimEdgeChar(tChar, pChar) {
  if (!tChar) return false;
  if (CLAUSE_PUNCT_RE.test(tChar)) return !CLAUSE_PUNCT_RE.test(pChar || '');
  if (HIRAGANA_PARTICLE_RE.test(tChar) && charScriptGroup(pChar) !== 'hiragana') {
    return true;
  }
  return false;
}

export function buildGlossaryTypoHintId(groupId, entryIdOrHeadword, foundText, acceptedTerm = '') {
  const key = computeDeterministicHash(`${entryIdOrHeadword || ''}:${acceptedTerm}:${foundText}`);
  return `${groupId || 'grp'}:GLOSSARY_TYPO:${key}`;
}

function describeFuzzyOps(ops) {
  const details = [];
  for (const op of ops) {
    if (op.kind === 'sub') {
      details.push(`「${op.pChar}」→「${op.tChar}」の誤記疑い`);
    } else if (op.kind === 'del') {
      details.push(`「${op.pChar}」欠落の疑い`);
    } else if (op.kind === 'ins') {
      details.push(`余分な「${op.tChar}」の疑い`);
    } else if (op.kind === 'swap') {
      details.push(`「${op.pChar}」⇄「${op.tChar}」入れ替えの疑い`);
    }
  }
  return details.join('・') || '表記差異の疑い';
}

/**
 * Deterministic approximate substring matcher (semi-global Damerau-Levenshtein DP)
 * for catching 1-2 character typos, omissions (脱字), insertions (衍字), and adjacent swaps
 * in Japanese translations relative to a registered term.
 * @param {string} jaPlainText
 * @param {string} term
 * @param {{ normalizeWidth?: boolean, normalizeLongVowel?: boolean, normalizeOkurigana?: boolean, fuzzyTypoCheck?: boolean, fuzzyMinLength?: number }} [jaNormOptions]
 * @returns {Array<{ start: number, end: number, text: string, edits: number, diffSummary: string, term: string }>}
 */
export function findJapaneseFuzzyTermSpans(
  jaPlainText,
  term,
  jaNormOptions = DEFAULT_JA_NORM_OPTIONS,
) {
  if (jaNormOptions && jaNormOptions.fuzzyTypoCheck === false) return [];
  const plain = String(jaPlainText || '');
  const cleanTerm = String(term || '').trim();
  if (!cleanTerm || !plain) return [];

  const normTerm = normalizeJapaneseText(cleanTerm, jaNormOptions);
  const m = normTerm.length;
  const minLength = Math.max(3, Number(jaNormOptions?.fuzzyMinLength) || 4);
  if (m < minLength) return [];

  const maxEdits = m >= 9 ? 2 : 1;
  const { normText, chars } = normalizeJapaneseWithMap(plain, jaNormOptions);
  const n = normText.length;
  if (!normText || n < Math.max(2, m - maxEdits)) return [];

  // Skip if exact match already exists in this text
  if (findJapaneseTermSpans(plain, cleanTerm, jaNormOptions).length > 0) {
    return [];
  }

  // Semi-global DP (0 = match, 1 = sub, 2 = del, 3 = ins, 4 = swap)
  const cols = n + 1;
  const dp = new Uint16Array((m + 1) * cols);
  const opGrid = new Uint8Array((m + 1) * cols);

  for (let i = 1; i <= m; i += 1) {
    dp[i * cols] = i;
    opGrid[i * cols] = 2; // del
  }

  for (let i = 1; i <= m; i += 1) {
    const pCh = normTerm[i - 1];
    for (let j = 1; j <= n; j += 1) {
      const tCh = normText[j - 1];
      const costSub = pCh === tCh ? 0 : 1;
      const subCost = dp[(i - 1) * cols + (j - 1)] + costSub;
      const delCost = dp[(i - 1) * cols + j] + 1;
      const insCost = dp[i * cols + (j - 1)] + 1;
      const canSwap =
        i >= 2 &&
        j >= 2 &&
        normTerm[i - 2] === tCh &&
        pCh === normText[j - 2] &&
        pCh !== normTerm[i - 2];
      const swapCost = canSwap ? dp[(i - 2) * cols + (j - 2)] + 1 : 0xffff;

      const best = Math.min(subCost, delCost, insCost, swapCost);
      const idx = i * cols + j;
      dp[idx] = best;

      if (costSub === 0 && subCost === best) {
        opGrid[idx] = 0;
      } else if (swapCost === best) {
        opGrid[idx] = 4;
      } else if (subCost === best) {
        opGrid[idx] = 1;
      } else if (delCost === best) {
        opGrid[idx] = 2;
      } else {
        opGrid[idx] = 3;
      }
    }
  }

  const rawCandidates = [];

  for (let endJ = 1; endJ <= n; endJ += 1) {
    if (dp[m * cols + endJ] > maxEdits) continue;

    // Traceback until row 0
    const revOps = [];
    let i = m;
    let j = endJ;
    while (i > 0) {
      const op = opGrid[i * cols + j];
      if (op === 0 || op === 1) {
        revOps.push({
          kind: op === 0 ? 'match' : 'sub',
          pChar: normTerm[i - 1],
          tChar: normText[j - 1],
          tIdx: j - 1,
        });
        i -= 1;
        j -= 1;
      } else if (op === 4) {
        revOps.push({
          kind: 'swap',
          pChar: `${normTerm[i - 2]}${normTerm[i - 1]}`,
          tChar: `${normText[j - 2]}${normText[j - 1]}`,
          tIdx: j - 2,
          tEndIdx: j - 1,
        });
        i -= 2;
        j -= 2;
      } else if (op === 2) {
        revOps.push({
          kind: 'del',
          pChar: normTerm[i - 1],
          tChar: '',
          tIdx: -1,
        });
        i -= 1;
      } else {
        revOps.push({
          kind: 'ins',
          pChar: '',
          tChar: normText[j - 1],
          tIdx: j - 1,
        });
        j -= 1;
      }
    }

    const ops = revOps.reverse();

    // Trim edge insertions and particle/punctuation boundary substitutions
    let changed = true;
    while (changed && ops.length > 0) {
      changed = false;
      if (ops[0].kind === 'ins') {
        ops.shift();
        changed = true;
        continue;
      }
      if (ops[ops.length - 1].kind === 'ins') {
        ops.pop();
        changed = true;
        continue;
      }
      if (ops[0].kind === 'sub' && isTrimEdgeChar(ops[0].tChar, ops[0].pChar)) {
        ops[0] = { kind: 'del', pChar: ops[0].pChar, tChar: '', tIdx: -1 };
        changed = true;
        continue;
      }
      const lastIdx = ops.length - 1;
      if (ops[lastIdx].kind === 'sub' && isTrimEdgeChar(ops[lastIdx].tChar, ops[lastIdx].pChar)) {
        ops[lastIdx] = { kind: 'del', pChar: ops[lastIdx].pChar, tChar: '', tIdx: -1 };
        changed = true;
      }
    }

    let edits = 0;
    let exactMatchCount = 0;
    let swapCount = 0;
    let boundaryDelCount = 0;
    let hasCrossPunct = false;
    let minTIdx = Infinity;
    let maxTIdx = -1;

    for (let k = 0; k < ops.length; k += 1) {
      const op = ops[k];
      if (op.kind === 'match') {
        exactMatchCount += 1;
      } else {
        edits += 1;
        if (op.kind === 'swap') swapCount += 1;
        if (op.kind === 'del' && (k === 0 || k === ops.length - 1)) {
          boundaryDelCount += 1;
        }
        if ((op.kind === 'sub' || op.kind === 'ins') && CLAUSE_PUNCT_RE.test(op.tChar)) {
          hasCrossPunct = true;
        }
      }
      if (op.tIdx >= 0) {
        minTIdx = Math.min(minTIdx, op.tIdx);
        maxTIdx = Math.max(maxTIdx, op.tEndIdx ?? op.tIdx);
      }
    }

    if (hasCrossPunct || edits === 0 || edits > maxEdits || maxTIdx < minTIdx) continue;
    const spanNormLen = maxTIdx - minTIdx + 1;
    if (spanNormLen < Math.max(2, m - maxEdits)) continue;
    if (Math.abs(spanNormLen - m) > maxEdits) continue;
    if (exactMatchCount < 2 || exactMatchCount < m - maxEdits - swapCount) continue;

    // Require matched chars to share same script family if m === 3
    if (m === 3 && exactMatchCount < 2) continue;

    const firstChar = chars[minTIdx];
    const lastChar = chars[maxTIdx];
    const start = firstChar.s;
    const end = Math.max(lastChar.e, lastChar.extEnd || lastChar.e);
    const matchedRaw = plain.slice(start, end);
    if (!matchedRaw.trim() || start >= end) continue;
    // Skip if edge of plain slice is whitespace
    if (/^\s|\s$/.test(matchedRaw)) continue;

    rawCandidates.push({
      start,
      end,
      text: matchedRaw,
      edits,
      exactMatchCount,
      boundaryDelCount,
      diffSummary: describeFuzzyOps(ops),
      term: cleanTerm,
    });
  }

  if (rawCandidates.length === 0) return [];

  // Deduplicate and pick strongest candidate per overlapping span
  rawCandidates.sort((a, b) => {
    if (a.edits !== b.edits) return a.edits - b.edits;
    if (a.exactMatchCount !== b.exactMatchCount) return b.exactMatchCount - a.exactMatchCount;
    if (a.boundaryDelCount !== b.boundaryDelCount) return a.boundaryDelCount - b.boundaryDelCount;
    return a.start - b.start || (b.end - b.start) - (a.end - a.start);
  });

  const accepted = [];
  for (const cand of rawCandidates) {
    const overlaps = accepted.some((k) => k.start < cand.end && k.end > cand.start);
    if (!overlaps) {
      accepted.push({
        start: cand.start,
        end: cand.end,
        text: cand.text,
        edits: cand.edits,
        diffSummary: cand.diffSummary,
        term: cand.term,
      });
    }
  }
  return accepted.sort((a, b) => a.start - b.start || a.end - b.end);
}

function resolveOverlappingTermSpans(rawSpans) {
  if (!Array.isArray(rawSpans) || rawSpans.length === 0) return [];
  const priority = { deprecated: 0, matched: 1, typo: 2 };
  // Prioritize deprecated warnings first, then exact matched, then typo guesses, then longer phrases
  const sorted = [...rawSpans].sort((a, b) => {
    const pa = priority[a.status] ?? 9;
    const pb = priority[b.status] ?? 9;
    if (pa !== pb) return pa - pb;
    const lenDiff = (b.end - b.start) - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    return a.start - b.start;
  });

  const accepted = [];
  for (const sp of sorted) {
    if (!sp || sp.end <= sp.start) continue;
    const overlaps = accepted.some((k) => k.start < sp.end && k.end > sp.start);
    if (!overlaps) {
      accepted.push(sp);
    }
  }
  return accepted.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Collects exact character-offset underline spans for registered TM/glossary entries
 * across a single alignment group's English and Japanese sentences.
 */
export function collectGroupHighlightSpans(
  enSentences,
  jaSentences,
  glossaryEntries,
  jaNormOptions = DEFAULT_JA_NORM_OPTIONS,
  { groupId = '', dismissedHints = {} } = {},
) {
  const enSpansBySentenceId = new Map();
  const jaSpansBySentenceId = new Map();
  if (!Array.isArray(glossaryEntries) || glossaryEntries.length === 0) {
    return { enSpansBySentenceId, jaSpansBySentenceId };
  }

  const enRawBySentence = new Map();
  const jaRawBySentence = new Map();
  const matchedEntries = [];

  for (const entry of glossaryEntries) {
    if (!entry || !entry.enHeadword) continue;
    let entryMatchedEn = false;
    const accLabel = (entry.jaAccepted || []).join(' / ');
    const enTitle = accLabel
      ? `登録済: ${entry.enHeadword} ⇔ ${accLabel}${entry.notes ? ` (${entry.notes})` : ''}`
      : `登録済: ${entry.enHeadword}${entry.notes ? ` (${entry.notes})` : ''}`;

    for (const s of enSentences || []) {
      const spans = findEnglishGlossarySpans(s?.plainText || '', entry);
      if (spans.length > 0) {
        entryMatchedEn = true;
        const list = enRawBySentence.get(s.id) || [];
        for (const sp of spans) {
          list.push({
            start: sp.start,
            end: sp.end,
            status: 'matched',
            title: enTitle,
          });
        }
        enRawBySentence.set(s.id, list);
      }
    }

    if (entryMatchedEn) {
      matchedEntries.push(entry);
    }

    // Always highlight deprecated Japanese translations as warning underlines if present
    for (const dep of entry.jaDeprecated || []) {
      if (!dep) continue;
      for (const s of jaSentences || []) {
        const spans = findJapaneseTermSpans(s?.plainText || '', dep, jaNormOptions);
        if (spans.length > 0) {
          const list = jaRawBySentence.get(s.id) || [];
          const depTitle = `⚠ 非推奨訳語 (${entry.enHeadword}): ${dep}${accLabel ? ` → 推奨: ${accLabel}` : ''}`;
          for (const sp of spans) {
            list.push({
              start: sp.start,
              end: sp.end,
              status: 'deprecated',
              title: depTitle,
            });
          }
          jaRawBySentence.set(s.id, list);
        }
      }
    }
  }

  // Highlight corresponding Japanese accepted translations for entries matched on the English side,
  // or fuzzy typo/omission/insertion candidates if enabled and no exact accepted match appeared.
  for (const entry of matchedEntries) {
    let foundExactAccepted = false;
    for (const acc of entry.jaAccepted || []) {
      if (!acc) continue;
      for (const s of jaSentences || []) {
        const spans = findJapaneseTermSpans(s?.plainText || '', acc, jaNormOptions);
        if (spans.length > 0) {
          foundExactAccepted = true;
          const list = jaRawBySentence.get(s.id) || [];
          const jaTitle = `登録済訳語: ${acc} ⇔ ${entry.enHeadword}${entry.notes ? ` (${entry.notes})` : ''}`;
          for (const sp of spans) {
            list.push({
              start: sp.start,
              end: sp.end,
              status: 'matched',
              title: jaTitle,
            });
          }
          jaRawBySentence.set(s.id, list);
        }
      }
    }

    if (!foundExactAccepted && jaNormOptions?.fuzzyTypoCheck !== false) {
      for (const acc of entry.jaAccepted || []) {
        if (!acc) continue;
        for (const s of jaSentences || []) {
          const fuzzySpans = findJapaneseFuzzyTermSpans(s?.plainText || '', acc, jaNormOptions);
          if (fuzzySpans.length === 0) continue;
          const list = jaRawBySentence.get(s.id) || [];
          for (const sp of fuzzySpans) {
            const hintId = buildGlossaryTypoHintId(
              groupId,
              entry.id || entry.enHeadword,
              sp.text,
              acc,
            );
            if (dismissedHints && dismissedHints[hintId]) continue;
            list.push({
              start: sp.start,
              end: sp.end,
              status: 'typo',
              title: `⚠ 誤記・脱字の疑い (${entry.enHeadword} ⇔ ${acc}): 「${sp.text}」 (${sp.diffSummary})`,
            });
          }
          jaRawBySentence.set(s.id, list);
        }
      }
    }
  }

  for (const [sid, list] of enRawBySentence.entries()) {
    enSpansBySentenceId.set(sid, resolveOverlappingTermSpans(list));
  }
  for (const [sid, list] of jaRawBySentence.entries()) {
    jaSpansBySentenceId.set(sid, resolveOverlappingTermSpans(list));
  }

  return { enSpansBySentenceId, jaSpansBySentenceId };
}

/**
 * Checks glossary consistency for one alignment group (EN plain text vs JA plain text),
 * including deterministic fuzzy typo/omission/insertion detection when enabled.
 */
export function checkGroupGlossary(
  enPlainText,
  jaPlainText,
  glossaryEntries,
  jaNormOptions = DEFAULT_JA_NORM_OPTIONS,
  { groupId = '', dismissedHints = {} } = {},
) {
  const enPlain = stripInlineMarkup(enPlainText || '');
  const jaPlain = stripInlineMarkup(jaPlainText || '');
  const matchedOk = [];
  const missingAccepted = [];
  const deprecatedUsed = [];
  const fuzzyTypos = [];
  const dismissedFuzzyTypos = [];

  for (const entry of glossaryEntries || []) {
    if (!entry || !entry.enHeadword) continue;
    const enHits = findEnglishGlossaryMatches(enPlain, entry);
    const matchedDeprecated = (entry.jaDeprecated || []).filter((t) =>
      matchJapaneseTerm(jaPlain, t, jaNormOptions),
    );
    const matchedAccepted = (entry.jaAccepted || []).filter((t) =>
      matchJapaneseTerm(jaPlain, t, jaNormOptions),
    );

    if (matchedDeprecated.length > 0) {
      deprecatedUsed.push({
        entry,
        enHits,
        foundDeprecated: matchedDeprecated,
      });
    }

    if (enHits.length > 0) {
      if (jaPlain.trim() && (entry.jaAccepted || []).length > 0 && matchedAccepted.length === 0) {
        let foundAnyFuzzy = false;
        let activeFuzzyForEntry = false;
        if (jaNormOptions?.fuzzyTypoCheck !== false) {
          for (const acc of entry.jaAccepted) {
            const spans = findJapaneseFuzzyTermSpans(jaPlain, acc, jaNormOptions);
            for (const sp of spans) {
              foundAnyFuzzy = true;
              const hintId = buildGlossaryTypoHintId(
                groupId,
                entry.id || entry.enHeadword,
                sp.text,
                acc,
              );
              const item = {
                hintId,
                entry,
                enHits,
                span: sp,
              };
              if (dismissedHints && dismissedHints[hintId]) {
                dismissedFuzzyTypos.push(item);
              } else {
                fuzzyTypos.push(item);
                activeFuzzyForEntry = true;
              }
            }
          }
        }
        if (!foundAnyFuzzy && !activeFuzzyForEntry) {
          missingAccepted.push({
            entry,
            enHits,
          });
        }
      } else if (matchedDeprecated.length === 0) {
        matchedOk.push({
          entry,
          enHits,
          matchedAccepted,
        });
      }
    }
  }

  return {
    matchedOk,
    missingAccepted,
    deprecatedUsed,
    fuzzyTypos,
    dismissedFuzzyTypos,
    hasIssues:
      missingAccepted.length > 0 || deprecatedUsed.length > 0 || fuzzyTypos.length > 0,
  };
}

/**
 * Reverse lookup (JA -> EN): finds all groups whose Japanese sentences match `query`,
 * along with their paired English text and matching glossary entries.
 */
export function reverseLookupJapanese(
  blocks,
  query,
  jaNormOptions = DEFAULT_JA_NORM_OPTIONS,
  glossaryEntries = [],
) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];

  const results = [];
  for (const block of blocks || []) {
    const enMap = new Map((block.enSentences || []).map((s) => [s.id, s]));
    const jaMap = new Map((block.jaSentences || []).map((s) => [s.id, s]));

    for (const group of block.groups || []) {
      const jaPlain = group.jaIds
        .map((id) => jaMap.get(id)?.plainText || '')
        .filter(Boolean)
        .join(' ');
      if (!jaPlain) continue;

      if (matchJapaneseTerm(jaPlain, cleanQuery, jaNormOptions)) {
        const enPlain = group.enIds
          .map((id) => enMap.get(id)?.plainText || '')
          .filter(Boolean)
          .join(' ');
        const matchedGlossary = (glossaryEntries || [])
          .filter((e) => findEnglishGlossaryMatches(enPlain, e).length > 0)
          .map((e) => e.enHeadword);

        results.push({
          blockId: block.id,
          blockIndex: block.index,
          groupId: group.id,
          jaText: jaPlain,
          enText: enPlain,
          matchedGlossary,
        });
      }
    }
  }

  return results;
}

function parseDelimitedRow(line, delimiter) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function splitListCell(cell) {
  return String(cell || '')
    .split(/[|;；、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parses CSV or TSV text into GlossaryEntry objects.
 * Supports headers (enHeadword/en, jaAccepted/ja, jaDeprecated, enVariants, caseSensitive, notes)
 * or positional columns: enHeadword, jaAccepted, jaDeprecated, enVariants, caseSensitive, notes.
 */
export function parseGlossaryDelimited(rawText, delimiter = 'auto') {
  const clean = String(rawText || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!clean) return [];

  const lines = clean.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const effectiveDelimiter =
    delimiter === 'auto' ? (lines[0].includes('\t') ? '\t' : ',') : delimiter;

  const firstCells = parseDelimitedRow(lines[0], effectiveDelimiter).map((c) => c.toLowerCase());
  const looksLikeHeader =
    firstCells.some((c) =>
      ['enheadword', 'en', 'english', '英語', '見出し語', 'jaaccepted', 'ja', '日本語', '訳語'].includes(
        c,
      ),
    );

  let startRow = 0;
  let colMap = { en: 0, ja: 1, dep: 2, variants: 3, caseSensitive: 4, exactMatch: -1, notes: 5 };

  if (looksLikeHeader) {
    startRow = 1;
    colMap = {
      en: firstCells.findIndex((c) => ['enheadword', 'en', 'english', '英語', '見出し語'].includes(c)),
      ja: firstCells.findIndex((c) =>
        ['jaaccepted', 'ja', 'japanese', '日本語', '訳語', '許容訳語'].includes(c),
      ),
      dep: firstCells.findIndex((c) =>
        ['jadeprecated', 'deprecated', '非推奨', '非推奨訳語'].includes(c),
      ),
      variants: firstCells.findIndex((c) =>
        ['envariants', 'variants', '活用形'].includes(c),
      ),
      caseSensitive: firstCells.findIndex((c) =>
        ['casesensitive', 'case', '大文字小文字'].includes(c),
      ),
      exactMatch: firstCells.findIndex((c) =>
        ['exactmatch', 'exact', 'strictinflection', '厳密一致', '単複区別', '活用区別'].includes(c),
      ),
      notes: firstCells.findIndex((c) => ['notes', 'note', '備考', 'メモ'].includes(c)),
    };
  }

  const entries = [];
  for (let i = startRow; i < lines.length; i += 1) {
    const row = parseDelimitedRow(lines[i], effectiveDelimiter);
    const enHeadword = colMap.en >= 0 ? (row[colMap.en] || '').trim() : '';
    if (!enHeadword) continue;

    const jaAccepted = colMap.ja >= 0 ? splitListCell(row[colMap.ja]) : [];
    const jaDeprecated = colMap.dep >= 0 ? splitListCell(row[colMap.dep]) : [];
    const enVariants = colMap.variants >= 0 ? splitListCell(row[colMap.variants]) : [];
    const caseRaw = colMap.caseSensitive >= 0 ? (row[colMap.caseSensitive] || '').toLowerCase() : '';
    const caseSensitive = ['true', '1', 'yes', '区別'].includes(caseRaw);
    const exactRaw = colMap.exactMatch >= 0 ? (row[colMap.exactMatch] || '').toLowerCase() : '';
    const exactMatch = ['true', '1', 'yes', '区別', '厳密一致'].includes(exactRaw);
    const notes = colMap.notes >= 0 ? (row[colMap.notes] || '').trim() : '';

    entries.push({
      id: nextLocalId('glo'),
      enHeadword,
      enVariants,
      jaAccepted,
      jaDeprecated,
      caseSensitive,
      exactMatch,
      notes,
    });
  }

  return entries;
}

function escapeDelimitedCell(value, delimiter) {
  const s = String(value ?? '');
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serializes GlossaryEntry[] to CSV or TSV.
 */
export function serializeGlossaryDelimited(entries, delimiter = ',') {
  const header = [
    'enHeadword',
    'jaAccepted',
    'jaDeprecated',
    'enVariants',
    'caseSensitive',
    'exactMatch',
    'notes',
  ];
  const rows = [header.join(delimiter)];

  for (const e of entries || []) {
    rows.push(
      [
        escapeDelimitedCell(e.enHeadword, delimiter),
        escapeDelimitedCell((e.jaAccepted || []).join(' | '), delimiter),
        escapeDelimitedCell((e.jaDeprecated || []).join(' | '), delimiter),
        escapeDelimitedCell((e.enVariants || []).join(' | '), delimiter),
        escapeDelimitedCell(e.caseSensitive ? 'true' : 'false', delimiter),
        escapeDelimitedCell(e.exactMatch ? 'true' : 'false', delimiter),
        escapeDelimitedCell(e.notes || '', delimiter),
      ].join(delimiter),
    );
  }

  return rows.join('\n');
}
