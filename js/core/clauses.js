/**
 * Ad-hoc clause-level comparison pairs ("文節対比") inside an alignment group.
 * Non-destructive to block sentence lists and translation memory.
 * Zero DOM dependencies.
 */

import { nextLocalId } from './alignment.js';
import { computeMarkerCoveragePercent, normalizeMarkerRanges } from './markers.js';

function normalizeSpan(span) {
  if (!span || typeof span !== 'object') return null;
  const text = String(span.text || '').trim();
  const sentenceId = String(span.sentenceId || '');
  const start = Math.max(0, Math.floor(Number(span.start) || 0));
  const end = Math.max(start, Math.floor(Number(span.end) || start + text.length));
  if (!text || end <= start) return null;
  return { sentenceId, start, end, text };
}

export function createClausePair({ enSpan = null, jaSpan = null, note = '', checked = false } = {}) {
  return {
    id: nextLocalId('clp'),
    enSpan: normalizeSpan(enSpan),
    jaSpan: normalizeSpan(jaSpan),
    checked: Boolean(checked),
    note: String(note || ''),
  };
}

/**
 * Finds the best existing clause pair waiting to be paired with `lang`.
 */
export function findWaitingClausePairId(group, lang) {
  const pairs = group?.clausePairs || [];
  const needKey = lang === 'ja' ? 'jaSpan' : 'enSpan';
  const haveKey = lang === 'ja' ? 'enSpan' : 'jaSpan';
  for (let i = pairs.length - 1; i >= 0; i -= 1) {
    if (pairs[i][haveKey] && !pairs[i][needKey]) {
      return pairs[i].id;
    }
  }
  return null;
}

function updateGroupClauses(block, groupId, updater) {
  if (!block) return block;
  let changed = false;
  const groups = (block.groups || []).map((g) => {
    if (g.id !== groupId) return g;
    changed = true;
    return {
      ...g,
      clausePairs: updater(g.clausePairs || []),
    };
  });
  return changed ? { ...block, groups } : block;
}

export function addClausePairInGroup(block, groupId, { enSpan = null, jaSpan = null } = {}) {
  const pair = createClausePair({ enSpan, jaSpan });
  if (!pair.enSpan && !pair.jaSpan) return { block, pairId: null };
  const nextBlock = updateGroupClauses(block, groupId, (pairs) => [...pairs, pair]);
  return { block: nextBlock, pairId: pair.id };
}

export function attachSpanToClausePairInGroup(block, groupId, pairId, lang, span) {
  const cleanSpan = normalizeSpan(span);
  if (!cleanSpan) return block;
  const key = lang === 'en' ? 'enSpan' : 'jaSpan';
  return updateGroupClauses(block, groupId, (pairs) =>
    pairs.map((p) => (p.id === pairId ? { ...p, [key]: cleanSpan } : p)),
  );
}

export function toggleClausePairCheckedInGroup(block, groupId, pairId, forceVal = null) {
  return updateGroupClauses(block, groupId, (pairs) =>
    pairs.map((p) =>
      p.id === pairId
        ? { ...p, checked: forceVal !== null ? Boolean(forceVal) : !Boolean(p.checked) }
        : p,
    ),
  );
}

export function updateClausePairNoteInGroup(block, groupId, pairId, note) {
  return updateGroupClauses(block, groupId, (pairs) =>
    pairs.map((p) => (p.id === pairId ? { ...p, note: String(note || '') } : p)),
  );
}

export function removeClausePairInGroup(block, groupId, pairId) {
  return updateGroupClauses(block, groupId, (pairs) => pairs.filter((p) => p.id !== pairId));
}

export function clearClausePairsInGroup(block, groupId) {
  return updateGroupClauses(block, groupId, () => []);
}

/**
 * Collects pending & checked span ranges for a specific sentence inside a group.
 */
export function collectSentenceClauseHighlights(group, lang, sentenceId) {
  const pending = [];
  const checked = [];
  const key = lang === 'en' ? 'enSpan' : 'jaSpan';
  for (const pair of group?.clausePairs || []) {
    const span = pair[key];
    if (!span || span.sentenceId !== sentenceId) continue;
    if (pair.checked) {
      checked.push({ start: span.start, end: span.end });
    } else {
      pending.push({ start: span.start, end: span.end });
    }
  }
  return { pending, checked };
}

/**
 * Computes checked clause count and EN/JA plain-text coverage across clause pairs in a group.
 */
export function computeClauseCoverage(group, enItems = [], jaItems = []) {
  const pairs = group?.clausePairs || [];
  const checkedPairs = pairs.filter((p) => p.checked).length;

  const calcLangPercent = (items, key) => {
    let totalLen = 0;
    let covered = 0;
    for (const item of items) {
      const len = (item.plainText || '').length;
      totalLen += len;
      const ranges = pairs
        .map((p) => p[key])
        .filter((sp) => sp && sp.sentenceId === item.id);
      const norm = normalizeMarkerRanges(ranges, len);
      for (const r of norm) covered += r.end - r.start;
    }
    return totalLen === 0 ? 0 : Math.min(100, computeMarkerCoveragePercent([{ start: 0, end: covered }], totalLen));
  };

  return {
    totalPairs: pairs.length,
    checkedPairs,
    enPercent: calcLangPercent(enItems, 'enSpan'),
    jaPercent: calcLangPercent(jaItems, 'jaSpan'),
  };
}

/**
 * Deterministic punctuation/conjunction chunker for optional quick clause chips.
 * Preserves exact [start, end] offsets on plainText.
 */
export function suggestDeterministicClauseChunks(plainText, lang) {
  const text = String(plainText || '');
  if (!text.trim()) return [];

  const breakRe =
    lang === 'ja'
      ? /[、，；：]+/g
      : /(?:[,;:]+\s+|\s+—\s+|\s+(?:and|or|but|because|while|when|if|that|which|where|before|after)\s+)/gi;

  const boundaries = [0];
  let match;
  while ((match = breakRe.exec(text)) !== null) {
    const endPos =
      lang === 'ja' ? match.index + match[0].length : match.index + (match[0].startsWith(' ') ? 0 : match[0].length);
    if (endPos > boundaries[boundaries.length - 1] && endPos < text.length) {
      boundaries.push(endPos);
    }
  }
  boundaries.push(text.length);

  const chunks = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    let start = boundaries[i];
    let end = boundaries[i + 1];
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    if (end <= start) continue;
    chunks.push({ start, end, text: text.slice(start, end) });
  }
  return chunks;
}
