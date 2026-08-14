(function(){
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const bootScreen = $('#boot-screen');
if (bootScreen) bootScreen.hidden = false;

const screens = {
  login: $('#login-screen'),
  dashboard: $('#dashboard'),
  editor: $('#editor'),
};

let currentNoteId = null;
let currentTag = null;
let isDirty = false;
let panelState = 'both';
let savedSnapshot = { title: '', tags: '', content: '' };
let editorSessionGeneration = 0;
const DEFAULT_PREFS = {revision:1, autoSave:true, hidePreview:false, hideHeaderOnFullscreen:false, hideToolbar:false, collapseDetails:false, hideCursorHighlight:false, theme:'default-light', accentColor:'', fontFamily:'system-sans', editorFontFamily:'system-monospace', previewFontFamily:'system-sans'};
const FONT_OPTIONS = ['Inter', 'Roboto', 'Rubik', 'DM Sans', 'Spectral', 'Newsreader', 'Plus Jakarta Sans', 'Google Sans'];
const FONT_CACHE_NAME = 'mdnotes-fonts';
const SYSTEM_FONT_STACK = 'ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
const SYSTEM_SERIF_STACK = 'ui-serif,Georgia,Cambria,"Times New Roman",Times,serif';
const SYSTEM_MONO_STACK = 'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace';
const SYSTEM_FONT_OPTIONS = [{value:'system-sans',label:'System (Sans)'}, {value:'system-serif',label:'System (Serif)'}, {value:'system-monospace',label:'System (Monospace)'}];
let prefs = {...DEFAULT_PREFS};
let fontAvailability = 'checking';
let fontAvailabilityPromise = null;
let fontLoadGeneration = 0;
let fontApplyQueue = Promise.resolve();
let renderedPreviewSource = null;
let previewCheckFrame = null;
let highlightFrame = null;
let currentRevision = 0;
let currentBaseRevision = null;
let syncInFlight = false;
let syncScheduleTimer = null;
let syncScheduleOptions = {};
let syncRetryDelayMs = 0;
let activeSyncControllers = new Set();
let syncCancellationRequested = false;
let lastSuccessfulSyncAt = 0;
let syncNetworkRequestsInFlight = 0;
let offlineStorageFailureReported = false;
let lastSyncProblem = '';
let lastSyncDiagnostic = '';
let lastSyncResponseStatus = 0;
let authenticationRequired = false;
const syncTabID = `tab_${newLocalNoteID()}`;
const syncLeaseKey = 'syncLease';
const syncLeaseDurationMs = 60000;
let syncCoordinationChannel = null;
let syncLeaseRenewTimer = null;
let panelRatio = Math.min(.8, Math.max(.2, Number(localStorage.getItem('mdnotes-panel-ratio')) || .5));
let panelWide = false;
let appVersionAtLoad = localStorage.getItem('mdnotes-version') || null;
let appRevisionAtLoad = localStorage.getItem('mdnotes-revision') || null;
let registeredServiceWorkerRevision = null;
let updateToast = null;

const httpRequestTimeoutMs = 15000;
const syncRetryDelaysMs = [1000, 5000, 15000, 60000, 300000];
const bulkNoteBatchSize = 25;
const healthySseFallbackSyncAgeMs = 5 * 60 * 1000;
const unhealthySseFallbackSyncAgeMs = 30 * 1000;

// Notes are stored locally before any network request. The service worker keeps
// the app shell available, while IndexedDB holds the user's working set and a
// durable queue of mutations to replay after connectivity returns.
const offlineDBName = 'mdnotes-offline';
const offlineDBVersion = 3;
let offlineDBPromise;

const syncOperationIDPattern = /^[A-Za-z0-9_-]{1,128}$/;
const noteRouteIDPattern = /^[A-Za-z0-9_-]{1,64}$/;

function noteIDFromLocation() {
  try {
    const id = decodeURIComponent(window.location.pathname.slice(1));
    return noteRouteIDPattern.test(id) ? id : null;
  } catch (_) {
    return null;
  }
}

function setNoteRoute(noteID, {replace = false} = {}) {
  const path = `/${encodeURIComponent(noteID)}`;
  if (window.location.pathname === path && !window.location.search && !window.location.hash) return;
  history[replace ? 'replaceState' : 'pushState']({noteID}, '', path);
}

function setDashboardRoute({replace = false} = {}) {
  if (window.location.pathname === '/' && !window.location.search && !window.location.hash) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', '/');
}

function openOfflineDB() {
  if (offlineDBPromise) return offlineDBPromise;
  offlineDBPromise = new Promise((resolve, reject) => {
    // Do not request a fixed database version here. A browser may have a
    // newer local schema from a prior build; opening it with an older version
    // fails before the app can read its offline notes.
    const request = indexedDB.open(offlineDBName, offlineDBVersion);
    request.onupgradeneeded = event => {
      const db = request.result;
      if (event.oldVersion < 1 && !db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', {keyPath: 'id'});
      }
      if (event.oldVersion < 1 && !db.objectStoreNames.contains('queue')) {
        const queue = db.createObjectStore('queue', {keyPath: 'id', autoIncrement: true});
        queue.createIndex('note_id', 'note_id', {unique: false});
      }
      if (event.oldVersion < 1 && !db.objectStoreNames.contains('state')) {
        db.createObjectStore('state', {keyPath: 'key'});
      }
      if (event.oldVersion < 3 && db.objectStoreNames.contains('queue')) {
        const queue = event.target.transaction.objectStore('queue');
        if (!queue.indexNames.contains('note_id')) queue.createIndex('note_id', 'note_id', {unique: false});
        if (!queue.indexNames.contains('client_sequence')) queue.createIndex('client_sequence', 'client_sequence', {unique: false});
      }
    };
    request.onsuccess = async () => {
      request.result.onversionchange = () => {
        request.result.close();
        offlineDBPromise = undefined;
      };
      try {
        await repairOfflineQueue(request.result);
        resolve(request.result);
      } catch (error) {
        request.result.close();
        offlineDBPromise = undefined;
        reportOfflineStorageFailure(error);
        reject(error);
      }
    };
    request.onerror = () => {
      offlineDBPromise = undefined;
      const error = request.error?.name === 'VersionError'
        ? new Error('offline data was created by a newer app version')
        : request.error;
      reportOfflineStorageFailure(error);
      reject(error);
    };
    request.onblocked = () => showToast('Close other app tabs to update local storage.', 'warning');
  });
  return offlineDBPromise;
}

function reportOfflineStorageFailure(error) {
  setSyncDiagnostic(`local storage unavailable: ${error?.message || 'unknown error'}`);
  if (offlineStorageFailureReported) return;
  offlineStorageFailureReported = true;
  showToast('Local storage is unavailable. Your changes may not be saved.', 'warning');
}

// A previous development build could leave an operation without the replay
// metadata introduced in version 2. Repair it in place: the note snapshot is
// kept, and the operation can be acknowledged normally instead of making a
// healthy server look offline forever.
async function repairOfflineQueue(db) {
  if (!db.objectStoreNames.contains('queue') || !db.objectStoreNames.contains('state')) {
    throw new Error('offline database is missing required stores');
  }

  // Repair in two cursor passes instead of loading the complete queue into
  // memory. The queue can contain a large backlog after a long offline period.
  let largestSequence = 0;
  await withQueueCursor(db, 'readonly', operation => {
    if (Number.isSafeInteger(operation.client_sequence) && operation.client_sequence > largestSequence) {
      largestSequence = operation.client_sequence;
    }
  });

  const transaction = db.transaction(['queue', 'state'], 'readwrite');
  const queue = transaction.objectStore('queue');
  const state = transaction.objectStore('state');
  const complete = transactionComplete(transaction);
  const savedSequenceRequest = state.get('clientSequence');
  savedSequenceRequest.onsuccess = () => {
    const previousSequence = Number(savedSequenceRequest.result?.value || 0);
    largestSequence = Math.max(largestSequence, previousSequence);
    const cursorRequest = queue.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        const operation = cursor.value;
        if (!Number.isSafeInteger(operation.client_sequence) || operation.client_sequence < 1) {
          operation.client_sequence = ++largestSequence;
        }
        if (!syncOperationIDPattern.test(operation.op_id || '')) operation.op_id = `legacy-${operation.id}`;
        if (operation.type === 'save') operation.type = 'note.save';
        if (operation.type === 'delete') operation.type = 'note.delete';
        if (operation.type === 'preferences') operation.type = 'prefs.save';
        if (!operation.type) operation.type = operation.kind === 'save' ? 'note.save' : operation.kind === 'delete' ? 'note.delete' : 'prefs.save';
        if (operation.type === 'note.save' && !operation.note) operation.note = operation.data;
        if (operation.type === 'note.save' && !operation.note_id) operation.note_id = operation.note?.id;
        if (operation.type === 'prefs.save') operation.note_id = '__prefs__';
        queue.put(operation);
        cursor.continue();
        return;
      }
      state.put({key: 'clientSequence', value: Math.max(previousSequence, largestSequence)});
    };
  };
  await complete;
}

function withQueueCursor(db, mode, visit) {
  const transaction = db.transaction(['queue'], mode);
  const cursorRequest = transaction.objectStore('queue').openCursor();
  const complete = transactionComplete(transaction);
  return new Promise((resolve, reject) => {
    cursorRequest.onerror = () => reject(cursorRequest.error);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        complete.then(resolve, reject);
        return;
      }
      visit(cursor.value, cursor);
      cursor.continue();
    };
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function withOfflineStore(names, mode, work) {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map(name => [name, tx.objectStore(name)]));
    const complete = transactionComplete(tx);
    const result = await work(stores);
    await complete;
    return result;
  } catch (error) {
    if (error?.name === 'QuotaExceededError' || error?.name === 'InvalidStateError' || error?.name === 'TransactionInactiveError') {
      reportOfflineStorageFailure(error);
    }
    throw error;
  }
}

function getLocalNote(id) {
  return withOfflineStore(['notes'], 'readonly', stores => requestValue(stores.notes.get(id)));
}

async function getOfflineDatabaseInfo() {
  const db = await openOfflineDB();
  return {
    version: db.version,
    queueIndexes: [...db.transaction('queue', 'readonly').objectStore('queue').indexNames],
  };
}

function putLocalNote(note) {
  return withOfflineStore(['notes'], 'readwrite', stores => requestValue(stores.notes.put(note)));
}

function removeLocalNote(id) {
  return withOfflineStore(['notes'], 'readwrite', stores => requestValue(stores.notes.delete(id)));
}

async function getLocalNotes() {
  const notes = await getAllLocalNotes();
  return notes.filter(note => !note.deleted).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

function getAllLocalNotes() {
  return withOfflineStore(['notes'], 'readonly', stores => requestValue(stores.notes.getAll()));
}

function getOfflineState(key) {
  return withOfflineStore(['state'], 'readonly', async stores => {
    const value = await requestValue(stores.state.get(key));
    return value && value.value;
  });
}

function setOfflineState(key, value) {
  return withOfflineStore(['state'], 'readwrite', stores => requestValue(stores.state.put({key, value})));
}

function unresolvedConflictKey(noteID) {
  return `unresolvedConflict:${noteID}`;
}

function rejectedSyncKey(noteID) {
  return `rejectedSync:${noteID}`;
}

function getUnresolvedConflict(noteID) {
  return getOfflineState(unresolvedConflictKey(noteID));
}

function setUnresolvedConflict(conflict) {
  return setOfflineState(unresolvedConflictKey(conflict.note_id), conflict);
}

function mergeQueuedPreferencePayload(existing, operation) {
  const existingPatch = existing.prefs?._sync_patch;
  const nextPatch = operation.prefs?._sync_patch;
  if (!existingPatch || !nextPatch) {
    existing.base_revision = operation.base_revision;
    existing.prefs = operation.prefs;
    return;
  }
  const patch = {...existingPatch};
  const base = {...(existing.prefs?._sync_base || {})};
  const nextBase = operation.prefs?._sync_base || {};
  Object.entries(nextPatch).forEach(([key, value]) => {
    if (!(key in base)) base[key] = nextBase[key];
    patch[key] = value;
  });
  existing.prefs = {...operation.prefs, _sync_patch: patch, _sync_base: base};
}

async function queueOperationInStores(stores, operation) {
  if (operation.type === 'note.save' || operation.type === 'note.delete' || operation.type === 'prefs.save') {
    await requestValue(stores.state.delete(rejectedSyncKey(operation.note_id)));
  }
  if (operation.type === 'note.save' || operation.type === 'prefs.save') {
    const queued = await requestValue(stores.queue.index('note_id').getAll(operation.note_id));
    const existing = queued
      // Once a request has been attempted, its op_id/client_sequence and
      // payload are immutable. A later edit must get a new queue identity so
      // an acknowledgement for the old payload cannot remove the new edit.
      .filter(item => !item.attempted_at && item.type === operation.type)
      .sort((left, right) => right.client_sequence - left.client_sequence)[0];
    if (existing) {
      if (operation.type === 'prefs.save') mergeQueuedPreferencePayload(existing, operation);
      else {
        existing.base_revision = operation.base_revision;
        existing.note = operation.note;
        existing.prefs = operation.prefs;
      }
      await requestValue(stores.queue.put(existing));
      return;
    }
  }
  const state = await requestValue(stores.state.get('clientSequence'));
  const sequence = Number(state?.value || 0) + 1;
  operation.client_sequence = sequence;
  operation.op_id = newLocalNoteID();
  await requestValue(stores.queue.add(operation));
  await requestValue(stores.state.put({key: 'clientSequence', value: sequence}));
}

function queueOperation(operation) {
  return withOfflineStore(['queue', 'state'], 'readwrite', stores => queueOperationInStores(stores, operation)).then(result => {
    notifySyncRequested();
    return result;
  });
}

async function saveLocalNoteAndQueue(note, operation) {
  await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    await requestValue(stores.notes.put(note));
    await queueOperationInStores(stores, operation);
  });
  notifySyncRequested();
}

async function removeLocalNoteAndQueue(id, operation) {
  await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    await requestValue(stores.notes.delete(id));
    await queueOperationInStores(stores, operation);
  });
  notifySyncRequested();
}

function removeLocalNoteAndSupersede(id, afterSequence) {
  return withOfflineStore(['notes', 'queue'], 'readwrite', async stores => {
    await requestValue(stores.notes.delete(id));
    const operations = await requestValue(stores.queue.index('note_id').getAll(id));
    operations.forEach(operation => {
      if (operation.client_sequence > afterSequence && !operation.attempted_at) {
        operation.type = 'noop';
        stores.queue.put(operation);
      }
    });
  });
}

function pendingOperations() {
  return withOfflineStore(['queue'], 'readonly', async stores => {
    const items = await requestValue(stores.queue.getAll());
    return items.sort((a, b) => a.client_sequence - b.client_sequence);
  });
}

async function repairSyncSequenceGap(expectedSequence) {
  if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 1) return false;
  return withOfflineStore(['queue', 'state'], 'readwrite', async stores => {
    const operations = (await requestValue(stores.queue.getAll()))
      .sort((left, right) => left.client_sequence - right.client_sequence || left.id - right.id);
    const unsent = operations.filter(operation => operation.client_sequence >= expectedSequence);
    if (!unsent.length) return false;
    let sequence = expectedSequence;
    for (const operation of unsent) {
      // The server returned 409 before applying this request, so these rows
      // are safe to re-arm and close the local sequence gap. A normal
      // acknowledgement never changes an attempted row.
      if (operation.client_sequence !== sequence || operation.attempted_at) {
        operation.client_sequence = sequence;
        delete operation.attempted_at;
        await requestValue(stores.queue.put(operation));
      }
      sequence++;
    }
    // These operations have not reached the server (it explicitly requested
    // expectedSequence), so it is safe to close the local numbering gap and
    // let future edits continue immediately after the repaired queue.
    await requestValue(stores.state.put({key: 'clientSequence', value: sequence - 1}));
    return true;
  });
}

