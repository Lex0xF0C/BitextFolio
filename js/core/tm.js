/**
 * Pure deterministic Translation Memory (TM) engine, TMX 1.4b exporter,
 * and frequent English n-gram + Japanese co-occurrence term candidate extractor.
 * Zero DOM dependencies.
 */

import { computeDeterministicHash, stripInlineMarkup } from './markup.js';
import { findEnglishGlossarySpans } from './glossary.js';

const EN_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'between',
  'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'during', 'each', 'either', 'for',
  'from', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'may', 'might', 'more', 'most',
  'must', 'my', 'neither', 'no', 'nor', 'not', 'now', 'of', 'on', 'once', 'only', 'or', 'other',
  'our', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that',
  'the', 'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'without', 'would', 'you', 'your',
]);

/**
 * Builds character n-gram array (unique) from normalized text.
 * @param {string} text
 * @param {number} [n=3]
 * @returns {string[]}
 */
export function buildCharNgrams(text, n = 3) {
  const norm = stripInlineMarkup(String(text || ''))
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return [];
  if (norm.length <= n) return [norm];
  const grams = new Set();
  for (let i = 0; i <= norm.length - n; i += 1) {
    grams.add(norm.slice(i, i + n));
  }
  return [...grams];
}

/**
 * Computes Jaccard similarity (0..1) between two n-gram arrays or Sets.
 */
