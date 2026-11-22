/**
 * Local JSON export/import and UTF-8 text file reading utilities.
 * Zero network calls.
 */

import {
  CURRENT_SCHEMA_VERSION,
  migrateProject,
  parseAndValidateImportPayload,
} from '../core/schema.js';

export function buildProjectExportPayload(project) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    type: 'single_project',
    projects: [migrateProject(project)],
  };
}

export function buildAllProjectsExportPayload(projects, settings = {}, glossary = [], tmRecords = []) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    type: 'workspace_backup',
    settings,
    glossary,
    tmRecords,
    projects: (projects || []).map((p) => migrateProject(p)),
  };
}

export function triggerTextDownload(filename, textContent, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([textContent], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function triggerJsonDownload(filename, dataObject) {
  const jsonText = JSON.stringify(dataObject, null, 2);
  triggerTextDownload(filename, jsonText, 'application/json;charset=utf-8');
}

/**
 * Validates against BitextFolio JSON Schema rules, migrates stepwise (vN -> vN+1),
 * and normalizes imported JSON text.
 * @param {string} jsonText
 */
export function parseImportedJson(jsonText) {
  return parseAndValidateImportPayload(jsonText);
}

/**
 * Reads a File object as UTF-8 text.
 * @param {File} file
 * @returns {Promise<string>}
 */
export function readFileAsUtf8(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').replace(/^\uFEFF/, ''));
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました。'));
    reader.readAsText(file, 'UTF-8');
  });
}