async function hasPendingOperation(noteID) {
  return withOfflineStore(['queue', 'state'], 'readonly', async stores => {
    const item = await requestValue(stores.queue.index('note_id').get(noteID));
    if (item) return true;
    return Boolean(await requestValue(stores.state.get(rejectedSyncKey(noteID))));
  });
}

function pendingOperationsForNote(noteID) {
  return withOfflineStore(['queue'], 'readonly', stores => requestValue(stores.queue.index('note_id').getAll(noteID)));
}

async function claimQueueOperation(id) {
  return withOfflineStore(['queue'], 'readwrite', async stores => {
    const operation = await requestValue(stores.queue.get(id));
    if (!operation) return null;
    if (!operation.attempted_at) {
      operation.attempted_at = new Date().toISOString();
      await requestValue(stores.queue.put(operation));
    }
    return operation;
  });
}

function queueOperationPayload(operation) {
  return JSON.stringify({
    type: operation.type,
    note_id: operation.note_id,
    base_revision: operation.base_revision,
    note: operation.note && {
      id: operation.note.id,
      title: operation.note.title,
      tags: operation.note.tags,
      content: operation.note.content,
      base_revision: operation.note.base_revision,
      base_content: operation.note.base_content,
      base_title: operation.note.base_title,
      base_tags: operation.note.base_tags,
    },
    prefs: operation.prefs || null,
  });
}

function removePendingOperationIfIdentityMatches(id, expectedOperation) {
  return withOfflineStore(['queue'], 'readwrite', async stores => {
    const operation = await requestValue(stores.queue.get(id));
    if (!operation || operation.op_id !== expectedOperation.op_id || operation.client_sequence !== expectedOperation.client_sequence || queueOperationPayload(operation) !== queueOperationPayload(expectedOperation)) return false;
    await requestValue(stores.queue.delete(id));
    return true;
  });
}

async function quarantineQueueOperation(operation, reason) {
  return withOfflineStore(['queue', 'state'], 'readwrite', async stores => {
    const queued = await requestValue(stores.queue.get(operation.id));
    if (!queued || queued.op_id !== operation.op_id || queued.client_sequence !== operation.client_sequence || queueOperationPayload(queued) !== queueOperationPayload(operation)) return false;
    await requestValue(stores.state.put({
      key: rejectedSyncKey(operation.note_id),
      value: {
        op_id: operation.op_id,
        client_sequence: operation.client_sequence,
        note_id: operation.note_id,
        type: operation.type,
        reason: reason || 'server rejected the operation',
        rejected_at: new Date().toISOString(),
      },
    }));
    queued.type = 'noop';
    delete queued.note;
    delete queued.prefs;
    delete queued.base_revision;
    queued.rejected = true;
    queued.rejected_reason = reason || 'server rejected the operation';
    await requestValue(stores.queue.put(queued));
    return true;
  });
}

async function syncDeviceID() {
  let deviceID = await getOfflineState('deviceID');
  if (!deviceID) {
    deviceID = `device_${newLocalNoteID()}`;
    await setOfflineState('deviceID', deviceID);
  }
  return deviceID;
}

async function rebaseQueuedNoteOperations(noteID, acknowledgedID, revision, baseNote) {
  return withOfflineStore(['queue'], 'readwrite', async stores => {
    const operations = await requestValue(stores.queue.index('note_id').getAll(noteID));
    let hasLater = false;
    operations.forEach(operation => {
      if (operation.id === acknowledgedID || operation.client_sequence < 1 || operation.attempted_at) return;
      if (operation.type === 'note.save' || operation.type === 'note.delete') {
        operation.base_revision = revision;
        if (operation.note) {
          operation.note.base_revision = revision;
          operation.note.base_content = baseNote.content;
          operation.note.base_title = baseNote.title;
          operation.note.base_tags = baseNote.tags;
        }
        stores.queue.put(operation);
        hasLater = true;
      }
    });
    return hasLater;
  });
}

async function supersedeQueuedNoteOperations(noteID, afterSequence) {
  await withOfflineStore(['queue'], 'readwrite', async stores => {
    const operations = await requestValue(stores.queue.index('note_id').getAll(noteID));
    operations.forEach(operation => {
      if (operation.client_sequence > afterSequence && !operation.attempted_at) {
        operation.type = 'noop';
        stores.queue.put(operation);
      }
    });
  });
}

async function clearOfflineData() {
  try {
    syncCoordinationChannel?.postMessage({type: 'logout', sender: syncTabID});
  } catch (_) {}
  const dbPromise = offlineDBPromise;
  offlineDBPromise = undefined;
  if (dbPromise) {
    try { (await dbPromise).close(); } catch (_) {}
  }
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(offlineDBName);
    const timeout = setTimeout(() => reject(new Error('local data cleanup is blocked by another app tab')), 5000);
    request.onerror = () => {
      clearTimeout(timeout);
      reject(request.error);
    };
    request.onsuccess = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
}

async function closeOfflineDatabaseConnection() {
  const dbPromise = offlineDBPromise;
  offlineDBPromise = undefined;
  if (!dbPromise) return;
  try { (await dbPromise).close(); } catch (_) {}
}

function newLocalNoteID() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

try {
  if (typeof BroadcastChannel !== 'undefined') {
    syncCoordinationChannel = new BroadcastChannel('mdnotes-sync');
    syncCoordinationChannel.addEventListener('message', event => {
      if (!event.data || event.data.sender === syncTabID) return;
      if (event.data.type === 'sync-request') scheduleSync({}, 0);
      if (event.data.type === 'logout') void closeOfflineDatabaseConnection();
    });
  }
} catch (_) {
  syncCoordinationChannel = null;
}

function notifySyncRequested() {
  try {
    syncCoordinationChannel?.postMessage({type: 'sync-request', sender: syncTabID});
  } catch (_) {}
}

const syncStates = {
  online: {label: 'Saved', title: 'Saved and up to date'},
  syncing: {label: 'Syncing', title: 'Synchronizing changes'},
  offline: {label: 'Offline', title: 'Offline — changes are saved on this device'},
};
let syncFailed = false;

function setSyncStatus(state) {
  const config = syncStates[state] || syncStates.offline;
  ['#sync-status', '#editor-status'].forEach(selector => {
    const element = $(selector);
    if (!element) return;
    element.dataset.state = state;
    element.title = config.title;
    element.setAttribute('aria-label', config.title);
    element.querySelector('.sync-indicator-label').textContent = config.label;
  });
}

function showToast(message, kind = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  $('#toast-region').append(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 180);
  }, 3200);
}

function showUpdateAvailable() {
  if (updateToast) return;
  const toast = document.createElement('div');
  toast.className = 'toast update';
  const message = document.createElement('span');
  message.textContent = 'New version available.';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'toast-action';
  reload.textContent = 'Reload';
  reload.addEventListener('click', async () => {
    reload.disabled = true;
    reload.textContent = 'Updating…';
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      await registration?.update();
    } catch (error) {
      console.warn('service worker update check failed', error);
    }
    window.location.reload();
  });
  toast.append(message, reload);
  $('#toast-region').append(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  updateToast = toast;
}

function setSyncDiagnostic(detail, responseStatus = 0) {
  lastSyncDiagnostic = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  lastSyncResponseStatus = Number.isInteger(responseStatus) ? responseStatus : 0;
}

function clearSyncDiagnostic() {
  lastSyncDiagnostic = '';
  lastSyncResponseStatus = 0;
}

function showOfflineNotice(checking = false) {
  $$('.offline-notice').forEach(notice => {
    notice.classList.remove('hidden');
    notice.querySelector('.offline-notice-message').textContent = checking ? 'Checking…' : "You're offline. Changes are saved on this device.";
    const retry = notice.querySelector('.offline-retry');
    retry.classList.toggle('hidden', checking);
    retry.disabled = checking;
  });
}

function hideOfflineNotice() {
  $$('.offline-notice').forEach(notice => notice.classList.add('hidden'));
}

function showSyncCompleteToast() {
  hideOfflineNotice();
  showToast('Changes synced.', 'success');
}

function cacheAppVersion(response) {
  const changedVersion = response?.version && appVersionAtLoad && response.version !== appVersionAtLoad;
  const changedRevision = response?.revision && appRevisionAtLoad && response.revision !== appRevisionAtLoad;
  if (changedVersion || changedRevision) showUpdateAvailable();
  if (response?.version) {
    if (!appVersionAtLoad) appVersionAtLoad = response.version;
    localStorage.setItem('mdnotes-version', response.version);
  }
  if (response?.revision) {
    if (!appRevisionAtLoad) appRevisionAtLoad = response.revision;
    localStorage.setItem('mdnotes-revision', response.revision);
    registerServiceWorker(response.revision);
  }
  const version = response?.version || localStorage.getItem('mdnotes-version') || 'dev';
  $('#app-version').textContent = `v${version}`;
}

function show(screen) {
  Object.values(screens).forEach(el => el.classList.add('hidden'));
  screen.classList.remove('hidden');
}

function clearCurrentNote() {
  editorSessionGeneration++;
  currentNoteId = null;
  currentRevision = 0;
  currentBaseRevision = null;
  isDirty = false;
}

function requireAuthentication() {
  authenticationRequired = true;
  show(screens.login);
  $('#login-form input').focus();
}

async function fetchWithTimeout(path, options = {}, {group = null, timeoutMs = httpRequestTimeoutMs} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('request timed out', 'TimeoutError')), timeoutMs);
  if (group) group.add(controller);
  try {
    return await fetch(path, {...options, signal: controller.signal});
  } finally {
    clearTimeout(timer);
    if (group) group.delete(controller);
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function cancelActiveSyncRequests() {
  if (!activeSyncControllers.size) return;
  syncCancellationRequested = true;
  activeSyncControllers.forEach(controller => controller.abort());
}

function beginSyncNetworkRequest() {
  syncNetworkRequestsInFlight++;
  setSyncStatus('syncing');
}

function endSyncNetworkRequest() {
  syncNetworkRequestsInFlight = Math.max(0, syncNetworkRequestsInFlight - 1);
  if (syncNetworkRequestsInFlight === 0) setIdleSyncStatus();
}

function setIdleSyncStatus() {
  if (syncNetworkRequestsInFlight > 0) return;
  setSyncStatus(syncFailed ? 'offline' : 'online');
}

class APIError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'APIError';
    this.responseStatus = status;
    this.retryable = !status || status === 408 || status === 429 || status >= 500;
  }
}

async function api(path, opts) {
  const method = opts?.method || 'GET';
  const syncRequest = opts?.syncRequest === true;
  const throwOnError = opts?.throwOnError === true;
  const requestOpts = {...opts};
  delete requestOpts.syncRequest;
  delete requestOpts.throwOnError;
  if (syncRequest) beginSyncNetworkRequest();
  try {
    const res = await fetchWithTimeout(path, {
      credentials: 'same-origin',
      headers: requestOpts?.body ? {'Content-Type':'application/json'} : {},
      ...requestOpts,
    }, {group: syncRequest ? activeSyncControllers : null});
    if (res.status === 401) {
      setSyncDiagnostic(`${method} ${path} returned HTTP 401`, 401);
      requireAuthentication();
      if (throwOnError || syncRequest) throw new APIError('authentication required', 401);
      return null;
    }
    if (res.status === 204) return true;
    if (!res.ok) {
      const text = await res.text();
      throw new APIError(text || res.statusText, res.status);
    }
    return await res.json();
  } catch(e) {
    const error = e instanceof APIError ? e : Object.assign(e, {retryable: true});
    setSyncDiagnostic(`${method} ${path} ${error?.responseStatus ? `returned HTTP ${error.responseStatus}` : 'failed'}: ${error?.message || 'unknown error'}`, error?.responseStatus);
    console.error(error);
    if (throwOnError || syncRequest) throw error;
    return null;
  } finally {
    if (syncRequest) endSyncNetworkRequest();
  }
}

async function syncFetch(path, options) {
  const method = options?.method || 'GET';
  beginSyncNetworkRequest();
  try {
    const response = await fetchWithTimeout(path, {
      credentials: 'same-origin',
      headers: options?.body ? {'Content-Type': 'application/json'} : {},
      ...options,
    }, {group: activeSyncControllers});
    const body = response.status === 204 ? null : await response.text();
    let data = null;
    if (body) {
      try { data = JSON.parse(body); } catch (_) { data = body; }
    }
    if (!response.ok) setSyncDiagnostic(`${method} ${path} returned HTTP ${response.status}: ${typeof data === 'string' ? data : response.statusText}`, response.status);
    return {response, data};
  } catch (error) {
    setSyncDiagnostic(`${method} ${path} failed: ${error?.message || 'unknown error'}`);
    throw error;
  } finally {
    endSyncNetworkRequest();
  }
}

async function cacheRemoteNote(note) {
  const local = await getLocalNote(note.id);
  // A just-typed change may not have reached IndexedDB yet. Do not let a pull
  // replace that base snapshot before syncNow has a chance to save it locally.
  if (local?.pending || (currentNoteId === note.id && isDirty)) return;
  await putLocalNote({...local, ...note, pending: false, base_revision: null, base_content: null, base_title: null, base_tags: null});
  if (currentNoteId === note.id && !isDirty) {
    currentRevision = note.revision || 0;
    currentBaseRevision = null;
    savedSnapshot = {title: note.title || '', tags: note.tags || '', content: note.content || ''};
    $('#note-title').value = savedSnapshot.title;
    $('#note-tags').value = savedSnapshot.tags;
    $('#note-content').value = savedSnapshot.content;
    renderedPreviewSource = null;
    updatePreview();
  }
}

async function applyRemoteDeletion(noteID) {
  const removed = await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    const pending = await requestValue(stores.queue.index('note_id').getAll(noteID));
    const conflict = await requestValue(stores.state.get(unresolvedConflictKey(noteID)));
    const rejected = await requestValue(stores.state.get(rejectedSyncKey(noteID)));
    if (pending.length || conflict || rejected) return false;
    await requestValue(stores.notes.delete(noteID));
    return true;
  });
  if (removed && currentNoteId === noteID && !isDirty) {
    clearCurrentNote();
    await loadDashboard({sync: false});
    setDashboardRoute({replace: true});
  }
  return removed;
}

async function bulkRemoteNotes(noteIDs) {
  if (!noteIDs.length) return new Map();
  const notes = new Map();
  for (let index = 0; index < noteIDs.length; index += bulkNoteBatchSize) {
    const batch = noteIDs.slice(index, index + bulkNoteBatchSize);
    const response = await api(`/api/sync/notes?ids=${encodeURIComponent(batch.join(','))}`, {syncRequest: true});
    if (!response || !Array.isArray(response.notes) || !Array.isArray(response.missing)) {
      throw new Error('could not download changed notes');
    }
    response.notes.forEach(note => notes.set(note.id, note));
    response.missing.forEach(id => notes.set(id, null));
  }
  return notes;
}

async function loadSyncGuards() {
  return withOfflineStore(['queue', 'state'], 'readonly', async stores => {
    const [operations, records] = await Promise.all([
      requestValue(stores.queue.getAll()),
      requestValue(stores.state.getAll()),
    ]);
    const guarded = new Set(operations.map(operation => operation.note_id).filter(Boolean));
    records.forEach(record => {
      if (record.key.startsWith('unresolvedConflict:') || record.key.startsWith('rejectedSync:')) {
        const noteID = record.value?.note_id || record.key.split(':').slice(1).join(':');
        if (noteID) guarded.add(noteID);
      }
    });
    return guarded;
  });
}