export function jaccardSimilarity(aList, bList) {
  const setA = aList instanceof Set ? aList : new Set(aList || []);
  const setB = bList instanceof Set ? bList : new Set(bList || []);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const g of setA) {
    if (setB.has(g)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function normalizeTmSentence(text) {
  return stripInlineMarkup(String(text || ''))
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Creates a deterministic TM record keyed by normalized English source text.
 */
export function createTmRecord({ enPlain, jaPlain, sourceDocId = '', sourceDocTitle = '', groupId = '' }) {
  const cleanEn = normalizeTmSentence(enPlain);
  const cleanJa = normalizeTmSentence(jaPlain);
  const id = `tm_${computeDeterministicHash(cleanEn.toLowerCase())}`;
  return {
    id,
    enPlain: cleanEn,
    jaPlain: cleanJa,
    ngrams: buildCharNgrams(cleanEn, 3),
    sourceDocId,
    sourceDocTitle,
    groupId,
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * Finds deterministic TM matches for an English segment and flags discrepancies
 * against the current Japanese translation.
 */
export function findTmMatches(
  enPlain,
  tmRecords,
  { threshold = 0.45, maxResults = 3, excludeGroupId = null, currentJaPlain = '' } = {},
) {
  const cleanEn = normalizeTmSentence(enPlain);
  if (!cleanEn || !Array.isArray(tmRecords) || tmRecords.length === 0) return [];

  const queryGrams = buildCharNgrams(cleanEn, 3);
  if (queryGrams.length === 0) return [];

  const normQueryEn = cleanEn.toLowerCase();
  const normCurrentJa = normalizeTmSentence(currentJaPlain);
  const currentJaGrams = normCurrentJa ? buildCharNgrams(normCurrentJa, 2) : [];

  const matches = [];
  for (const rec of tmRecords) {
    if (!rec || !rec.enPlain || !rec.jaPlain) continue;
    if (excludeGroupId && rec.groupId === excludeGroupId) continue;

    const recGrams = rec.ngrams && rec.ngrams.length > 0 ? rec.ngrams : buildCharNgrams(rec.enPlain, 3);
    const similarity = jaccardSimilarity(queryGrams, recGrams);
    if (similarity < threshold) continue;

    const isExactEn = rec.enPlain.toLowerCase() === normQueryEn;
    let jaSimilarity = 1;
    let hasDiscrepancy = false;

    if (normCurrentJa) {
      const normRecJa = normalizeTmSentence(rec.jaPlain);
      if (normCurrentJa === normRecJa) {
        jaSimilarity = 1;
        hasDiscrepancy = false;
      } else {
        jaSimilarity = jaccardSimilarity(currentJaGrams, buildCharNgrams(normRecJa, 2));
        hasDiscrepancy = (isExactEn || similarity >= 0.72) && jaSimilarity < 0.78;
      }
    }

    matches.push({
      record: rec,
      similarity,
      jaSimilarity,
      isExactEn,
      hasDiscrepancy,
    });
  }

  return matches
    .sort((a, b) => b.similarity - a.similarity || (b.record.verifiedAt || '').localeCompare(a.record.verifiedAt || ''))
    .slice(0, maxResults);
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Exports Translation Memory / unified Glossary records as valid TMX 1.4b XML.
 */
export function exportTmAsTmx(tmRecords) {
  const header = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tmx version="1.4">',
    '  <header creationtool="BitextFolio" creationtoolversion="1.0" datatype="PlainText" segtype="phrase" adminlang="en" srclang="en" o-tmf="plain"/>',
    '  <body>',
  ];

  const body = [];
  for (const rec of tmRecords || []) {
    if (!rec) continue;
    if (rec.enHeadword) {
      const jaList = (rec.jaAccepted || []).filter(Boolean);
      for (const jaText of jaList) {
        body.push('    <tu>');
        if (rec.notes) {
          body.push(`      <prop type="x-note">${escapeXml(rec.notes)}</prop>`);
        }
        body.push(`      <tuv xml:lang="en"><seg>${escapeXml(rec.enHeadword)}</seg></tuv>`);
        body.push(`      <tuv xml:lang="ja"><seg>${escapeXml(jaText)}</seg></tuv>`);
        body.push('    </tu>');
      }
      continue;
    }
    if (!rec.enPlain || !rec.jaPlain) continue;
    body.push('    <tu>');
    if (rec.sourceDocTitle) {
      body.push(`      <prop type="x-document">${escapeXml(rec.sourceDocTitle)}</prop>`);
    }
    body.push(`      <tuv xml:lang="en"><seg>${escapeXml(rec.enPlain)}</seg></tuv>`);
    body.push(`      <tuv xml:lang="ja"><seg>${escapeXml(rec.jaPlain)}</seg></tuv>`);
    body.push('    </tu>');
  }

  return [...header, ...body, '  </body>', '</tmx>', ''].join('\n');
}

function extractEnglishTokens(text) {
  const matches = stripInlineMarkup(text || '').match(/[A-Za-z][A-Za-z0-9'-]*/g);
  return matches || [];
}

export function extractJapaneseCandidateTerms(jaPlain) {
  const clean = stripInlineMarkup(jaPlain || '').normalize('NFKC');
  const terms = new Set();
  // Mixed katakana + kanji compounds (e.g., インシデント対応, セキュリティ要件)
  const mixed = clean.match(/[\u30A1-\u30F6ー\u4E00-\u9FFF]{2,}/g) || [];
  for (const t of mixed) terms.add(t);
  // Katakana compounds (>= 2 chars)
  const kata = clean.match(/[\u30A1-\u30F6ー]{2,}/g) || [];
  for (const t of kata) terms.add(t);
  // Kanji compounds (>= 2 chars)
  const kanji = clean.match(/[\u4E00-\u9FFF]{2,}/g) || [];
  for (const t of kanji) terms.add(t);
  // Alphanumeric terms (e.g., NIST, SP800-61r3)
  const alpha = clean.match(/[A-Za-z][A-Za-z0-9-]{1,}/g) || [];
  for (const t of alpha) terms.add(t);
  return [...terms];
}

/**
 * Deterministic term candidate extractor:
 * extracts frequent English 1-7 word n-grams and co-occurring Japanese terms within the same alignment group.
 */
export function extractTermCandidates(
  blocks,
  glossaryEntries = [],
  { minFreq = 2, minN = 1, maxN = 7, maxResults = 200 } = {},
) {
  const safeMinN = Math.max(1, Math.min(7, Number(minN) || 1));
  const safeMaxN = Math.max(safeMinN, Math.min(7, Number(maxN) || 7));
  const safeMaxResults = Math.max(1, Number(maxResults) || 200);
  const phraseStats = new Map(); // normPhrase -> { displayCounts: Map, count: number, groups: Array<{ groupId, blockId, jaPlain }> }

  for (const blk of blocks || []) {
    const enMap = new Map((blk.enSentences || []).map((s) => [s.id, s]));
    const jaMap = new Map((blk.jaSentences || []).map((s) => [s.id, s]));

    for (const grp of blk.groups || []) {
      const enTexts = (grp.enIds || [])
        .map((id) => enMap.get(id)?.plainText || '')
        .filter((t) => t.trim().length > 0);
      if (enTexts.length === 0) continue;

      const jaPlain = (grp.jaIds || []).map((id) => jaMap.get(id)?.plainText || '').join(' ');
      const seenInGroup = new Set();

      for (const sentenceText of enTexts) {
        const tokens = extractEnglishTokens(sentenceText);
        for (let len = safeMinN; len <= safeMaxN; len += 1) {
          for (let i = 0; i <= tokens.length - len; i += 1) {
            const slice = tokens.slice(i, i + len);
            const firstLower = slice[0].toLowerCase();
            const lastLower = slice[slice.length - 1].toLowerCase();
            if (EN_STOP_WORDS.has(firstLower) || EN_STOP_WORDS.has(lastLower)) continue;
            if (len === 1 && firstLower.length < 3 && !/^[A-Z]{2,}$/.test(slice[0])) continue;
            if (len > 1 && slice.every((w) => EN_STOP_WORDS.has(w.toLowerCase()))) continue;

            const rawPhrase = slice.join(' ');
            const normKey = rawPhrase.toLowerCase();
            if (seenInGroup.has(normKey)) continue;
            seenInGroup.add(normKey);

            let rec = phraseStats.get(normKey);
            if (!rec) {
              rec = { normKey, displayCounts: new Map(), count: 0, groups: [] };
              phraseStats.set(normKey, rec);
            }
            rec.count += 1;
            rec.displayCounts.set(rawPhrase, (rec.displayCounts.get(rawPhrase) || 0) + 1);
            rec.groups.push({ groupId: grp.id, blockId: blk.id, jaPlain });
          }
        }
      }
    }
  }

  const preliminary = [];
  for (const rec of phraseStats.values()) {
    if (rec.count < minFreq) continue;

    // Pick most common surface casing
    let bestDisplay = rec.normKey;
    let bestCount = -1;
    for (const [surface, c] of rec.displayCounts.entries()) {
      if (c > bestCount) {
        bestCount = c;
        bestDisplay = surface;
      }
    }

    const alreadyInGlossary = (glossaryEntries || []).some((g) =>
      findEnglishGlossarySpans(bestDisplay, g).some(
        (sp) => sp.start === 0 && sp.end === bestDisplay.length,
      ),
    );

    const wordCount = bestDisplay.split(/\s+/).length;
    preliminary.push({
      enTerm: bestDisplay,
      wordCount,
      count: rec.count,
      alreadyInGlossary,
      groups: rec.groups,
    });
  }

  const topCandidates = preliminary
    .sort((a, b) => {
      if (a.alreadyInGlossary !== b.alreadyInGlossary) return a.alreadyInGlossary ? 1 : -1;
      return b.count - a.count || b.wordCount - a.wordCount || a.enTerm.localeCompare(b.enTerm);
    })
    .slice(0, safeMaxResults);

  const jaTermsCache = new Map();
  return topCandidates.map((cand) => {
    const jaCounts = new Map();
    for (const g of cand.groups) {
      let jaTerms = jaTermsCache.get(g.jaPlain);
      if (!jaTerms) {
        jaTerms = extractJapaneseCandidateTerms(g.jaPlain);
        jaTermsCache.set(g.jaPlain, jaTerms);
      }
      for (const jt of jaTerms) {
        jaCounts.set(jt, (jaCounts.get(jt) || 0) + 1);
      }
    }

    const jaCandidates = [...jaCounts.entries()]
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .slice(0, 5)
      .map(([jaTerm, count]) => ({ jaTerm, count }));

    return {
      enTerm: cand.enTerm,
      wordCount: cand.wordCount,
      count: cand.count,
      alreadyInGlossary: cand.alreadyInGlossary,
      jaCandidates,
      sampleGroupIds: cand.groups.map((g) => g.groupId),
    };
  });
}
