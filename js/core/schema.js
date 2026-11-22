/**
 * Pure deterministic JSON Schema validation and stepwise schemaVersion migrations (vN -> vN+1).
 * Mirrors schemas/bitextfolio-export.schema.json without external runtime dependencies.
 * Zero DOM dependencies.
 */

import { syncBlockMeta } from './alignment.js';
import { DEFAULT_JA_NORM_OPTIONS } from './glossary.js';
import { buildBlockHashes } from './hash-diff.js';
import { normalizeMarkerRanges } from './markers.js';
import { stripInlineMarkup } from './markup.js';
import { DEFAULT_ABBREVIATIONS } from './sentence-splitter.js';

export const CURRENT_SCHEMA_VERSION = 2;

export const VALID_EXPORT_TYPES = new Set(['single_project', 'workspace_backup']);
export const VALID_GROUP_STATUSES = new Set([
  'unread',
  'read',
  'verified',
  'needs_review',
  'source_changed',
]);

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function isNonEmptyString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

function validateSentenceItem(item, path, errors) {
  if (!isPlainObject(item)) {
    errors.push(`${path} はオブジェクトである必要があります`);
    return;
  }
  if (!isNonEmptyString(item.id)) {
    errors.push(`${path}.id は空でない文字列である必要があります`);
  }
  if (typeof item.rawText !== 'string') {
    errors.push(`${path}.rawText は文字列である必要があります`);
  }
  if (item.plainText !== undefined && typeof item.plainText !== 'string') {
    errors.push(`${path}.plainText は文字列である必要があります`);
  }
  if (item.markers !== undefined) {
    if (!Array.isArray(item.markers)) {
      errors.push(`${path}.markers は配列である必要があります`);
    } else {
      item.markers.forEach((m, idx) => {
        if (
          !isPlainObject(m) ||
          !Number.isInteger(m.start) ||
          !Number.isInteger(m.end) ||
          m.start < 0 ||
          m.end <= m.start
        ) {
          errors.push(`${path}.markers[${idx}] は有効な { start, end } (0 <= start < end) である必要があります`);
        }
      });
    }
  }
}

function validateAlignmentGroup(group, path, errors) {
  if (!isPlainObject(group)) {
    errors.push(`${path} はオブジェクトである必要があります`);
    return;
  }
  if (!isNonEmptyString(group.id)) {
    errors.push(`${path}.id は空でない文字列である必要があります`);
  }
  if (!Array.isArray(group.enIds) || group.enIds.some((id) => !isNonEmptyString(id))) {
    errors.push(`${path}.enIds は文字列配列である必要があります`);
  }
  if (!Array.isArray(group.jaIds) || group.jaIds.some((id) => !isNonEmptyString(id))) {
    errors.push(`${path}.jaIds は文字列配列である必要があります`);
  }
  if (group.status !== undefined && !VALID_GROUP_STATUSES.has(group.status)) {
    errors.push(`${path}.status の値 "${String(group.status)}" は不正です`);
  }
  if (group.memo !== undefined && typeof group.memo !== 'string') {
    errors.push(`${path}.memo は文字列である必要があります`);
  }
  if (group.tempNoOmission !== undefined && typeof group.tempNoOmission !== 'boolean') {
    errors.push(`${path}.tempNoOmission は真偽値である必要があります`);
  }
  if (group.confirmedAlignment !== undefined && typeof group.confirmedAlignment !== 'boolean') {
    errors.push(`${path}.confirmedAlignment は真偽値である必要があります`);
  }
  if (group.clausePairs !== undefined) {
    if (!Array.isArray(group.clausePairs)) {
      errors.push(`${path}.clausePairs は配列である必要があります`);
    } else {
      group.clausePairs.forEach((cp, idx) => {
        if (!isPlainObject(cp) || !isNonEmptyString(cp.id)) {
          errors.push(`${path}.clausePairs[${idx}].id は空でない文字列である必要があります`);
        }
      });
    }
  }
}

