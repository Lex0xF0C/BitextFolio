/**
 * Safe DOM element creation helpers and inline markup renderer.
 * Zero innerHTML usage with untrusted text.
 */

import { sliceTokensByRange, splitTokensByHighlights } from '../core/markers.js';
import { tokenizeInlineMarkup } from '../core/markup.js';

export const STATUS_META = {
  unread: { label: '未読', icon: '○', className: 'status-unread' },
  read: { label: '読了', icon: '◐', className: 'status-read' },
  verified: { label: '確認済', icon: '✓', className: 'status-verified' },
  needs_review: { label: '要確認', icon: '!', className: 'status-needs_review' },
  source_changed: { label: '変更あり', icon: 'Δ', className: 'status-source_changed' },
};

export const WARNING_LABELS = {
  CONSECUTIVE_EN: '英語段落が連続しています（対応する日本語段落が欠落または結合が必要）',
  CONSECUTIVE_JA: '日本語段落が連続しています（対応する英語段落が欠落または結合が必要）',
  TRAILING_EN: '末尾が英語段落で終わっています',
  LEADING_JA: '先頭が日本語段落で始まっています',
  AMBIGUOUS_LANG: '言語判定の確信度が低いブロックです',
  UNMATCHED_COUNT: '文数不一致',
  UNCONFIRMED_GROUP: '未確定グループあり',
  SOURCE_CHANGED: '原文差し替えにより変更あり',
};

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  const tagLower = String(tag).toLowerCase();
  const useValueProp =
    tagLower === 'textarea' ||
    tagLower === 'input' ||
    tagLower === 'select' ||
    tagLower === 'option';
  let hasDeferredValue = false;
  let deferredValue = '';

  for (const [key, val] of Object.entries(attrs)) {
    if (val === null || val === undefined || val === false) continue;
    if (key === 'className') {
      node.className = val;
    } else if (key === 'textContent') {
      node.textContent = val;
    } else if (key === 'value' && useValueProp) {
      hasDeferredValue = true;
      deferredValue = String(val);
    } else if (key.startsWith('on') && typeof val === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (key === 'dataset' && typeof val === 'object') {
      for (const [dk, dv] of Object.entries(val)) {
        if (dv !== undefined && dv !== null) {
          node.dataset[dk] = String(dv);
        }
      }
    } else if (val === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(val));
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }
  if (hasDeferredValue) {
    node.value = deferredValue;
  }
  return node;
}

function wrapTermHighlightNode(innerNode, seg) {
  if (seg.termState === 'deprecated') {
    return el('span', { className: 'tm-term-match is-deprecated', title: seg.termTitle || null }, [
      innerNode,
    ]);
  }
  if (seg.termState === 'typo') {
    return el('span', { className: 'tm-term-match is-typo', title: seg.termTitle || null }, [
      innerNode,
    ]);
  }
  if (seg.termState === 'matched') {
    return el('span', { className: 'tm-term-match', title: seg.termTitle || null }, [innerNode]);
  }
  return innerNode;
}

/**
 * Safely renders inline emphasis/code tokens, manual markers, temporary clause highlights,
 * and dashed underlines for registered TM/glossary terms.
 */
export function renderRichSentenceFragment(
  rawText,
  markers = [],
  clauseHighlights = null,
  termSpans = [],
  options = {},
) {
  const frag = document.createDocumentFragment();
  const tokens = options?.literalText
    ? rawText
      ? [{ type: 'text', value: String(rawText) }]
      : []
    : tokenizeInlineMarkup(rawText);
  const segments = splitTokensByHighlights(tokens, {
    markers,
    pending: clauseHighlights?.pending || [],
    checked: clauseHighlights?.checked || [],
    terms: termSpans,
  });
  for (const seg of segments) {
    let innerNode = seg.marked
      ? el('mark', { className: 'sentence-marker', textContent: seg.value })
      : document.createTextNode(seg.value);

    innerNode = wrapTermHighlightNode(innerNode, seg);

    if (seg.clauseState === 'checked') {
      innerNode = el('span', { className: 'clause-span is-checked' }, [innerNode]);
    } else if (seg.clauseState === 'pending') {
      innerNode = el('span', { className: 'clause-span is-pending' }, [innerNode]);
    }

    if (seg.type === 'em') {
      frag.appendChild(el('em', {}, [innerNode]));
    } else if (seg.type === 'strong') {
      frag.appendChild(el('strong', {}, [innerNode]));
    } else if (seg.type === 'code') {
      frag.appendChild(el('code', {}, [innerNode]));
    } else {
      frag.appendChild(innerNode);
    }
  }
  return frag;
}

/**
 * Safely renders a sentence slice [spanStart, spanEnd) with inline markup, sentence markers, and term underlines.
 */
