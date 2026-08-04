(function(){
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

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
let prefs = { autoSave: true, hidePreview: false, hideToolbar: false, collapseDetails: false, hideCursorHighlight: false };
let renderedPreviewSource = null;
let previewCheckFrame = null;
let highlightFrame = null;

function show(screen) {
  Object.values(screens).forEach(el => el.classList.add('hidden'));
  screen.classList.remove('hidden');
}

async function api(path, opts) {
  try {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: opts?.body ? {'Content-Type':'application/json'} : {},
      ...opts,
    });
    if (res.status === 401) {
      show(screens.login);
      $('#login-form input').focus();
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

// --- Auth ---
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = e.target.password.value;
  const res = await api('/api/login', {method:'POST', body:JSON.stringify({password:pw})});
  if (res) {
    $('#login-error').textContent = '';
    await loadPrefs();
    await loadDashboard();
  } else {
    $('#login-error').textContent = 'Wrong password';
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', {method:'POST'});
  show(screens.login);
  $('#login-form input').focus();
});

// --- Dashboard ---
async function loadDashboard() {
  show(screens.dashboard);
  await Promise.all([loadTags(), loadNotes()]);
}

async function loadTags() {
  const tags = await api('/api/tags');
  if (!tags) return;
  const bar = $('#tag-bar');
  let html = '<span class="tag'+(currentTag?'':' active')+'" data-tag="">All</span>';
  tags.forEach(t => {
    const active = t === currentTag ? ' active' : '';
    html += `<span class="tag${active}" data-tag="${esc(t)}">${esc(t)}</span>`;
  });
  bar.innerHTML = html;
  bar.querySelectorAll('.tag').forEach(el => {
    el.addEventListener('click', () => {
      const tag = el.dataset.tag;
      currentTag = tag;
      loadTags();
      loadNotes();
    });
  });
}

async function loadNotes() {
  const url = currentTag ? `/api/notes?tag=${encodeURIComponent(currentTag)}` : '/api/notes';
  const notes = await api(url);
  if (!notes) return;
  const list = $('#note-list');
  if (notes.length === 0) {
    list.innerHTML = '<div class="note-empty">No notes yet</div>';
    return;
  }
  list.innerHTML = notes.map(n => `
    <div class="note-item" data-id="${esc(n.id)}">
      <div class="note-title">${esc(n.title || 'Untitled')}</div>
      <div class="note-meta">${esc(formatDate(n.updated_at))}</div>
      ${n.tags ? '<div class="note-tags">'+n.tags.split(',').map(t=>`<span class="tag">${esc(t.trim())}</span>`).join('')+'</div>' : ''}
    </div>
  `).join('');
  list.querySelectorAll('.note-item').forEach(el => {
    el.addEventListener('click', () => openNote(el.dataset.id));
  });
}

function applyEditorPrefs() {
  $('.meta-pane').classList.toggle('collapsed', prefs.collapseDetails);
  if (prefs.hideToolbar) {
    $('.fmt-bar').classList.add('hidden');
  } else {
    $('.fmt-bar').classList.remove('hidden');
  }
}

// --- Editor ---
$('#new-note-btn').addEventListener('click', () => {
  if (saveTimer) clearTimeout(saveTimer);
  if (previewTimer) clearTimeout(previewTimer);
  setPanelState(prefs.hidePreview ? 'editor' : 'both');
  currentNoteId = null;
  isDirty = false;
  savedSnapshot = { title: '', tags: '', content: '' };
  $('#note-title').value = '';
  $('#note-tags').value = '';
  $('#note-content').value = '';
  $('#preview').innerHTML = '';
  renderedPreviewSource = null;
  $('#editor-status').textContent = '';
  cachePreviewBlocks();
  applyEditorPrefs();
  show(screens.editor);
  $('#note-title').focus();
});

$('#back-btn').addEventListener('click', async () => {
  if (saveTimer) clearTimeout(saveTimer);
  if (previewTimer) clearTimeout(previewTimer);
  await saveCurrentNote();
  await loadDashboard();
});

async function openNote(id) {
  if (saveTimer) clearTimeout(saveTimer);
  if (previewTimer) clearTimeout(previewTimer);
  setPanelState(prefs.hidePreview ? 'editor' : 'both');
  const data = await api(`/api/notes/${id}`);
  if (!data) return;
  currentNoteId = data.id;
  isDirty = false;
  savedSnapshot = { title: data.title || '', tags: data.tags || '', content: data.content || '' };
  $('#note-title').value = data.title || '';
  $('#note-tags').value = data.tags || '';
  $('#note-content').value = data.content || '';
  $('#editor-status').textContent = '';
  applyEditorPrefs();
  show(screens.editor);
  updatePreview();
}

// --- Autosave ---
function markDirty() {
  if (!isDirty) {
    isDirty = true;
    $('#editor-status').textContent = 'Unsaved changes';
  }
}

async function saveCurrentNote() {
  const title = $('#note-title').value.trim() || 'Untitled';
  const tags = $('#note-tags').value.trim();
  const content = $('#note-content').value;

  const data = {title, tags, content};
  if (currentNoteId) data.id = currentNoteId;

  if (currentNoteId && data.title === savedSnapshot.title && data.tags === savedSnapshot.tags && data.content === savedSnapshot.content) {
    isDirty = false;
    $('#editor-status').textContent = '';
    return;
  }
  $('#editor-status').textContent = 'Saving...';
  const res = await api('/api/notes', {method:'POST', body:JSON.stringify(data)});
  if (res) {
    currentNoteId = res.id;
    savedSnapshot = { title: data.title, tags: data.tags, content: data.content };
    isDirty = false;
    $('#editor-status').textContent = 'Saved';
    setTimeout(() => {
      if (!isDirty) $('#editor-status').textContent = '';
    }, 2000);
  } else {
    $('#editor-status').textContent = 'Save failed';
  }
}

let saveTimer = null;
let previewTimer = null;

function scheduleSave() {
  if (!prefs.autoSave) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (isDirty) saveCurrentNote();
  }, 5000);
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
  document.querySelectorAll('.panel-toggle use').forEach(el => {
    el.setAttribute('href', state === 'both' ? '#icon-plus' : '#icon-minus');
  });
  if (state !== 'editor') schedulePreviewCheck();
}

