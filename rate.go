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
	trustProxy bool
	mu         sync.Mutex
	bans       map[string]banCacheEntry
}

type banCacheEntry struct {
	banned  bool
	expires time.Time
}

const (
	banCacheTTL        = 5 * time.Minute
	maxCachedBanIPs    = 4096
	loginAttemptWindow = 15 * time.Minute
)

func newRateLimiter(db *sql.DB, trustProxy bool) (*rateLimiter, error) {
	return &rateLimiter{db: db, trustProxy: trustProxy, bans: make(map[string]banCacheEntry)}, nil
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
	return false, nil
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

func (rl *rateLimiter) banIP(ip string) {
	rl.cacheBan(ip, true)
}

func (rl *rateLimiter) recordLoginAttempt(ip string, success bool) error {
	if success {
		_, err := rl.db.Exec("DELETE FROM rate_limits WHERE ip = ? AND typ = 'login'", ip)
		return err
	}
	now := time.Now().UTC()
	windowStart := now.Add(-loginAttemptWindow).Format(time.RFC3339)
	nowText := now.Format(time.RFC3339)
	_, err := rl.db.Exec(`
		INSERT INTO rate_limits (ip, typ, count, updated_at) VALUES (?, 'login', 1, ?)
		ON CONFLICT(ip, typ) DO UPDATE SET
			count = CASE WHEN rate_limits.updated_at < ? THEN 1 ELSE rate_limits.count + 1 END,
			updated_at = ?
	`, ip, nowText, windowStart, nowText)
	if err != nil {
		return err
	}
	var count int
	err = rl.db.QueryRow("SELECT count FROM rate_limits WHERE ip = ? AND typ = 'login'", ip).Scan(&count)
	if err != nil {
		return err
	}
	if count >= 5 {
		rl.banIP(ip)
	}
	return nil
}

func (rl *rateLimiter) loginRetryAfter(ip string) (int, error) {
	var count int
	var updatedAt string
	err := rl.db.QueryRow("SELECT count, updated_at FROM rate_limits WHERE ip = ? AND typ = 'login'", ip).Scan(&count, &updatedAt)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	updated, err := time.Parse(time.RFC3339, updatedAt)
	if err != nil || time.Since(updated) >= loginAttemptWindow {
		if _, deleteErr := rl.db.Exec("DELETE FROM rate_limits WHERE ip = ? AND typ = 'login'", ip); deleteErr != nil {
			return 0, deleteErr
		}
		return 0, nil
	}
	if count < 5 {
		return 0, nil
	}
	backoff := 1 << min(count-5, 8)
	remaining := int(time.Until(updated.Add(loginAttemptWindow)).Seconds())
	if remaining < 1 {
		return 0, nil
	}
	if backoff > 300 {
		backoff = 300
	}
	if backoff > remaining {
		backoff = remaining
	}
	return backoff, nil
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
