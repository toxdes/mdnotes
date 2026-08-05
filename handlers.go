package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const maxNoteRequestBytes = 4 << 20 // 4 MiB

const (
	maxTitleBytes = 512
	maxTagsBytes  = 4 << 10
)

var noteIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
var errRevisionConflict = errors.New("note revision conflict")

func randID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func sanitizePath(base, path string) (string, error) {
	abs, err := filepath.Abs(filepath.Join(base, path))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(base, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", http.ErrMissingFile
	}
	return abs, nil
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(value)
}

func writeJSONStatus(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, value any, maxBytes int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return false
	}
	return true
}

func writeNoteFile(path string, content []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".mdnotes-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func normalizeTags(raw string) string {
	parts := strings.Split(raw, ",")
	cleaned := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, part := range parts {
		tag := strings.TrimSpace(part)
		if tag == "" {
			continue
		}
		if _, ok := seen[tag]; ok {
			continue
		}
		seen[tag] = struct{}{}
		cleaned = append(cleaned, tag)
	}
	return strings.Join(cleaned, ",")
}

func (a *app) handleListNotes(w http.ResponseWriter, r *http.Request) {
	tag := r.URL.Query().Get("tag")
	limitParam := r.URL.Query().Get("limit")
	if limitParam != "" {
		limit, err := strconv.Atoi(limitParam)
		if err != nil || limit < 1 || limit > 100 {
			http.Error(w, "invalid page limit", http.StatusBadRequest)
			return
		}
		page, err := listNotesPage(a.db, tag, r.URL.Query().Get("cursor"), limit)
		if err != nil {
			if errors.Is(err, errInvalidCursor) {
				http.Error(w, "invalid cursor", http.StatusBadRequest)
				return
			}
			http.Error(w, "could not list notes", http.StatusInternalServerError)
			return
		}
		writeJSON(w, page)
		return
	}
	notes, err := listNotes(a.db, tag)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, notes)
}

func (a *app) handleSearchNotes(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) > 256 {
		http.Error(w, "search query is too long", http.StatusBadRequest)
		return
	}
	notes, err := searchNotes(a.db, query, 50)
	if err != nil {
		http.Error(w, "could not search notes", http.StatusInternalServerError)
		return
	}
	writeJSON(w, notes)
}

func (a *app) handleSyncChanges(w http.ResponseWriter, r *http.Request) {
	since := int64(0)
	if raw := r.URL.Query().Get("since"); raw != "" {
		var err error
		since, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || since < 0 {
			http.Error(w, "invalid sync sequence", http.StatusBadRequest)
			return
		}
	}
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		var err error
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 500 {
			http.Error(w, "invalid page limit", http.StatusBadRequest)
			return
		}
	}
	page, err := listSyncChanges(a.db, since, limit)
	if err != nil {
		http.Error(w, "could not list sync changes", http.StatusInternalServerError)
		return
	}
	writeJSON(w, page)
}

func (a *app) handleGetNote(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	n, err := getNote(a.db, id)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "could not load note", http.StatusInternalServerError)
			return
		}
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if cached, ok := a.noteCache.get(id); ok {
		resp := struct {
			note
			Content string `json:"content"`
		}{
			note:    *n,
			Content: cached,
		}
		writeJSON(w, resp)
		return
	}
	path, err := sanitizePath(a.notesDir, n.Filename)
	if err != nil {
		http.Error(w, "invalid path", http.StatusInternalServerError)
		return
	}
	enc, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "file not found", http.StatusNotFound)
		return
	}
	plain, err := a.encryption.decryptNote(enc, id)
	if err != nil {
		http.Error(w, "decryption failed", http.StatusInternalServerError)
		return
	}
	content := string(plain)
	a.noteCache.set(id, content)
	resp := struct {
		note
		Content string `json:"content"`
	}{
		note:    *n,
		Content: content,
	}
	writeJSON(w, resp)
}

type saveRequest struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Content      string `json:"content"`
	Tags         string `json:"tags"`
	BaseRevision *int64 `json:"base_revision,omitempty"`
}

func checkNoteRevision(db *sql.DB, id string, expected int64) error {
	n, err := getNote(db, id)
	if err == nil {
		if n.Revision != expected {
			return errRevisionConflict
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var latest int64
	if err := db.QueryRow("SELECT COALESCE(MAX(revision), 0) FROM sync_changes WHERE note_id = ?", id).Scan(&latest); err != nil {
		return err
	}
	if expected != 0 || latest != 0 {
		return errRevisionConflict
	}
	return nil
}

func (a *app) handleSaveNote(w http.ResponseWriter, r *http.Request) {
	var req saveRequest
	if !decodeJSON(w, r, &req, maxNoteRequestBytes) {
		return
	}
	if len(req.Title) > maxTitleBytes || len(req.Tags) > maxTagsBytes {
		http.Error(w, "title or tags are too long", http.StatusBadRequest)
		return
	}

	id := req.ID
	if id == "" {
		var err error
		id, err = randID()
		if err != nil {
			http.Error(w, "could not create note", http.StatusInternalServerError)
			return
		}
	} else if !noteIDPattern.MatchString(id) {
		http.Error(w, "invalid note id", http.StatusBadRequest)
		return
	}

	tags := normalizeTags(req.Tags)

	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	if err := a.recoverFileOperations(); err != nil {
		http.Error(w, "could not recover pending file operations", http.StatusInternalServerError)
		return
	}
	n, err := a.saveNoteWithFileOperation(id, req.Title, tags, req.Content, req.BaseRevision)
	if errors.Is(err, errRevisionConflict) {
		http.Error(w, "note changed on another device", http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	a.publishChange()
	writeJSON(w, n)
}

func (a *app) handleDeleteNote(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var expectedRevision *int64
	if raw := r.URL.Query().Get("base_revision"); raw != "" {
		revision, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || revision < 1 {
			http.Error(w, "invalid note revision", http.StatusBadRequest)
			return
		}
		expectedRevision = &revision
	}
	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	if err := a.recoverFileOperations(); err != nil {
		http.Error(w, "could not recover pending file operations", http.StatusInternalServerError)
		return
	}
	err := a.deleteNoteWithFileOperation(id, expectedRevision)
	if errors.Is(err, errRevisionConflict) {
		http.Error(w, "note changed on another device", http.StatusConflict)
		return
	}
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "delete failed", http.StatusInternalServerError)
			return
		}
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	a.publishChange()
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) handleListTags(w http.ResponseWriter, r *http.Request) {
	tags, err := listTags(a.db)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if tags == nil {
		tags = []string{}
	}
	writeJSON(w, tags)
}

func (a *app) handleGetPrefs(w http.ResponseWriter, r *http.Request) {
	p, err := getPrefs(a.db)
	if err != nil {
		http.Error(w, "could not load preferences", http.StatusInternalServerError)
		return
	}
	writeJSON(w, p)
}

func (a *app) handleSavePrefs(w http.ResponseWriter, r *http.Request) {
	var p prefs
	if !decodeJSON(w, r, &p, 16<<10) {
		return
	}
	if err := savePrefs(a.db, &p); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, &p)
}
