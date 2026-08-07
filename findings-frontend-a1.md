# Frontend Audit Report — mdnotes v2.2.7

**Auditor:** opencode frontend auditor  
**Date:** 2026-08-07  
**Scope:** `static/index.html`, `static/app.js`, `static/style.css`, `static/themes.js`, `static/sw.js`, `static/merge.js`

---

## Severity Legend

- **P0 Critical** — Breaking bug, data loss, or security issue
- **P1 High** — Significant accessibility barrier or functional regression
- **P2 Medium** — Notable UX issue, redundant work, or edge case
- **P3 Low** — Minor polish or best-practice deviation

---

## 1. Accessibility Issues

### 1.1 [P1] Login password field has no `<label>`
**File:** `static/index.html:80`

```html
<input type="password" name="password" placeholder="password" required autocomplete="current-password">
```

The password input uses only a `placeholder` as its visible label. Placeholders disappear on input and are not reliably announced by all screen readers. There is no `<label>` element associated with this field.

**Recommendation:** Add `<label for="...">` or an `aria-label` attribute.

---

### 1.2 [P1] Dashboard note items are not keyboard-accessible
**File:** `static/app.js:1449-1458`, `static/index.html:103`

Note items are rendered as `<div class="note-item">` with click handlers attached via `addEventListener`. They have no `role="button"`, no `tabindex="0"`, and no `keydown` handler for Enter/Space. Keyboard-only users cannot open notes.

**Recommendation:** Render note items as `<button>` or `<a>` elements, or add `role="button"`, `tabindex="0"`, and keyboard event handling.

---

### 1.3 [P1] Tag filter buttons are not keyboard-accessible
**File:** `static/app.js:1431-1442`

Tags in the tag bar are `<span class="tag">` elements with click handlers. No `role="button"`, no `tabindex="0"`, and no keyboard event handling. Keyboard-only users cannot filter by tag.

**Recommendation:** Use `<button>` elements or add ARIA roles and keyboard handlers.

---

### 1.4 [P1] Login error message lacks `role="alert"`
**File:** `static/index.html:82`

```html
<p id="login-error" class="error"></p>
```

When a wrong password is entered, the text is set programmatically (`app.js:1401`), but the element has no `role="alert"` or `aria-live` attribute. Screen readers will not announce the error.

**Recommendation:** Add `role="alert"` to the error element.

---

### 1.5 [P1] Meta pane toggle lacks `aria-expanded`
**File:** `static/index.html:212`

```html
<button class="meta-toggle" type="button" title="Toggle details">
```

The Details toggle in the editor has no `aria-expanded` attribute. Screen readers cannot determine whether the section is expanded or collapsed.

**Recommendation:** Add `aria-expanded` and update it when the panel is toggled (`app.js:1893-1895`).

---

### 1.6 [P2] Preferences modal does not trap focus
**File:** `static/index.html:109-147`, `static/app.js:2262-2271`

When the preferences modal opens, focus is not moved into it and there is no focus trap. Users can Tab out of the modal into the background content behind the backdrop. Clicking the backdrop closes the modal but does not restore focus to the trigger button.

**Recommendation:** Implement focus trap and focus restoration on close (the `Escape` key handler is also missing).

---

### 1.7 [P2] Conflict modal does not trap focus
**File:** `static/index.html:149-196`

Same issue as 1.6. The conflict resolution modal lacks focus trapping. Focus can escape to background content, and `Escape` does not close the modal.

**Recommendation:** Implement focus trap and `Escape` key handling.

---

### 1.8 [P2] Table picker grid has incomplete ARIA roles
**File:** `static/app.js:1686-1697`

The table picker uses `role="grid"` and `role="gridcell"` but lacks `role="row"` or `role="rowgroup"` wrappers. A grid requires row elements for correct semantics.

**Recommendation:** Wrap cells in `<div role="row">` containers.

---

### 1.9 [P2] Toast notifications auto-dismiss too quickly
**File:** `static/app.js:457-460`

Toasts disappear after 3.2 seconds. WCAG 2.2 SC 2.2.1 (Timing Adjustable) recommends that users have control over time limits. Important warnings (e.g., "Local storage is unavailable") may not be read in time, especially for users who rely on screen readers or have slow reading speed.

**Recommendation:** Increase timeout for warning/error toasts to at least 5-8 seconds, or add a dismiss button and extend on hover/focus.

---

### 1.10 [P2] `note-content` textarea has no associated label
**File:** `static/index.html:269`

```html
<textarea id="note-content" placeholder="Write markdown here..."></textarea>
```

There is no `<label for="note-content">` or `aria-label`. The "Editor" panel label is visually near the textarea but not programmatically associated.

