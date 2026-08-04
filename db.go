package main

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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
}

type notesPage struct {
	Notes      []note `json:"notes"`
	NextCursor string `json:"nextCursor,omitempty"`
}

var errInvalidCursor = errors.New("invalid cursor")

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
	AutoSave            bool `json:"autoSave"`
	HidePreview         bool `json:"hidePreview"`
	HideToolbar         bool `json:"hideToolbar"`
	CollapseDetails     bool `json:"collapseDetails"`
	HideCursorHighlight bool `json:"hideCursorHighlight"`
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
}

func initDB(db *sql.DB) error {
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL
		)`); err != nil {
		return err
	}
	for _, migration := range migrations {
		var version int
		err := db.QueryRow("SELECT version FROM schema_migrations WHERE version = ?", migration.version).Scan(&version)
		if err == nil {
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
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

func getPrefs(db *sql.DB) (*prefs, error) {
	var data string
	err := db.QueryRow("SELECT data FROM prefs WHERE id = 1").Scan(&data)
	if err != nil {
		return nil, err
	}
	p := &prefs{AutoSave: true}
	if err := json.Unmarshal([]byte(data), p); err != nil {
		return nil, fmt.Errorf("decode preferences: %w", err)
	}
	return p, nil
}

func savePrefs(db *sql.DB, p *prefs) error {
	b, err := json.Marshal(p)
	if err != nil {
		return err
	}
	_, err = db.Exec("UPDATE prefs SET data = ? WHERE id = 1", string(b))
	return err
}

func listNotes(db *sql.DB, tag string) ([]note, error) {
	var rows *sql.Rows
	var err error
	if tag != "" {
		rows, err = db.Query(`
			SELECT n.id, n.title, n.filename, n.tags, n.created_at, n.updated_at
			FROM notes n
			JOIN note_tags nt ON nt.note_id = n.id
			WHERE nt.tag = ?
			ORDER BY n.updated_at DESC`, tag)
	} else {
		rows, err = db.Query("SELECT id, title, filename, tags, created_at, updated_at FROM notes ORDER BY updated_at DESC")
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var notes []note
	for rows.Next() {
		var n note
		if err := rows.Scan(&n.ID, &n.Title, &n.Filename, &n.Tags, &n.CreatedAt, &n.UpdatedAt); err != nil {
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

	query := "SELECT n.id, n.title, n.filename, n.tags, n.created_at, n.updated_at FROM notes n"
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
		if err := rows.Scan(&n.ID, &n.Title, &n.Filename, &n.Tags, &n.CreatedAt, &n.UpdatedAt); err != nil {
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
		SELECT n.id, n.title, n.filename, n.tags, n.created_at, n.updated_at
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
		if err := rows.Scan(&n.ID, &n.Title, &n.Filename, &n.Tags, &n.CreatedAt, &n.UpdatedAt); err != nil {
			return nil, err
		}
		notes = append(notes, n)
	}
	return notes, rows.Err()
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
		"SELECT id, title, filename, tags, created_at, updated_at FROM notes WHERE id = ?", id,
	).Scan(&n.ID, &n.Title, &n.Filename, &n.Tags, &n.CreatedAt, &n.UpdatedAt)
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
	_, err = tx.Exec(`
		INSERT INTO notes (id, title, filename, tags, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			title=excluded.title,
			filename=excluded.filename,
			tags=excluded.tags,
			updated_at=excluded.updated_at
	`, id, title, filename, tags, now, now)
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
	return tx.Commit()
}

func deleteNote(db *sql.DB, id string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM note_metadata_fts WHERE note_id = ?", id); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM notes WHERE id = ?", id); err != nil {
		return err
	}
	return tx.Commit()
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
