package main

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type note struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Filename  string `json:"filename"`
	Tags      string `json:"tags"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	Revision  int64  `json:"revision"`
}

type notesPage struct {
	Notes      []note `json:"notes"`
	NextCursor string `json:"nextCursor,omitempty"`
}

type syncChange struct {
	Sequence  int64  `json:"sequence"`
	NoteID    string `json:"note_id"`
	Revision  int64  `json:"revision"`
	Deleted   bool   `json:"deleted"`
	ChangedAt string `json:"changed_at"`
}

type syncChangesPage struct {
	Changes       []syncChange `json:"changes"`
	NextSequence  int64        `json:"nextSequence"`
	HasMore       bool         `json:"hasMore"`
	ResetRequired bool         `json:"resetRequired,omitempty"`
}

var errInvalidCursor = errors.New("invalid cursor")

const maxMigrationBackups = 3
const maxSyncChanges = 100000

func openDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path+"?_journal_mode=WAL&_busy_timeout=5000&_synchronous=NORMAL&_cache_size=-8000")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	return db, nil
}

type prefs struct {
	Revision               int64                      `json:"revision,omitempty"`
	AutoSave               bool                       `json:"autoSave"`
	HidePreview            bool                       `json:"hidePreview"`
	HideHeaderOnFullscreen bool                       `json:"hideHeaderOnFullscreen"`
	HideToolbar            bool                       `json:"hideToolbar"`
	HideSaveButton         bool                       `json:"hideSaveButton"`
	CollapseDetails        bool                       `json:"collapseDetails"`
	HideCursorHighlight    bool                       `json:"hideCursorHighlight"`
	StatusDisplay          string                     `json:"statusDisplay,omitempty"`
	Theme                  string                     `json:"theme,omitempty"`
	AccentColor            string                     `json:"accentColor,omitempty"`
	FontFamily             string                     `json:"fontFamily,omitempty"`
	EditorFontFamily       string                     `json:"editorFontFamily,omitempty"`
	PreviewFontFamily      string                     `json:"previewFontFamily,omitempty"`
	SyncPatch              map[string]json.RawMessage `json:"_sync_patch,omitempty"`
	SyncBase               map[string]json.RawMessage `json:"_sync_base,omitempty"`
}

type migration struct {
	version int
	up      func(*sql.Tx) error
}

var migrations = []migration{
	{version: 1, up: migrateInitialSchema},
	{version: 2, up: migrateTagIndex},
	{version: 3, up: migrateRateLimitSchema},
	{version: 4, up: migrateRemoveUnusedTagIndex},
	{version: 5, up: migrateMetadataSearch},
	{version: 6, up: migrateSyncSchema},
	{version: 7, up: migrateSessionSchema},
	{version: 8, up: migrateSyncOperationsSchema},
	{version: 9, up: migrateSyncOperationPayloadSchema},
	{version: 10, up: migrateFileOperationSchema},
	{version: 11, up: migrateClearLegacyIPBans},
	{version: 12, up: migrateFileOperationHashSchema},
	{version: 13, up: migrateFileOperationRecoverySchema},
	{version: 14, up: migrateSyncOperationCompactionSchema},
	{version: 15, up: migratePreferenceRevisionSchema},
	{version: 16, up: migrateRepairSyncOperationStats},
}

func initDB(db *sql.DB, databasePaths ...string) error {
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL
		)`); err != nil {
		return err
	}
	pending, err := pendingMigrations(db)
	if err != nil {
		return err
	}
	if len(pending) == 0 {
		return nil
	}
	if len(databasePaths) > 0 {
		backupPath, err := backupBeforeMigration(db, databasePaths[0], pending[0].version)
		if err != nil {
			return fmt.Errorf("backup before migration %d: %w", pending[0].version, err)
		}
		if backupPath != "" {
			log.Printf("created pre-migration database backup: %s", backupPath)
		}
	}
	for _, migration := range pending {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if err := migration.up(tx); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", migration.version, err)
		}
		if _, err := tx.Exec("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", migration.version, time.Now().UTC().Format(time.RFC3339)); err != nil {
			tx.Rollback()
			return fmt.Errorf("record migration %d: %w", migration.version, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %d: %w", migration.version, err)
		}
	}
	return nil
}

