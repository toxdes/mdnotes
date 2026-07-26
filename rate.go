package main

import (
	"database/sql"
	"net/http"
	"strings"
	"time"
)

type rateLimiter struct {
	db       *sql.DB
	sessions *sessionStore
}

func newRateLimiter(db *sql.DB, sessions *sessionStore) (*rateLimiter, error) {
	_, err := db.Exec(`
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
		)
	`)
	if err != nil {
		return nil, err
	}
	return &rateLimiter{db: db, sessions: sessions}, nil
}

func (rl *rateLimiter) realIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if i := strings.IndexByte(fwd, ','); i != -1 {
			return fwd[:i]
		}
		return fwd
	}
	if real := r.Header.Get("X-Real-IP"); real != "" {
		return real
	}
	if i := strings.LastIndex(r.RemoteAddr, ":"); i != -1 {
		return r.RemoteAddr[:i]
	}
	return r.RemoteAddr
}

func (rl *rateLimiter) isBanned(ip string) (bool, error) {
	var exists int
	err := rl.db.QueryRow("SELECT 1 FROM ip_bans WHERE ip = ?", ip).Scan(&exists)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return true, err
}

func (rl *rateLimiter) banIP(ip, reason string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := rl.db.Exec(
		"INSERT OR IGNORE INTO ip_bans (ip, reason, created_at) VALUES (?, ?, ?)",
		ip, reason, now,
	)
	return err
}

func (rl *rateLimiter) recordLoginAttempt(ip string, success bool) error {
	if success {
		_, err := rl.db.Exec("DELETE FROM rate_limits WHERE ip = ? AND typ = 'login'", ip)
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := rl.db.Exec(`
		INSERT INTO rate_limits (ip, typ, count, updated_at) VALUES (?, 'login', 1, ?)
		ON CONFLICT(ip, typ) DO UPDATE SET
			count = count + 1,
			updated_at = ?
	`, ip, now, now)
	if err != nil {
		return err
	}
	var count int
	err = rl.db.QueryRow("SELECT count FROM rate_limits WHERE ip = ? AND typ = 'login'", ip).Scan(&count)
	if err != nil {
		return err
	}
	if count >= 5 {
		return rl.banIP(ip, "too many failed login attempts")
	}
	return nil
}

func (rl *rateLimiter) recordNotFound(ip string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := rl.db.Exec(`
		INSERT INTO rate_limits (ip, typ, count, updated_at) VALUES (?, 'not_found', 1, ?)
		ON CONFLICT(ip, typ) DO UPDATE SET
			count = count + 1,
			updated_at = ?
	`, ip, now, now)
	if err != nil {
		return err
	}
	var count int
	err = rl.db.QueryRow("SELECT count FROM rate_limits WHERE ip = ? AND typ = 'not_found'", ip).Scan(&count)
	if err != nil {
		return err
	}
	if count >= 10 {
		return rl.banIP(ip, "too many 404s")
	}
	return nil
}

func (rl *rateLimiter) banCheckMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := rl.realIP(r)
		banned, err := rl.isBanned(ip)
		if err != nil || banned {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(b)
}

func (rl *rateLimiter) notFoundTracker(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		if rec.status == http.StatusNotFound {
			c, err := r.Cookie("session")
			if err != nil || !rl.sessions.valid(c.Value) {
				ip := rl.realIP(r)
				rl.recordNotFound(ip)
			}
		}
	})
}
