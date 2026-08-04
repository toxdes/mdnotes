package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

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
