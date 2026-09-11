import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(testDirectory, '..', 'static', 'app.js'), 'utf8');
const themesSource = fs.readFileSync(path.join(testDirectory, '..', 'static', 'themes.js'), 'utf8');
const markedSource = fs.readFileSync(path.join(testDirectory, '..', 'static', 'marked.min.js'), 'utf8');
const mergeSource = fs.readFileSync(path.join(testDirectory, '..', 'static', 'merge.js'), 'utf8');

const testHookSource = `
globalThis.__vylkTestHooks = {
  saveCurrentNote,
  queueOperation,
  flushPendingChanges,
  quarantineQueueOperation,
  saveLocalNoteAndQueue,
  toggleNotePin,
  getLocalNotes,
  pendingOperations,
  pendingOperationsForNote,
  claimQueueOperation,
  removePendingOperationIfIdentityMatches,
  withSyncLeadership,
  registerServiceWorker,
  acknowledgeCompactedOperation,
  applySyncAcknowledgement,
  applyRemoteSnapshot,
  removeLocalNoteAndSupersede,
  savePref,
  applyFonts,
  loadPrefs,
  applyRemoteDeletion,
  applyRemoteChangePage,
  getLocalNote,
  getOfflineDatabaseInfo,
  getOfflineState,
  clearOfflineData,
  api,
  cancelActiveSyncRequests,
  scheduleSync,
  syncNow,
  handleServerChangeEvent,
  putLocalNote,
  init,
  restoreRoute,
  getState: () => ({
    currentNoteId,
    currentRevision,
    currentBaseRevision,
    isDirty,
    savedSnapshot: {...savedSnapshot},
    editorSessionGeneration,
  }),
  setEditorState(state = {}) {
    editorSessionGeneration++;
    currentNoteId = state.id ?? null;
    currentRevision = state.revision ?? 0;
    currentBaseRevision = state.baseRevision ?? null;
    isDirty = state.dirty ?? false;
    savedSnapshot = {...(state.savedSnapshot || {title: '', tags: '', content: ''})};
    $('#note-title').value = state.title ?? savedSnapshot.title ?? '';
    $('#note-tags').value = state.tags ?? savedSnapshot.tags ?? '';
    $('#note-content').value = state.content ?? savedSnapshot.content ?? '';
  },
  markDirty,
  showNoteInEditor,
  updatePreview,
  highlightBlock,
  calculatePreviewScrollAdjustment,
  closeDatabase: async () => {
    const db = offlineDBPromise && await offlineDBPromise;
    db?.close();
  },
  cancelScheduledSync: () => {
    if (syncScheduleTimer) clearTimeout(syncScheduleTimer);
    syncScheduleTimer = null;
    syncScheduleOptions = {};
  },
  getSyncScheduleState: () => ({
    scheduled: Boolean(syncScheduleTimer),
    options: {...syncScheduleOptions},
  }),
};
`;

const deferredSaveCall = "await saveLocalNoteAndQueue(local, {type: 'note.save', note_id: snapshot.noteID, base_revision: baseRevision, note: local});";
const deferredSaveReplacement = "await globalThis.__testSaveLocalNoteAndQueue(local, {type: 'note.save', note_id: snapshot.noteID, base_revision: baseRevision, note: local});";
const syncCompletionCall = "    localStorage.setItem('vylk-offline-ready', '1');";
const syncCompletionReplacement = "    await globalThis.__testBeforeSyncCompletion();\n    localStorage.setItem('vylk-offline-ready', '1');";

function response(status, body = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 404 ? 'Not Found' : status === 503 ? 'Service Unavailable' : 'OK',
    text: async () => body,
    json: async () => typeof body === 'string' ? JSON.parse(body || '{}') : body,
  };
}

export async function deleteOfflineDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('vylk-offline');
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('offline test database is blocked'));
  });
}

export async function createApp({deferredSave = false, deferredSyncCompletion = false, fetchImpl = async () => response(200, '{}'), serviceWorker = null, realMarked = false, realMerge = false} = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(testDirectory, '..', 'static', 'index.html'), 'utf8'), {
    url: 'http://localhost:8080/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const {window} = dom;
  window.indexedDB = indexedDB;
  window.IDBKeyRange = IDBKeyRange;
  window.fetch = fetchImpl;
  if (serviceWorker) Object.defineProperty(window.navigator, 'serviceWorker', {value: serviceWorker, configurable: true});
  window.eval(themesSource);
  if (realMerge) window.eval(mergeSource);
  if (realMarked) {
    window.eval(markedSource);
  } else {
    window.marked = {parse: () => ''};
  }
  window.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}});
  window.requestAnimationFrame = callback => window.setTimeout(callback, 0);
  window.cancelAnimationFrame = id => window.clearTimeout(id);
  window.scrollTo = () => {};
  Object.defineProperty(window.document, 'fonts', {value: {load: async () => {}}, configurable: true});

  let resolveFirstSaveStarted;
  let releaseFirstSave;
  const firstSaveStarted = new Promise(resolve => { resolveFirstSaveStarted = resolve; });
  const firstSaveGate = new Promise(resolve => { releaseFirstSave = resolve; });
  const saveCalls = [];
  if (deferredSave) {
    window.__testSaveLocalNoteAndQueue = async (note, operation) => {
      saveCalls.push({note: structuredClone(note), operation: structuredClone(operation)});
      if (saveCalls.length === 1) {
        resolveFirstSaveStarted();
        await firstSaveGate;
      }
    };
  }

  let resolveSyncCompletionStarted;
  let releaseSyncCompletion;
  const syncCompletionStarted = new Promise(resolve => { resolveSyncCompletionStarted = resolve; });
  const syncCompletionGate = new Promise(resolve => { releaseSyncCompletion = resolve; });
  let syncCompletionCalls = 0;
  if (deferredSyncCompletion) {
    window.__testBeforeSyncCompletion = async () => {
      syncCompletionCalls++;
      if (syncCompletionCalls !== 1) return;
      resolveSyncCompletionStarted();
      await syncCompletionGate;
    };
  }

  let source = appSource;
  if (deferredSave) {
    if (!source.includes(deferredSaveCall)) throw new Error('save call was not found for test instrumentation');
    source = source.replace(deferredSaveCall, deferredSaveReplacement);
  }
  if (deferredSyncCompletion) {
    if (!source.includes(syncCompletionCall)) throw new Error('sync completion marker was not found for test instrumentation');
    source = source.replace(syncCompletionCall, syncCompletionReplacement);
  }
  if (!source.includes('\ninit();\n')) throw new Error('app init marker was not found');
  source = source.replace('\ninit();\n', `\n${testHookSource}\n`);
  window.eval(source);

  return {
    window,
    hooks: window.__vylkTestHooks,
    saveCalls,
    firstSaveStarted,
    releaseFirstSave,
    syncCompletionStarted,
    releaseSyncCompletion,
    close: async () => {
      await window.__vylkTestHooks.closeDatabase();
      window.close();
    },
  };
}

export {response};
