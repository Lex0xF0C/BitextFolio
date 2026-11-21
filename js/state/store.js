/**
 * Central application state store with IndexedDB auto-persistence and subscriber notifications.
 */

import {
  nextLocalId,
  mergeSentenceWithNextInBlock,
  moveSentenceToGroup,
  splitSentenceInBlock,
  syncBlockMeta,
} from '../core/alignment.js';
import {
  buildAlignmentBlock,
  computeProjectStats,
  createDocumentProject,
  insertTextIntoGroup,
  mergeWithNextBlock,
  parseDocumentBlocks,
  realignBlockWithHints,
  SAMPLE_SOURCE_TEXT,
  swapBlockSides,
  updateBlockJapaneseText,
} from '../core/document-builder.js';
import { DEFAULT_JA_NORM_OPTIONS, SAMPLE_GLOSSARY_ENTRIES } from '../core/glossary.js';
import { reconcileReloadedBlocks } from '../core/hash-diff.js';
import { DEFAULT_ABBREVIATIONS } from '../core/sentence-splitter.js';
import { createTmRecord } from '../core/tm.js';
import {
  clearAllGlossaryEntries,
  clearAllTmRecords,
  deleteGlossaryEntry,
  deleteProject,
  deleteTmRecord,
  getSetting,
  listGlossaryEntries,
  listProjects,
  listTmRecords,
  saveGlossaryEntry,
  saveProject,
  saveTmRecord,
  setSetting,
} from '../storage/indexed-db.js';

const SAVE_DEBOUNCE_MS = 280;

