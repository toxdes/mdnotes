package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type sseTestRecorder struct {
	*httptest.ResponseRecorder
	flushes int
}

func TestStaticCachePreventsProxyTransforms(t *testing.T) {
	handler := staticCacheMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

	for _, path := range []string{"/", "/style.css"} {
		result := httptest.NewRecorder()
		handler.ServeHTTP(result, httptest.NewRequest(http.MethodGet, path, nil))
		if cacheControl := result.Header().Get("Cache-Control"); !strings.Contains(cacheControl, "no-transform") {
			t.Fatalf("Cache-Control for %s = %q, want no-transform", path, cacheControl)
		}
	}
}

func TestSecurityHeadersUseStrictCSP(t *testing.T) {
	handler := securityHeaders(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, httptest.NewRequest(http.MethodGet, "/", nil))

	csp := result.Header().Get("Content-Security-Policy")
	for _, directive := range []string{"script-src 'self'", "style-src 'self'", "connect-src 'self'", "worker-src 'self'", "object-src 'none'"} {
		if !strings.Contains(csp, directive) {
			t.Fatalf("CSP %q is missing %q", csp, directive)
		}
	}
}

func TestGzipMiddlewareCompressesErrorResponsesCorrectly(t *testing.T) {
	handler := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	request := httptest.NewRequest(http.MethodGet, "/style.css", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, request)

	if result.Code != http.StatusForbidden || result.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("gzip error response = status %d, encoding %q", result.Code, result.Header().Get("Content-Encoding"))
	}
	reader, err := gzip.NewReader(result.Body)
	if err != nil {
		t.Fatalf("read gzip response: %v", err)
	}
	decompressed, err := io.ReadAll(reader)
	if closeErr := reader.Close(); err == nil {
		err = closeErr
	}
	if err != nil || string(decompressed) != "forbidden\n" {
		t.Fatalf("gzip error body = %q, %v", decompressed, err)
	}
}

