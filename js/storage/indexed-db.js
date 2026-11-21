/**
 * Local-only IndexedDB persistence layer for multi-document storage and app settings.
 * Includes safe localStorage fallback if IndexedDB is unavailable.
 */

const DB_NAME = 'bilingual_review_workbench_v1';
const DB_VERSION = 3;
const STORE_PROJECTS = 'projects';
const STORE_SETTINGS = 'settings';
const STORE_GLOSSARY = 'glossary';
const STORE_TM = 'tm';
const FALLBACK_KEY = 'bilingual_review_workbench_fallback_v1';

let dbPromise = null;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_GLOSSARY)) {
        db.createObjectStore(STORE_GLOSSARY, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_TM)) {
        db.createObjectStore(STORE_TM, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });
  return dbPromise;
}

function readFallback() {
  try {
    const raw = localStorage.getItem(FALLBACK_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      projects: parsed.projects || {},
      settings: parsed.settings || {},
      glossary: parsed.glossary || {},
      tm: parsed.tm || {},
    };
  } catch {
    return { projects: {}, settings: {}, glossary: {}, tm: {} };
  }
}

function writeFallback(data) {
  try {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(data));
  } catch {
    // Ignore quota errors in fallback
  }
}

function runTx(storeName, mode, executor) {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const req = executor(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function listProjects() {
  try {
    const items = await runTx(STORE_PROJECTS, 'readonly', (s) => s.getAll());
    return (items || []).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  } catch {
    const fb = readFallback();
    return Object.values(fb.projects).sort((a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || ''),
    );
  }
}

export async function saveProject(project) {
  const stamped = { ...project, updatedAt: new Date().toISOString() };
  try {
    await runTx(STORE_PROJECTS, 'readwrite', (s) => s.put(stamped));
    return stamped;
  } catch {
    const fb = readFallback();
    fb.projects[stamped.id] = stamped;
    writeFallback(fb);
    return stamped;
  }
}

export async function deleteProject(projectId) {
  try {
    await runTx(STORE_PROJECTS, 'readwrite', (s) => s.delete(projectId));
  } catch {
    const fb = readFallback();
    delete fb.projects[projectId];
    writeFallback(fb);
  }
}

export async function getSetting(key, defaultValue = null) {
  try {
    const row = await runTx(STORE_SETTINGS, 'readonly', (s) => s.get(key));
    return row ? row.value : defaultValue;
  } catch {
    const fb = readFallback();
    return key in fb.settings ? fb.settings[key] : defaultValue;
  }
}

export async function setSetting(key, value) {
  try {
    await runTx(STORE_SETTINGS, 'readwrite', (s) => s.put({ key, value }));
  } catch {
    const fb = readFallback();
    fb.settings[key] = value;
    writeFallback(fb);
  }
}

export async function listGlossaryEntries() {
  try {
    const items = await runTx(STORE_GLOSSARY, 'readonly', (s) => s.getAll());
    return (items || []).sort((a, b) => (a.enHeadword || '').localeCompare(b.enHeadword || ''));
  } catch {
    const fb = readFallback();
    return Object.values(fb.glossary).sort((a, b) =>
      (a.enHeadword || '').localeCompare(b.enHeadword || ''),
    );
  }
}

export async function saveGlossaryEntry(entry) {
  try {
    await runTx(STORE_GLOSSARY, 'readwrite', (s) => s.put(entry));
    return entry;
  } catch {
    const fb = readFallback();
    fb.glossary[entry.id] = entry;
    writeFallback(fb);
    return entry;
  }
}

export async function deleteGlossaryEntry(entryId) {
  try {
    await runTx(STORE_GLOSSARY, 'readwrite', (s) => s.delete(entryId));
  } catch {
    const fb = readFallback();
    delete fb.glossary[entryId];
    writeFallback(fb);
  }
}

export async function clearAllGlossaryEntries() {
  try {
    await runTx(STORE_GLOSSARY, 'readwrite', (s) => s.clear());
  } catch {
    const fb = readFallback();
    fb.glossary = {};
    writeFallback(fb);
  }
}

export async function listTmRecords() {
  try {
    const items = await runTx(STORE_TM, 'readonly', (s) => s.getAll());
    return (items || []).sort((a, b) => (b.verifiedAt || '').localeCompare(a.verifiedAt || ''));
  } catch {
    const fb = readFallback();
    return Object.values(fb.tm || {}).sort((a, b) =>
      (b.verifiedAt || '').localeCompare(a.verifiedAt || ''),
    );
  }
}

export async function saveTmRecord(record) {
  try {
    await runTx(STORE_TM, 'readwrite', (s) => s.put(record));
    return record;
  } catch {
    const fb = readFallback();
    fb.tm = fb.tm || {};
    fb.tm[record.id] = record;
    writeFallback(fb);
    return record;
  }
}

export async function deleteTmRecord(recordId) {
  try {
    await runTx(STORE_TM, 'readwrite', (s) => s.delete(recordId));
  } catch {
    const fb = readFallback();
    if (fb.tm) delete fb.tm[recordId];
    writeFallback(fb);
  }
}

export async function clearAllTmRecords() {
  try {
    await runTx(STORE_TM, 'readwrite', (s) => s.clear());
  } catch {
    const fb = readFallback();
    fb.tm = {};
    writeFallback(fb);
  }
}
