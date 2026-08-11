import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {
  createApp,
  deleteOfflineDatabase,
  response,
} from './app-harness.js';

let apps = [];

beforeEach(async () => {
  apps = [];
  await deleteOfflineDatabase();
});

afterEach(async () => {
  for (const app of apps.reverse()) await app.close();
  await deleteOfflineDatabase();
});

function track(app) {
  apps.push(app);
  return app;
}

describe('F-01 editor save coordination', () => {
  test('drains an edit made while the previous local save is in flight', async () => {
    const app = track(await createApp({deferredSave: true}));
    app.hooks.setEditorState({
      id: 'note-a',
      dirty: true,
      title: 'Note',
      content: 'first version',
      savedSnapshot: {title: '', tags: '', content: ''},
    });

    const firstSave = app.hooks.saveCurrentNote(false);
    await app.firstSaveStarted;

    app.window.document.querySelector('#note-content').value = 'newest version';
    app.hooks.markDirty();
    const secondSave = app.hooks.saveCurrentNote(false);
    expect(secondSave).toBe(firstSave);

    app.releaseFirstSave();
    await firstSave;

    expect(app.saveCalls).toHaveLength(2);
    expect(app.saveCalls[0].note.content).toBe('first version');
    expect(app.saveCalls[1].note.content).toBe('newest version');
    expect(app.hooks.getState()).toMatchObject({
      currentNoteId: 'note-a',
      isDirty: false,
      savedSnapshot: {content: 'newest version'},
    });
  });

  test('does not let an old save completion mutate a newly opened note', async () => {
    const app = track(await createApp({deferredSave: true}));
    app.hooks.setEditorState({
      id: 'note-a',
      dirty: true,
      title: 'Old note',
      content: 'old content',
      savedSnapshot: {title: '', tags: '', content: ''},
    });

    const save = app.hooks.saveCurrentNote(false);
    await app.firstSaveStarted;
    app.hooks.showNoteInEditor({id: 'note-b', revision: 4, title: 'New note', tags: '', content: 'new content'});
    app.releaseFirstSave();
    await save;

    expect(app.saveCalls).toHaveLength(1);
    expect(app.hooks.getState()).toMatchObject({
      currentNoteId: 'note-b',
      currentRevision: 4,
      isDirty: false,
      savedSnapshot: {title: 'New note', content: 'new content'},
    });
  });
});

describe('F-02 immutable queue operations', () => {
  test('appends a new identity after an operation has been attempted', async () => {
    const app = track(await createApp());
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', title: 'Note', tags: '', content: 'first'},
    });
    const first = (await app.hooks.pendingOperations())[0];
    const attempted = await app.hooks.claimQueueOperation(first.id);

    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', title: 'Note', tags: '', content: 'second'},
    });

    const pending = await app.hooks.pendingOperations();
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({id: first.id, op_id: first.op_id, attempted_at: expect.any(String)});
    expect(pending[0].note.content).toBe('first');
    expect(pending[1].note.content).toBe('second');
    expect(pending[1].op_id).not.toBe(first.op_id);

    expect(await app.hooks.removePendingOperationIfIdentityMatches(attempted.id, attempted)).toBe(true);
    expect((await app.hooks.pendingOperations()).map(operation => operation.note.content)).toEqual(['second']);
  });

  test('allows only one tab to hold the fallback sync lease', async () => {
    const firstTab = track(await createApp());
    const secondTab = track(await createApp());
    let release;
    let resolveStarted;
    const started = new Promise(resolve => { resolveStarted = resolve; });
    const gate = new Promise(resolve => { release = resolve; });

    const leaderRun = firstTab.hooks.withSyncLeadership(async () => {
      resolveStarted();
      await gate;
      return 'leader';
    });
    await started;
    expect(await secondTab.hooks.withSyncLeadership(() => 'unexpected follower')).toBe(false);
    secondTab.hooks.cancelScheduledSync();
    release();
    expect(await leaderRun).toBe('leader');
  });
});