func TestLegacyIPBansAreClearedByMigration(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at TEXT NOT NULL
	)`); err != nil {
		t.Fatalf("create migration table: %v", err)
	}
	for _, migration := range migrations[:len(migrations)-2] {
		tx, err := db.Begin()
		if err != nil {
			t.Fatalf("begin migration %d: %v", migration.version, err)
		}
		if err := migration.up(tx); err != nil {
			tx.Rollback()
			t.Fatalf("apply migration %d: %v", migration.version, err)
		}
		if _, err := tx.Exec("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", migration.version, "2025-01-01T00:00:00Z"); err != nil {
			tx.Rollback()
			t.Fatalf("record migration %d: %v", migration.version, err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatalf("commit migration %d: %v", migration.version, err)
		}
	}
	if _, err := db.Exec("INSERT INTO ip_bans (ip, reason, created_at) VALUES ('203.0.113.7', 'too many 404s', '2025-01-01T00:00:00Z')"); err != nil {
		t.Fatalf("insert legacy ban: %v", err)
	}
	if err := initDB(db); err != nil {
		t.Fatalf("apply ban-clearing migration: %v", err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM ip_bans").Scan(&count); err != nil || count != 0 {
		t.Fatalf("legacy bans after migration = %d, %v; want 0", count, err)
	}
}

func TestRateLimiterBanIsTemporaryAndLoginWindowResets(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	rl, err := newRateLimiter(db, false)
	if err != nil {
		t.Fatalf("new rate limiter: %v", err)
	}
	for range 5 {
		if err := rl.recordLoginAttempt("203.0.113.7", false); err != nil {
			t.Fatalf("record failed login: %v", err)
		}
	}
	if banned, err := rl.isBanned("203.0.113.7"); err != nil || !banned {
		t.Fatalf("temporary login ban = %t, %v; want true", banned, err)
	}
	restarted, err := newRateLimiter(db, false)
	if err != nil {
		t.Fatalf("restart rate limiter: %v", err)
	}
	if banned, err := restarted.isBanned("203.0.113.7"); err != nil || banned {
		t.Fatalf("ban persisted after restart = %t, %v; want false", banned, err)
	}
	old := time.Now().UTC().Add(-loginAttemptWindow - time.Minute).Format(time.RFC3339)
	if _, err := db.Exec("INSERT INTO rate_limits (ip, typ, count, updated_at) VALUES (?, 'login', 4, ?)", "203.0.113.8", old); err != nil {
		t.Fatalf("seed expired login attempts: %v", err)
	}
	if err := rl.recordLoginAttempt("203.0.113.8", false); err != nil {
		t.Fatalf("record login after expired window: %v", err)
	}
	var count int
	if err := db.QueryRow("SELECT count FROM rate_limits WHERE ip = ? AND typ = 'login'", "203.0.113.8").Scan(&count); err != nil || count != 1 {
		t.Fatalf("expired-window login count = %d, %v; want 1", count, err)
	}
}

func (r *sseTestRecorder) Flush() {
	r.flushes++
}

func (r *sseTestRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseRecorder
}

func TestSanitizePathRejectsSiblingPrefix(t *testing.T) {
	base := t.TempDir()
	inside, err := sanitizePath(base, "note.md")
	if err != nil {
		t.Fatalf("sanitize inside path: %v", err)
	}
	if inside != filepath.Join(base, "note.md") {
		t.Fatalf("inside path = %q", inside)
	}
	if _, err := sanitizePath(base, "../"+filepath.Base(base)+"-other.md"); err == nil {
		t.Fatal("sibling path with matching prefix was accepted")
	}
}

func TestReadSecretFromFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(path, []byte("value\n"), 0600); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	t.Setenv("MDNOTES_TEST_SECRET_FILE", path)
	value, err := readSecret("MDNOTES_TEST_SECRET")
	if err != nil || value != "value" {
		t.Fatalf("read secret = %q, %v", value, err)
	}
}

func TestVersionedEncryptionBindsTheNoteID(t *testing.T) {
	config := &encryptionConfig{key: make([]byte, 32)}
	for i := range config.key {
		config.key[i] = byte(i + 1)
	}
	ciphertext, err := config.encryptNote([]byte("private note"), "note-a")
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if string(ciphertext[:len(envelopeMagic)]) != envelopeMagic {
		t.Fatal("new ciphertext does not have a versioned envelope")
	}
	plaintext, err := config.decryptNote(ciphertext, "note-a")
	if err != nil || string(plaintext) != "private note" {
		t.Fatalf("decrypt = %q, %v", plaintext, err)
	}
	if _, err := config.decryptNote(ciphertext, "note-b"); err == nil {
		t.Fatal("ciphertext was accepted under a different note ID")
	}
}

func TestPasswordEncryptionReadsLegacyNotes(t *testing.T) {
	dir := t.TempDir()
	config, err := newEncryptionConfig(dir, "correct horse battery staple", "")
	if err != nil {
		t.Fatalf("create password config: %v", err)
	}
	legacy, err := encryptLegacy([]byte("old note"), deriveKey("correct horse battery staple"))
	if err != nil {
		t.Fatalf("encrypt legacy: %v", err)
	}
	plaintext, err := config.decryptNote(legacy, "old-id")
	if err != nil || string(plaintext) != "old note" {
		t.Fatalf("decrypt legacy = %q, %v", plaintext, err)
	}
	info, err := os.Stat(filepath.Join(dir, metaFilename))
	if err != nil {
		t.Fatalf("encryption metadata: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("metadata mode = %o, want 600", info.Mode().Perm())
	}
}

func TestMigrateEncryptionUpgradesLegacyFiles(t *testing.T) {
	notesDir := t.TempDir()
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if err := upsertNote(db, "legacy-id", "Legacy", "legacy-id.md", ""); err != nil {
		t.Fatalf("create legacy note: %v", err)
	}
	legacy, err := encryptLegacy([]byte("migrate me"), deriveKey("old secret"))
	if err != nil {
		t.Fatalf("encrypt legacy: %v", err)
	}
	path := filepath.Join(notesDir, "legacy-id.md")
	if err := writeNoteFile(path, legacy); err != nil {
		t.Fatalf("write legacy note: %v", err)
	}
	config, err := newEncryptionConfig(notesDir, "old secret", "")
	if err != nil {
		t.Fatalf("new config: %v", err)
	}
	a := &app{db: db, notesDir: notesDir, encryption: config}
	count, err := migrateEncryption(a)
	if err != nil || count != 1 {
		t.Fatalf("migrate = %d, %v", count, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migrated note: %v", err)
	}
	if !isVersionedEnvelope(data) {
		t.Fatal("migrated note does not use versioned encryption")
	}
	plaintext, err := config.decryptNote(data, "legacy-id")
	if err != nil || string(plaintext) != "migrate me" {
		t.Fatalf("decrypt migrated note = %q, %v", plaintext, err)
	}
}

func TestNoteCacheIsBounded(t *testing.T) {
	c := newNoteCache()
	for i := 0; i < maxCachedNotes+1; i++ {
		c.set(string(rune('a'+i)), "content")
	}
	if c.lru.Len() != maxCachedNotes {
		t.Fatalf("cache length = %d, want %d", c.lru.Len(), maxCachedNotes)
	}
	if _, ok := c.get("a"); ok {
		t.Fatal("least-recently-used entry was not evicted")
	}
	large := make([]byte, maxCacheBytes+1)
	c.set("large", string(large))
	if _, ok := c.get("large"); ok {
		t.Fatal("oversized cache entry was retained")
	}
}

func TestNormalizeTags(t *testing.T) {
	if got, want := normalizeTags(" work,personal, work, , personal "), "work,personal"; got != want {
		t.Fatalf("normalizeTags() = %q, want %q", got, want)
	}
}

func TestNoteTagsAreIndexedAndSorted(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if err := upsertNote(db, "first", "First", "first.md", "zebra,alpha"); err != nil {
		t.Fatalf("insert first: %v", err)
	}
	if err := upsertNote(db, "second", "Second", "second.md", "alpha"); err != nil {
		t.Fatalf("insert second: %v", err)
	}
	tags, err := listTags(db)
	if err != nil {
		t.Fatalf("list tags: %v", err)
	}
	if len(tags) != 2 || tags[0] != "alpha" || tags[1] != "zebra" {
		t.Fatalf("tags = %#v", tags)
	}
	notes, err := listNotes(db, "alpha")
	if err != nil {
		t.Fatalf("filter notes: %v", err)
	}
	if len(notes) != 2 {
		t.Fatalf("filtered notes = %d, want 2", len(notes))
	}
}

func TestNoteRevisionsAndTombstonesUseServerChanges(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if err := upsertNote(db, "sync-note", "First", "sync-note.md", ""); err != nil {
		t.Fatalf("create note: %v", err)
	}
	if err := upsertNote(db, "sync-note", "Second", "sync-note.md", ""); err != nil {
		t.Fatalf("update note: %v", err)
	}
	n, err := getNote(db, "sync-note")
	if err != nil || n.Revision != 2 {
		t.Fatalf("revision = %#v, %v; want 2", n, err)
	}
	if err := deleteNote(db, "sync-note"); err != nil {
		t.Fatalf("delete note: %v", err)
	}
	var revision int64
	var deleted int
	if err := db.QueryRow("SELECT revision, deleted FROM sync_changes WHERE note_id = ? ORDER BY sequence DESC LIMIT 1", "sync-note").Scan(&revision, &deleted); err != nil {
		t.Fatalf("read tombstone: %v", err)
	}
	if revision != 3 || deleted != 1 {
		t.Fatalf("tombstone = revision %d, deleted %d; want 3, 1", revision, deleted)
	}
	if err := upsertNote(db, "sync-note", "Recreated", "sync-note.md", ""); err != nil {
		t.Fatalf("recreate note: %v", err)
	}
	n, err = getNote(db, "sync-note")
	if err != nil || n.Revision != 4 {
		t.Fatalf("recreated revision = %#v, %v; want 4", n, err)
	}
	changes, err := listSyncChanges(db, 0, 2)
	if err != nil || len(changes.Changes) != 2 || !changes.HasMore || changes.NextSequence != changes.Changes[1].Sequence {
		t.Fatalf("first sync page = %#v, %v", changes, err)
	}
	changes, err = listSyncChanges(db, changes.NextSequence, 2)
	if err != nil || len(changes.Changes) != 2 || changes.HasMore || changes.Changes[0].Deleted != true || changes.Changes[1].Revision != 4 {
		t.Fatalf("second sync page = %#v, %v", changes, err)
	}
}

func TestSyncMigrationSeedsExistingNotes(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at TEXT NOT NULL
	)`); err != nil {
		t.Fatalf("create migration table: %v", err)
	}
	for _, migration := range migrations[:5] {
		tx, err := db.Begin()
		if err != nil {
			t.Fatalf("begin migration %d: %v", migration.version, err)
		}
		if err := migration.up(tx); err != nil {
			tx.Rollback()
			t.Fatalf("apply migration %d: %v", migration.version, err)
		}
		if _, err := tx.Exec("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", migration.version, "2025-01-01T00:00:00Z"); err != nil {
			tx.Rollback()
			t.Fatalf("record migration %d: %v", migration.version, err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatalf("commit migration %d: %v", migration.version, err)
		}
	}
	if _, err := db.Exec(`INSERT INTO notes (id, title, filename, tags, created_at, updated_at)
		VALUES ('existing', 'Existing', 'existing.md', '', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z')`); err != nil {
		t.Fatalf("insert existing note: %v", err)
	}
	if err := initDB(db); err != nil {
		t.Fatalf("upgrade database: %v", err)
	}
	changes, err := listSyncChanges(db, 0, 10)
	if err != nil || len(changes.Changes) != 1 {
		t.Fatalf("seeded changes = %#v, %v", changes, err)
	}
	change := changes.Changes[0]
	if change.NoteID != "existing" || change.Revision != 1 || change.Deleted || change.ChangedAt != "2025-01-02T00:00:00Z" {
		t.Fatalf("seeded change = %#v", change)
	}
}