async function applyRemoteChangePage(changes, downloaded, nextSequence) {
  let activeNote = null;
  let activeDeleted = false;
  await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    const [operations, records] = await Promise.all([
      requestValue(stores.queue.getAll()),
      requestValue(stores.state.getAll()),
    ]);
    const guarded = new Set(operations.map(operation => operation.note_id).filter(Boolean));
    records.forEach(record => {
      if (record.key.startsWith('unresolvedConflict:') || record.key.startsWith('rejectedSync:')) {
        const noteID = record.value?.note_id || record.key.split(':').slice(1).join(':');
        if (noteID) guarded.add(noteID);
      }
    });
    for (const change of changes) {
      if (guarded.has(change.note_id)) continue;
      const remote = change.deleted ? null : downloaded.get(change.note_id);
      const local = await requestValue(stores.notes.get(change.note_id));
      if (local?.pending || (currentNoteId === change.note_id && isDirty)) continue;
      if (!remote) {
        await requestValue(stores.notes.delete(change.note_id));
        if (currentNoteId === change.note_id) activeDeleted = true;
        continue;
      }
      const next = {...local, ...remote, pending: false, base_revision: null, base_content: null, base_title: null, base_tags: null};
      await requestValue(stores.notes.put(next));
      if (currentNoteId === change.note_id && !isDirty) activeNote = next;
    }
    await requestValue(stores.state.put({key: 'syncSequence', value: nextSequence}));
  });
  if (activeNote) updateOpenNote(activeNote);
  if (activeDeleted && currentNoteId && !isDirty) {
    clearCurrentNote();
    await loadDashboard({sync: false});
    setDashboardRoute({replace: true});
  }
}

async function applyRemoteSnapshot(remoteNotes, remoteIDs, sequence = null) {
  let activeNote = null;
  let activeDeleted = false;
  await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    const [operations, records, locals] = await Promise.all([
      requestValue(stores.queue.getAll()),
      requestValue(stores.state.getAll()),
      requestValue(stores.notes.getAll()),
    ]);
    const localByID = new Map(locals.map(note => [note.id, note]));
    const guarded = new Set(operations.map(operation => operation.note_id).filter(Boolean));
    records.forEach(record => {
      if (record.key.startsWith('unresolvedConflict:') || record.key.startsWith('rejectedSync:')) {
        const noteID = record.value?.note_id || record.key.split(':').slice(1).join(':');
        if (noteID) guarded.add(noteID);
      }
    });
    for (const [id, remote] of remoteNotes) {
      if (guarded.has(id)) continue;
      const local = localByID.get(id);
      if (local?.pending || (currentNoteId === id && isDirty)) continue;
      const next = {...local, ...remote, pending: false, base_revision: null, base_content: null, base_title: null, base_tags: null};
      await requestValue(stores.notes.put(next));
      if (currentNoteId === id && !isDirty) activeNote = next;
    }
    for (const local of locals) {
      if (remoteIDs.has(local.id) || guarded.has(local.id)) continue;
      await requestValue(stores.notes.delete(local.id));
      if (currentNoteId === local.id) activeDeleted = true;
    }
    if (sequence !== null) await requestValue(stores.state.put({key: 'syncSequence', value: sequence}));
  });
  if (activeNote) updateOpenNote(activeNote);
  if (activeDeleted && currentNoteId && !isDirty) {
    clearCurrentNote();
    await loadDashboard({sync: false});
    setDashboardRoute({replace: true});
  }
}

async function pullRemoteChanges() {
  let since = Number(await getOfflineState('syncSequence') || 0);
  const fetchedNotes = new Map();
  const guards = await loadSyncGuards();
  for (;;) {
    const page = await api(`/api/sync?since=${since}&limit=100`, {syncRequest: true});
    if (!page) throw new Error('could not fetch sync changes');
    if (page.resetRequired) {
      await resetLocalNotesFromRemote(Number(page.nextSequence || 0));
      return;
    }
    const downloadIDs = [];
    for (const change of page.changes) {
      if (change.deleted || fetchedNotes.has(change.note_id)) continue;
      if (guards.has(change.note_id)) continue;
      downloadIDs.push(change.note_id);
    }
    const downloaded = await bulkRemoteNotes([...new Set(downloadIDs)]);
    downloaded.forEach((remote, id) => fetchedNotes.set(id, remote));
    const nextSince = Number(page.nextSequence || since);
    if (page.hasMore && nextSince <= since) {
      throw new Error(`sync cursor did not advance (since ${since}, next ${nextSince})`);
    }
    await applyRemoteChangePage(page.changes, fetchedNotes, nextSince);
    since = nextSince;
    if (!page.hasMore) return;
  }
}

async function resetLocalNotesFromRemote(sequence) {
  const summaries = await api('/api/notes', {syncRequest: true});
  if (!Array.isArray(summaries)) throw new Error('could not refresh notes after sync compaction');
  const remoteIDs = new Set(summaries.map(note => note.id));
  const remoteNotes = new Map();
  const downloadIDs = [];
  const guards = await loadSyncGuards();
  for (const summary of summaries) {
    if (guards.has(summary.id)) continue;
    downloadIDs.push(summary.id);
  }
  for (let index = 0; index < downloadIDs.length; index += 100) {
    const page = await bulkRemoteNotes(downloadIDs.slice(index, index + 100));
    page.forEach((remote, id) => remoteNotes.set(id, remote));
  }
  for (const id of downloadIDs) if (!remoteNotes.get(id)) throw new Error('could not download refreshed note');
  await applyRemoteSnapshot(remoteNotes, remoteIDs, sequence);
}

// A sync cursor records that this browser has observed the change feed, but a
// browser can still lose individual IndexedDB records (for example after a
// storage repair). Reconcile against note summaries at session start so a
// valid-but-stale cursor cannot leave the dashboard incomplete forever.
async function reconcileLocalNotes() {
  const summaries = await api('/api/notes', {syncRequest: true});
  if (!Array.isArray(summaries)) throw new Error('could not reconcile local notes');
  const remoteIDs = new Set(summaries.map(note => note.id));
  const downloadIDs = [];
  const remoteNotes = new Map();
  const guards = await loadSyncGuards();
  const locals = await getAllLocalNotes();
  const localByID = new Map(locals.map(note => [note.id, note]));
  for (const summary of summaries) {
    if (guards.has(summary.id)) continue;
    const local = localByID.get(summary.id);
    if (local && local.revision === summary.revision) continue;
    downloadIDs.push(summary.id);
  }
  for (let index = 0; index < downloadIDs.length; index += 100) {
    const page = await bulkRemoteNotes(downloadIDs.slice(index, index + 100));
    page.forEach((remote, id) => remoteNotes.set(id, remote));
  }
  for (const id of downloadIDs) if (!remoteNotes.get(id)) throw new Error('could not download reconciled note');
  await applyRemoteSnapshot(remoteNotes, remoteIDs);
}

function updateOpenNote(note) {
  if (currentNoteId !== note.id || isDirty) return;
  currentRevision = note.revision || 0;
  currentBaseRevision = note.base_revision ?? null;
  savedSnapshot = {title: note.title || '', tags: note.tags || '', content: note.content || ''};
  $('#note-title').value = savedSnapshot.title;
  $('#note-tags').value = savedSnapshot.tags;
  $('#note-content').value = savedSnapshot.content;
  renderedPreviewSource = null;
  updatePreview();
}

async function loadConflictRemoteNote(noteID) {
  try {
    return await api(`/api/notes/${encodeURIComponent(noteID)}`, {syncRequest: true});
  } catch (error) {
    // A 404 is authoritative: the remote note was deleted. Other failures
    // must abort conflict handling so the original operation can be retried.
    if (error?.responseStatus === 404) return null;
    throw error;
  }
}

async function mergeConflictedNote(operation, remote) {
  if (operation.type !== 'note.save' || !operation.note || !window.MDNotesMerge) return false;
  // A network response can arrive while the user is still typing. Capture that
  // newer local state before deriving the merge, rather than merging an older
  // queued snapshot and accidentally omitting the last keystrokes.
  if (currentNoteId === operation.note_id && isDirty) await saveCurrentNote(false);
  const local = await getLocalNote(operation.note_id);
  if (!local || !remote) return false;
  // Queued edits created before three-way metadata existed cannot be merged
  // safely for title/tags; the durable resolver handles them instead.
  if (local.base_title === undefined || local.base_tags === undefined) return false;

  const base = {
    title: local.base_title ?? operation.note.base_title ?? operation.note.title ?? '',
    tags: local.base_tags ?? operation.note.base_tags ?? operation.note.tags ?? '',
    content: local.base_content ?? operation.note.base_content ?? '',
  };
  const merged = window.MDNotesMerge.mergeNoteVersions(base, local, remote);
  if (!merged) return false;

  const now = new Date().toISOString();
  const mergedLocal = {
    ...remote,
    ...merged,
    updated_at: now,
    pending: true,
    base_revision: remote.revision,
    base_content: remote.content || '',
    base_title: remote.title || '',
    base_tags: remote.tags || '',
  };
  await putLocalNote(mergedLocal);
  // The conflicting operation is already recorded by the server. Later local
  // snapshots have the old base, so replace them with ordered no-ops and a
  // single merged save after them; that preserves the device event sequence.
  await supersedeQueuedNoteOperations(operation.note_id, operation.client_sequence);
  await removePendingOperationIfIdentityMatches(operation.id, operation);
  await queueOperation({type: 'note.save', note_id: mergedLocal.id, base_revision: remote.revision, note: mergedLocal});
  updateOpenNote(mergedLocal);
  return true;
}

async function preserveConflictCopy(operation, local, remote) {
  if (remote) await putLocalNote({...remote, pending: false, base_revision: null, base_content: null, base_title: null, base_tags: null});
  else await removeLocalNote(operation.note_id);
  if (local && operation.type === 'note.save') {
    const conflictID = newLocalNoteID();
    const now = new Date().toISOString();
    const conflict = {
      id: conflictID,
      title: `${local.title || 'Untitled'} (conflict copy)`,
      filename: `${conflictID}.md`,
      tags: local.tags || '',
      content: local.content || '',
      base_content: '',
      created_at: now,
      updated_at: now,
      revision: 0,
      base_revision: 0,
      base_title: '',
      base_tags: '',
      pending: true,
    };
    await putLocalNote(conflict);
    await queueOperation({type: 'note.save', note_id: conflictID, base_revision: 0, note: conflict});
    if (currentNoteId === operation.note_id) {
      currentNoteId = conflictID;
      updateOpenNote(conflict);
    }
  }
  await supersedeQueuedNoteOperations(operation.note_id, operation.client_sequence);
  await removePendingOperationIfIdentityMatches(operation.id, operation);
}

function conflictBase(local, operation) {
  return {
    title: local.base_title ?? operation.note?.base_title ?? operation.note?.title ?? '',
    tags: local.base_tags ?? operation.note?.base_tags ?? operation.note?.tags ?? '',
    content: local.base_content ?? operation.note?.base_content ?? '',
  };
}

async function createRemoteDeletionConflict(operation, local) {
  const preserved = {
    ...local,
    id: operation.note_id,
    title: local.title || 'Untitled',
    tags: local.tags || '',
    content: local.content || '',
  };
  const conflict = {
    kind: 'remote-deleted',
    note_id: operation.note_id,
    created_at: new Date().toISOString(),
    base: conflictBase(preserved, operation),
    local: preserved,
    remote: null,
  };
  await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    const queued = await requestValue(stores.queue.get(operation.id));
    if (!queued || queued.op_id !== operation.op_id || queued.client_sequence !== operation.client_sequence || queueOperationPayload(queued) !== queueOperationPayload(operation)) {
      throw new Error('conflicting sync operation changed before deletion resolution');
    }
    await requestValue(stores.notes.put({...preserved, pending: false}));
    await requestValue(stores.state.put({key: unresolvedConflictKey(operation.note_id), value: conflict}));
    const laterOperations = await requestValue(stores.queue.index('note_id').getAll(operation.note_id));
    for (const later of laterOperations) {
      if (later.id !== operation.id && later.client_sequence > operation.client_sequence && !later.attempted_at) {
        later.type = 'noop';
        await requestValue(stores.queue.put(later));
      }
    }
    await requestValue(stores.queue.delete(operation.id));
  });
}

function renderConflictDiff(target, base, version, changedClass) {
  const baseLines = String(base || '').split('\n');
  const versionLines = String(version || '').split('\n');
  let prefix = 0;
  while (prefix < baseLines.length && prefix < versionLines.length && baseLines[prefix] === versionLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < baseLines.length - prefix && suffix < versionLines.length - prefix && baseLines[baseLines.length - suffix - 1] === versionLines[versionLines.length - suffix - 1]) suffix++;
  target.replaceChildren();
  const append = (text, changed) => {
    const node = document.createElement(changed ? 'mark' : 'span');
    if (changed) node.className = `conflict-line ${changedClass}`;
    node.textContent = text;
    target.append(node);
  };
  if (prefix) append(`${versionLines.slice(0, prefix).join('\n')}\n`, false);
  const changed = versionLines.slice(prefix, versionLines.length - suffix).join('\n');
  if (changed || versionLines.length !== baseLines.length) append(`${changed || '∅'}\n`, true);
  if (suffix) append(versionLines.slice(versionLines.length - suffix).join('\n'), false);
}

let activeConflictID = null;
let activeConflictSelection = 'local';
let activeConflictKind = 'edit';

function closeConflictResolver() {
  activeConflictID = null;
  activeConflictSelection = 'local';
  activeConflictKind = 'edit';
  closeModal($('#conflict-modal'));
}

function openModal(modal) {
  modal.classList.remove('hidden', 'is-closing');
}

function closeModal(modal) {
  if (modal.classList.contains('hidden') || modal.classList.contains('is-closing')) return;
  modal.classList.add('is-closing');
  const finish = () => {
    modal.classList.remove('is-closing');
    modal.classList.add('hidden');
  };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finish();
  } else {
    window.setTimeout(finish, 170);
  }
}

function setConflictSelection(selection) {
  activeConflictSelection = selection;
  const localSelected = selection === 'local';
  const remoteSelected = selection === 'remote';
  $('.conflict-version-local').classList.toggle('is-selected', localSelected);
  $('.conflict-version-remote').classList.toggle('is-selected', remoteSelected);
  $('#conflict-use-local').setAttribute('aria-pressed', String(localSelected));
  $('#conflict-use-remote').setAttribute('aria-pressed', String(remoteSelected));
  $('#conflict-selection-status').textContent = selection === 'local'
    ? 'Selected: this device. You can edit the result below.'
    : selection === 'remote'
      ? 'Selected: other device. You can edit the result below.'
      : 'Custom result. You can continue editing it below.';
}

function showConflictResolver(conflict) {
  activeConflictKind = 'edit';
  activeConflictID = conflict.note_id;
  $('#conflict-title').textContent = 'Resolve conflicting edits';
  $('.conflict-intro').textContent = 'This note changed on another device while you were editing it. Review both versions, then save the result you want to keep.';
  $('#conflict-deleted-details').classList.add('hidden');
  $$('.conflict-fields, .conflict-metadata-compare, .conflict-compare, #conflict-selection-status, .conflict-result, .conflict-base:not(#conflict-deleted-details)').forEach(element => element.classList.remove('hidden'));
  $('#conflict-copy').className = 'btn-text';
  $('#conflict-copy').textContent = 'Keep as copy';
  $('#conflict-save').className = 'btn-primary';
  $('#conflict-save').textContent = 'Save resolution';
  $('#conflict-note-title').value = conflict.local.title || '';
  $('#conflict-note-tags').value = conflict.local.tags || '';
  $('#conflict-note-content').value = conflict.local.content || '';
  $('#conflict-local-metadata').textContent = `Title: ${conflict.local.title || 'Untitled'}\nTags: ${conflict.local.tags || 'None'}`;
  $('#conflict-remote-metadata').textContent = `Title: ${conflict.remote.title || 'Untitled'}\nTags: ${conflict.remote.tags || 'None'}`;
  renderConflictDiff($('#conflict-local-diff'), conflict.base.content, conflict.local.content, 'conflict-line-local');
  renderConflictDiff($('#conflict-remote-diff'), conflict.base.content, conflict.remote.content, 'conflict-line-remote');
  $('#conflict-base-content').textContent = conflict.base.content || '(empty note)';
  setConflictSelection('local');
  openModal($('#conflict-modal'));
  $('#conflict-note-content').focus();
}

