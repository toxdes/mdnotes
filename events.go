package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// eventBroker fans out small, content-free change hints. The durable sync API
// remains authoritative, so a dropped hint is harmless and the client can
// always catch up on its next normal sync.
type eventBroker struct {
	mu          sync.Mutex
	subscribers map[chan string]struct{}
}

func newEventBroker() *eventBroker {
	return &eventBroker{subscribers: make(map[chan string]struct{})}
}

func (b *eventBroker) subscribe() chan string {
	ch := make(chan string, 1)
	b.mu.Lock()
	b.subscribers[ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

func (b *eventBroker) unsubscribe(ch chan string) {
	b.mu.Lock()
	delete(b.subscribers, ch)
	b.mu.Unlock()
}

func (b *eventBroker) publish(kind string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subscribers {
		select {
		case ch <- kind:
		default:
		}
	}
}

func (a *app) publishChange(kind string) {
	if a.events != nil {
		a.events.publish(kind)
	}
}

const (
	sseHeartbeatInterval = 25 * time.Second
	sseReconnectDelay    = 3 * time.Second
	sseWriteTimeout      = 10 * time.Second
)

func writeSSEHeartbeat(w io.Writer) error {
	_, err := io.WriteString(w, "event: heartbeat\ndata: {}\n\n")
	return err
}

func writeSSEChange(w io.Writer, kind string) error {
	data, err := json.Marshal(map[string]string{"type": kind})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: change\ndata: %s\n\n", data)
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

// handleEvents keeps an authenticated stream open for reachability and tiny
// change hints. Mutations and note content continue to use normal HTTP sync.
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
	var changes chan string
	if a.events != nil {
		changes = a.events.subscribe()
		defer a.events.unsubscribe(changes)
	}
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
		case kind := <-changes:
			if err := setSSEWriteDeadline(w); err != nil {
				return
			}
			if err := writeSSEChange(w, kind); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