describe('F-03 compacted acknowledgement recovery', () => {
  async function queueAttemptedNote(app) {
    const note = {
      id: 'note-a',
      filename: 'note-a.md',
      title: 'Local',
      tags: '',
      content: 'local content',
      revision: 2,
      base_revision: 2,
      base_content: 'remote base',
      base_title: 'Local',
      base_tags: '',
      pending: true,
    };
    await app.hooks.saveLocalNoteAndQueue(note, {
      type: 'note.save',
      note_id: note.id,
      base_revision: note.base_revision,
      note,
    });
    const queued = (await app.hooks.pendingOperations())[0];
    return app.hooks.claimQueueOperation(queued.id);
  }

  test('keeps the queue and local note when reconciliation times out', async () => {
    const app = track(await createApp({fetchImpl: async () => response(503, 'temporary failure')}));
    app.window.console.error = () => {};
    const operation = await queueAttemptedNote(app);

    await expect(app.hooks.acknowledgeCompactedOperation(operation)).rejects.toMatchObject({responseStatus: 503});
    expect(await app.hooks.pendingOperations()).toHaveLength(1);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pending: true, content: 'local content'});
  });

  test('removes local state only after an authoritative 404', async () => {
    const app = track(await createApp({fetchImpl: async () => response(404)}));
    app.window.console.error = () => {};
    const operation = await queueAttemptedNote(app);

    await app.hooks.acknowledgeCompactedOperation(operation);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getLocalNote('note-a')).toBeUndefined();
  });

  test('applies the authoritative remote note and clears pending state', async () => {
    const remote = {id: 'note-a', filename: 'note-a.md', title: 'Remote', tags: 'work', content: 'remote content', revision: 9};
    const app = track(await createApp({fetchImpl: async () => response(200, JSON.stringify(remote))}));
    const operation = await queueAttemptedNote(app);

    await app.hooks.acknowledgeCompactedOperation(operation);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({...remote, pending: false, base_revision: null});
  });
});

describe('F-04 service worker revisions', () => {
  test('registers the worker with the server-provided frontend revision', async () => {
    const register = vi.fn(async () => {});
    const app = track(await createApp({serviceWorker: {register}}));
    register.mockClear();

    app.hooks.registerServiceWorker('frontend-hash-123');
    await Promise.resolve();

    expect(register).toHaveBeenCalledWith('/sw.js?revision=frontend-hash-123', {updateViaCache: 'none'});
  });
});

describe('startup responsiveness', () => {
  test('shows a cached note before a slow server check completes', async () => {
    let markCheckStarted;
    let releaseCheck;
    const checkStarted = new Promise(resolve => { markCheckStarted = resolve; });
    const checkGate = new Promise(resolve => { releaseCheck = resolve; });
    const app = track(await createApp({
      fetchImpl: async path => {
        if (String(path) === '/api/check') {
          markCheckStarted();
          await checkGate;
          return response(503, 'offline');
        }
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    app.window.console.error = () => {};
    await app.hooks.putLocalNote({
      id: 'note-a',
      filename: 'note-a.md',
      title: 'Cached note',
      tags: '',
      content: 'Available immediately',
      revision: 1,
      pending: false,
    });
    app.window.history.replaceState({}, '', '/note-a');

    const startup = app.hooks.init();
    await checkStarted;

    expect(app.window.document.querySelector('#app').classList.contains('booting')).toBe(false);
    expect(app.window.document.querySelector('#editor').classList.contains('hidden')).toBe(false);
    expect(app.window.document.querySelector('#note-title').value).toBe('Cached note');

    releaseCheck();
    await startup;
  });
});

describe('remote deletion coordination', () => {
  test('preserves a note while a local operation is pending', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Local edit', content: 'Keep me', pending: true});
    await app.hooks.queueOperation({type: 'note.save', note_id: 'note-a', base_revision: 1, note: {id: 'note-a', content: 'Keep me'}});

    expect(await app.hooks.applyRemoteDeletion('note-a')).toBe(false);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({title: 'Local edit', content: 'Keep me'});
  });
});

describe('permanent queue rejection recovery', () => {
  test('quarantines a rejected head operation and replays its sequence as a noop', async () => {
    let pushCount = 0;
    const app = track(await createApp({
      fetchImpl: async (path, options) => {
        if (String(path) !== '/api/sync/push') throw new Error(`unexpected request: ${path}`);
        const request = JSON.parse(options.body);
        const operation = request.operations[0];
        pushCount++;
        if (pushCount === 1) {
          return response(400, JSON.stringify({
            error: 'invalid note save operation',
            code: 'invalid_sync_operation',
            permanent: true,
            op_id: operation.op_id,
          }));
        }
        if (pushCount === 2) {
          expect(request.operations).toHaveLength(1);
          expect(operation.type).toBe('note.save');
          return response(400, JSON.stringify({error: 'invalid note save operation', permanent: true, op_id: operation.op_id}));
        }
        if (pushCount === 3) expect(operation.type).toBe('noop');
        else expect(operation.type).toBe('note.save');
        return response(200, JSON.stringify({
          acknowledged: [{client_sequence: operation.client_sequence, op_id: operation.op_id, status: 'applied', revision: pushCount === 3 ? undefined : 1}],
          expected_sequence: operation.client_sequence + 1,
        }));
      },
    }));
    await app.hooks.putLocalNote({id: 'note-a', title: 'Too large', content: 'Keep locally', pending: true});
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', title: 'Too large', content: 'Keep locally'},
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-b',
      base_revision: 0,
      note: {id: 'note-b', title: 'Later note', content: 'Continue syncing'},
    });

    expect(await app.hooks.flushPendingChanges()).toBe(true);
    expect(pushCount).toBe(4);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getOfflineState('rejectedSync:note-a')).toMatchObject({type: 'note.save'});
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pending: true, content: 'Keep locally'});
  });
});