function showDeletedConflict(conflict) {
  activeConflictKind = 'remote-deleted';
  activeConflictID = conflict.note_id;
  $('#conflict-title').textContent = 'Note deleted on another device';
  $('.conflict-intro').textContent = 'Your changes are saved on this device. Choose whether to keep them as a new note or accept the deletion.';
  $$('.conflict-fields, .conflict-metadata-compare, .conflict-compare, #conflict-selection-status, .conflict-result, .conflict-base').forEach(element => element.classList.add('hidden'));
  $('#conflict-deleted-details').classList.remove('hidden');
  $('#conflict-deleted-content').textContent = [
    `Title: ${conflict.local.title || 'Untitled'}`,
    `Tags: ${conflict.local.tags || 'None'}`,
    '',
    conflict.local.content || '(empty note)',
  ].join('\n');
  $('#conflict-copy').className = 'btn-primary';
  $('#conflict-copy').textContent = 'Keep as new note';
  $('#conflict-save').className = 'btn-text danger';
  $('#conflict-save').textContent = 'Accept deletion';
  openModal($('#conflict-modal'));
}

async function showConflictResolverFor(noteID) {
  const conflict = await getUnresolvedConflict(noteID);
  if (!conflict) return false;
  if (conflict.kind === 'remote-deleted') showDeletedConflict(conflict);
  else showConflictResolver(conflict);
  return true;
}

function fillConflictResolution(version, selection) {
  $('#conflict-note-title').value = version.title || '';
  $('#conflict-note-tags').value = version.tags || '';
  $('#conflict-note-content').value = version.content || '';
  setConflictSelection(selection);
}

async function createConflictResolution(operation, remote) {
  // Always capture fresh keystrokes before replacing the cached note. This is
  // especially important for notification-driven sync, which can arrive while
  // the 250ms local-save timer is still pending.
  if (currentNoteId === operation.note_id && isDirty) await saveCurrentNote(false);
  const local = await getLocalNote(operation.note_id);
  if (!remote && operation.type === 'note.save' && (local || operation.note)) {
    await createRemoteDeletionConflict(operation, local || operation.note);
    return 'remote-deleted';
  }
  if (!local || !remote || operation.type !== 'note.save') {
    await preserveConflictCopy(operation, local, remote);
    return false;
  }

  const conflict = {
    note_id: operation.note_id,
    created_at: new Date().toISOString(),
    base: conflictBase(local, operation),
    local: {title: local.title || '', tags: local.tags || '', content: local.content || ''},
    remote: {...remote, title: remote.title || '', tags: remote.tags || '', content: remote.content || '', revision: remote.revision || 0, filename: remote.filename || ''},
  };
  // Persist the user's version before acknowledging the conflict locally. If
  // the browser closes now, reopening the note resumes this resolver.
  await setUnresolvedConflict(conflict);
  await putLocalNote({...remote, pending: false, base_revision: null, base_content: null, base_title: null, base_tags: null});
  await supersedeQueuedNoteOperations(operation.note_id, operation.client_sequence);
  await removePendingOperationIfIdentityMatches(operation.id, operation);
  // Bring the authoritative version into the normal editor before opening the
  // resolver, even if the conflict was discovered after navigating away. Any
  // note the user began editing during the request is saved locally first.
  if (isDirty) await saveCurrentNote(false);
  showNoteInEditor(remote);
  setNoteRoute(remote.id);
  showConflictResolver(conflict);
  if (!screens.dashboard.classList.contains('hidden')) void refreshDashboard();
  return true;
}

async function saveConflictResolution() {
  const noteID = activeConflictID;
  const conflict = noteID && await getUnresolvedConflict(noteID);
  if (!conflict) return;
  const now = new Date().toISOString();
  const resolved = {
    ...conflict.remote,
    id: noteID,
    title: $('#conflict-note-title').value.trim() || 'Untitled',
    tags: $('#conflict-note-tags').value.trim(),
    content: $('#conflict-note-content').value,
    updated_at: now,
    pending: true,
    base_revision: conflict.remote.revision,
    base_title: conflict.remote.title || '',
    base_tags: conflict.remote.tags || '',
    base_content: conflict.remote.content || '',
  };
  await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    await requestValue(stores.notes.put(resolved));
    await queueOperationInStores(stores, {type: 'note.save', note_id: noteID, base_revision: resolved.base_revision, note: resolved});
    await requestValue(stores.state.delete(unresolvedConflictKey(noteID)));
  });
  currentNoteId = noteID;
  isDirty = false;
  updateOpenNote(resolved);
  closeConflictResolver();
  showToast('Conflict resolution saved.', 'success');
  if (!screens.dashboard.classList.contains('hidden')) void refreshDashboard();
  scheduleSync();
}

async function keepConflictAsCopy() {
  const noteID = activeConflictID;
  const conflict = noteID && await getUnresolvedConflict(noteID);
  if (!conflict) return;
  const conflictID = newLocalNoteID();
  const now = new Date().toISOString();
  const copy = {
    id: conflictID,
    title: `${conflict.local.title || 'Untitled'} (conflict copy)`,
    filename: `${conflictID}.md`,
    tags: conflict.local.tags || '',
    content: conflict.local.content || '',
    created_at: now,
    updated_at: now,
    revision: 0,
    base_revision: 0,
    base_title: '',
    base_tags: '',
    base_content: '',
    pending: true,
  };
  await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    await requestValue(stores.notes.put(copy));
    await queueOperationInStores(stores, {type: 'note.save', note_id: copy.id, base_revision: 0, note: copy});
    await requestValue(stores.state.delete(unresolvedConflictKey(noteID)));
  });
  currentNoteId = copy.id;
  isDirty = false;
  updateOpenNote(copy);
  setNoteRoute(copy.id);
  closeConflictResolver();
  showToast('Your version was saved as a separate note.', 'success');
  if (!screens.dashboard.classList.contains('hidden')) void refreshDashboard();
  scheduleSync();
}

async function keepDeletedConflictAsCopy() {
  const noteID = activeConflictID;
  const conflict = noteID && await getUnresolvedConflict(noteID);
  if (!conflict || conflict.kind !== 'remote-deleted') return;
  const conflictID = newLocalNoteID();
  const now = new Date().toISOString();
  const copy = {
    ...conflict.local,
    id: conflictID,
    title: `${conflict.local.title || 'Untitled'} (conflict copy)`,
    filename: `${conflictID}.md`,
    created_at: conflict.local.created_at || now,
    updated_at: now,
    revision: 0,
    base_revision: 0,
    base_title: '',
    base_tags: '',
    base_content: '',
    pending: true,
  };
  await withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    await requestValue(stores.notes.put(copy));
    await queueOperationInStores(stores, {type: 'note.save', note_id: conflictID, base_revision: 0, note: copy});
    await requestValue(stores.notes.delete(noteID));
    await requestValue(stores.state.delete(unresolvedConflictKey(noteID)));
  });
  currentNoteId = conflictID;
  isDirty = false;
  updateOpenNote(copy);
  setNoteRoute(conflictID);
  closeConflictResolver();
  showToast('Your changes were saved as a new note.', 'success');
  if (!screens.dashboard.classList.contains('hidden')) void refreshDashboard();
  scheduleSync();
}

async function acceptDeletedConflict() {
  const noteID = activeConflictID;
  const conflict = noteID && await getUnresolvedConflict(noteID);
  if (!conflict || conflict.kind !== 'remote-deleted') return;
  await withOfflineStore(['notes', 'state'], 'readwrite', async stores => {
    await requestValue(stores.notes.delete(noteID));
    await requestValue(stores.state.delete(unresolvedConflictKey(noteID)));
  });
  if (currentNoteId === noteID) {
    clearCurrentNote();
    await loadDashboard({sync: false});
    setDashboardRoute({replace: true});
  }
  closeConflictResolver();
  showToast('The remote deletion was accepted.', 'success');
  scheduleSync();
}

$('#conflict-use-local').addEventListener('click', async () => {
  const conflict = activeConflictID && await getUnresolvedConflict(activeConflictID);
  if (conflict) fillConflictResolution(conflict.local, 'local');
});

$('#conflict-use-remote').addEventListener('click', async () => {
  const conflict = activeConflictID && await getUnresolvedConflict(activeConflictID);
  if (conflict) fillConflictResolution(conflict.remote, 'remote');
});

['#conflict-note-title', '#conflict-note-tags', '#conflict-note-content'].forEach(selector => {
  $(selector).addEventListener('input', () => {
    if (activeConflictID && activeConflictSelection !== 'custom') setConflictSelection('custom');
  });
});

$('#conflict-save').addEventListener('click', () => { void (activeConflictKind === 'remote-deleted' ? acceptDeletedConflict() : saveConflictResolution()); });
$('#conflict-copy').addEventListener('click', () => { void (activeConflictKind === 'remote-deleted' ? keepDeletedConflictAsCopy() : keepConflictAsCopy()); });
$('#conflict-later').addEventListener('click', closeConflictResolver);
$('#conflict-close').addEventListener('click', closeConflictResolver);
$('#conflict-modal .modal-backdrop').addEventListener('click', closeConflictResolver);

async function reconcileCompactedOperationLocally(operation, remote) {
  return withOfflineStore(['notes', 'queue'], 'readwrite', async stores => {
    const queued = await requestValue(stores.queue.get(operation.id));
    if (!queued || queued.op_id !== operation.op_id || queued.client_sequence !== operation.client_sequence || queueOperationPayload(queued) !== queueOperationPayload(operation)) {
      throw new Error('compacted sync operation changed before local reconciliation');
    }

    const operations = await requestValue(stores.queue.index('note_id').getAll(operation.note_id));
    let hasLater = false;
    for (const later of operations) {
      if (later.id === operation.id || later.client_sequence < 1 || later.attempted_at) continue;
      if (later.type !== 'note.save' && later.type !== 'note.delete') continue;
      if (remote) {
        later.base_revision = remote.revision;
        if (later.note) {
          later.note.base_revision = remote.revision;
          later.note.base_content = remote.content;
          later.note.base_title = remote.title;
          later.note.base_tags = remote.tags;
        }
        await requestValue(stores.queue.put(later));
      }
      hasLater = true;
    }

    const local = await requestValue(stores.notes.get(operation.note_id));
    if (remote && !hasLater) {
      await requestValue(stores.notes.put({...local, ...remote, pending: false, base_revision: null, base_content: null, base_title: null, base_tags: null}));
    } else if (remote && hasLater) {
      await requestValue(stores.notes.put({...remote, ...local, revision: remote.revision, pending: true, base_revision: remote.revision, base_content: remote.content, base_title: remote.title, base_tags: remote.tags}));
    } else if (!remote && !hasLater) {
      await requestValue(stores.notes.delete(operation.note_id));
    }
    await requestValue(stores.queue.delete(operation.id));
    return hasLater;
  });
}

async function acknowledgeCompactedOperation(operation) {
  if (operation.type !== 'note.save' && operation.type !== 'note.delete') {
    const removed = await removePendingOperationIfIdentityMatches(operation.id, operation);
    if (!removed) throw new Error('compacted sync operation changed before acknowledgement');
    return;
  }

  let remote = null;
  try {
    remote = await api(`/api/notes/${encodeURIComponent(operation.note_id)}`, {syncRequest: true, throwOnError: true});
  } catch (error) {
    // Only an explicit 404 proves that the note is absent. Timeouts, server
    // errors, authentication failures, and other errors must leave the queue
    // entry intact so the next sync can retry reconciliation.
    if (error?.responseStatus !== 404) throw error;
  }

  const hasLater = await reconcileCompactedOperationLocally(operation, remote);
  if (!hasLater && remote) updateOpenNote(remote);
  if (!hasLater && !remote && currentNoteId === operation.note_id && !isDirty) {
    clearCurrentNote();
    await loadDashboard({sync: false});
    setDashboardRoute({replace: true});
  }
}

const syncPushBatchLimit = 100;
const syncPushBatchByteLimit = 3 * 1024 * 1024;

function outgoingSyncOperation(operation) {
  const outgoing = {
    client_sequence: operation.client_sequence,
    op_id: operation.op_id,
    type: operation.type,
    note_id: operation.note_id,
    base_revision: operation.base_revision,
  };
  if (operation.type === 'note.save') {
    outgoing.title = operation.note.title;
    outgoing.tags = operation.note.tags;
    outgoing.content = operation.note.content;
    outgoing.base_content = operation.note.base_content || '';
  } else if (operation.type === 'prefs.save') {
    outgoing.prefs = operation.prefs;
  }
  return outgoing;
}

function encodedByteLength(value) {
  const encoded = JSON.stringify(value);
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(encoded).byteLength : encoded.length;
}

function claimPendingOperationBatch(deviceID, maxOperations, maxBytes) {
  return withOfflineStore(['queue'], 'readwrite', stores => new Promise((resolve, reject) => {
    const batch = [];
    const request = stores.queue.index('client_sequence').openCursor();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve(batch);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || batch.length >= maxOperations) {
        finish();
        return;
      }
      const operation = cursor.value;
      const candidate = [...batch.map(item => outgoingSyncOperation(item)), outgoingSyncOperation(operation)];
      const requestBytes = encodedByteLength({device_id: deviceID, operations: candidate});
      if (batch.length && requestBytes > maxBytes) {
        finish();
        return;
      }
      if (!operation.attempted_at) {
        operation.attempted_at = new Date().toISOString();
        cursor.update(operation);
      }
      batch.push(operation);
      if (batch.length >= maxOperations) finish();
      else cursor.continue();
    };
  }));
}

async function applySyncAcknowledgement(operation, acknowledgement) {
  if (acknowledgement.status === 'compacted') {
    await acknowledgeCompactedOperation(operation);
    return;
  }
  if (acknowledgement.status === 'conflict') {
    if (operation.type === 'prefs.save') {
      await resolvePreferenceConflict(operation);
      return;
    }
    const remote = await loadConflictRemoteNote(operation.note_id);
    if (await mergeConflictedNote(operation, remote)) {
      showToast('Merged your non-overlapping changes.', 'success');
    } else {
      const resolverReady = await createConflictResolution(operation, remote);
      if (resolverReady === 'remote-deleted') {
        await showConflictResolverFor(operation.note_id);
      } else if (resolverReady) showToast('Conflicting edits need your review.', 'warning');
      else showToast('A conflict copy was created so your changes are safe.', 'warning');
    }
    return;
  }
  if (acknowledgement.status !== 'applied') throw new Error('unknown sync acknowledgement');
  if (operation.type === 'prefs.save') {
    prefs = normalizePrefs({...prefs, revision: acknowledgement.revision || prefs.revision});
    localStorage.setItem('mdnotes-prefs', JSON.stringify(prefs));
    applyPrefs();
  }
  if (operation.type === 'note.save') {
    const acknowledgedNote = operation.note;
    const hasLater = await rebaseQueuedNoteOperations(operation.note_id, operation.id, acknowledgement.revision, acknowledgedNote);
    const local = await getLocalNote(operation.note_id);
    if (local) {
      await putLocalNote({...local, revision: acknowledgement.revision, pending: hasLater, base_revision: hasLater ? acknowledgement.revision : null, base_content: hasLater ? acknowledgedNote.content : null, base_title: hasLater ? acknowledgedNote.title : null, base_tags: hasLater ? acknowledgedNote.tags : null});
    }
    if (currentNoteId === operation.note_id) {
      currentRevision = acknowledgement.revision || 0;
      currentBaseRevision = hasLater ? acknowledgement.revision : null;
    }
  }
  await removePendingOperationIfIdentityMatches(operation.id, operation);
}

