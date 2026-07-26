package main

import "sync"

type noteCache struct {
	mu   sync.RWMutex
	data map[string][]byte
}

func newNoteCache() *noteCache {
	return &noteCache{data: make(map[string][]byte)}
}

func (c *noteCache) get(id string) ([]byte, bool) {
	c.mu.RLock()
	v, ok := c.data[id]
	c.mu.RUnlock()
	return v, ok
}

func (c *noteCache) set(id string, content []byte) {
	c.mu.Lock()
	c.data[id] = content
	c.mu.Unlock()
}

func (c *noteCache) del(id string) {
	c.mu.Lock()
	delete(c.data, id)
	c.mu.Unlock()
}
