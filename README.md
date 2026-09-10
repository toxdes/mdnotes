# mdnotes

Lightweight, low-resources single-binary markdown files editor with SQLite metadata and optional AES-256-GCM file encryption.

## Features

- Live markdown preview via marked.js with cursor-position block highlighting
- Formatting toolbar: bold, italic, strike, code, code blocks, headings (h1-h4), links, images, lists, blockquotes, horizontal rules, tables
- Fullscreen mode for editor or preview panel
- Tags support with filtering
- Mobile-friendly responsive layout with dark theme
- Autosave (2s debounce) with manual save
- Versioned AES-256-GCM encryption on disk with Argon2id password mode or a random 32-byte key
- Session-based authentication (MDNOTES_PASSWORD)
- PWA-ready (manifest, service worker, installable app)
- Offline-first notes: the installed app caches its shell, saves edits in IndexedDB, and synchronizes them after reconnection

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
| ARTIFICIAL_RTT_DELAY_MS | 0 | Development-only delay added once before each request, in milliseconds; `/api/events` is excluded |

Every secret variable also accepts a `_FILE` form—for example, `MDNOTES_ENCRYPTION_PASSWORD_FILE=/run/secrets/mdnotes_encryption_password`. This is preferred for Docker or Kubernetes secrets.

## Production encryption

Use `MDNOTES_ENCRYPTION_PASSWORD` for passphrases. It derives the file-encryption key with Argon2id and stores only non-secret KDF metadata in `MDNOTES_DIR/.mdnotes-crypto.json`. Alternatively, set `MDNOTES_ENCRYPTION_KEY` to a random 32-byte key prefixed with `hex:` or `base64:`.

Existing arbitrary `MDNOTES_ENCRYPTION_KEY` values use the legacy format. To migrate, back up the data, replace (do not combine) `MDNOTES_ENCRYPTION_KEY` with `MDNOTES_ENCRYPTION_PASSWORD` set to the same value, and start once with `MDNOTES_MIGRATE_ENCRYPTION=1`. Then restart without the migration flag. New writes use the versioned format, which authenticates each note ID.

HTTPS termination is intentionally left to your deployment (for example Certbot or Cloudflare). Set `MDNOTES_TRUST_PROXY=1` only when a trusted TLS-terminating proxy supplies the forwarding headers.

File encryption is server-side encryption at rest. It protects encrypted note bodies from a lost notes directory when the key is kept separately. It does not protect against a compromised running server, and SQLite metadata (titles, tags, timestamps) remains plaintext. Place both `MDNOTES_DIR` and `MDNOTES_DB` on an encrypted volume or use an encrypted SQLite deployment when metadata confidentiality is required.

### Migration backups

Before applying pending database migrations, mdnotes creates a consistent SQLite snapshot beside `MDNOTES_DB` using SQLite's backup mechanism. The three newest `*.pre-migration-*.db` snapshots are retained for rollback; ordinary restarts with no pending migration create no snapshot. Ensure the database volume has roughly one extra database-sized block of free space before an upgrade; startup stops safely if the snapshot cannot be made.

## Offline use

After signing in online once, mdnotes caches its application shell and notes on the device. You can then reopen the installed PWA without a connection, edit or delete notes, and continue working normally. Changes are stored in the browser's IndexedDB and automatically synchronize whenever connectivity returns, while the app is visible.

Open notes use their note ID as the route (`/<note-id>`), so browser navigation and bookmarks return to the same note. The server serves the application shell for valid note routes; access still requires the usual session.

The preview recognizes `[[Wiki Links]]`: clicking a matching note title opens that note, while an unmatched title creates and opens a new note with that title.

Markdown preview treats raw HTML as text rather than rendering it. Links are limited to HTTP, HTTPS, and mailto URLs, and images are limited to HTTP and HTTPS URLs. Remote images load lazily and asynchronously.

While the signed-in app is open, it keeps an authenticated SSE stream to the server. A 25-second heartbeat drives the Online/Offline indicator, and content-free change hints trigger normal HTTP sync promptly on other open devices. A missing heartbeat for 70 seconds is treated as offline, and reconnection runs a full cache reconciliation before replaying local work.

Sync history is bounded for small deployments: the server retains up to 100,000 change records and acknowledgements, and caps stored full operation payloads at 32 MiB. A device older than the retained change feed performs a full server refresh before replaying any local work; old acknowledged retries receive a safe compacted acknowledgement and rebase from the server state.

If the same note changed on another device while you were offline, mdnotes first performs a three-way merge using the shared base version, your local version, and the server version. Non-overlapping line edits and one-sided title/tag changes are merged and synchronized automatically. For ambiguous overlapping edits, mdnotes preserves both versions and opens a conflict resolver with the common original, highlighted device versions, and an editable result; you can also explicitly keep your version as a separately titled `conflict copy`. Signing out removes the locally cached notes and queued changes from that browser. Offline copies are plaintext in the browser profile, so use a protected device and sign out on shared devices.

## Build

```
go build -trimpath -ldflags="-s -w -X main.version=$(cat VERSION)" -o mdnotes .
```

Cross-compile all targets (Linux binaries compressed with UPX):

```
./build.py
```

## Tests

Run the default frontend behavior suite with `npm run test:frontend`. The opt-in browser reliability suite uses the installed Chrome binary and a temporary Go server; run it with `npm run test:browser`. It covers offline cached startup, unchanged navigation request counts, a warm dashboard performance budget, keyboard navigation, and serious accessibility violations.

## Docker

```
docker build -t mdnotes .
docker run -d -p 8080:8080 \
  -e MDNOTES_PASSWORD=<password> \
  -v mdnotes-data:/data \
  mdnotes
```

Mount `/data` to persist notes and SQLite database across restarts.