function validateAlignmentBlock(block, path, errors) {
  if (!isPlainObject(block)) {
    errors.push(`${path} はオブジェクトである必要があります`);
    return;
  }
  if (!isNonEmptyString(block.id)) {
    errors.push(`${path}.id は空でない文字列である必要があります`);
  }
  if (block.index !== undefined && (!Number.isInteger(block.index) || block.index < 0)) {
    errors.push(`${path}.index は 0 以上の整数である必要があります`);
  }
  if (!Array.isArray(block.enSentences)) {
    errors.push(`${path}.enSentences は配列である必要があります`);
  } else {
    block.enSentences.forEach((s, i) => validateSentenceItem(s, `${path}.enSentences[${i}]`, errors));
  }
  if (!Array.isArray(block.jaSentences)) {
    errors.push(`${path}.jaSentences は配列である必要があります`);
  } else {
    block.jaSentences.forEach((s, i) => validateSentenceItem(s, `${path}.jaSentences[${i}]`, errors));
  }
  if (!Array.isArray(block.groups)) {
    errors.push(`${path}.groups は配列である必要があります`);
  } else {
    block.groups.forEach((g, i) => validateAlignmentGroup(g, `${path}.groups[${i}]`, errors));
  }
}

function validateProjectObject(proj, path, errors) {
  if (!isPlainObject(proj)) {
    errors.push(`${path} はオブジェクトである必要があります`);
    return;
  }
  if (!isNonEmptyString(proj.id)) {
    errors.push(`${path}.id は空でない文字列である必要があります`);
  }
  if (proj.title !== undefined && typeof proj.title !== 'string') {
    errors.push(`${path}.title は文字列である必要があります`);
  }
  if (proj.schemaVersion !== undefined) {
    if (!Number.isInteger(proj.schemaVersion) || proj.schemaVersion < 1) {
      errors.push(`${path}.schemaVersion は 1 以上の整数である必要があります`);
    } else if (proj.schemaVersion > CURRENT_SCHEMA_VERSION) {
      errors.push(
        `${path}.schemaVersion (${proj.schemaVersion}) は現在の対応版 (v${CURRENT_SCHEMA_VERSION}) より新しい形式です`,
      );
    }
  }
  if (!Array.isArray(proj.blocks)) {
    errors.push(`${path}.blocks は配列である必要があります`);
  } else {
    proj.blocks.forEach((b, i) => validateAlignmentBlock(b, `${path}.blocks[${i}]`, errors));
  }
  if (
    proj.abbreviations !== undefined &&
    (!Array.isArray(proj.abbreviations) || proj.abbreviations.some((a) => typeof a !== 'string'))
  ) {
    errors.push(`${path}.abbreviations は文字列配列である必要があります`);
  }
  if (proj.dismissedHints !== undefined && !isPlainObject(proj.dismissedHints)) {
    errors.push(`${path}.dismissedHints はオブジェクトである必要があります`);
  }
}

function validateGlossaryEntryObject(entry, path, errors) {
  if (!isPlainObject(entry)) {
    errors.push(`${path} はオブジェクトである必要があります`);
    return;
  }
  if (!isNonEmptyString(entry.id)) {
    errors.push(`${path}.id は空でない文字列である必要があります`);
  }
  if (!isNonEmptyString(entry.enHeadword)) {
    errors.push(`${path}.enHeadword は空でない文字列である必要があります`);
  }
  for (const listKey of ['enVariants', 'jaAccepted', 'jaDeprecated']) {
    if (
      entry[listKey] !== undefined &&
      (!Array.isArray(entry[listKey]) || entry[listKey].some((v) => typeof v !== 'string'))
    ) {
      errors.push(`${path}.${listKey} は文字列配列である必要があります`);
    }
  }
  for (const boolKey of ['caseSensitive', 'exactMatch']) {
    if (entry[boolKey] !== undefined && typeof entry[boolKey] !== 'boolean') {
      errors.push(`${path}.${boolKey} は真偽値である必要があります`);
    }
  }
}

