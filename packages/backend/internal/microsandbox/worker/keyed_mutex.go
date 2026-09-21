package worker

import "sync"

// keyedMutex serializes work for one key without retaining every key forever.
// A waiter counts as a reference, so the entry cannot be removed and replaced
// while another goroutine is blocked on the same mutex.
type keyedMutex struct {
	mu      sync.Mutex
	entries map[string]*keyedMutexEntry
}

type keyedMutexEntry struct {
	mu   sync.Mutex
	refs int
}

func (m *keyedMutex) Lock(key string) func() {
	entry := m.acquire(key)
	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		m.release(key, entry)
	}
}

func (m *keyedMutex) TryLock(key string) (func(), bool) {
	entry := m.acquire(key)
	if !entry.mu.TryLock() {
		m.release(key, entry)
		return nil, false
	}
	return func() {
		entry.mu.Unlock()
		m.release(key, entry)
	}, true
}

func (m *keyedMutex) acquire(key string) *keyedMutexEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.entries == nil {
		m.entries = make(map[string]*keyedMutexEntry)
	}
	entry := m.entries[key]
	if entry == nil {
		entry = &keyedMutexEntry{}
		m.entries[key] = entry
	}
	entry.refs++
	return entry
}

func (m *keyedMutex) release(key string, entry *keyedMutexEntry) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry.refs--
	if entry.refs == 0 && m.entries[key] == entry {
		delete(m.entries, key)
	}
}

func (m *keyedMutex) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.entries)
}
