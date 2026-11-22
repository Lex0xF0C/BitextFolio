/**
 * Deterministic alignment groups, auxiliary hint scoring, anchor-based DP alignment,
 * and pure block/group editing operations (split, merge, move, unmatched).
 * Zero DOM dependencies.
 */

import {
  mergeMarkerLists,
  normalizeMarkerRanges,
  remapMarkersOnSplit,
} from './markers.js';
import { stripInlineMarkup } from './markup.js';

const NUMBER_TOKEN_RE = /\b\d+(?:[.,:-]\d+)*(?:r\d+)?\b/g;
const LATIN_TOKEN_RE = /\b[A-Za-z][A-Za-z0-9_-]{1,}\b/g;
const COMMON_EN_STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'what', 'when', 'where', 'which', 'who',
  'will', 'would', 'can', 'could', 'into', 'they', 'them', 'their', 'there',
  'then', 'than', 'been', 'being', 'also', 'such', 'more', 'most', 'only',
  'used', 'usually', 'about', 'other', 'some', 'these', 'those', 'since',
]);

let idCounter = 1;
export function nextLocalId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/**
 * Creates a SentenceItem from raw text.
 * @param {string} rawText
 * @param {'en'|'ja'} lang
 * @param {string} [id]
 */
export function makeSentenceItem(rawText, lang, id, markers = [], options = {}) {
  const clean = String(rawText || '').trim();
  const literalText = Boolean(options?.literalText);
  const plainText = literalText ? clean : stripInlineMarkup(clean);
  const item = {
    id: id || nextLocalId(lang),
    rawText: clean,
    plainText,
    markers: normalizeMarkerRanges(markers, plainText.length),
  };
  if (literalText) {
    item.literalText = true;
  }
  return item;
}

/**
 * Extracts deterministic anchor tokens (numbers and distinctive Latin identifiers).
 * @param {string} plainText
 */
export function extractAnchorTokens(plainText) {
  const numbers = new Set();
  const latin = new Set();
  const text = String(plainText || '');

  const numMatches = text.match(NUMBER_TOKEN_RE) || [];
  for (const n of numMatches) {
    numbers.add(n);
  }

  const latMatches = text.match(LATIN_TOKEN_RE) || [];
  for (const word of latMatches) {
    const lower = word.toLowerCase();
    if (!COMMON_EN_STOPWORDS.has(lower) && word.length >= 2) {
      latin.add(lower);
    }
  }
  return { numbers, latin };
}

/**
 * Computes deterministic auxiliary alignment hints for a group of EN and JA sentences.
 * @param {Array<{plainText: string}>} enItems
 * @param {Array<{plainText: string}>} jaItems
 */
export function computeGroupHints(enItems, jaItems) {
  const enJoined = enItems.map((s) => s.plainText).join(' ');
  const jaJoined = jaItems.map((s) => s.plainText).join(' ');

  const enTokens = extractAnchorTokens(enJoined);
  const jaTokens = extractAnchorTokens(jaJoined);

  const sharedNumbers = [...enTokens.numbers].filter((n) => jaTokens.numbers.has(n));
  const sharedLatin = [...enTokens.latin].filter((w) => jaTokens.latin.has(w));

  const enLen = enJoined.length;
  const jaLen = jaJoined.length;
  // Typical EN chars to JA chars ratio is ~2.1; normalized ratio ~1.0 means balanced.
  const expectedJa = enLen / 2.1;
  const lengthBalance =
    enLen === 0 || jaLen === 0 ? 0 : Math.min(jaLen, expectedJa) / Math.max(jaLen, expectedJa);

  return {
    sharedNumbers,
    sharedLatin,
    enChars: enLen,
    jaChars: jaLen,
    lengthBalance: Number(lengthBalance.toFixed(2)),
  };
}

/**
 * Creates default 1-to-1 alignment groups from sentence lists.
 * @param {Array<{id: string, rawText: string, plainText: string}>} enSentences
 * @param {Array<{id: string, rawText: string, plainText: string}>} jaSentences
 * @param {string} [blockId]
 */
export function createInitialGroups(enSentences, jaSentences, blockId = 'blk') {
  const maxLen = Math.max(enSentences.length, jaSentences.length);
  const groups = [];
  const countMismatch = enSentences.length !== jaSentences.length;

  for (let i = 0; i < maxLen; i += 1) {
    const enItem = enSentences[i] || null;
    const jaItem = jaSentences[i] || null;
    const enIds = enItem ? [enItem.id] : [];
    const jaIds = jaItem ? [jaItem.id] : [];
    groups.push({
      id: `${blockId}_g_${i + 1}_${nextLocalId('g')}`,
      enIds,
      jaIds,
      status: 'unread',
      memo: '',
      previousMemoNote: '',
      tempNoOmission: false,
      confirmedAlignment: !countMismatch && enIds.length === 1 && jaIds.length === 1,
    });
  }

  return groups;
}

