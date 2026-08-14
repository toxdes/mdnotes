package main

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

const (
	maxSyncPushBytes          = 4 << 20
	compactedOperationPayload = `{"compacted":true}`
)

var maxSyncOperationPayloadBytes int64 = 32 << 20
var maxSyncOperationAcknowledgements int64 = 100000

var syncIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

type syncPushRequest struct {
	DeviceID   string                 `json:"device_id"`
	Operations []syncOperationRequest `json:"operations"`
}

type syncOperationRequest struct {
	ClientSequence int64  `json:"client_sequence"`
	OpID           string `json:"op_id"`
	Type           string `json:"type"`
	NoteID         string `json:"note_id,omitempty"`
	BaseRevision   *int64 `json:"base_revision,omitempty"`
	Title          string `json:"title,omitempty"`
	Tags           string `json:"tags,omitempty"`
	Content        string `json:"content,omitempty"`
	BaseContent    string `json:"base_content,omitempty"`
	Prefs          *prefs `json:"prefs,omitempty"`
}

type syncOperationResult struct {
	ClientSequence  int64  `json:"client_sequence"`
	OpID            string `json:"op_id"`
	Status          string `json:"status"`
	Revision        int64  `json:"revision,omitempty"`
	CurrentRevision int64  `json:"current_revision,omitempty"`
}

type syncPushResponse struct {
	Acknowledged     []syncOperationResult `json:"acknowledged"`
	ExpectedSequence int64                 `json:"expected_sequence"`
}

func (a *app) handleSyncPush(w http.ResponseWriter, r *http.Request) {
	var request syncPushRequest
	if !decodeJSON(w, r, &request, maxSyncPushBytes) {
		return
	}
	if !syncIdentifierPattern.MatchString(request.DeviceID) || len(request.Operations) > 100 {
		http.Error(w, "invalid sync request", http.StatusBadRequest)
		return
	}
	for index, operation := range request.Operations {
		if err := validateSyncOperation(operation); err != nil {
			writeJSONStatus(w, http.StatusBadRequest, map[string]any{
				"error":           err.Error(),
				"code":            "invalid_sync_operation",
				"permanent":       true,
				"operation_index": index,
				"client_sequence": operation.ClientSequence,
				"op_id":           operation.OpID,
			})
			return
		}
	}

	a.noteMu.Lock()
	defer a.noteMu.Unlock()
	if err := a.recoverFileOperations(); err != nil {
		http.Error(w, "could not recover pending file operations", http.StatusInternalServerError)
		return
	}
	for _, operation := range request.Operations {
		if operation.Type != "note.save" && operation.Type != "note.delete" {
			continue
		}
		if blocked, err := a.fileOperationBlocked(operation.NoteID); err != nil {
			http.Error(w, "could not inspect pending file operations", http.StatusInternalServerError)
			return
		} else if blocked {
			writeJSONStatus(w, http.StatusServiceUnavailable, map[string]any{
				"error":   "note file recovery requires attention",
				"code":    "note_file_recovery_blocked",
				"note_id": operation.NoteID,
			})
			return
		}
	}

	lastSequence, err := syncDeviceSequence(a.db, request.DeviceID)
	if err != nil {
		http.Error(w, "could not read sync state", http.StatusInternalServerError)
		return
	}
	response := syncPushResponse{Acknowledged: make([]syncOperationResult, 0, len(request.Operations)), ExpectedSequence: lastSequence + 1}
	for _, operation := range request.Operations {
		if operation.ClientSequence <= lastSequence {
			stored, err := storedSyncOperation(a.db, request.DeviceID, operation.ClientSequence, operation.OpID)
			if errors.Is(err, sql.ErrNoRows) {
				response.Acknowledged = append(response.Acknowledged, syncOperationResult{ClientSequence: operation.ClientSequence, OpID: operation.OpID, Status: "compacted"})
				continue
			}
			if err != nil {
				http.Error(w, "invalid replayed operation", http.StatusConflict)
				return
			}
			response.Acknowledged = append(response.Acknowledged, stored)
			continue
		}
		if operation.ClientSequence != lastSequence+1 {
			writeJSONStatus(w, http.StatusConflict, response)
			return
		}
		result, err := a.applySyncOperation(request.DeviceID, operation)
		if err != nil {
			http.Error(w, "could not apply sync operation", http.StatusInternalServerError)
			return
		}
		if result.Status == "applied" {
			if operation.Type == "prefs.save" {
				a.publishChange("preferences")
			} else if operation.Type == "note.save" || operation.Type == "note.delete" {
				a.publishChange("notes")
			}
		}
		response.Acknowledged = append(response.Acknowledged, result)
		lastSequence = operation.ClientSequence
		response.ExpectedSequence = lastSequence + 1
	}
	writeJSON(w, response)
}