func pendingMigrations(db *sql.DB) ([]migration, error) {
	pending := make([]migration, 0)
	for _, migration := range migrations {
		var version int
		err := db.QueryRow("SELECT version FROM schema_migrations WHERE version = ?", migration.version).Scan(&version)
		if err == nil {
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		pending = append(pending, migration)
	}
	return pending, nil
}

func backupBeforeMigration(db *sql.DB, databasePath string, version int) (string, error) {
	if databasePath == "" || databasePath == ":memory:" {
		return "", nil
	}
	var userTableCount int
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT IN ('schema_migrations', 'sqlite_sequence')`).Scan(&userTableCount); err != nil {
		return "", err
	}
	if userTableCount == 0 {
		return "", nil
	}

	directory := filepath.Dir(databasePath)
	base := filepath.Base(databasePath)
	backupPath := filepath.Join(directory, fmt.Sprintf("%s.pre-migration-v%d-%s.db", base, version, time.Now().UTC().Format("20060102T150405.000000000Z")))
	info, err := os.Stat(databasePath)
	if err != nil {
		return "", err
	}
	if _, err := db.Exec("VACUUM INTO ?", backupPath); err != nil {
		return "", fmt.Errorf("create consistent backup (requires roughly %d additional bytes of disk space): %w", info.Size(), err)
	}
	if err := os.Chmod(backupPath, 0600); err != nil {
		return "", err
	}
	if err := pruneMigrationBackups(directory, base); err != nil {
		return "", err
	}
	return backupPath, nil
}

func pruneMigrationBackups(directory, base string) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	prefix := base + ".pre-migration-v"
	type backupFile struct {
		name    string
		modTime time.Time
	}
	backups := make([]backupFile, 0)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), prefix) || !strings.HasSuffix(entry.Name(), ".db") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		backups = append(backups, backupFile{name: entry.Name(), modTime: info.ModTime()})
	}
	sort.Slice(backups, func(i, j int) bool {
		if backups[i].modTime.Equal(backups[j].modTime) {
			return backups[i].name > backups[j].name
		}
		return backups[i].modTime.After(backups[j].modTime)
	})
	if len(backups) > maxMigrationBackups {
		for _, backup := range backups[maxMigrationBackups:] {
			if err := os.Remove(filepath.Join(directory, backup.name)); err != nil {
				return err
			}
		}
	}
	return nil
}

func migrateInitialSchema(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE IF NOT EXISTS notes (
			id        TEXT PRIMARY KEY,
			title     TEXT NOT NULL DEFAULT '',
			filename  TEXT NOT NULL UNIQUE,
			tags      TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS prefs (
			id    INTEGER PRIMARY KEY DEFAULT 1,
			data  TEXT NOT NULL DEFAULT '{}'
		);
		INSERT OR IGNORE INTO prefs (id, data) VALUES (1, '{"autoSave":true}');
	`)
	return err
}