async function flushPendingChanges() {
  let pushed = false;
  let maxOperations = syncPushBatchLimit;
  for (;;) {
    const deviceID = await syncDeviceID();
    const operations = await claimPendingOperationBatch(deviceID, maxOperations, syncPushBatchByteLimit);
    if (!operations.length) return pushed;
    const result = await syncFetch('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({device_id: deviceID, operations: operations.map(outgoingSyncOperation)}),
    });
    pushed = true;
    if (result.response.status === 401) {
      requireAuthentication();
      const error = new Error('sign in required to sync');
      error.responseStatus = 401;
      throw error;
    }
    if (result.response.status === 409) {
      const expected = Number(result.data?.expected_sequence);
      if (await repairSyncSequenceGap(expected)) {
        showToast('Recovered a local sync gap. Retrying your changes.', 'warning');
        continue;
      }
      throw new Error(expected ? `sync sequence gap; expected ${expected}` : 'sync sequence conflict');
    }
    if (!result.response.ok) {
      const permanent = result.response.status === 400 || result.response.status === 413 || result.data?.permanent === true;
      if (permanent) {
        if (operations.length > 1) {
          maxOperations = result.response.status === 413 ? Math.max(1, Math.floor(maxOperations / 2)) : 1;
          continue;
        }
        if (await quarantineQueueOperation(operations[0], typeof result.data === 'string' ? result.data : result.data?.error)) {
          showToast('A local change needs attention before it can sync.', 'warning');
          continue;
        }
      }
      const error = new Error(typeof result.data === 'string' ? result.data : 'sync failed');
      error.responseStatus = result.response.status;
      throw error;
    }
    for (const operation of operations) {
      const acknowledgement = result.data?.acknowledged?.find(item => item.op_id === operation.op_id);
      if (!acknowledgement) throw new Error('sync acknowledgement missing');
      await applySyncAcknowledgement(operation, acknowledgement);
    }
  }
}

function preferenceValuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function resolvePreferenceConflict(operation) {
  const remote = await api('/api/prefs', {syncRequest: true});
  if (!remote) throw new Error('could not load remote preferences');
  const payload = operation.prefs || {};
  const patch = payload._sync_patch || {};
  const base = payload._sync_base || {};
  const safePatch = {};
  const conflicts = [];
  Object.entries(patch).forEach(([key, desired]) => {
    const current = remote[key];
    if (!(key in base) || (!preferenceValuesEqual(current, base[key]) && !preferenceValuesEqual(current, desired))) {
      conflicts.push(key);
    } else if (!preferenceValuesEqual(current, desired)) {
      safePatch[key] = desired;
    }
  });

  const next = normalizePrefs({...remote, ...safePatch});
  await withOfflineStore(['queue', 'state'], 'readwrite', async stores => {
    const queued = await requestValue(stores.queue.get(operation.id));
    if (!queued || queued.op_id !== operation.op_id || queued.client_sequence !== operation.client_sequence || queueOperationPayload(queued) !== queueOperationPayload(operation)) {
      throw new Error('preference operation changed before conflict resolution');
    }
    await requestValue(stores.queue.delete(operation.id));
    if (Object.keys(safePatch).length) {
      const safeBase = Object.fromEntries(Object.keys(safePatch).map(key => [key, remote[key]]));
      await queueOperationInStores(stores, {
        type: 'prefs.save',
        note_id: '__prefs__',
        base_revision: remote.revision,
        prefs: {...next, _sync_patch: safePatch, _sync_base: safeBase},
      });
    }
  });
  prefs = next;
  localStorage.setItem('mdnotes-prefs', JSON.stringify(prefs));
  applyPrefs();
  if (conflicts.length) {
    showToast('Some preferences changed on another device. Those settings were kept.', 'warning');
  }
  scheduleSync();
}

function mergeSyncScheduleOptions(options = {}) {
  syncScheduleOptions = {
    ...syncScheduleOptions,
    ...options,
    reconcile: Boolean(syncScheduleOptions.reconcile || options.reconcile),
  };
}

async function acquireSyncLease() {
  const now = Date.now();
  return withOfflineStore(['state'], 'readwrite', async stores => {
    const current = await requestValue(stores.state.get(syncLeaseKey));
    const lease = current?.value;
    if (lease && lease.owner !== syncTabID && Number(lease.expiresAt) > now) return false;
    await requestValue(stores.state.put({
      key: syncLeaseKey,
      value: {owner: syncTabID, expiresAt: now + syncLeaseDurationMs},
    }));
    return true;
  });
}

async function renewSyncLease() {
  const now = Date.now();
  try {
    await withOfflineStore(['state'], 'readwrite', async stores => {
      const current = await requestValue(stores.state.get(syncLeaseKey));
      if (current?.value?.owner !== syncTabID) return;
      await requestValue(stores.state.put({
        key: syncLeaseKey,
        value: {owner: syncTabID, expiresAt: now + syncLeaseDurationMs},
      }));
    });
  } catch (error) {
    console.warn('could not renew sync lease', error);
  }
}

async function releaseSyncLease() {
  if (syncLeaseRenewTimer) {
    clearInterval(syncLeaseRenewTimer);
    syncLeaseRenewTimer = null;
  }
  await withOfflineStore(['state'], 'readwrite', async stores => {
    const current = await requestValue(stores.state.get(syncLeaseKey));
    if (current?.value?.owner === syncTabID) await requestValue(stores.state.delete(syncLeaseKey));
  });
}

async function withSyncLeadership(work) {
  if (navigator.locks && typeof navigator.locks.request === 'function') {
    let acquired = false;
    let result;
    try {
      await navigator.locks.request('mdnotes-sync', {ifAvailable: true}, async lock => {
        if (!lock) return;
        acquired = true;
        result = await work();
      });
      if (acquired) return result;
    } catch (error) {
      if (acquired) throw error;
      console.warn('Web Locks unavailable; using IndexedDB sync lease', error);
    }
  }

  if (!await acquireSyncLease()) {
    scheduleSync({}, 500);
    return false;
  }
  syncLeaseRenewTimer = setInterval(() => { void renewSyncLease(); }, syncLeaseDurationMs / 3);
  try {
    return await work();
  } finally {
    await releaseSyncLease();
  }
}

function scheduleSync(options = {}, delayMs = 75) {
  mergeSyncScheduleOptions(options);
  if (syncScheduleTimer) return;
  const delay = Math.max(delayMs, syncRetryDelayMs);
  syncScheduleTimer = setTimeout(async () => {
    syncScheduleTimer = null;
    const requested = syncScheduleOptions;
    syncScheduleOptions = {};
    if (document.visibilityState === 'hidden') {
      scheduleSync(requested, 1000);
      return;
    }
    if (syncInFlight) {
      scheduleSync(requested, 100);
      return;
    }
    const synced = await syncNow(requested);
    if (synced) {
      syncRetryDelayMs = 0;
      if (!screens.dashboard.classList.contains('hidden')) await refreshDashboard();
      return;
    }
    if (syncFailed) {
      const index = syncRetryDelaysMs.indexOf(syncRetryDelayMs);
      syncRetryDelayMs = syncRetryDelaysMs[index + 1] || syncRetryDelaysMs[syncRetryDelaysMs.length - 1];
      scheduleSync(requested, syncRetryDelayMs);
    }
  }, delay);
}

async function performSync(options = {}) {
  const preserveSnackbar = Boolean(options.preserveSnackbar);
  let reconcile = Boolean(options.reconcile);
  if (syncScheduleTimer) {
    clearTimeout(syncScheduleTimer);
    syncScheduleTimer = null;
    reconcile = Boolean(reconcile || syncScheduleOptions.reconcile);
    syncScheduleOptions = {};
  }
  // Network requests and the authenticated SSE heartbeat are authoritative.
  // navigator.onLine is only an unreliable browser hint, particularly in an
  // installed mobile PWA, so it must never prevent a requested sync.
  if (syncInFlight) return false;
  syncInFlight = true;
  const wasOffline = syncFailed;
  try {
    // Save the visible editor locally before pulling. This never waits on the
    // network, but ensures a remote notification cannot overwrite the common
    // base needed to merge the user's newest keystrokes.
    if (!screens.editor.classList.contains('hidden') && isDirty) await saveCurrentNote(false);
    await pullRemoteChanges();
    if (reconcile) await reconcileLocalNotes();
    const pushed = await flushPendingChanges();
    if (pushed) await pullRemoteChanges();
    localStorage.setItem('mdnotes-offline-ready', '1');
    clearSyncDiagnostic();
    syncFailed = false;
    lastSuccessfulSyncAt = Date.now();
    syncRetryDelayMs = 0;
    setSyncStatus('online');
    if (!serverEvents) connectServerEvents();
    if (!preserveSnackbar) hideOfflineNotice();
    if (wasOffline && !preserveSnackbar) showToast('Back online. Changes synced.');
    return true;
  } catch (error) {
    console.warn('sync failed', error);
    if (isAbortError(error) && syncCancellationRequested) {
      syncCancellationRequested = false;
      return false;
    }
    if (!lastSyncDiagnostic) setSyncDiagnostic(error?.message || 'unknown sync error', error?.responseStatus);
    if (authenticationRequired) {
      // An expired or unavailable session is actionable, and is distinct from
      // losing network access. In particular, do not mask it with an offline
      // screen just because this browser has an offline cache.
      syncFailed = false;
      setSyncStatus('online');
      hideOfflineNotice();
      requireAuthentication();
      $('#login-error').textContent = 'Your session expired. Sign in again.';
      return false;
    }
    // A 4xx response proves that this server is reachable. Keeping the UI in
    // Offline in that case hides the actionable problem and makes retrying
    // misleading. Network failures and unavailable servers still use Offline.
    const responseStatus = error?.responseStatus || lastSyncResponseStatus;
    if (responseStatus >= 400 && responseStatus < 500) {
      syncFailed = false;
      setSyncStatus('online');
      hideOfflineNotice();
      const message = `Sync needs attention: ${error.message}`;
      if (lastSyncProblem !== message) {
        lastSyncProblem = message;
        showToast(message, 'warning');
      }
      return false;
    }
    lastSyncProblem = '';
    markServerOffline();
    return false;
  } finally {
    syncInFlight = false;
  }
}

async function syncNow(options = {}) {
  if (syncInFlight) return false;
  return withSyncLeadership(() => performSync(options));
}

const sseStaleAfterMs = 70000;
let serverEvents = null;
let serverHeartbeatAt = 0;
let serverEventsWatchdog = null;
let serverChangeTimer = null;
let serverChangePending = false;

function isServerEventsHealthy() {
  return Boolean(serverEvents && serverHeartbeatAt > 0 && Date.now() - serverHeartbeatAt <= sseStaleAfterMs);
}

function markServerOffline() {
  const shouldToast = !syncFailed;
  syncFailed = true;
  setSyncStatus('offline');
  showOfflineNotice();
  if (shouldToast) showToast('Working offline. Your changes are saved on this device.', 'warning');
}

async function handleServerHeartbeat() {
  serverHeartbeatAt = Date.now();
  if (!syncFailed) {
    if (!syncInFlight) setSyncStatus('online');
    return;
  }
  scheduleSync({reconcile: true});
}

function scheduleServerChangeSync() {
  serverChangePending = true;
  if (serverChangeTimer) return;
  serverChangeTimer = setTimeout(async () => {
    serverChangeTimer = null;
    serverChangePending = false;
    scheduleSync();
    if (serverChangePending) scheduleServerChangeSync();
  }, 75);
}

function connectServerEvents() {
  if (!('EventSource' in window) || serverEvents) return;
  serverHeartbeatAt = Date.now();
  const events = new EventSource('/api/events');
  serverEvents = events;
  events.addEventListener('server', event => {
    try { cacheAppVersion(JSON.parse(event.data)); } catch (_) {}
  });
  events.addEventListener('change', event => {
    serverHeartbeatAt = Date.now();
    try {
      if (JSON.parse(event.data).type === 'preferences') void loadPrefs();
    } catch (_) {}
    scheduleServerChangeSync();
  });
  events.addEventListener('heartbeat', () => { void handleServerHeartbeat(); });
  events.onopen = () => { void handleServerHeartbeat(); };
  events.onerror = () => {
    // EventSource emits error for its normal reconnect cycle too, especially
    // when Android briefly backgrounds a tab. It is not enough evidence to
    // label the whole app offline; regular HTTP sync remains authoritative.
    if (serverEvents === events) serverHeartbeatAt = 0;
  };
  if (!serverEventsWatchdog) {
    serverEventsWatchdog = setInterval(() => {
      if (!serverEvents || Date.now() - serverHeartbeatAt <= sseStaleAfterMs) return;
      serverEvents.close();
      serverEvents = null;
      // A missing heartbeat is a prompt to verify with real authenticated
      // HTTP, not an offline verdict by itself.
      void syncNow({reconcile: true}).then(synced => {
        if (synced) connectServerEvents();
      });
    }, 5000);
  }
}

function disconnectServerEvents() {
  if (serverEvents) serverEvents.close();
  serverEvents = null;
  serverHeartbeatAt = 0;
  if (serverEventsWatchdog) clearInterval(serverEventsWatchdog);
  serverEventsWatchdog = null;
  if (serverChangeTimer) clearTimeout(serverChangeTimer);
  serverChangeTimer = null;
  serverChangePending = false;
}

// --- Auth ---
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  authenticationRequired = false;
  clearSyncDiagnostic();
  const pw = e.target.password.value;
  const res = await api('/api/login', {method:'POST', body:JSON.stringify({password:pw})});
  if (res) {
    $('#login-error').textContent = '';
    cacheAppVersion(res);
    await loadPrefs();
    await restoreRoute();
    connectServerEvents();
    scheduleSync({reconcile: true});
  } else {
    $('#login-error').textContent = 'Wrong password';
  }
});

$('#logout-btn').addEventListener('click', async () => {
  cancelActiveSyncRequests();
  disconnectServerEvents();
  await api('/api/logout', {method:'POST'});
  try {
    await clearOfflineData();
  } catch (error) {
    console.error('could not clear local data during logout', error);
    showToast('Close other app tabs, then try signing out again.', 'warning');
    return;
  }
  localStorage.removeItem('mdnotes-offline-ready');
  localStorage.removeItem('mdnotes-prefs');
  show(screens.login);
  $('#login-form input').focus();
});

// --- Dashboard ---
let dashboardNotes = [];
let dashboardRenderGeneration = 0;

async function unresolvedConflictIDs() {
  const records = await withOfflineStore(['state'], 'readonly', stores => requestValue(stores.state.getAll()));
  return new Set(records
    .filter(record => record.key.startsWith('unresolvedConflict:') && record.value?.note_id)
    .map(record => record.value.note_id));
}