/**
 * Validates an imported JSON payload against the BitextFolio JSON Schema rules.
 * Accepts enveloped exports (`{ schemaVersion?, type?, projects: [...] }`) and legacy bare projects (`{ id, blocks }`).
 * @param {unknown} rawPayload
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateExportPayload(rawPayload) {
  const errors = [];
  if (!isPlainObject(rawPayload)) {
    return { valid: false, errors: ['ルート要素は JSON オブジェクトである必要があります'] };
  }

  if (rawPayload.schemaVersion !== undefined) {
    if (!Number.isInteger(rawPayload.schemaVersion) || rawPayload.schemaVersion < 1) {
      errors.push('schemaVersion は 1 以上の整数である必要があります');
    } else if (rawPayload.schemaVersion > CURRENT_SCHEMA_VERSION) {
      errors.push(
        `未対応のスキーマバージョン (v${rawPayload.schemaVersion}) です。対応上限は v${CURRENT_SCHEMA_VERSION} です。`,
      );
    }
  }

  if (rawPayload.type !== undefined && !VALID_EXPORT_TYPES.has(rawPayload.type)) {
    errors.push(`type "${String(rawPayload.type)}" は single_project または workspace_backup である必要があります`);
  }

  const isBareProject =
    !Array.isArray(rawPayload.projects) &&
    typeof rawPayload.id === 'string' &&
    Array.isArray(rawPayload.blocks);

  if (isBareProject) {
    validateProjectObject(rawPayload, 'project', errors);
  } else if (Array.isArray(rawPayload.projects)) {
    if (rawPayload.projects.length === 0) {
      errors.push('projects 配列には 1 件以上のドキュメントが必要です');
    }
    rawPayload.projects.forEach((p, idx) => validateProjectObject(p, `projects[${idx}]`, errors));
  } else {
    errors.push('有効なドキュメントデータ（projects 配列、または id と blocks を持つ単一プロジェクト）が見つかりません');
  }

  if (rawPayload.glossary !== undefined) {
    if (!Array.isArray(rawPayload.glossary)) {
      errors.push('glossary は配列である必要があります');
    } else {
      rawPayload.glossary.forEach((g, idx) => validateGlossaryEntryObject(g, `glossary[${idx}]`, errors));
    }
  }

  if (rawPayload.settings !== undefined && rawPayload.settings !== null) {
    if (!isPlainObject(rawPayload.settings)) {
      errors.push('settings はオブジェクトである必要があります');
    } else {
      const s = rawPayload.settings;
      if (
        s.abbreviations !== undefined &&
        (!Array.isArray(s.abbreviations) || s.abbreviations.some((a) => typeof a !== 'string'))
      ) {
        errors.push('settings.abbreviations は文字列配列である必要があります');
      }
      if (s.jaNormOptions !== undefined && !isPlainObject(s.jaNormOptions)) {
        errors.push('settings.jaNormOptions はオブジェクトである必要があります');
      }
    }
  }

  if (rawPayload.tmRecords !== undefined && !Array.isArray(rawPayload.tmRecords)) {
    errors.push('tmRecords は配列である必要があります');
  }

  return { valid: errors.length === 0, errors };
}

function normalizeSentenceV2(sentence) {
  const rawText = String(sentence.rawText || '');
  const literalText = Boolean(sentence.literalText);
  const plainText =
    typeof sentence.plainText === 'string'
      ? sentence.plainText
      : literalText
        ? rawText
        : stripInlineMarkup(rawText);
  const normalized = {
    ...sentence,
    rawText,
    plainText,
    markers: normalizeMarkerRanges(sentence.markers || [], plainText.length),
  };
  if (literalText) {
    normalized.literalText = true;
  }
  return normalized;
}

function normalizeGroupV2(group) {
  const status = VALID_GROUP_STATUSES.has(group.status) ? group.status : 'unread';
  return {
    ...group,
    enIds: Array.isArray(group.enIds) ? [...group.enIds] : [],
    jaIds: Array.isArray(group.jaIds) ? [...group.jaIds] : [],
    status,
    memo: typeof group.memo === 'string' ? group.memo : '',
    previousMemoNote: typeof group.previousMemoNote === 'string' ? group.previousMemoNote : '',
    tempNoOmission: Boolean(group.tempNoOmission),
    tempNoOmissionAt: typeof group.tempNoOmissionAt === 'string' ? group.tempNoOmissionAt : '',
    confirmedAlignment: Boolean(group.confirmedAlignment),
    clausePairs: Array.isArray(group.clausePairs) ? [...group.clausePairs] : [],
  };
}

/**
 * Pure migration step: DocumentProject v1 (or unversioned legacy) -> v2.
 * @param {object} project
 * @returns {object}
 */
