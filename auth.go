package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

type sessionStore struct {
	mu       sync.RWMutex
	sessions map[string]time.Time
}

func newSessionStore() *sessionStore {
	return &sessionStore{
		sessions: make(map[string]time.Time),
	}
}

func (s *sessionStore) create() string {
	b := make([]byte, 16)
	rand.Read(b)
	token := hex.EncodeToString(b)
	s.mu.Lock()
	s.sessions[token] = time.Now().Add(24 * time.Hour)
	s.mu.Unlock()
	return token
}

func (s *sessionStore) valid(token string) bool {
	s.mu.RLock()
	expiry, ok := s.sessions[token]
	s.mu.RUnlock()
	if !ok {
		return false
	}
	if time.Now().After(expiry) {
		s.mu.Lock()
		delete(s.sessions, token)
		s.mu.Unlock()
		return false
	}
	return true
}

func (s *sessionStore) remove(token string) {
	s.mu.Lock()
	delete(s.sessions, token)
	s.mu.Unlock()
}

func (s *sessionStore) cleanup() {
	s.mu.Lock()
	now := time.Now()
	for t, exp := range s.sessions {
		if now.After(exp) {
			delete(s.sessions, t)
		}
	}
	s.mu.Unlock()
}

func (s *sessionStore) cleanupLoop() {
	for {
		time.Sleep(10 * time.Minute)
		s.cleanup()
	}
}

type app struct {
	db       *sql.DB
	sessions *sessionStore
	password string
	notesDir string
	encKey   []byte
	noteCache *noteCache
	rl        *rateLimiter
}

func (a *app) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("session")
		if err != nil || !a.sessions.valid(c.Value) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func (a *app) handleCheck(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func (a *app) handleLogout(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Cookie("session")
	if c != nil {
		a.sessions.remove(c.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if body.Password != a.password {
		a.rl.recordLoginAttempt(a.rl.realIP(r), false)
		http.Error(w, "wrong password", http.StatusUnauthorized)
		return
	}
	a.rl.recordLoginAttempt(a.rl.realIP(r), true)
	token := a.sessions.create()
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   86400,
	})
	json.NewEncoder(w).Encode(map[string]string{"token": token})
}
