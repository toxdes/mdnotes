package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	fileOperationReplace = "replace"
	fileOperationDelete  = "delete"
	stageFilePrefix      = ".mdnotes-stage-"
)

type fileOperation struct {
	ID           string
	Action       string
	NoteID       string
	StageName    string
	ExpectedHash string
}

func fileContentHash(content []byte) string {
	hash := sha256.Sum256(content)
	return hex.EncodeToString(hash[:])
}

func fileMatchesHash(path, expected string) (bool, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	return fileContentHash(content) == expected, nil
}

func stageNoteFile(notesDir string, content []byte) (string, error) {
	tmp, err := os.CreateTemp(notesDir, stageFilePrefix+"*")
	if err != nil {
		return "", err
	}
	path := tmp.Name()
	remove := true
	defer func() {
		if remove {
			_ = os.Remove(path)
		}
	}()
	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	remove = false
	return filepath.Base(path), nil
}

func recordFileOperation(tx *sql.Tx, operation fileOperation) error {
	_, err := tx.Exec("INSERT INTO file_operations (id, action, note_id, stage_name, expected_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)", operation.ID, operation.Action, operation.NoteID, operation.StageName, operation.ExpectedHash, time.Now().UTC().Format(time.RFC3339))
	return err
}

func (a *app) recoverFileOperations() error {
	rows, err := a.db.Query("SELECT id, action, note_id, stage_name, expected_hash FROM file_operations ORDER BY created_at, id")
	if err != nil {
		return err
	}
	operations := make([]fileOperation, 0)
	for rows.Next() {
		var operation fileOperation
		if err := rows.Scan(&operation.ID, &operation.Action, &operation.NoteID, &operation.StageName, &operation.ExpectedHash); err != nil {
			rows.Close()
			return err
		}
		operations = append(operations, operation)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, operation := range operations {
		if err := a.completeFileOperation(operation); err != nil {
			return err
		}
	}
	return a.removeOrphanedStageFiles()
}

func (a *app) completeFileOperation(operation fileOperation) error {
	if !noteIDPattern.MatchString(operation.NoteID) {
		return errors.New("invalid file operation note id")
	}
	target, err := sanitizePath(a.notesDir, operation.NoteID+".md")
	if err != nil {
		return err
	}
	switch operation.Action {
	case fileOperationReplace:
		if !strings.HasPrefix(operation.StageName, stageFilePrefix) || filepath.Base(operation.StageName) != operation.StageName {
			return errors.New("invalid staged file name")
		}
		stage, err := sanitizePath(a.notesDir, operation.StageName)
		if err != nil {
			return err
		}
		if operation.ExpectedHash != "" {
			matches, hashErr := fileMatchesHash(stage, operation.ExpectedHash)
			if hashErr != nil && !errors.Is(hashErr, os.ErrNotExist) {
				return hashErr
			}
			if hashErr == nil && !matches {
				return errors.New("staged replacement hash does not match")
			}
		}
		if err := os.Rename(stage, target); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				return err
			}
			if operation.ExpectedHash == "" {
				return errors.New("staged replacement is missing and has no expected hash")
			}
			matches, targetErr := fileMatchesHash(target, operation.ExpectedHash)
			if targetErr != nil {
				return fmt.Errorf("staged replacement is missing: %w", targetErr)
			}
			if !matches {
				return errors.New("staged replacement target hash does not match")
			}
		}
	case fileOperationDelete:
		if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	default:
		return errors.New("unknown file operation")
	}
	_, err = a.db.Exec("DELETE FROM file_operations WHERE id = ?", operation.ID)
	return err
}

func (a *app) removeOrphanedStageFiles() error {
	entries, err := os.ReadDir(a.notesDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), stageFilePrefix) {
			continue
		}
		if err := os.Remove(filepath.Join(a.notesDir, entry.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (a *app) saveNoteWithFileOperation(id, title, tags, content string, expectedRevision *int64) (*note, error) {
	enc, err := a.encryption.encryptNote([]byte(content), id)
	if err != nil {
		return nil, err
	}
	stageName, err := stageNoteFile(a.notesDir, enc)
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(filepath.Join(a.notesDir, stageName))
		}
	}()

	tx, err := a.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if expectedRevision != nil {
		if _, err := checkNoteRevisionTx(tx, id, *expectedRevision); err != nil {
			return nil, err
		}
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := upsertNoteTx(tx, id, title, id+".md", normalizeTags(tags), now); err != nil {
		return nil, err
	}
	operationID, err := randID()
	if err != nil {
		return nil, err
	}
	operation := fileOperation{ID: operationID, Action: fileOperationReplace, NoteID: id, StageName: stageName, ExpectedHash: fileContentHash(enc)}
	if err := recordFileOperation(tx, operation); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	committed = true
	if err := a.completeFileOperation(operation); err != nil {
		return nil, err
	}
	a.noteCache.set(id, content)
	return getNote(a.db, id)
}

func (a *app) deleteNoteWithFileOperation(id string, expectedRevision *int64) error {
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if expectedRevision != nil {
		if _, err := checkNoteRevisionTx(tx, id, *expectedRevision); err != nil {
			return err
		}
	}
	if _, err := getNoteTx(tx, id); err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := deleteNoteTx(tx, id, now); err != nil {
		return err
	}
	operationID, err := randID()
	if err != nil {
		return err
	}
	operation := fileOperation{ID: operationID, Action: fileOperationDelete, NoteID: id}
	if err := recordFileOperation(tx, operation); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if err := a.completeFileOperation(operation); err != nil {
		return err
	}
	a.noteCache.del(id)
	return nil
}
