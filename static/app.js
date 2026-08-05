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
let prefs = { autoSave: true, hidePreview: false, hideHeaderOnFullscreen: false, hideToolbar: false, collapseDetails: false, hideCursorHighlight: false };
let renderedPreviewSource = null;
let previewCheckFrame = null;
let highlightFrame = null;
let currentRevision = 0;
let currentBaseRevision = null;
let syncInFlight = false;
let syncingQueueOperationID = null;
let lastSyncProblem = '';
let authenticationRequired = false;
let panelRatio = Math.min(.8, Math.max(.2, Number(localStorage.getItem('mdnotes-panel-ratio')) || .5));
let panelWide = false;
let appVersionAtLoad = localStorage.getItem('mdnotes-version') || null;
let appRevisionAtLoad = localStorage.getItem('mdnotes-revision') || null;
let updateToast = null;

// Notes are stored locally before any network request. The service worker keeps
// the app shell available, while IndexedDB holds the user's working set and a
// durable queue of mutations to replay after connectivity returns.
const offlineDBName = 'mdnotes-offline';
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
    const request = indexedDB.open(offlineDBName);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', {keyPath: 'id'});
      if (!db.objectStoreNames.contains('queue')) {
        const queue = db.createObjectStore('queue', {keyPath: 'id', autoIncrement: true});
        queue.createIndex('note_id', 'note_id', {unique: false});
      }
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state', {keyPath: 'key'});
    };
    request.onsuccess = async () => {
      try {
        await repairOfflineQueue(request.result);
        resolve(request.result);
      } catch (error) {
        request.result.close();
        offlineDBPromise = undefined;
        reject(error);
      }
    };
    request.onerror = () => reject(request.error);
  });
  return offlineDBPromise;
}

// A previous development build could leave an operation without the replay
// metadata introduced in version 2. Repair it in place: the note snapshot is
// kept, and the operation can be acknowledged normally instead of making a
// healthy server look offline forever.
async function repairOfflineQueue(db) {
  if (!db.objectStoreNames.contains('queue') || !db.objectStoreNames.contains('state')) {
    throw new Error('offline database is missing required stores');
  }
  const transaction = db.transaction(['queue', 'state'], 'readwrite');
  const queue = transaction.objectStore('queue');
  const state = transaction.objectStore('state');
  const complete = transactionComplete(transaction);
  const records = await requestValue(queue.getAll());
  let largestSequence = 0;
  records.sort((left, right) => left.id - right.id);
  for (const operation of records) {
    if (Number.isSafeInteger(operation.client_sequence) && operation.client_sequence > largestSequence) {
      largestSequence = operation.client_sequence;
    }
  }
  for (const operation of records) {
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
  }
  const savedSequence = await requestValue(state.get('clientSequence'));
  const previousSequence = Number(savedSequence?.value || 0);
  state.put({key: 'clientSequence', value: Math.max(previousSequence, largestSequence)});
  await complete;
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
  const db = await openOfflineDB();
  const tx = db.transaction(names, mode);
  const stores = Object.fromEntries(names.map(name => [name, tx.objectStore(name)]));
  const complete = transactionComplete(tx);
  const result = await work(stores);
  await complete;
  return result;
}