func TestCheckNoteRevisionDetectsUpdatesAndTombstones(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if err := checkNoteRevision(db, "new", 0); err != nil {
		t.Fatalf("new note revision: %v", err)
	}
	if err := upsertNote(db, "note", "First", "note.md", ""); err != nil {
		t.Fatalf("create note: %v", err)
	}
	if err := checkNoteRevision(db, "note", 1); err != nil {
		t.Fatalf("current revision: %v", err)
	}
	if err := checkNoteRevision(db, "note", 0); !errors.Is(err, errRevisionConflict) {
		t.Fatalf("stale revision error = %v", err)
	}
	if err := deleteNote(db, "note"); err != nil {
		t.Fatalf("delete note: %v", err)
	}
	if err := checkNoteRevision(db, "note", 1); !errors.Is(err, errRevisionConflict) {
		t.Fatalf("deleted revision error = %v", err)
	}
}

func TestSaveRejectsStaleOfflineRevisionBeforeReplacingFile(t *testing.T) {
	notesDir := t.TempDir()
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	a := &app{db: db, notesDir: notesDir, noteCache: newNoteCache()}
	first := httptest.NewRequest(http.MethodPost, "/api/notes", strings.NewReader(`{"id":"offline-note","title":"First","content":"first body","tags":"","base_revision":0}`))
	first.Header.Set("Content-Type", "application/json")
	firstResult := httptest.NewRecorder()
	a.handleSaveNote(firstResult, first)
	if firstResult.Code != http.StatusOK {
		t.Fatalf("first save status = %d: %s", firstResult.Code, firstResult.Body.String())
	}

	stale := httptest.NewRequest(http.MethodPost, "/api/notes", strings.NewReader(`{"id":"offline-note","title":"Stale","content":"stale body","tags":"","base_revision":0}`))
	stale.Header.Set("Content-Type", "application/json")
	staleResult := httptest.NewRecorder()
	a.handleSaveNote(staleResult, stale)
	if staleResult.Code != http.StatusConflict {
		t.Fatalf("stale save status = %d: %s", staleResult.Code, staleResult.Body.String())
	}
	data, err := os.ReadFile(filepath.Join(notesDir, "offline-note.md"))
	if err != nil || string(data) != "first body" {
		t.Fatalf("note file after stale save = %q, %v", data, err)
	}
}

