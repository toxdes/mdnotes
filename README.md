# mdnotes

Lightweight, low-resources single-binary markdown files editor with SQLite metadata and optional AES-256-GCM file encryption.

## Features

- Live markdown preview via marked.js with cursor-position block highlighting
- Formatting toolbar: bold, italic, strike, code, code blocks, headings (h1-h4), links, images, lists, blockquotes, horizontal rules, tables
- Fullscreen mode for editor or preview panel
- Tags support with filtering
- Mobile-friendly responsive layout with dark theme
- Autosave (5s debounce) with manual save
- Versioned AES-256-GCM encryption on disk with Argon2id password mode or a random 32-byte key
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
| MDNOTES_ENCRYPTION_PASSWORD | (none) | Enable versioned encryption with an Argon2id-derived key |
| MDNOTES_ENCRYPTION_KEY | (none) | Enable encryption with a `hex:` or `base64:` encoded 32-byte key; arbitrary legacy values remain readable for migration |
| MDNOTES_TRUST_PROXY | (unset) | Set to `1` only when a trusted reverse proxy supplies client-IP headers |
| MDNOTES_MIGRATE_ENCRYPTION | (unset) | Set to `1` once with a v2 encryption setting to upgrade all legacy encrypted notes before serving requests |

Every secret variable also accepts a `_FILE` form—for example, `MDNOTES_ENCRYPTION_PASSWORD_FILE=/run/secrets/mdnotes_encryption_password`. This is preferred for Docker or Kubernetes secrets.

## Production encryption

Use `MDNOTES_ENCRYPTION_PASSWORD` for passphrases. It derives the file-encryption key with Argon2id and stores only non-secret KDF metadata in `MDNOTES_DIR/.mdnotes-crypto.json`. Alternatively, set `MDNOTES_ENCRYPTION_KEY` to a random 32-byte key prefixed with `hex:` or `base64:`.

Existing arbitrary `MDNOTES_ENCRYPTION_KEY` values use the legacy format. To migrate, back up the data, replace (do not combine) `MDNOTES_ENCRYPTION_KEY` with `MDNOTES_ENCRYPTION_PASSWORD` set to the same value, and start once with `MDNOTES_MIGRATE_ENCRYPTION=1`. Then restart without the migration flag. New writes use the versioned format, which authenticates each note ID.

HTTPS termination is intentionally left to your deployment (for example Certbot or Cloudflare). Set `MDNOTES_TRUST_PROXY=1` only when a trusted TLS-terminating proxy supplies the forwarding headers.

File encryption is server-side encryption at rest. It protects encrypted note bodies from a lost notes directory when the key is kept separately. It does not protect against a compromised running server, and SQLite metadata (titles, tags, timestamps) remains plaintext. Place both `MDNOTES_DIR` and `MDNOTES_DB` on an encrypted volume or use an encrypted SQLite deployment when metadata confidentiality is required.

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
