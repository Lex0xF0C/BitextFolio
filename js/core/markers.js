/**
 * Deterministic sentence marker interval operations and inline-token splitting.
 * Zero DOM dependencies.
 */

/**
 * Normalizes, clamps, sorts, and merges overlapping or adjacent marker intervals.
 * @param {Array<{start: number, end: number}>} ranges
 * @param {number} maxLength
 * @returns {Array<{start: number, end: number}>}
 */
export function normalizeMarkerRanges(ranges, maxLength) {
  const limit = Math.max(0, Number(maxLength) || 0);
  if (!Array.isArray(ranges) || ranges.length === 0 || limit === 0) return [];

  const valid = [];
  for (const r of ranges) {
    if (!r || typeof r !== 'object') continue;
    const start = Math.max(0, Math.min(limit, Math.floor(Number(r.start))));
    const end = Math.max(0, Math.min(limit, Math.floor(Number(r.end))));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      valid.push({ start, end });
    }
  }
  if (valid.length === 0) return [];

  valid.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [{ ...valid[0] }];
  for (let i = 1; i < valid.length; i += 1) {
    const prev = merged[merged.length - 1];
    const curr = valid[i];
    if (curr.start <= prev.end) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}

/**
 * Adds a marker range [start, end] and returns a normalized merged list.
 */
export function addMarkerRange(ranges, start, end, maxLength) {
  return normalizeMarkerRanges([...(ranges || []), { start, end }], maxLength);
}

/**
 * Subtracts [cutStart, cutEnd] from existing marker intervals.
 */
export function removeMarkerRange(ranges, cutStart, cutEnd, maxLength) {
  const norm = normalizeMarkerRanges(ranges, maxLength);
  const cs = Math.max(0, Math.floor(Number(cutStart) || 0));
  const ce = Math.max(0, Math.floor(Number(cutEnd) || 0));
  if (ce <= cs || norm.length === 0) return norm;

  const next = [];
  for (const r of norm) {
    if (r.end <= cs || r.start >= ce) {
      next.push(r);
      continue;
    }
    if (r.start < cs) {
      next.push({ start: r.start, end: cs });
    }
    if (r.end > ce) {
      next.push({ start: ce, end: r.end });
    }
  }
  return next;
}

/**
 * Returns true if any marker range overlaps [start, end].
 */
export function hasMarkerOverlap(ranges, start, end) {
  if (!Array.isArray(ranges) || ranges.length === 0) return false;
  const s = Number(start);
  const e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return false;
  return ranges.some((r) => r && r.end > s && r.start < e);
}

/**
 * Returns true if the entire interval [start, end] is covered by existing markers.
 */
export function isRangeFullyMarked(ranges, start, end) {
  if (!Array.isArray(ranges) || ranges.length === 0) return false;
  const s = Math.floor(Number(start));
  const e = Math.floor(Number(end));
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return false;
  const norm = normalizeMarkerRanges(ranges, Math.max(e, ...ranges.map((r) => Number(r?.end) || 0)));
  return norm.some((r) => r.start <= s && r.end >= e);
}

/**
 * Computes percentage of plainText covered by markers (0..100).
 */
export function computeMarkerCoveragePercent(ranges, plainLength) {
  const len = Math.max(0, Number(plainLength) || 0);
  if (len === 0 || !Array.isArray(ranges) || ranges.length === 0) return 0;
  const norm = normalizeMarkerRanges(ranges, len);
  let covered = 0;
  for (const r of norm) {
    covered += r.end - r.start;
  }
  return Math.min(100, Math.round((covered / len) * 100));
}

/**
 * Remaps markers when splitting a sentence into left and right items.
 */
export function remapMarkersOnSplit(markers, targetPlainLen, leftPlainLen, rightPlainLen) {
  const norm = normalizeMarkerRanges(markers, targetPlainLen);
  if (norm.length === 0) return { leftMarkers: [], rightMarkers: [] };

  const rightStart = Math.max(0, targetPlainLen - rightPlainLen);
  const leftRaw = [];
  const rightRaw = [];

  for (const r of norm) {
    if (r.start < leftPlainLen) {
      leftRaw.push({ start: r.start, end: Math.min(r.end, leftPlainLen) });
    }
    if (r.end > rightStart) {
      rightRaw.push({
        start: Math.max(0, r.start - rightStart),
        end: Math.max(0, r.end - rightStart),
      });
    }
  }

  return {
    leftMarkers: normalizeMarkerRanges(leftRaw, leftPlainLen),
    rightMarkers: normalizeMarkerRanges(rightRaw, rightPlainLen),
  };
}

/**
 * Merges left and right sentence marker lists when concatenating two sentences.
 */