function scorePairing(enSlice, jaSlice) {
  const hints = computeGroupHints(enSlice, jaSlice);
  let score = hints.lengthBalance * 2.0;
  score += hints.sharedNumbers.length * 3.0;
  score += hints.sharedLatin.length * 2.0;
  // Mild penalty for merging multiple sentences unless anchors or length justify it
  const totalCount = enSlice.length + jaSlice.length;
  if (totalCount > 2) {
    score -= (totalCount - 2) * 0.35;
  }
  return score;
}

/**
 * Deterministic DP alignment supporting 1:1, 1:2, 2:1, 1:0, 0:1 pairings
 * using numbers, Latin tokens, and length ratio hints.
 * @param {Array<{id: string, rawText: string, plainText: string}>} enSentences
 * @param {Array<{id: string, rawText: string, plainText: string}>} jaSentences
 * @param {string} [blockId]
 */
export function suggestHintedGroups(enSentences, jaSentences, blockId = 'blk') {
  const N = enSentences.length;
  const M = jaSentences.length;
  if (N === 0 && M === 0) return [];
  if (N === 0 || M === 0) {
    return createInitialGroups(enSentences, jaSentences, blockId);
  }

  const dp = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(-Infinity));
  const back = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(null));
  dp[0][0] = 0;

  const transitions = [
    [1, 1],
    [2, 1],
    [1, 2],
    [1, 0],
    [0, 1],
  ];

  for (let i = 0; i <= N; i += 1) {
    for (let j = 0; j <= M; j += 1) {
      if (!Number.isFinite(dp[i][j])) continue;
      for (const [di, dj] of transitions) {
        const ni = i + di;
        const nj = j + dj;
        if (ni > N || nj > M) continue;
        const stepScore =
          di === 0 || dj === 0
            ? -0.8
            : scorePairing(enSentences.slice(i, ni), jaSentences.slice(j, nj));
        const candidate = dp[i][j] + stepScore;
        if (candidate > dp[ni][nj]) {
          dp[ni][nj] = candidate;
          back[ni][nj] = [i, j];
        }
      }
    }
  }

  const steps = [];
  let ci = N;
  let cj = M;
  while (ci > 0 || cj > 0) {
    const prev = back[ci][cj];
    if (!prev) break;
    steps.push({ i0: prev[0], i1: ci, j0: prev[1], j1: cj });
    ci = prev[0];
    cj = prev[1];
  }
  steps.reverse();

  return steps.map((step, idx) => ({
    id: `${blockId}_g_${idx + 1}_${nextLocalId('g')}`,
    enIds: enSentences.slice(step.i0, step.i1).map((s) => s.id),
    jaIds: jaSentences.slice(step.j0, step.j1).map((s) => s.id),
    status: 'unread',
    memo: '',
    previousMemoNote: '',
    tempNoOmission: false,
    confirmedAlignment: false,
  }));
}

/**
 * Splits a sentence inside a block at the given character offset (on rawText).
 * Returns a new block object (immutable update).
 */
export function splitSentenceInBlock(block, lang, sentenceId, splitOffset) {
  const listKey = lang === 'en' ? 'enSentences' : 'jaSentences';
  const idKey = lang === 'en' ? 'enIds' : 'jaIds';
  const sentences = block[listKey];
  const idx = sentences.findIndex((s) => s.id === sentenceId);
  if (idx === -1) return block;

  const target = sentences[idx];
  const offset = Math.max(1, Math.min(target.rawText.length - 1, Number(splitOffset) || 0));
  const leftRaw = target.rawText.slice(0, offset).trim();
  const rightRaw = target.rawText.slice(offset).trim();
  if (!leftRaw || !rightRaw) return block;

  const literalText = Boolean(target.literalText);
  const leftPlainLen = literalText ? leftRaw.length : stripInlineMarkup(leftRaw).length;
  const rightPlainLen = literalText ? rightRaw.length : stripInlineMarkup(rightRaw).length;
  const { leftMarkers, rightMarkers } = remapMarkersOnSplit(
    target.markers,
    target.plainText.length,
    leftPlainLen,
    rightPlainLen,
  );

  const leftItem = makeSentenceItem(leftRaw, lang, target.id, leftMarkers, { literalText });
  const rightItem = makeSentenceItem(rightRaw, lang, undefined, rightMarkers, { literalText });

  const nextSentences = [
    ...sentences.slice(0, idx),
    leftItem,
    rightItem,
    ...sentences.slice(idx + 1),
  ];

  const nextGroups = block.groups.map((group) => {
    const pos = group[idKey].indexOf(sentenceId);
    if (pos === -1) return group;
    const updatedIds = [
      ...group[idKey].slice(0, pos + 1),
      rightItem.id,
      ...group[idKey].slice(pos + 1),
    ];
    return {
      ...group,
      [idKey]: updatedIds,
      confirmedAlignment: false,
    };
  });

  return syncBlockMeta({
    ...block,
    [listKey]: nextSentences,
    groups: nextGroups,
  });
}

/**
 * Merges a sentence with the next sentence of the same language inside the block.
 */
