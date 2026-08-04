package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	sseHeartbeatInterval = 25 * time.Second
	sseReconnectDelay    = 3 * time.Second
	sseWriteTimeout      = 10 * time.Second
)

func writeSSEHeartbeat(w io.Writer) error {
	_, err := io.WriteString(w, "event: heartbeat\ndata: {}\n\n")
	return err
}

func writeSSEServerInfo(w io.Writer) error {
	data, err := json.Marshal(map[string]string{"version": version, "revision": appRevision})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: server\ndata: %s\n\n", data)
	return err
}

func setSSEWriteDeadline(w http.ResponseWriter) error {
	err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(sseWriteTimeout))
	if errors.Is(err, http.ErrNotSupported) {
		return nil
	}
	return err
}

// handleEvents keeps a lightweight authenticated stream open solely to report
// server reachability. Mutations continue to use the regular replayable HTTP
// sync API; no note content travels through this endpoint.
func (a *app) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming is not supported", http.StatusInternalServerError)
		return
	}

	// Reset a short write deadline before each heartbeat. This lets the stream
	// outlive the server's normal request timeout without allowing a stalled
	// client to hold a goroutine forever.
	if err := setSSEWriteDeadline(w); err != nil {
		http.Error(w, "could not configure stream deadline", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	if _, err := io.WriteString(w, "retry: 3000\n\n"); err != nil {
		return
	}
	if err := writeSSEServerInfo(w); err != nil {
		return
	}
	if err := writeSSEHeartbeat(w); err != nil {
		return
	}
	flusher.Flush()

	ticker := time.NewTicker(sseHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if err := setSSEWriteDeadline(w); err != nil {
				return
			}
			if err := writeSSEHeartbeat(w); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
