/**
 * High-level pure document construction, structural fixes, and progress aggregation.
 * Zero DOM dependencies.
 */

import { buildEnglishOnlyPairs, pairClassifiedBlocks, splitIntoRawBlocks } from './block-parser.js';
import {
  createInitialGroups,
  makeSentenceItem,
  nextLocalId,
  suggestHintedGroups,
  syncBlockMeta,
} from './alignment.js';
import { checkGroupGlossary, DEFAULT_JA_NORM_OPTIONS } from './glossary.js';
import { buildBlockHashes } from './hash-diff.js';
import { buildDuplicateJaIndex, detectGroupHints } from './hints.js';
import { normalizeMarkerRanges } from './markers.js';
import { stripInlineMarkup } from './markup.js';
import { DEFAULT_ABBREVIATIONS, splitEnglishSentences, splitJapaneseSentences } from './sentence-splitter.js';

export const SAMPLE_SOURCE_TEXT = `During security incident handling, *triage* is the initial process of assessing incoming
reports to determine their severity, scope and urgency. A designated coordinator records
each finding with a unique tracking identifier and assigns an owner before containment
begins. According to a 2025 operational guide, timely validation prevents duplicate work
across engineering teams. In coordinated vulnerability disclosure, clear timelines also
help external reporters and vendors align on remediation milestones.

セキュリティ・インシデント対応において、トリアージ（*triage*）とは、受領した報告の深刻度、
影響範囲、緊急性を評価する初期プロセスを指す。指定されたコーディネーターは、各事案に一意の
追跡IDを付与して記録する。その後、封じ込め作業を開始する前に担当者を割り当てる。2025年の
運用手引きによれば、迅速な検証は開発チーム間の重複作業を防ぐ効果がある。協調的な脆弱性情報
開示においては、明確なスケジュール設定が報告者とベンダー双方の修正マイルストーン調整にも役立つ。

- Prepare the response baseline (e.g., NIST SP 800-61r3, ver. 2.0) before an incident occurs.
- Record mitigation metrics (such as a 0.5% error rate threshold) and advisory timelines in UTC.

- インシデント発生前に、対応基準（例：NIST SP 800-61r3、第2.0版）を整備する。
- 緩和策の指標（エラー率0.5%の閾値など）およびアドバイザリ公開予定をUTCで記録する。`;

/**
 * Builds an AlignmentBlock from raw EN and JA strings.
 */
export function buildAlignmentBlock(enRaw, jaRaw, index, options = {}) {
  const abbreviations = options.abbreviations || DEFAULT_ABBREVIATIONS;
  const enList = splitEnglishSentences(enRaw, { abbreviations }).map((s) => makeSentenceItem(s, 'en'));
  const jaList = splitJapaneseSentences(jaRaw).map((s) => makeSentenceItem(s, 'ja'));
  const blockId = options.id || nextLocalId('blk');
  const hashes = buildBlockHashes(enRaw, jaRaw);
  const groups = createInitialGroups(enList, jaList, blockId);

  return syncBlockMeta({
    id: blockId,
    index,
    enRaw: enRaw || '',
    jaRaw: jaRaw || '',
    enLang: options.enLang || (enRaw ? 'en' : null),
    jaLang: options.jaLang || (jaRaw ? 'ja' : null),
    enConfidence: options.enConfidence ?? 1,
    jaConfidence: options.jaConfidence ?? 1,
    warnings: [...(options.warnings || [])],
    enSentences: enList,
    jaSentences: jaList,
    groups,
    ...hashes,
  });
}

/**
 * Parses raw text (or manually adjusted rawBlocks) into AlignmentBlock[].
 */
export function parseDocumentBlocks(rawText, options = {}) {
  const rawBlocks = options.rawBlocks || splitIntoRawBlocks(rawText);
  const pairs =
    options.inputMode === 'english_only'
      ? buildEnglishOnlyPairs(rawBlocks)
      : pairClassifiedBlocks(rawBlocks);
  return pairs.map((pair, idx) =>
    buildAlignmentBlock(pair.enRaw, pair.jaRaw, idx, {
      abbreviations: options.abbreviations,
      enLang: pair.enLang,
      jaLang: pair.jaLang,
      enConfidence: pair.enConfidence,
      jaConfidence: pair.jaConfidence,
      warnings: pair.warnings,
    }),
  );
}

/**
 * Updates or fills in the Japanese paragraph text for an existing block,
 * preserving existing English sentence edits and recalculating hashes and groups.
 */