export function mergeSentenceWithNextInBlock(block, lang, sentenceId) {
  const listKey = lang === 'en' ? 'enSentences' : 'jaSentences';
  const idKey = lang === 'en' ? 'enIds' : 'jaIds';
  const sentences = block[listKey];
  const idx = sentences.findIndex((s) => s.id === sentenceId);
  if (idx === -1 || idx + 1 >= sentences.length) return block;

  const current = sentences[idx];
  const next = sentences[idx + 1];
  const joiner = lang === 'en' ? ' ' : '';
  const mergedRaw = `${current.rawText}${joiner}${next.rawText}`.trim();
  const literalText = Boolean(current.literalText || next.literalText);
  const mergedPlainLen = literalText ? mergedRaw.length : stripInlineMarkup(mergedRaw).length;
  const mergedMarkers = mergeMarkerLists(
    current.markers,
    next.markers,
    current.plainText.length + joiner.length,
    mergedPlainLen,
    current.plainText.length,
  );
  const mergedItem = makeSentenceItem(mergedRaw, lang, current.id, mergedMarkers, { literalText });

  const nextSentences = [
    ...sentences.slice(0, idx),
    mergedItem,
    ...sentences.slice(idx + 2),
  ];

  const nextGroups = block.groups
    .map((group) => ({
      ...group,
      [idKey]: group[idKey].filter((id) => id !== next.id),
    }))
    .filter((group, gIdx, arr) => {
      const empty = group.enIds.length === 0 && group.jaIds.length === 0;
      return !empty || arr.length === 1;
    });

  return syncBlockMeta({
    ...block,
    [listKey]: nextSentences,
    groups: nextGroups,
  });
}

/**
 * Moves a sentence into a target group (or creates a new unmatched group if targetGroupId === '__NEW__').
 */
export function moveSentenceToGroup(block, lang, sentenceId, targetGroupId) {
  const idKey = lang === 'en' ? 'enIds' : 'jaIds';
  const orderList = block[lang === 'en' ? 'enSentences' : 'jaSentences'];
  const orderMap = new Map(orderList.map((s, idx) => [s.id, idx]));

  let nextGroups = block.groups.map((g) => ({
    ...g,
    [idKey]: g[idKey].filter((id) => id !== sentenceId),
  }));

  if (targetGroupId === '__NEW__') {
    const sourceIdx = block.groups.findIndex((g) => g[idKey].includes(sentenceId));
    const insertAt = sourceIdx === -1 ? nextGroups.length : sourceIdx + 1;
    const newGroup = {
      id: `${block.id}_g_${nextLocalId('g')}`,
      enIds: lang === 'en' ? [sentenceId] : [],
      jaIds: lang === 'ja' ? [sentenceId] : [],
      status: 'unread',
      memo: '',
      previousMemoNote: '',
      tempNoOmission: false,
      confirmedAlignment: false,
    };
    nextGroups.splice(insertAt, 0, newGroup);
  } else {
    nextGroups = nextGroups.map((g) => {
      if (g.id !== targetGroupId) return g;
      const merged = [...g[idKey], sentenceId].sort(
        (a, b) => (orderMap.get(a) ?? 0) - (orderMap.get(b) ?? 0),
      );
      return {
        ...g,
        [idKey]: merged,
        confirmedAlignment: false,
      };
    });
  }

  nextGroups = nextGroups.filter((g) => g.enIds.length > 0 || g.jaIds.length > 0);
  if (nextGroups.length === 0) {
    nextGroups = createInitialGroups(block.enSentences, block.jaSentences, block.id);
  }

  return syncBlockMeta({
    ...block,
    groups: nextGroups,
  });
}

/**
 * Recomputes block-level mismatch/unconfirmed warnings while preserving structural warnings.
 */
export function syncBlockMeta(block) {
  const structural = (block.warnings || []).filter(
    (w) => w !== 'UNMATCHED_COUNT' && w !== 'UNCONFIRMED_GROUP',
  );
  if (block.enSentences.length !== block.jaSentences.length) {
    structural.push('UNMATCHED_COUNT');
  }
  const hasUnconfirmed = block.groups.some(
    (g) => !g.confirmedAlignment && g.status !== 'verified',
  );
  if (hasUnconfirmed) {
    structural.push('UNCONFIRMED_GROUP');
  }
  return {
    ...block,
    warnings: structural,
  };
}

/**
 * Updates marker ranges for a specific sentence inside a block.
 */
export function updateSentenceMarkersInBlock(block, lang, sentenceId, updaterFn) {
  if (!block || typeof updaterFn !== 'function') return block;
  const listKey = lang === 'en' ? 'enSentences' : 'jaSentences';
  const sentences = block[listKey] || [];
  let changed = false;
  const nextSentences = sentences.map((s) => {
    if (s.id !== sentenceId) return s;
    changed = true;
    const nextMarkers = normalizeMarkerRanges(
      updaterFn(s.markers || [], s.plainText.length),
      s.plainText.length,
    );
    return { ...s, markers: nextMarkers };
  });
  if (!changed) return block;
  return {
    ...block,
    [listKey]: nextSentences,
  };
}