function getLocalNote(id) {
  return withOfflineStore(['notes'], 'readonly', stores => requestValue(stores.notes.get(id)));
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

function getUnresolvedConflict(noteID) {
  return getOfflineState(unresolvedConflictKey(noteID));
}

function setUnresolvedConflict(conflict) {
  return setOfflineState(unresolvedConflictKey(conflict.note_id), conflict);
}

async function queueOperationInStores(stores, operation) {
  if (operation.type === 'note.save' || operation.type === 'prefs.save') {
    const queued = await requestValue(stores.queue.index('note_id').getAll(operation.note_id));
    const existing = queued
      .filter(item => item.id !== syncingQueueOperationID && item.type === operation.type)
      .sort((left, right) => right.client_sequence - left.client_sequence)[0];
    if (existing) {
      existing.base_revision = operation.base_revision;
      existing.note = operation.note;
      existing.prefs = operation.prefs;
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
  return withOfflineStore(['queue', 'state'], 'readwrite', stores => queueOperationInStores(stores, operation));
}

function saveLocalNoteAndQueue(note, operation) {
  return withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    await requestValue(stores.notes.put(note));
    await queueOperationInStores(stores, operation);
  });
}

function removeLocalNoteAndQueue(id, operation) {
  return withOfflineStore(['notes', 'queue', 'state'], 'readwrite', async stores => {
    await requestValue(stores.notes.delete(id));
    await queueOperationInStores(stores, operation);
  });
}

function removeLocalNoteAndSupersede(id, afterSequence) {
  return withOfflineStore(['notes', 'queue'], 'readwrite', async stores => {
    await requestValue(stores.notes.delete(id));
    const operations = await requestValue(stores.queue.index('note_id').getAll(id));
    operations.forEach(operation => {
      if (operation.client_sequence > afterSequence) {
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
      if (operation.client_sequence !== sequence) {
        operation.client_sequence = sequence;
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
  return withOfflineStore(['queue'], 'readonly', async stores => {
    const item = await requestValue(stores.queue.index('note_id').get(noteID));
    return Boolean(item);
  });
}

function removePendingOperation(id) {
  return withOfflineStore(['queue'], 'readwrite', stores => requestValue(stores.queue.delete(id)));
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
      if (operation.id === acknowledgedID || operation.client_sequence < 1) return;
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
      if (operation.client_sequence > afterSequence) {
        operation.type = 'noop';
        stores.queue.put(operation);
      }
    });
  });
}

async function clearOfflineData() {
  const db = await openOfflineDB();
  db.close();
  offlineDBPromise = undefined;
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(offlineDBName);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = resolve;
  });
}

function newLocalNoteID() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
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

function showOfflineNotice(checking = false) {
  $$('.offline-notice').forEach(notice => {
    notice.classList.remove('hidden');
    notice.querySelector('.offline-notice-message').textContent = checking ? 'Checking…' : "You're offline. Your changes are saved on this device.";
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
  }
  const version = response?.version || localStorage.getItem('mdnotes-version') || 'dev';
  $('#app-version').textContent = `v${version}`;
}

function show(screen) {
  Object.values(screens).forEach(el => el.classList.add('hidden'));
  screen.classList.remove('hidden');
}

function clearCurrentNote() {
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

async function api(path, opts) {
  try {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: opts?.body ? {'Content-Type':'application/json'} : {},
      ...opts,
    });
    if (res.status === 401) {
      requireAuthentication();
      return null;
    }
    if (res.status === 204) return true;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || res.statusText);
    }
    return await res.json();
  } catch(e) {
    console.error(e);
    return null;
  }
}

async function syncFetch(path, options) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options?.body ? {'Content-Type': 'application/json'} : {},
    ...options,
  });
  const body = response.status === 204 ? null : await response.text();
  let data = null;
  if (body) {
    try { data = JSON.parse(body); } catch (_) { data = body; }
  }
  return {response, data};
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

async function pullRemoteChanges() {
  let since = Number(await getOfflineState('syncSequence') || 0);
  for (;;) {
    const page = await api(`/api/sync?since=${since}&limit=100`);
    if (!page) throw new Error('could not fetch sync changes');
    if (page.resetRequired) {
      await resetLocalNotesFromRemote(Number(page.nextSequence || 0));
      return;
    }
    for (const change of page.changes) {
      if (await hasPendingOperation(change.note_id) || await getUnresolvedConflict(change.note_id)) continue;
      if (change.deleted) {
        await removeLocalNote(change.note_id);
        if (currentNoteId === change.note_id && !isDirty) {
          currentNoteId = null;
          await loadDashboard({sync: false});
          setDashboardRoute({replace: true});
        }
        continue;
      }
      const remote = await api(`/api/notes/${encodeURIComponent(change.note_id)}`);
      if (!remote) throw new Error('could not download changed note');
      await cacheRemoteNote(remote);
    }
    since = Number(page.nextSequence || since);
    await setOfflineState('syncSequence', since);
    if (!page.hasMore) return;
  }
}

