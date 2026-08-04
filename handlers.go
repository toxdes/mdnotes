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
	ID      string `json:"id"`
	Title   string `json:"title"`
	Content string `json:"content"`
	Tags    string `json:"tags"`
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
	filename := id + ".md"
	path, err := sanitizePath(a.notesDir, filename)
	if err != nil {
		http.Error(w, "invalid path", http.StatusInternalServerError)
		return
	}

	enc, err := a.encryption.encryptNote([]byte(req.Content), id)
	if err != nil {
		http.Error(w, "encryption failed", http.StatusInternalServerError)
		return
	}
	if err := writeNoteFile(path, enc); err != nil {
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}

	if err := upsertNote(a.db, id, req.Title, filename, tags); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	a.noteCache.set(id, req.Content)

	n, err := getNote(a.db, id)
	if err != nil {
		http.Error(w, "note saved but could not be loaded", http.StatusInternalServerError)
		return
	}
	writeJSON(w, n)
}

func (a *app) handleDeleteNote(w http.ResponseWriter, r *http.Request) {
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
	path, err := sanitizePath(a.notesDir, n.Filename)
	if err != nil {
		http.Error(w, "invalid path", http.StatusInternalServerError)
		return
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		http.Error(w, "delete failed", http.StatusInternalServerError)
		return
	}
	a.noteCache.del(id)
	if err := deleteNote(a.db, id); err != nil {
		http.Error(w, "delete failed", http.StatusInternalServerError)
		return
	}
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