func migrateTagIndex(tx *sql.Tx) error {
	if _, err := tx.Exec(`
		CREATE TABLE IF NOT EXISTS note_tags (
			note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
			tag     TEXT NOT NULL,
			PRIMARY KEY (note_id, tag)
		);
		CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag, note_id);`); err != nil {
		return err
	}
	rows, err := tx.Query(`
		SELECT n.id, n.tags
		FROM notes n
		WHERE n.tags != ''
		  AND NOT EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id)`)
	if err != nil {
		return err
	}
	var records []struct{ id, tags string }
	for rows.Next() {
		var record struct{ id, tags string }
		if err := rows.Scan(&record.id, &record.tags); err != nil {
			rows.Close()
			return err
		}
		records = append(records, record)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, record := range records {
		for _, tag := range parseTags(record.tags) {
			if _, err := tx.Exec("INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)", record.id, tag); err != nil {
				return err
			}
		}
	}
	return nil
}

func migrateRateLimitSchema(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE IF NOT EXISTS ip_bans (
			ip        TEXT PRIMARY KEY,
			reason    TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS rate_limits (
			ip        TEXT NOT NULL,
			typ       TEXT NOT NULL,
			count     INTEGER NOT NULL DEFAULT 1,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (ip, typ)
		);`)
	return err
}

// Earlier releases made both failed-login and missing-asset bans permanent.
// A stale service-worker request could therefore lock a legitimate user out.
// Rate limiting is now in-memory and temporary, so clear the legacy state.
func migrateClearLegacyIPBans(tx *sql.Tx) error {
	_, err := tx.Exec("DELETE FROM ip_bans; DELETE FROM rate_limits")
	return err
}

func migrateRemoveUnusedTagIndex(tx *sql.Tx) error {
	_, err := tx.Exec("DROP INDEX IF EXISTS idx_notes_tags")
	return err
}

func migrateMetadataSearch(tx *sql.Tx) error {
	if _, err := tx.Exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS note_metadata_fts USING fts5(
			note_id UNINDEXED,
			title,
			tags
		);`); err != nil {
		return err
	}
	rows, err := tx.Query("SELECT id, title, tags FROM notes")
	if err != nil {
		return err
	}
	type searchRecord struct{ id, title, tags string }
	var records []searchRecord
	for rows.Next() {
		var record searchRecord
		if err := rows.Scan(&record.id, &record.title, &record.tags); err != nil {
			rows.Close()
			return err
		}
		records = append(records, record)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, record := range records {
		if _, err := tx.Exec("INSERT INTO note_metadata_fts (note_id, title, tags) VALUES (?, ?, ?)", record.id, record.title, record.tags); err != nil {
			return err
		}
	}
	return nil
}

func migrateSyncSchema(tx *sql.Tx) error {
	if _, err := tx.Exec(`ALTER TABLE notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`); err != nil {
		return err
	}
	if _, err := tx.Exec(`
		CREATE TABLE sync_changes (
			sequence   INTEGER PRIMARY KEY AUTOINCREMENT,
			note_id    TEXT NOT NULL,
			revision   INTEGER NOT NULL,
			deleted    INTEGER NOT NULL DEFAULT 0,
			changed_at TEXT NOT NULL
		);
		CREATE INDEX idx_sync_changes_sequence ON sync_changes(sequence);
		INSERT INTO sync_changes (note_id, revision, deleted, changed_at)
		SELECT id, revision, 0, updated_at FROM notes;`); err != nil {
		return err
	}
	return nil
}

func migrateSessionSchema(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE sessions (
			token_hash TEXT PRIMARY KEY,
			expires_at TEXT NOT NULL
		);
		CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);`)
	return err
}

func migrateSyncOperationsSchema(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE sync_device_state (
			device_id     TEXT PRIMARY KEY,
			last_sequence INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE sync_operations (
			device_id      TEXT NOT NULL,
			client_sequence INTEGER NOT NULL,
			op_id          TEXT NOT NULL,
			op_type        TEXT NOT NULL,
			result         TEXT NOT NULL,
			applied_at     TEXT NOT NULL,
			PRIMARY KEY (device_id, client_sequence),
			UNIQUE (device_id, op_id)
		);`)
	return err
}

func migrateSyncOperationPayloadSchema(tx *sql.Tx) error {
	_, err := tx.Exec("ALTER TABLE sync_operations ADD COLUMN operation TEXT NOT NULL DEFAULT '{}'")
	return err
}

