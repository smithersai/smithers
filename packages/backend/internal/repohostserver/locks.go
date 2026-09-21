package repohostserver

import (
	"sort"
	"sync"
)

type repoLocker struct {
	mu    sync.Mutex
	locks map[string]*repoLockEntry
}

type repoLockEntry struct {
	mu   sync.RWMutex
	refs int
}

func newRepoLocker() *repoLocker {
	return &repoLocker{locks: map[string]*repoLockEntry{}}
}

func (l *repoLocker) Lock(key string) func() {
	entry := l.acquire(key)
	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		l.release(key, entry)
	}
}

func (l *repoLocker) LockAll(keys ...string) func() {
	if len(keys) == 0 {
		return func() {}
	}

	ordered := append([]string(nil), keys...)
	sort.Strings(ordered)
	deduped := ordered[:0]
	for _, key := range ordered {
		if len(deduped) == 0 || deduped[len(deduped)-1] != key {
			deduped = append(deduped, key)
		}
	}

	unlocks := make([]func(), 0, len(deduped))
	for _, key := range deduped {
		unlocks = append(unlocks, l.Lock(key))
	}
	return func() {
		for i := len(unlocks) - 1; i >= 0; i-- {
			unlocks[i]()
		}
	}
}

func (l *repoLocker) RLock(key string) func() {
	entry := l.acquire(key)
	entry.mu.RLock()
	return func() {
		entry.mu.RUnlock()
		l.release(key, entry)
	}
}

func (l *repoLocker) acquire(key string) *repoLockEntry {
	l.mu.Lock()
	entry := l.locks[key]
	if entry == nil {
		entry = &repoLockEntry{}
		l.locks[key] = entry
	}
	entry.refs++
	l.mu.Unlock()
	return entry
}

func (l *repoLocker) release(key string, entry *repoLockEntry) {
	l.mu.Lock()
	entry.refs--
	if entry.refs == 0 {
		delete(l.locks, key)
	}
	l.mu.Unlock()
}