function renderDashboard(notes, conflicts) {
  const tags = [...new Set(notes.flatMap(note => (note.tags || '').split(',').map(tag => tag.trim()).filter(Boolean)))].sort((a, b) => a.localeCompare(b));
  if (currentTag && !tags.includes(currentTag)) currentTag = null;
  const bar = $('#tag-bar');
  let html = '<span class="tag'+(currentTag?'':' active')+'" data-tag="">All</span>';
  tags.forEach(t => {
    const active = t === currentTag ? ' active' : '';
    html += `<span class="tag${active}" data-tag="${esc(t)}">${esc(t)}</span>`;
  });
  bar.innerHTML = html;
  bar.querySelectorAll('.tag').forEach(el => {
    el.addEventListener('click', () => {
      currentTag = el.dataset.tag;
      renderDashboard(dashboardNotes, conflicts);
    });
  });
  if (currentTag) notes = notes.filter(note => noteHasTag(note, currentTag));
  const list = $('#note-list');
  if (notes.length === 0) {
    list.innerHTML = '<div class="note-empty">No notes yet</div>';
    return;
  }
  list.innerHTML = notes.map(n => `
    <div class="note-item" data-id="${esc(n.id)}">
      <div class="note-title">${esc(n.title || 'Untitled')}${conflicts.has(n.id) ? '<span class="note-conflict">Conflict</span>' : ''}</div>
      <div class="note-meta">${esc(formatDate(n.updated_at))}</div>
      ${n.tags ? '<div class="note-tags">'+n.tags.split(',').map(t=>`<span class="tag">${esc(t.trim())}</span>`).join('')+'</div>' : ''}
    </div>
  `).join('');
  list.querySelectorAll('.note-item').forEach(el => {
    el.addEventListener('click', () => openNote(el.dataset.id));
  });
}

function noteHasTag(note, tag) {
  return (note.tags || '').split(',').some(noteTag => noteTag.trim() === tag);
}

async function refreshDashboard() {
  const generation = ++dashboardRenderGeneration;
  const [notes, conflicts] = await Promise.all([getLocalNotes(), unresolvedConflictIDs()]);
  if (generation !== dashboardRenderGeneration) return;
  dashboardNotes = notes;
  renderDashboard(notes, conflicts);
}

async function syncDashboardInBackground() {
  scheduleSync();
}

async function loadDashboard({sync = true} = {}) {
  show(screens.dashboard);
  await refreshDashboard();
  if (sync) void syncDashboardInBackground();
}

function applyEditorPrefs() {
  $('.meta-pane').classList.toggle('collapsed', prefs.collapseDetails);
  $('#editor').classList.toggle('header-hidden', prefs.hideHeaderOnFullscreen && panelState !== 'both');
  if (prefs.hideToolbar) {
    $('.fmt-bar').classList.add('hidden');
  } else {
    $('.fmt-bar').classList.remove('hidden');
  }
}

// --- Editor ---
function startNewNote(title = '') {
  if (saveTimer) clearTimeout(saveTimer);
  if (localSaveTimer) clearTimeout(localSaveTimer);
  if (previewTimer) clearTimeout(previewTimer);
  setPanelState(prefs.hidePreview ? 'editor' : 'both');
  editorSessionGeneration++;
  currentNoteId = newLocalNoteID();
  currentRevision = 0;
  currentBaseRevision = null;
  isDirty = false;
  savedSnapshot = { title: '', tags: '', content: '' };
  $('#note-title').value = title;
  $('#note-tags').value = '';
  $('#note-content').value = '';
  $('#preview').innerHTML = '';
  renderedPreviewSource = null;
  setIdleSyncStatus();
  cachePreviewBlocks();
  applyEditorPrefs();
  show(screens.editor);
  $('#note-title').focus();
}

$('#new-note-btn').addEventListener('click', () => startNewNote());

$('#back-btn').addEventListener('click', async () => {
  if (saveTimer) clearTimeout(saveTimer);
  if (localSaveTimer) clearTimeout(localSaveTimer);
  if (previewTimer) clearTimeout(previewTimer);
  // Navigation waits only for the durable local save. Network replay then runs
  // after the cached dashboard is visible, rather than making Back feel slow.
  await saveCurrentNote(false);
  clearCurrentNote();
  await loadDashboard({sync: false});
  if ((await pendingOperations()).length) scheduleSync();
  setDashboardRoute();
});

function showNoteInEditor(data) {
  setPanelState(prefs.hidePreview ? 'editor' : 'both');
  editorSessionGeneration++;
  currentNoteId = data.id;
  currentRevision = data.revision || 0;
  currentBaseRevision = data.base_revision ?? null;
  isDirty = false;
  savedSnapshot = { title: data.title || '', tags: data.tags || '', content: data.content || '' };
  $('#note-title').value = data.title || '';
  $('#note-tags').value = data.tags || '';
  $('#note-content').value = data.content || '';
  setIdleSyncStatus();
  applyEditorPrefs();
  show(screens.editor);
  updatePreview();
}

async function openNote(id, {route = 'push'} = {}) {
  if (saveTimer) clearTimeout(saveTimer);
  if (localSaveTimer) clearTimeout(localSaveTimer);
  if (previewTimer) clearTimeout(previewTimer);
  if (!screens.editor.classList.contains('hidden') && currentNoteId !== id && (isDirty || localSavePromise)) {
    const saved = await saveCurrentNote(false);
    if (saved === false) return;
  }
  const data = await getLocalNote(id);
  if (!data) return;
  showNoteInEditor(data);
  if (route === 'push') setNoteRoute(id);
  await showConflictResolverFor(id);
  // The note is already usable from IndexedDB. Sync is driven by the central
  // scheduler, server events, and pending local work rather than navigation.
}

function normalizeWikiTitle(title) {
  return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

async function followWikiLink(title) {
  title = title.trim().replace(/\s+/g, ' ');
  if (!title) return;
  if (isDirty) await saveCurrentNote(false);
  const existing = (await getLocalNotes()).find(note => normalizeWikiTitle(note.title || '') === normalizeWikiTitle(title));
  if (existing) {
    await openNote(existing.id);
    return;
  }
  startNewNote(title);
  await saveCurrentNote(false);
  showToast(`Created “${title}”.`, 'success');
  scheduleSync();
}

async function restoreRoute({fetchRemote = false} = {}) {
  const noteID = noteIDFromLocation();
  if (!screens.editor.classList.contains('hidden') && isDirty) await saveCurrentNote(false);
  if (noteID && await getLocalNote(noteID)) {
    await openNote(noteID, {route: 'none'});
    return;
  }
  if (noteID && fetchRemote && !await hasPendingOperation(noteID) && !await getUnresolvedConflict(noteID)) {
    try {
      const remote = await api(`/api/notes/${encodeURIComponent(noteID)}`, {syncRequest: true, throwOnError: true});
      await putLocalNote({...remote, pending: false, base_revision: null, base_content: null, base_title: null, base_tags: null});
      await openNote(noteID, {route: 'none'});
      return;
    } catch (error) {
      if (error?.responseStatus !== 404) return;
    }
  }
  if (noteID) {
    setDashboardRoute({replace: true});
    showToast('That note is no longer available.', 'warning');
  }
  clearCurrentNote();
  await loadDashboard({sync: false});
}

async function restoreCachedStartup() {
  const noteID = noteIDFromLocation();
  if (noteID && await getLocalNote(noteID)) {
    await openNote(noteID, {route: 'none'});
    return;
  }
  await loadDashboard({sync: false});
  const conflicts = await unresolvedConflictIDs();
  for (const conflictID of conflicts) {
    if (await getLocalNote(conflictID) && await showConflictResolverFor(conflictID)) break;
  }
}

// --- Autosave ---
function markDirty() {
  if (!isDirty) {
    isDirty = true;
  }
}

function readEditorSnapshot() {
  return {
    title: $('#note-title').value.trim() || 'Untitled',
    tags: $('#note-tags').value.trim(),
    content: $('#note-content').value,
  };
}

function editorSnapshotIsCurrent(snapshot) {
  return editorSessionGeneration === snapshot.sessionGeneration &&
    currentNoteId === snapshot.noteID &&
    readEditorSnapshot().title === snapshot.title &&
    readEditorSnapshot().tags === snapshot.tags &&
    readEditorSnapshot().content === snapshot.content;
}

async function persistEditorSnapshot(snapshot, trySync) {
  if (editorSnapshotIsCurrent(snapshot) &&
      snapshot.title === savedSnapshot.title &&
      snapshot.tags === savedSnapshot.tags &&
      snapshot.content === savedSnapshot.content) {
    isDirty = false;
    if (trySync) await syncNow();
    return true;
  }

  const existing = await getLocalNote(snapshot.noteID);
  const baseRevision = existing?.pending ? existing.base_revision : (snapshot.baseRevision ?? 0);
  const baseContent = existing?.pending ? (existing.base_content ?? '') : (existing?.content || '');
  const baseTitle = existing?.pending ? (existing.base_title ?? existing.title ?? '') : (existing?.title || '');
  const baseTags = existing?.pending ? (existing.base_tags ?? existing.tags ?? '') : (existing?.tags || '');
  const now = new Date().toISOString();
  const local = {
    ...existing,
    title: snapshot.title,
    tags: snapshot.tags,
    content: snapshot.content,
    id: snapshot.noteID,
    filename: existing?.filename || `${snapshot.noteID}.md`,
    revision: existing?.revision ?? snapshot.revision ?? 0,
    base_revision: baseRevision,
    base_content: baseContent,
    base_title: baseTitle,
    base_tags: baseTags,
    pending: true,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  const unresolved = await getUnresolvedConflict(snapshot.noteID);
  if (unresolved?.kind === 'remote-deleted') {
    const conflictLocal = {...local, pending: false};
    try {
      await withOfflineStore(['notes', 'state'], 'readwrite', async stores => {
        await requestValue(stores.notes.put(conflictLocal));
        await requestValue(stores.state.put({
          key: unresolvedConflictKey(snapshot.noteID),
          value: {...unresolved, local: conflictLocal},
        }));
      });
    } catch (error) {
      console.error('local conflict update failed', error);
      showToast('Could not save locally. Free browser storage and try again.', 'warning');
      return false;
    }
    if (editorSnapshotIsCurrent(snapshot)) {
      currentBaseRevision = null;
      savedSnapshot = {title: snapshot.title, tags: snapshot.tags, content: snapshot.content};
      isDirty = false;
      if (noteIDFromLocation() !== snapshot.noteID) setNoteRoute(snapshot.noteID);
      setIdleSyncStatus();
    }
    return true;
  }
  try {
    await saveLocalNoteAndQueue(local, {type: 'note.save', note_id: snapshot.noteID, base_revision: baseRevision, note: local});
  } catch (error) {
    console.error('local save failed', error);
    showToast('Could not save locally. Free browser storage and try again.', 'warning');
    return false;
  }

  // The IndexedDB write may have completed after another editor session was
  // opened or after more text was entered. Only this exact session/snapshot
  // may update the live editor state.
  if (editorSnapshotIsCurrent(snapshot)) {
    currentBaseRevision = baseRevision;
    savedSnapshot = {title: snapshot.title, tags: snapshot.tags, content: snapshot.content};
    isDirty = false;
    if (noteIDFromLocation() !== snapshot.noteID) setNoteRoute(snapshot.noteID);
    setIdleSyncStatus();
  }
  if (trySync) await syncNow();
  return true;
}

function saveCurrentNote(trySync = true) {
  localSaveRequested = true;
  localSaveTrySync = localSaveTrySync || trySync;
  if (localSavePromise) return localSavePromise;

  localSavePromise = (async () => {
    let result = true;
    while (localSaveRequested) {
      localSaveRequested = false;
      const requestedTrySync = localSaveTrySync;
      localSaveTrySync = false;
      const noteID = currentNoteId || newLocalNoteID();
      if (!currentNoteId) currentNoteId = noteID;
      const data = readEditorSnapshot();
      const snapshot = {
        ...data,
        noteID,
        revision: currentRevision,
        baseRevision: currentBaseRevision ?? currentRevision ?? 0,
        sessionGeneration: editorSessionGeneration,
      };
      result = await persistEditorSnapshot(snapshot, requestedTrySync);
    }
    return result;
  })().finally(() => {
    localSavePromise = null;
  });
  return localSavePromise;
}

let saveTimer = null;
let localSaveTimer = null;
let previewTimer = null;
let localSavePromise = null;
let localSaveRequested = false;
let localSaveTrySync = false;

function scheduleSave() {
  if (localSaveTimer) clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(() => {
    localSaveTimer = null;
    if (isDirty) void saveCurrentNote(false);
  }, 250);
  if (!prefs.autoSave) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // The 250ms timer may already have durably saved this edit to IndexedDB
    // and cleared isDirty. Still call saveCurrentNote: its unchanged-note path
    // replays the queued operation, which is the intended 2s idle sync.
    if (!screens.editor.classList.contains('hidden')) void saveCurrentNote();
  }, 2000);
}

$('#save-btn').addEventListener('click', () => { if (saveTimer) clearTimeout(saveTimer); void saveCurrentNote(); });
$('#note-title').addEventListener('input', () => { markDirty(); scheduleSave(); });
$('#note-tags').addEventListener('input', () => { markDirty(); scheduleSave(); });

// --- Formatting toolbar ---
const tablePicker = document.createElement('div');
tablePicker.id = 'table-picker';
tablePicker.className = 'table-picker hidden';
tablePicker.setAttribute('role', 'dialog');
tablePicker.setAttribute('aria-label', 'Choose table size');
tablePicker.innerHTML = '<div class="table-picker-label" aria-live="polite">Table</div><div class="table-grid" role="grid"></div>';
document.body.append(tablePicker);

const tableGrid = tablePicker.querySelector('.table-grid');
const tablePickerLabel = tablePicker.querySelector('.table-picker-label');
const tablePickerRows = 6;
const tablePickerColumns = 8;

for (let row = 1; row <= tablePickerRows; row++) {
  for (let column = 1; column <= tablePickerColumns; column++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'table-grid-cell';
    cell.dataset.rows = String(row);
    cell.dataset.columns = String(column);
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('aria-label', `${column} columns by ${row} rows`);
    tableGrid.append(cell);
  }
}

function setTableGridHighlight(rows = 0, columns = 0) {
  tablePickerLabel.textContent = rows && columns ? `${columns} × ${rows} table` : 'Table';
  tableGrid.querySelectorAll('.table-grid-cell').forEach(cell => {
    cell.classList.toggle('active', Number(cell.dataset.rows) <= rows && Number(cell.dataset.columns) <= columns);
  });
}

function hideTablePicker() {
  tablePicker.classList.add('hidden');
  $('.fmt-bar [data-fmt="table"]').setAttribute('aria-expanded', 'false');
  setTableGridHighlight();
}

function showTablePicker(trigger) {
  tablePicker.classList.remove('hidden');
  trigger.setAttribute('aria-expanded', 'true');
  const rect = trigger.getBoundingClientRect();
  const gutter = 8;
  const left = Math.min(Math.max(gutter, rect.left), window.innerWidth - tablePicker.offsetWidth - gutter);
  const top = Math.min(rect.bottom + gutter, window.innerHeight - tablePicker.offsetHeight - gutter);
  tablePicker.style.left = `${left}px`;
  tablePicker.style.top = `${top}px`;
}

function insertTable(rows, columns) {
  const ta = $('#note-content');
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const header = Array.from({length: columns}, (_, index) => `Column ${index + 1}`);
  const divider = Array.from({length: columns}, () => '---');
  const body = Array.from({length: Math.max(0, rows - 1)}, () => Array(columns).fill(''));
  const markdownRows = [header, divider, ...body].map(row => `| ${row.join(' | ')} |`);
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  const prefix = before && !before.endsWith('\n') ? '\n\n' : '';
  const suffix = after && !after.startsWith('\n') ? '\n\n' : '';
  const table = markdownRows.join('\n');
  const insertion = prefix + table + suffix;
  const firstCell = start + prefix.length + markdownRows[0].length + 1 + markdownRows[1].length + 3;

  ta.setRangeText(insertion, start, end, 'end');
  ta.focus();
  ta.selectionStart = ta.selectionEnd = firstCell;
  ta.dispatchEvent(new Event('input'));
}