async function resetLocalNotesFromRemote(sequence) {
  const summaries = await api('/api/notes');
  if (!Array.isArray(summaries)) throw new Error('could not refresh notes after sync compaction');
  const remoteIDs = new Set(summaries.map(note => note.id));
  for (const summary of summaries) {
    if (await hasPendingOperation(summary.id) || await getUnresolvedConflict(summary.id)) continue;
    const remote = await api(`/api/notes/${encodeURIComponent(summary.id)}`);
    if (!remote) throw new Error('could not download refreshed note');
    await cacheRemoteNote(remote);
  }
  for (const local of await getAllLocalNotes()) {
    if (!remoteIDs.has(local.id) && !await hasPendingOperation(local.id)) {
      await removeLocalNote(local.id);
    }
  }
  await setOfflineState('syncSequence', sequence);
}

// A sync cursor records that this browser has observed the change feed, but a
// browser can still lose individual IndexedDB records (for example after a
// storage repair). Reconcile against note summaries at session start so a
// valid-but-stale cursor cannot leave the dashboard incomplete forever.
async function reconcileLocalNotes() {
  const summaries = await api('/api/notes');
  if (!Array.isArray(summaries)) throw new Error('could not reconcile local notes');
  const remoteIDs = new Set(summaries.map(note => note.id));
  for (const summary of summaries) {
    if (await hasPendingOperation(summary.id) || await getUnresolvedConflict(summary.id)) continue;
    const local = await getLocalNote(summary.id);
    if (local && local.revision === summary.revision) continue;
    const remote = await api(`/api/notes/${encodeURIComponent(summary.id)}`);
    if (!remote) throw new Error('could not download reconciled note');
    await cacheRemoteNote(remote);
  }
  for (const local of await getAllLocalNotes()) {
    if (!remoteIDs.has(local.id) && !await hasPendingOperation(local.id) && !await getUnresolvedConflict(local.id)) {
      await removeLocalNote(local.id);
    }
  }
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

async function mergeConflictedNote(operation) {
  if (operation.type !== 'note.save' || !operation.note || !window.MDNotesMerge) return false;
  // A network response can arrive while the user is still typing. Capture that
  // newer local state before deriving the merge, rather than merging an older
  // queued snapshot and accidentally omitting the last keystrokes.
  if (currentNoteId === operation.note_id && isDirty) await saveCurrentNote(false);
  const local = await getLocalNote(operation.note_id);
  const remote = await api(`/api/notes/${encodeURIComponent(operation.note_id)}`);
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
  await removePendingOperation(operation.id);
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
  await removePendingOperation(operation.id);
}

function conflictBase(local, operation) {
  return {
    title: local.base_title ?? operation.note?.base_title ?? operation.note?.title ?? '',
    tags: local.base_tags ?? operation.note?.base_tags ?? operation.note?.tags ?? '',
    content: local.base_content ?? operation.note?.base_content ?? '',
  };
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

function closeConflictResolver() {
  activeConflictID = null;
  activeConflictSelection = 'local';
  $('#conflict-modal').classList.add('hidden');
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
  activeConflictID = conflict.note_id;
  $('#conflict-note-title').value = conflict.local.title || '';
  $('#conflict-note-tags').value = conflict.local.tags || '';
  $('#conflict-note-content').value = conflict.local.content || '';
  $('#conflict-local-metadata').textContent = `Title: ${conflict.local.title || 'Untitled'}\nTags: ${conflict.local.tags || 'None'}`;
  $('#conflict-remote-metadata').textContent = `Title: ${conflict.remote.title || 'Untitled'}\nTags: ${conflict.remote.tags || 'None'}`;
  renderConflictDiff($('#conflict-local-diff'), conflict.base.content, conflict.local.content, 'conflict-line-local');
  renderConflictDiff($('#conflict-remote-diff'), conflict.base.content, conflict.remote.content, 'conflict-line-remote');
  $('#conflict-base-content').textContent = conflict.base.content || '(empty note)';
  setConflictSelection('local');
  $('#conflict-modal').classList.remove('hidden');
  $('#conflict-note-content').focus();
}

async function showConflictResolverFor(noteID) {
  const conflict = await getUnresolvedConflict(noteID);
  if (!conflict) return false;
  showConflictResolver(conflict);
  return true;
}

function fillConflictResolution(version, selection) {
  $('#conflict-note-title').value = version.title || '';
  $('#conflict-note-tags').value = version.tags || '';
  $('#conflict-note-content').value = version.content || '';
  setConflictSelection(selection);
}

async function createConflictResolution(operation) {
  // Always capture fresh keystrokes before replacing the cached note. This is
  // especially important for notification-driven sync, which can arrive while
  // the 250ms local-save timer is still pending.
  if (currentNoteId === operation.note_id && isDirty) await saveCurrentNote(false);
  const local = await getLocalNote(operation.note_id);
  const remote = await api(`/api/notes/${encodeURIComponent(operation.note_id)}`);
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
  await removePendingOperation(operation.id);
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
  void syncNow();
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
  void syncNow();
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

$('#conflict-save').addEventListener('click', () => { void saveConflictResolution(); });
$('#conflict-copy').addEventListener('click', () => { void keepConflictAsCopy(); });
$('#conflict-later').addEventListener('click', closeConflictResolver);
$('#conflict-modal .modal-backdrop').addEventListener('click', closeConflictResolver);

async function acknowledgeCompactedOperation(operation) {
  await removePendingOperation(operation.id);
  if (operation.type !== 'note.save' && operation.type !== 'note.delete') return;
  const remote = await api(`/api/notes/${encodeURIComponent(operation.note_id)}`);
  if (!remote) {
    if (!await hasPendingOperation(operation.note_id)) await removeLocalNote(operation.note_id);
    return;
  }
  const hasLater = await rebaseQueuedNoteOperations(operation.note_id, -1, remote.revision, remote);
  const local = await getLocalNote(operation.note_id);
  if (!hasLater) {
    await cacheRemoteNote(remote);
    return;
  }
  if (local) {
    await putLocalNote({...local, revision: remote.revision, pending: true, base_revision: remote.revision, base_content: remote.content, base_title: remote.title, base_tags: remote.tags});
  }
}

async function flushPendingChanges() {
  for (;;) {
    const operations = await pendingOperations();
    if (!operations.length) return;
    const operation = operations[0];
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
    syncingQueueOperationID = operation.id;
    let result;
    try {
      result = await syncFetch('/api/sync/push', {
        method: 'POST',
        body: JSON.stringify({device_id: await syncDeviceID(), operations: [outgoing]}),
      });
    } finally {
      syncingQueueOperationID = null;
    }
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
      const error = new Error(typeof result.data === 'string' ? result.data : 'sync failed');
      error.responseStatus = result.response.status;
      throw error;
    }
    const acknowledgement = result.data?.acknowledged?.find(item => item.op_id === operation.op_id);
    if (!acknowledgement) throw new Error('sync acknowledgement missing');
    if (acknowledgement.status === 'compacted') {
      await acknowledgeCompactedOperation(operation);
      continue;
    }
    if (acknowledgement.status === 'conflict') {
      if (await mergeConflictedNote(operation)) {
        showToast('Merged your non-overlapping changes.', 'success');
      } else {
        const resolverReady = await createConflictResolution(operation);
        if (resolverReady) showToast('Conflicting edits need your review.', 'warning');
        else showToast('A conflict copy was created so your changes are safe.', 'warning');
      }
      continue;
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
    await removePendingOperation(operation.id);
  }
}

async function syncNow({preserveSnackbar = false, reconcile = false} = {}) {
  // Network requests and the authenticated SSE heartbeat are authoritative.
  // navigator.onLine is only an unreliable browser hint, particularly in an
  // installed mobile PWA, so it must never prevent a requested sync.
  if (syncInFlight) return false;
  syncInFlight = true;
  setSyncStatus('syncing');
  const wasOffline = syncFailed;
  try {
    // Save the visible editor locally before pulling. This never waits on the
    // network, but ensures a remote notification cannot overwrite the common
    // base needed to merge the user's newest keystrokes.
    if (!screens.editor.classList.contains('hidden') && isDirty) await saveCurrentNote(false);
    await pullRemoteChanges();
    if (reconcile) await reconcileLocalNotes();
    await flushPendingChanges();
    await pullRemoteChanges();
    localStorage.setItem('mdnotes-offline-ready', '1');
    syncFailed = false;
    setSyncStatus('online');
    if (!preserveSnackbar) hideOfflineNotice();
    if (wasOffline && !preserveSnackbar) showToast('Back online. Changes synced.');
    return true;
  } catch (error) {
    console.warn('sync failed', error);
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
    if (error?.responseStatus >= 400 && error.responseStatus < 500) {
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

const sseStaleAfterMs = 70000;
let serverEvents = null;
let serverHeartbeatAt = 0;
let serverEventsWatchdog = null;
let serverChangeTimer = null;
let serverChangePending = false;

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
  const synced = await syncNow({reconcile: true});
  if (synced && !screens.dashboard.classList.contains('hidden')) {
    await refreshDashboard();
  }
}

function scheduleServerChangeSync() {
  serverChangePending = true;
  if (serverChangeTimer) return;
  serverChangeTimer = setTimeout(async () => {
    serverChangeTimer = null;
    if (syncInFlight) {
      scheduleServerChangeSync();
      return;
    }
    serverChangePending = false;
    const synced = await syncNow();
    if (synced && !screens.dashboard.classList.contains('hidden')) await refreshDashboard();
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
  events.addEventListener('change', () => {
    serverHeartbeatAt = Date.now();
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
  const pw = e.target.password.value;
  const res = await api('/api/login', {method:'POST', body:JSON.stringify({password:pw})});
  if (res) {
    $('#login-error').textContent = '';
    cacheAppVersion(res);
    await loadPrefs();
    await syncNow({reconcile: true});
    connectServerEvents();
    await restoreRoute();
  } else {
    $('#login-error').textContent = 'Wrong password';
  }
});

$('#logout-btn').addEventListener('click', async () => {
  disconnectServerEvents();
  await api('/api/logout', {method:'POST'});
  await clearOfflineData();
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
  const synced = await syncNow();
  if (synced && !screens.dashboard.classList.contains('hidden')) await refreshDashboard();
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
  setSyncStatus(syncFailed ? 'offline' : 'online');
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
  await loadDashboard();
  setDashboardRoute();
});

function showNoteInEditor(data) {
  setPanelState(prefs.hidePreview ? 'editor' : 'both');
  currentNoteId = data.id;
  currentRevision = data.revision || 0;
  currentBaseRevision = data.base_revision ?? null;
  isDirty = false;
  savedSnapshot = { title: data.title || '', tags: data.tags || '', content: data.content || '' };
  $('#note-title').value = data.title || '';
  $('#note-tags').value = data.tags || '';
  $('#note-content').value = data.content || '';
  setSyncStatus(syncFailed ? 'offline' : 'online');
  applyEditorPrefs();
  show(screens.editor);
  updatePreview();
}

async function openNote(id, {route = 'push'} = {}) {
  if (saveTimer) clearTimeout(saveTimer);
  if (previewTimer) clearTimeout(previewTimer);
  const data = await getLocalNote(id);
  if (!data) return;
  showNoteInEditor(data);
  if (route === 'push') setNoteRoute(id);
  await showConflictResolverFor(id);
  // The note is already usable from IndexedDB. Refreshing it is deliberately
  // background work so opening a note never waits on a round trip.
  void syncNow();
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
  void syncNow();
}

async function restoreRoute() {
  const noteID = noteIDFromLocation();
  if (!screens.editor.classList.contains('hidden') && isDirty) await saveCurrentNote(false);
  if (noteID && await getLocalNote(noteID)) {
    await openNote(noteID, {route: 'none'});
    return;
  }
  if (noteID) {
    setDashboardRoute({replace: true});
    showToast('That note is no longer available.', 'warning');
  }
  clearCurrentNote();
  await loadDashboard({sync: false});
}

// --- Autosave ---
function markDirty() {
  if (!isDirty) {
    isDirty = true;
  }
}

async function saveCurrentNote(trySync = true) {
  const title = $('#note-title').value.trim() || 'Untitled';
  const tags = $('#note-tags').value.trim();
  const content = $('#note-content').value;

  const data = {title, tags, content};
  if (currentNoteId) data.id = currentNoteId;

  if (currentNoteId && data.title === savedSnapshot.title && data.tags === savedSnapshot.tags && data.content === savedSnapshot.content) {
    isDirty = false;
    if (trySync) await syncNow();
    return;
  }
  if (!currentNoteId) currentNoteId = newLocalNoteID();
  const existing = await getLocalNote(currentNoteId);
  const baseRevision = existing?.pending ? existing.base_revision : (currentBaseRevision ?? currentRevision ?? 0);
  const baseContent = existing?.pending ? (existing.base_content ?? '') : (existing?.content || '');
  const baseTitle = existing?.pending ? (existing.base_title ?? existing.title ?? '') : (existing?.title || '');
  const baseTags = existing?.pending ? (existing.base_tags ?? existing.tags ?? '') : (existing?.tags || '');
  const now = new Date().toISOString();
  const local = {
    ...existing,
    ...data,
    id: currentNoteId,
    filename: existing?.filename || `${currentNoteId}.md`,
    revision: existing?.revision ?? currentRevision ?? 0,
    base_revision: baseRevision,
    base_content: baseContent,
    base_title: baseTitle,
    base_tags: baseTags,
    pending: true,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  try {
    await saveLocalNoteAndQueue(local, {type: 'note.save', note_id: currentNoteId, base_revision: baseRevision, note: local});
  } catch (error) {
    console.error('local save failed', error);
    showToast('Could not save locally. Free browser storage and try again.', 'warning');
    return false;
  }
  currentBaseRevision = baseRevision;
  savedSnapshot = { title: data.title, tags: data.tags, content: data.content };
  isDirty = false;
  if (noteIDFromLocation() !== currentNoteId) setNoteRoute(currentNoteId);
  setSyncStatus(syncFailed ? 'offline' : 'online');
  if (trySync) await syncNow();
}

let saveTimer = null;
let localSaveTimer = null;
let previewTimer = null;

function scheduleSave() {
  if (localSaveTimer) clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(() => {
    if (isDirty) saveCurrentNote(false);
  }, 250);
  if (!prefs.autoSave) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // The 250ms timer may already have durably saved this edit to IndexedDB
    // and cleared isDirty. Still call saveCurrentNote: its unchanged-note path
    // replays the queued operation, which is the intended 2s idle sync.
    if (!screens.editor.classList.contains('hidden')) void saveCurrentNote();
  }, 2000);
}

$('#save-btn').addEventListener('click', () => { if (saveTimer) clearTimeout(saveTimer); saveCurrentNote(); });
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
  const local = await getLocalNote(currentNoteId);
  if (!local) return;
  const pending = await hasPendingOperation(currentNoteId);
  if (pending && (local.base_revision || 0) === 0) {
    await removeLocalNoteAndSupersede(currentNoteId, 0);
  } else {
    await removeLocalNoteAndQueue(currentNoteId, {type: 'note.delete', note_id: currentNoteId, base_revision: local.base_revision ?? local.revision});
  }
  currentNoteId = null;
  currentRevision = 0;
  currentBaseRevision = null;
  if (currentTag) {
    const remainingNotes = await getLocalNotes();
    if (!remainingNotes.some(note => noteHasTag(note, currentTag))) currentTag = null;
  }
  setSyncStatus(syncFailed ? 'offline' : 'online');
  void syncNow();
  await loadDashboard();
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
    $('#preview').innerHTML = marked.parse(md, {breaks:true,gfm:true});
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

// --- Theme ---
function setTheme(dark) {
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  $$('.theme-btn use').forEach(el => el.setAttribute('href', dark ? '#icon-moon' : '#icon-sun'));
  localStorage.setItem('theme', dark ? 'dark' : 'light');
}

function toggleTheme() {
  setTheme(!document.documentElement.classList.contains('dark'));
}

// Apply saved or system theme
(function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) {
    setTheme(saved === 'dark');
  } else {
    setTheme(window.matchMedia('(prefers-color-scheme:dark)').matches);
  }
})();

// --- Preferences ---
$('#prefs-btn').addEventListener('click', () => {
  $('#pref-autosave').checked = prefs.autoSave;
  $('#pref-hidepreview').checked = prefs.hidePreview;
  $('#pref-hideheader').checked = prefs.hideHeaderOnFullscreen;
  $('#pref-hidetoolbar').checked = prefs.hideToolbar;
  $('#pref-collapse').checked = prefs.collapseDetails;
  $('#pref-hidecursor').checked = prefs.hideCursorHighlight;
  $('#pref-theme').checked = document.documentElement.classList.contains('dark');
  $('#prefs-modal').classList.remove('hidden');
});

$('#prefs-close').addEventListener('click', () => {
  $('#prefs-modal').classList.add('hidden');
});

$('#prefs-modal .modal-backdrop').addEventListener('click', () => {
  $('#prefs-modal').classList.add('hidden');
});

async function savePref(key, value) {
  prefs[key] = value;
  localStorage.setItem('mdnotes-prefs', JSON.stringify(prefs));
  await queueOperation({type: 'prefs.save', note_id: '__prefs__', prefs: {...prefs}});
  applyEditorPrefs();
  void syncNow();
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
$('#pref-theme').addEventListener('change', function () {
  setTheme(this.checked);
  localStorage.setItem('theme', this.checked ? 'dark' : 'light');
});

async function loadPrefs() {
  const p = await api('/api/prefs');
  if (p && !await hasPendingOperation('__prefs__')) {
    prefs = p;
    localStorage.setItem('mdnotes-prefs', JSON.stringify(prefs));
    return;
  }
  try {
    const cached = localStorage.getItem('mdnotes-prefs');
    if (cached) prefs = {...prefs, ...JSON.parse(cached)};
  } catch (_) {}
}

// --- Init ---
async function init() {
  try {
    const res = await api('/api/check');
    if (res) {
      cacheAppVersion(res);
      await loadPrefs();
      await syncNow({reconcile: true});
      connectServerEvents();
      await restoreRoute();
    } else if (authenticationRequired) {
      // api() has already displayed the sign-in screen. A cached offline copy
      // must never override that when the server explicitly returned 401.
    } else if (localStorage.getItem('mdnotes-offline-ready') === '1') {
      cacheAppVersion();
      await loadPrefs();
      setSyncStatus('offline');
      showOfflineNotice();
      await restoreRoute();
    } else {
      show(screens.login);
      $('#login-form input').focus();
    }
  } catch (error) {
    console.error('initialization failed', error);
    show(screens.login);
    $('#login-error').textContent = 'Could not start the app. Please reload.';
    $('#login-form input').focus();
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
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(error => console.warn('service worker registration failed', error));
}

window.addEventListener('popstate', () => { void restoreRoute(); });

window.addEventListener('online', async () => {
  connectServerEvents();
  if (await syncNow({reconcile: true}) && !screens.dashboard.classList.contains('hidden')) {
    await refreshDashboard();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && isDirty) saveCurrentNote(false);
  if (document.visibilityState === 'visible') {
    connectServerEvents();
    syncNow();
  }
});

setInterval(() => {
  if (document.visibilityState === 'visible') syncNow();
}, 30000);

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveCurrentNote();
  }
});

})();
