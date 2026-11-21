/**
 * Main workspace UI controller: persistent shell + surgical region updates + virtual windowing.
 */

import { computeGroupHints } from '../core/alignment.js';
import { checkGroupGlossary } from '../core/glossary.js';
import { buildDuplicateJaIndex, detectGroupHints } from '../core/hints.js';
import {
  computeMarkerCoveragePercent,
  hasMarkerOverlap,
  isRangeFullyMarked,
} from '../core/markers.js';
import { extractJapaneseCandidateTerms, findTmMatches } from '../core/tm.js';
import {
  blockHasActiveHints,
  blockHasGlossaryIssues,
  blockMatchesFilter,
  el,
  renderRichSentenceFragment,
  STATUS_META,
  WARNING_LABELS,
} from './render-helpers.js';

const VIRTUAL_THRESHOLD = 40;
const DEFAULT_BLOCK_HEIGHT = 280;
const OVERSCAN_PX = 900;

export function mountWorkspace(rootEl, store, onOpenImportSample) {
  let dragPayload = null;
  const blockHeights = new Map();
  let lastFilteredBlocks = [];
  let currentDupJaIndex = null;
  let virtualRaf = null;
  let lastRenderRange = { start: -1, end: -1 };
  let rememberedJaSelection = null; // { groupId, text }
  let quickRegisterState = null; // { mode: 'tm' | 'glossary', blockId, groupId, enText, jaText, jaSuggestions }
  const unmatchedDrafts = new Map(); // `${groupId}:${lang}` -> string

  // Build persistent shell once so inputs (search, memo) never lose focus unnecessarily
  const projectSelect = el('select', {
    className: 'project-select',
    'aria-label': 'ドキュメント選択',
    onChange: (e) => store.selectProject(e.target.value),
  });

  const themeBtn = el('button', {
    type: 'button',
    className: 'btn btn-sm',
    onClick: () => store.setTheme(store.state.theme === 'dark' ? 'light' : 'dark'),
  });

  const headerEl = el('header', { className: 'top-header' }, [
    el('div', { className: 'brand-zone' }, [
      el('h1', {
        className: 'brand-title',
        textContent: 'BitextFolio',
        title: 'BitextFolio — 英日対訳チェック支援ツール',
      }),
      el('div', { className: 'project-select-wrap' }, [projectSelect]),
    ]),
    el('nav', { className: 'top-nav', 'aria-label': '主要メニュー' }, [
      el('button', {
        type: 'button',
        className: 'nav-action-btn',
        textContent: '用語集・逆引き',
        onClick: () => store.openModal('glossary', 'list'),
      }),
      el('button', {
        type: 'button',
        className: 'nav-action-btn',
        textContent: '翻訳メモリ・用語抽出',
        onClick: () => store.openModal('tm', 'tm'),
      }),
      el('button', {
        type: 'button',
        className: 'nav-action-btn',
        textContent: '原文差し替え',
        onClick: () => store.openModal('import', 'replace'),
      }),
      el('button', {
        type: 'button',
        className: 'nav-action-btn',
        textContent: 'JSON保存・復元',
        onClick: () => store.openModal('json'),
      }),
      el('button', {
        type: 'button',
        className: 'nav-action-btn',
        textContent: '略語ルール設定',
        onClick: () => store.openModal('settings'),
      }),
      el('button', {
        type: 'button',
        className: 'nav-action-btn',
        textContent: '操作ガイド (?)',
        onClick: () => store.openModal('shortcuts'),
      }),
    ]),
    el('div', { className: 'header-actions' }, [
      themeBtn,
      el('button', {
        type: 'button',
        className: 'btn btn-primary btn-sm',
        textContent: '新規読込',
        onClick: () => store.openModal('import', 'new'),
      }),
    ]),
  ]);

  const warningSummaryItems = el('div', { className: 'warning-summary-items' });
  const warningBar = el('div', { className: 'warning-bar is-hidden', role: 'status' }, [
    warningSummaryItems,
    el('div', { className: 'toolbar-group' }, [
      el('button', {
        type: 'button',
        className: 'btn btn-xs',
        textContent: '警告・不一致のみ表示',
        onClick: () => store.setFilterStatus('warnings'),
      }),
      el('button', {
        type: 'button',
        className: 'btn btn-xs',
        textContent: '次の警告・要確認へ',
        onClick: () => jumpToNextAttentionGroup(),
      }),
    ]),
  ]);

  const searchInput = el('input', {
    type: 'search',
    className: 'search-input',
    placeholder: '英文・和文・メモを検索...',
    'aria-label': 'ブロック検索',
    onInput: (e) => store.setSearchQuery(e.target.value),
  });

  const progressText = el('span', { className: 'tabular-nums' });
  const progressCount = el('span', { className: 'tabular-nums' });
  const progressFill = el('div', { className: 'progress-fill' });
  const sidebarList = el('div', { className: 'sidebar-list' });

  const sidebarEl = el('aside', { className: 'sidebar', 'aria-label': 'ブロック一覧' }, [
    el('div', { className: 'sidebar-top' }, [
      searchInput,
      el('div', { className: 'sidebar-stats' }, [progressText, progressCount]),
      el('div', { className: 'progress-track' }, [progressFill]),
      el('button', {
        type: 'button',
        className: 'btn btn-sm',
        textContent: '前回の続きへ移動',
        onClick: () => jumpToLastFocused(),
      }),
    ]),
    sidebarList,
  ]);

  const sidebarToggleBtn = el('button', {
    type: 'button',
    className: 'btn btn-sm',
    textContent: '目次切替',
    onClick: () => store.toggleSidebar(),
  });

  const filterControl = el('div', { className: 'segmented-control', role: 'tablist', 'aria-label': '状態フィルタ' });
  const layoutControl = el('div', { className: 'segmented-control', role: 'group', 'aria-label': '表示レイアウト' });

  const toolbarEl = el('div', { className: 'workspace-toolbar' }, [
    el('div', { className: 'toolbar-group' }, [sidebarToggleBtn, filterControl]),
    el('div', { className: 'toolbar-group' }, [layoutControl]),
  ]);

  const topSpacer = el('div', { className: 'virtual-spacer' });
  const blocksList = el('div', { className: 'blocks-list' });
  const bottomSpacer = el('div', { className: 'virtual-spacer' });
  const blocksViewport = el('main', { className: 'blocks-viewport', tabindex: '-1' }, [
    topSpacer,
    blocksList,
    bottomSpacer,
  ]);

  blocksViewport.addEventListener('scroll', () => {
    if (lastFilteredBlocks.length <= VIRTUAL_THRESHOLD) return;
    if (virtualRaf) return;
    virtualRaf = requestAnimationFrame(() => {
      virtualRaf = null;
      renderVisibleWindow(false);
    });
  });

  const mainPane = el('div', { className: 'main-pane' }, [toolbarEl, blocksViewport]);
  const workspaceBody = el('div', { className: 'workspace-body' }, [sidebarEl, mainPane]);
  const modalRoot = el('div');
  const contextMenuEl = el('div', {
    className: 'context-menu is-hidden',
    role: 'menu',
    'aria-label': '選択テキスト登録メニュー',
  });
  const toastRegion = el('div', { className: 'toast-region', 'aria-live': 'polite' });

  rootEl.appendChild(headerEl);
  rootEl.appendChild(warningBar);
  rootEl.appendChild(workspaceBody);
  rootEl.appendChild(modalRoot);
  rootEl.appendChild(contextMenuEl);
  rootEl.appendChild(toastRegion);

  function closeContextMenu() {
    contextMenuEl.classList.add('is-hidden');
    contextMenuEl.textContent = '';
  }

  document.addEventListener('mousedown', (e) => {
    if (!contextMenuEl.classList.contains('is-hidden') && !contextMenuEl.contains(e.target)) {
      closeContextMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeContextMenu();
      if (quickRegisterState) {
        quickRegisterState = null;
        renderVisibleWindow(true);
      }
    }
  });
  blocksViewport.addEventListener('scroll', closeContextMenu);

  function truncateLabel(text, maxLen = 28) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean;
  }

  function openQuickRegister(nextState) {
    quickRegisterState = nextState;
    renderVisibleWindow(true);
    requestAnimationFrame(() => {
      const targetInput = blocksList.querySelector(
        `input[data-quick-reg-ja="${CSS.escape(nextState.groupId)}"]`,
      );
      if (targetInput) {
        targetInput.focus();
        targetInput.select();
      }
    });
  }

  function getPlainOffsetInContainer(containerEl, boundaryNode, boundaryOffset) {
    if (!containerEl || !containerEl.contains(boundaryNode)) return null;
    let offset = 0;
    let done = false;
    function walk(node) {
      if (done) return;
      if (node === boundaryNode) {
        if (node.nodeType === Node.TEXT_NODE) {
          offset += Math.min(boundaryOffset, node.textContent.length);
          done = true;
          return;
        }
        const children = node.childNodes;
        const limit = Math.min(boundaryOffset, children.length);
        for (let i = 0; i < limit; i += 1) {
          offset += children[i].textContent.length;
        }
        done = true;
        return;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        offset += node.textContent.length;
      } else {
        for (const child of node.childNodes) {
          walk(child);
          if (done) return;
        }
      }
    }
    walk(containerEl);
    return offset;
  }

  function getSelectionOffsetsInSentence(sentenceTextEl) {
    if (!sentenceTextEl) return null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (typeof range.intersectsNode === 'function' && !range.intersectsNode(sentenceTextEl)) {
      return null;
    }

    const totalLen = sentenceTextEl.textContent.length;
    if (totalLen === 0) return null;

    let start = getPlainOffsetInContainer(sentenceTextEl, range.startContainer, range.startOffset);
    let end = getPlainOffsetInContainer(sentenceTextEl, range.endContainer, range.endOffset);

    if (start === null) {
      const containerRange = document.createRange();
      containerRange.selectNodeContents(sentenceTextEl);
      if (range.compareBoundaryPoints(Range.START_TO_START, containerRange) <= 0) {
        start = 0;
      } else {
        return null;
      }
    }
    if (end === null) {
      const containerRange = document.createRange();
      containerRange.selectNodeContents(sentenceTextEl);
      if (range.compareBoundaryPoints(Range.END_TO_END, containerRange) >= 0) {
        end = totalLen;
      } else {
        return null;
      }
    }

    if (end <= start) return null;
    const text = sentenceTextEl.textContent.slice(start, end);
    if (!text.trim()) return null;
    return { start, end, text };
  }

  function clearBrowserSelection() {
    const sel = window.getSelection();
    if (sel && typeof sel.removeAllRanges === 'function') {
      sel.removeAllRanges();
    }
  }

  function getSelectedTextInsideCell(cellEl, clickedSentenceEl) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      const text = sel.toString().trim();
      if (text && sel.anchorNode && cellEl.contains(sel.anchorNode)) {
        return { text, fromSelection: true };
      }
    }
    if (clickedSentenceEl) {
      const txtNode = clickedSentenceEl.querySelector('.sentence-text');
      const sentenceText = txtNode ? txtNode.textContent.trim() : '';
      if (sentenceText) return { text: sentenceText, fromSelection: false };
    }
    return { text: '', fromSelection: false };
  }

  function handleCellContextMenu(e, block, group, lang, enPlain, jaPlain) {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') {
      return;
    }
    e.preventDefault();
    closeContextMenu();

    const cellEl = e.currentTarget;
    const sentenceItemEl = e.target.closest?.('.sentence-item');
    const sentenceId = sentenceItemEl?.dataset?.sentenceId || null;
    const sentenceList = lang === 'en' ? block.enSentences : block.jaSentences;
    const sentenceObj = sentenceId ? sentenceList.find((s) => s.id === sentenceId) || null : null;
    const sentenceTextEl = sentenceItemEl?.querySelector?.('.sentence-text') || null;
    const selRange = getSelectionOffsetsInSentence(sentenceTextEl);

    const picked = getSelectedTextInsideCell(cellEl, sentenceItemEl);
    const jaSuggestions = extractJapaneseCandidateTerms(jaPlain).slice(0, 6);
    const rememberedForGroup =
      rememberedJaSelection && rememberedJaSelection.groupId === group.id
        ? rememberedJaSelection.text
        : '';

    const items = [];
    const headerLabel = selRange
      ? `${lang === 'en' ? '選択英文' : '選択和文'}: 「${truncateLabel(selRange.text, 30)}」`
      : lang === 'en'
        ? `${picked.fromSelection ? '選択英文' : '対象英文'}: 「${truncateLabel(picked.text || enPlain, 30)}」`
        : `${picked.fromSelection ? '選択和文' : '対象和文'}: 「${truncateLabel(picked.text || jaPlain, 30)}」`;

    items.push(
      el('div', {
        className: 'context-menu-header',
        textContent: headerLabel,
      }),
    );

    if (sentenceObj && selRange) {
      items.push(
        el('button', {
          type: 'button',
          className: 'context-menu-item is-primary',
          textContent: '選択範囲をマーカ（確認済の目印） [H]',
          onClick: () => {
            closeContextMenu();
            clearBrowserSelection();
            store.addSentenceMarker(
              block.id,
              lang,
              sentenceObj.id,
              selRange.start,
              selRange.end,
              '選択範囲にマーカを付けました',
            );
          },
        }),
      );
      items.push(
        el('button', {
          type: 'button',
          className: 'context-menu-item',
          textContent: '文頭〜選択末尾までをマーカ [Shift+H]',
          onClick: () => {
            closeContextMenu();
            clearBrowserSelection();
            store.addSentenceMarker(
              block.id,
              lang,
              sentenceObj.id,
              0,
              selRange.end,
              '文頭〜選択位置までマーカを付けました',
            );
          },
        }),
      );
      if (hasMarkerOverlap(sentenceObj.markers, selRange.start, selRange.end)) {
        items.push(
          el('button', {
            type: 'button',
            className: 'context-menu-item',
            textContent: '選択範囲のマーカを解除',
            onClick: () => {
              closeContextMenu();
              clearBrowserSelection();
              store.removeSentenceMarker(
                block.id,
                lang,
                sentenceObj.id,
                selRange.start,
                selRange.end,
              );
            },
          }),
        );
      }
    }

    if (sentenceObj && (sentenceObj.markers || []).length > 0) {
      items.push(
        el('button', {
          type: 'button',
          className: 'context-menu-item',
          textContent: 'この文のマーカをすべて解除',
          onClick: () => {
            closeContextMenu();
            clearBrowserSelection();
            store.clearSentenceMarkers(block.id, lang, sentenceObj.id);
          },
        }),
      );
    }

    if (sentenceObj && (selRange || (sentenceObj.markers || []).length > 0)) {
      items.push(el('div', { className: 'context-menu-divider', role: 'separator' }));
    }

    items.push(
      el('button', {
        type: 'button',
        className: 'context-menu-item',
        textContent: group.tempNoOmission
          ? '✓ 訳漏れなし（一時記録）を解除'
          : '✓ 一時記録：この枠は訳漏れなし',
        onClick: () => {
          closeContextMenu();
          store.toggleGroupTempNoOmission(block.id, group.id);
        },
      }),
    );

    items.push(el('div', { className: 'context-menu-divider', role: 'separator' }));

    if (lang === 'en') {
      const targetEn = picked.text || enPlain;
      if (targetEn) {
        const targetJa = rememberedForGroup || jaPlain;
        const jaPreview = targetJa ? `「${truncateLabel(targetJa, 22)}」` : '（和文なし）';

        items.push(
          el('button', {
            type: 'button',
            className: `context-menu-item${!selRange ? ' is-primary' : ''}`,
            disabled: !targetJa,
            textContent: `翻訳メモリ (TM) に即登録 ⇔ ${jaPreview}`,
            onClick: async () => {
              closeContextMenu();
              await store.saveCustomTmPair({
                enPlain: targetEn,
                jaPlain: targetJa,
                groupId: group.id,
              });
            },
          }),
        );
        items.push(
          el('button', {
            type: 'button',
            className: 'context-menu-item',
            textContent: '対訳を調整して翻訳メモリ (TM) に登録…',
            onClick: () => {
              closeContextMenu();
              openQuickRegister({
                mode: 'tm',
                blockId: block.id,
                groupId: group.id,
                enText: targetEn,
                jaText: targetJa,
                jaSuggestions,
              });
            },
          }),
        );
        items.push(
          el('button', {
            type: 'button',
            className: 'context-menu-item',
            textContent: '用語集に即登録（和文候補を選択）…',
            onClick: () => {
              closeContextMenu();
              openQuickRegister({
                mode: 'glossary',
                blockId: block.id,
                groupId: group.id,
                enText: targetEn,
                jaText: rememberedForGroup || jaSuggestions[0] || '',
                jaSuggestions,
              });
            },
          }),
        );
        items.push(
          el('button', {
            type: 'button',
            className: 'context-menu-item',
            disabled: !enPlain || !jaPlain,
            textContent: 'この対訳枠を「確認済」にしてTM登録',
            onClick: () => {
              closeContextMenu();
              store.setGroupStatus(block.id, group.id, 'verified');
            },
          }),
        );
      }
    } else {
      const targetJa = picked.text || jaPlain;
      if (targetJa) {
        items.push(
          el('button', {
            type: 'button',
            className: `context-menu-item${!selRange ? ' is-primary' : ''}`,
            textContent: 'この和文を対訳ペア用に記憶（次に英文側で右クリック）',
            onClick: () => {
              closeContextMenu();
              rememberedJaSelection = { groupId: group.id, text: targetJa };
              store.showToast(`和文を記憶しました: 「${truncateLabel(targetJa, 24)}」`);
            },
          }),
        );
        items.push(
          el('button', {
            type: 'button',
            className: 'context-menu-item',
            disabled: !enPlain,
            textContent: 'この枠の英文 ⇔ 選択和文をTMに即登録',
            onClick: async () => {
              closeContextMenu();
              await store.saveCustomTmPair({
                enPlain,
                jaPlain: targetJa,
                groupId: group.id,
              });
            },
          }),
        );
        items.push(
          el('button', {
            type: 'button',
            className: 'context-menu-item',
            textContent: '対訳を調整してTM／用語集に登録…',
            onClick: () => {
              closeContextMenu();
              openQuickRegister({
                mode: 'glossary',
                blockId: block.id,
                groupId: group.id,
                enText: enPlain,
                jaText: targetJa,
                jaSuggestions,
              });
            },
          }),
        );
      }
    }

    contextMenuEl.textContent = '';
    for (const item of items) contextMenuEl.appendChild(item);
    contextMenuEl.classList.remove('is-hidden');

    const rect = contextMenuEl.getBoundingClientRect();
    const menuW = rect.width || 320;
    const menuH = rect.height || 280;
    const left = Math.max(8, Math.min(e.clientX, window.innerWidth - menuW - 12));
    const top = Math.max(8, Math.min(e.clientY, window.innerHeight - menuH - 12));
    contextMenuEl.style.left = `${left}px`;
    contextMenuEl.style.top = `${top}px`;
  }

  function getFlatFilteredGroups() {
    const out = [];
    for (const blk of lastFilteredBlocks) {
      for (const grp of blk.groups) {
        out.push({ blockId: blk.id, groupId: grp.id, group: grp, block: blk });
      }
    }
    return out;
  }

  function scrollToBlockOrGroup(blockId, groupId = null) {
    const idx = lastFilteredBlocks.findIndex((b) => b.id === blockId);
    if (idx === -1) return;

    if (lastFilteredBlocks.length > VIRTUAL_THRESHOLD) {
      let y = 0;
      for (let i = 0; i < idx; i += 1) {
        y += blockHeights.get(lastFilteredBlocks[i].id) || DEFAULT_BLOCK_HEIGHT;
      }
      blocksViewport.scrollTop = Math.max(0, y - 24);
      renderVisibleWindow(true);
    }

    requestAnimationFrame(() => {
      const selector = groupId
        ? `[data-group-id="${CSS.escape(groupId)}"]`
        : `[data-block-id="${CSS.escape(blockId)}"]`;
      const target = blocksList.querySelector(selector);
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
  }

  function jumpToLastFocused() {
    const proj = store.getActiveProject();
    if (!proj) return;
    const targetId = proj.lastFocusedGroupId || store.state.selectedGroupId;
    if (!targetId) return;
    for (const blk of proj.blocks) {
      if (blk.groups.some((g) => g.id === targetId)) {
        if (!blockMatchesFilter(blk, store.state.filterStatus, store.state.searchQuery)) {
          store.setFilterStatus('all');
          store.setSearchQuery('');
        }
        store.selectGroup(targetId);
        scrollToBlockOrGroup(blk.id, targetId);
        return;
      }
    }
  }

  function jumpToNextAttentionGroup() {
    const proj = store.getActiveProject();
    if (!proj) return;
    const candidates = [];
    const dupIdx = currentDupJaIndex || buildDuplicateJaIndex(proj.blocks);
    const dismissedHints = proj.dismissedHints || {};
    for (const blk of proj.blocks) {
      const blkWarn = (blk.warnings || []).length > 0;
      const enMap = new Map(blk.enSentences.map((s) => [s.id, s]));
      const jaMap = new Map(blk.jaSentences.map((s) => [s.id, s]));
      for (const g of blk.groups) {
        const enPlain = g.enIds.map((id) => enMap.get(id)?.plainText || '').join(' ');
        const jaPlain = g.jaIds.map((id) => jaMap.get(id)?.plainText || '').join(' ');
        const hasGlossaryIssue =
          store.state.glossary.length > 0 &&
          checkGroupGlossary(enPlain, jaPlain, store.state.glossary, store.state.jaNormOptions)
            .hasIssues;
        const hasHintIssue = detectGroupHints(g, blk, {
          duplicateJaIndex: dupIdx,
          dismissedHints,
        }).hasActiveHints;
        if (
          blkWarn ||
          hasGlossaryIssue ||
          hasHintIssue ||
          g.status === 'needs_review' ||
          g.status === 'source_changed' ||
          !g.confirmedAlignment
        ) {
          candidates.push({ blockId: blk.id, groupId: g.id });
        }
      }
    }
    if (candidates.length === 0) {
      store.showToast('現在、対応が必要な警告・要確認グループはありません');
      return;
    }
    const currIdx = candidates.findIndex((c) => c.groupId === store.state.selectedGroupId);
    const next = candidates[(currIdx + 1) % candidates.length];
    if (store.state.filterStatus !== 'all' && store.state.filterStatus !== 'warnings') {
      store.setFilterStatus('all');
    }
    store.selectGroup(next.groupId);
    scrollToBlockOrGroup(next.blockId, next.groupId);
  }

  function stepSelectedGroup(delta) {
    const flat = getFlatFilteredGroups();
    if (flat.length === 0) return;
    const currIdx = flat.findIndex((item) => item.groupId === store.state.selectedGroupId);
    const nextIdx =
      currIdx === -1
        ? 0
        : Math.max(0, Math.min(flat.length - 1, currIdx + delta));
    const target = flat[nextIdx];
    store.selectGroup(target.groupId);
    scrollToBlockOrGroup(target.blockId, target.groupId);
  }

  function renderSentenceNode(block, group, groupIdx, lang, sentence, listIdx, totalInLang) {
    const isSplitting =
      store.state.activeSplitTarget &&
      store.state.activeSplitTarget.blockId === block.id &&
      store.state.activeSplitTarget.lang === lang &&
      store.state.activeSplitTarget.sentenceId === sentence.id;

    const itemEl = el('div', {
      className: 'sentence-item',
      dataset: { sentenceId: sentence.id, lang },
    });

    const handle = el('span', {
      className: 'drag-handle',
      draggable: 'true',
      title: 'ドラッグして別グループへ移動',
      textContent: '⋮⋮',
      onDragstart: (e) => {
        dragPayload = { blockId: block.id, lang, sentenceId: sentence.id };
        itemEl.classList.add('is-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', sentence.id);
        }
      },
      onDragend: () => {
        dragPayload = null;
        itemEl.classList.remove('is-dragging');
      },
    });

    const idBadge = el('span', {
      className: 'sentence-id tabular-nums',
      textContent: `${lang.toUpperCase()}-${listIdx + 1}`,
    });

    const textEl = el('p', { className: 'sentence-text' });
    textEl.appendChild(renderRichSentenceFragment(sentence.rawText, sentence.markers));

    itemEl.appendChild(el('div', { className: 'sentence-top-row' }, [handle, idBadge, textEl]));

    if (isSplitting) {
      const maxOffset = Math.max(1, sentence.rawText.length - 1);
      const offset = Math.max(1, Math.min(maxOffset, store.state.activeSplitTarget.offset));
      const leftText = sentence.rawText.slice(0, offset);
      const rightText = sentence.rawText.slice(offset);

      const leftPreview = el('div', { className: 'split-preview-part' }, [
        el('span', { className: 'split-preview-label', textContent: '前半' }),
        document.createTextNode(leftText),
      ]);
      const rightPreview = el('div', { className: 'split-preview-part' }, [
        el('span', { className: 'split-preview-label', textContent: '後半' }),
        document.createTextNode(rightText),
      ]);

      const slider = el('input', {
        type: 'range',
        className: 'split-range-input',
        min: 1,
        max: maxOffset,
        value: offset,
        'aria-label': '文分割位置',
        onInput: (e) => {
          const val = Number(e.target.value);
          store.state.activeSplitTarget.offset = val;
          leftPreview.lastChild.textContent = sentence.rawText.slice(0, val);
          rightPreview.lastChild.textContent = sentence.rawText.slice(val);
        },
      });

      const splitEditor = el('div', { className: 'split-editor' }, [
        el('div', {
          className: 'split-editor-hint',
          textContent: 'スライダーで分割位置を指定して「この位置で分割」を押してください。',
        }),
        slider,
        el('div', { className: 'split-preview-box' }, [leftPreview, rightPreview]),
        el('div', { className: 'toolbar-group' }, [
          el('button', {
            type: 'button',
            className: 'btn btn-primary btn-xs',
            textContent: 'この位置で分割',
            onClick: () => store.confirmSplitSentence(),
          }),
          el('button', {
            type: 'button',
            className: 'btn btn-xs',
            textContent: 'キャンセル',
            onClick: () => store.cancelSplitSentence(),
          }),
        ]),
      ]);
      itemEl.appendChild(splitEditor);
    }

    const markerPct = computeMarkerCoveragePercent(sentence.markers, sentence.plainText.length);
    const actions = el('div', { className: 'sentence-actions' }, [
      el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-xs',
        textContent: '文を分割',
        title: '1つの文を途中の位置で2文に分けます（英語1文が日本語2文に訳されている場合や、コロン等で分けたいとき）',
        disabled: sentence.rawText.length < 4,
        onClick: () =>
          store.startSplitSentence(block.id, lang, sentence.id, sentence.rawText.length),
      }),
      el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-xs',
        textContent: '次文と結合↓',
        title: 'この文と直後の文をつなげて1文にします（略語や小数点などで誤って途中で文が切れたとき）',
        disabled: listIdx + 1 >= totalInLang,
        onClick: () => store.mergeSentenceWithNext(block.id, lang, sentence.id),
      }),
      el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-xs',
        textContent: '↑上のペアへ',
        title: 'この文を1つ上の対訳枠へ移動してまとめます（例：英語1文⇔日本語2文、英語2文⇔日本語1文にしたいとき）',
        disabled: groupIdx === 0,
        onClick: () =>
          store.moveSentence(block.id, lang, sentence.id, block.groups[groupIdx - 1].id),
      }),
      el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-xs',
        textContent: '↓下のペアへ',
        title: 'この文を1つ下の対訳枠へ送り出します（同じ枠にまとめすぎた文を次の枠へ移したいとき）',
        disabled: groupIdx + 1 >= block.groups.length,
        onClick: () =>
          store.moveSentence(block.id, lang, sentence.id, block.groups[groupIdx + 1].id),
      }),
      el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-xs',
        textContent: '対応なし枠へ',
        title: '同じ枠内の相手と切り離し、この文だけの独立した枠（対応なし）を作ります（意図的な補足・省略があるとき）',
        disabled: group.enIds.length + group.jaIds.length <= 1,
        onClick: () => store.moveSentence(block.id, lang, sentence.id, '__NEW__'),
      }),
      markerPct > 0
        ? el('button', {
            type: 'button',
            className: 'btn btn-xs marker-clear-chip',
            textContent: `マーカ済 ${markerPct}% ×`,
            title: 'クリックすると、この文に付けたマーカをすべて解除します',
            onClick: () => store.clearSentenceMarkers(block.id, lang, sentence.id),
          })
        : null,
    ]);
    itemEl.appendChild(actions);
    return itemEl;
  }

  function renderBlockSection(block, allBlocksCount) {
    const warnings = block.warnings || [];
    const hasStructural = warnings.some((w) =>
      ['CONSECUTIVE_EN', 'CONSECUTIVE_JA', 'TRAILING_EN', 'LEADING_JA', 'AMBIGUOUS_LANG'].includes(w),
    );
    const hasMismatch = warnings.includes('UNMATCHED_COUNT');

    const sectionClasses = ['block-section'];
    if (hasMismatch) sectionClasses.push('has-mismatch');
    else if (hasStructural) sectionClasses.push('has-warning');

    const section = el('section', {
      className: sectionClasses.join(' '),
      dataset: { blockId: block.id },
    });

    const verifiedInBlock = block.groups.filter((g) => g.status === 'verified').length;

    const headerInfo = el('div', { className: 'block-header-info' }, [
      el('span', {
        className: 'block-number tabular-nums',
        textContent: `ブロック #${String(block.index + 1).padStart(2, '0')}`,
      }),
      el('span', { className: 'meta-sep', textContent: '·' }),
      el('span', {
        className: 'tabular-nums',
        textContent: `英 ${block.enSentences.length}文 / 和 ${block.jaSentences.length}文`,
      }),
      el('span', { className: 'meta-sep', textContent: '·' }),
      el('span', {
        className: 'tabular-nums',
        textContent: `確認済 ${verifiedInBlock}/${block.groups.length}`,
      }),
      hasMismatch
        ? el('span', { className: 'status-label-text status-needs_review', textContent: '⚠ 文数不一致' })
        : null,
    ]);

    const blockActions = el('div', { className: 'block-structural-actions' }, [
      el('button', {
        type: 'button',
        className: 'btn btn-xs',
        textContent: block.jaRaw ? '和文を編集' : '和文を入力',
        title: 'このブロックの日本語訳をまとめて入力・差し替えして文分割します',
        onClick: () => store.toggleBlockJaEditor(block.id),
      }),
      block.enSentences.length !== block.jaSentences.length && block.jaSentences.length > 0
        ? el('button', {
            type: 'button',
            className: 'btn btn-xs',
            textContent: 'ヒントで自動整列',
            onClick: () => store.realignBlock(block.id, true),
          })
        : null,
      el('button', {
        type: 'button',
        className: 'btn btn-xs',
        textContent: '英日入替',
        onClick: () => store.swapBlockLanguages(block.id),
      }),
      block.index + 1 < allBlocksCount
        ? el('button', {
            type: 'button',
            className: 'btn btn-xs',
            textContent: '次ブロックと結合',
            onClick: () => store.mergeBlockWithFollowing(block.index),
          })
        : null,
      el('button', {
        type: 'button',
        className: 'btn btn-xs',
        textContent: 'すべて確認済',
        onClick: () => store.setBlockAllStatus(block.id, 'verified'),
      }),
    ]);

    section.appendChild(el('header', { className: 'block-header' }, [headerInfo, blockActions]));

    const structuralMessages = warnings
      .filter((w) => w !== 'UNCONFIRMED_GROUP')
      .map((w) => WARNING_LABELS[w] || w);

    if (structuralMessages.length > 0) {
      section.appendChild(
        el('div', { className: 'block-warning-strip' }, [
          el('span', { textContent: `注意: ${structuralMessages.join(' / ')}` }),
        ]),
      );
    }

    const showJaEditor = !block.jaRaw.trim() || store.state.editingJaBlockIds.has(block.id);
    if (showJaEditor) {
      const jaInput = el('textarea', {
        className: 'ja-block-textarea',
        value: block.jaRaw || '',
        placeholder: 'この英語段落に対応する日本語訳を入力・貼り付けしてください（Ctrl+Enter で反映・文分割）...',
        'aria-label': `ブロック #${block.index + 1} の日本語訳入力`,
        onKeydown: (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            store.updateBlockJapanese(block.id, jaInput.value);
          }
        },
      });
      section.appendChild(
        el('div', { className: 'ja-block-editor' }, [
          el('div', { className: 'ja-block-editor-header' }, [
            el('span', {
              textContent: block.jaRaw.trim()
                ? 'このブロックの日本語段落を編集'
                : '日本語訳が未入力です（英語に対応する日本語段落を都度入力できます）',
            }),
          ]),
          jaInput,
          el('div', { className: 'toolbar-group' }, [
            el('button', {
              type: 'button',
              className: 'btn btn-primary btn-xs',
              textContent: '日本語を反映・文分割',
              onClick: () => store.updateBlockJapanese(block.id, jaInput.value),
            }),
            block.jaRaw.trim()
              ? el('button', {
                  type: 'button',
                  className: 'btn btn-xs',
                  textContent: '閉じる',
                  onClick: () => store.toggleBlockJaEditor(block.id, false),
                })
              : null,
          ]),
        ]),
      );
    }

    const enMap = new Map(block.enSentences.map((s, idx) => [s.id, { item: s, idx }]));
    const jaMap = new Map(block.jaSentences.map((s, idx) => [s.id, { item: s, idx }]));
    const groupsContainer = el('div', { className: 'groups-container' });

    block.groups.forEach((group, groupIdx) => {
      const isSelected = store.state.selectedGroupId === group.id;
      const groupEl = el('div', {
        className: `alignment-group${isSelected ? ' is-selected' : ''}`,
        dataset: { groupId: group.id },
        onClick: () => {
          if (store.state.selectedGroupId !== group.id) {
            store.selectGroup(group.id);
          }
        },
      });

      const colsClass =
        store.state.layoutMode === 'stacked'
          ? 'alignment-columns layout-stacked'
          : 'alignment-columns';

      const makeDropHandlers = (lang) => ({
        onDragover: (e) => {
          if (dragPayload && dragPayload.blockId === block.id && dragPayload.lang === lang) {
            e.preventDefault();
            e.currentTarget.classList.add('is-drop-target');
          }
        },
        onDragleave: (e) => {
          e.currentTarget.classList.remove('is-drop-target');
        },
        onDrop: (e) => {
          e.preventDefault();
          e.currentTarget.classList.remove('is-drop-target');
          if (dragPayload && dragPayload.blockId === block.id && dragPayload.lang === lang) {
            store.moveSentence(block.id, lang, dragPayload.sentenceId, group.id);
            dragPayload = null;
          }
        },
      });

      const enItems = group.enIds.map((id) => enMap.get(id)?.item).filter(Boolean);
      const jaItems = group.jaIds.map((id) => jaMap.get(id)?.item).filter(Boolean);
      const enPlain = enItems.map((s) => s.plainText).join(' ');
      const jaPlain = jaItems.map((s) => s.plainText).join(' ');

      const renderUnmatchedCellEditor = (lang) => {
        const draftKey = `${group.id}:${lang}`;
        const draftVal = unmatchedDrafts.get(draftKey) || '';
        const commitText = () => {
          const val = textarea.value.trim();
          if (!val) {
            store.showToast('テキストを入力またはペーストしてください', true);
            return;
          }
          unmatchedDrafts.delete(draftKey);
          store.insertGroupSentenceText(block.id, group.id, lang, val);
        };
        const textarea = el('textarea', {
          className: 'unmatched-textarea',
          value: draftVal,
          dataset: { unmatchedInputKey: draftKey },
          placeholder:
            lang === 'ja'
              ? '対応する日本語文をここに入力・ペースト（Ctrl+Enter または「反映」で確定 / 他枠からドロップも可）'
              : '対応する英文をここに入力・ペースト（Ctrl+Enter または「反映」で確定 / 他枠からドロップも可）',
          'aria-label': lang === 'ja' ? '日本語訳を直接入力' : '英文を直接入力',
          onInput: (e) => {
            unmatchedDrafts.set(draftKey, e.target.value);
          },
          onKeydown: (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              commitText();
            }
          },
        });
        return el('div', { className: 'unmatched-editor' }, [
          textarea,
          el('div', { className: 'unmatched-editor-footer' }, [
            el('span', {
              className: 'meta-sep',
              textContent:
                lang === 'ja'
                  ? '対応なし（コピペ入力可 / ドロップも可）'
                  : '対応なし（コピペ入力可 / ドロップも可）',
            }),
            el('button', {
              type: 'button',
              className: 'btn btn-primary btn-xs',
              textContent: '反映 (Ctrl+Enter)',
              onClick: commitText,
            }),
          ]),
        ]);
      };

      const enCell = el('div', {
        className: 'lang-cell lang-cell-en',
        ...makeDropHandlers('en'),
        onContextmenu: (e) => handleCellContextMenu(e, block, group, 'en', enPlain, jaPlain),
      });
      if (group.enIds.length === 0) {
        enCell.appendChild(renderUnmatchedCellEditor('en'));
      } else {
        for (const eid of group.enIds) {
          const entry = enMap.get(eid);
          if (entry) {
            enCell.appendChild(
              renderSentenceNode(
                block,
                group,
                groupIdx,
                'en',
                entry.item,
                entry.idx,
                block.enSentences.length,
              ),
            );
          }
        }
      }

      const jaCell = el('div', {
        className: 'lang-cell lang-cell-ja',
        ...makeDropHandlers('ja'),
        onContextmenu: (e) => handleCellContextMenu(e, block, group, 'ja', enPlain, jaPlain),
      });
      if (group.jaIds.length === 0) {
        jaCell.appendChild(renderUnmatchedCellEditor('ja'));
      } else {
        for (const jid of group.jaIds) {
          const entry = jaMap.get(jid);
          if (entry) {
            jaCell.appendChild(
              renderSentenceNode(
                block,
                group,
                groupIdx,
                'ja',
                entry.item,
                entry.idx,
                block.jaSentences.length,
              ),
            );
          }
        }
      }

      groupEl.appendChild(el('div', { className: colsClass }, [enCell, jaCell]));

      if (quickRegisterState && quickRegisterState.groupId === group.id) {
        const qState = quickRegisterState;
        const enQuickInput = el('input', {
          type: 'text',
          className: 'text-input',
          value: qState.enText,
          'aria-label': '登録する英語語句・文',
          onInput: (ev) => {
            qState.enText = ev.target.value;
          },
        });
        const jaQuickInput = el('input', {
          type: 'text',
          className: 'text-input',
          value: qState.jaText,
          dataset: { quickRegJa: group.id },
          placeholder: '対応する日本語訳を入力または下の候補をクリック...',
          'aria-label': '登録する日本語訳',
          onInput: (ev) => {
            qState.jaText = ev.target.value;
          },
        });

        const submitQuick = async () => {
          const enVal = enQuickInput.value.trim();
          const jaVal = jaQuickInput.value.trim();
          if (!enVal || !jaVal) {
            store.showToast('英語と日本語の両方を入力してください', true);
            return;
          }
          if (qState.mode === 'tm') {
            const ok = await store.saveCustomTmPair({
              enPlain: enVal,
              jaPlain: jaVal,
              groupId: group.id,
            });
            if (ok) quickRegisterState = null;
          } else {
            await store.saveGlossaryItem({
              enHeadword: enVal,
              enVariants: [],
              jaAccepted: jaVal.split(/[|;；、,]/).map((s) => s.trim()).filter(Boolean),
              jaDeprecated: [],
              caseSensitive: /^[A-Z0-9-]+$/.test(enVal),
              notes: '本文の右クリックメニューから登録',
            });
            quickRegisterState = null;
          }
          renderVisibleWindow(true);
        };

        const onQuickKey = (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            submitQuick();
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            quickRegisterState = null;
            renderVisibleWindow(true);
          }
        };
        enQuickInput.addEventListener('keydown', onQuickKey);
        jaQuickInput.addEventListener('keydown', onQuickKey);

        const modeBar = el('div', { className: 'segmented-control' }, [
          el('button', {
            type: 'button',
            className: `segmented-btn${qState.mode === 'tm' ? ' is-active' : ''}`,
            textContent: '翻訳メモリ (TM) に登録',
            onClick: () => {
              qState.mode = 'tm';
              renderVisibleWindow(true);
            },
          }),
          el('button', {
            type: 'button',
            className: `segmented-btn${qState.mode === 'glossary' ? ' is-active' : ''}`,
            textContent: '用語集に登録',
            onClick: () => {
              qState.mode = 'glossary';
              renderVisibleWindow(true);
            },
          }),
        ]);

        const chipsRow =
          qState.jaSuggestions && qState.jaSuggestions.length > 0
            ? el('div', { className: 'toolbar-group' }, [
                el('span', { className: 'meta-sep', textContent: 'この枠の和文候補:' }),
                ...qState.jaSuggestions.map((cand) =>
                  el('button', {
                    type: 'button',
                    className: 'btn btn-xs candidate-chip-btn',
                    textContent: cand,
                    onClick: () => {
                      qState.jaText = cand;
                      jaQuickInput.value = cand;
                      jaQuickInput.focus();
                    },
                  }),
                ),
              ])
            : null;

        groupEl.appendChild(
          el('div', { className: 'quick-register-bar' }, [
            el('div', { className: 'ja-block-editor-header' }, [
              modeBar,
              el('button', {
                type: 'button',
                className: 'btn btn-xs',
                textContent: '閉じる',
                onClick: () => {
                  quickRegisterState = null;
                  renderVisibleWindow(true);
                },
              }),
            ]),
            el('div', { className: 'glossary-form-grid' }, [
              el('div', { className: 'form-field' }, [
                el('label', { className: 'form-label', textContent: '英語（EN）' }),
                enQuickInput,
              ]),
              el('div', { className: 'form-field' }, [
                el('label', { className: 'form-label', textContent: '日本語（JA）' }),
                jaQuickInput,
              ]),
            ]),
            chipsRow,
            el('div', { className: 'toolbar-group' }, [
              el('button', {
                type: 'button',
                className: 'btn btn-primary btn-xs',
                textContent: qState.mode === 'tm' ? '翻訳メモリに登録 (Enter)' : '用語集に登録 (Enter)',
                onClick: submitQuick,
              }),
            ]),
          ]),
        );
      }

      // Group Footer: Status, Memo toggle, Deterministic Hints
      const statusMeta = STATUS_META[group.status] || STATUS_META.unread;
      const statusSelect = el(
        'select',
        {
          className: 'status-select',
          'aria-label': 'グループの確認状態',
          onChange: (e) => store.setGroupStatus(block.id, group.id, e.target.value),
        },
        Object.entries(STATUS_META).map(([value, meta]) =>
          el('option', {
            value,
            selected: group.status === value,
            textContent: `${meta.icon} ${meta.label}`,
          }),
        ),
      );

      const glossaryCheck = checkGroupGlossary(
        enPlain,
        jaPlain,
        store.state.glossary,
        store.state.jaNormOptions,
      );

      if (
        glossaryCheck.deprecatedUsed.length > 0 ||
        glossaryCheck.missingAccepted.length > 0 ||
        glossaryCheck.matchedOk.length > 0
      ) {
        const glossaryStrip = el('div', { className: 'glossary-strip' });
        for (const item of glossaryCheck.deprecatedUsed) {
          const rec =
            item.entry.jaAccepted.length > 0
              ? `（許容訳語: ${item.entry.jaAccepted.join(' / ')}）`
              : '';
          glossaryStrip.appendChild(
            el('div', {
              className: 'glossary-warning-line',
              textContent: `⚠ 用語注意（非推奨訳語）: 「${item.foundDeprecated.join(', ')}」が使用されています ${rec}`,
            }),
          );
        }
        for (const item of glossaryCheck.missingAccepted) {
          glossaryStrip.appendChild(
            el('div', {
              className: 'glossary-warning-line',
              textContent: `⚠ 用語不統一: 英語「${item.enHits.join(', ')}」に対応する許容訳語（${item.entry.jaAccepted.join(' / ')}）が和文に見当たりません`,
            }),
          );
        }
        if (glossaryCheck.matchedOk.length > 0) {
          const okSummary = glossaryCheck.matchedOk
            .map((m) => `${m.entry.enHeadword} ⇔ ${m.matchedAccepted.join('/') || '登録済'}`)
            .join(' · ');
          glossaryStrip.appendChild(
            el('div', {
              className: 'glossary-ok-line',
              textContent: `✓ 用語一致: ${okSummary}`,
            }),
          );
        }
        groupEl.appendChild(glossaryStrip);
      }

      const dismissedHints = store.getActiveProject()?.dismissedHints || {};
      const hintCheck = detectGroupHints(group, block, {
        duplicateJaIndex: currentDupJaIndex,
        dismissedHints,
      });

      if (hintCheck.activeHints.length > 0 || hintCheck.dismissedList.length > 0) {
        const hintsStrip = el('div', { className: 'hints-strip' });
        for (const h of hintCheck.activeHints) {
          hintsStrip.appendChild(
            el('div', { className: 'hint-item-row' }, [
              el('div', { className: 'hint-item-text' }, [
                el('span', {
                  className: h.severity === 'warning' ? 'hint-badge-warn' : 'hint-badge-info',
                  textContent: `${h.severity === 'warning' ? '⚠' : 'ℹ'} ${h.title}:`,
                }),
                el('span', { textContent: ` ${h.detail}` }),
              ]),
              el('button', {
                type: 'button',
                className: 'btn btn-xs',
                textContent: '許容・非表示',
                title: 'このヒントを確認済みとして非表示にします（後で復元できます）',
                onClick: () => store.dismissHint(h.id),
              }),
            ]),
          );
        }
        if (hintCheck.dismissedList.length > 0) {
          hintsStrip.appendChild(
            el('div', { className: 'hint-dismissed-row' }, [
              el('span', {
                className: 'meta-sep',
                textContent: `非表示済みのヒント: ${hintCheck.dismissedList.length}件`,
              }),
              el('button', {
                type: 'button',
                className: 'btn btn-ghost btn-xs',
                textContent: '元に戻す',
                onClick: () =>
                  store.restoreHints(hintCheck.dismissedList.map((d) => d.id)),
              }),
            ]),
          );
        }
        groupEl.appendChild(hintsStrip);
      }

      if (enPlain.trim() && store.state.tmRecords.length > 0) {
        const tmMatches = findTmMatches(enPlain, store.state.tmRecords, {
          threshold: 0.48,
          maxResults: 2,
          excludeGroupId: group.id,
          currentJaPlain: jaPlain,
        });
        if (tmMatches.length > 0) {
          const tmStrip = el('div', { className: 'tm-strip' });
          for (const m of tmMatches) {
            const pct = Math.round(m.similarity * 100);
            tmStrip.appendChild(
              el('div', {
                className: m.hasDiscrepancy ? 'tm-warning-line' : 'tm-match-line',
              }, [
                el('strong', {
                  textContent: m.hasDiscrepancy
                    ? `⚠ 翻訳メモリ過去訳と差異あり（類似度 ${pct}%）: `
                    : `TM類似訳（${pct}%）: `,
                }),
                el('span', {
                  textContent: `「${m.record.jaPlain}」`,
                }),
                el('span', {
                  className: 'meta-sep',
                  textContent: ` — EN: ${m.record.enPlain}`,
                }),
              ]),
            );
          }
          groupEl.appendChild(tmStrip);
        }
      }

      const hints = computeGroupHints(enItems, jaItems);
      const hintParts = [];
      if (hints.sharedNumbers.length > 0) {
        hintParts.push(`一致数値: ${hints.sharedNumbers.slice(0, 4).join(', ')}`);
      }
      if (hints.sharedLatin.length > 0) {
        hintParts.push(`一致英字: ${hints.sharedLatin.slice(0, 4).join(', ')}`);
      }
      if (enItems.length > 0 && jaItems.length > 0) {
        hintParts.push(`文長バランス: ${hints.lengthBalance}`);
      }

      const memoOpen =
        store.state.openMemoGroupIds.has(group.id) ||
        Boolean(group.memo && group.memo.trim()) ||
        Boolean(group.previousMemoNote);

      const footer = el('div', { className: 'group-footer' }, [
        el('div', { className: 'group-status-controls' }, [
          el('span', {
            className: `status-label-text ${statusMeta.className}`,
            textContent: `${statusMeta.icon} ${statusMeta.label}`,
          }),
          statusSelect,
          el('button', {
            type: 'button',
            className: 'btn btn-xs',
            textContent: '確認済にする',
            onClick: () => store.setGroupStatus(block.id, group.id, 'verified'),
          }),
          el('button', {
            type: 'button',
            className: `btn btn-xs${group.tempNoOmission ? ' is-temp-checked' : ''}`,
            'aria-pressed': group.tempNoOmission ? 'true' : 'false',
            textContent: group.tempNoOmission ? '✓ 訳漏れなし（一時記録）' : '訳漏れなし(仮)',
            title: '「確認済」にする前の一時チェックとして、この枠に訳漏れがないことを記録します（Tキーでも切替可）',
            onClick: () => store.toggleGroupTempNoOmission(block.id, group.id),
          }),
          el('button', {
            type: 'button',
            className: 'btn btn-xs',
            textContent: memoOpen ? 'メモを隠す' : 'メモを開く',
            onClick: () => store.toggleMemo(group.id),
          }),
        ]),
        el('div', { className: 'group-hints-meta tabular-nums' }, [
          el('span', { textContent: `対応 ${group.enIds.length}:${group.jaIds.length}` }),
          hintParts.length > 0 ? el('span', { className: 'meta-sep', textContent: '·' }) : null,
          hintParts.length > 0 ? el('span', { textContent: hintParts.join(' · ') }) : null,
        ]),
      ]);
      groupEl.appendChild(footer);

      if (memoOpen) {
        const memoWrap = el('div', { className: 'group-memo-inline' });
        if (group.previousMemoNote) {
          memoWrap.appendChild(
            el('div', {
              className: 'memo-readonly-note',
              textContent: group.previousMemoNote,
            }),
          );
        }
        memoWrap.appendChild(
          el('textarea', {
            className: 'memo-textarea',
            placeholder: 'レビューメモ（訳の懸念点、要確認事項など）...',
            value: group.memo || '',
            dataset: { memoGroupId: group.id },
            onInput: (e) => store.setGroupMemo(block.id, group.id, e.target.value),
          }),
        );
        groupEl.appendChild(memoWrap);
      }

      groupsContainer.appendChild(groupEl);
    });

    section.appendChild(groupsContainer);
    return section;
  }

  function renderVisibleWindow(forceRedraw = true) {
    const blocks = lastFilteredBlocks;
    const total = blocks.length;

    if (total === 0) {
      topSpacer.style.height = '0px';
      bottomSpacer.style.height = '0px';
      blocksList.textContent = '';
      const proj = store.getActiveProject();
      blocksList.appendChild(
        el('div', { className: 'empty-state' }, [
          el('h2', {
            textContent: proj
              ? '条件に一致するブロックがありません'
              : '対訳ドキュメントがまだありません',
          }),
          el('p', {
            textContent: proj
              ? '検索キーワードや状態フィルタを変更してください。'
              : '英語段落と日本語段落が交互に並ぶテキストを貼り付けるか、.txt / .md ファイルを読み込んでください。',
          }),
          el('div', { className: 'empty-actions' }, [
            proj
              ? el('button', {
                  type: 'button',
                  className: 'btn btn-primary',
                  textContent: 'フィルタをリセット',
                  onClick: () => {
                    store.setFilterStatus('all');
                    store.setSearchQuery('');
                  },
                })
              : el('button', {
                  type: 'button',
                  className: 'btn btn-primary',
                  textContent: 'テキスト・ファイルを読み込む',
                  onClick: () => store.openModal('import', 'new'),
                }),
            !proj
              ? el('button', {
                  type: 'button',
                  className: 'btn',
                  textContent: 'サンプルを読み込む',
                  onClick: () => onOpenImportSample(),
                })
              : null,
          ]),
        ]),
      );
      lastRenderRange = { start: 0, end: 0 };
      return;
    }

    const allBlocksCount = store.getActiveProject()?.blocks.length || total;

    if (total <= VIRTUAL_THRESHOLD) {
      topSpacer.style.height = '0px';
      bottomSpacer.style.height = '0px';
      blocksList.textContent = '';
      for (const blk of blocks) {
        blocksList.appendChild(renderBlockSection(blk, allBlocksCount));
      }
      lastRenderRange = { start: 0, end: total };
      return;
    }

    // Virtual windowing for large documents
    const viewTop = blocksViewport.scrollTop;
    const viewBottom = viewTop + blocksViewport.clientHeight;
    let accY = 0;
    let startIdx = 0;
    let endIdx = total;
    let topH = 0;
    let bottomH = 0;

    for (let i = 0; i < total; i += 1) {
      const h = blockHeights.get(blocks[i].id) || DEFAULT_BLOCK_HEIGHT;
      if (accY + h < viewTop - OVERSCAN_PX) {
        startIdx = i + 1;
        topH += h;
      } else if (accY > viewBottom + OVERSCAN_PX) {
        endIdx = i;
        break;
      }
      accY += h;
    }

    for (let i = endIdx; i < total; i += 1) {
      bottomH += blockHeights.get(blocks[i].id) || DEFAULT_BLOCK_HEIGHT;
    }

    if (!forceRedraw && startIdx === lastRenderRange.start && endIdx === lastRenderRange.end) {
      return;
    }

    lastRenderRange = { start: startIdx, end: endIdx };
    topSpacer.style.height = `${topH}px`;
    bottomSpacer.style.height = `${bottomH}px`;
    blocksList.textContent = '';

    for (let i = startIdx; i < endIdx; i += 1) {
      const node = renderBlockSection(blocks[i], allBlocksCount);
      blocksList.appendChild(node);
    }

    requestAnimationFrame(() => {
      for (const child of blocksList.children) {
        const bid = child.dataset?.blockId;
        if (bid) {
          blockHeights.set(bid, child.getBoundingClientRect().height + 24);
        }
      }
    });
  }

  function render(state) {
    // Theme
    document.documentElement.classList.toggle('dark', state.theme === 'dark');
    themeBtn.textContent = state.theme === 'dark' ? 'ライト表示' : 'ダーク表示';

    // Sidebar visibility
    sidebarEl.classList.toggle('is-collapsed', !state.sidebarOpen);

    // Project selector
    projectSelect.textContent = '';
    if (state.projects.length === 0) {
      projectSelect.appendChild(el('option', { value: '', textContent: '（未登録）' }));
      projectSelect.disabled = true;
    } else {
      projectSelect.disabled = false;
      for (const p of state.projects) {
        projectSelect.appendChild(
          el('option', {
            value: p.id,
            selected: p.id === state.activeProjectId,
            textContent: p.title,
          }),
        );
      }
    }

    // Active project & stats
    const activeProject = store.getActiveProject();
    const stats = store.getStats();

    progressText.textContent = `進捗 ${stats.progressPercent}%`;
    progressCount.textContent = `${stats.verifiedGroups} / ${stats.totalGroups} 確認済`;
    progressFill.style.width = `${stats.progressPercent}%`;

    // Warning Bar
    const totalWarnings =
      stats.structuralWarningBlocks +
      stats.mismatchBlocks +
      stats.needsReviewGroups +
      stats.changedGroups +
      stats.glossaryWarningGroups +
      stats.hintWarningGroups;
    if (activeProject && totalWarnings > 0) {
      warningBar.classList.remove('is-hidden');
      warningSummaryItems.textContent = '';
      warningSummaryItems.appendChild(
        el('strong', { textContent: '確認ポイント:' }),
      );
      if (stats.structuralWarningBlocks > 0) {
        warningSummaryItems.appendChild(
          el('span', {
            className: 'tabular-nums',
            textContent: `構成警告 ${stats.structuralWarningBlocks}ブロック`,
          }),
        );
      }
      if (stats.mismatchBlocks > 0) {
        warningSummaryItems.appendChild(
          el('span', {
            className: 'tabular-nums',
            textContent: `文数不一致・未確定 ${stats.mismatchBlocks}ブロック`,
          }),
        );
      }
      if (stats.glossaryWarningGroups > 0) {
        warningSummaryItems.appendChild(
          el('span', {
            className: 'tabular-nums',
            textContent: `用語不統一 ${stats.glossaryWarningGroups}グループ`,
          }),
        );
      }
      if (stats.hintWarningGroups > 0) {
        warningSummaryItems.appendChild(
          el('span', {
            className: 'tabular-nums',
            textContent: `漏れ・混入ヒント ${stats.hintWarningGroups}グループ`,
          }),
        );
      }
      if (stats.needsReviewGroups > 0) {
        warningSummaryItems.appendChild(
          el('span', {
            className: 'tabular-nums',
            textContent: `要確認 ${stats.needsReviewGroups}グループ`,
          }),
        );
      }
      if (stats.changedGroups > 0) {
        warningSummaryItems.appendChild(
          el('span', {
            className: 'tabular-nums',
            textContent: `原文変更 ${stats.changedGroups}グループ`,
          }),
        );
      }
    } else {
      warningBar.classList.add('is-hidden');
    }

    // Filter controls
    const filterDefs = [
      ['all', 'すべて'],
      ['unread', '未読'],
      ['read', '読了'],
      ['verified', '確認済'],
      ['needs_review', '要確認'],
      ['source_changed', '変更あり'],
      ['marked_or_temp', 'マーカ・仮記録'],
      ['glossary_issues', '用語警告'],
      ['hint_issues', '漏れ・混入'],
      ['warnings', '警告・不一致'],
    ];
    filterControl.textContent = '';
    for (const [val, label] of filterDefs) {
      filterControl.appendChild(
        el('button', {
          type: 'button',
          className: `segmented-btn${state.filterStatus === val ? ' is-active' : ''}`,
          textContent: label,
          onClick: () => store.setFilterStatus(val),
        }),
      );
    }

    // Layout mode controls
    layoutControl.textContent = '';
    layoutControl.appendChild(
      el('button', {
        type: 'button',
        className: `segmented-btn${state.layoutMode === 'columns' ? ' is-active' : ''}`,
        textContent: '左右2列',
        onClick: () => store.setLayoutMode('columns'),
      }),
    );
    layoutControl.appendChild(
      el('button', {
        type: 'button',
        className: `segmented-btn${state.layoutMode === 'stacked' ? ' is-active' : ''}`,
        textContent: '上下2段',
        onClick: () => store.setLayoutMode('stacked'),
      }),
    );

    // Filtered blocks
    if (searchInput.value !== state.searchQuery) {
      searchInput.value = state.searchQuery;
    }
    currentDupJaIndex = activeProject ? buildDuplicateJaIndex(activeProject.blocks) : null;
    const activeDismissedHints = activeProject?.dismissedHints || {};
    lastFilteredBlocks = activeProject
      ? activeProject.blocks.filter((b) =>
          blockMatchesFilter(
            b,
            state.filterStatus,
            state.searchQuery,
            state.glossary,
            state.jaNormOptions,
            currentDupJaIndex,
            activeDismissedHints,
          ),
        )
      : [];

    // Sidebar list
    sidebarList.textContent = '';
    for (const blk of lastFilteredBlocks) {
      const done = blk.groups.filter((g) => g.status === 'verified').length;
      const hasFlag =
        (blk.warnings || []).length > 0 ||
        blk.groups.some((g) => g.status === 'needs_review' || g.status === 'source_changed') ||
        blockHasGlossaryIssues(blk, state.glossary, state.jaNormOptions) ||
        blockHasActiveHints(blk, currentDupJaIndex, activeDismissedHints);
      const isActive = blk.groups.some((g) => g.id === state.selectedGroupId);
      const previewText =
        blk.jaSentences[0]?.plainText || blk.enSentences[0]?.plainText || '(空ブロック)';

      sidebarList.appendChild(
        el(
          'button',
          {
            type: 'button',
            className: `sidebar-block-item${isActive ? ' is-active' : ''}`,
            onClick: () => {
              if (blk.groups[0]) store.selectGroup(blk.groups[0].id);
              scrollToBlockOrGroup(blk.id, blk.groups[0]?.id);
            },
          },
          [
            el('div', { className: 'sidebar-block-top' }, [
              el('span', {
                className: 'tabular-nums',
                textContent: `#${String(blk.index + 1).padStart(2, '0')}`,
              }),
              el('span', {
                className: `tabular-nums${hasFlag ? ' status-needs_review' : ''}`,
                textContent: `${done}/${blk.groups.length}${hasFlag ? ' ⚠' : ''}`,
              }),
            ]),
            el('div', { className: 'sidebar-block-preview', textContent: previewText }),
          ],
        ),
      );
    }

    // Preserve active memo or unmatched-input focus across re-renders
    const activeEl = document.activeElement;
    const activeMemoGroupId = activeEl?.dataset?.memoGroupId || null;
    const activeUnmatchedKey = activeEl?.dataset?.unmatchedInputKey || null;
    const selectionStart =
      activeMemoGroupId || activeUnmatchedKey ? activeEl.selectionStart : null;
    const selectionEnd =
      activeMemoGroupId || activeUnmatchedKey ? activeEl.selectionEnd : null;

    renderVisibleWindow(true);

    if (activeMemoGroupId) {
      const restored = blocksList.querySelector(
        `textarea[data-memo-group-id="${CSS.escape(activeMemoGroupId)}"]`,
      );
      if (restored) {
        restored.focus();
        if (selectionStart !== null && selectionEnd !== null) {
          restored.setSelectionRange(selectionStart, selectionEnd);
        }
      }
    } else if (activeUnmatchedKey) {
      const restored = blocksList.querySelector(
        `textarea[data-unmatched-input-key="${CSS.escape(activeUnmatchedKey)}"]`,
      );
      if (restored) {
        restored.focus();
        if (selectionStart !== null && selectionEnd !== null) {
          restored.setSelectionRange(selectionStart, selectionEnd);
        }
      }
    }

    // Toasts
    toastRegion.textContent = '';
    for (const toast of state.toastQueue) {
      toastRegion.appendChild(
        el('div', {
          className: `toast${toast.isError ? ' is-error' : ''}`,
          textContent: toast.message,
        }),
      );
    }
  }

  function findSelectedSentenceElement(range) {
    const pickClosest = (node) => {
      if (!node) return null;
      const elNode = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      return elNode?.closest?.('.sentence-item') || null;
    };
    const fromStart = pickClosest(range.startContainer);
    if (fromStart && blocksList.contains(fromStart)) return fromStart;
    const fromEnd = pickClosest(range.endContainer);
    if (fromEnd && blocksList.contains(fromEnd)) return fromEnd;
    if (typeof range.intersectsNode === 'function') {
      for (const item of blocksList.querySelectorAll('.sentence-item')) {
        if (range.intersectsNode(item)) return item;
      }
    }
    return null;
  }

  function markCurrentSelection({ fromStart = false } = {}) {
    const proj = store.getActiveProject();
    if (!proj) return false;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      store.showToast('文中の文字をドラッグ選択してから H キーを押してください');
      return false;
    }

    const range = sel.getRangeAt(0);
    const sentenceItemEl = findSelectedSentenceElement(range);
    if (!sentenceItemEl) {
      store.showToast('対訳文の中をドラッグ選択してから H キーを押してください');
      return false;
    }

    const sentenceTextEl = sentenceItemEl.querySelector('.sentence-text');
    const selRange = getSelectionOffsetsInSentence(sentenceTextEl);
    if (!selRange) return false;

    const sentenceId = sentenceItemEl.dataset.sentenceId;
    const lang = sentenceItemEl.dataset.lang;
    const blockId = sentenceItemEl.closest('.block-section')?.dataset?.blockId;
    const groupId = sentenceItemEl.closest('.alignment-group')?.dataset?.groupId;
    const block = proj.blocks.find((b) => b.id === blockId);
    if (!block) return false;
    const sentenceList = lang === 'en' ? block.enSentences : block.jaSentences;
    const sentenceObj = sentenceList.find((s) => s.id === sentenceId);
    if (!sentenceObj) return false;

    if (groupId) {
      store.state.selectedGroupId = groupId;
    }
    closeContextMenu();
    clearBrowserSelection();

    if (fromStart) {
      store.addSentenceMarker(
        block.id,
        lang,
        sentenceObj.id,
        0,
        selRange.end,
        '文頭〜選択位置までマーカを付けました [Shift+H]',
      );
      return true;
    }

    if (isRangeFullyMarked(sentenceObj.markers, selRange.start, selRange.end)) {
      store.removeSentenceMarker(block.id, lang, sentenceObj.id, selRange.start, selRange.end);
    } else {
      store.addSentenceMarker(
        block.id,
        lang,
        sentenceObj.id,
        selRange.start,
        selRange.end,
        '選択範囲にマーカを付けました [H]',
      );
    }
    return true;
  }

  return {
    modalRoot,
    render,
    stepSelectedGroup,
    scrollToBlockOrGroup,
    jumpToLastFocused,
    markCurrentSelection,
  };
}