tableGrid.addEventListener('pointerover', e => {
  const cell = e.target.closest('.table-grid-cell');
  if (cell) setTableGridHighlight(Number(cell.dataset.rows), Number(cell.dataset.columns));
});

tableGrid.addEventListener('focusin', e => {
  const cell = e.target.closest('.table-grid-cell');
  if (cell) setTableGridHighlight(Number(cell.dataset.rows), Number(cell.dataset.columns));
});

tableGrid.addEventListener('click', e => {
  const cell = e.target.closest('.table-grid-cell');
  if (!cell) return;
  insertTable(Number(cell.dataset.rows), Number(cell.dataset.columns));
  hideTablePicker();
});

document.addEventListener('pointerdown', e => {
  if (!tablePicker.classList.contains('hidden') && !e.target.closest('#table-picker, [data-fmt="table"]')) hideTablePicker();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !tablePicker.classList.contains('hidden')) hideTablePicker();
});

window.addEventListener('resize', hideTablePicker);

function insertFmt(type) {
  const ta = $('#note-content');
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const sel = ta.value.slice(start, end);
  const line = ta.value.slice(0, start).split('\n').pop();
  const lineStart = start - line.length;

  const fmts = {
    bold:       ['**', '**'],
    italic:     ['*', '*'],
    strike:     ['~~', '~~'],
    code:       ['`', '`'],
    link:       ['[', '](url)'],
    image:      ['![', '](url)'],
    h1:         ['# ', '\n'],
    h2:         ['## ', '\n'],
    h3:         ['### ', '\n'],
    h4:         ['#### ', '\n'],
    h5:         ['##### ', '\n'],
    h6:         ['###### ', '\n'],
    ul:         ['- ', '\n'],
    ol:         ['1. ', '\n'],
    task:       ['- [ ] ', '\n'],
    blockquote: ['> ', '\n'],
    hr:         ['\n---\n', ''],
  };

  const f = fmts[type];
  if (!f) return;

  let inserted;
  let cursor;
  let clean = false;

  const headings = ['h1','h2','h3','h4','h5','h6'];
  const toggles = ['ul','ol','task','blockquote'];

  if (headings.includes(type)) {
    const prefix = f[0];
    const re = new RegExp('^#{1,6}\\s');
    if (line.trim().match(re)) {
      const stripped = line.trim().replace(re, '');
      ta.value = ta.value.slice(0, lineStart) + stripped + ta.value.slice(start);
      cursor = lineStart + stripped.length;
      clean = true;
    } else {
      inserted = prefix + line.trimStart();
      ta.value = ta.value.slice(0, lineStart) + inserted + ta.value.slice(start);
      cursor = lineStart + inserted.length;
    }
  } else if (toggles.includes(type)) {
    const prefix = f[0];
    const lines = sel ? sel.split('\n') : [line.trim() || 'item'];
    const toggled = lines.map(l => l.startsWith(prefix) ? l.slice(prefix.length) : prefix + l).join('\n');
    ta.value = ta.value.slice(0, start) + toggled + ta.value.slice(end);
    cursor = start + toggled.length;
    clean = !sel;
  } else if (type === 'hr') {
    inserted = '\n---\n';
    ta.value = ta.value.slice(0, start) + inserted + ta.value.slice(end);
    cursor = start + inserted.length;
  } else if (type === 'codeblock') {
    if (sel) {
      inserted = '```\n' + sel + '\n```';
      ta.value = ta.value.slice(0, start) + inserted + ta.value.slice(end);
      cursor = start + inserted.length;
    } else {
      inserted = '```\n\n```';
      ta.value = ta.value.slice(0, start) + inserted + ta.value.slice(end);
      cursor = start + 4;
    }
  } else if (type === 'table') {
    inserted = '\n| col1 | col2 |\n|------|------|\n|  |  |\n';
    ta.value = ta.value.slice(0, start) + inserted + ta.value.slice(end);
    cursor = start + inserted.length;
  } else {
    // inline: bold, italic, strike, code, link, image
    if (sel) {
      inserted = f[0] + sel + f[1];
      ta.value = ta.value.slice(0, start) + inserted + ta.value.slice(end);
      cursor = start + inserted.length;
    } else {
      inserted = f[0] + f[1];
      ta.value = ta.value.slice(0, start) + inserted + ta.value.slice(end);
      cursor = start + f[0].length;
    }
  }

  ta.focus();
  ta.selectionStart = ta.selectionEnd = clean ? cursor : cursor;
  ta.dispatchEvent(new Event('input'));
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  updatePreview();
}

document.querySelector('.fmt-bar')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-fmt]');
  if (btn) {
    e.preventDefault();
    if (btn.dataset.fmt === 'table') {
      if (tablePicker.classList.contains('hidden')) showTablePicker(btn);
      else hideTablePicker();
      return;
    }
    insertFmt(btn.dataset.fmt);
  }
});

// Shortcuts for bold/italic in textarea
$('#note-content').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'i')) {
    e.preventDefault();
    insertFmt(e.key === 'b' ? 'bold' : 'italic');
  }
});

// --- Meta pane toggle ---
$('.meta-toggle')?.addEventListener('click', () => {
  $('.meta-pane').classList.toggle('collapsed');
});

// --- Panel toggle ---
function setPanelState(state) {
  panelState = state;
  if (state === 'both') panelWide = false;
  const wrap = $('#editor-panels');
  const ed = $('.panel-editor');
  const pv = $('.panel-preview');
  wrap.classList.remove('panels-single');
  ed.classList.remove('panel-hidden');
  pv.classList.remove('panel-hidden');
  if (state === 'editor') {
    pv.classList.add('panel-hidden');
    wrap.classList.add('panels-single');
  } else if (state === 'preview') {
    ed.classList.add('panel-hidden');
    wrap.classList.add('panels-single');
  }
  wrap.classList.toggle('panel-wide', panelWide && state !== 'both');
  $('#editor').classList.toggle('header-hidden', prefs.hideHeaderOnFullscreen && state !== 'both');
  document.querySelectorAll('.panel-layout').forEach(button => {
    const focused = state === button.dataset.panel;
    button.title = focused ? 'Show split view' : `Focus ${button.dataset.panel}`;
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(focused));
    button.querySelector('use').setAttribute('href', focused ? '#icon-minimize' : '#icon-maximize');
  });
  document.querySelectorAll('.panel-width').forEach(button => {
    const label = panelWide ? 'Use reading width' : 'Use full width';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(panelWide));
    button.querySelector('use').setAttribute('href', panelWide ? '#icon-width-reading' : '#icon-width-full');
  });
  applyPanelRatio();
  if (state !== 'editor') schedulePreviewCheck();
}

$('#editor-panels').addEventListener('click', e => {
  const switchButton = e.target.closest('.panel-switch');
  if (switchButton) {
    setPanelState(switchButton.dataset.panelSwitch);
    return;
  }
  const widthButton = e.target.closest('.panel-width');
  if (widthButton) {
    if (panelState !== 'both') {
      panelWide = !panelWide;
      setPanelState(panelState);
    }
    return;
  }
  const btn = e.target.closest('.panel-layout');
  if (!btn) return;
  if (panelState === 'both') {
    setPanelState(btn.dataset.panel);
  } else {
    setPanelState('both');
  }
});

function applyPanelRatio() {
  $('#editor-panels').style.setProperty('--editor-panel-width', `${Math.round(panelRatio * 1000) / 10}%`);
  $('#panel-resizer').setAttribute('aria-valuenow', String(Math.round(panelRatio * 100)));
}

function setPanelRatio(ratio) {
  panelRatio = Math.min(.8, Math.max(.2, ratio));
  localStorage.setItem('mdnotes-panel-ratio', String(panelRatio));
  applyPanelRatio();
}

const panelResizer = $('#panel-resizer');
panelResizer.addEventListener('pointerdown', event => {
  if (panelState !== 'both' || window.matchMedia('(max-width: 640px)').matches) return;
  event.preventDefault();
  panelResizer.setPointerCapture(event.pointerId);
  $('#editor-panels').classList.add('resizing');
});
panelResizer.addEventListener('pointermove', event => {
  if (!panelResizer.hasPointerCapture(event.pointerId)) return;
  const bounds = $('#editor-panels').getBoundingClientRect();
  setPanelRatio((event.clientX - bounds.left) / bounds.width);
});
function finishPanelResize(event) {
  if (panelResizer.hasPointerCapture(event.pointerId)) panelResizer.releasePointerCapture(event.pointerId);
  $('#editor-panels').classList.remove('resizing');
}
panelResizer.addEventListener('pointerup', finishPanelResize);
panelResizer.addEventListener('pointercancel', finishPanelResize);
panelResizer.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft') { event.preventDefault(); setPanelRatio(panelRatio - .05); }
  if (event.key === 'ArrowRight') { event.preventDefault(); setPanelRatio(panelRatio + .05); }
  if (event.key === 'Home') { event.preventDefault(); setPanelRatio(.2); }
  if (event.key === 'End') { event.preventDefault(); setPanelRatio(.8); }
});
applyPanelRatio();

// --- Cursor preview highlight ---
let previewBlocks = [];
function isPreviewVisible() {
  return !screens.editor.classList.contains('hidden') && panelState !== 'editor';
}
function schedulePreviewCheck() {
  if (previewCheckFrame !== null) return;
  previewCheckFrame = requestAnimationFrame(() => {
    previewCheckFrame = null;
    updatePreview();
  });
}
function scheduleHighlight() {
  if (highlightFrame !== null) return;
  highlightFrame = requestAnimationFrame(() => {
    highlightFrame = null;
    highlightBlock();
  });
}
function cachePreviewBlocks() {
  const pv = $('#preview');
  previewBlocks = Array.from(pv.children).filter(c => c.tagName && !['STYLE','SCRIPT'].includes(c.tagName));
}
function highlightBlock() {
  if (!isPreviewVisible()) return;
  if (prefs.hideCursorHighlight) {
    const cur = $('#preview').querySelector('.highlight');
    if (cur) cur.classList.remove('highlight');
    return;
  }
  const ta = $('#note-content');
  const pv = $('#preview');
  const cur = pv.querySelector('.highlight');
  if (cur) cur.classList.remove('highlight');
  const text = ta.value;
  const pos = ta.selectionStart;
  if (!text.trim() || !previewBlocks.length) return;
  const before = text.slice(0, pos);
  const nonEmpty = before.split(/\n\n+/).filter(b => b.trim());
  let idx = Math.max(0, nonEmpty.length - 1);
  if (idx >= previewBlocks.length) idx = previewBlocks.length - 1;
  previewBlocks[idx]?.classList.add('highlight');
}

// --- Delete ---
$('#delete-btn').addEventListener('click', async () => {
  if (!currentNoteId) return;
  if (!confirm('Delete this note?')) return;
  const noteID = currentNoteId;
  if (isDirty || localSavePromise) {
    const saved = await saveCurrentNote(false);
    if (saved === false || currentNoteId !== noteID) return;
  }
  const local = await getLocalNote(noteID);
  if (!local) return;
  const pending = await pendingOperationsForNote(noteID);
  const hasAttemptedOperation = pending.some(operation => Boolean(operation.attempted_at));
  if (pending.length && !hasAttemptedOperation && (local.base_revision || 0) === 0) {
    await removeLocalNoteAndSupersede(noteID, 0);
  } else {
    await removeLocalNoteAndQueue(noteID, {type: 'note.delete', note_id: noteID, base_revision: local.base_revision ?? local.revision});
  }
  editorSessionGeneration++;
  currentNoteId = null;
  currentRevision = 0;
  currentBaseRevision = null;
  if (currentTag) {
    const remainingNotes = await getLocalNotes();
    if (!remainingNotes.some(note => noteHasTag(note, currentTag))) currentTag = null;
  }
  setIdleSyncStatus();
  scheduleSync();
  await loadDashboard({sync: false});
  setDashboardRoute({replace: true});
});

// --- Live Preview ---
$('#note-content').addEventListener('input', () => {
  markDirty();
  scheduleSave();
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 500);
});
$('#note-content').addEventListener('click', scheduleHighlight);
$('#note-content').addEventListener('keyup', scheduleHighlight);

function linkifyWikiLinks(container) {
  const matcher = /\[\[([^\[\]\n]+)\]\]/g;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!matcher.test(node.nodeValue || '')) return NodeFilter.FILTER_REJECT;
      matcher.lastIndex = 0;
      return node.parentElement?.closest('a, code, pre, script, style')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue || '';
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    matcher.lastIndex = 0;
    for (let match; (match = matcher.exec(text));) {
      const title = match[1].trim().replace(/\s+/g, ' ');
      if (!title) continue;
      fragment.append(document.createTextNode(text.slice(cursor, match.index)));
      const link = document.createElement('a');
      link.className = 'wiki-link';
      link.href = '/';
      link.dataset.wikiTitle = title;
      link.textContent = title;
      fragment.append(link);
      cursor = match.index + match[0].length;
    }
    fragment.append(document.createTextNode(text.slice(cursor)));
    node.replaceWith(fragment);
  }
}

const previewAllowedElements = new Set([
  'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'IMG', 'INPUT', 'LI', 'OL', 'P', 'PRE', 'S', 'STRONG', 'SUB', 'SUP', 'TABLE',
  'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL',
]);
const previewAllowedAttributes = new Set(['align', 'alt', 'checked', 'class', 'colspan', 'disabled', 'href', 'rowspan', 'src', 'title', 'type']);

function safePreviewURL(value, allowMailto = false) {
  if (!value || /[\u0000-\u001f]/.test(value)) return false;
  try {
    const url = new URL(value, window.location.href);
    return ['http:', 'https:'].includes(url.protocol) || (allowMailto && url.protocol === 'mailto:');
  } catch (_) {
    return false;
  }
}

function sanitizePreview(container) {
  [...container.querySelectorAll('*')].forEach(element => {
    if (!previewAllowedElements.has(element.tagName)) {
      element.remove();
      return;
    }
    const attributeNames = [];
    for (let index = 0; index < element.attributes.length; index++) {
      const attribute = element.attributes.item(index);
      if (attribute?.name) attributeNames.push(attribute.name);
    }
    attributeNames.forEach(attributeName => {
      const name = attributeName.toLowerCase();
      if (!previewAllowedAttributes.has(name) || name.startsWith('on')) element.removeAttribute(attributeName);
    });
    if (element.tagName === 'A') {
      const href = element.getAttribute('href');
      if (href && !safePreviewURL(href, true)) element.removeAttribute('href');
    }
    if (element.tagName === 'IMG') {
      const src = element.getAttribute('src');
      if (!src || !safePreviewURL(src)) {
        element.remove();
        return;
      }
      element.setAttribute('loading', 'lazy');
      element.setAttribute('decoding', 'async');
    }
    if (element.tagName === 'INPUT' && element.getAttribute('type') !== 'checkbox') element.remove();
  });
}

function markdownRenderOptions() {
  const options = {breaks:true, gfm:true};
  if (typeof marked.Renderer === 'function') {
    const renderer = new marked.Renderer();
    renderer.html = token => esc(token.text ?? token.raw ?? '');
    options.renderer = renderer;
  }
  return options;
}

$('#preview').addEventListener('click', event => {
  const link = event.target.closest('a[data-wiki-title]');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  void followWikiLink(link.dataset.wikiTitle);
});