export function createAppStore() {
  const listeners = new Set();
  let saveTimer = null;

  const state = {
    initialized: false,
    projects: [],
    activeProjectId: null,
    theme: 'light', // 'light' | 'dark'
    layoutMode: 'columns', // 'columns' | 'stacked'
    sidebarOpen: true,
    filterStatus: 'all', // 'all' | 'unread' | 'read' | 'verified' | 'needs_review' | 'source_changed' | 'warnings'
    searchQuery: '',
    selectedGroupId: null,
    openMemoGroupIds: new Set(),
    editingJaBlockIds: new Set(),
    activeSplitTarget: null, // { blockId, lang, sentenceId, offset }
    activeModal: null, // null | 'import' | 'json' | 'settings' | 'shortcuts' | 'glossary' | 'tm'
    glossaryTab: 'list', // 'list' | 'lookup' | 'csv'
    tmModalTab: 'tm', // 'tm' | 'candidates'
    importModalMode: 'new', // 'new' | 'replace'
    abbreviations: [...DEFAULT_ABBREVIATIONS],
    glossary: [],
    glossaryRevision: 0,
    jaNormOptions: { ...DEFAULT_JA_NORM_OPTIONS },
    tmRecords: [],
    tmRevision: 0,
    toastQueue: [],
  };

  function notify() {
    for (const fn of listeners) {
      fn(state);
    }
  }

  function showToast(message, isError = false) {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    state.toastQueue = [...state.toastQueue, { id, message, isError }];
    notify();
    setTimeout(() => {
      state.toastQueue = state.toastQueue.filter((t) => t.id !== id);
      notify();
    }, 3400);
  }

  function getActiveProject() {
    return state.projects.find((p) => p.id === state.activeProjectId) || null;
  }

  function scheduleSaveActiveProject() {
    const proj = getActiveProject();
    if (!proj) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const saved = await saveProject(proj);
      state.projects = state.projects.map((p) => (p.id === saved.id ? saved : p));
    }, SAVE_DEBOUNCE_MS);
  }

  function updateActiveProject(updater, immediateSave = false) {
    const proj = getActiveProject();
    if (!proj) return;
    const updated = updater(proj);
    updated.updatedAt = new Date().toISOString();
    state.projects = state.projects.map((p) => (p.id === updated.id ? updated : p));
    notify();
    if (immediateSave) {
      clearTimeout(saveTimer);
      saveProject(updated);
    } else {
      scheduleSaveActiveProject();
    }
  }

  function mutateBlock(blockId, blockUpdater, immediateSave = false) {
    updateActiveProject((proj) => {
      const blocks = proj.blocks.map((blk) =>
        blk.id === blockId ? blockUpdater(blk) : blk,
      );
      return { ...proj, blocks };
    }, immediateSave);
  }

  async function init() {
    const [
      savedProjects,
      savedTheme,
      savedLayout,
      savedActiveId,
      savedAbbrs,
      savedGlossary,
      glossarySeeded,
      savedJaNorm,
      savedTm,
    ] = await Promise.all([
      listProjects(),
      getSetting('theme', 'light'),
      getSetting('layoutMode', 'columns'),
      getSetting('activeProjectId', null),
      getSetting('abbreviations', DEFAULT_ABBREVIATIONS),
      listGlossaryEntries(),
      getSetting('glossarySeeded', false),
      getSetting('jaNormOptions', DEFAULT_JA_NORM_OPTIONS),
      listTmRecords(),
    ]);

    state.theme = savedTheme === 'dark' ? 'dark' : 'light';
    state.layoutMode = savedLayout === 'stacked' ? 'stacked' : 'columns';
    state.abbreviations =
      Array.isArray(savedAbbrs) && savedAbbrs.length > 0
        ? savedAbbrs
        : [...DEFAULT_ABBREVIATIONS];
    state.jaNormOptions = { ...DEFAULT_JA_NORM_OPTIONS, ...(savedJaNorm || {}) };
    state.tmRecords = Array.isArray(savedTm) ? savedTm : [];

    if (savedGlossary.length > 0 || glossarySeeded) {
      state.glossary = savedGlossary;
    } else {
      for (const entry of SAMPLE_GLOSSARY_ENTRIES) {
        await saveGlossaryEntry(entry);
      }
      await setSetting('glossarySeeded', true);
      state.glossary = [...SAMPLE_GLOSSARY_ENTRIES];
    }

    if (savedProjects.length > 0) {
      state.projects = savedProjects;
      const found = savedProjects.find((p) => p.id === savedActiveId) || savedProjects[0];
      state.activeProjectId = found.id;
      state.selectedGroupId = found.lastFocusedGroupId || found.blocks[0]?.groups[0]?.id || null;
    } else {
      // Seed initial sample project on first visit so user can immediately explore
      const sample = createDocumentProject({
        title: 'サンプル対訳（インシデント対応・脆弱性調整）',
        rawText: SAMPLE_SOURCE_TEXT,
        abbreviations: state.abbreviations,
      });
      await saveProject(sample);
      state.projects = [sample];
      state.activeProjectId = sample.id;
      state.selectedGroupId = sample.lastFocusedGroupId;
      await setSetting('activeProjectId', sample.id);
    }

    state.initialized = true;
    notify();
  }

  return {
    state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    init,
    showToast,
    getActiveProject,
    getStats() {
      return computeProjectStats(getActiveProject(), state.glossary, state.jaNormOptions);
    },
    async setTheme(theme) {
      state.theme = theme === 'dark' ? 'dark' : 'light';
      await setSetting('theme', state.theme);
      notify();
    },
    async setLayoutMode(mode) {
      state.layoutMode = mode === 'stacked' ? 'stacked' : 'columns';
      await setSetting('layoutMode', state.layoutMode);
      notify();
    },
    toggleSidebar() {
      state.sidebarOpen = !state.sidebarOpen;
      notify();
    },
    setFilterStatus(filterStatus) {
      state.filterStatus = filterStatus;
      notify();
    },
    setSearchQuery(searchQuery) {
      state.searchQuery = searchQuery;
      notify();
    },
    openModal(modalName, subOption = null) {
      state.activeModal = modalName;
      if (modalName === 'import' && subOption) {
        state.importModalMode = subOption;
      }
      if (modalName === 'glossary' && subOption) {
        state.glossaryTab = subOption;
      }
      if (modalName === 'tm' && subOption) {
        state.tmModalTab = subOption;
      }
      notify();
    },
    closeModal() {
      state.activeModal = null;
      notify();
    },
    selectGroup(groupId) {
      state.selectedGroupId = groupId;
      updateActiveProject((proj) => ({ ...proj, lastFocusedGroupId: groupId }));
    },
    toggleMemo(groupId, forceOpen = null) {
      const next = new Set(state.openMemoGroupIds);
      const shouldOpen = forceOpen !== null ? forceOpen : !next.has(groupId);
      if (shouldOpen) next.add(groupId);
      else next.delete(groupId);
      state.openMemoGroupIds = next;
      notify();
    },
    async selectProject(projectId) {
      const found = state.projects.find((p) => p.id === projectId);
      if (!found) return;
      state.activeProjectId = found.id;
      state.selectedGroupId = found.lastFocusedGroupId || found.blocks[0]?.groups[0]?.id || null;
      state.activeSplitTarget = null;
      state.filterStatus = 'all';
      state.searchQuery = '';
      await setSetting('activeProjectId', found.id);
      notify();
    },
    async createNewProject({ title, rawText, rawBlocks, inputMode = 'alternating' }) {
      const proj = createDocumentProject({
        title,
        rawText,
        rawBlocks,
        inputMode,
        abbreviations: state.abbreviations,
      });
      await saveProject(proj);
      state.projects = [proj, ...state.projects];
      state.activeProjectId = proj.id;
      state.selectedGroupId = proj.lastFocusedGroupId;
      state.filterStatus = 'all';
      state.searchQuery = '';
      state.activeModal = null;
      await setSetting('activeProjectId', proj.id);
      showToast(`「${proj.title}」を読み込みました（${proj.blocks.length}ブロック）`);
      notify();
    },
    async replaceActiveProjectSource({ title, rawText, rawBlocks, inputMode = 'alternating' }) {
      const current = getActiveProject();
      if (!current) return;
      const newBlocks = parseDocumentBlocks(rawText, {
        abbreviations: state.abbreviations,
        rawBlocks,
        inputMode,
      });
      const { blocks: reconciled, summary } = reconcileReloadedBlocks(current.blocks, newBlocks);
      const updated = {
        ...current,
        title: (title || '').trim() || current.title,
        rawSourceText: rawText,
        blocks: reconciled,
        lastFocusedGroupId: reconciled[0]?.groups[0]?.id || null,
      };
      await saveProject(updated);
      state.projects = state.projects.map((p) => (p.id === updated.id ? updated : p));
      state.selectedGroupId = updated.lastFocusedGroupId;
      state.activeModal = null;
      showToast(
        `原文を差し替えました（継承: ${summary.inheritedCount} / 変更検知: ${summary.changedCount} / 新規: ${summary.addedCount}）`,
      );
      notify();
    },
    async renameProject(projectId, newTitle) {
      const clean = (newTitle || '').trim();
      if (!clean) return;
      const target = state.projects.find((p) => p.id === projectId);
      if (!target) return;
      const updated = await saveProject({ ...target, title: clean });
      state.projects = state.projects.map((p) => (p.id === updated.id ? updated : p));
      showToast('ドキュメント名を更新しました');
      notify();
    },
    async removeProject(projectId) {
      await deleteProject(projectId);
      state.projects = state.projects.filter((p) => p.id !== projectId);
      if (state.activeProjectId === projectId) {
        const next = state.projects[0] || null;
        state.activeProjectId = next ? next.id : null;
        state.selectedGroupId = next ? next.lastFocusedGroupId || next.blocks[0]?.groups[0]?.id || null : null;
        await setSetting('activeProjectId', state.activeProjectId);
      }
      showToast('ドキュメントを削除しました');
      notify();
    },
    async importProjectsFromJson({ projects, settings, glossary, tmRecords }) {
      if (settings && Array.isArray(settings.abbreviations) && settings.abbreviations.length > 0) {
        state.abbreviations = settings.abbreviations;
        await setSetting('abbreviations', state.abbreviations);
      }
      if (Array.isArray(glossary) && glossary.length > 0) {
        for (const entry of glossary) {
          if (entry && entry.id && entry.enHeadword) {
            await saveGlossaryEntry(entry);
          }
        }
        state.glossary = await listGlossaryEntries();
        state.glossaryRevision += 1;
      }
      if (Array.isArray(tmRecords) && tmRecords.length > 0) {
        for (const rec of tmRecords) {
          if (rec && rec.id && rec.enPlain && rec.jaPlain) {
            await saveTmRecord(rec);
          }
        }
        state.tmRecords = await listTmRecords();
        state.tmRevision += 1;
      }
      const existingMap = new Map(state.projects.map((p) => [p.id, p]));
      for (const proj of projects) {
        const saved = await saveProject(proj);
        existingMap.set(saved.id, saved);
      }
      state.projects = [...existingMap.values()].sort((a, b) =>
        (b.updatedAt || '').localeCompare(a.updatedAt || ''),
      );
      if (projects[0]) {
        state.activeProjectId = projects[0].id;
        state.selectedGroupId =
          projects[0].lastFocusedGroupId || projects[0].blocks[0]?.groups[0]?.id || null;
        await setSetting('activeProjectId', state.activeProjectId);
      }
      state.activeModal = null;
      showToast(`${projects.length}件のドキュメントをインポートしました`);
      notify();
    },
    async recordGroupToTm(block, group, projTitle = '', projId = '') {
      if (!block || !group) return;
      const enMap = new Map((block.enSentences || []).map((s) => [s.id, s]));
      const jaMap = new Map((block.jaSentences || []).map((s) => [s.id, s]));
      const enPlain = (group.enIds || []).map((id) => enMap.get(id)?.plainText || '').join(' ').trim();
      const jaPlain = (group.jaIds || []).map((id) => jaMap.get(id)?.plainText || '').join(' ').trim();
      if (!enPlain || !jaPlain) return;
      const rec = createTmRecord({
        enPlain,
        jaPlain,
        sourceDocId: projId,
        sourceDocTitle: projTitle,
        groupId: group.id,
      });
      await saveTmRecord(rec);
      const others = state.tmRecords.filter((r) => r.id !== rec.id);
      state.tmRecords = [rec, ...others];
      state.tmRevision += 1;
      notify();
    },
    async saveCustomTmPair({ enPlain, jaPlain, groupId = '' }) {
      const cleanEn = String(enPlain || '').trim();
      const cleanJa = String(jaPlain || '').trim();
      if (!cleanEn || !cleanJa) {
        showToast('英語と日本語の両方を入力してください', true);
        return false;
      }
      const proj = getActiveProject();
      const rec = createTmRecord({
        enPlain: cleanEn,
        jaPlain: cleanJa,
        sourceDocId: proj?.id || '',
        sourceDocTitle: proj?.title || '',
        groupId,
      });
      await saveTmRecord(rec);
      const others = state.tmRecords.filter((r) => r.id !== rec.id);
      state.tmRecords = [rec, ...others];
      state.tmRevision += 1;
      showToast(`翻訳メモリに登録しました: 「${rec.enPlain.slice(0, 28)}${rec.enPlain.length > 28 ? '…' : ''}」`);
      notify();
      return true;
    },
    setGroupStatus(blockId, groupId, status) {
      state.selectedGroupId = groupId;
      let verifiedBlock = null;
      let verifiedGroup = null;
      let projTitle = '';
      let projId = '';
      updateActiveProject((proj) => {
        projTitle = proj.title;
        projId = proj.id;
        const blocks = proj.blocks.map((blk) => {
          if (blk.id !== blockId) return blk;
          const groups = blk.groups.map((g) => {
            if (g.id !== groupId) return g;
            const nextGroup = {
              ...g,
              status,
              confirmedAlignment: status === 'verified' ? true : g.confirmedAlignment,
            };
            if (status === 'verified') {
              verifiedGroup = nextGroup;
            }
            return nextGroup;
          });
          const synced = syncBlockMeta({ ...blk, groups });
          if (status === 'verified') verifiedBlock = synced;
          return synced;
        });
        return { ...proj, lastFocusedGroupId: groupId, blocks };
      });
      if (status === 'verified' && verifiedBlock && verifiedGroup) {
        this.recordGroupToTm(verifiedBlock, verifiedGroup, projTitle, projId);
      }
      if (status === 'needs_review') {
        state.openMemoGroupIds.add(groupId);
        notify();
      }
    },
    setGroupMemo(blockId, groupId, memo) {
      mutateBlock(blockId, (blk) => {
        const groups = blk.groups.map((g) => (g.id === groupId ? { ...g, memo } : g));
        return { ...blk, groups };
      });
    },
    async setBlockAllStatus(blockId, status) {
      let targetBlock = null;
      let projTitle = '';
      let projId = '';
      mutateBlock(
        blockId,
        (blk) => {
          const groups = blk.groups.map((g) => ({
            ...g,
            status,
            confirmedAlignment: status === 'verified' ? true : g.confirmedAlignment,
          }));
          targetBlock = syncBlockMeta({ ...blk, groups });
          return targetBlock;
        },
        true,
      );
      if (status === 'verified' && targetBlock) {
        const proj = getActiveProject();
        projTitle = proj?.title || '';
        projId = proj?.id || '';
        for (const grp of targetBlock.groups) {
          await this.recordGroupToTm(targetBlock, grp, projTitle, projId);
        }
      }
      showToast('ブロック内の全グループの状態を更新しました');
    },
    startSplitSentence(blockId, lang, sentenceId, rawLength) {
      state.activeSplitTarget = {
        blockId,
        lang,
        sentenceId,
        offset: Math.max(1, Math.floor(rawLength / 2)),
      };
      notify();
    },
    updateSplitOffset(offset) {
      if (!state.activeSplitTarget) return;
      state.activeSplitTarget = { ...state.activeSplitTarget, offset };
      notify();
    },
    cancelSplitSentence() {
      state.activeSplitTarget = null;
      notify();
    },
    confirmSplitSentence() {
      if (!state.activeSplitTarget) return;
      const { blockId, lang, sentenceId, offset } = state.activeSplitTarget;
      mutateBlock(blockId, (blk) => splitSentenceInBlock(blk, lang, sentenceId, offset), true);
      state.activeSplitTarget = null;
      showToast('文を分割しました');
    },
    mergeSentenceWithNext(blockId, lang, sentenceId) {
      mutateBlock(blockId, (blk) => mergeSentenceWithNextInBlock(blk, lang, sentenceId), true);
      showToast('次の文と結合しました');
    },
    moveSentence(blockId, lang, sentenceId, targetGroupId) {
      mutateBlock(blockId, (blk) => moveSentenceToGroup(blk, lang, sentenceId, targetGroupId), true);
    },
    swapBlockLanguages(blockId) {
      mutateBlock(blockId, (blk) => swapBlockSides(blk, state.abbreviations), true);
      showToast('ブロックの英語・日本語を入れ替えました');
    },
    mergeBlockWithFollowing(blockIndex) {
      updateActiveProject((proj) => {
        const blocks = mergeWithNextBlock(proj.blocks, blockIndex, state.abbreviations);
        return { ...proj, blocks };
      }, true);
      showToast('次のブロックと結合しました');
    },
    realignBlock(blockId, useHintDp = true) {
      mutateBlock(
        blockId,
        (blk) => realignBlockWithHints(blk, state.abbreviations, useHintDp),
        true,
      );
      showToast(useHintDp ? 'ヒントを使って自動整列しました' : '先頭から1対1に再整列しました');
    },
    toggleBlockJaEditor(blockId, forceOpen = null) {
      const next = new Set(state.editingJaBlockIds);
      const shouldOpen = forceOpen !== null ? forceOpen : !next.has(blockId);
      if (shouldOpen) next.add(blockId);
      else next.delete(blockId);
      state.editingJaBlockIds = next;
      notify();
    },
    updateBlockJapanese(blockId, jaText) {
      mutateBlock(blockId, (blk) => updateBlockJapaneseText(blk, jaText), true);
      const next = new Set(state.editingJaBlockIds);
      next.delete(blockId);
      state.editingJaBlockIds = next;
      showToast('日本語訳を反映して文分割しました');
      notify();
    },
    insertGroupSentenceText(blockId, groupId, lang, rawText) {
      const clean = String(rawText || '').trim();
      if (!clean) {
        showToast('テキストを入力またはペーストしてください', true);
        return;
      }
      mutateBlock(
        blockId,
        (blk) => insertTextIntoGroup(blk, groupId, lang, clean, state.abbreviations),
        true,
      );
      showToast(lang === 'ja' ? '日本語文を対訳枠へ反映しました' : '英文を対訳枠へ反映しました');
    },
    async saveAbbreviations(newList, resplitCurrentDoc = false) {
      const cleaned = [...new Set(newList.map((s) => s.trim()).filter(Boolean))];
      state.abbreviations = cleaned;
      await setSetting('abbreviations', cleaned);
      if (resplitCurrentDoc) {
        updateActiveProject((proj) => {
          const blocks = proj.blocks.map((blk, idx) =>
            buildAlignmentBlock(blk.enRaw, blk.jaRaw, idx, {
              id: blk.id,
              abbreviations: cleaned,
              warnings: (blk.warnings || []).filter(
                (w) => w !== 'UNMATCHED_COUNT' && w !== 'UNCONFIRMED_GROUP',
              ),
            }),
          );
          return { ...proj, abbreviations: cleaned, blocks };
        }, true);
        showToast('略語リストを保存し、現在の文書を再分割しました');
      } else {
        showToast('略語リストを保存しました');
      }
      state.activeModal = null;
      notify();
    },
    async saveGlossaryItem(entryInput) {
      const enHeadword = String(entryInput.enHeadword || '').trim();
      if (!enHeadword) {
        showToast('英語見出し語を入力してください', true);
        return;
      }
      const entry = {
        id: entryInput.id || nextLocalId('glo'),
        enHeadword,
        enVariants: (entryInput.enVariants || []).map((s) => s.trim()).filter(Boolean),
        jaAccepted: (entryInput.jaAccepted || []).map((s) => s.trim()).filter(Boolean),
        jaDeprecated: (entryInput.jaDeprecated || []).map((s) => s.trim()).filter(Boolean),
        caseSensitive: Boolean(entryInput.caseSensitive),
        notes: String(entryInput.notes || '').trim(),
      };
      await saveGlossaryEntry(entry);
      state.glossary = await listGlossaryEntries();
      state.glossaryRevision += 1;
      showToast(`用語「${entry.enHeadword}」を保存しました`);
      notify();
    },
    async removeGlossaryItem(entryId) {
      await deleteGlossaryEntry(entryId);
      state.glossary = state.glossary.filter((e) => e.id !== entryId);
      state.glossaryRevision += 1;
      showToast('用語を削除しました');
      notify();
    },
    async importGlossaryList(entries, replaceAll = false) {
      if (replaceAll) {
        await clearAllGlossaryEntries();
      }
      for (const entry of entries) {
        await saveGlossaryEntry(entry);
      }
      state.glossary = await listGlossaryEntries();
      state.glossaryRevision += 1;
      showToast(`${entries.length}件の用語をインポートしました`);
      notify();
    },
    async seedSampleGlossary() {
      for (const entry of SAMPLE_GLOSSARY_ENTRIES) {
        await saveGlossaryEntry(entry);
      }
      state.glossary = await listGlossaryEntries();
      state.glossaryRevision += 1;
      showToast('サンプル用語を登録しました');
      notify();
    },
    async clearGlossary() {
      await clearAllGlossaryEntries();
      state.glossary = [];
      state.glossaryRevision += 1;
      showToast('用語集を空にしました');
      notify();
    },
    async setJaNormOptions(nextOptions) {
      state.jaNormOptions = { ...state.jaNormOptions, ...nextOptions };
      await setSetting('jaNormOptions', state.jaNormOptions);
      notify();
    },
    dismissHint(hintId) {
      updateActiveProject((proj) => ({
        ...proj,
        dismissedHints: { ...(proj.dismissedHints || {}), [hintId]: true },
      }), true);
      showToast('ヒントを許容・非表示にしました');
    },
    restoreHints(hintIds) {
      updateActiveProject((proj) => {
        const next = { ...(proj.dismissedHints || {}) };
        for (const id of hintIds) delete next[id];
        return { ...proj, dismissedHints: next };
      }, true);
      showToast('非表示にしたヒントを復元しました');
    },
    restoreAllHints() {
      updateActiveProject((proj) => ({ ...proj, dismissedHints: {} }), true);
      showToast('すべての非表示ヒントを復元しました');
    },
    async harvestVerifiedToTm() {
      const proj = getActiveProject();
      if (!proj) return;
      let count = 0;
      for (const blk of proj.blocks) {
        const enMap = new Map((blk.enSentences || []).map((s) => [s.id, s]));
        const jaMap = new Map((blk.jaSentences || []).map((s) => [s.id, s]));
        for (const grp of blk.groups || []) {
          if (grp.status !== 'verified') continue;
          const enPlain = (grp.enIds || []).map((id) => enMap.get(id)?.plainText || '').join(' ').trim();
          const jaPlain = (grp.jaIds || []).map((id) => jaMap.get(id)?.plainText || '').join(' ').trim();
          if (!enPlain || !jaPlain) continue;
          const rec = createTmRecord({
            enPlain,
            jaPlain,
            sourceDocId: proj.id,
            sourceDocTitle: proj.title,
            groupId: grp.id,
          });
          await saveTmRecord(rec);
          count += 1;
        }
      }
      state.tmRecords = await listTmRecords();
      state.tmRevision += 1;
      showToast(`${count}件の確認済ペアを翻訳メモリに登録しました`);
      notify();
    },
    async removeTmRecord(recordId) {
      await deleteTmRecord(recordId);
      state.tmRecords = state.tmRecords.filter((r) => r.id !== recordId);
      state.tmRevision += 1;
      showToast('翻訳メモリから削除しました');
      notify();
    },
    async clearTm() {
      await clearAllTmRecords();
      state.tmRecords = [];
      state.tmRevision += 1;
      showToast('翻訳メモリを空にしました');
      notify();
    },
  };
}