**Recommendation:** Add `aria-label="Note content"` or a visually hidden `<label>`.

---

### 1.11 [P3] No skip navigation link
**File:** `static/index.html`

There is no skip link to jump past the header/tag bar to the main content area. Keyboard users must tab through all header elements and tags before reaching the note list.

**Recommendation:** Add a visually hidden skip link as the first focusable element.

---

## 2. UI / Edge Case Issues

### 2.1 [P1] `bulkRemoteNotes` URL can exceed browser length limits
**File:** `static/app.js:674-687`

```js
const response = await api(`/api/sync/notes?ids=${encodeURIComponent(batch.join(','))}`);
```

Note IDs are 32-character hex strings. With `bulkNoteBatchSize = 25`, the query string can reach ~800+ characters. On browsers with lower URL limits (some IE/Edge legacy thresholds at 2048 chars), or if the batch size is changed, this could silently fail. The endpoint only supports GET, so there is no POST fallback.

**Recommendation:** Use POST with a request body for bulk note fetches, or reduce batch size conservatively.

---

### 2.2 [P1] `pullRemoteChanges` infinite loop risk on stuck cursor
**File:** `static/app.js:724-726`

```js
if (page.hasMore && nextSince <= since) {
  throw new Error(`sync cursor did not advance (since ${since}, next ${nextSince})`);
}
```

If the server returns `hasMore: true` with the same `nextSequence`, the function throws — but the outer `syncNow` catch handler may retry via `scheduleSync`, which could re-enter `pullRemoteChanges` with the same stale cursor, creating a retry loop that hammers the server.

**Recommendation:** Track repeated cursor-stuck errors and back off or bail after N consecutive failures.

---

### 2.3 [P2] `saveCurrentNote` can leave `isDirty = true` after IndexedDB failure
**File:** `static/app.js:1634-1639`

```js
try {
  await saveLocalNoteAndQueue(local, {type: 'note.save', ...});
} catch (error) {
  console.error('local save failed', error);
  showToast('Could not save locally. Free browser storage and try again.', 'warning');
  return false;
}
```

If `saveLocalNoteAndQueue` throws (e.g., `QuotaExceededError`), `isDirty` is never set to `false`. The 250ms debounce timer will keep retrying, but the save may repeatedly fail and spam toasts.

**Recommendation:** Show the toast once per distinct error, and consider setting a cooldown to prevent toast spam.

---

### 2.4 [P2] Conflict resolver discards manual edits silently
**File:** `static/app.js:951-956`

When the user edits the merged result (switching to "Custom" state), then clicks "Use this device" or "Use other device", `fillConflictResolution` replaces their edits with the raw version without confirmation.

**Recommendation:** If `activeConflictSelection === 'custom'`, confirm before overwriting.

---

### 2.5 [P2] `checkFontAvailability` makes unconditional network request
**File:** `static/app.js:2312-2327`

`checkFontAvailability` fetches a Google Fonts stylesheet on every app load, even when the user has `fontFamily: 'system'`. This is a wasted network request for most users.

**Recommendation:** Skip the probe when `prefs.fontFamily === 'system'`.

---

### 2.6 [P2] Tag bar HTML rebuild causes unnecessary DOM thrashing
**File:** `static/app.js:1430-1442`

Every call to `renderDashboard` replaces the entire `#tag-bar` innerHTML and re-attaches click handlers to all tags. On fast sync cycles this can cause visible flickering and is inefficient.

**Recommendation:** Diff and patch only changed tags, or debounce `renderDashboard`.

---

### 2.7 [P3] `showConflictResolver` forces focus to textarea
**File:** `static/app.js:941`

```js
$('#conflict-note-content').focus();
```

If the user opened the conflict modal via keyboard navigation and was focused on a specific button, this forced focus shift can be disorienting.

**Recommendation:** Focus the modal container or first interactive element, or use `requestAnimationFrame` to let the user's focus land naturally.

---

### 2.8 [P3] Periodic sync timer has no guard against IndexedDB errors
**File:** `static/app.js:2412-2423`

```js
setInterval(async () => {
  if (document.visibilityState !== 'visible' || syncInFlight) return;
  try {
    const pending = (await pendingOperations()).length > 0;
    ...
  } catch (error) {
    console.warn('periodic sync check failed', error);
  }
}, 30000);
```

If IndexedDB is corrupted or unavailable, `pendingOperations()` throws every 30 seconds, filling the console with warnings. The catch prevents a crash but does not disable the timer.

**Recommendation:** After repeated failures, clear the interval or disable periodic sync.

---

### 2.9 [P3] `noteIDFromLocation` rejects valid long IDs
**File:** `static/app.js:66`