func migrateFileOperationSchema(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE file_operations (
			id         TEXT PRIMARY KEY,
			action     TEXT NOT NULL,
			note_id    TEXT NOT NULL,
			stage_name TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL
		);
		CREATE INDEX idx_file_operations_created_at ON file_operations(created_at);`)
	return err
}

func migrateFileOperationHashSchema(tx *sql.Tx) error {
	_, err := tx.Exec("ALTER TABLE file_operations ADD COLUMN expected_hash TEXT NOT NULL DEFAULT ''")
	return err
}

func migrateFileOperationRecoverySchema(tx *sql.Tx) error {
	_, err := tx.Exec(`
		ALTER TABLE file_operations ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
		ALTER TABLE file_operations ADD COLUMN last_error TEXT NOT NULL DEFAULT '';
		ALTER TABLE file_operations ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0;`)
	return err
}

func migrateSyncOperationCompactionSchema(tx *sql.Tx) error {
	_, err := tx.Exec(`
		CREATE TABLE sync_operation_stats (
			id              INTEGER PRIMARY KEY CHECK (id = 1),
			operation_count INTEGER NOT NULL DEFAULT 0,
			payload_bytes   INTEGER NOT NULL DEFAULT 0
		);
		INSERT INTO sync_operation_stats (id, operation_count, payload_bytes)
		SELECT 1, COUNT(*), COALESCE(SUM(length(operation)), 0) FROM sync_operations;
		CREATE INDEX idx_sync_operations_applied_at ON sync_operations(applied_at, device_id, client_sequence);`)
	return err
}

func migratePreferenceRevisionSchema(tx *sql.Tx) error {
	_, err := tx.Exec(`ALTER TABLE prefs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`)
	return err
}

func migrateRepairSyncOperationStats(tx *sql.Tx) error {
	_, err := tx.Exec(`UPDATE sync_operation_stats
		SET operation_count = (SELECT COUNT(*) FROM sync_operations),
		    payload_bytes = (SELECT COALESCE(SUM(length(operation)), 0) FROM sync_operations)
		WHERE id = 1`)
	return err
}

func getPrefs(db *sql.DB) (*prefs, error) {
	dbTx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer dbTx.Rollback()
	p, err := getPrefsTx(dbTx)
	if err != nil {
		return nil, err
	}
	return p, nil
}

func getPrefsTx(tx *sql.Tx) (*prefs, error) {
	var data string
	var revision int64
	if err := tx.QueryRow("SELECT data, revision FROM prefs WHERE id = 1").Scan(&data, &revision); err != nil {
		return nil, err
	}
	p := &prefs{AutoSave: true, Revision: revision}
	if err := json.Unmarshal([]byte(data), p); err != nil {
		return nil, fmt.Errorf("decode preferences: %w", err)
	}
	p.Revision = revision
	p.SyncPatch = nil
	p.SyncBase = nil
	return p, nil
}

func savePrefsTx(tx *sql.Tx, p *prefs, expectedRevision *int64) error {
	current, err := getPrefsTx(tx)
	if err != nil {
		return err
	}
	if expectedRevision != nil && *expectedRevision != current.Revision {
		return errRevisionConflict
	}
	stored := *p
	stored.Revision = 0
	stored.SyncPatch = nil
	stored.SyncBase = nil
	b, err := json.Marshal(&stored)
	if err != nil {
		return err
	}
	nextRevision := current.Revision + 1
	if _, err := tx.Exec("UPDATE prefs SET data = ?, revision = ? WHERE id = 1", string(b), nextRevision); err != nil {
		return err
	}
	p.Revision = nextRevision
	return nil
}

func savePrefs(db *sql.DB, p *prefs, expectedRevision *int64) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := savePrefsTx(tx, p, expectedRevision); err != nil {
		return err
	}
	return tx.Commit()
}

func listNotes(db *sql.DB, tag string) ([]note, error) {
	var rows *sql.Rows
	var err error
	if tag != "" {
		rows, err = db.Query(`
			SELECT n.id, n.title, n.filename, n.tags, n.created_at, n.updated_at, n.revision
			FROM notes n
			JOIN note_tags nt ON nt.note_id = n.id
			WHERE nt.tag = ?
			ORDER BY n.updated_at DESC`, tag)
	} else {
		rows, err = db.Query("SELECT id, title, filename, tags, created_at, updated_at, revision FROM notes ORDER BY updated_at DESC")
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	notes := make([]note, 0)
	for rows.Next() {
		var n note
		if err := rows.Scan(&n.ID, &n.Title, &n.Filename, &n.Tags, &n.CreatedAt, &n.UpdatedAt, &n.Revision); err != nil {
			return nil, err
		}
		notes = append(notes, n)
	}
	return notes, rows.Err()
}

func encodeNoteCursor(n note) string {
	return base64.RawURLEncoding.EncodeToString([]byte(n.UpdatedAt + "\x00" + n.ID))
}

func decodeNoteCursor(cursor string) (updatedAt, id string, err error) {
	data, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return "", "", errInvalidCursor
	}
	updatedAt, id, ok := strings.Cut(string(data), "\x00")
	if !ok || updatedAt == "" || id == "" {
		return "", "", errInvalidCursor
	}
	return updatedAt, id, nil
}

func listNotesPage(db *sql.DB, tag, cursor string, limit int) (notesPage, error) {
	if limit < 1 || limit > 100 {
		return notesPage{}, fmt.Errorf("invalid page limit")
	}

	var updatedAt, id string
	var err error
	if cursor != "" {
		updatedAt, id, err = decodeNoteCursor(cursor)
		if err != nil {
			return notesPage{}, err
		}
	}

	query := "SELECT n.id, n.title, n.filename, n.tags, n.created_at, n.updated_at, n.revision FROM notes n"
	args := make([]any, 0, 4)
	where := make([]string, 0, 2)
	if tag != "" {
		query += " JOIN note_tags nt ON nt.note_id = n.id"
		where = append(where, "nt.tag = ?")
		args = append(args, tag)
	}
	if cursor != "" {
		where = append(where, "(n.updated_at < ? OR (n.updated_at = ? AND n.id < ?))")
		args = append(args, updatedAt, updatedAt, id)
	}
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY n.updated_at DESC, n.id DESC LIMIT ?"
	args = append(args, limit+1)

	rows, err := db.Query(query, args...)
	if err != nil {
		return notesPage{}, err
	}
	defer rows.Close()

	page := notesPage{Notes: make([]note, 0, limit)}
	for rows.Next() {
		var n note
		if err := rows.Scan(&n.ID, &n.Title, &n.Filename, &n.Tags, &n.CreatedAt, &n.UpdatedAt, &n.Revision); err != nil {
			return notesPage{}, err
		}
		page.Notes = append(page.Notes, n)
	}
	if err := rows.Err(); err != nil {
		return notesPage{}, err
	}
	if len(page.Notes) > limit {
		page.Notes = page.Notes[:limit]
		page.NextCursor = encodeNoteCursor(page.Notes[len(page.Notes)-1])
	}
	return page, nil
}

func searchNotes(db *sql.DB, query string, limit int) ([]note, error) {
	if limit < 1 || limit > 100 {
		return nil, fmt.Errorf("invalid search limit")
	}
	match := metadataSearchQuery(query)
	if match == "" {
		return []note{}, nil
	}
	rows, err := db.Query(`
		SELECT n.id, n.title, n.filename, n.tags, n.created_at, n.updated_at, n.revision
		FROM note_metadata_fts
		JOIN notes n ON n.id = note_metadata_fts.note_id
		WHERE note_metadata_fts MATCH ?
		ORDER BY bm25(note_metadata_fts), n.updated_at DESC
		LIMIT ?`, match, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var notes []note
	for rows.Next() {
		var n note
		if err := rows.Scan(&n.ID, &n.Title, &n.Filename, &n.Tags, &n.CreatedAt, &n.UpdatedAt, &n.Revision); err != nil {
			return nil, err
		}
		notes = append(notes, n)
	}
	return notes, rows.Err()
}

func listSyncChanges(db *sql.DB, since int64, limit int) (syncChangesPage, error) {
	var oldest, newest sql.NullInt64
	if err := db.QueryRow("SELECT MIN(sequence), MAX(sequence) FROM sync_changes").Scan(&oldest, &newest); err != nil {
		return syncChangesPage{}, err
	}
	if oldest.Valid && since < oldest.Int64-1 {
		return syncChangesPage{Changes: []syncChange{}, NextSequence: newest.Int64, ResetRequired: true}, nil
	}
	rows, err := db.Query(`
		SELECT sequence, note_id, revision, deleted, changed_at
		FROM sync_changes
		WHERE sequence > ?
		ORDER BY sequence
		LIMIT ?`, since, limit+1)
	if err != nil {
		return syncChangesPage{}, err
	}
	defer rows.Close()

	page := syncChangesPage{Changes: make([]syncChange, 0, limit), NextSequence: since}
	for rows.Next() {
		var change syncChange
		var deleted int
		if err := rows.Scan(&change.Sequence, &change.NoteID, &change.Revision, &deleted, &change.ChangedAt); err != nil {
			return syncChangesPage{}, err
		}
		if len(page.Changes) == limit {
			page.HasMore = true
			break
		}
		change.Deleted = deleted != 0
		page.Changes = append(page.Changes, change)
		page.NextSequence = change.Sequence
	}
	if err := rows.Err(); err != nil {
		return syncChangesPage{}, err
	}
	return page, nil
}

func metadataSearchQuery(raw string) string {
	words := strings.Fields(raw)
	if len(words) > 8 {
		words = words[:8]
	}
	quoted := make([]string, 0, len(words))
	for _, word := range words {
		word = strings.ReplaceAll(word, `"`, `""`)
		if word != "" {
			quoted = append(quoted, `"`+word+`"`+"*")
		}
	}
	return strings.Join(quoted, " AND ")
}

