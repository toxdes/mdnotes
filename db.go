package main

import (
	"database/sql"
	"encoding/json"
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
	AutoSave           bool `json:"autoSave"`
	HidePreview        bool `json:"hidePreview"`
	HideToolbar        bool `json:"hideToolbar"`
	CollapseDetails    bool `json:"collapseDetails"`
	HideCursorHighlight bool `json:"hideCursorHighlight"`
}

func initDB(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS notes (
			id        TEXT PRIMARY KEY,
			title     TEXT NOT NULL DEFAULT '',
			filename  TEXT NOT NULL UNIQUE,
			tags      TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_notes_tags ON notes(tags);
		CREATE TABLE IF NOT EXISTS prefs (
			id    INTEGER PRIMARY KEY DEFAULT 1,
			data  TEXT NOT NULL DEFAULT '{}'
		);
	`)
	if err != nil {
		return err
	}
	_, err = db.Exec("INSERT OR IGNORE INTO prefs (id, data) VALUES (1, '{\"autoSave\":true}')")
	return err
}

func getPrefs(db *sql.DB) *prefs {
	var data string
	err := db.QueryRow("SELECT data FROM prefs WHERE id = 1").Scan(&data)
	if err != nil {
		return &prefs{AutoSave: true}
	}
	p := &prefs{AutoSave: true}
	json.Unmarshal([]byte(data), p)
	return p
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
		rows, err = db.Query(
			"SELECT id, title, filename, tags, created_at, updated_at FROM notes WHERE instr(','||tags||',', ?) > 0 ORDER BY updated_at DESC",
			","+tag+",",
		)
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
	_, err := db.Exec(`
		INSERT INTO notes (id, title, filename, tags, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			title=excluded.title,
			filename=excluded.filename,
			tags=excluded.tags,
			updated_at=excluded.updated_at
	`, id, title, filename, tags, now, now)
	return err
}

func deleteNote(db *sql.DB, id string) error {
	_, err := db.Exec("DELETE FROM notes WHERE id = ?", id)
	return err
}

func listTags(db *sql.DB) ([]string, error) {
	rows, err := db.Query("SELECT DISTINCT tags FROM notes WHERE tags != ''")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tagSet := make(map[string]bool)
	for rows.Next() {
		var tags string
		if err := rows.Scan(&tags); err != nil {
			return nil, err
		}
		for _, t := range parseTags(tags) {
			tagSet[t] = true
		}
	}
	var result []string
	for t := range tagSet {
		result = append(result, t)
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
