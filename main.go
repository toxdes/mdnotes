package main

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"embed"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

var version = "dev"

//go:embed static
var staticFS embed.FS

var appRevision = embeddedAppRevision()

func embeddedAppRevision() string {
	hash := sha256.New()
	err := fs.WalkDir(staticFS, "static", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		data, err := staticFS.ReadFile(path)
		if err != nil {
			return err
		}
		_, _ = hash.Write([]byte(path))
		_, _ = hash.Write(data)
		return nil
	})
	if err != nil {
		return "unknown"
	}
	return fmt.Sprintf("%x", hash.Sum(nil)[:8])
}

func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Keep dynamic endpoints cheap and do not recompress already-compressed
		// assets. Range responses must stay uncompressed for correct byte ranges.
		if r.Method == http.MethodGet && !strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Add("Vary", "Accept-Encoding")
		}
		if r.Method != http.MethodGet || strings.HasPrefix(r.URL.Path, "/api/") ||
			r.Header.Get("Range") != "" || !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") ||
			strings.HasSuffix(r.URL.Path, ".png") || strings.HasSuffix(r.URL.Path, ".ico") {
			next.ServeHTTP(w, r)
			return
		}
		gw, err := gzip.NewWriterLevel(w, gzip.BestSpeed)
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}
		defer gw.Close()
		w.Header().Set("Content-Encoding", "gzip")
		next.ServeHTTP(&gzipResponseWriter{ResponseWriter: w, Writer: gw}, r)
	})
}

func staticCacheMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/", "/index.html", "/sw.js", "/manifest.json":
			// Cloudflare respects no-transform and therefore cannot inject its
			// Web Analytics script into our strictly CSP-protected app shell.
			w.Header().Set("Cache-Control", "no-cache, no-transform")
		default:
			w.Header().Set("Cache-Control", "public, max-age=86400, no-transform")
		}
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; font-src 'self'")
		next.ServeHTTP(w, r)
	})
}

type gzipResponseWriter struct {
	http.ResponseWriter
	Writer io.Writer
}

func (w *gzipResponseWriter) Write(b []byte) (int, error) {
	return w.Writer.Write(b)
}

