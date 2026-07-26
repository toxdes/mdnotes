package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func randID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func sanitizePath(base, path string) (string, error) {
	abs, err := filepath.Abs(filepath.Join(base, path))
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(abs, base) {
		return "", http.ErrMissingFile
	}
	return abs, nil
}

func (a *app) handleListNotes(w http.ResponseWriter, r *http.Request) {
	tag := r.URL.Query().Get("tag")
	notes, err := listNotes(a.db, tag)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(notes)
}

func (a *app) handleGetNote(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	n, err := getNote(a.db, id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if cached, ok := a.noteCache.get(id); ok {
		resp := struct {
			note
			Content string `json:"content"`
		}{
			note:    *n,
			Content: string(cached),
		}
		json.NewEncoder(w).Encode(resp)
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
	plain, err := decrypt(enc, a.encKey)
	if err != nil {
		http.Error(w, "decryption failed", http.StatusInternalServerError)
		return
	}
	a.noteCache.set(id, plain)
	resp := struct {
		note
		Content string `json:"content"`
	}{
		note:    *n,
		Content: string(plain),
	}
	json.NewEncoder(w).Encode(resp)
}

type saveRequest struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Content string `json:"content"`
	Tags    string `json:"tags"`
}

func (a *app) handleSaveNote(w http.ResponseWriter, r *http.Request) {
	var req saveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	id := req.ID
	if id == "" {
		id = randID()
	}

	filename := id + ".md"
	path, err := sanitizePath(a.notesDir, filename)
	if err != nil {
		http.Error(w, "invalid path", http.StatusInternalServerError)
		return
	}

	enc, err := encrypt([]byte(req.Content), a.encKey)
	if err != nil {
		http.Error(w, "encryption failed", http.StatusInternalServerError)
		return
	}
	if err := os.WriteFile(path, enc, 0644); err != nil {
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}

	// normalize tags
	tags := strings.TrimSpace(req.Tags)
	if tags != "" {
		parts := strings.Split(tags, ",")
		var cleaned []string
		for _, p := range parts {
			t := strings.TrimSpace(p)
			if t != "" {
				cleaned = append(cleaned, t)
			}
		}
		tags = strings.Join(cleaned, ",")
	}

	a.noteCache.set(id, []byte(req.Content))

	if err := upsertNote(a.db, id, req.Title, filename, tags); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	n, _ := getNote(a.db, id)
	json.NewEncoder(w).Encode(n)
}

func (a *app) handleDeleteNote(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	n, err := getNote(a.db, id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	path, err := sanitizePath(a.notesDir, n.Filename)
	if err != nil {
		http.Error(w, "invalid path", http.StatusInternalServerError)
		return
	}
	os.Remove(path)
	a.noteCache.del(id)
	deleteNote(a.db, id)
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
	json.NewEncoder(w).Encode(tags)
}