export function migrateProjectV1ToV2(project) {
  const blocks = (project.blocks || []).map((blk, idx) => {
    const enRaw = typeof blk.enRaw === 'string' ? blk.enRaw : '';
    const jaRaw = typeof blk.jaRaw === 'string' ? blk.jaRaw : '';
    const hashes =
      typeof blk.enHash === 'string' && typeof blk.jaHash === 'string'
        ? { enHash: blk.enHash, jaHash: blk.jaHash }
        : buildBlockHashes(enRaw, jaRaw);
    const enSentences = (blk.enSentences || []).map(normalizeSentenceV2);
    const jaSentences = (blk.jaSentences || []).map(normalizeSentenceV2);
    const groups = (blk.groups || []).map(normalizeGroupV2);

    return syncBlockMeta({
      ...blk,
      index: Number.isInteger(blk.index) ? blk.index : idx,
      enRaw,
      jaRaw,
      enLang: blk.enLang !== undefined ? blk.enLang : enRaw ? 'en' : null,
      jaLang: blk.jaLang !== undefined ? blk.jaLang : jaRaw ? 'ja' : null,
      enConfidence: typeof blk.enConfidence === 'number' ? blk.enConfidence : enRaw ? 1 : 0,
      jaConfidence: typeof blk.jaConfidence === 'number' ? blk.jaConfidence : jaRaw ? 1 : 0,
      splitInsideList: Boolean(blk.splitInsideList),
      warnings: Array.isArray(blk.warnings) ? [...blk.warnings] : [],
      enSentences,
      jaSentences,
      groups,
      ...hashes,
    });
  });

  const now = new Date().toISOString();
  const normalizedDismissed = {};
  if (isPlainObject(project.dismissedHints)) {
    for (const [k, v] of Object.entries(project.dismissedHints)) {
      if (v) normalizedDismissed[k] = true;
    }
  }

  return {
    ...project,
    schemaVersion: 2,
    title: typeof project.title === 'string' && project.title.trim() ? project.title : '無題の対訳ドキュメント',
    createdAt: typeof project.createdAt === 'string' ? project.createdAt : now,
    updatedAt: typeof project.updatedAt === 'string' ? project.updatedAt : now,
    rawSourceText: typeof project.rawSourceText === 'string' ? project.rawSourceText : '',
    abbreviations:
      Array.isArray(project.abbreviations) && project.abbreviations.length > 0
        ? [...project.abbreviations]
        : [...DEFAULT_ABBREVIATIONS],
    splitInsideList: Boolean(project.splitInsideList),
    lastFocusedGroupId:
      project.lastFocusedGroupId !== undefined
        ? project.lastFocusedGroupId
        : blocks[0]?.groups[0]?.id || null,
    dismissedHints: normalizedDismissed,
    blocks,
  };
}

function normalizeGlossaryEntryV2(entry) {
  return {
    ...entry,
    enVariants: Array.isArray(entry.enVariants) ? [...entry.enVariants] : [],
    jaAccepted: Array.isArray(entry.jaAccepted) ? [...entry.jaAccepted] : [],
    jaDeprecated: Array.isArray(entry.jaDeprecated) ? [...entry.jaDeprecated] : [],
    caseSensitive: Boolean(entry.caseSensitive),
    exactMatch: Boolean(entry.exactMatch),
    notes: typeof entry.notes === 'string' ? entry.notes : '',
  };
}

/**
 * Pure migration step: ExportPayload v1 (or bare legacy project) -> v2.
 * @param {object} payload
 * @returns {object}
 */
export function migrateExportPayloadV1ToV2(payload) {
  const isBareProject =
    !Array.isArray(payload.projects) &&
    typeof payload.id === 'string' &&
    Array.isArray(payload.blocks);

  const rawProjects = isBareProject ? [payload] : payload.projects || [];
  const projects = rawProjects.map((p) => migrateProjectV1ToV2(p));
  const type = VALID_EXPORT_TYPES.has(payload.type)
    ? payload.type
    : projects.length > 1 || payload.settings || payload.glossary
      ? 'workspace_backup'
      : 'single_project';

  const out = {
    schemaVersion: 2,
    exportedAt: typeof payload.exportedAt === 'string' ? payload.exportedAt : new Date().toISOString(),
    type,
    projects,
  };

  if (isPlainObject(payload.settings)) {
    out.settings = {
      abbreviations: Array.isArray(payload.settings.abbreviations)
        ? [...payload.settings.abbreviations]
        : [...DEFAULT_ABBREVIATIONS],
      jaNormOptions: {
        ...DEFAULT_JA_NORM_OPTIONS,
        ...(isPlainObject(payload.settings.jaNormOptions) ? payload.settings.jaNormOptions : {}),
      },
    };
  }
  if (Array.isArray(payload.glossary)) {
    out.glossary = payload.glossary.map(normalizeGlossaryEntryV2);
  }
  if (Array.isArray(payload.tmRecords)) {
    out.tmRecords = [...payload.tmRecords];
  }

  return out;
}

