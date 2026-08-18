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

describe('font availability', () => {
  test('requires both the stylesheet and a loaded font face', async () => {
    const app = track(await createApp());
    const head = app.window.document.head;
    const append = head.append.bind(head);
    const fontLoads = [];
    app.window.document.fonts.load = async descriptor => {
      fontLoads.push(descriptor);
      return [{}];
    };
    head.append = (...nodes) => {
      append(...nodes);
      nodes.filter(node => node.rel === 'stylesheet').forEach(node => {
        setTimeout(() => node.dispatchEvent(new app.window.Event('load')), 0);
      });
    };

    await expect(app.hooks.checkFontAvailability()).resolves.toBe('available');

    expect(fontLoads).toContain('1rem "Inter"');
    expect(app.window.document.querySelector('#font-availability').textContent).toBe('Google Fonts available');
    expect(app.window.document.querySelector('#pref-font option[value="Inter"]').disabled).toBe(false);
  });
});

describe('editor display preferences', () => {
  test('applies status display modes and save button visibility', async () => {
    const app = track(await createApp());
    const root = app.window.document.documentElement;
    const statusLabel = app.window.document.querySelector('#editor-status .sync-indicator-label');
    expect(app.window.document.querySelector('#pref-status')).not.toBeNull();
    expect(app.window.document.querySelector('#pref-hidesave')).not.toBeNull();

    await app.hooks.savePref('statusDisplay', 'compact');
    expect(root.dataset.statusDisplay).toBe('compact');
    expect(statusLabel).not.toBeNull();

    await app.hooks.savePref('hideSaveButton', true);
    expect(app.window.document.querySelector('#editor').classList.contains('hide-save-button')).toBe(true);

    await app.hooks.savePref('statusDisplay', 'off');
    expect(root.dataset.statusDisplay).toBe('off');
  });
});

describe('markdown preview policy', () => {
  test('highlights the rendered block containing the caret', async () => {
    const app = track(await createApp());
    app.window.marked = {
      lexer: () => [
        {raw: '# Heading\n\n'},
        {raw: '- first\n\n- second\n\n'},
        {raw: '```text\ninside\n\ncode\n```\n\n'},
        {raw: 'tail'},
      ],
      parse: () => '<h1>Heading</h1><ul><li>first</li><li>second</li></ul><pre><code>inside\n\ncode\n</code></pre><p>tail</p>',
    };
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: '# Heading\n\n- first\n\n- second\n\n```text\ninside\n\ncode\n```\n\ntail'});
    app.hooks.updatePreview();

    const textarea = app.window.document.querySelector('#note-content');
    const codeOffset = textarea.value.indexOf('code');
    textarea.selectionStart = textarea.selectionEnd = codeOffset;
    app.hooks.highlightBlock();

    const blocks = [...app.window.document.querySelector('#preview').children];
    expect(blocks[2].classList.contains('highlight')).toBe(true);
    expect(blocks[1].classList.contains('highlight')).toBe(false);
  });

  test('escapes raw HTML, rejects unsafe resource URLs, and lazy-loads images', async () => {
    const app = track(await createApp());
    app.window.marked = {
      Renderer: class {},
      parse: (markdown, options) => [
        '<p>before</p>',
        options.renderer.html({text: '<form action="/delete"><input name="title"></form>'}),
        '<a href="javascript:alert(1)">unsafe link</a>',
        '<img src="https://example.com/image.png" alt="remote">',
        '<img src="data:text/html,unsafe" alt="blocked">',
      ].join(''),
    };

    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: '# Note'});

    const preview = app.window.document.querySelector('#preview');
    expect(preview.querySelector('form')).toBeNull();
    expect(preview.textContent).toContain('<form action="/delete">');
    expect(preview.querySelector('a').getAttribute('href')).toBeNull();
    const remoteImage = preview.querySelector('img[src="https://example.com/image.png"]');
    expect(remoteImage).not.toBeNull();
    expect(remoteImage.getAttribute('loading')).toBe('lazy');
    expect(remoteImage.getAttribute('decoding')).toBe('async');
    expect(preview.querySelector('img[src^="data:"]')).toBeNull();
  });
});