func validateSyncOperation(operation syncOperationRequest) error {
	if operation.ClientSequence < 1 || !syncIdentifierPattern.MatchString(operation.OpID) {
		return errors.New("invalid sync operation")
	}
	switch operation.Type {
	case "note.save":
		if !noteIDPattern.MatchString(operation.NoteID) || operation.BaseRevision == nil || len(operation.Title) > maxTitleBytes || len(operation.Tags) > maxTagsBytes {
			return errors.New("invalid note save operation")
		}
	case "note.delete":
		if !noteIDPattern.MatchString(operation.NoteID) || operation.BaseRevision == nil || *operation.BaseRevision < 1 {
			return errors.New("invalid note delete operation")
		}
	case "prefs.save":
		if operation.Prefs == nil {
			return errors.New("invalid preferences operation")
		}
	case "noop":
	default:
		return errors.New("unknown sync operation")
	}
	return nil
}

func syncDeviceSequence(db *sql.DB, deviceID string) (int64, error) {
	if _, err := db.Exec("INSERT OR IGNORE INTO sync_device_state (device_id, last_sequence) VALUES (?, 0)", deviceID); err != nil {
		return 0, err
	}
	var sequence int64
	err := db.QueryRow("SELECT last_sequence FROM sync_device_state WHERE device_id = ?", deviceID).Scan(&sequence)
	return sequence, err
}

func storedSyncOperation(db *sql.DB, deviceID string, sequence int64, opID string) (syncOperationResult, error) {
	var storedOpID, encoded string
	if err := db.QueryRow("SELECT op_id, result FROM sync_operations WHERE device_id = ? AND client_sequence = ?", deviceID, sequence).Scan(&storedOpID, &encoded); err != nil {
		return syncOperationResult{}, err
	}
	if storedOpID != opID {
		return syncOperationResult{}, errors.New("operation sequence belongs to another operation")
	}
	var result syncOperationResult
	if err := json.Unmarshal([]byte(encoded), &result); err != nil {
		return syncOperationResult{}, err
	}
	return result, nil
}

var preferenceFieldNames = map[string]struct{}{
	"autoSave":               {},
	"hidePreview":            {},
	"hideHeaderOnFullscreen": {},
	"hideToolbar":            {},
	"collapseDetails":        {},
	"hideCursorHighlight":    {},
	"theme":                  {},
	"accentColor":            {},
	"fontFamily":             {},
	"editorFontFamily":       {},
	"previewFontFamily":      {},
}

func preferenceFields(p *prefs) (map[string]json.RawMessage, error) {
	encoded, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	fields := make(map[string]json.RawMessage)
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return nil, err
	}
	delete(fields, "revision")
	delete(fields, "_sync_patch")
	delete(fields, "_sync_base")
	return fields, nil
}

func jsonValuesEqual(left, right json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(left), bytes.TrimSpace(right))
}

func preferencePatchConflicts(current *prefs, operation *prefs) (bool, error) {
	currentFields, err := preferenceFields(current)
	if err != nil {
		return false, err
	}
	for key, desired := range operation.SyncPatch {
		if _, ok := preferenceFieldNames[key]; !ok {
			return false, fmt.Errorf("unknown preference field %q", key)
		}
		base, ok := operation.SyncBase[key]
		if !ok {
			return true, nil
		}
		currentValue, exists := currentFields[key]
		if !exists {
			currentValue = json.RawMessage(`""`)
		}
		if !jsonValuesEqual(currentValue, base) && !jsonValuesEqual(currentValue, desired) {
			return true, nil
		}
	}
	return false, nil
}

func applyPreferencePatch(current *prefs, patch map[string]json.RawMessage) (*prefs, error) {
	fields, err := preferenceFields(current)
	if err != nil {
		return nil, err
	}
	for key, value := range patch {
		if _, ok := preferenceFieldNames[key]; !ok {
			return nil, fmt.Errorf("unknown preference field %q", key)
		}
		if !json.Valid(value) {
			return nil, fmt.Errorf("invalid preference value for %q", key)
		}
		fields[key] = value
	}
	encoded, err := json.Marshal(fields)
	if err != nil {
		return nil, err
	}
	var next prefs
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&next); err != nil {
		return nil, err
	}
	next.Revision = current.Revision
	return &next, nil
}