export const PROJECT_MIGRATION_STEPS = {
  1: migrateProjectV1ToV2,
};

export const PAYLOAD_MIGRATION_STEPS = {
  1: migrateExportPayloadV1ToV2,
};

/**
 * Migrates a single DocumentProject stepwise from its schemaVersion (default 1) to CURRENT_SCHEMA_VERSION.
 * @param {object} rawProject
 * @returns {object}
 */
export function migrateProject(rawProject) {
  if (!isPlainObject(rawProject)) {
    throw new Error('ドキュメントオブジェクトが不正です');
  }
  let version = Number.isInteger(rawProject.schemaVersion) ? rawProject.schemaVersion : 1;
  if (version < 1 || version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`未対応のプロジェクト schemaVersion: ${version}`);
  }
  let current = { ...rawProject };
  while (version < CURRENT_SCHEMA_VERSION) {
    const stepFn = PROJECT_MIGRATION_STEPS[version];
    if (!stepFn) {
      throw new Error(`schemaVersion v${version} -> v${version + 1} のマイグレーションが見つかりません`);
    }
    current = stepFn(current);
    version += 1;
  }
  return current;
}

/**
 * Migrates an export payload stepwise from its schemaVersion (default 1) to CURRENT_SCHEMA_VERSION.
 * @param {object} rawPayload
 * @returns {{ payload: object, migratedFromVersion: number, migrated: boolean }}
 */
export function migrateExportPayload(rawPayload) {
  if (!isPlainObject(rawPayload)) {
    throw new Error('エクスポートペイロードがオブジェクトではありません');
  }
  const initialVersion = Number.isInteger(rawPayload.schemaVersion) ? rawPayload.schemaVersion : 1;
  if (initialVersion < 1 || initialVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `未対応のスキーマバージョン (v${initialVersion}) です。対応範囲は v1〜v${CURRENT_SCHEMA_VERSION} です。`,
    );
  }
  let version = initialVersion;
  let current = { ...rawPayload };
  while (version < CURRENT_SCHEMA_VERSION) {
    const stepFn = PAYLOAD_MIGRATION_STEPS[version];
    if (!stepFn) {
      throw new Error(`schemaVersion v${version} -> v${version + 1} のマイグレーションが見つかりません`);
    }
    current = stepFn(current);
    version += 1;
  }
  return {
    payload: current,
    migratedFromVersion: initialVersion,
    migrated: initialVersion < CURRENT_SCHEMA_VERSION,
  };
}

/**
 * Parses UTF-8 JSON text, validates against the deterministic schema checker,
 * and migrates stepwise to CURRENT_SCHEMA_VERSION.
 * @param {string} jsonText
 */
export function parseAndValidateImportPayload(jsonText) {
  let parsed;
  try {
    const cleanJson = String(jsonText || '').replace(/^\uFEFF/, '');
    parsed = JSON.parse(cleanJson);
  } catch {
    throw new Error('JSONの構文が正しくありません。UTF-8のJSONファイルを選択してください。');
  }

  const validation = validateExportPayload(parsed);
  if (!validation.valid) {
    throw new Error(`JSONスキーマ検証エラー: ${validation.errors[0]}`);
  }

  const { payload, migratedFromVersion, migrated } = migrateExportPayload(parsed);

  return {
    schemaVersion: payload.schemaVersion,
    migratedFromVersion,
    migrated,
    projects: payload.projects,
    settings: payload.settings || null,
    glossary: Array.isArray(payload.glossary) ? payload.glossary : null,
    tmRecords: Array.isArray(payload.tmRecords) ? payload.tmRecords : null,
  };
}
