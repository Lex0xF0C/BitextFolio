/**
 * Local JSON export/import and UTF-8 text file reading utilities.
 * Zero network calls.
 */

const EXPORT_SCHEMA_VERSION = 1;

export function buildProjectExportPayload(project) {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    type: 'single_project',
    projects: [project],
  };
}

export function buildAllProjectsExportPayload(projects, settings = {}, glossary = [], tmRecords = []) {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    type: 'workspace_backup',
    settings,
    glossary,
    tmRecords,
    projects,
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
 * Validates and normalizes imported JSON text.
 * @param {string} jsonText
 */
export function parseImportedJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('JSONの構文が正しくありません。UTF-8のJSONファイルを選択してください。');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSONの形式が想定と異なります。');
  }

  let projects = [];
  if (Array.isArray(parsed.projects)) {
    projects = parsed.projects;
  } else if (parsed.id && Array.isArray(parsed.blocks)) {
    projects = [parsed];
  } else {
    throw new Error('有効なドキュメントデータ（projects配列またはblocks配列）が見つかりません。');
  }

  for (const proj of projects) {
    if (!proj || typeof proj.id !== 'string' || !Array.isArray(proj.blocks)) {
      throw new Error('ドキュメント項目に必須フィールド（id, blocks）が不足しています。');
    }
  }

  return {
    projects,
    settings: parsed.settings || null,
    glossary: Array.isArray(parsed.glossary) ? parsed.glossary : null,
    tmRecords: Array.isArray(parsed.tmRecords) ? parsed.tmRecords : null,
  };
}

/**
 * Reads a File object as UTF-8 text.
 * @param {File} file
 * @returns {Promise<string>}
 */
export function readFileAsUtf8(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました。'));
    reader.readAsText(file, 'UTF-8');
  });
}