func (a *app) applySyncOperation(deviceID string, operation syncOperationRequest) (syncOperationResult, error) {
	tx, err := a.db.Begin()
	if err != nil {
		return syncOperationResult{}, err
	}
	defer tx.Rollback()

	result := syncOperationResult{ClientSequence: operation.ClientSequence, OpID: operation.OpID, Status: "applied"}
	now := time.Now().UTC().Format(time.RFC3339)
	var stagedName string
	committed := false
	defer func() {
		if !committed && stagedName != "" {
			_ = os.Remove(filepath.Join(a.notesDir, stagedName))
		}
	}()
	var pendingFileOperation *fileOperation
	var cachedContent *string
	switch operation.Type {
	case "note.save":
		currentRevision, err := checkNoteRevisionTx(tx, operation.NoteID, *operation.BaseRevision)
		if errors.Is(err, errRevisionConflict) {
			result.Status = "conflict"
			result.CurrentRevision = currentRevision
			break
		}
		if err != nil {
			return syncOperationResult{}, err
		}
		enc, err := a.encryption.encryptNote([]byte(operation.Content), operation.NoteID)
		if err != nil {
			return syncOperationResult{}, err
		}
		stagedName, err = stageNoteFile(a.notesDir, enc)
		if err != nil {
			return syncOperationResult{}, err
		}
		if err := upsertNoteTx(tx, operation.NoteID, operation.Title, operation.NoteID+".md", normalizeTags(operation.Tags), now); err != nil {
			return syncOperationResult{}, err
		}
		if err := tx.QueryRow("SELECT revision FROM notes WHERE id = ?", operation.NoteID).Scan(&result.Revision); err != nil {
			return syncOperationResult{}, err
		}
		fileOperationID, err := randID()
		if err != nil {
			return syncOperationResult{}, err
		}
		pendingFileOperation = &fileOperation{ID: fileOperationID, Action: fileOperationReplace, NoteID: operation.NoteID, StageName: stagedName, ExpectedHash: fileContentHash(enc)}
		if err := recordFileOperation(tx, *pendingFileOperation); err != nil {
			return syncOperationResult{}, err
		}
		cachedContent = &operation.Content
	case "note.delete":
		currentRevision, err := checkNoteRevisionTx(tx, operation.NoteID, *operation.BaseRevision)
		if errors.Is(err, errRevisionConflict) {
			result.Status = "conflict"
			result.CurrentRevision = currentRevision
			break
		}
		if err != nil {
			return syncOperationResult{}, err
		}
		n, err := getNoteTx(tx, operation.NoteID)
		if err != nil {
			return syncOperationResult{}, err
		}
		if err := deleteNoteTx(tx, operation.NoteID, now); err != nil {
			return syncOperationResult{}, err
		}
		result.Revision = currentRevision + 1
		fileOperationID, err := randID()
		if err != nil {
			return syncOperationResult{}, err
		}
		pendingFileOperation = &fileOperation{ID: fileOperationID, Action: fileOperationDelete, NoteID: n.ID}
		if err := recordFileOperation(tx, *pendingFileOperation); err != nil {
			return syncOperationResult{}, err
		}
	case "prefs.save":
		current, err := getPrefsTx(tx)
		if err != nil {
			return syncOperationResult{}, err
		}
		if len(operation.Prefs.SyncPatch) > 0 {
			if operation.BaseRevision != nil && *operation.BaseRevision != current.Revision {
				conflict, err := preferencePatchConflicts(current, operation.Prefs)
				if err != nil {
					return syncOperationResult{}, err
				}
				if conflict {
					result.Status = "conflict"
					result.CurrentRevision = current.Revision
					break
				}
			}
			next, err := applyPreferencePatch(current, operation.Prefs.SyncPatch)
			if err != nil {
				return syncOperationResult{}, err
			}
			if err := savePrefsTx(tx, next, nil); err != nil {
				return syncOperationResult{}, err
			}
			result.Revision = next.Revision
			break
		}
		if operation.BaseRevision != nil && *operation.BaseRevision != current.Revision {
			result.Status = "conflict"
			result.CurrentRevision = current.Revision
			break
		}
		if err := savePrefsTx(tx, operation.Prefs, nil); err != nil {
			return syncOperationResult{}, err
		}
		result.Revision = operation.Prefs.Revision
	case "noop":
	}

	encoded, err := json.Marshal(result)
	if err != nil {
		return syncOperationResult{}, err
	}
	encodedOperation, err := a.encodeSyncOperation(deviceID, operation)
	if err != nil {
		return syncOperationResult{}, err
	}
	if _, err := tx.Exec("INSERT INTO sync_operations (device_id, client_sequence, op_id, op_type, result, operation, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)", deviceID, operation.ClientSequence, operation.OpID, operation.Type, string(encoded), encodedOperation, now); err != nil {
		return syncOperationResult{}, err
	}
	if _, err := tx.Exec("UPDATE sync_operation_stats SET operation_count = operation_count + 1, payload_bytes = payload_bytes + ? WHERE id = 1", len(encodedOperation)); err != nil {
		return syncOperationResult{}, err
	}
	if err := compactSyncOperationPayloads(tx); err != nil {
		return syncOperationResult{}, err
	}
	if err := compactSyncOperationAcknowledgements(tx); err != nil {
		return syncOperationResult{}, err
	}
	if _, err := tx.Exec("UPDATE sync_device_state SET last_sequence = ? WHERE device_id = ?", operation.ClientSequence, deviceID); err != nil {
		return syncOperationResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return syncOperationResult{}, err
	}
	committed = true
	if pendingFileOperation != nil {
		if err := a.completeFileOperation(*pendingFileOperation); err != nil {
			return syncOperationResult{}, err
		}
	}
	if cachedContent != nil {
		a.noteCache.set(operation.NoteID, *cachedContent)
	} else if operation.Type == "note.delete" {
		a.noteCache.del(operation.NoteID)
	}
	return result, nil
}

