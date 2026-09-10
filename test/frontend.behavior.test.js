import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
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

const styleSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'style.css'), 'utf8');

describe('font preferences', () => {
  test('uses text inputs and leaves Google Fonts fetching disabled by default', async () => {
    const app = track(await createApp());

    expect(app.window.document.querySelector('#pref-font').tagName).toBe('INPUT');
    expect(app.window.document.querySelector('#pref-editor-font').tagName).toBe('INPUT');
    expect(app.window.document.querySelector('#pref-preview-font').tagName).toBe('INPUT');
    expect(app.window.document.querySelector('#pref-font-google').checked).toBe(false);
    expect(app.window.document.querySelector('#pref-editor-font-google').checked).toBe(false);
    expect(app.window.document.querySelector('#pref-preview-font-google').checked).toBe(false);
    expect(app.window.document.querySelector('#pref-font-google').closest('.font-input-wrap')).not.toBeNull();
    expect(app.window.document.querySelector('#pref-editor-font-google').closest('.font-input-wrap')).not.toBeNull();
    expect(app.window.document.querySelector('#pref-preview-font-google').closest('.font-input-wrap')).not.toBeNull();
  });

  test('keeps arbitrary local font names and applies slot-specific system fallbacks', async () => {
    const app = track(await createApp());

    await app.hooks.savePref('fontFamily', 'Aptos');
    await app.hooks.savePref('editorFontFamily', 'Fira Code');
    await app.hooks.savePref('previewFontFamily', 'Source Serif 4');
    await app.hooks.applyFonts();

    const root = app.window.document.documentElement;
    expect(root.style.getPropertyValue('--font')).toContain('"Aptos"');
    expect(root.style.getPropertyValue('--font')).toContain('ui-sans-serif');
    expect(root.style.getPropertyValue('--editor-font')).toContain('"Fira Code"');
    expect(root.style.getPropertyValue('--editor-font')).toContain('ui-monospace');
    expect(root.style.getPropertyValue('--preview-font')).toContain('"Source Serif 4"');
    expect(root.style.getPropertyValue('--preview-font')).toContain('ui-sans-serif');
    await app.hooks.savePref('previewFontFamily', 'system-serif');
    await app.hooks.applyFonts();
    expect(root.style.getPropertyValue('--preview-font')).toContain('ui-serif');
    expect(app.window.document.querySelectorAll('[data-mdnotes-font]')).toHaveLength(0);
    expect(app.window.document.querySelector('#pref-font-error').hidden).toBe(true);
  });

  test('keeps an invalid font name visible and does not save it', async () => {
    const app = track(await createApp());
    const input = app.window.document.querySelector('#pref-font');
    const error = app.window.document.querySelector('#pref-font-error');

    input.value = 'Bad"Font';
    input.dispatchEvent(new app.window.Event('change'));

    await vi.waitFor(() => expect(error.hidden).toBe(false));
    expect(input.value).toBe('Bad"Font');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(error.textContent).toContain('valid font name');
    expect((await app.hooks.pendingOperations()).filter(operation => operation.type === 'prefs.save')).toHaveLength(0);
    expect(JSON.parse(app.window.localStorage.getItem('mdnotes-prefs') || '{}').fontFamily).not.toBe('Bad"Font');

    await app.hooks.applyFonts();
    expect(input.value).toBe('Bad"Font');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(error.hidden).toBe(false);
  });

  test('does not probe Google Fonts for local-only custom preferences', async () => {
    const app = track(await createApp());
    await app.hooks.savePref('fontFamily', 'Aptos');
    const head = app.window.document.head;
    const append = head.append.bind(head);
    let probeCount = 0;
    head.append = (...nodes) => {
      append(...nodes);
      nodes.filter(node => node.rel === 'stylesheet' && !node.dataset.mdnotesFont).forEach(node => {
        probeCount++;
        setTimeout(() => node.dispatchEvent(new app.window.Event('error')), 0);
      });
    };

    await app.hooks.loadPrefs();

    expect(probeCount).toBe(0);
    expect(app.window.document.querySelectorAll('[data-mdnotes-font]')).toHaveLength(0);
    expect(app.window.document.querySelector('#pref-font-error').hidden).toBe(true);
  });

  test('shows a font error when opt-in Google loading fails', async () => {
    const app = track(await createApp());
    app.window.console.warn = () => {};
    const head = app.window.document.head;
    const append = head.append.bind(head);
    head.append = (...nodes) => {
      append(...nodes);
      nodes.filter(node => node.rel === 'stylesheet' && node.dataset.mdnotesFont).forEach(node => {
        setTimeout(() => node.dispatchEvent(new app.window.Event('error')), 0);
      });
    };

    const fetchFonts = app.window.document.querySelector('#pref-font-google');
    fetchFonts.checked = true;
    fetchFonts.dispatchEvent(new app.window.Event('change'));
    await app.hooks.savePref('fontFamily', 'Definitely Not A Google Font');
    await app.hooks.applyFonts();

    const error = app.window.document.querySelector('#pref-font-error');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('Font not available');
    expect(app.window.document.documentElement.style.getPropertyValue('--font')).toContain('ui-sans-serif');
  });

  test('requests a Google family without assuming unsupported weights or styles', async () => {
    const app = track(await createApp());
    const head = app.window.document.head;
    const append = head.append.bind(head);
    let stylesheet;
    head.append = (...nodes) => {
      append(...nodes);
      stylesheet ||= nodes.find(node => node.rel === 'stylesheet' && node.dataset.mdnotesFont);
      nodes.filter(node => node.rel === 'stylesheet' && node.dataset.mdnotesFont).forEach(node => {
        setTimeout(() => node.dispatchEvent(new app.window.Event('load')), 0);
      });
    };
    app.window.document.fonts.load = async () => [{}];

    const fetchFonts = app.window.document.querySelector('#pref-font-google');
    fetchFonts.checked = true;
    fetchFonts.dispatchEvent(new app.window.Event('change'));
    await app.hooks.savePref('fontFamily', 'Crimson Pro');
    await app.hooks.applyFonts();

    expect(stylesheet.href).toContain('family=Crimson+Pro&display=swap');
    expect(stylesheet.href).not.toContain('ital,wght');
  });

  test('keeps Google fetching independent for each font slot', async () => {
    const app = track(await createApp());
    const head = app.window.document.head;
    const append = head.append.bind(head);
    head.append = (...nodes) => {
      append(...nodes);
      nodes.filter(node => node.rel === 'stylesheet' && node.dataset.mdnotesFont).forEach(node => {
        setTimeout(() => node.dispatchEvent(new app.window.Event('load')), 0);
      });
    };
    app.window.document.fonts.load = async () => [{}];

    await app.hooks.savePref('editorFontFamily', 'Fira Code');
    const editorFetch = app.window.document.querySelector('#pref-editor-font-google');
    editorFetch.checked = true;
    editorFetch.dispatchEvent(new app.window.Event('change'));
    await app.hooks.pendingOperations();
    await app.hooks.applyFonts();

    const requested = [...app.window.document.querySelectorAll('[data-mdnotes-font]')];
    expect(requested).toHaveLength(1);
    expect(requested[0].href).toContain('family=Fira+Code&display=swap');
    expect(app.window.document.querySelector('#pref-font-google').checked).toBe(false);
    expect(app.window.document.querySelector('#pref-preview-font-google').checked).toBe(false);
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
  test('preserves the starting number of ordered lists', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({
      id: 'note-a',
      title: 'Note',
      content: '6. [ ] six\n7. [ ] seven\n8. [ ] eight',
    });
    app.hooks.updatePreview();

    const ordered = app.window.document.querySelector('#preview ol');
    expect(ordered).not.toBeNull();
    expect(ordered.getAttribute('start')).toBe('6');
  });

  test('preserves nested and signed ordered-list starts but strips malformed attributes', async () => {
    const app = track(await createApp({realMarked: true}));
    app.window.marked = {
      parse: () => '<ol start="6"><li>outer<ol start="-2"><li>nested</li></ol></li></ol><ol start="not-a-number"><li>bad</li></ol><p start="9">not a list</p>',
    };
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: 'ordered'});
    app.hooks.updatePreview();

    const lists = [...app.window.document.querySelectorAll('#preview ol')];
    expect(lists.map(list => list.getAttribute('start'))).toEqual(['6', '-2', null]);
    expect(app.window.document.querySelector('#preview p').getAttribute('start')).toBeNull();
  });

  test('leaves three editor lines of bottom breathing room', async () => {
    expect(styleSource).toContain('#note-content{padding-bottom:4.95em;scroll-padding-bottom:4.95em}');
  });

  test('softly aligns the preview anchor with the editor caret', async () => {
    const app = track(await createApp());

    expect(app.hooks.calculatePreviewScrollAdjustment({
      previewTop: 0,
      previewHeight: 200,
      previewScrollTop: 0,
      previewScrollHeight: 600,
      anchorTop: 300,
      caretTop: 100,
      margin: 30,
      deadband: 20,
    })).toBe(200);

    expect(app.hooks.calculatePreviewScrollAdjustment({
      previewTop: 0,
      previewHeight: 200,
      previewScrollTop: 100,
      previewScrollHeight: 600,
      anchorTop: 112,
      caretTop: 100,
      margin: 30,
      deadband: 20,
    })).toBe(0);
  });

  test('highlights the rendered block containing the caret', async () => {
    const app = track(await createApp({realMarked: true}));
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

  test('maps a caret inside a loose list to the list block', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '- first\n\n- second\n\nparagraph';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});

    const textarea = app.window.document.querySelector('#note-content');
    const secondItemOffset = content.indexOf('second');
    textarea.selectionStart = textarea.selectionEnd = secondItemOffset;
    app.hooks.highlightBlock();

    const blocks = [...app.window.document.querySelector('#preview').children];
    expect(blocks[0].tagName).toBe('UL');
    expect(blocks[0].classList.contains('highlight')).toBe(true);
    expect(blocks[1].classList.contains('highlight')).toBe(false);
  });

  test('maps caret positions at block ends and in separator whitespace', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '# First\n\nfirst paragraph\n\n# Second\n\nsecond paragraph';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});
    app.hooks.updatePreview();

    const textarea = app.window.document.querySelector('#note-content');
    const blocks = [...app.window.document.querySelector('#preview').children];
    const positions = [
      {position: content.indexOf('# First') + '# First'.length, block: 0},
      {position: content.indexOf('\n\nfirst') + 1, block: 0},
      {position: content.indexOf('\n\n# Second') + 1, block: 1},
      {position: content.length, block: blocks.length - 1},
    ];

    for (const {position, block} of positions) {
      textarea.selectionStart = textarea.selectionEnd = position;
      app.hooks.highlightBlock();
      expect(blocks.filter(element => element.classList.contains('highlight'))).toHaveLength(1);
      expect(blocks[block].classList.contains('highlight')).toBe(true);
    }
  });

  test('maps a caret inside fenced code across blank lines to the code block', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '```text\ninside\n\ncode\n```\n\ntail';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});

    const textarea = app.window.document.querySelector('#note-content');
    const codeOffset = content.indexOf('code');
    textarea.selectionStart = textarea.selectionEnd = codeOffset;
    app.hooks.highlightBlock();

    const blocks = [...app.window.document.querySelector('#preview').children];
    expect(blocks[0].tagName).toBe('PRE');
    expect(blocks[0].classList.contains('highlight')).toBe(true);
    expect(blocks[1].classList.contains('highlight')).toBe(false);
  });

  test('does not use preview ranges from an older source while rendering is pending', async () => {
    const app = track(await createApp({realMarked: true}));
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content: 'first paragraph\n\nsecond paragraph'});

    const textarea = app.window.document.querySelector('#note-content');
    textarea.value = 'short\n\nsecond';
    textarea.selectionStart = textarea.selectionEnd = textarea.value.indexOf('second');
    app.hooks.highlightBlock();

    const blocks = [...app.window.document.querySelector('#preview').children];
    expect(blocks.every(block => !block.classList.contains('highlight'))).toBe(true);

    app.hooks.updatePreview();
    app.hooks.highlightBlock();
    const refreshedBlocks = [...app.window.document.querySelector('#preview').children];
    expect(refreshedBlocks[1].classList.contains('highlight')).toBe(true);
  });

  test('maps headings, blockquotes, thematic breaks, and tables to their blocks', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '> quoted\n\n## heading\n\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});

    const textarea = app.window.document.querySelector('#note-content');
    const preview = app.window.document.querySelector('#preview');
    const blocks = [...preview.children];
    expect(blocks.map(block => block.tagName)).toEqual(['BLOCKQUOTE', 'H2', 'HR', 'TABLE']);
    for (const [index, marker] of ['quoted', 'heading', '---', '| 1'].entries()) {
      textarea.selectionStart = textarea.selectionEnd = content.indexOf(marker);
      app.hooks.highlightBlock();
      expect(blocks[index].classList.contains('highlight')).toBe(true);
    }
  });

  test('maps a Setext heading to its rendered heading block', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = 'Setext heading\n==============\n\nparagraph';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});

    const textarea = app.window.document.querySelector('#note-content');
    textarea.selectionStart = textarea.selectionEnd = content.indexOf('Setext');
    app.hooks.highlightBlock();

    const blocks = [...app.window.document.querySelector('#preview').children];
    expect(blocks.map(block => block.tagName)).toEqual(['H1', 'P']);
    expect(blocks[0].classList.contains('highlight')).toBe(true);
  });

  test('maps rendered blocks after an omitted link-reference definition', async () => {
    const app = track(await createApp({realMarked: true}));
    const content = '[docs]: https://example.com\n\nParagraph with [docs].';
    app.hooks.showNoteInEditor({id: 'note-a', title: 'Note', content});

    const textarea = app.window.document.querySelector('#note-content');
    textarea.selectionStart = textarea.selectionEnd = content.indexOf('Paragraph');
    app.hooks.highlightBlock();

    const paragraph = app.window.document.querySelector('#preview > p');
    expect(paragraph).not.toBeNull();
    expect(paragraph.classList.contains('highlight')).toBe(true);
  });

  test('highlighting does not change preview block geometry', () => {
    expect(styleSource).toMatch(/\.preview \.highlight\{[^}]*background:/);
    expect(styleSource).not.toMatch(/\.preview \.highlight\{[^}]*\bmargin:/);
    expect(styleSource).not.toMatch(/\.preview \.highlight\{[^}]*\bpadding:/);
    expect(styleSource).toContain('.preview p{margin:0 0 1em}');
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

describe('server change invalidation', () => {
  test('refreshes preferences without scheduling an unrelated note sync', async () => {
    const requests = [];
    const app = track(await createApp({
      fetchImpl: async path => {
        requests.push(String(path));
        if (String(path) === '/api/prefs') return response(200, {revision: 2, theme: 'default-light'});
        if (String(path).startsWith('/api/sync?')) return response(200, {changes: [], nextSequence: 0, hasMore: false});
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    Object.defineProperty(app.window.document, 'visibilityState', {value: 'visible', configurable: true});

    await expect(app.hooks.handleServerChangeEvent({type: 'preferences', revision: 2})).resolves.toBe(true);
    await vi.waitFor(() => expect(requests.filter(path => path === '/api/prefs')).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(requests.some(path => path.startsWith('/api/sync?'))).toBe(false);
    expect(app.hooks.getSyncScheduleState()).toEqual({scheduled: false, options: {}});
  });

  test('ignores a note event already covered by the local sync cursor', async () => {
    const app = track(await createApp());
    Object.defineProperty(app.window.document, 'visibilityState', {value: 'visible', configurable: true});
    await app.hooks.applyRemoteChangePage([], new Map(), 42);

    await expect(app.hooks.handleServerChangeEvent({type: 'notes', sequence: 42})).resolves.toBe(false);
    expect(app.hooks.getSyncScheduleState()).toEqual({scheduled: false, options: {}});

    await expect(app.hooks.handleServerChangeEvent({type: 'notes', sequence: 43})).resolves.toBe(true);
    await new Promise(resolve => setTimeout(resolve, 90));
    expect(app.hooks.getSyncScheduleState().scheduled).toBe(true);
    app.hooks.cancelScheduledSync();
  });

  test('pulls again when a newer note event arrives during sync completion', async () => {
    let pullRequests = 0;
    const app = track(await createApp({
      deferredSyncCompletion: true,
      fetchImpl: async path => {
        if (!String(path).startsWith('/api/sync?')) throw new Error(`unexpected request: ${path}`);
        pullRequests++;
        return response(200, {changes: [], nextSequence: pullRequests > 1 ? 1 : 0, hasMore: false});
      },
    }));
    Object.defineProperty(app.window.document, 'visibilityState', {value: 'visible', configurable: true});

    const sync = app.hooks.syncNow();
    await app.syncCompletionStarted;
    await app.hooks.handleServerChangeEvent({type: 'notes', sequence: 1});
    app.releaseSyncCompletion();
    await sync;

    await vi.waitFor(() => expect(pullRequests).toBe(2));
  });
});

describe('sync coordinator', () => {
  test('reports a durable queued edit as saved but waiting to sync', async () => {
    const app = track(await createApp());
    app.hooks.setEditorState({
      id: 'note-a', dirty: true, title: 'Note', content: 'local edit',
      savedSnapshot: {title: '', tags: '', content: ''},
    });

    await app.hooks.saveCurrentNote(false);
    await vi.waitFor(() => {
      const status = app.window.document.querySelector('#editor-status');
      expect(status).toMatchObject({
        dataset: expect.objectContaining({state: 'local'}),
        title: 'Saved on this device; waiting to sync',
      });
      expect(status.querySelector('.sync-indicator-label').textContent).toBe('Saved');
      expect(status.getAttribute('aria-label')).toBe('Saved on this device; waiting to sync');
    });
  });

  test('does not run a redundant follow-up for requests made during an idle sync', async () => {
    let markSyncStarted;
    let releaseSync;
    const syncStarted = new Promise(resolve => { markSyncStarted = resolve; });
    const syncGate = new Promise(resolve => { releaseSync = resolve; });
    let syncRequests = 0;
    const app = track(await createApp({
      fetchImpl: async path => {
        if (String(path).startsWith('/api/sync?')) {
          syncRequests++;
          if (syncRequests === 1) {
            markSyncStarted();
            await syncGate;
          }
          return response(200, {changes: [], nextSequence: 0, hasMore: false});
        }
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    Object.defineProperty(app.window.document, 'visibilityState', {value: 'visible', configurable: true});

    const sync = app.hooks.syncNow();
    await syncStarted;
    app.hooks.scheduleSync();
    app.hooks.scheduleSync();
    releaseSync();
    await sync;
    await new Promise(resolve => setTimeout(resolve, 180));

    expect(syncRequests).toBe(1);
  });

  test('keeps one logical syncing state across pull, push, and final pull', async () => {
    let markPushStarted;
    let releasePush;
    const pushStarted = new Promise(resolve => { markPushStarted = resolve; });
    const pushGate = new Promise(resolve => { releasePush = resolve; });
    const app = track(await createApp({
      fetchImpl: async (path, options) => {
        const value = String(path);
        if (value.startsWith('/api/sync?')) return response(200, {changes: [], nextSequence: 0, hasMore: false});
        if (value === '/api/sync/push') {
          const request = JSON.parse(options.body);
          markPushStarted();
          await pushGate;
          return response(200, {
            acknowledged: request.operations.map(operation => ({
              client_sequence: operation.client_sequence,
              op_id: operation.op_id,
              status: 'applied',
              revision: 1,
            })),
            expected_sequence: request.operations.at(-1).client_sequence + 1,
          });
        }
        throw new Error(`unexpected request: ${path}`);
      },
    }));
    Object.defineProperty(app.window.document, 'visibilityState', {value: 'visible', configurable: true});
    await app.hooks.putLocalNote({id: 'note-a', title: 'Note', tags: '', content: 'body', revision: 0, pending: true, base_revision: 0});
    await app.hooks.queueOperation({type: 'note.save', note_id: 'note-a', base_revision: 0, note: {id: 'note-a', title: 'Note', tags: '', content: 'body', revision: 0}});

    const states = [];
    const status = app.window.document.querySelector('#sync-status');
    const observer = new app.window.MutationObserver(() => states.push(status.dataset.state));
    observer.observe(status, {attributes: true, subtree: true, childList: true});
    const sync = app.hooks.syncNow();
    await pushStarted;
    await new Promise(resolve => setTimeout(resolve, 180));
    releasePush();
    await sync;
    await new Promise(resolve => setTimeout(resolve, 0));
    observer.disconnect();

    expect(states.filter((state, index) => index === 0 || state !== states[index - 1])).toEqual(['syncing', 'online']);
  });

  test('flushes a local edit made during sync without starting an empty extra cycle', async () => {
    let markFirstPushStarted;
    let releaseFirstPush;
    const firstPushStarted = new Promise(resolve => { markFirstPushStarted = resolve; });
    const firstPushGate = new Promise(resolve => { releaseFirstPush = resolve; });
    let app;
    let pullRequests = 0;
    let pushRequests = 0;
    const fetchImpl = async (path, options) => {
      const value = String(path);
      if (value.startsWith('/api/sync?')) {
        pullRequests++;
        return response(200, {changes: [], nextSequence: 0, hasMore: false});
      }
      if (value === '/api/sync/push') {
        pushRequests++;
        const request = JSON.parse(options.body);
        if (pushRequests === 1) {
          markFirstPushStarted();
          await firstPushGate;
        }
        return response(200, {
          acknowledged: request.operations.map(operation => ({
            client_sequence: operation.client_sequence,
            op_id: operation.op_id,
            status: 'applied',
            revision: 1,
          })),
          expected_sequence: request.operations.at(-1).client_sequence + 1,
        });
      }
      throw new Error(`unexpected request: ${path}`);
    };
    app = track(await createApp({fetchImpl}));
    Object.defineProperty(app.window.document, 'visibilityState', {value: 'visible', configurable: true});
    const first = {id: 'note-a', title: 'Note', tags: '', content: 'first', revision: 0};
    await app.hooks.putLocalNote({...first, pending: true, base_revision: 0});
    await app.hooks.queueOperation({type: 'note.save', note_id: first.id, base_revision: 0, note: first});

    const sync = app.hooks.syncNow();
    await firstPushStarted;
    const second = {...first, content: 'second', pending: true, base_revision: 0};
    await app.hooks.putLocalNote(second);
    await app.hooks.queueOperation({type: 'note.save', note_id: second.id, base_revision: 0, note: second});
    app.hooks.scheduleSync();
    releaseFirstPush();
    await sync;
    await new Promise(resolve => setTimeout(resolve, 180));

    expect(pushRequests).toBe(2);
    expect(pullRequests).toBe(2);
  });

  test('shows a loading state instead of a final empty state during initial hydration', async () => {
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

    const startup = app.hooks.init();
    await checkStarted;
    expect(app.window.document.querySelector('#note-list').textContent).toContain('Loading notes');
    releaseCheck();
    await startup;
    await new Promise(resolve => setTimeout(resolve, 0));
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

  test('does not self-conflict when a newer note save is queued during an earlier push', async () => {
    let revision = 1;
    let remote = {id: 'note-a', title: 'Note', tags: '', content: 'base', revision};
    const pushes = [];
    const app = track(await createApp({
      fetchImpl: async (path, options = {}) => {
        if (String(path) === '/api/sync/push') {
          const request = JSON.parse(options.body);
          pushes.push(request.operations);
          const acknowledged = request.operations.map(operation => {
            if (operation.base_revision !== revision) {
              return {
                client_sequence: operation.client_sequence,
                op_id: operation.op_id,
                status: 'conflict',
                current_revision: revision,
              };
            }
            revision++;
            remote = {...remote, title: operation.title, tags: operation.tags, content: operation.content, revision};
            return {
              client_sequence: operation.client_sequence,
              op_id: operation.op_id,
              status: 'applied',
              revision,
            };
          });
          return response(200, JSON.stringify({
            acknowledged,
            expected_sequence: request.operations.at(-1).client_sequence + 1,
          }));
        }
        if (String(path) === '/api/notes/note-a') return response(200, JSON.stringify(remote));
        throw new Error(`unexpected request: ${path}`);
      },
    }));

    await app.hooks.putLocalNote({
      ...remote,
      pending: true,
      base_revision: revision,
      base_content: remote.content,
      base_title: remote.title,
      base_tags: remote.tags,
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: revision,
      note: {...remote, content: 'first edit', base_revision: revision, base_content: remote.content, base_title: remote.title, base_tags: remote.tags},
    });
    const first = (await app.hooks.pendingOperations())[0];
    await app.hooks.claimQueueOperation(first.id);

    await app.hooks.putLocalNote({
      ...remote,
      content: 'newest edit',
      pending: true,
      base_revision: revision,
      base_content: remote.content,
      base_title: remote.title,
      base_tags: remote.tags,
    });
    await app.hooks.queueOperation({
      type: 'note.save',
      note_id: 'note-a',
      base_revision: revision,
      note: {...remote, content: 'newest edit', base_revision: revision, base_content: remote.content, base_title: remote.title, base_tags: remote.tags},
    });

    await expect(app.hooks.flushPendingChanges()).resolves.toBe(true);

    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toHaveLength(1);
    expect(pushes[1]).toHaveLength(1);
    expect(pushes[1][0].base_revision).toBe(2);
    expect(remote.content).toBe('newest edit');
    expect(app.window.document.querySelector('#toast-region').textContent).not.toContain('conflict');
    expect(await app.hooks.pendingOperations()).toHaveLength(0);
  });

  test('does not overwrite a remote edit when a stale pin precedes a local save', async () => {
    let revision = 3;
    let remote = {
      id: 'note-a', title: 'Note', tags: '',
      content: 'one\ntwo\nthree\nremote change',
      revision, pinned: false, pin_order: 0,
    };
    const app = track(await createApp({
      realMerge: true,
      fetchImpl: async (path, options = {}) => {
        if (String(path) === '/api/notes/note-a') return response(200, JSON.stringify(remote));
        if (String(path) !== '/api/sync/push') throw new Error(`unexpected request: ${path}`);
        const request = JSON.parse(options.body);
        const acknowledged = request.operations.map(operation => {
          if (operation.type !== 'noop' && operation.base_revision !== revision) {
            return {op_id: operation.op_id, status: 'conflict', current_revision: revision};
          }
          if (operation.type === 'noop') return {op_id: operation.op_id, status: 'applied'};
          revision++;
          if (operation.type === 'note.save') {
            remote = {...remote, title: operation.title, tags: operation.tags, content: operation.content, revision};
          } else if (operation.type === 'note.pin') {
            remote = {...remote, pinned: operation.pinned, pin_order: operation.pinned ? 9 : 0, revision};
          }
          return {op_id: operation.op_id, status: 'applied', revision, pin_order: remote.pin_order};
        });
        return response(200, JSON.stringify({
          acknowledged,
          expected_sequence: request.operations.at(-1).client_sequence + 1,
        }));
      },
    }));
    const base = 'one\ntwo\nthree\nfour';
    const localContent = 'one\nlocal change\nthree\nfour';
    await app.hooks.putLocalNote({
      ...remote, content: localContent, revision: 2, pinned: true, pin_order: 5,
      pending: true, base_revision: 2, base_content: base, base_title: 'Note', base_tags: '',
    });
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 2, pinned: true});
    await app.hooks.queueOperation({
      type: 'note.save', note_id: 'note-a', base_revision: 2,
      note: {id: 'note-a', title: 'Note', tags: '', content: localContent, revision: 2, pinned: true, base_revision: 2, base_content: base, base_title: 'Note', base_tags: ''},
    });

    await app.hooks.flushPendingChanges();

    expect(remote.content).toBe('one\nlocal change\nthree\nremote change');
  });

  test('preserves a later pin when an earlier save conflicts', async () => {
    let revision = 2;
    let remote = {
      id: 'note-a', title: 'Note', tags: '',
      content: 'one\ntwo\nthree\nremote change',
      revision, pinned: false, pin_order: 0,
    };
    const app = track(await createApp({
      realMerge: true,
      fetchImpl: async (path, options = {}) => {
        if (String(path) === '/api/notes/note-a') return response(200, JSON.stringify(remote));
        if (String(path) !== '/api/sync/push') throw new Error(`unexpected request: ${path}`);
        const request = JSON.parse(options.body);
        const acknowledged = request.operations.map(operation => {
          if (operation.type !== 'noop' && operation.base_revision !== revision) {
            return {op_id: operation.op_id, status: 'conflict', current_revision: revision};
          }
          if (operation.type === 'noop') return {op_id: operation.op_id, status: 'applied'};
          revision++;
          if (operation.type === 'note.save') {
            remote = {...remote, title: operation.title, tags: operation.tags, content: operation.content, pinned: operation.pinned, revision, pin_order: operation.pinned ? 12 : 0};
          } else if (operation.type === 'note.pin') {
            remote = {...remote, pinned: operation.pinned, revision, pin_order: operation.pinned ? 12 : 0};
          }
          return {op_id: operation.op_id, status: 'applied', revision, pin_order: remote.pin_order};
        });
        return response(200, JSON.stringify({acknowledged, expected_sequence: request.operations.at(-1).client_sequence + 1}));
      },
    }));
    const base = 'one\ntwo\nthree\nfour';
    const localContent = 'one\nlocal change\nthree\nfour';
    await app.hooks.putLocalNote({
      ...remote, content: localContent, revision: 1, pinned: true, pin_order: 5,
      pending: true, base_revision: 1, base_content: base, base_title: 'Note', base_tags: '',
    });
    await app.hooks.queueOperation({
      type: 'note.save', note_id: 'note-a', base_revision: 1,
      note: {id: 'note-a', title: 'Note', tags: '', content: localContent, revision: 1, pinned: false, base_revision: 1, base_content: base, base_title: 'Note', base_tags: ''},
    });
    await app.hooks.queueOperation({type: 'note.pin', note_id: 'note-a', base_revision: 1, pinned: true, pin_order: 5});

    await app.hooks.flushPendingChanges();

    expect(remote).toMatchObject({
      content: 'one\nlocal change\nthree\nremote change',
      pinned: true,
    });
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
  test('syncs Google font fetch switches as preference patches', async () => {
    const app = track(await createApp());

    const fetchFonts = app.window.document.querySelector('#pref-font-google');
    fetchFonts.checked = true;
    fetchFonts.dispatchEvent(new app.window.Event('change'));
    app.hooks.cancelScheduledSync();

    const pending = await app.hooks.pendingOperations();
    expect(pending).toHaveLength(1);
    expect(pending[0].prefs._sync_patch).toEqual({fontFamilyGoogle: true});
  });

  test('restores Google font fetch switches from remote preferences', async () => {
    const app = track(await createApp({
      fetchImpl: async path => {
        if (String(path) === '/api/prefs') return response(200, JSON.stringify({
          revision: 2,
          autoSave: true,
          fontFamily: 'Inter',
          fontFamilyGoogle: true,
          editorFontFamily: 'system-monospace',
          editorFontFamilyGoogle: false,
          previewFontFamily: 'system-sans',
          previewFontFamilyGoogle: false,
        }));
        throw new Error(`unexpected request: ${path}`);
      },
    }));

    const fetchFonts = app.window.document.querySelector('#pref-font-google');
    await app.hooks.loadPrefs();
    expect(fetchFonts.checked).toBe(true);
  });

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
