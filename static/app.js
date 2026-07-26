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
    await loadDashboard();
  } else {
    $('#login-error').textContent = 'Wrong password';
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', {method:'POST'});
  show(screens.login);
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

// --- Editor ---
$('#new-note-btn').addEventListener('click', () => {
  if (saveTimer) clearTimeout(saveTimer);
  setPanelState('both');
  currentNoteId = null;
  isDirty = false;
  $('#note-title').value = '';
  $('#note-tags').value = '';
  $('#note-content').value = '';
  $('#preview').innerHTML = '';
  $('#editor-status').textContent = '';
  show(screens.editor);
  $('#note-title').focus();
});

$('#back-btn').addEventListener('click', async () => {
  if (saveTimer) clearTimeout(saveTimer);
  await saveCurrentNote();
  await loadDashboard();
});

async function openNote(id) {
  if (saveTimer) clearTimeout(saveTimer);
  setPanelState('both');
  const data = await api(`/api/notes/${id}`);
  if (!data) return;
  currentNoteId = data.id;
  isDirty = false;
  $('#note-title').value = data.title || '';
  $('#note-tags').value = data.tags || '';
  $('#note-content').value = data.content || '';
  $('#editor-status').textContent = '';
  updatePreview();
  show(screens.editor);
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

  $('#editor-status').textContent = 'Saving...';
  const res = await api('/api/notes', {method:'POST', body:JSON.stringify(data)});
  if (res) {
    currentNoteId = res.id;
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

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (isDirty) saveCurrentNote();
  }, 5000);
}

$('#save-btn').addEventListener('click', () => { if (saveTimer) clearTimeout(saveTimer); saveCurrentNote(); });
$('#note-title').addEventListener('input', () => { markDirty(); scheduleSave(); });
$('#note-tags').addEventListener('input', () => { markDirty(); scheduleSave(); });

// --- Formatting toolbar ---
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
}

document.querySelector('.fmt-bar')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-fmt]');
  if (btn) {
    e.preventDefault();
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
  document.querySelectorAll('.panel-toggle .material-symbols-outlined').forEach(el => {
    el.textContent = state === 'both' ? 'add' : 'remove';
  });
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
}

$('#editor-panels').addEventListener('click', e => {
  const btn = e.target.closest('.panel-fs');
  if (btn) toggleFullscreen(btn.dataset.fs);
});

// --- Cursor preview highlight ---
function highlightBlock() {
  const ta = $('#note-content');
  const pv = $('#preview');
  pv.querySelectorAll('.highlight').forEach(el => el.classList.remove('highlight'));
  const text = ta.value;
  const pos = ta.selectionStart;
  if (!text.trim() || !pv.children.length) return;
  const before = text.slice(0, pos);
  const nonEmpty = before.split(/\n\n+/).filter(b => b.trim());
  let idx = Math.max(0, nonEmpty.length - 1);
  const blocks = Array.from(pv.children).filter(c => c.tagName && !['STYLE','SCRIPT'].includes(c.tagName));
  if (idx >= blocks.length) idx = blocks.length - 1;
  blocks[idx]?.classList.add('highlight');
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
  updatePreview();
});
$('#note-content').addEventListener('click', highlightBlock);
$('#note-content').addEventListener('keyup', highlightBlock);

function updatePreview() {
  const md = $('#note-content').value;
  if (typeof marked !== 'undefined' && marked.parse) {
    $('#preview').innerHTML = marked.parse(md, {breaks:true,gfm:true});
  } else {
    $('#preview').innerHTML = '<p><em>loading parser...</em></p>';
  }
  highlightBlock();
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
  const icon = dark ? 'dark_mode' : 'light_mode';
  $$('.theme-btn .material-symbols-outlined').forEach(el => el.textContent = icon);
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

$$('.theme-btn').forEach(el => el.addEventListener('click', toggleTheme));

// --- Init ---
async function init() {
  const res = await api('/api/check');
  if (res) {
    await loadDashboard();
  } else {
    show(screens.login);
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