describe('typed API outcomes', () => {
  test('preserves server status, stable code, and retry policy', async () => {
    const app = track(await createApp({fetchImpl: async () => response(409, JSON.stringify({error: 'note changed', code: 'note_revision_conflict'}))}));
    app.window.console.error = () => {};

    await expect(app.hooks.api('/api/notes/note-a')).rejects.toMatchObject({
      kind: 'http',
      responseStatus: 409,
      code: 'note_revision_conflict',
      retryable: false,
    });
  });

  test('classifies transport failures separately from HTTP errors', async () => {
    const app = track(await createApp({fetchImpl: async () => { throw new TypeError('network unavailable'); }}));
    app.window.console.error = () => {};

    await expect(app.hooks.api('/api/check')).rejects.toMatchObject({
      kind: 'network',
      responseStatus: 0,
      retryable: true,
    });
  });
});

describe('sync scheduling while hidden', () => {
  test('keeps pending sync work dormant until the tab becomes visible', async () => {
    const requests = [];
    const app = track(await createApp({
      fetchImpl: async url => {
        requests.push(url);
        const path = String(url);
        if (path.includes('/api/sync')) return response(200, {changes: [], nextSequence: 0, hasMore: false});
        if (path.endsWith('/api/notes')) return response(200, []);
        return response(200, {});
      },
    }));
    const setVisibility = value => Object.defineProperty(app.window.document, 'visibilityState', {value, configurable: true});

    setVisibility('hidden');
    app.hooks.scheduleSync({reconcile: true});
    await new Promise(resolve => setTimeout(resolve, 1100));

    expect(requests).toHaveLength(0);
    expect(app.hooks.getSyncScheduleState()).toEqual({scheduled: false, options: {reconcile: true}});

    setVisibility('visible');
    app.window.document.dispatchEvent(new app.window.Event('visibilitychange'));
    expect(app.hooks.getSyncScheduleState().scheduled).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(requests.some(url => String(url).includes('/api/sync'))).toBe(true);
  });
});

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

  test('drains the latest snapshot before exposing the new-note action', async () => {
    const app = track(await createApp({deferredSave: true}));
    app.hooks.showNoteInEditor({id: 'note-a', revision: 1, title: 'Old note', tags: '', content: 'saved version'});
    app.window.history.replaceState({}, '', '/note-a');
    app.hooks.setEditorState({
      id: 'note-a',
      dirty: true,
      title: 'Old note',
      content: 'first version',
      savedSnapshot: {title: '', tags: '', content: ''},
    });

    const firstSave = app.hooks.saveCurrentNote(false);
    await app.firstSaveStarted;
    app.window.document.querySelector('#note-content').value = 'newest version';
    app.hooks.markDirty();
    app.hooks.saveCurrentNote(false);

    app.window.document.querySelector('#back-btn').click();
    expect(app.window.document.querySelector('#new-note-btn').closest('#dashboard').classList.contains('hidden')).toBe(true);
    app.releaseFirstSave();
    await firstSave;
    await vi.waitFor(() => {
      expect(app.window.document.querySelector('#dashboard').classList.contains('hidden')).toBe(false);
      expect(app.window.location.pathname).toBe('/');
    });

    expect(app.saveCalls).toHaveLength(2);
    expect(app.saveCalls[1]).toMatchObject({
      note: {id: 'note-a', content: 'newest version'},
      operation: {note_id: 'note-a'},
    });

    app.window.document.querySelector('#new-note-btn').click();
    expect(app.hooks.getState().currentNoteId).not.toBe('note-a');
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

  test('does not fall through to the fallback lease when a Web Lock is held', async () => {
    const app = track(await createApp());
    Object.defineProperty(app.window.navigator, 'locks', {
      configurable: true,
      value: {request: vi.fn(async (_name, _options, callback) => callback(null))},
    });
    const work = vi.fn(() => 'unexpected leader');

    expect(await app.hooks.withSyncLeadership(work)).toBe(false);
    expect(work).not.toHaveBeenCalled();
    app.hooks.cancelScheduledSync();
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

describe('conflict deletion recovery', () => {
  async function createDeletedConflictApp() {
    let remoteReads = 0;
    const app = track(await createApp({
      fetchImpl: async (path, options) => {
        if (String(path) === '/api/sync/push') {
          const request = JSON.parse(options.body);
          const operation = request.operations[0];
          return response(200, JSON.stringify({
            acknowledged: [{client_sequence: operation.client_sequence, op_id: operation.op_id, status: 'conflict', current_revision: 2}],
            expected_sequence: operation.client_sequence + 1,
          }));
        }
        if (String(path) === '/api/notes/note-a') {
          remoteReads++;
          return response(404);
        }
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    app.window.console.error = () => {};
    await app.hooks.putLocalNote({id: 'note-a', title: 'Local edit', content: 'Keep this', pending: true});
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', title: 'Local edit', content: 'Keep this'},
    });
    return {app, getRemoteReads: () => remoteReads};
  }

  test('persists the decision and keeps local content when the remote note was deleted', async () => {
    const {app, getRemoteReads} = await createDeletedConflictApp();

    await expect(app.hooks.flushPendingChanges()).resolves.toBe(true);

    expect(getRemoteReads()).toBe(1);
    expect(await app.hooks.getOfflineState('unresolvedConflict:note-a')).toMatchObject({kind: 'remote-deleted', note_id: 'note-a'});
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pending: false, content: 'Keep this'});
    expect(app.window.document.querySelector('#conflict-title').textContent).toBe('Note deleted on another device');

    app.window.document.querySelector('#conflict-later').click();
    expect(await app.hooks.getOfflineState('unresolvedConflict:note-a')).toMatchObject({kind: 'remote-deleted'});

    app.hooks.setEditorState({id: 'note-a', dirty: true, title: 'Updated locally', content: 'Newer local content'});
    await app.hooks.saveCurrentNote(false);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getOfflineState('unresolvedConflict:note-a')).toMatchObject({
      local: {title: 'Updated locally', content: 'Newer local content'},
    });
  });

  test('keeps the local version as a new note when requested', async () => {
    const {app} = await createDeletedConflictApp();

    await app.hooks.flushPendingChanges();
    app.window.document.querySelector('#conflict-copy').click();
    let pending = [];
    for (let attempt = 0; attempt < 20 && !pending.length; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      pending = await app.hooks.pendingOperations();
    }
    app.hooks.cancelScheduledSync();

    expect(pending).toHaveLength(1);
    expect(pending[0].note_id).not.toBe('note-a');
    expect(pending[0].note).toMatchObject({title: 'Local edit (conflict copy)', content: 'Keep this'});
    expect(await app.hooks.getLocalNote('note-a')).toBeUndefined();
    expect(await app.hooks.getOfflineState('unresolvedConflict:note-a')).toBeUndefined();
  });

  test('discards the local version only when deletion is accepted', async () => {
    const {app} = await createDeletedConflictApp();

    await app.hooks.flushPendingChanges();
    app.window.document.querySelector('#conflict-save').click();
    let localNote;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      localNote = await app.hooks.getLocalNote('note-a');
      if (!localNote) break;
    }
    app.hooks.cancelScheduledSync();

    expect(localNote).toBeUndefined();
    expect(await app.hooks.getOfflineState('unresolvedConflict:note-a')).toBeUndefined();
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
  });

  test('keeps the original operation when the remote lookup fails transiently', async () => {
    let pushCount = 0;
    let remoteReads = 0;
    const app = track(await createApp({
      fetchImpl: async (path, options) => {
        if (String(path) === '/api/sync/push') {
          pushCount++;
          const request = JSON.parse(options.body);
          const operation = request.operations[0];
          return response(200, JSON.stringify({
            acknowledged: [{client_sequence: operation.client_sequence, op_id: operation.op_id, status: 'conflict', current_revision: 2}],
            expected_sequence: operation.client_sequence + 1,
          }));
        }
        if (String(path) === '/api/notes/note-a') {
          remoteReads++;
          return response(503, 'temporary failure');
        }
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    app.window.console.error = () => {};
    await app.hooks.putLocalNote({id: 'note-a', title: 'Local edit', content: 'Keep this', pending: true});
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: 1,
      note: {id: 'note-a', title: 'Local edit', content: 'Keep this'},
    });

    await expect(app.hooks.flushPendingChanges()).rejects.toMatchObject({responseStatus: 503});

    expect(pushCount).toBe(1);
    expect(remoteReads).toBe(1);
    expect(await app.hooks.pendingOperations()).toHaveLength(1);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pending: true, content: 'Keep this'});
  });
});

describe('F-04 service worker revisions', () => {
  test('does not register a provisional legacy revision before the server revision is known', async () => {
    const register = vi.fn(async () => {});
    const app = track(await createApp({serviceWorker: {register}}));

    expect(register).not.toHaveBeenCalled();
  });

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

describe('batched remote application', () => {
  test('applies a change page and cursor in one logical local update', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Old', content: 'Old content', revision: 1});
    await app.hooks.putLocalNote({id: 'note-b', title: 'Delete me', content: 'Remove', revision: 1});
    const remote = {id: 'note-a', title: 'New', tags: 'work', content: 'New content', revision: 2};

    await app.hooks.applyRemoteChangePage(
      [{note_id: 'note-a', deleted: false}, {note_id: 'note-b', deleted: true}],
      new Map([['note-a', remote]]),
      42,
    );

    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({...remote, pending: false});
    expect(await app.hooks.getLocalNote('note-b')).toBeUndefined();
    expect(await app.hooks.getOfflineState('syncSequence')).toBe(42);
  });
});

describe('sync request lifecycle', () => {
  test('tracks and cancels a pull-style request through the shared manager', async () => {
    let markStarted;
    let release;
    let signal;
    const started = new Promise(resolve => { markStarted = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const app = track(await createApp({
      fetchImpl: async (path, options) => {
        signal = options.signal;
        markStarted();
        await gate;
        return response(200, '{}');
      },
    }));
    const request = app.hooks.api('/api/sync?since=0', {syncRequest: true});
    await started;
    expect(app.window.document.querySelector('#sync-status').dataset.state).toBe('syncing');
    app.hooks.cancelActiveSyncRequests();
    expect(signal.aborted).toBe(true);
    release();
    await request;
    expect(app.window.document.querySelector('#sync-status').dataset.state).toBe('online');
  });
});

describe('preference sync coordination', () => {
  test('coalesces preference changes into field-level patches', async () => {
    const app = track(await createApp());

    await app.hooks.savePref('theme', 'default-dark');
    await app.hooks.savePref('accentColor', '#123456');
    app.hooks.cancelScheduledSync();

    const pending = await app.hooks.pendingOperations();
    expect(pending).toHaveLength(1);
    expect(pending[0].base_revision).toBe(1);
    expect(pending[0].prefs._sync_patch).toEqual({theme: 'default-dark', accentColor: '#123456'});
    expect(pending[0].prefs._sync_base).toEqual({theme: 'default-light', accentColor: ''});
  });

  test('surfaces same-field preference conflicts and keeps the remote value', async () => {
    const remote = {
      revision: 2,
      autoSave: true,
      hidePreview: false,
      hideHeaderOnFullscreen: false,
      hideToolbar: false,
      collapseDetails: false,
      hideCursorHighlight: false,
      theme: 'solarized-dark',
      accentColor: '',
      fontFamily: 'system-sans',
      editorFontFamily: 'system-monospace',
      previewFontFamily: 'system-sans',
    };
    const app = track(await createApp({
      fetchImpl: async (path, options) => {
        if (String(path) === '/api/sync/push') {
          const request = JSON.parse(options.body);
          const operation = request.operations[0];
          return response(200, JSON.stringify({
            acknowledged: [{client_sequence: operation.client_sequence, op_id: operation.op_id, status: 'conflict', current_revision: 2}],
            expected_sequence: operation.client_sequence + 1,
          }));
        }
        if (String(path) === '/api/prefs') return response(200, JSON.stringify(remote));
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    app.window.console.error = () => {};
    await app.hooks.savePref('theme', 'default-dark');
    app.hooks.cancelScheduledSync();

    await expect(app.hooks.flushPendingChanges()).resolves.toBe(true);

    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(JSON.parse(app.window.localStorage.getItem('mdnotes-prefs'))).toMatchObject({theme: 'solarized-dark', revision: 2});
    expect(app.window.document.querySelector('#toast-region').textContent).toContain('Some preferences changed on another device');
  });
});

describe('deep-link restoration', () => {
  test('fetches an uncached deep-linked note before declaring it missing', async () => {
    const remote = {id: 'note-a', filename: 'note-a.md', title: 'Remote note', tags: 'work', content: 'Loaded directly', revision: 4};
    const app = track(await createApp({
      fetchImpl: async path => {
        if (String(path) === '/api/notes/note-a') return response(200, JSON.stringify(remote));
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    app.window.history.replaceState({}, '', '/note-a');

    await app.hooks.restoreRoute({fetchRemote: true});

    expect(app.window.location.pathname).toBe('/note-a');
    expect(app.window.document.querySelector('#note-title').value).toBe('Remote note');
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject(remote);
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

describe('note pinning', () => {
  test('folds a pin into an unsynced note save', async () => {
    const app = track(await createApp());
    const note = {id: 'new-note', title: 'New', tags: '', content: 'body', revision: 0, base_revision: 0, pending: true};
    await app.hooks.putLocalNote(note);
    await app.hooks.queueOperation({type: 'note.save', note_id: note.id, base_revision: 0, note});

    await app.hooks.toggleNotePin(note.id);

    const operations = await app.hooks.pendingOperations();
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({type: 'note.save', base_revision: 0, note: {pinned: true}});
    expect(await app.hooks.getLocalNote(note.id)).toMatchObject({pinned: true, pending: true});
  });

  test('keeps a newer pin made after an initial save was claimed', async () => {
    const app = track(await createApp());
    const note = {id: 'new-note', title: 'New', tags: '', content: 'body', revision: 0, base_revision: 0, pending: true, pinned: false, pin_order: 0};
    await app.hooks.putLocalNote(note);
    await app.hooks.queueOperation({type: 'note.save', note_id: note.id, base_revision: 0, note});
    const save = (await app.hooks.pendingOperations())[0];
    await app.hooks.claimQueueOperation(save.id);
    await app.hooks.toggleNotePin(note.id);
    const pinnedLocally = await app.hooks.getLocalNote(note.id);

    await app.hooks.applySyncAcknowledgement(save, {status: 'applied', revision: 1});

    expect(await app.hooks.getLocalNote(note.id)).toMatchObject({pinned: true, pin_order: pinnedLocally.pin_order, revision: 1, pending: true, base_revision: 1});
    await expect(app.hooks.pendingOperations()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'note.pin', pinned: true, base_revision: 1}),
    ]));
  });


  test('filters before sorting and queues an offline pin without changing content', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'pinned-work', title: 'Pinned work', tags: 'work', content: 'keep', updated_at: '2026-01-01T00:00:00Z', revision: 2, pinned: true, pin_order: 10});
    await app.hooks.putLocalNote({id: 'recent-work', title: 'Recent work', tags: 'work', content: 'recent', updated_at: '2026-02-01T00:00:00Z', revision: 2});
    await app.hooks.putLocalNote({id: 'pinned-home', title: 'Pinned home', tags: 'home', content: 'hidden', updated_at: '2026-03-01T00:00:00Z', revision: 2, pinned: true, pin_order: 20});

    const notes = await app.hooks.getLocalNotes();
    expect(notes.map(note => note.id)).toEqual(['pinned-home', 'pinned-work', 'recent-work']);
    expect(notes.filter(note => (note.tags || '').split(',').includes('work')).map(note => note.id)).toEqual(['pinned-work', 'recent-work']);

    await app.hooks.toggleNotePin('recent-work');
    expect(await app.hooks.getLocalNote('recent-work')).toMatchObject({content: 'recent', pinned: true, pending: true});
    await expect(app.hooks.pendingOperations()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'note.pin', note_id: 'recent-work', pinned: true, base_revision: 2}),
    ]));

    await app.hooks.toggleNotePin('recent-work');
    const pinOperations = (await app.hooks.pendingOperations()).filter(operation => operation.note_id === 'recent-work' && operation.type === 'note.pin');
    expect(pinOperations).toHaveLength(1);
    expect(pinOperations[0].pinned).toBe(false);
    expect(await app.hooks.getLocalNote('recent-work')).toMatchObject({content: 'recent', pinned: false, pin_order: 0});
  });

  test('does not let a remote pin update replace a pending local pin', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Local', content: 'keep', revision: 2, pending: true, base_revision: 2, pinned: true, pin_order: 42});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 2, pinned: true});

    await app.hooks.applyRemoteChangePage(
      [{note_id: 'note-a', revision: 3, deleted: false}],
      new Map([['note-a', {id: 'note-a', title: 'Remote', content: 'replace', revision: 3, pinned: false, pin_order: 0}]]),
      3,
    );

    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({content: 'keep', pinned: true, pin_order: 42, pending: true});
  });

  test('does not accept remote deletion while a pin operation is queued', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Pinned locally', content: 'keep', revision: 2, pinned: true, pin_order: 9});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 2, pinned: true});

    await expect(app.hooks.applyRemoteDeletion('note-a')).resolves.toBe(false);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({content: 'keep', pinned: true});
  });

  test('rebases a later content save after a pin acknowledgement', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Note', content: 'body', revision: 1, pinned: false});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 1, pinned: true});
    await app.hooks.queueOperation({type: 'note.save', note_id: 'note-a', base_revision: 1, note: {id: 'note-a', title: 'Note', tags: '', content: 'edited'}});
    const pin = (await app.hooks.pendingOperations()).find(operation => operation.type === 'note.pin');

    await app.hooks.applySyncAcknowledgement(pin, {status: 'applied', op_id: pin.op_id, revision: 2, pin_order: 11});

    await expect(app.hooks.pendingOperations()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'note.save', note_id: 'note-a', base_revision: 2}),
    ]));
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pinned: true, pin_order: 11, revision: 2});
  });

  test('does not let an older pin acknowledgement undo a newer toggle', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Note', content: 'body', revision: 1, pinned: true, pin_order: 10, pending: true, base_revision: 1});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 1, pinned: true, pin_order: 10});
    const firstPin = (await app.hooks.pendingOperations())[0];
    await app.hooks.claimQueueOperation(firstPin.id);
    await app.hooks.toggleNotePin('note-a');

    await app.hooks.applySyncAcknowledgement(firstPin, {status: 'applied', revision: 2, pin_order: 11});

    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pinned: false, pin_order: 0, revision: 2, pending: true, base_revision: 2});
    await expect(app.hooks.pendingOperations()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'note.pin', pinned: false, base_revision: 2}),
    ]));
  });

  test('does not retry a stale pin over a newer toggle after conflict', async () => {
    const remote = {id: 'note-a', title: 'Remote', tags: '', content: 'body', revision: 3, pinned: false, pin_order: 0};
    const app = track(await createApp({fetchImpl: async path => String(path) === '/api/notes/note-a' ? response(200, JSON.stringify(remote)) : response(200, '{}')}));
    await app.hooks.putLocalNote({...remote, revision: 2, pinned: true, pin_order: 10, pending: true, base_revision: 2});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 2, pinned: true, pin_order: 10});
    const firstPin = (await app.hooks.pendingOperations())[0];
    await app.hooks.claimQueueOperation(firstPin.id);
    await app.hooks.toggleNotePin('note-a');

    await app.hooks.applySyncAcknowledgement(firstPin, {status: 'conflict', current_revision: 3});

    const remaining = await app.hooks.pendingOperations();
    expect(remaining.filter(operation => operation.type === 'note.pin')).toEqual([
      expect.objectContaining({pinned: false, base_revision: 3}),
    ]);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pinned: false, pin_order: 0, revision: 3, pending: true});
  });

  test('retries a stale pin against the latest remote revision', async () => {
    let pushCount = 0;
    let lastOperationID = '';
    const remote = {id: 'note-a', title: 'Remote', tags: '', content: 'remote', revision: 3, pinned: false, pin_order: 0};
    const app = track(await createApp({fetchImpl: async (path, options) => {
      if (String(path) === '/api/sync/push') {
        pushCount++;
        lastOperationID = JSON.parse(options.body).operations[0].op_id;
        return response(200, JSON.stringify(pushCount === 1
          ? {acknowledged: [{op_id: lastOperationID, status: 'conflict', current_revision: 3}], expected_sequence: 2}
          : {acknowledged: [{op_id: lastOperationID, status: 'applied', revision: 4, pin_order: 12}], expected_sequence: 3}));
      }
      if (String(path) === '/api/notes/note-a') return response(200, JSON.stringify(remote));
      throw new Error(`unexpected request: ${path}`);
    }}));
    await app.hooks.putLocalNote({...remote, title: 'Stale local', content: 'stale local', updated_at: '2025-01-01T00:00:00Z', pinned: false});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 2, pinned: true});

    await app.hooks.flushPendingChanges();
    expect(pushCount).toBe(2);
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({title: 'Remote', content: 'remote', pinned: true, pin_order: 12, revision: 4});
  });

  test('keeps a later local content save while rebasing a stale pin', async () => {
    const remote = {id: 'note-a', title: 'Remote', tags: '', content: 'remote', revision: 3, pinned: false, pin_order: 0};
    const app = track(await createApp({fetchImpl: async path => String(path) === '/api/notes/note-a' ? response(200, JSON.stringify(remote)) : response(200, '{}')}));
    await app.hooks.putLocalNote({...remote, title: 'Local edit', content: 'local edit', revision: 2, pending: true});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 2, pinned: true});
    await app.hooks.queueOperation({type: 'note.save', note_id: 'note-a', base_revision: 2, note: {id: 'note-a', title: 'Local edit', tags: '', content: 'local edit'}});
    const pin = (await app.hooks.pendingOperations()).find(operation => operation.type === 'note.pin');

    await app.hooks.applySyncAcknowledgement(pin, {status: 'conflict', current_revision: 3});

    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({title: 'Local edit', content: 'local edit', pinned: true, revision: 3, pending: true});
  });

  test('recovers a compacted pin acknowledgement from the remote note', async () => {
    const remote = {id: 'note-a', title: 'Remote', tags: '', content: 'body', revision: 4, pinned: true, pin_order: 19};
    const app = track(await createApp({fetchImpl: async path => String(path) === '/api/notes/note-a' ? response(200, JSON.stringify(remote)) : response(200, '{}')}));
    await app.hooks.putLocalNote({id: 'note-a', title: 'Local', content: 'body', revision: 3, pending: true, pinned: true, pin_order: 2});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 3, pinned: true});
    const operation = (await app.hooks.pendingOperations())[0];

    await app.hooks.acknowledgeCompactedOperation(operation);

    expect(await app.hooks.pendingOperations()).toHaveLength(0);
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pinned: true, pin_order: 19, revision: 4, pending: false});
  });

  test('keeps a dirty open note while a remote pin update arrives', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Local', content: 'typed', revision: 2, pinned: false});
    app.hooks.setEditorState({id: 'note-a', revision: 2, dirty: true, title: 'Local', content: 'typed'});

    await app.hooks.applyRemoteChangePage(
      [{note_id: 'note-a', revision: 3, deleted: false}],
      new Map([['note-a', {id: 'note-a', title: 'Remote', content: 'remote', revision: 3, pinned: true, pin_order: 21}]]),
      3,
    );

    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({content: 'typed', pinned: false});
  });

  test('preserves pin state during snapshot reconciliation', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'Old', content: 'body', revision: 1, pinned: false});
    await app.hooks.applyRemoteSnapshot(new Map([['note-a', {id: 'note-a', title: 'New', content: 'body', revision: 2, pinned: true, pin_order: 30}]]), new Set(['note-a']));
    expect(await app.hooks.getLocalNote('note-a')).toMatchObject({pinned: true, pin_order: 30, revision: 2});
  });

  test('supersedes a queued pin when a new note is deleted locally', async () => {
    const app = track(await createApp());
    await app.hooks.putLocalNote({id: 'note-a', title: 'New', content: 'body', revision: 0});
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 0, pinned: true});
    const operation = (await app.hooks.pendingOperations())[0];
    await app.hooks.removeLocalNoteAndSupersede('note-a', 0);
    expect(await app.hooks.getLocalNote('note-a')).toBeUndefined();
    expect(await app.hooks.pendingOperations()).toEqual([expect.objectContaining({id: operation.id, type: 'noop'})]);
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
      version: 4,
      queueIndexes: expect.arrayContaining(['note_id', 'client_sequence']),
    });
  });
});
