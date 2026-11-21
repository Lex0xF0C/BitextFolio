/**
 * Pure deterministic glossary matching, English inflection normalization,
 * Japanese variant normalization, consistency checking, reverse lookup, and CSV/TSV I/O.
 * Zero DOM dependencies.
 */

import { nextLocalId } from './alignment.js';
import { stripInlineMarkup } from './markup.js';

export const DEFAULT_JA_NORM_OPTIONS = {
  normalizeWidth: true,
  normalizeLongVowel: true,
  normalizeOkurigana: true,
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
 * Checks whether an English glossary entry matches inside plain English text.
 * Supports multi-word phrases, deterministic inflection matching, and manual variants.
 * @param {string} enPlainText
 * @param {{ enHeadword: string, enVariants?: string[], caseSensitive?: boolean }} entry
 */
export function findEnglishGlossaryMatches(enPlainText, entry) {
  const plain = String(enPlainText || '');
  if (!plain || !entry?.enHeadword) return [];
  const tokens = tokenizeEnglishWords(plain);
  const caseSensitive = Boolean(entry.caseSensitive);
  const hits = [];

  for (const span of matchEnglishPhrase(tokens, entry.enHeadword, caseSensitive, true)) {
    hits.push(plain.slice(span.start, span.end));
  }

  for (const variant of entry.enVariants || []) {
    const cleanVar = String(variant || '').trim();
    if (!cleanVar) continue;
    for (const span of matchEnglishPhrase(tokens, cleanVar, caseSensitive, false)) {
      hits.push(plain.slice(span.start, span.end));
    }
  }

  return [...new Set(hits)];
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

/**
 * Checks whether a Japanese term appears inside Japanese plain text under current normalization rules.
 */
export function matchJapaneseTerm(jaPlainText, term, jaNormOptions = DEFAULT_JA_NORM_OPTIONS) {
  const cleanTerm = String(term || '').trim();
  if (!cleanTerm || !jaPlainText) return false;
  const normText = normalizeJapaneseText(jaPlainText, jaNormOptions);
  const normTerm = normalizeJapaneseText(cleanTerm, jaNormOptions);
  if (!normTerm) return false;
  if (jaNormOptions.normalizeLongVowel === false && /[\u30A1-\u30F6]$/.test(normTerm)) {
    let idx = normText.indexOf(normTerm);
    while (idx !== -1) {
      if (normText[idx + normTerm.length] !== 'ー') return true;
      idx = normText.indexOf(normTerm, idx + 1);
    }
    return false;
  }
  return normText.includes(normTerm);
}

/**
 * Checks glossary consistency for one alignment group (EN plain text vs JA plain text).
 */
export function checkGroupGlossary(
  enPlainText,
  jaPlainText,
  glossaryEntries,
  jaNormOptions = DEFAULT_JA_NORM_OPTIONS,
) {
  const enPlain = stripInlineMarkup(enPlainText || '');
  const jaPlain = stripInlineMarkup(jaPlainText || '');
  const matchedOk = [];
  const missingAccepted = [];
  const deprecatedUsed = [];

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
        missingAccepted.push({
          entry,
          enHits,
        });
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
    hasIssues: missingAccepted.length > 0 || deprecatedUsed.length > 0,
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
  let colMap = { en: 0, ja: 1, dep: 2, variants: 3, caseSensitive: 4, notes: 5 };

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
    const notes = colMap.notes >= 0 ? (row[colMap.notes] || '').trim() : '';

    entries.push({
      id: nextLocalId('glo'),
      enHeadword,
      enVariants,
      jaAccepted,
      jaDeprecated,
      caseSensitive,
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
        escapeDelimitedCell(e.notes || '', delimiter),
      ].join(delimiter),
    );
  }

  return rows.join('\n');
}
