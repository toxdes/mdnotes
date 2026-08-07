# Backend Audit A1 — Memory Leaks, Race Conditions, Edge Cases

**Target:** `mdnotes` Go backend (`main.go`, `handlers.go`, `db.go`, `sync_ops.go`,
`events.go`, `cache.go`, `rate.go`, `auth.go`, `crypto.go`, `file_ops.go`)
**Method:** full source review; `go build`, `go vet`, `go test -race` (all pass);
one stdlib behaviour claim (gzip + `Content-Length`) verified empirically and
against the installed Go 1.25 source.
**Date:** 2026-08-07

---

## Severity summary

| ID | Severity | Category | Issue |
|----|----------|----------|-------|
| R1 | **High** | Race / consistency | Un-synchronized read path vs. two-phase write commit → stale cache clobber and stale metadata/content snapshots |
| R2 | **High** | Edge / data integrity | Direct save/delete can bypass the revision guard entirely (no `base_revision`) and silently overwrite/recreate/delete notes |
| L1 | Medium | Growth / leak | `rate_limits` rows accumulate forever (never pruned) |
| E1 | Medium | Edge | Any note-file read error is conflated with `sql.ErrNoRows` ("not found") |
| E2 | Medium | Edge / availability | A single unrecoverable `file_operations` row blocks *all* future writes permanently |
| L2 | Medium | Growth / leak | `file_operations` rows + orphaned staged/note files accumulate if a file op persistently fails |
| L3 | Low | Growth / leak | `sync_device_state` grows one row per distinct device, never pruned |
| E3 | Low | Edge | Note files are read whole with no size cap (`os.ReadFile`) |
| E4 | Low | Edge | Unpaged `GET /api/notes` materializes the entire notes table in memory |
| E5 | Low | Edge | Oversized request bodies return 400 rather than 413 |
| E6 | Low | Edge | Graceful shutdown does not drain SSE connections; abrupt disconnect |
| E7 | Low | Edge | Full ban cache silently drops new bans |
| E8 | Low | Edge / perf | `recoverFileOperations()` runs on every write and lists the whole notes dir |
| E9 | Low | Edge | Direct `PATCH /api/prefs` never publishes a change event (inconsistent with sync `prefs.save`) |

No classic goroutine/DB-connection leak was found: all `sql.Rows` are closed,
the note cache is LRU-bounded, sync tables are compacted, SSE subscribers are
removed on disconnect, and the race detector is clean on the test suite.

---

## High severity

### R1 — Read path is not synchronized with the write path's two-phase commit (stale cache clobber)

The write path commits the DB row first, then renames the file, then updates the
cache — all under `a.noteMu` (`file_ops.go:180-188`, `sync_ops.go:279-292`).
The read path (`loadNoteWithContent`, `handlers.go:206-235`) touches the DB,
the file, and the cache **without** holding `a.noteMu`, so it can interleave in
the middle of that commit:

1. Reader: `getNote` returns rev N, cache miss, starts `os.ReadFile` (old file, rev N).
2. Writer: commits rev N+1, renames file, `noteCache.set(id, rev-N+1 content)`.
3. Reader: finishes reading the old file, decrypts, then `handlers.go:230`
   `a.noteCache.set(id, rev-N content)` — **clobbering the fresh cache entry**.
4. Subsequent GETs serve stale content while the DB reports rev N+1, until an
   eviction or another save/delete.

Two sibling manifestations of the same root cause:
- **Stale metadata/content snapshot:** a reader that reads the DB *after* the
  writer's commit but the file *before* the rename serves rev-N+1 metadata with
  rev-N content (`handlers.go:207` + `221`).
- **Transient 404:** a reader that resolved a note in the DB can hit the file
  while a concurrent delete is removing it → `os.ReadFile` fails → 404 even
  though the delete was not yet committed from the client's perspective.

`handleBulkGetNotes` and `handleGetNote` both route through this path, so every
read is affected.

Suggested direction: hold `a.noteMu` across read+decrypt+cache-set (matching the
write path), or re-check/replace the cache entry only if the existing entry is
older than the freshly read file (e.g. compare timestamps), or drop the cache and
serve straight from disk.

---

### R2 — Direct save/delete can bypass the revision guard and overwrite data

`base_revision` is optional on the direct HTTP API. When absent,
`expectedRevision == nil` and the revision check is skipped:

