/**
 * Application bootstrap and global keyboard shortcut bindings.
 */

import { SAMPLE_SOURCE_TEXT } from './core/document-builder.js';
import { createAppStore } from './state/store.js';
import { mountModals } from './ui/modals.js';
import { mountWorkspace } from './ui/workspace.js';

const rootEl = document.getElementById('app');
const store = createAppStore();

const workspace = mountWorkspace(rootEl, store, async () => {
  await store.createNewProject({
    title: 'サンプル対訳（インシデント対応・脆弱性調整）',
    rawText: SAMPLE_SOURCE_TEXT,
  });
});

const modals = mountModals(workspace.modalRoot, store, (blockId, groupId) => {
  store.closeModal();
  if (store.state.filterStatus !== 'all') {
    store.setFilterStatus('all');
  }
  store.selectGroup(groupId);
  workspace.scrollToBlockOrGroup(blockId, groupId);
});

let lastRenderedModalKey = null;

store.subscribe((state) => {
  workspace.render(state);
  const modalKey = state.activeModal
    ? `${state.activeModal}:${state.glossaryTab}:${state.tmModalTab}:${state.glossaryRevision}:${state.tmRevision}:${JSON.stringify(state.jaNormOptions)}:${Object.keys(store.getActiveProject()?.dismissedHints || {}).length}:${state.projects.map((p) => `${p.id}:${p.title}`).join('|')}`
    : null;
  if (modalKey !== lastRenderedModalKey) {
    lastRenderedModalKey = modalKey;
    modals.renderModal(state);
  }
});

// Keyboard-centric navigation when focus is outside editable inputs
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (store.state.activeModal) {
      store.closeModal();
      return;
    }
    if (store.state.activeSplitTarget) {
      store.cancelSplitSentence();
      return;
    }
  }

  if (store.state.activeModal) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return;
  }

  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    e.preventDefault();
    store.openModal('shortcuts');
    return;
  }

  if (e.key === 'j' || e.key === 'ArrowDown') {
    e.preventDefault();
    workspace.stepSelectedGroup(1);
    return;
  }

  if (e.key === 'k' || e.key === 'ArrowUp') {
    e.preventDefault();
    workspace.stepSelectedGroup(-1);
    return;
  }

  const groupId = store.state.selectedGroupId;
  const proj = store.getActiveProject();
  if (!groupId || !proj) return;

  const ownerBlock = proj.blocks.find((b) => b.groups.some((g) => g.id === groupId));
  if (!ownerBlock) return;

  if (e.key === 'v' || e.key === 'Enter') {
    e.preventDefault();
    store.setGroupStatus(ownerBlock.id, groupId, 'verified');
    workspace.stepSelectedGroup(1);
  } else if (e.key === 'r') {
    e.preventDefault();
    store.setGroupStatus(ownerBlock.id, groupId, 'read');
  } else if (e.key === 'f') {
    e.preventDefault();
    store.setGroupStatus(ownerBlock.id, groupId, 'needs_review');
    requestAnimationFrame(() => {
      const textarea = document.querySelector(
        `textarea[data-memo-group-id="${CSS.escape(groupId)}"]`,
      );
      if (textarea) textarea.focus();
    });
  } else if (e.key === 't') {
    e.preventDefault();
    store.toggleGroupTempNoOmission(ownerBlock.id, groupId);
  } else if (e.key === 'm') {
    e.preventDefault();
    store.toggleMemo(groupId, true);
    requestAnimationFrame(() => {
      const textarea = document.querySelector(
        `textarea[data-memo-group-id="${CSS.escape(groupId)}"]`,
      );
      if (textarea) textarea.focus();
    });
  }
});

store.init();