$('#editor-panels').addEventListener('click', e => {
  const btn = e.target.closest('.panel-toggle');
  if (!btn) return;
  if (panelState === 'both') {
    setPanelState(btn.dataset.panel);
  } else {
    setPanelState('both');
  }
});

// --- Fullscreen toggle ---
function toggleFullscreen(panel) {
  const editor = $('#editor');
  const cls = 'fs-' + panel;
  if (editor.classList.contains(cls)) {
    editor.classList.remove('fs-editor', 'fs-preview');
  } else {
    editor.classList.remove('fs-editor', 'fs-preview');
    editor.classList.add(cls);
  }
  schedulePreviewCheck();
}

$('#editor-panels').addEventListener('click', e => {
  const btn = e.target.closest('.panel-fs');
  if (btn) toggleFullscreen(btn.dataset.fs);
});

// --- Cursor preview highlight ---
let previewBlocks = [];
function isPreviewVisible() {
  return !screens.editor.classList.contains('hidden') && panelState !== 'editor' && !screens.editor.classList.contains('fs-editor');
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
  const ok = await api(`/api/notes/${currentNoteId}`, {method:'DELETE'});
  if (ok) {
    currentNoteId = null;
    await loadDashboard();
  }
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

function updatePreview() {
  if (!isPreviewVisible()) return;
  const md = $('#note-content').value;
  if (md === renderedPreviewSource) {
    scheduleHighlight();
    return;
  }
  if (typeof marked !== 'undefined' && marked.parse) {
    $('#preview').innerHTML = marked.parse(md, {breaks:true,gfm:true});
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
  await api('/api/prefs', { method: 'PATCH', body: JSON.stringify(prefs) });
  applyEditorPrefs();
}

$('#pref-autosave').addEventListener('change', function () {
  savePref('autoSave', this.checked);
});
$('#pref-hidepreview').addEventListener('change', function () {
  savePref('hidePreview', this.checked);
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
  if (p) prefs = p;
}

// --- Init ---
async function init() {
  const res = await api('/api/check');
  if (res) {
    await loadPrefs();
    await loadDashboard();
  } else {
    show(screens.login);
    $('#login-form input').focus();
  }
}

init();

// Service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveCurrentNote();
  }
});

})();