export function updateBlockJapaneseText(block, newJaRaw) {
  const cleanJa = String(newJaRaw || '').trim();
  const jaList = splitJapaneseSentences(cleanJa).map((s) => makeSentenceItem(s, 'ja'));
  const hashes = buildBlockHashes(block.enRaw, cleanJa);
  const groups = createInitialGroups(block.enSentences, jaList, block.id);
  const cleanedWarnings = (block.warnings || []).filter(
    (w) =>
      w !== 'CONSECUTIVE_EN' &&
      w !== 'TRAILING_EN' &&
      w !== 'AMBIGUOUS_LANG' &&
      w !== 'SOURCE_CHANGED',
  );

  return syncBlockMeta({
    ...block,
    jaRaw: cleanJa,
    jaLang: cleanJa ? 'ja' : null,
    jaConfidence: cleanJa ? 1 : 0,
    jaSentences: jaList,
    groups,
    warnings: cleanedWarnings,
    ...hashes,
  });
}

/**
 * Inserts typed or pasted text directly into an empty side of an existing alignment group,
 * keeping sentence order consistent across surrounding groups and recalculating hashes/warnings.
 */
export function insertTextIntoGroup(block, groupId, lang, rawInput, abbreviations = DEFAULT_ABBREVIATIONS) {
  const clean = String(rawInput || '').trim();
  if (!clean || !block) return block;

  const listKey = lang === 'en' ? 'enSentences' : 'jaSentences';
  const idKey = lang === 'en' ? 'enIds' : 'jaIds';
  const rawKey = lang === 'en' ? 'enRaw' : 'jaRaw';

  const newItems = (
    lang === 'en'
      ? splitEnglishSentences(clean, { abbreviations })
      : splitJapaneseSentences(clean)
  ).map((s) => makeSentenceItem(s, lang));

  if (newItems.length === 0) return block;

  const groupIdx = (block.groups || []).findIndex((g) => g.id === groupId);
  if (groupIdx === -1) return block;

  const existingSentences = block[listKey] || [];
  let insertAt = 0;
  for (let i = groupIdx - 1; i >= 0; i -= 1) {
    const prevIds = block.groups[i][idKey] || [];
    if (prevIds.length > 0) {
      const lastPrevId = prevIds[prevIds.length - 1];
      const foundIdx = existingSentences.findIndex((s) => s.id === lastPrevId);
      if (foundIdx !== -1) {
        insertAt = foundIdx + 1;
        break;
      }
    }
  }

  const nextSentences = [
    ...existingSentences.slice(0, insertAt),
    ...newItems,
    ...existingSentences.slice(insertAt),
  ];

  const newIds = newItems.map((item) => item.id);
  const nextGroups = block.groups.map((g) => {
    if (g.id !== groupId) return g;
    return {
      ...g,
      [idKey]: [...(g[idKey] || []), ...newIds],
      confirmedAlignment: false,
    };
  });

  const rebuiltRaw = nextSentences.map((s) => s.rawText).join(lang === 'en' ? ' ' : '');
  const nextEnRaw = lang === 'en' ? rebuiltRaw : block.enRaw;
  const nextJaRaw = lang === 'ja' ? rebuiltRaw : block.jaRaw;
  const hashes = buildBlockHashes(nextEnRaw, nextJaRaw);

  const cleanedWarnings = (block.warnings || []).filter(
    (w) =>
      w !== 'CONSECUTIVE_EN' &&
      w !== 'CONSECUTIVE_JA' &&
      w !== 'TRAILING_EN' &&
      w !== 'LEADING_JA' &&
      w !== 'AMBIGUOUS_LANG' &&
      w !== 'SOURCE_CHANGED',
  );

  return syncBlockMeta({
    ...block,
    [rawKey]: rebuiltRaw,
    enLang: nextEnRaw ? 'en' : null,
    jaLang: nextJaRaw ? 'ja' : null,
    enConfidence: nextEnRaw ? 1 : 0,
    jaConfidence: nextJaRaw ? 1 : 0,
    [listKey]: nextSentences,
    groups: nextGroups,
    warnings: cleanedWarnings,
    ...hashes,
  });
}

/**
 * Updates a single sentence's raw text in place without re-splitting or resetting groups.
 * Useful when fixing an omission or excess spotted during clause-level review.
 */