```js
const noteRouteIDPattern = /^[A-Za-z0-9_-]{1,64}$/;
```

The regex caps route IDs at 64 characters. The `newLocalNoteID` function generates 32-character hex strings, which is fine. But if the server ever generates longer IDs, navigation would break. The 64-char limit is undocumented and could silently reject valid IDs.

**Recommendation:** Either enforce the 64-char limit server-side, or increase the pattern length.

---

### 2.10 [P2] `reconcileLocalNotes` can trigger O(n) sequential API calls
**File:** `static/app.js:765-788`

On app startup, if the local state is significantly stale, `reconcileLocalNotes` downloads every changed note in batches of 100 via `bulkRemoteNotes`. With many notes, this can produce many sequential network requests, slowing startup.

**Recommendation:** Show a loading indicator during reconciliation, or use `Promise.all` for independent batches.

---

## 3. Unnecessary API Calls

### 3.1 [P2] Redundant `pullRemoteChanges` after `flushPendingChanges`
**File:** `static/app.js:1246-1247`

```js
const pushed = await flushPendingChanges();
if (pushed) await pullRemoteChanges();
```

`flushPendingChanges` pushes local changes. Then `pullRemoteChanges` fetches the full change feed again. If no other devices have synced in the interim, this second pull returns nothing new and wastes bandwidth.

**Recommendation:** After a push, only pull if there are server-side changes to fetch (e.g., check a `last-modified` header or use conditional requests).

---

### 3.2 [P2] `checkFontAvailability` runs on every login
**File:** `static/app.js:2337`, `static/app.js:2345`

Both the server-prefs path and the fallback path in `loadPrefs` call `checkFontAvailability()`. This fires a Google Fonts network probe on every session start, even when the user's preference is "System" font.

**Recommendation:** Guard with `if (prefs.fontFamily !== 'system')`.

---

### 3.3 [P3] Service worker revalidates cached assets on every navigation
**File:** `static/sw.js:52`

```js
fetch(request, {cache: 'no-cache'}).then(response => {
```

Every navigation fetches the resource from the network with `cache: 'no-cache'`, then updates the cache. This means `index.html`, `app.js`, etc. are fetched from the network on every page load, even when unchanged. The service worker provides no offline benefit for the app shell during normal operation — only when the network is down.

**Recommendation:** Use a stale-while-revalidate strategy or versioned cache keys to serve from cache while updating in the background.

---

## 4. Regression Risks

### 4.1 [P2] `isDirty` flag not cleared on failed save creates persistent dirty state
**File:** `static/app.js:1594-1598`, `static/app.js:1634-1639`

If the local save fails (IndexedDB error), `isDirty` remains `true`. The Back button (`app.js:1518-1529`) calls `saveCurrentNote(false)` which will fail again, potentially trapping the user in the editor with no way to navigate away without losing data.

**Recommendation:** On persistent save failure, offer a "discard and go back" option.

---

### 4.2 [P2] `applyRemoteDeletion` silently navigates away if user is editing
**File:** `static/app.js:665-671`

```js
async function applyRemoteDeletion(noteID) {
  await removeLocalNote(noteID);
  if (currentNoteId === noteID && !isDirty) {
    clearCurrentNote();
    await loadDashboard({sync: false});
    setDashboardRoute({replace: true});
  }
}
```

If the note is being edited (`isDirty = true`), the deletion is applied to IndexedDB but the editor still shows the stale content. The user's next save will attempt to re-create the deleted note as a new save, which may produce an unexpected ghost note.

**Recommendation:** If `isDirty`, warn the user that their note was deleted remotely before silently navigating away, or queue the local changes as a new note.

---

### 4.3 [P3] `renderDashboard` race condition on rapid navigation
**File:** `static/app.js:1427-1459`

`renderDashboard` replaces `innerHTML` of `#tag-bar` and `#note-list`. If the user navigates away and back quickly, the generation counter prevents stale renders, but click handlers from the previous render may briefly remain on detached DOM nodes.

**Recommendation:** The current generation guard is adequate; no action required, but worth noting as a latent risk.

---

## 5. Summary

| Severity | Count |
|----------|-------|
| P0 Critical | 0 |
| P1 High | 5 |
| P2 Medium | 11 |
| P3 Low | 6 |
| **Total** | **22** |

**Most impactful areas to address first:**
1. Keyboard accessibility for note items and tags (P1 #1.2, #1.3)
2. Login form labeling and error announcement (P1 #1.1, #1.4)
3. Modal focus management (P2 #1.6, #1.7)
4. `bulkRemoteNotes` URL length safety (P2 #2.1)
5. Redundant API calls on startup (P2 #3.2)