describe('batched queue flushing', () => {
  test('sends ordered pending operations in one bounded push', async () => {
    const requests = [];
    const app = track(await createApp({
      fetchImpl: async (path, options) => {
        if (String(path) !== '/api/sync/push') throw new Error(`unexpected request: ${path}`);
        const request = JSON.parse(options.body);
        requests.push(request);
        return response(200, JSON.stringify({
          acknowledged: request.operations.map((operation, index) => ({
            client_sequence: operation.client_sequence,
            op_id: operation.op_id,
            status: 'applied',
            revision: index + 1,
          })),
          expected_sequence: request.operations.at(-1).client_sequence + 1,
        }));
      },
    }));
    for (const [index, id] of ['note-a', 'note-b', 'note-c'].entries()) {
      await app.hooks.queueOperation({
        type: 'note.save',
        note_id: id,
        base_revision: 0,
        note: {id, title: `Note ${index}`, content: `Content ${index}`},
      });
    }

    await app.hooks.flushPendingChanges();
    expect(requests).toHaveLength(1);
    expect(requests[0].operations.map(operation => operation.note_id)).toEqual(['note-a', 'note-b', 'note-c']);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
  });
});

describe('logout storage cleanup', () => {
  test('waits for other database connections before reporting cleanup complete', async () => {
    const first = track(await createApp());
    const originalIndexedDB = first.window.indexedDB;
    let deleteRequest;
    Object.defineProperty(first.window, 'indexedDB', {
      configurable: true,
      value: {
        deleteDatabase: () => {
          deleteRequest = {};
          setTimeout(() => deleteRequest.onblocked?.(), 0);
          return deleteRequest;
        },
      },
    });

    let completed = false;
    const cleanup = first.hooks.clearOfflineData().then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(completed).toBe(false);

    deleteRequest.onsuccess();
    await cleanup;
    expect(completed).toBe(true);
    Object.defineProperty(first.window, 'indexedDB', {configurable: true, value: originalIndexedDB});
  });
});

describe('offline database migrations', () => {
  test('upgrades the legacy layout to the explicit schema and queue index', async () => {
    const app = track(await createApp());
    const legacy = await new Promise((resolve, reject) => {
      const request = app.window.indexedDB.open('mdnotes-offline', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('notes', {keyPath: 'id'});
        const queue = db.createObjectStore('queue', {keyPath: 'id', autoIncrement: true});
        queue.createIndex('note_id', 'note_id', {unique: false});
        db.createObjectStore('state', {keyPath: 'key'});
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    expect(legacy).toBeUndefined();

    expect(await app.hooks.getOfflineDatabaseInfo()).toMatchObject({
      version: 3,
      queueIndexes: expect.arrayContaining(['note_id', 'client_sequence']),
    });
  });
});