func TestNoteContentReadWaitsForNoteWriteLock(t *testing.T) {
	dir := t.TempDir()
	db, err := openDB(filepath.Join(dir, "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	config, err := newEncryptionConfig(dir, "test password", "")
	if err != nil {
		t.Fatalf("create encryption config: %v", err)
	}
	if err := upsertNote(db, "read-lock-note", "Read lock", "read-lock-note.md", ""); err != nil {
		t.Fatalf("create note: %v", err)
	}
	ciphertext, err := config.encryptNote([]byte("consistent content"), "read-lock-note")
	if err != nil {
		t.Fatalf("encrypt note: %v", err)
	}
	if err := writeNoteFile(filepath.Join(dir, "read-lock-note.md"), ciphertext); err != nil {
		t.Fatalf("write note: %v", err)
	}
	a := &app{db: db, notesDir: dir, encryption: config, noteCache: newNoteCache()}

	a.noteMu.Lock()
	result := make(chan struct {
		data noteWithContent
		err  error
	}, 1)
	go func() {
		data, err := a.loadNoteWithContent("read-lock-note")
		result <- struct {
			data noteWithContent
			err  error
		}{data: data, err: err}
	}()

	select {
	case <-result:
		t.Fatal("note content read passed through the write lock")
	case <-time.After(25 * time.Millisecond):
	}
	a.noteMu.Unlock()

	select {
	case read := <-result:
		if read.err != nil || read.data.Revision != 1 || read.data.Content != "consistent content" {
			t.Fatalf("note read = %#v, %v", read.data, read.err)
		}
	case <-time.After(time.Second):
		t.Fatal("note content read did not complete after releasing the lock")
	}
}

func TestSessionsPersistAcrossStoreRestart(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	first := newSessionStore(db)
	token, err := first.create()
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if !newSessionStore(db).valid(token) {
		t.Fatal("session was not available after recreating the store")
	}
	var storedHash string
	if err := db.QueryRow("SELECT token_hash FROM sessions").Scan(&storedHash); err != nil {
		t.Fatalf("read stored session: %v", err)
	}
	if storedHash == token {
		t.Fatal("session token was stored without hashing")
	}
	first.remove(token)
	if newSessionStore(db).valid(token) {
		t.Fatal("removed session remained valid")
	}
}

func TestEventsStreamSendsAnImmediateHeartbeat(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	a := &app{db: db, sessions: newSessionStore(db)}
	token, err := a.sessions.create()
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest(http.MethodGet, "/api/events", nil).WithContext(ctx)
	r.AddCookie(&http.Cookie{Name: "session", Value: token})
	w := &sseTestRecorder{ResponseRecorder: httptest.NewRecorder()}
	a.auth(a.handleEvents)(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("events status = %d: %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("content type = %q", got)
	}
	if got := w.Header().Get("X-Accel-Buffering"); got != "no" {
		t.Fatalf("X-Accel-Buffering = %q", got)
	}
	if body := w.Body.String(); !strings.Contains(body, "retry: 3000\n\n") || !strings.Contains(body, "event: server\ndata: {") || !strings.Contains(body, `"revision":"`) || !strings.Contains(body, "event: heartbeat\n") {
		t.Fatalf("events body = %q", body)
	}
	if w.flushes == 0 {
		t.Fatal("events stream was not flushed")
	}
}

func TestSyncPushOrdersAndDeduplicatesOperations(t *testing.T) {
	notesDir := t.TempDir()
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	a := &app{db: db, notesDir: notesDir, noteCache: newNoteCache()}
	baseRevision := int64(0)
	first := syncPushRequest{DeviceID: "device_a", Operations: []syncOperationRequest{{
		ClientSequence: 1, OpID: "operation_1", Type: "note.save", NoteID: "replay-note", BaseRevision: &baseRevision, Title: "First", Content: "first body", BaseContent: "before edit",
	}}}
	push := func(request syncPushRequest) *httptest.ResponseRecorder {
		body, err := json.Marshal(request)
		if err != nil {
			t.Fatalf("marshal request: %v", err)
		}
		r := httptest.NewRequest(http.MethodPost, "/api/sync/push", strings.NewReader(string(body)))
		r.Header.Set("Content-Type", "application/json")
		result := httptest.NewRecorder()
		a.handleSyncPush(result, r)
		return result
	}
	decode := func(result *httptest.ResponseRecorder) syncPushResponse {
		var response syncPushResponse
		if err := json.Unmarshal(result.Body.Bytes(), &response); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		return response
	}

	result := push(first)
	if result.Code != http.StatusOK {
		t.Fatalf("first push status = %d: %s", result.Code, result.Body.String())
	}
	response := decode(result)
	if len(response.Acknowledged) != 1 || response.Acknowledged[0].Status != "applied" || response.Acknowledged[0].Revision != 1 || response.ExpectedSequence != 2 {
		t.Fatalf("first response = %#v", response)
	}
	var recordedOperation string
	if err := db.QueryRow("SELECT operation FROM sync_operations WHERE device_id = ? AND client_sequence = 1", "device_a").Scan(&recordedOperation); err != nil || !strings.Contains(recordedOperation, "first body") || !strings.Contains(recordedOperation, "before edit") {
		t.Fatalf("recorded operation = %q, %v", recordedOperation, err)
	}

	result = push(first)
	if result.Code != http.StatusOK {
		t.Fatalf("duplicate push status = %d: %s", result.Code, result.Body.String())
	}
	response = decode(result)
	if len(response.Acknowledged) != 1 || response.Acknowledged[0].Revision != 1 || response.ExpectedSequence != 2 {
		t.Fatalf("duplicate response = %#v", response)
	}
	n, err := getNote(db, "replay-note")
	if err != nil || n.Revision != 1 {
		t.Fatalf("note after duplicate = %#v, %v", n, err)
	}

	gap := first
	gap.Operations[0].ClientSequence = 3
	gap.Operations[0].OpID = "operation_3"
	result = push(gap)
	if result.Code != http.StatusConflict {
		t.Fatalf("gap push status = %d: %s", result.Code, result.Body.String())
	}
	response = decode(result)
	if response.ExpectedSequence != 2 {
		t.Fatalf("gap response = %#v", response)
	}

	staleRevision := int64(0)
	stale := syncPushRequest{DeviceID: "device_a", Operations: []syncOperationRequest{{
		ClientSequence: 2, OpID: "operation_2", Type: "note.save", NoteID: "replay-note", BaseRevision: &staleRevision, Title: "Stale", Content: "stale body",
	}}}
	result = push(stale)
	if result.Code != http.StatusOK {
		t.Fatalf("conflict push status = %d: %s", result.Code, result.Body.String())
	}
	response = decode(result)
	if len(response.Acknowledged) != 1 || response.Acknowledged[0].Status != "conflict" || response.Acknowledged[0].CurrentRevision != 1 || response.ExpectedSequence != 3 {
		t.Fatalf("conflict response = %#v", response)
	}
}

func TestMigrationsAreRecordedAndIdempotent(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("initial migration: %v", err)
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM schema_migrations").Scan(&count); err != nil {
		t.Fatalf("count migrations: %v", err)
	}
	if count != len(migrations) {
		t.Fatalf("migration count = %d, want %d", count, len(migrations))
	}
	if err := initDB(db); err != nil {
		t.Fatalf("repeat migration: %v", err)
	}
	if err := db.QueryRow("SELECT count(*) FROM schema_migrations").Scan(&count); err != nil {
		t.Fatalf("count migrations after repeat: %v", err)
	}
	if count != len(migrations) {
		t.Fatalf("migration count after repeat = %d, want %d", count, len(migrations))
	}
}

func TestInitDBCreatesBackupBeforePendingMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notes.db")
	db, err := openDB(path)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`); err != nil {
		t.Fatalf("create migration table: %v", err)
	}
	for _, migration := range migrations[:len(migrations)-1] {
		tx, err := db.Begin()
		if err != nil {
			t.Fatalf("begin migration %d: %v", migration.version, err)
		}
		if err := migration.up(tx); err != nil {
			t.Fatalf("apply migration %d: %v", migration.version, err)
		}
		if _, err := tx.Exec("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", migration.version, "2026-01-01T00:00:00Z"); err != nil {
			t.Fatalf("record migration %d: %v", migration.version, err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatalf("commit migration %d: %v", migration.version, err)
		}
	}

	if err := initDB(db, path); err != nil {
		t.Fatalf("apply pending migration: %v", err)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatalf("read backup directory: %v", err)
	}
	prefix := filepath.Base(path) + ".pre-migration-v" + strconv.Itoa(migrations[len(migrations)-1].version) + "-"
	var backupPath string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), prefix) && strings.HasSuffix(entry.Name(), ".db") {
			backupPath = filepath.Join(filepath.Dir(path), entry.Name())
			break
		}
	}
	if backupPath == "" {
		t.Fatal("pre-migration backup was not created")
	}
	backup, err := openDB(backupPath)
	if err != nil {
		t.Fatalf("open backup: %v", err)
	}
	defer backup.Close()
	var applied int
	if err := backup.QueryRow("SELECT count(*) FROM schema_migrations WHERE version = ?", migrations[len(migrations)-1].version).Scan(&applied); err != nil {
		t.Fatalf("inspect backup migration state: %v", err)
	}
	if applied != 0 {
		t.Fatal("backup contains the pending migration")
	}
}

func TestPruneMigrationBackupsKeepsThreeNewest(t *testing.T) {
	directory := t.TempDir()
	base := "notes.db"
	for index := 0; index < 4; index++ {
		path := filepath.Join(directory, base+".pre-migration-v9-20260101T00000"+strconv.Itoa(index)+"Z.db")
		if err := os.WriteFile(path, []byte("backup"), 0600); err != nil {
			t.Fatalf("write backup %d: %v", index, err)
		}
		stamp := time.Date(2026, time.January, 1, 0, 0, index, 0, time.UTC)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatalf("set backup timestamp %d: %v", index, err)
		}
	}
	if err := os.WriteFile(filepath.Join(directory, "unrelated.db"), []byte("keep"), 0600); err != nil {
		t.Fatalf("write unrelated file: %v", err)
	}
	if err := pruneMigrationBackups(directory, base); err != nil {
		t.Fatalf("prune backups: %v", err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read backup directory: %v", err)
	}
	backupCount := 0
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), base+".pre-migration-v") {
			backupCount++
		}
	}
	if backupCount != maxMigrationBackups {
		t.Fatalf("backup count = %d, want %d", backupCount, maxMigrationBackups)
	}
	if _, err := os.Stat(filepath.Join(directory, "unrelated.db")); err != nil {
		t.Fatalf("unrelated file was removed: %v", err)
	}
}

func TestListSyncChangesRequestsResetAfterCompaction(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if _, err := db.Exec("INSERT INTO sync_changes (sequence, note_id, revision, deleted, changed_at) VALUES (100, 'old-note', 1, 0, '2026-01-01T00:00:00Z'), (101, 'new-note', 1, 0, '2026-01-01T00:00:01Z')"); err != nil {
		t.Fatalf("seed compacted change feed: %v", err)
	}
	page, err := listSyncChanges(db, 0, 100)
	if err != nil {
		t.Fatalf("list sync changes: %v", err)
	}
	if !page.ResetRequired || page.NextSequence != 101 || len(page.Changes) != 0 {
		t.Fatalf("compacted sync page = %#v", page)
	}
}

func TestCompactSyncOperationPayloadsPreservesAcknowledgements(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	previousLimit := maxSyncOperationPayloadBytes
	maxSyncOperationPayloadBytes = 30
	t.Cleanup(func() { maxSyncOperationPayloadBytes = previousLimit })
	tx, err := db.Begin()
	if err != nil {
		t.Fatalf("begin transaction: %v", err)
	}
	defer tx.Rollback()
	for sequence, payload := range []string{"first-payload-is-large", "second-payload-is-large"} {
		if _, err := tx.Exec("INSERT INTO sync_operations (device_id, client_sequence, op_id, op_type, result, operation, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)", "device", sequence+1, "op"+strconv.Itoa(sequence+1), "noop", `{"status":"applied"}`, payload, "2026-01-01T00:00:00Z"); err != nil {
			t.Fatalf("insert operation %d: %v", sequence, err)
		}
	}
	if err := compactSyncOperationPayloads(tx); err != nil {
		t.Fatalf("compact payloads: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit compacted operations: %v", err)
	}
	var compactedCount, resultCount int
	if err := db.QueryRow("SELECT count(*) FROM sync_operations WHERE operation = ?", compactedOperationPayload).Scan(&compactedCount); err != nil {
		t.Fatalf("count compacted payloads: %v", err)
	}
	if err := db.QueryRow("SELECT count(*) FROM sync_operations WHERE result = ?", `{"status":"applied"}`).Scan(&resultCount); err != nil {
		t.Fatalf("count acknowledgements: %v", err)
	}
	if compactedCount == 0 || resultCount != 2 {
		t.Fatalf("compacted = %d, acknowledgements = %d", compactedCount, resultCount)
	}
}

func TestSyncPushAcknowledgesCompactedReplay(t *testing.T) {
	notesDir := t.TempDir()
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if _, err := db.Exec("INSERT INTO sync_device_state (device_id, last_sequence) VALUES (?, ?)", "device", 5); err != nil {
		t.Fatalf("seed device state: %v", err)
	}
	a := &app{db: db, notesDir: notesDir, noteCache: newNoteCache()}
	body := `{"device_id":"device","operations":[{"client_sequence":1,"op_id":"old-operation","type":"noop"}]}`
	r := httptest.NewRequest(http.MethodPost, "/api/sync/push", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.handleSyncPush(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("compacted replay status = %d: %s", w.Code, w.Body.String())
	}
	var response syncPushResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode compacted replay: %v", err)
	}
	if len(response.Acknowledged) != 1 || response.Acknowledged[0].Status != "compacted" || response.ExpectedSequence != 6 {
		t.Fatalf("compacted replay response = %#v", response)
	}
}

func TestSyncPushReportsPermanentValidationErrors(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	baseRevision := int64(0)
	body, err := json.Marshal(syncPushRequest{
		DeviceID: "device_a",
		Operations: []syncOperationRequest{{
			ClientSequence: 1,
			OpID:           "operation_1",
			Type:           "note.save",
			NoteID:         "note-a",
			BaseRevision:   &baseRevision,
			Title:          strings.Repeat("x", maxTitleBytes+1),
		}},
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/sync/push", strings.NewReader(string(body)))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	(&app{db: db, notesDir: t.TempDir(), noteCache: newNoteCache()}).handleSyncPush(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("validation status = %d: %s", w.Code, w.Body.String())
	}
	var response map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode validation response: %v", err)
	}
	if response["code"] != "invalid_sync_operation" || response["permanent"] != true || response["op_id"] != "operation_1" {
		t.Fatalf("validation response = %#v", response)
	}
}

func TestRecoverFileOperationsCompletesCommittedReplacement(t *testing.T) {
	notesDir := t.TempDir()
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	a := &app{db: db, notesDir: notesDir, noteCache: newNoteCache()}
	stageName, err := stageNoteFile(notesDir, []byte("new body"))
	if err != nil {
		t.Fatalf("stage note: %v", err)
	}
	if _, err := db.Exec("INSERT INTO file_operations (id, action, note_id, stage_name, created_at) VALUES (?, ?, ?, ?, ?)", "replace-op", fileOperationReplace, "note-a", stageName, "2026-01-01T00:00:00Z"); err != nil {
		t.Fatalf("record file operation: %v", err)
	}
	if err := a.recoverFileOperations(); err != nil {
		t.Fatalf("recover file operation: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(notesDir, "note-a.md"))
	if err != nil || string(data) != "new body" {
		t.Fatalf("recovered note = %q, %v", data, err)
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM file_operations").Scan(&count); err != nil || count != 0 {
		t.Fatalf("remaining file operations = %d, %v", count, err)
	}
}

func TestRecoverFileOperationsRejectsOldTargetWhenStageIsMissing(t *testing.T) {
	notesDir := t.TempDir()
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if err := os.WriteFile(filepath.Join(notesDir, "note-a.md"), []byte("old body"), 0600); err != nil {
		t.Fatalf("write old target: %v", err)
	}
	stageName, err := stageNoteFile(notesDir, []byte("new body"))
	if err != nil {
		t.Fatalf("stage replacement: %v", err)
	}
	if _, err := db.Exec("INSERT INTO file_operations (id, action, note_id, stage_name, expected_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)", "replace-op", fileOperationReplace, "note-a", stageName, fileContentHash([]byte("new body")), "2026-01-01T00:00:00Z"); err != nil {
		t.Fatalf("record file operation: %v", err)
	}
	if err := os.Remove(filepath.Join(notesDir, stageName)); err != nil {
		t.Fatalf("remove stage: %v", err)
	}
	a := &app{db: db, notesDir: notesDir, noteCache: newNoteCache()}
	if err := a.recoverFileOperations(); err == nil {
		t.Fatal("recovery accepted an old target for a missing staged replacement")
	}
	data, err := os.ReadFile(filepath.Join(notesDir, "note-a.md"))
	if err != nil || string(data) != "old body" {
		t.Fatalf("target after failed recovery = %q, %v", data, err)
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM file_operations").Scan(&count); err != nil || count != 1 {
		t.Fatalf("remaining file operations = %d, %v; want 1", count, err)
	}
}

func TestRecoverFileOperationsCompletesCommittedDelete(t *testing.T) {
	notesDir := t.TempDir()
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if err := os.WriteFile(filepath.Join(notesDir, "note-a.md"), []byte("old body"), 0600); err != nil {
		t.Fatalf("write note: %v", err)
	}
	a := &app{db: db, notesDir: notesDir, noteCache: newNoteCache()}
	if _, err := db.Exec("INSERT INTO file_operations (id, action, note_id, stage_name, created_at) VALUES (?, ?, ?, ?, ?)", "delete-op", fileOperationDelete, "note-a", "", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatalf("record file operation: %v", err)
	}
	if err := a.recoverFileOperations(); err != nil {
		t.Fatalf("recover file operation: %v", err)
	}
	if _, err := os.Stat(filepath.Join(notesDir, "note-a.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted note remains: %v", err)
	}
}

func TestMetadataSearchTracksNoteUpdatesAndDeletes(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if err := upsertNote(db, "alpha", "Project Aurora", "alpha.md", "work,urgent"); err != nil {
		t.Fatalf("insert alpha: %v", err)
	}
	if err := upsertNote(db, "beta", "Shopping list", "beta.md", "home"); err != nil {
		t.Fatalf("insert beta: %v", err)
	}
	results, err := searchNotes(db, "auro", 50)
	if err != nil || len(results) != 1 || results[0].ID != "alpha" {
		t.Fatalf("title search = %#v, %v", results, err)
	}
	results, err = searchNotes(db, "urgent", 50)
	if err != nil || len(results) != 1 || results[0].ID != "alpha" {
		t.Fatalf("tag search = %#v, %v", results, err)
	}
	if err := deleteNote(db, "alpha"); err != nil {
		t.Fatalf("delete alpha: %v", err)
	}
	results, err = searchNotes(db, "aurora", 50)
	if err != nil || len(results) != 0 {
		t.Fatalf("search after delete = %#v, %v", results, err)
	}
}

func TestListNotesPageUsesStableCursor(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := initDB(db); err != nil {
		t.Fatalf("init db: %v", err)
	}
	for _, id := range []string{"a", "b", "c"} {
		if err := upsertNote(db, id, id, id+".md", ""); err != nil {
			t.Fatalf("insert %s: %v", id, err)
		}
	}
	first, err := listNotesPage(db, "", "", 2)
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if len(first.Notes) != 2 || first.NextCursor == "" {
		t.Fatalf("first page = %#v", first)
	}
	second, err := listNotesPage(db, "", first.NextCursor, 2)
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if len(second.Notes) != 1 || second.NextCursor != "" {
		t.Fatalf("second page = %#v", second)
	}
	if _, _, err := decodeNoteCursor("not-a-cursor"); !errors.Is(err, errInvalidCursor) {
		t.Fatalf("invalid cursor error = %v", err)
	}
}