export function updateSentenceTextInBlock(block, lang, sentenceId, newRawText) {
  const clean = String(newRawText || '').trim();
  if (!clean || !block) return block;
  const listKey = lang === 'en' ? 'enSentences' : 'jaSentences';
  const rawKey = lang === 'en' ? 'enRaw' : 'jaRaw';
  const spanKey = lang === 'en' ? 'enSpan' : 'jaSpan';
  const sentences = block[listKey] || [];
  let changed = false;
  let newPlain = '';

  const nextSentences = sentences.map((s) => {
    if (s.id !== sentenceId) return s;
    changed = true;
    newPlain = stripInlineMarkup(clean);
    return {
      ...s,
      rawText: clean,
      plainText: newPlain,
      markers: normalizeMarkerRanges(s.markers || [], newPlain.length),
    };
  });
  if (!changed) return block;

  const rebuiltRaw = nextSentences.map((s) => s.rawText).join(lang === 'en' ? ' ' : '');
  const nextEnRaw = lang === 'en' ? rebuiltRaw : block.enRaw;
  const nextJaRaw = lang === 'ja' ? rebuiltRaw : block.jaRaw;
  const hashes = buildBlockHashes(nextEnRaw, nextJaRaw);

  const nextGroups = (block.groups || []).map((g) => {
    if (!Array.isArray(g.clausePairs) || g.clausePairs.length === 0) return g;
    const nextPairs = g.clausePairs.map((pair) => {
      const sp = pair[spanKey];
      if (!sp || sp.sentenceId !== sentenceId) return pair;
      if (sp.end <= newPlain.length && newPlain.slice(sp.start, sp.end) === sp.text) {
        return pair;
      }
      const relocated = newPlain.indexOf(sp.text);
      if (relocated !== -1) {
        return {
          ...pair,
          [spanKey]: { ...sp, start: relocated, end: relocated + sp.text.length },
        };
      }
      const clampedStart = Math.max(0, Math.min(sp.start, newPlain.length));
      const clampedEnd = Math.max(clampedStart, Math.min(sp.end, newPlain.length));
      return {
        ...pair,
        [spanKey]: { ...sp, start: clampedStart, end: clampedEnd },
      };
    });
    return { ...g, clausePairs: nextPairs };
  });

  return syncBlockMeta({
    ...block,
    [rawKey]: rebuiltRaw,
    [listKey]: nextSentences,
    groups: nextGroups,
    ...hashes,
  });
}

/**
 * Creates a full DocumentProject record.
 */
export function createDocumentProject({ title, rawText, abbreviations, rawBlocks, inputMode }) {
  const now = new Date().toISOString();
  const blocks = parseDocumentBlocks(rawText, { abbreviations, rawBlocks, inputMode });
  const firstGroupId = blocks[0]?.groups[0]?.id || null;
  return {
    id: nextLocalId('doc'),
    title: (title || '').trim() || '無題の対訳ドキュメント',
    createdAt: now,
    updatedAt: now,
    rawSourceText: rawText || '',
    abbreviations: [...(abbreviations || DEFAULT_ABBREVIATIONS)],
    lastFocusedGroupId: firstGroupId,
    dismissedHints: {},
    blocks,
  };
}

/**
 * Swaps EN and JA sides within a single block (for structural correction).
 */
export function swapBlockSides(block, abbreviations) {
  const structural = (block.warnings || []).filter(
    (w) =>
      w !== 'CONSECUTIVE_EN' &&
      w !== 'CONSECUTIVE_JA' &&
      w !== 'TRAILING_EN' &&
      w !== 'LEADING_JA' &&
      w !== 'AMBIGUOUS_LANG',
  );
  return buildAlignmentBlock(block.jaRaw, block.enRaw, block.index, {
    id: block.id,
    abbreviations,
    warnings: structural,
  });
}

/**
 * Merges a block with the next block (useful when two consecutive EN or JA blocks should be joined,
 * or an orphan EN block should pair with the following orphan JA block).
 */
export function mergeWithNextBlock(blocks, blockIndex, abbreviations) {
  if (blockIndex < 0 || blockIndex + 1 >= blocks.length) return blocks;
  const curr = blocks[blockIndex];
  const next = blocks[blockIndex + 1];

  const joinParts = (a, b) => {
    if (a && b) return `${a}\n\n${b}`;
    return a || b || '';
  };

  const mergedEn = joinParts(curr.enRaw, next.enRaw);
  const mergedJa = joinParts(curr.jaRaw, next.jaRaw);
  const mergedBlock = buildAlignmentBlock(mergedEn, mergedJa, blockIndex, {
    abbreviations,
    warnings: [],
  });

  const nextList = [
    ...blocks.slice(0, blockIndex),
    mergedBlock,
    ...blocks.slice(blockIndex + 2),
  ];
  return nextList.map((b, idx) => ({ ...b, index: idx }));
}

