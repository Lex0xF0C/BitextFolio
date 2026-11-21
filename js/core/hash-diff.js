/**
 * Deterministic block hashing and diff reconciliation when replacing source text.
 * Zero DOM dependencies.
 */

import { computeDeterministicHash, normalizeForHash } from './markup.js';
import { syncBlockMeta } from './alignment.js';

/**
 * Computes normalized EN, JA, and combined pair hashes for a block.
 * @param {string} enRaw
 * @param {string} jaRaw
 */
export function buildBlockHashes(enRaw, jaRaw) {
  const enNorm = normalizeForHash(enRaw || '');
  const jaNorm = normalizeForHash(jaRaw || '');
  const enHash = computeDeterministicHash(`en:${enNorm}`);
  const jaHash = computeDeterministicHash(`ja:${jaNorm}`);
  const pairHash = computeDeterministicHash(`pair:${enNorm}\n---\n${jaNorm}`);
  return { enHash, jaHash, pairHash };
}

/**
 * Reconciles newly parsed blocks against previous blocks on source replacement.
 * - Exact pairHash match -> inherits groups, statuses, memos, and sentence edits verbatim.
 * - Partial match (enHash or jaHash match) or positional fallback with prior notes ->
 *   marks groups as 'source_changed' ("変更あり・要再確認") and preserves old memos as reference.
 *
 * @param {Array<any>} oldBlocks
 * @param {Array<any>} newBlocks
 */
export function reconcileReloadedBlocks(oldBlocks, newBlocks) {
  const usedOldIndices = new Set();
  const byPairHash = new Map();
  const byEnHash = new Map();
  const byJaHash = new Map();

  oldBlocks.forEach((blk, idx) => {
    if (!byPairHash.has(blk.pairHash)) byPairHash.set(blk.pairHash, []);
    byPairHash.get(blk.pairHash).push(idx);

    if (blk.enRaw && !byEnHash.has(blk.enHash)) byEnHash.set(blk.enHash, []);
    if (blk.enRaw) byEnHash.get(blk.enHash).push(idx);

    if (blk.jaRaw && !byJaHash.has(blk.jaHash)) byJaHash.set(blk.jaHash, []);
    if (blk.jaRaw) byJaHash.get(blk.jaHash).push(idx);
  });

  let inheritedCount = 0;
  let changedCount = 0;
  let addedCount = 0;

  const takeUnused = (list) => {
    if (!list) return -1;
    for (const idx of list) {
      if (!usedOldIndices.has(idx)) {
        usedOldIndices.add(idx);
        return idx;
      }
    }
    return -1;
  };

  // Pass 1: exact pairHash match
  const matchedOldIndexForNew = new Array(newBlocks.length).fill(-1);
  newBlocks.forEach((nBlk, nIdx) => {
    const matchIdx = takeUnused(byPairHash.get(nBlk.pairHash));
    if (matchIdx !== -1) {
      matchedOldIndexForNew[nIdx] = matchIdx;
    }
  });

  // Pass 2: partial match (either EN or JA unchanged)
  const partialOldIndexForNew = new Array(newBlocks.length).fill(-1);
  newBlocks.forEach((nBlk, nIdx) => {
    if (matchedOldIndexForNew[nIdx] !== -1) return;
    let partialIdx = takeUnused(byEnHash.get(nBlk.enHash));
    if (partialIdx === -1) {
      partialIdx = takeUnused(byJaHash.get(nBlk.jaHash));
    }
    if (partialIdx !== -1) {
      partialOldIndexForNew[nIdx] = partialIdx;
    }
  });

  const reconciled = newBlocks.map((nBlk, nIdx) => {
    const exactIdx = matchedOldIndexForNew[nIdx];
    if (exactIdx !== -1) {
      inheritedCount += 1;
      const oldBlk = oldBlocks[exactIdx];
      return syncBlockMeta({
        ...nBlk,
        enSentences: oldBlk.enSentences,
        jaSentences: oldBlk.jaSentences,
        groups: oldBlk.groups,
        warnings: [...(nBlk.warnings || [])],
      });
    }

    const partialIdx = partialOldIndexForNew[nIdx];
    if (partialIdx !== -1) {
      changedCount += 1;
      const oldBlk = oldBlocks[partialIdx];
      const oldNotes = oldBlk.groups
        .map((g) => g.memo)
        .filter((m) => m && m.trim().length > 0)
        .join(' / ');
      const updatedGroups = nBlk.groups.map((g, gIdx) => ({
        ...g,
        status: 'source_changed',
        previousMemoNote: gIdx === 0 && oldNotes ? `変更前メモ: ${oldNotes}` : '',
      }));
      return syncBlockMeta({
        ...nBlk,
        groups: updatedGroups,
        warnings: [...new Set([...(nBlk.warnings || []), 'SOURCE_CHANGED'])],
      });
    }

    // If same-index old block existed and wasn't matched elsewhere, mark changed if it had review activity
    if (nIdx < oldBlocks.length && !usedOldIndices.has(nIdx)) {
      const fallbackOld = oldBlocks[nIdx];
      const hadActivity = fallbackOld.groups.some(
        (g) => g.status !== 'unread' || (g.memo && g.memo.trim().length > 0),
      );
      if (hadActivity) {
        usedOldIndices.add(nIdx);
        changedCount += 1;
        const oldNotes = fallbackOld.groups
          .map((g) => g.memo)
          .filter((m) => m && m.trim().length > 0)
          .join(' / ');
        return syncBlockMeta({
          ...nBlk,
          groups: nBlk.groups.map((g, gIdx) => ({
            ...g,
            status: 'source_changed',
            previousMemoNote: gIdx === 0 && oldNotes ? `変更前メモ: ${oldNotes}` : '',
          })),
          warnings: [...new Set([...(nBlk.warnings || []), 'SOURCE_CHANGED'])],
        });
      }
    }

    addedCount += 1;
    return nBlk;
  });

  return {
    blocks: reconciled,
    summary: { inheritedCount, changedCount, addedCount },
  };
}