export function mergeMarkerLists(
  leftMarkers,
  rightMarkers,
  rightOffset,
  totalPlainLen,
  leftPlainLen = rightOffset,
) {
  const shiftedRight = (rightMarkers || []).map((r) => ({
    start: r.start + rightOffset,
    end: r.end + rightOffset,
  }));
  const combined = [...(leftMarkers || []), ...shiftedRight];
  const leftTouchesEnd = (leftMarkers || []).some((r) => r.end >= leftPlainLen);
  const rightTouchesStart = (rightMarkers || []).some((r) => r.start === 0);
  if (leftTouchesEnd && rightTouchesStart && rightOffset > leftPlainLen) {
    combined.push({ start: leftPlainLen, end: rightOffset });
  }
  return normalizeMarkerRanges(combined, totalPlainLen);
}

/**
 * Splits inline markup tokens into sub-segments annotated with `marked: boolean`
 * matching character intervals relative to the concatenated plain text.
 * @param {Array<{type: string, value: string}>} tokens
 * @param {Array<{start: number, end: number}>} markers
 * @returns {Array<{type: string, value: string, marked: boolean}>}
 */
export function splitTokensByMarkers(tokens, markers) {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];
  const totalLen = tokens.reduce((acc, t) => acc + (t.value ? t.value.length : 0), 0);
  const norm = normalizeMarkerRanges(markers, totalLen);

  if (norm.length === 0) {
    return tokens.map((t) => ({ ...t, marked: false }));
  }

  const out = [];
  let cursor = 0;
  let mIdx = 0;

  for (const token of tokens) {
    const text = token.value || '';
    const tokenStart = cursor;
    const tokenEnd = cursor + text.length;
    cursor = tokenEnd;

    if (text.length === 0) continue;

    while (mIdx < norm.length && norm[mIdx].end <= tokenStart) {
      mIdx += 1;
    }

    let pos = tokenStart;
    let scanIdx = mIdx;

    while (pos < tokenEnd) {
      while (scanIdx < norm.length && norm[scanIdx].end <= pos) {
        scanIdx += 1;
      }
      const m = scanIdx < norm.length ? norm[scanIdx] : null;
      if (!m || m.start >= tokenEnd) {
        out.push({
          type: token.type,
          value: text.slice(pos - tokenStart),
          marked: false,
        });
        break;
      }
      if (pos < m.start) {
        const nextCut = Math.min(tokenEnd, m.start);
        out.push({
          type: token.type,
          value: text.slice(pos - tokenStart, nextCut - tokenStart),
          marked: false,
        });
        pos = nextCut;
        continue;
      }
      const markEnd = Math.min(tokenEnd, m.end);
      out.push({
        type: token.type,
        value: text.slice(pos - tokenStart, markEnd - tokenStart),
        marked: true,
      });
      pos = markEnd;
    }
  }

  return out;
}

/**
 * Splits inline markup tokens across manual markers and temporary clause-pair spans.
 * @param {Array<{type: string, value: string}>} tokens
 * @param {{markers?: Array<{start:number,end:number}>, pending?: Array<{start:number,end:number}>, checked?: Array<{start:number,end:number}>}} layers
 * @returns {Array<{type: string, value: string, marked: boolean, clauseState: 'none'|'pending'|'checked'}>}
 */
export function splitTokensByHighlights(tokens, layers = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];
  const totalLen = tokens.reduce((acc, t) => acc + (t.value ? t.value.length : 0), 0);
  const normMarkers = normalizeMarkerRanges(layers.markers || [], totalLen);
  const normPending = normalizeMarkerRanges(layers.pending || [], totalLen);
  const normChecked = normalizeMarkerRanges(layers.checked || [], totalLen);

  if (normMarkers.length === 0 && normPending.length === 0 && normChecked.length === 0) {
    return tokens.map((t) => ({ ...t, marked: false, clauseState: 'none' }));
  }

  const containsSlice = (ranges, a, b) => ranges.some((r) => r.start <= a && r.end >= b);

  const out = [];
  let cursor = 0;

  for (const token of tokens) {
    const text = token.value || '';
    const tokenStart = cursor;
    const tokenEnd = cursor + text.length;
    cursor = tokenEnd;
    if (text.length === 0) continue;

    const bounds = new Set([tokenStart, tokenEnd]);
    for (const list of [normMarkers, normPending, normChecked]) {
      for (const r of list) {
        if (r.start > tokenStart && r.start < tokenEnd) bounds.add(r.start);
        if (r.end > tokenStart && r.end < tokenEnd) bounds.add(r.end);
      }
    }
    const sorted = [...bounds].sort((a, b) => a - b);

    for (let i = 0; i < sorted.length - 1; i += 1) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (b <= a) continue;
      const marked = containsSlice(normMarkers, a, b);
      const clauseState = containsSlice(normChecked, a, b)
        ? 'checked'
        : containsSlice(normPending, a, b)
          ? 'pending'
          : 'none';
      out.push({
        type: token.type,
        value: text.slice(a - tokenStart, b - tokenStart),
        marked,
        clauseState,
      });
    }
  }

  return out;
}
