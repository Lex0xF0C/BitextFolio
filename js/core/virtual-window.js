/**
 * Pure virtual-window range and scroll-anchoring calculations.
 * Zero DOM dependencies.
 */

function readBlockHeight(block, heightLookup, defaultBlockHeight) {
  if (!block) return defaultBlockHeight;
  if (typeof heightLookup === 'function') {
    const h = Number(heightLookup(block.id));
    return Number.isFinite(h) && h > 0 ? h : defaultBlockHeight;
  }
  if (heightLookup && typeof heightLookup.get === 'function') {
    const h = Number(heightLookup.get(block.id));
    return Number.isFinite(h) && h > 0 ? h : defaultBlockHeight;
  }
  if (heightLookup && typeof heightLookup === 'object') {
    const h = Number(heightLookup[block.id]);
    return Number.isFinite(h) && h > 0 ? h : defaultBlockHeight;
  }
  return defaultBlockHeight;
}

/**
 * Computes [startIdx, endIdx) of blocks intersecting [viewTop - overscanPx, viewTop + clientHeight + overscanPx]
 * along with spacer heights for blocks above and below the rendered window.
 *
 * @param {Array<{ id: string }>} blocks
 * @param {Map<string, number>|Record<string, number>|((id: string) => number)} heightLookup
 * @param {{ viewTop?: number, clientHeight?: number, defaultBlockHeight?: number, overscanPx?: number }} [options]
 * @returns {{ startIdx: number, endIdx: number, topHeight: number, bottomHeight: number }}
 */
export function computeVirtualWindowRange(blocks, heightLookup, options = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const total = list.length;
  if (total === 0) {
    return { startIdx: 0, endIdx: 0, topHeight: 0, bottomHeight: 0 };
  }

  const viewTop = Math.max(0, Number(options.viewTop) || 0);
  const clientHeight = Math.max(0, Number(options.clientHeight) || 0);
  const viewBottom = viewTop + clientHeight;
  const defaultBlockHeight = Math.max(1, Number(options.defaultBlockHeight) || 280);
  const overscanPx = Math.max(0, Number(options.overscanPx) ?? 900);

  let accY = 0;
  let startIdx = 0;
  let endIdx = total;
  let topHeight = 0;
  let bottomHeight = 0;

  for (let i = 0; i < total; i += 1) {
    const h = readBlockHeight(list[i], heightLookup, defaultBlockHeight);
    if (accY + h < viewTop - overscanPx) {
      startIdx = i + 1;
      topHeight += h;
    } else if (accY > viewBottom + overscanPx) {
      endIdx = i;
      break;
    }
    accY += h;
  }

  for (let i = endIdx; i < total; i += 1) {
    bottomHeight += readBlockHeight(list[i], heightLookup, defaultBlockHeight);
  }

  return { startIdx, endIdx, topHeight, bottomHeight };
}

/**
 * Computes scrollTop compensation after a virtual-window DOM update shifts an anchor element's position.
 * Returns null if no adjustment is needed.
 *
 * @param {number} currentScrollTop
 * @param {number} anchorOldTop
 * @param {number} anchorNewTop
 * @param {number} [minDeltaPx]
 * @returns {number|null}
 */
export function computeAnchoredScrollTop(
  currentScrollTop,
  anchorOldTop,
  anchorNewTop,
  minDeltaPx = 2,
) {
  const scrollTop = Number(currentScrollTop) || 0;
  if (scrollTop <= 0) return null;
  const delta = (Number(anchorNewTop) || 0) - (Number(anchorOldTop) || 0);
  if (Math.abs(delta) < minDeltaPx) return null;
  return Math.max(0, scrollTop + delta);
}
