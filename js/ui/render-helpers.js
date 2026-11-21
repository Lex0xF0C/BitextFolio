/**
 * Safe DOM element creation helpers and inline markup renderer.
 * Zero innerHTML usage with untrusted text.
 */

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
  for (const [key, val] of Object.entries(attrs)) {
    if (val === null || val === undefined || val === false) continue;
    if (key === 'className') {
      node.className = val;
    } else if (key === 'textContent') {
      node.textContent = val;
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
  return node;
}

/**
 * Safely renders inline emphasis/code tokens as DOM nodes.
 */
export function renderRichSentenceFragment(rawText) {
  const frag = document.createDocumentFragment();
  const tokens = tokenizeInlineMarkup(rawText);
  for (const token of tokens) {
    if (token.type === 'em') {
      frag.appendChild(el('em', { textContent: token.value }));
    } else if (token.type === 'strong') {
      frag.appendChild(el('strong', { textContent: token.value }));
    } else if (token.type === 'code') {
      frag.appendChild(el('code', { textContent: token.value }));
    } else {
      frag.appendChild(document.createTextNode(token.value));
    }
  }
  return frag;
}

import { checkGroupGlossary, DEFAULT_JA_NORM_OPTIONS } from '../core/glossary.js';
import { detectGroupHints } from '../core/hints.js';

export function blockHasGlossaryIssues(block, glossary = [], jaNormOptions = DEFAULT_JA_NORM_OPTIONS) {
  if (!glossary || glossary.length === 0) return false;
  const enMap = new Map((block.enSentences || []).map((s) => [s.id, s]));
  const jaMap = new Map((block.jaSentences || []).map((s) => [s.id, s]));
  return (block.groups || []).some((g) => {
    const enPlain = (g.enIds || []).map((id) => enMap.get(id)?.plainText || '').join(' ');
    const jaPlain = (g.jaIds || []).map((id) => jaMap.get(id)?.plainText || '').join(' ');
    return checkGroupGlossary(enPlain, jaPlain, glossary, jaNormOptions).hasIssues;
  });
}

export function blockHasActiveHints(block, duplicateJaIndex = null, dismissedHints = {}) {
  return (block.groups || []).some(
    (g) => detectGroupHints(g, block, { duplicateJaIndex, dismissedHints }).hasActiveHints,
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
    if (filterStatus === 'glossary_issues') {
      return blockHasGlossaryIssues(block, glossary, jaNormOptions);
    }
    if (filterStatus === 'hint_issues') {
      return blockHasActiveHints(block, duplicateJaIndex, dismissedHints);
    }
    if (filterStatus === 'warnings') {
      return (
        (block.warnings || []).length > 0 ||
        block.groups.some((g) => g.status === 'needs_review' || g.status === 'source_changed') ||
        blockHasGlossaryIssues(block, glossary, jaNormOptions) ||
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
