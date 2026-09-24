package services

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// racingTimelineStore widens the count-then-insert window: each count waits
// until a second concurrent count arrives (or a short timeout), so two
// unserialized creates both observe the pre-insert count.
type racingTimelineStore struct {
	*fakeAppTimelineStore
	mu      sync.Mutex
	nextID  int
	waiting chan struct{}
}

func (r *racingTimelineStore) CountAppTimelinesForOwner(ctx context.Context, ownerUserID int64) (int64, error) {
	r.mu.Lock()
	n, _ := r.fakeAppTimelineStore.CountAppTimelinesForOwner(ctx, ownerUserID)
	r.mu.Unlock()
	select {
	case r.waiting <- struct{}{}:
	case <-r.waiting:
	case <-time.After(200 * time.Millisecond):
	}
	return n, nil
}

func (r *racingTimelineStore) CreateAppTimeline(_ context.Context, arg db.CreateAppTimelineParams) (db.AppTimeline, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nextID++
	t := db.AppTimeline{ID: fmt.Sprintf("race-%d", r.nextID), OwnerUserID: arg.OwnerUserID, ClientKey: arg.ClientKey}
	r.timelines[t.ID] = t
	return t, nil
}

func (r *racingTimelineStore) GetAppTimelineByOwnerClientKey(ctx context.Context, arg db.GetAppTimelineByOwnerClientKeyParams) (db.AppTimeline, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.fakeAppTimelineStore.GetAppTimelineByOwnerClientKey(ctx, arg)
}

func (r *racingTimelineStore) UpsertAppTimelineMember(ctx context.Context, arg db.UpsertAppTimelineMemberParams) (db.AppTimelineMember, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.fakeAppTimelineStore.UpsertAppTimelineMember(ctx, arg)
}

// advisoryLocks models pg_advisory_xact_lock: Exec blocks on the key's lock
// and the transaction end releases it.
type advisoryLocks struct {
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

func (a *advisoryLocks) Begin(context.Context) (pgx.Tx, error) {
	return &advisoryLockTx{locks: a}, nil
}

type advisoryLockTx struct {
	pgx.Tx
	locks *advisoryLocks
	held  *sync.Mutex
}

func (t *advisoryLockTx) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	key := args[0].(string)
	t.locks.mu.Lock()
	if t.locks.locks == nil {
		t.locks.locks = map[string]*sync.Mutex{}
	}
	lock, ok := t.locks.locks[key]
	if !ok {
		lock = &sync.Mutex{}
		t.locks.locks[key] = lock
	}
	t.locks.mu.Unlock()
	lock.Lock()
	t.held = lock
	return pgconn.CommandTag{}, nil
}

func (t *advisoryLockTx) release() {
	if t.held != nil {
		t.held.Unlock()
		t.held = nil
	}
}

func (t *advisoryLockTx) Commit(context.Context) error   { t.release(); return nil }
func (t *advisoryLockTx) Rollback(context.Context) error { t.release(); return nil }

func TestAppTimeline_FindOrCreate_ConcurrentCreatesCannotExceedOwnerCap(t *testing.T) {
	store := &racingTimelineStore{fakeAppTimelineStore: newFakeAppTimelineStore(), waiting: make(chan struct{})}
	for i := 0; i < MaxAppTimelinesPerOwner-1; i++ {
		id := fmt.Sprintf("seed-%d", i)
		store.timelines[id] = db.AppTimeline{ID: id, OwnerUserID: 1, ClientKey: id}
	}
	s := NewAppTimelineService(store, WithAppTimelineTxBeginner(&advisoryLocks{}))

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = s.FindOrCreate(context.Background(), 1, fmt.Sprintf("client-%d", i))
		}(i)
	}
	wg.Wait()

	count, _ := store.fakeAppTimelineStore.CountAppTimelinesForOwner(context.Background(), 1)
	if count != MaxAppTimelinesPerOwner {
		t.Fatalf("owner has %d timelines, cap is %d (errs: %v)", count, MaxAppTimelinesPerOwner, errs)
	}
	if (errs[0] == nil) == (errs[1] == nil) {
		t.Fatalf("exactly one create must lose to the cap, got %v", errs)
	}
}
