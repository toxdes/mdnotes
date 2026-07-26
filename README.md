# mdnotes

Lightweight, low-resources single-binary markdown files editor with SQLite metadata and optional AES-256-GCM file encryption.

## Features

- Live markdown preview via marked.js with cursor-position block highlighting
- Formatting toolbar: bold, italic, strike, code, code blocks, headings (h1-h4), links, images, lists, blockquotes, horizontal rules, tables
- Fullscreen mode for editor or preview panel
- Tags support with filtering
- Mobile-friendly responsive layout with dark theme
- Autosave (5s debounce) with manual save
- AES-256-GCM encryption on disk (opt-in via MDNOTES_ENCRYPTION_KEY)
- Session-based authentication (MDNOTES_PASSWORD)
- PWA-ready (manifest, service worker, installable app)

## Usage

```
MDNOTES_PASSWORD=<password> ./mdnotes
```

Optional environment variables:

| Variable | Default | Description |
|---|---|---|
| PORT | 8080 | HTTP listen port |
| MDNOTES_DIR | ./notes | Directory for markdown files |
| MDNOTES_DB | ./mdnotes.db | SQLite database path |
| MDNOTES_ENCRYPTION_KEY | (none) | Enable file encryption (32-byte key, any string) |

## Build

```
go build -trimpath -ldflags="-s -w -X main.version=$(cat VERSION)" -o mdnotes .
```

Cross-compile all targets (Linux binaries compressed with UPX):

```
./build.py
```

## Docker

```
docker build -t mdnotes .
docker run -d -p 8080:8080 \
  -e MDNOTES_PASSWORD=<password> \
  -v mdnotes-data:/data \
  mdnotes
```

Mount `/data` to persist notes and SQLite database across restarts.