- `saveNoteWithFileOperation` (`file_ops.go:163-167`) — `checkNoteRevisionTx`
  only runs `if expectedRevision != nil`.
- `deleteNoteWithFileOperation` (`file_ops.go:197-201`) — same.

Consequences:
- A client can `POST /api/notes` with the `id` of an existing note and **no
  `base_revision`**, and `upsertNoteTx`'s `ON CONFLICT(id) DO UPDATE`
  (`db.go:645-655`) will silently overwrite title/tags/content, bumping the
  revision — no conflict, no error. This is reachable by any authenticated
  client and defeats the optimistic-concurrency model that the sync path
  enforces (`validateSyncOperation` requires `BaseRevision != nil`, `sync_ops.go:128`).
- A client can re-create a *deleted* note's id with no revision guard, whereas
  the sync path rejects that via the `MAX(revision)` check (`handlers.go:299`,
  `sync_ops.go:380`).
- A client can `DELETE /api/notes/{id}` without `base_revision` and delete any
  note regardless of whether it changed on another device.

Suggested direction: when `id` is supplied by the client, require
`base_revision` to be present; or at minimum reject the save if the note already
exists and no `base_revision` was provided.

---

## Memory leaks / unbounded growth

### L1 — `rate_limits` table grows forever (medium)

`recordLoginAttempt` (`rate.go:88-114`) inserts one row per distinct IP that
fails a login and never deletes it. The only cleanup is a `DELETE` for that IP on
a *successful* login (`rate.go:90`). Rows from attacker IPs (or any IP that never
succeeds) persist indefinitely — the table grows one row per unique failing IP
over the life of the deployment. In-memory ban state is bounded (`bans` cap 4096,
TTL 5 min), but the DB-side table is not. (The legacy `ip_bans` table is now
write-free and only cleared by migration 11.)

Suggested direction: prune `rate_limits` rows older than `loginAttemptWindow`
(15 min) periodically, e.g. in the same loop as session cleanup.

### L2 — `file_operations` rows + orphan files on persistent failure (medium)

Under the normal path each op row is inserted then deleted
(`file_ops.go:57-60`, `122-123`). But if `completeFileOperation` fails
persistently (e.g. filesystem becomes read-only, staged file vanished AND target
missing), the row is never removed, the staged file is intentionally left in
place for retry (`file_ops.go:151-156`), and every subsequent write path calls
`recoverFileOperations()` which **aborts on the first failing op**
(`file_ops.go:82-86`). Result: the table grows and all writes return 500 forever
(see E2). Note files removed during a delete whose file removal subsequently
fails are also left as orphans on disk (not covered by
`removeOrphanedStageFiles`, which only matches the stage-file prefix).

### L3 — `sync_device_state` grows one row per device (low)

`syncDeviceSequence` (`sync_ops.go:146-153`) inserts a row for every distinct
`device_id` ever seen and nothing ever deletes it. Small per-row, but unbounded
over time. `sync_operations` itself is bounded (100k ack rows, 32 MB payloads),
so only the device table is an issue.

---

## Edge cases

### E1 — Any note-file read error is reported as "not found" (medium)

`loadNoteWithContent` (`handlers.go:221-224`):

```go
enc, err := os.ReadFile(path)
if err != nil {
    return noteWithContent{}, sql.ErrNoRows
}
```

Every `os.ReadFile` failure — ENOENT, EACCES, EIO, transient I/O — collapses into
`sql.ErrNoRows` and is surfaced as 404 / added to `missing`. A transient
permission or I/O fault is therefore indistinguishable from a genuinely absent
note and can mask real filesystem problems.

### E2 — A single stuck file operation bricks all writes (medium)

Every save/delete/sync starts with `a.recoverFileOperations()` under `noteMu`
(`handlers.go:335`, `365`, `sync_ops.go:74`). If any pending operation cannot be
completed, recovery returns an error and the whole request fails 500. One
unrecoverable row (e.g. replace where both the stage file and target are gone —
`file_ops.go:111-113`) permanently blocks *every* write until an operator
intervenes in the DB. Recovery also stops at the first bad op
(`file_ops.go:82-86`), leaving subsequent ops unprocessed.

Suggested direction: on `completeFileOperation` failure, surface/require manual
cleanup of that specific row (e.g. quarantine it) instead of failing the entire
recovery scan.

### E3 — Unbounded note-file reads (low)

