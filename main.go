package main

import (
	"compress/gzip"
	"context"
	"embed"
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

//go:embed static
var staticFS embed.FS

func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
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

type gzipResponseWriter struct {
	http.ResponseWriter
	Writer io.Writer
}

func (w *gzipResponseWriter) Write(b []byte) (int, error) {
	return w.Writer.Write(b)
}

func main() {
	password := os.Getenv("MDNOTE_PASSWORD")
	if password == "" {
		log.Fatal("MDNOTE_PASSWORD environment variable is required")
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	notesDir := os.Getenv("MDNOTE_DIR")
	if notesDir == "" {
		notesDir = "./notes"
	}
	notesDir, err := filepath.Abs(notesDir)
	if err != nil {
		log.Fatalf("invalid notes directory: %v", err)
	}
	if err := os.MkdirAll(notesDir, 0755); err != nil {
		log.Fatalf("cannot create notes directory: %v", err)
	}

	dbPath := os.Getenv("MDNOTE_DB")
	if dbPath == "" {
		dbPath = "./mdnotes.db"
	}

	db, err := openDB(dbPath)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer db.Close()

	if err := initDB(db); err != nil {
		log.Fatalf("init db: %v", err)
	}

	sessions := newSessionStore()

	var encKey []byte
	if ek := os.Getenv("MDNOTE_ENCRYPTION_KEY"); ek != "" {
		encKey = deriveKey(ek)
		log.Println("file encryption enabled")
	}

	app := &app{
		db:        db,
		sessions:  sessions,
		password:  password,
		notesDir:  notesDir,
		encKey:    encKey,
		noteCache: newNoteCache(),
	}

	go sessions.cleanupLoop()

	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/login", app.handleLogin)
	mux.HandleFunc("POST /api/logout", app.auth(app.handleLogout))
	mux.HandleFunc("GET /api/check", app.auth(app.handleCheck))
	mux.HandleFunc("GET /api/notes", app.auth(app.handleListNotes))
	mux.HandleFunc("GET /api/notes/{id}", app.auth(app.handleGetNote))
	mux.HandleFunc("POST /api/notes", app.auth(app.handleSaveNote))
	mux.HandleFunc("DELETE /api/notes/{id}", app.auth(app.handleDeleteNote))
	mux.HandleFunc("GET /api/tags", app.auth(app.handleListTags))

	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatalf("static fs: %v", err)
	}
	fileServer := http.FileServer(http.FS(sub))
	mux.Handle("GET /", fileServer)

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      gzipMiddleware(mux),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("mdnotes running on :%s (notes: %s, db: %s)", port, notesDir, dbPath)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(shutdownCtx)
}