func compactSyncOperationAcknowledgements(tx *sql.Tx) error {
	var count int64
	if err := tx.QueryRow("SELECT operation_count FROM sync_operation_stats WHERE id = 1").Scan(&count); err != nil {
		return err
	}
	if count <= maxSyncOperationAcknowledgements {
		return nil
	}
	result, err := tx.Exec(`DELETE FROM sync_operations WHERE rowid IN (
		SELECT rowid FROM sync_operations
		ORDER BY applied_at, device_id, client_sequence
		LIMIT ?
	)`, count-maxSyncOperationAcknowledgements)
	if err != nil {
		return err
	}
	removed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	_, err = tx.Exec("UPDATE sync_operation_stats SET operation_count = operation_count - ? WHERE id = 1", removed)
	return err
}

func compactSyncOperationPayloads(tx *sql.Tx) error {
	var total int64
	if err := tx.QueryRow("SELECT payload_bytes FROM sync_operation_stats WHERE id = 1").Scan(&total); err != nil {
		return err
	}
	if total <= maxSyncOperationPayloadBytes {
		return nil
	}
	type storedPayload struct {
		rowID int64
		size  int64
	}
	for total > maxSyncOperationPayloadBytes {
		rows, err := tx.Query(`SELECT rowid, length(operation) FROM sync_operations
			WHERE operation != ?
			ORDER BY applied_at, device_id, client_sequence
			LIMIT 100`, compactedOperationPayload)
		if err != nil {
			return err
		}
		payloads := make([]storedPayload, 0, 100)
		for rows.Next() {
			var payload storedPayload
			if err := rows.Scan(&payload.rowID, &payload.size); err != nil {
				rows.Close()
				return err
			}
			payloads = append(payloads, payload)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if len(payloads) == 0 {
			break
		}
		var reduced int64
		for _, payload := range payloads {
			result, err := tx.Exec("UPDATE sync_operations SET operation = ? WHERE rowid = ? AND operation != ?", compactedOperationPayload, payload.rowID, compactedOperationPayload)
			if err != nil {
				return err
			}
			changed, err := result.RowsAffected()
			if err != nil {
				return err
			}
			if changed > 0 {
				reduced += payload.size - int64(len(compactedOperationPayload))
			}
		}
		if reduced <= 0 {
			break
		}
		total -= reduced
		if _, err := tx.Exec("UPDATE sync_operation_stats SET payload_bytes = ? WHERE id = 1", total); err != nil {
			return err
		}
	}
	return nil
}

func (a *app) encodeSyncOperation(deviceID string, operation syncOperationRequest) (string, error) {
	data, err := json.Marshal(operation)
	if err != nil {
		return "", err
	}
	if a.encryption == nil {
		return string(data), nil
	}
	encoded, err := a.encryption.encryptNote(data, "sync-operation:"+deviceID+":"+operation.OpID)
	if err != nil {
		return "", err
	}
	return "enc:" + base64.RawStdEncoding.EncodeToString(encoded), nil
}

func checkNoteRevisionTx(tx *sql.Tx, id string, expected int64) (int64, error) {
	var revision int64
	err := tx.QueryRow("SELECT revision FROM notes WHERE id = ?", id).Scan(&revision)
	if err == nil {
		if revision != expected {
			return revision, errRevisionConflict
		}
		return revision, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	if err := tx.QueryRow("SELECT COALESCE(MAX(revision), 0) FROM sync_changes WHERE note_id = ?", id).Scan(&revision); err != nil {
		return 0, err
	}
	if expected != 0 || revision != 0 {
		return revision, errRevisionConflict
	}
	return 0, nil
}

func getNoteTx(tx *sql.Tx, id string) (*note, error) {
	var n note
	err := tx.QueryRow("SELECT id, title, filename, tags, created_at, updated_at, revision FROM notes WHERE id = ?", id).Scan(&n.ID, &n.Title, &n.Filename, &n.Tags, &n.CreatedAt, &n.UpdatedAt, &n.Revision)
	if err != nil {
		return nil, err
	}
	return &n, nil
}

func removeNoteFile(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
