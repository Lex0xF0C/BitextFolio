/**
 * Central application state store with IndexedDB auto-persistence and subscriber notifications.
 */

import {
  nextLocalId,
  mergeSentenceWithNextInBlock,
  moveSentenceToGroup,
  splitSentenceInBlock,
  syncBlockMeta,
  updateSentenceMarkersInBlock,
} from '../core/alignment.js';
import { addMarkerRange, removeMarkerRange } from '../core/markers.js';
import {
  addClausePairInGroup,
  attachSpanToClausePairInGroup,
  clearClausePairsInGroup,
  removeClausePairInGroup,
  toggleClausePairCheckedInGroup,
  updateClausePairNoteInGroup,
} from '../core/clauses.js';
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
  updateSentenceTextInBlock,
} from '../core/document-builder.js';
import { DEFAULT_JA_NORM_OPTIONS, SAMPLE_GLOSSARY_ENTRIES } from '../core/glossary.js';
import { reconcileReloadedBlocks } from '../core/hash-diff.js';
import { DEFAULT_ABBREVIATIONS } from '../core/sentence-splitter.js';
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
    openClauseGroupIds: new Set(),
    editingJaBlockIds: new Set(),
    editingSentenceTarget: null, // { blockId, lang, sentenceId }
    activeSplitTarget: null, // { blockId, lang, sentenceId, offset }
    activeModal: null, // null | 'import' | 'json' | 'settings' | 'shortcuts' | 'glossary'
    glossaryTab: 'list', // 'list' | 'candidates' | 'lookup' | 'csv'
    importModalMode: 'new', // 'new' | 'replace'
    abbreviations: [...DEFAULT_ABBREVIATIONS],
    glossary: [],
    glossaryRevision: 0,
    jaNormOptions: { ...DEFAULT_JA_NORM_OPTIONS },
    tmRecords: [], // legacy sentence-level records if any remain in IndexedDB
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

    // One-time migration: merge legacy short phrase TM entries into unified glossary/TM store
    const tmMigrated = await getSetting('tmMigratedToUnified', false);
    if (!tmMigrated && state.tmRecords.length > 0) {
      const existingByLower = new Map(
        state.glossary.map((g) => [(g.enHeadword || '').trim().toLowerCase(), g]),
      );
      let migratedCount = 0;
      for (const rec of state.tmRecords) {
        const cleanEn = String(rec?.enPlain || '').trim();
        const cleanJa = String(rec?.jaPlain || '').trim();
        if (!cleanEn || !cleanJa) continue;
        const wordCount = cleanEn.split(/\s+/).length;
        const looksLikeFullSentence = wordCount > 5 || /[.!?。！？]$/.test(cleanEn);
        if (looksLikeFullSentence) continue;
        const key = cleanEn.toLowerCase();
        const existing = existingByLower.get(key);
        if (existing) {
          if (!existing.jaAccepted.includes(cleanJa)) {
            const updated = { ...existing, jaAccepted: [...existing.jaAccepted, cleanJa] };
            await saveGlossaryEntry(updated);
            existingByLower.set(key, updated);
          }
        } else {
          const entry = {
            id: nextLocalId('glo'),
            enHeadword: cleanEn,
            enVariants: [],
            jaAccepted: [cleanJa],
            jaDeprecated: [],
            caseSensitive: /^[A-Z0-9-]+$/.test(cleanEn),
            notes: rec.sourceDocTitle ? `旧TMより統合 (${rec.sourceDocTitle})` : '旧TMより統合',
          };
          await saveGlossaryEntry(entry);
          existingByLower.set(key, entry);
        }
        await deleteTmRecord(rec.id);
        migratedCount += 1;
      }
      if (migratedCount > 0) {
        state.glossary = await listGlossaryEntries();
        state.tmRecords = await listTmRecords();
      }
      await setSetting('tmMigratedToUnified', true);
    } else if (!tmMigrated) {
      await setSetting('tmMigratedToUnified', true);
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
      if (modalName === 'tm') {
        state.activeModal = 'glossary';
        state.glossaryTab = subOption === 'candidates' ? 'candidates' : 'list';
      } else {
        state.activeModal = modalName;
        if (modalName === 'import' && subOption) {
          state.importModalMode = subOption;
        }
        if (modalName === 'glossary' && subOption) {
          state.glossaryTab = subOption;
        }
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
    async createNewProject({
      title,
      rawText,
      rawBlocks,
      inputMode = 'alternating',
      splitInsideList = false,
    }) {
      const proj = createDocumentProject({
        title,
        rawText,
        rawBlocks,
        inputMode,
        splitInsideList,
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
    async replaceActiveProjectSource({
      title,
      rawText,
      rawBlocks,
      inputMode = 'alternating',
      splitInsideList = false,
    }) {
      const current = getActiveProject();
      if (!current) return;
      const newBlocks = parseDocumentBlocks(rawText, {
        abbreviations: state.abbreviations,
        rawBlocks,
        inputMode,
        splitInsideList,
      });
      const { blocks: reconciled, summary } = reconcileReloadedBlocks(current.blocks, newBlocks);
      const updated = {
        ...current,
        title: (title || '').trim() || current.title,
        rawSourceText: rawText,
        splitInsideList: Boolean(splitInsideList),
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
      if (settings && settings.jaNormOptions && typeof settings.jaNormOptions === 'object') {
        state.jaNormOptions = { ...DEFAULT_JA_NORM_OPTIONS, ...settings.jaNormOptions };
        await setSetting('jaNormOptions', state.jaNormOptions);
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
        const existingByLower = new Map(
          state.glossary.map((g) => [(g.enHeadword || '').trim().toLowerCase(), g]),
        );
        let mergedFromBackup = false;
        for (const rec of tmRecords) {
          const cleanEn = String(rec?.enPlain || '').trim();
          const cleanJa = String(rec?.jaPlain || '').trim();
          if (!cleanEn || !cleanJa) continue;
          const wordCount = cleanEn.split(/\s+/).length;
          if (wordCount > 5 || /[.!?。！？]$/.test(cleanEn)) continue;
          const key = cleanEn.toLowerCase();
          const existing = existingByLower.get(key);
          if (existing) {
            if (!existing.jaAccepted.includes(cleanJa)) {
              const updated = { ...existing, jaAccepted: [...existing.jaAccepted, cleanJa] };
              await saveGlossaryEntry(updated);
              existingByLower.set(key, updated);
              mergedFromBackup = true;
            }
          } else {
            const entry = {
              id: nextLocalId('glo'),
              enHeadword: cleanEn,
              enVariants: [],
              jaAccepted: [cleanJa],
              jaDeprecated: [],
              caseSensitive: /^[A-Z0-9-]+$/.test(cleanEn),
              notes: 'JSONバックアップより取込',
            };
            await saveGlossaryEntry(entry);
            existingByLower.set(key, entry);
            mergedFromBackup = true;
          }
        }
        if (mergedFromBackup) {
          state.glossary = await listGlossaryEntries();
          state.glossaryRevision += 1;
        }
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
    async registerTermPair({
      enHeadword,
      jaAccepted = [],
      jaDeprecated = [],
      enVariants = [],
      caseSensitive = false,
      notes = '',
      mergeIfExists = true,
    }) {
      const cleanEn = String(enHeadword || '').trim();
      const accList = (Array.isArray(jaAccepted) ? jaAccepted : [jaAccepted])
        .map((s) => String(s || '').trim())
        .filter(Boolean);
      const depList = (Array.isArray(jaDeprecated) ? jaDeprecated : [jaDeprecated])
        .map((s) => String(s || '').trim())
        .filter(Boolean);
      if (!cleanEn || (accList.length === 0 && depList.length === 0)) {
        showToast('英語語句と日本語訳の両方を入力してください', true);
        return false;
      }

      const existing = mergeIfExists
        ? state.glossary.find((g) => (g.enHeadword || '').trim().toLowerCase() === cleanEn.toLowerCase())
        : null;

      const entry = existing
        ? {
            ...existing,
            enVariants: [...new Set([...(existing.enVariants || []), ...enVariants])],
            jaAccepted: [...new Set([...(existing.jaAccepted || []), ...accList])],
            jaDeprecated: [...new Set([...(existing.jaDeprecated || []), ...depList])],
            notes: existing.notes || String(notes || '').trim(),
          }
        : {
            id: nextLocalId('glo'),
            enHeadword: cleanEn,
            enVariants: enVariants.map((s) => String(s || '').trim()).filter(Boolean),
            jaAccepted: [...new Set(accList)],
            jaDeprecated: [...new Set(depList)],
            caseSensitive: Boolean(caseSensitive),
            notes: String(notes || '').trim(),
          };

      await saveGlossaryEntry(entry);
      state.glossary = await listGlossaryEntries();
      state.glossaryRevision += 1;
      showToast(
        existing
          ? `翻訳メモリ・用語集を更新しました: 「${entry.enHeadword}」`
          : `翻訳メモリ・用語集に登録しました: 「${entry.enHeadword}」`,
      );
      notify();
      return true;
    },
    async saveCustomTmPair({ enPlain, jaPlain }) {
      return this.registerTermPair({
        enHeadword: enPlain,
        jaAccepted: [jaPlain],
        caseSensitive: /^[A-Z0-9-]+$/.test(String(enPlain || '').trim()),
        notes: '本文から登録',
        mergeIfExists: true,
      });
    },
    setGroupStatus(blockId, groupId, status) {
      state.selectedGroupId = groupId;
      updateActiveProject((proj) => {
        const blocks = proj.blocks.map((blk) => {
          if (blk.id !== blockId) return blk;
          const groups = blk.groups.map((g) => {
            if (g.id !== groupId) return g;
            return {
              ...g,
              status,
              confirmedAlignment: status === 'verified' ? true : g.confirmedAlignment,
            };
          });
          return syncBlockMeta({ ...blk, groups });
        });
        return { ...proj, lastFocusedGroupId: groupId, blocks };
      });
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
    toggleGroupTempNoOmission(blockId, groupId, forceValue = null) {
      state.selectedGroupId = groupId;
      let nextChecked = false;
      updateActiveProject((proj) => {
        const blocks = proj.blocks.map((blk) => {
          if (blk.id !== blockId) return blk;
          const groups = blk.groups.map((g) => {
            if (g.id !== groupId) return g;
            nextChecked = forceValue !== null ? Boolean(forceValue) : !Boolean(g.tempNoOmission);
            return {
              ...g,
              tempNoOmission: nextChecked,
              tempNoOmissionAt: nextChecked ? new Date().toISOString() : '',
            };
          });
          return { ...blk, groups };
        });
        return { ...proj, lastFocusedGroupId: groupId, blocks };
      });
      showToast(
        nextChecked
          ? '一時記録：この枠に「訳漏れなし」を記録しました'
          : '「訳漏れなし」の一時記録を解除しました',
      );
    },
    addSentenceMarker(blockId, lang, sentenceId, start, end, toastMsg = 'マーカを付けました') {
      mutateBlock(blockId, (blk) =>
        updateSentenceMarkersInBlock(blk, lang, sentenceId, (prev, maxLen) =>
          addMarkerRange(prev, start, end, maxLen),
        ),
      );
      if (toastMsg) showToast(toastMsg);
    },
    removeSentenceMarker(blockId, lang, sentenceId, start, end) {
      mutateBlock(blockId, (blk) =>
        updateSentenceMarkersInBlock(blk, lang, sentenceId, (prev, maxLen) =>
          removeMarkerRange(prev, start, end, maxLen),
        ),
      );
      showToast('選択範囲のマーカを解除しました');
    },
    clearSentenceMarkers(blockId, lang, sentenceId) {
      mutateBlock(blockId, (blk) =>
        updateSentenceMarkersInBlock(blk, lang, sentenceId, () => []),
      );
      showToast('この文のマーカをすべて解除しました');
    },
    toggleClauseWorkbench(groupId, forceOpen = null) {
      const next = new Set(state.openClauseGroupIds);
      const shouldOpen = forceOpen !== null ? forceOpen : !next.has(groupId);
      if (shouldOpen) next.add(groupId);
      else next.delete(groupId);
      state.openClauseGroupIds = next;
      notify();
    },
    addClausePair(blockId, groupId, { enSpan = null, jaSpan = null } = {}) {
      let createdId = null;
      const nextOpen = new Set(state.openClauseGroupIds);
      nextOpen.add(groupId);
      state.openClauseGroupIds = nextOpen;
      state.selectedGroupId = groupId;
      mutateBlock(blockId, (blk) => {
        const res = addClausePairInGroup(blk, groupId, { enSpan, jaSpan });
        createdId = res.pairId;
        return res.block;
      });
      if (createdId) {
        showToast('文節対比ペアを追加しました（対になる文節を選んで見比べできます）');
      }
      return createdId;
    },
    attachSpanToClausePair(blockId, groupId, pairId, lang, span) {
      const nextOpen = new Set(state.openClauseGroupIds);
      nextOpen.add(groupId);
      state.openClauseGroupIds = nextOpen;
      state.selectedGroupId = groupId;
      mutateBlock(blockId, (blk) => attachSpanToClausePairInGroup(blk, groupId, pairId, lang, span));
      showToast(lang === 'ja' ? '和文の文節をペアに紐付けました' : '英文の文節をペアに紐付けました');
    },
    toggleClausePairChecked(blockId, groupId, pairId, forceVal = null) {
      mutateBlock(blockId, (blk) =>
        toggleClausePairCheckedInGroup(blk, groupId, pairId, forceVal),
      );
    },
    updateClausePairNote(blockId, groupId, pairId, note) {
      mutateBlock(blockId, (blk) => updateClausePairNoteInGroup(blk, groupId, pairId, note));
    },
    removeClausePair(blockId, groupId, pairId) {
      mutateBlock(blockId, (blk) => removeClausePairInGroup(blk, groupId, pairId));
    },
    clearClausePairs(blockId, groupId) {
      mutateBlock(blockId, (blk) => clearClausePairsInGroup(blk, groupId));
      const nextOpen = new Set(state.openClauseGroupIds);
      nextOpen.delete(groupId);
      state.openClauseGroupIds = nextOpen;
      notify();
      showToast('文節対比の一時分割をクリアしました');
    },
    startEditSentence(blockId, lang, sentenceId) {
      state.editingSentenceTarget = { blockId, lang, sentenceId };
      notify();
    },
    cancelEditSentence() {
      state.editingSentenceTarget = null;
      notify();
    },
    saveEditedSentenceText(blockId, lang, sentenceId, newRawText) {
      const clean = String(newRawText || '').trim();
      if (!clean) {
        showToast('空文にはできません（削除する場合は文の結合等をご利用ください）', true);
        return;
      }
      mutateBlock(blockId, (blk) => updateSentenceTextInBlock(blk, lang, sentenceId, clean), true);
      state.editingSentenceTarget = null;
      showToast('文のテキストを更新しました（他の対応関係はそのまま維持されています）');
    },
    async setBlockAllStatus(blockId, status) {
      mutateBlock(
        blockId,
        (blk) => {
          const groups = blk.groups.map((g) => ({
            ...g,
            status,
            confirmedAlignment: status === 'verified' ? true : g.confirmedAlignment,
          }));
          return syncBlockMeta({ ...blk, groups });
        },
        true,
      );
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
      const projSplit = Boolean(getActiveProject()?.splitInsideList);
      mutateBlock(
        blockId,
        (blk) => swapBlockSides(blk, state.abbreviations, { splitInsideList: blk.splitInsideList ?? projSplit }),
        true,
      );
      showToast('ブロックの英語・日本語を入れ替えました');
    },
    mergeBlockWithFollowing(blockIndex) {
      updateActiveProject((proj) => {
        const blocks = mergeWithNextBlock(proj.blocks, blockIndex, state.abbreviations, {
          splitInsideList: Boolean(proj.splitInsideList),
        });
        return { ...proj, blocks };
      }, true);
      showToast('次のブロックと結合しました');
    },
    realignBlock(blockId, useHintDp = true, splitInsideList = null) {
      const projSplit = Boolean(getActiveProject()?.splitInsideList);
      mutateBlock(
        blockId,
        (blk) =>
          realignBlockWithHints(blk, state.abbreviations, useHintDp, {
            splitInsideList:
              splitInsideList !== null ? Boolean(splitInsideList) : blk.splitInsideList ?? projSplit,
          }),
        true,
      );
      if (splitInsideList !== null) {
        showToast(
          splitInsideList
            ? '番号・箇条書き行内も文末（。/.）で再分割しました'
            : '番号・箇条書きを行単位の分割に戻しました',
        );
      } else {
        showToast(useHintDp ? 'ヒントを使って自動整列しました' : '先頭から1対1に再整列しました');
      }
    },
    toggleBlockJaEditor(blockId, forceOpen = null) {
      const next = new Set(state.editingJaBlockIds);
      const shouldOpen = forceOpen !== null ? forceOpen : !next.has(blockId);
      if (shouldOpen) next.add(blockId);
      else next.delete(blockId);
      state.editingJaBlockIds = next;
      notify();
    },
    updateBlockJapanese(blockId, jaText, splitInsideList = null) {
      const projSplit = Boolean(getActiveProject()?.splitInsideList);
      mutateBlock(
        blockId,
        (blk) =>
          updateBlockJapaneseText(blk, jaText, {
            splitInsideList:
              splitInsideList !== null ? Boolean(splitInsideList) : blk.splitInsideList ?? projSplit,
          }),
        true,
      );
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
      const projSplit = Boolean(getActiveProject()?.splitInsideList);
      mutateBlock(
        blockId,
        (blk) =>
          insertTextIntoGroup(blk, groupId, lang, clean, state.abbreviations, {
            splitInsideList: blk.splitInsideList ?? projSplit,
          }),
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
              splitInsideList: blk.splitInsideList ?? Boolean(proj.splitInsideList),
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
    async removeTmRecord(recordId) {
      await deleteTmRecord(recordId);
      state.tmRecords = state.tmRecords.filter((r) => r.id !== recordId);
      state.tmRevision += 1;
      showToast('旧翻訳メモリ記録を削除しました');
      notify();
    },
    async clearTm() {
      await clearAllTmRecords();
      state.tmRecords = [];
      state.tmRevision += 1;
      showToast('旧・文単位TM記録を削除しました');
      notify();
    },
  };
}
