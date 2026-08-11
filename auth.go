package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const sessionLifetime = 180 * 24 * time.Hour

type sessionStore struct {
	db *sql.DB
}

func newSessionStore(db *sql.DB) *sessionStore {
	return &sessionStore{db: db}
}

func sessionTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *sessionStore) create() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)
	_, err := s.db.Exec("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)", sessionTokenHash(token), time.Now().UTC().Add(sessionLifetime).Format(time.RFC3339))
	if err != nil {
		return "", err
	}
	return token, nil
}

func (s *sessionStore) valid(token string) bool {
	var expiry string
	if err := s.db.QueryRow("SELECT expires_at FROM sessions WHERE token_hash = ?", sessionTokenHash(token)).Scan(&expiry); err != nil {
		return false
	}
	expiresAt, err := time.Parse(time.RFC3339, expiry)
	if err != nil || !time.Now().UTC().Before(expiresAt) {
		s.remove(token)
		return false
	}
	return true
}

func (s *sessionStore) remove(token string) {
	_, _ = s.db.Exec("DELETE FROM sessions WHERE token_hash = ?", sessionTokenHash(token))
}

func (s *sessionStore) cleanup() {
	_, _ = s.db.Exec("DELETE FROM sessions WHERE expires_at <= ?", time.Now().UTC().Format(time.RFC3339))
}

func (s *sessionStore) cleanupLoop() {
	for {
		time.Sleep(10 * time.Minute)
		s.cleanup()
	}
}

type app struct {
	db         *sql.DB
	noteMu     sync.Mutex
	sessions   *sessionStore
	password   string
	notesDir   string
	encryption *encryptionConfig
	noteCache  *noteCache
	rl         *rateLimiter
	events     *eventBroker
}

func (a *app) isSecureRequest(r *http.Request) bool {
	return r.TLS != nil || (a.rl.trustProxy && r.Header.Get("X-Forwarded-Proto") == "https")
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
	writeJSON(w, map[string]any{"ok": true, "version": version, "revision": appRevision})
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
		HttpOnly: true,
		Secure:   a.isSecureRequest(r),
		SameSite: http.SameSiteLaxMode,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) handleLogin(w http.ResponseWriter, r *http.Request) {
	ip := a.rl.realIP(r)
	retryAfter, err := a.rl.loginRetryAfter(ip)
	if err != nil {
		http.Error(w, "could not check login rate limit", http.StatusInternalServerError)
		return
	}
	if retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		_ = a.rl.recordLoginAttempt(ip, false)
		writeJSONStatus(w, http.StatusTooManyRequests, map[string]any{
			"error":       "too many login attempts",
			"code":        "login_rate_limited",
			"retry_after": retryAfter,
		})
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &body, 16<<10) {
		return
	}
	if subtle.ConstantTimeCompare([]byte(body.Password), []byte(a.password)) != 1 {
		a.rl.recordLoginAttempt(ip, false)
		http.Error(w, "wrong password", http.StatusUnauthorized)
		return
	}
	a.rl.recordLoginAttempt(ip, true)
	token, err := a.sessions.create()
	if err != nil {
		http.Error(w, "could not create session", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   a.isSecureRequest(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionLifetime.Seconds()),
	})
	writeJSON(w, map[string]bool{"ok": true})
}
