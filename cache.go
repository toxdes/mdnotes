package main

import (
	"container/list"
	"sync"
)

const (
	maxCachedNotes = 128
	maxCacheBytes  = 16 << 20 // 16 MiB
)

type cacheEntry struct {
	id      string
	content string
}

// noteCache is deliberately bounded. The source of truth is the note file, so
// caching every note forever turns a small self-hosted service into an
// unbounded in-memory copy of the whole library.
type noteCache struct {
	mu    sync.Mutex
	items map[string]*list.Element
	lru   *list.List
	bytes int
}

func newNoteCache() *noteCache {
	return &noteCache{
		items: make(map[string]*list.Element),
		lru:   list.New(),
	}
}

func (c *noteCache) get(id string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[id]
	if !ok {
		return "", false
	}
	c.lru.MoveToFront(e)
	return e.Value.(cacheEntry).content, true
}

func (c *noteCache) set(id, content string) {
	if len(content) > maxCacheBytes {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.items[id]; ok {
		old := e.Value.(cacheEntry)
		c.bytes -= len(old.content)
		e.Value = cacheEntry{id: id, content: content}
		c.bytes += len(content)
		c.lru.MoveToFront(e)
	} else {
		c.items[id] = c.lru.PushFront(cacheEntry{id: id, content: content})
		c.bytes += len(content)
	}

	for c.lru.Len() > maxCachedNotes || c.bytes > maxCacheBytes {
		e := c.lru.Back()
		entry := e.Value.(cacheEntry)
		delete(c.items, entry.id)
		c.bytes -= len(entry.content)
		c.lru.Remove(e)
	}
}

func (c *noteCache) del(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[id]
	if !ok {
		return
	}
	entry := e.Value.(cacheEntry)
	c.bytes -= len(entry.content)
	delete(c.items, id)
	c.lru.Remove(e)
}