func main() {
	for _, a := range os.Args[1:] {
		if a == "-v" || a == "--version" || a == "-version" {
			fmt.Println(version)
			return
		}
	}

	password, err := readSecret("MDNOTES_PASSWORD")
	if err != nil {
		log.Fatalf("password: %v", err)
	}
	if password == "" {
		log.Fatal("MDNOTES_PASSWORD environment variable is required")
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	notesDir := os.Getenv("MDNOTES_DIR")
	if notesDir == "" {
		notesDir = "./notes"
	}
	notesDir, err = filepath.Abs(notesDir)
	if err != nil {
		log.Fatalf("invalid notes directory: %v", err)
	}
	if err := os.MkdirAll(notesDir, 0755); err != nil {
		log.Fatalf("cannot create notes directory: %v", err)
	}

	dbPath := os.Getenv("MDNOTES_DB")
	if dbPath == "" {
		dbPath = "./mdnotes.db"
	}

	db, err := openDB(dbPath)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer db.Close()

	if err := initDB(db, dbPath); err != nil {
		log.Fatalf("init db: %v", err)
	}

	sessions := newSessionStore(db)

	trustProxy := os.Getenv("MDNOTES_TRUST_PROXY") == "1"
	rl, err := newRateLimiter(db, sessions, trustProxy)
	if err != nil {
		log.Fatalf("rate limiter: %v", err)
	}

	encryptionPassword, err := readSecret("MDNOTES_ENCRYPTION_PASSWORD")
	if err != nil {
		log.Fatalf("encryption password: %v", err)
	}
	encryptionKey, err := readSecret("MDNOTES_ENCRYPTION_KEY")
	if err != nil {
		log.Fatalf("encryption key: %v", err)
	}
	encryption, err := newEncryptionConfig(notesDir, encryptionPassword, encryptionKey)
	if err != nil {
		log.Fatalf("encryption: %v", err)
	}
	if encryption != nil {
		if encryption.legacyWrite {
			log.Println("legacy file encryption enabled; migrate to MDNOTES_ENCRYPTION_PASSWORD or an explicitly encoded 32-byte key")
		} else {
			log.Println("versioned file encryption enabled")
		}
	}

	app := &app{
		db:         db,
		sessions:   sessions,
		password:   password,
		notesDir:   notesDir,
		encryption: encryption,
		noteCache:  newNoteCache(),
		rl:         rl,
	}
	if err := app.recoverFileOperations(); err != nil {
		log.Fatalf("recover pending file operations: %v", err)
	}
	if os.Getenv("MDNOTES_MIGRATE_ENCRYPTION") == "1" {
		count, err := migrateEncryption(app)
		if err != nil {
			log.Fatalf("encryption migration: %v", err)
		}
		log.Printf("migrated %d note files to encryption v2", count)
	}

	go sessions.cleanupLoop()

	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/login", app.handleLogin)
	mux.HandleFunc("POST /api/logout", app.auth(app.handleLogout))
	mux.HandleFunc("GET /api/check", app.auth(app.handleCheck))
	mux.HandleFunc("GET /api/notes", app.auth(app.handleListNotes))
	mux.HandleFunc("GET /api/search", app.auth(app.handleSearchNotes))
	mux.HandleFunc("GET /api/sync", app.auth(app.handleSyncChanges))
	mux.HandleFunc("POST /api/sync/push", app.auth(app.handleSyncPush))
	mux.HandleFunc("GET /api/events", app.auth(app.handleEvents))
	mux.HandleFunc("GET /api/notes/{id}", app.auth(app.handleGetNote))
	mux.HandleFunc("POST /api/notes", app.auth(app.handleSaveNote))
	mux.HandleFunc("DELETE /api/notes/{id}", app.auth(app.handleDeleteNote))
	mux.HandleFunc("GET /api/tags", app.auth(app.handleListTags))
	mux.HandleFunc("GET /api/prefs", app.auth(app.handleGetPrefs))
	mux.HandleFunc("PATCH /api/prefs", app.auth(app.handleSavePrefs))

	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatalf("static fs: %v", err)
	}
	fileServer := staticCacheMiddleware(http.FileServer(http.FS(sub)))
	mux.Handle("GET /", fileServer)

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      securityHeaders(gzipMiddleware(rl.banCheckMiddleware(rl.notFoundTracker(mux)))),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("mdnotes running on :%s (notes: %s, db: %s)", port, notesDir, dbPath)
		err := srv.ListenAndServe()
		if err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(shutdownCtx)
}

// readSecret supports Docker/Kubernetes-style *_FILE secrets without putting a
// reusable encryption or login secret in the process environment. A final line
// break is removed because secret mounts conventionally include one.
func readSecret(name string) (string, error) {
	if path := os.Getenv(name + "_FILE"); path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		return strings.TrimSuffix(strings.TrimSuffix(string(data), "\n"), "\r"), nil
	}
	return os.Getenv(name), nil
}

func migrateEncryption(a *app) (int, error) {
	if a.encryption == nil || a.encryption.legacyWrite {
		return 0, fmt.Errorf("MDNOTES_MIGRATE_ENCRYPTION requires MDNOTES_ENCRYPTION_PASSWORD or an explicitly encoded key")
	}
	notes, err := listNotes(a.db, "")
	if err != nil {
		return 0, err
	}
	count := 0
	for _, n := range notes {
		path, err := sanitizePath(a.notesDir, n.Filename)
		if err != nil {
			return count, err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return count, err
		}
		if isVersionedEnvelope(data) {
			continue
		}
		plain, err := a.encryption.decryptNote(data, n.ID)
		if err != nil {
			return count, fmt.Errorf("decrypt %s: %w", n.ID, err)
		}
		updated, err := a.encryption.encryptNote(plain, n.ID)
		if err != nil {
			return count, err
		}
		if err := writeNoteFile(path, updated); err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}