function updatePreview() {
  if (!isPreviewVisible()) return;
  const md = $('#note-content').value;
  if (md === renderedPreviewSource) {
    scheduleHighlight();
    return;
  }
  if (typeof marked !== 'undefined' && marked.parse) {
    $('#preview').innerHTML = marked.parse(md, markdownRenderOptions());
    sanitizePreview($('#preview'));
    linkifyWikiLinks($('#preview'));
  } else {
    $('#preview').innerHTML = '<p><em>loading parser...</em></p>';
  }
  renderedPreviewSource = md;
  cachePreviewBlocks();
  scheduleHighlight();
}

// --- Utils ---
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'});
}

// --- Theme and appearance ---
const themeDefinitions = Array.isArray(window.MDNotesThemes) ? window.MDNotesThemes : [];
const themeByID = new Map(themeDefinitions.map(theme => [theme.id, theme]));

function kebabCase(value) {
  return value.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}

function validAccentColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '';
}

function legacyThemeID() {
  const saved = localStorage.getItem('theme');
  if (saved === 'dark') return 'default-dark';
  if (saved === 'light') return 'default-light';
  return window.matchMedia('(prefers-color-scheme:dark)').matches ? 'default-dark' : 'default-light';
}

function normalizePrefs(value = {}, fallback = {}) {
  const merged = {...DEFAULT_PREFS, ...fallback, ...value};
  merged.revision = Number.isSafeInteger(Number(merged.revision)) && Number(merged.revision) > 0 ? Number(merged.revision) : 1;
  if (!value.theme && !fallback.theme) merged.theme = legacyThemeID();
  if (!themeByID.has(merged.theme)) merged.theme = legacyThemeID();
  if (!validAccentColor(merged.accentColor)) merged.accentColor = '';
  ['fontFamily', 'editorFontFamily', 'previewFontFamily'].forEach(key => {
    if (merged[key] === 'system') merged[key] = key === 'editorFontFamily' ? 'system-monospace' : 'system-sans';
    if (!['system-sans', 'system-serif', 'system-monospace', ...FONT_OPTIONS].includes(merged[key])) merged[key] = DEFAULT_PREFS[key];
  });
  return merged;
}

function applyTheme(themeID = prefs.theme) {
  const theme = themeByID.get(themeID) || themeByID.get('default-light');
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.classList.toggle('dark', Boolean(theme.dark));
  Object.entries(theme.vars).forEach(([name, value]) => root.style.setProperty(`--${kebabCase(name)}`, value));
  if (prefs.accentColor) {
    root.style.setProperty('--accent', prefs.accentColor);
    root.style.setProperty('--accent-hover', 'color-mix(in srgb,var(--accent) 82%,#000)');
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.vars.bg);
}

function fontCSSURL(fontFamily) {
  const family = encodeURIComponent(fontFamily).replace(/%20/g, '+');
  return `https://fonts.googleapis.com/css2?family=${family}:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600;1,700&display=swap`;
}

function isSystemFont(fontFamily) {
  return ['system-sans', 'system-serif', 'system-monospace'].includes(fontFamily);
}

function systemFontStack(fontFamily) {
  if (fontFamily === 'system-serif') return SYSTEM_SERIF_STACK;
  if (fontFamily === 'system-monospace') return SYSTEM_MONO_STACK;
  return SYSTEM_FONT_STACK;
}

async function clearFontCache() {
  if ('caches' in window) await caches.delete(FONT_CACHE_NAME).catch(() => {});
}

const FONT_SLOTS = [
  {preference:'fontFamily', variable:'--font'},
  {preference:'editorFontFamily', variable:'--editor-font'},
  {preference:'previewFontFamily', variable:'--preview-font'},
];

function removeLoadedFonts() {
  document.querySelectorAll('[data-mdnotes-font]').forEach(link => link.remove());
  FONT_SLOTS.forEach(slot => document.documentElement.style.setProperty(slot.variable, systemFontStack(prefs[slot.preference])));
}

async function applyFontsNow(clearCache = false) {
  const generation = ++fontLoadGeneration;
  if (clearCache) await clearFontCache();
  removeLoadedFonts();
  const families = [...new Set(FONT_SLOTS.map(slot => prefs[slot.preference]).filter(font => font && !isSystemFont(font)))];
  const loaded = new Map();
  await Promise.all(families.map(async fontFamily => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.mdnotesFont = fontFamily;
    link.href = fontCSSURL(fontFamily);
    document.head.append(link);
    try {
      await new Promise((resolve, reject) => {
        link.addEventListener('load', resolve, {once:true});
        link.addEventListener('error', reject, {once:true});
        setTimeout(() => reject(new Error('font load timed out')), 5000);
      });
      const loadedFaces = await document.fonts.load(`1rem "${fontFamily}"`);
      if (!loadedFaces || loadedFaces.length === 0) throw new Error('font face unavailable');
      loaded.set(fontFamily, true);
    } catch (error) {
      link.remove();
      console.warn(`font unavailable: ${fontFamily}`, error);
    }
  }));
  if (generation !== fontLoadGeneration) return;
  FONT_SLOTS.forEach(slot => {
    const fontFamily = prefs[slot.preference];
    if (!isSystemFont(fontFamily) && loaded.has(fontFamily)) document.documentElement.style.setProperty(slot.variable, `"${fontFamily}",${SYSTEM_FONT_STACK}`);
  });
}

function applyFonts(clearCache = false) {
  const run = fontApplyQueue.then(() => applyFontsNow(clearCache));
  fontApplyQueue = run.catch(() => {});
  return run;
}

function renderThemeOptions() {
  const select = $('#pref-theme');
  select.innerHTML = themeDefinitions.map(theme => `<option value="${esc(theme.id)}">${esc(theme.name)}</option>`).join('');
}

function renderFontOptions() {
  const localOptions = SYSTEM_FONT_OPTIONS.map(option => `<option value="${esc(option.value)}">${esc(option.label)}</option>`).join('');
  const downloadableOptions = FONT_OPTIONS.map(font => `<option value="${esc(font)}"${fontAvailability === 'available' ? '' : ' disabled'}>${esc(font)}</option>`).join('');
  ['#pref-font', '#pref-editor-font', '#pref-preview-font'].forEach(selector => {
    const target = $(selector);
    target.disabled = false;
    target.innerHTML = localOptions + downloadableOptions;
  });
  $('#pref-font').value = prefs.fontFamily;
  $('#pref-editor-font').value = prefs.editorFontFamily;
  $('#pref-preview-font').value = prefs.previewFontFamily;
}

function applyPrefs() {
  applyTheme(prefs.theme);
  void applyFonts();
  applyEditorPrefs();
}

renderThemeOptions();
renderFontOptions();
applyPrefs();

// Apply cached preferences immediately, then the server's preferences later.
try {
  const cached = JSON.parse(localStorage.getItem('mdnotes-prefs') || '{}');
  prefs = normalizePrefs(cached);
  applyPrefs();
} catch (_) {
  prefs = normalizePrefs();
  applyPrefs();
}

$('#prefs-btn').addEventListener('click', () => {
  $('#pref-autosave').checked = prefs.autoSave;
  $('#pref-hidepreview').checked = prefs.hidePreview;
  $('#pref-hideheader').checked = prefs.hideHeaderOnFullscreen;
  $('#pref-hidetoolbar').checked = prefs.hideToolbar;
  $('#pref-collapse').checked = prefs.collapseDetails;
  $('#pref-hidecursor').checked = prefs.hideCursorHighlight;
  $('#pref-theme').value = prefs.theme;
  $('#pref-accent').value = prefs.accentColor || themeByID.get(prefs.theme)?.vars.accent || '#ae2448';
  $('#pref-font').value = prefs.fontFamily;
  $('#pref-editor-font').value = prefs.editorFontFamily;
  $('#pref-preview-font').value = prefs.previewFontFamily;
  openModal($('#prefs-modal'));
  void checkFontAvailability(fontAvailability === 'unavailable');
});

$('#prefs-close').addEventListener('click', () => {
  closeModal($('#prefs-modal'));
});

$('#prefs-modal .modal-backdrop').addEventListener('click', () => {
  closeModal($('#prefs-modal'));
});

async function savePref(key, value) {
  const previous = {...prefs};
  prefs = normalizePrefs({...prefs, [key]: value});
  localStorage.setItem('mdnotes-prefs', JSON.stringify(prefs));
  await queueOperation({
    type: 'prefs.save',
    note_id: '__prefs__',
    base_revision: previous.revision || 1,
    prefs: {
      ...prefs,
      _sync_patch: {[key]: prefs[key]},
      _sync_base: {[key]: previous[key]},
    },
  });
  if (key === 'theme' || key === 'accentColor') applyTheme(prefs.theme);
  if (['fontFamily', 'editorFontFamily', 'previewFontFamily'].includes(key)) void applyFonts(true);
  applyEditorPrefs();
  scheduleSync();
}

$('#pref-autosave').addEventListener('change', function () {
  savePref('autoSave', this.checked);
});
$('#pref-hidepreview').addEventListener('change', function () {
  savePref('hidePreview', this.checked);
});
$('#pref-hideheader').addEventListener('change', function () {
  savePref('hideHeaderOnFullscreen', this.checked);
});
$('#pref-hidetoolbar').addEventListener('change', function () {
  savePref('hideToolbar', this.checked);
});
$('#pref-collapse').addEventListener('change', function () {
  savePref('collapseDetails', this.checked);
});
$('#pref-hidecursor').addEventListener('change', function () {
  savePref('hideCursorHighlight', this.checked);
});
$('#pref-theme').addEventListener('change', function () { void savePref('theme', this.value); });
$('#pref-accent').addEventListener('change', function () { void savePref('accentColor', this.value); });
$('#pref-font').addEventListener('change', function () { void savePref('fontFamily', this.value); });
$('#pref-editor-font').addEventListener('change', function () { void savePref('editorFontFamily', this.value); });
$('#pref-preview-font').addEventListener('change', function () { void savePref('previewFontFamily', this.value); });

$$('.prefs-nav').forEach(button => button.addEventListener('click', () => {
  const section = button.dataset.prefSection;
  $$('.prefs-nav').forEach(item => {
    const active = item === button;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', active ? 'true' : 'false');
    item.tabIndex = active ? 0 : -1;
  });
  $$('.prefs-section').forEach(panel => {
    const active = panel.dataset.prefPanel === section;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
  $('#prefs-title').textContent = button.textContent;
}));

$$('.prefs-nav').forEach(button => button.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...$$('.prefs-nav')];
  const current = tabs.indexOf(button);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next].focus();
  tabs[next].click();
}));

async function checkFontAvailability(force = false) {
  if (!force && (fontAvailability === 'available' || fontAvailability === 'unavailable')) return fontAvailability;
  if (fontAvailabilityPromise) return fontAvailabilityPromise;
  fontAvailability = 'checking';
  $('#font-availability').textContent = 'Checking Google Fonts...';
  renderFontOptions();

  fontAvailabilityPromise = (async () => {
    const probe = document.createElement('link');
    probe.rel = 'stylesheet';
    probe.href = fontCSSURL('Inter');
    const stylesheetLoaded = await new Promise(resolve => {
      const timeout = setTimeout(() => resolve(false), 5000);
      probe.addEventListener('load', () => { clearTimeout(timeout); resolve(true); }, {once:true});
      probe.addEventListener('error', () => { clearTimeout(timeout); resolve(false); }, {once:true});
      document.head.append(probe);
    });
    probe.remove();
    let faceLoaded = false;
    if (stylesheetLoaded) {
      try {
        const loadedFaces = await document.fonts.load('1rem "Inter"');
        faceLoaded = Boolean(loadedFaces && loadedFaces.length);
      } catch (_) {}
    }
    fontAvailability = stylesheetLoaded && faceLoaded ? 'available' : 'unavailable';
    $('#font-availability').textContent = fontAvailability === 'available' ? 'Google Fonts available' : 'Google Fonts unavailable; using system font';
    renderFontOptions();
    if (fontAvailability === 'available') void applyFonts();
    return fontAvailability;
  })().finally(() => { fontAvailabilityPromise = null; });
  return fontAvailabilityPromise;
}

function hasSelectedWebFont() {
  return FONT_SLOTS.some(slot => prefs[slot.preference] && !isSystemFont(prefs[slot.preference]));
}

async function loadPrefs() {
  const p = await api('/api/prefs');
  if (p && !await hasPendingOperation('__prefs__')) {
    let cached = {};
    try { cached = JSON.parse(localStorage.getItem('mdnotes-prefs') || '{}'); } catch (_) {}
    prefs = normalizePrefs(p, cached);
    localStorage.setItem('mdnotes-prefs', JSON.stringify(prefs));
    applyPrefs();
    if (hasSelectedWebFont()) void checkFontAvailability();
    return;
  }
  try {
    const cached = localStorage.getItem('mdnotes-prefs');
    if (cached) prefs = normalizePrefs(JSON.parse(cached));
  } catch (_) {}
  applyPrefs();
  if (hasSelectedWebFont()) void checkFontAvailability();
}

// --- Init ---
async function init() {
  let localStartupReady = false;
  try {
    await restoreCachedStartup();
    localStartupReady = true;
    $('#app').classList.remove('booting');

    const res = await api('/api/check');
    if (res) {
      cacheAppVersion(res);
      void loadPrefs();
      await restoreRoute({fetchRemote: true});
      connectServerEvents();
      scheduleSync({reconcile: true});
    } else if (authenticationRequired) {
      // api() has already displayed the sign-in screen. A cached offline copy
      // must never override that when the server explicitly returned 401.
    } else {
      cacheAppVersion();
      setSyncStatus('offline');
      showOfflineNotice();
    }
  } catch (error) {
    console.error('initialization failed', error);
    if (localStartupReady) {
      markServerOffline();
    } else {
      show(screens.login);
      $('#login-error').textContent = 'Could not start the app. Please reload.';
      $('#login-form input').focus();
    }
  } finally {
    $('#app').classList.remove('booting');
  }
}

init();

$$('.offline-retry').forEach(retry => retry.addEventListener('click', async () => {
  showOfflineNotice(true);
  const ok = await syncNow({preserveSnackbar: true});
  if (ok) showSyncCompleteToast();
}));

// Service worker
function registerServiceWorker(revision = appRevisionAtLoad) {
  if (!('serviceWorker' in navigator)) return;
  const requestedRevision = /^[A-Za-z0-9._-]{1,128}$/.test(revision || '') ? revision : 'legacy';
  if (registeredServiceWorkerRevision === requestedRevision) return;
  registeredServiceWorkerRevision = requestedRevision;
  navigator.serviceWorker.register(`/sw.js?revision=${encodeURIComponent(requestedRevision)}`, {updateViaCache: 'none'}).catch(error => {
    registeredServiceWorkerRevision = null;
    console.warn('service worker registration failed', error);
  });
}
registerServiceWorker();

window.addEventListener('popstate', () => { void restoreRoute(); });

window.addEventListener('online', async () => {
  connectServerEvents();
  if (hasSelectedWebFont()) {
    fontAvailability = 'checking';
    void checkFontAvailability();
  }
  scheduleSync({reconcile: true});
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (isDirty) saveCurrentNote(false);
    cancelActiveSyncRequests();
  }
  if (document.visibilityState === 'visible') {
    connectServerEvents();
    scheduleSync();
  }
});

setInterval(async () => {
  if (document.visibilityState !== 'visible' || syncInFlight) return;
  try {
    const pending = (await pendingOperations()).length > 0;
    const sseHealthy = isServerEventsHealthy();
    const fallbackAge = sseHealthy ? healthySseFallbackSyncAgeMs : unhealthySseFallbackSyncAgeMs;
    const stale = !lastSuccessfulSyncAt || Date.now() - lastSuccessfulSyncAt >= fallbackAge;
    if (pending || stale) scheduleSync({reconcile: !sseHealthy});
  } catch (error) {
    console.warn('periodic sync check failed', error);
  }
}, 30000);

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveCurrentNote();
  }
});

})();
