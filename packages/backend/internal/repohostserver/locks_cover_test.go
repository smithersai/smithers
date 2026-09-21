package repohostserver

import "testing"

func TestLocks_Cov_LockAllWithNoKeysReturnsUsableUnlock(t *testing.T) {
	locker := newRepoLocker()
	unlock := locker.LockAll()
	unlock()

	if len(locker.locks) != 0 {
		t.Fatalf("expected no lock entries, got %d", len(locker.locks))
	}
}