export function renderClauseFragment(
  rawText,
  markers = [],
  spanStart = 0,
  spanEnd = 0,
  termSpans = [],
  options = {},
) {
  const frag = document.createDocumentFragment();
  const tokens = options?.literalText
    ? rawText
      ? [{ type: 'text', value: String(rawText) }]
      : []
    : tokenizeInlineMarkup(rawText);
  const segments = sliceTokensByRange(tokens, markers, spanStart, spanEnd, termSpans);
  for (const seg of segments) {
    let innerNode = seg.marked
      ? el('mark', { className: 'sentence-marker', textContent: seg.value })
      : document.createTextNode(seg.value);

    innerNode = wrapTermHighlightNode(innerNode, seg);

    if (seg.type === 'em') {
      frag.appendChild(el('em', {}, [innerNode]));
    } else if (seg.type === 'strong') {
      frag.appendChild(el('strong', {}, [innerNode]));
    } else if (seg.type === 'code') {
      frag.appendChild(el('code', {}, [innerNode]));
    } else {
      frag.appendChild(innerNode);
    }
  }
  return frag;
}

import { checkGroupGlossary, DEFAULT_JA_NORM_OPTIONS } from '../core/glossary.js';
import { detectGroupHints } from '../core/hints.js';

export function blockHasGlossaryIssues(
  block,
  glossary = [],
  jaNormOptions = DEFAULT_JA_NORM_OPTIONS,
  dismissedHints = {},
) {
  if (!glossary || glossary.length === 0) return false;
  const enMap = new Map((block.enSentences || []).map((s) => [s.id, s]));
  const jaMap = new Map((block.jaSentences || []).map((s) => [s.id, s]));
  return (block.groups || []).some((g) => {
    const enPlain = (g.enIds || []).map((id) => enMap.get(id)?.plainText || '').join(' ');
    const jaPlain = (g.jaIds || []).map((id) => jaMap.get(id)?.plainText || '').join(' ');
    const literalText =
      (g.enIds || []).some((id) => Boolean(enMap.get(id)?.literalText)) ||
      (g.jaIds || []).some((id) => Boolean(jaMap.get(id)?.literalText));
    return checkGroupGlossary(enPlain, jaPlain, glossary, jaNormOptions, {
      groupId: g.id,
      dismissedHints,
      literalText,
    }).hasIssues;
  });
}

export function blockHasActiveHints(block, duplicateJaIndex = null, dismissedHints = {}) {
  return (block.groups || []).some(
    (g) => detectGroupHints(g, block, { duplicateJaIndex, dismissedHints }).hasActiveHints,
  );
}

export function blockHasMarkersOrTempNoOmission(block) {
  const hasTempOrClauses = (block.groups || []).some(
    (g) => Boolean(g.tempNoOmission) || (g.clausePairs || []).length > 0,
  );
  if (hasTempOrClauses) return true;
  return (
    (block.enSentences || []).some((s) => (s.markers || []).length > 0) ||
    (block.jaSentences || []).some((s) => (s.markers || []).length > 0)
  );
}

export function blockMatchesFilter(
  block,
  filterStatus,
  searchQuery,
  glossary = [],
  jaNormOptions = DEFAULT_JA_NORM_OPTIONS,
  duplicateJaIndex = null,
  dismissedHints = {},
) {
  const q = (searchQuery || '').trim().toLowerCase();
  const hasMatchingStatus = () => {
    if (filterStatus === 'all') return true;
    if (filterStatus === 'marked_or_temp') {
      return blockHasMarkersOrTempNoOmission(block);
    }
    if (filterStatus === 'glossary_issues') {
      return blockHasGlossaryIssues(block, glossary, jaNormOptions, dismissedHints);
    }
    if (filterStatus === 'hint_issues') {
      return blockHasActiveHints(block, duplicateJaIndex, dismissedHints);
    }
    if (filterStatus === 'warnings') {
      return (
        (block.warnings || []).length > 0 ||
        block.groups.some((g) => g.status === 'needs_review' || g.status === 'source_changed') ||
        blockHasGlossaryIssues(block, glossary, jaNormOptions, dismissedHints) ||
        blockHasActiveHints(block, duplicateJaIndex, dismissedHints)
      );
    }
    return block.groups.some((g) => g.status === filterStatus);
  };

  if (!hasMatchingStatus()) return false;
  if (!q) return true;

  const inSentences =
    block.enSentences.some(
      (s) => s.plainText.toLowerCase().includes(q) || s.rawText.toLowerCase().includes(q),
    ) ||
    block.jaSentences.some(
      (s) => s.plainText.toLowerCase().includes(q) || s.rawText.toLowerCase().includes(q),
    );
  const inMemos = block.groups.some((g) => (g.memo || '').toLowerCase().includes(q));
  return inSentences || inMemos;
}