`loadNoteWithContent` reads and decrypts the entire file with no size cap. A
multi-hundred-MB note file (possible if files are placed on disk directly, or
via `migrateEncryption`/legacy layout) is read whole per request, and
`handleBulkGetNotes` multiplies that by up to 25. Direct save is capped at 4 MiB,
but the read side trusts the file size.

### E4 — Unpaged list materializes all notes (low)

`handleListNotes` without a `limit` calls `listNotes` (`db.go:435-462`) which
loads every row into memory and marshals them all. With a large library this is
an unbounded response/memory. Pagination exists but is opt-in by the client.

### E5 — Oversized bodies return 400 instead of 413 (low)

`decodeJSON` (`handlers.go:59-72`) wraps the body in `http.MaxBytesReader`, but a
body exceeding the limit makes `decoder.Decode` fail and is reported as
`400 invalid request` rather than the more accurate `413 Request Entity Too
Large`. Cosmetic, but misleads clients that rely on the status to retry with a
smaller payload.

### E6 — Graceful shutdown does not drain SSE (low)

On SIGINT/SIGTERM, `srv.Shutdown` (`main.go:278-282`) waits up to 5 s for
connections to become idle. SSE streams are never idle, so Shutdown times out and
the process exits while SSE clients get an abrupt, unannounced disconnect (no
`event: server` teardown, no close frame). No leak in practice (process exit
reclaims everything), but it is not a graceful SSE drain.

### E7 — Full ban cache silently drops new bans (low)

`cacheBan` (`rate.go:67-82`) evicts only expired entries; if the 4096-slot map is
full of *valid* entries, the new ban is dropped and that IP is not blocked for the
next 5 minutes. Under a large-scale distributed attack (many distinct IPs), ban
coverage degrades exactly when it is most needed.

### E8 — Recovery + orphan scan runs on every write (low/perf)

`handleSaveNote`, `handleDeleteNote`, and `handleSyncPush` all call
`recoverFileOperations()` (`handlers.go:335`, `365`, `sync_ops.go:74`), which
performs a full `file_operations` scan **and** `os.ReadDir(notesDir)`
(`file_ops.go:126-140`) on *every* mutation. On a large notes directory this
turns each write into an O(N) directory listing plus a table scan — pure
overhead in the happy path (the queue is normally empty).

### E9 — Direct prefs PATCH never publishes a change event (low)

The sync path publishes `preferences` on `prefs.save` (`sync_ops.go:109-110`),
but `handleSavePrefs` (`handlers.go:407-417`) performs the same logical change
without `publishChange`. Clients subscribed to `/api/events` are therefore not
notified of preference changes made via `PATCH /api/prefs` — an observable
inconsistency in the change-hint stream. The two paths also bypass any shared
serialization (prefs reads/writes are not covered by `noteMu`), relying solely on
the single-connection DB; last-write-wins is acceptable but undocumented.

---

## Verified non-issues (checked, not bugs)

- **gzip + `Content-Length` mismatch:** the middleware (`main.go:60-82`) wraps
  `http.FileServer`, which normally sets `Content-Length`. Verified empirically
  and against Go 1.25 `net/http/fs.go:411-412`: `serveContent` deliberately skips
  setting `Content-Length` when `Content-Encoding` is present, so responses use
  chunked encoding and never send a stale length. Safe.
- **SSE goroutine lifecycle:** `handleEvents` (`events.go:95-151`) unsubscribes on
  return, and the per-heartbeat `SetWriteDeadline` guarantees a stalled/dead
  client is reaped within ~10 s even if the TCP socket stays open. No subscriber
  or goroutine leak.
- **Lock ordering:** writers take `noteMu` → broker mutex / DB; no path acquires
  the broker mutex then `noteMu`, so no deadlock. `publish` uses non-blocking
  sends, so it cannot block under the broker lock.
- **Note cache bounded:** `noteCache` caps at 128 entries / 16 MiB and the
  overflow-guard in `set` (`cache.go:47-49`) prevents a single oversized entry
  from being cached. The staleness race in R1 is a correctness issue, not a
  memory one.
- **Sync tables compacted:** `sync_changes` (100k), `sync_operations` rows (100k)
  and payload bytes (32 MB) all have bounds (`db.go:52`, `sync_ops.go:20-21`).
- **All `sql.Rows` closed:** audit of every `db.Query`/`tx.Query` site (including
  error paths in migrations and `compactSyncOperationPayloads`) found no leaked
  rows.
