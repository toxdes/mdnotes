package main

import (
	"database/sql"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type rateLimiter struct {
	db         *sql.DB
	sessions   *sessionStore
	trustProxy bool
	mu         sync.Mutex
	bans       map[string]banCacheEntry
}

type banCacheEntry struct {
	banned  bool
	expires time.Time
}

const (
	banCacheTTL     = 5 * time.Minute
	maxCachedBanIPs = 4096
)

func newRateLimiter(db *sql.DB, sessions *sessionStore, trustProxy bool) (*rateLimiter, error) {
	return &rateLimiter{db: db, sessions: sessions, trustProxy: trustProxy, bans: make(map[string]banCacheEntry)}, nil
}

func (rl *rateLimiter) realIP(r *http.Request) string {
	if !rl.trustProxy {
		if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
			return host
		}
		return r.RemoteAddr
	}
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if i := strings.IndexByte(fwd, ','); i != -1 {
			return strings.TrimSpace(fwd[:i])
		}
		return strings.TrimSpace(fwd)
	}
	if real := r.Header.Get("X-Real-IP"); real != "" {
		return real
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func (rl *rateLimiter) isBanned(ip string) (bool, error) {
	rl.mu.Lock()
	if cached, ok := rl.bans[ip]; ok && time.Now().Before(cached.expires) {
		rl.mu.Unlock()
		return cached.banned, nil
	}
	delete(rl.bans, ip)
	rl.mu.Unlock()

	var exists int
	err := rl.db.QueryRow("SELECT 1 FROM ip_bans WHERE ip = ?", ip).Scan(&exists)
	if err == sql.ErrNoRows {
		rl.cacheBan(ip, false)
		return false, nil
	}
	if err != nil {
		return false, err
	}
	rl.cacheBan(ip, true)
	return true, nil
}

func (rl *rateLimiter) cacheBan(ip string, banned bool) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	if len(rl.bans) >= maxCachedBanIPs {
		now := time.Now()
		for key, entry := range rl.bans {
			if now.After(entry.expires) {
				delete(rl.bans, key)
			}
		}
		if len(rl.bans) >= maxCachedBanIPs {
			return
		}
	}
	rl.bans[ip] = banCacheEntry{banned: banned, expires: time.Now().Add(banCacheTTL)}
}

func (rl *rateLimiter) banIP(ip, reason string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := rl.db.Exec(
		"INSERT OR IGNORE INTO ip_bans (ip, reason, created_at) VALUES (?, ?, ?)",
		ip, reason, now,
	)
	if err == nil {
		rl.cacheBan(ip, true)
	}
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

func (r *statusRecorder) Flush() {
	if flusher, ok := r.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
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