/**
 * Re-splits all sentences in a block using current abbreviation list or DP hint alignment.
 */
export function realignBlockWithHints(block, abbreviations, useHintDp = true) {
  const enList = splitEnglishSentences(block.enRaw, { abbreviations }).map((s) =>
    makeSentenceItem(s, 'en'),
  );
  const jaList = splitJapaneseSentences(block.jaRaw).map((s) => makeSentenceItem(s, 'ja'));
  const groups = useHintDp
    ? suggestHintedGroups(enList, jaList, block.id)
    : createInitialGroups(enList, jaList, block.id);

  return syncBlockMeta({
    ...block,
    enSentences: enList,
    jaSentences: jaList,
    groups,
  });
}

/**
 * Computes progress and warning counts for a project (including Phase 2 glossary warnings).
 */
export function computeProjectStats(
  project,
  glossaryEntries = [],
  jaNormOptions = DEFAULT_JA_NORM_OPTIONS,
) {
  const blocks = project?.blocks || [];
  let totalGroups = 0;
  let verifiedGroups = 0;
  let readGroups = 0;
  let needsReviewGroups = 0;
  let changedGroups = 0;
  let unreadGroups = 0;
  let structuralWarningBlocks = 0;
  let mismatchBlocks = 0;
  let glossaryWarningGroups = 0;
  let hintWarningGroups = 0;
  let tempNoOmissionGroups = 0;
  let markedGroups = 0;
  const dupJaIdx = buildDuplicateJaIndex(blocks);
  const dismissedHints = project?.dismissedHints || {};

  for (const block of blocks) {
    const warnings = block.warnings || [];
    if (
      warnings.some((w) =>
        ['CONSECUTIVE_EN', 'CONSECUTIVE_JA', 'TRAILING_EN', 'LEADING_JA', 'AMBIGUOUS_LANG'].includes(
          w,
        ),
      )
    ) {
      structuralWarningBlocks += 1;
    }
    if (warnings.includes('UNMATCHED_COUNT') || warnings.includes('UNCONFIRMED_GROUP')) {
      mismatchBlocks += 1;
    }

    const enMap = new Map((block.enSentences || []).map((s) => [s.id, s]));
    const jaMap = new Map((block.jaSentences || []).map((s) => [s.id, s]));

    for (const group of block.groups || []) {
      totalGroups += 1;
      if (group.status === 'verified') verifiedGroups += 1;
      else if (group.status === 'read') readGroups += 1;
      else if (group.status === 'needs_review') needsReviewGroups += 1;
      else if (group.status === 'source_changed') changedGroups += 1;
      else unreadGroups += 1;

      if (group.tempNoOmission) tempNoOmissionGroups += 1;
      const hasSentenceMarkers =
        (group.enIds || []).some((id) => (enMap.get(id)?.markers || []).length > 0) ||
        (group.jaIds || []).some((id) => (jaMap.get(id)?.markers || []).length > 0);
      if (hasSentenceMarkers) markedGroups += 1;

      if (glossaryEntries && glossaryEntries.length > 0) {
        const enPlain = (group.enIds || []).map((id) => enMap.get(id)?.plainText || '').join(' ');
        const jaPlain = (group.jaIds || []).map((id) => jaMap.get(id)?.plainText || '').join(' ');
        const gCheck = checkGroupGlossary(enPlain, jaPlain, glossaryEntries, jaNormOptions);
        if (gCheck.hasIssues) {
          glossaryWarningGroups += 1;
        }
      }

      const hCheck = detectGroupHints(group, block, {
        duplicateJaIndex: dupJaIdx,
        dismissedHints,
      });
      if (hCheck.hasActiveHints) {
        hintWarningGroups += 1;
      }
    }
  }

  const completedGroups = verifiedGroups;
  const progressPercent = totalGroups === 0 ? 0 : Math.round((completedGroups / totalGroups) * 100);

  return {
    totalBlocks: blocks.length,
    totalGroups,
    verifiedGroups,
    readGroups,
    needsReviewGroups,
    changedGroups,
    unreadGroups,
    structuralWarningBlocks,
    mismatchBlocks,
    glossaryWarningGroups,
    hintWarningGroups,
    tempNoOmissionGroups,
    markedGroups,
    progressPercent,
  };
}