func getNote(db *sql.DB, id string) (*note, error) {
	var n note
	err := db.QueryRow(
		"SELECT id, title, filename, tags, created_at, updated_at, revision FROM notes WHERE id = ?", id,
	).Scan(&n.ID, &n.Title, &n.Filename, &n.Tags, &n.CreatedAt, &n.UpdatedAt, &n.Revision)
	if err != nil {
		return nil, err
	}
	return &n, nil
}

func upsertNote(db *sql.DB, id, title, filename, tags string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := upsertNoteTx(tx, id, title, filename, tags, now); err != nil {
		return err
	}
	return tx.Commit()
}

func upsertNoteTx(tx *sql.Tx, id, title, filename, tags, now string) error {
	_, err := tx.Exec(`
		INSERT INTO notes (id, title, filename, tags, created_at, updated_at, revision)
		VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(revision) + 1 FROM sync_changes WHERE note_id = ?), 1))
		ON CONFLICT(id) DO UPDATE SET
			title=excluded.title,
			filename=excluded.filename,
			tags=excluded.tags,
			updated_at=excluded.updated_at,
			revision=notes.revision + 1
	`, id, title, filename, tags, now, now, id)
	if err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM note_metadata_fts WHERE note_id = ?", id); err != nil {
		return err
	}
	if _, err := tx.Exec("INSERT INTO note_metadata_fts (note_id, title, tags) VALUES (?, ?, ?)", id, title, tags); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM note_tags WHERE note_id = ?", id); err != nil {
		return err
	}
	for _, tag := range parseTags(tags) {
		if _, err := tx.Exec("INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)", id, tag); err != nil {
			return err
		}
	}
	var revision int64
	if err := tx.QueryRow("SELECT revision FROM notes WHERE id = ?", id).Scan(&revision); err != nil {
		return err
	}
	if _, err := tx.Exec("INSERT INTO sync_changes (note_id, revision, deleted, changed_at) VALUES (?, ?, 0, ?)", id, revision, now); err != nil {
		return err
	}
	return compactSyncChangesTx(tx)
}

func deleteNote(db *sql.DB, id string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := deleteNoteTx(tx, id, time.Now().UTC().Format(time.RFC3339)); err != nil {
		return err
	}
	return tx.Commit()
}

func deleteNoteTx(tx *sql.Tx, id, now string) error {
	var revision int64
	if err := tx.QueryRow("SELECT revision FROM notes WHERE id = ?", id).Scan(&revision); err != nil {
		return err
	}
	if _, err := tx.Exec("INSERT INTO sync_changes (note_id, revision, deleted, changed_at) VALUES (?, ?, 1, ?)", id, revision+1, now); err != nil {
		return err
	}
	if err := compactSyncChangesTx(tx); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM note_metadata_fts WHERE note_id = ?", id); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM notes WHERE id = ?", id); err != nil {
		return err
	}
	return nil
}

func compactSyncChangesTx(tx *sql.Tx) error {
	var newest sql.NullInt64
	if err := tx.QueryRow("SELECT MAX(sequence) FROM sync_changes").Scan(&newest); err != nil {
		return err
	}
	if !newest.Valid || newest.Int64 <= maxSyncChanges {
		return nil
	}
	_, err := tx.Exec("DELETE FROM sync_changes WHERE sequence <= ?", newest.Int64-maxSyncChanges)
	return err
}

func listTags(db *sql.DB) ([]string, error) {
	rows, err := db.Query("SELECT DISTINCT tag FROM note_tags ORDER BY tag COLLATE NOCASE")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []string
	for rows.Next() {
		var tag string
		if err := rows.Scan(&tag); err != nil {
			return nil, err
		}
		result = append(result, tag)
	}
	return result, rows.Err()
}

func parseTags(s string) []string {
	if s == "" {
		return nil
	}
	var tags []string
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			tag := s[start:i]
			if tag != "" {
				tags = append(tags, tag)
			}
			start = i + 1
		}
	}
	return tags
}
