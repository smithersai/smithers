package services

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type countingRefreshLockTx struct {
	pgx.Tx
	open *atomic.Int32
}

func (tx *countingRefreshLockTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

func (tx *countingRefreshLockTx) Rollback(context.Context) error {
	tx.open.Add(-1)
	return nil
}

type countingRefreshLockPool struct {
	open    atomic.Int32
	maxOpen atomic.Int32
}

func (p *countingRefreshLockPool) Begin(context.Context) (pgx.Tx, error) {
	n := p.open.Add(1)
	for {
		seen := p.maxOpen.Load()
		if n <= seen || p.maxOpen.CompareAndSwap(seen, n) {
			break
		}
	}
	return &countingRefreshLockTx{open: &p.open}, nil
}

// Every lock holder's fn needs a second pool connection. If lock
// transactions could take every connection at once, all fns would wait on
// each other forever; the locker must cap how many it holds and let the rest
// run unserialized.
func TestPgGitHubRefreshLocker_CapsHeldLockConnections(t *testing.T) {
	pool := &countingRefreshLockPool{}
	locker := NewPgGitHubRefreshLocker(pool)

	const callers = 20
	release := make(chan struct{})
	var started sync.WaitGroup
	var done sync.WaitGroup
	var ran atomic.Int32
	started.Add(callers)
	done.Add(callers)
	for i := 0; i < callers; i++ {
		go func() {
			defer done.Done()
			err := locker.WithUserRefreshLock(context.Background(), "workos", fmt.Sprint(i), func(context.Context) error {
				ran.Add(1)
				started.Done()
				<-release
				return nil
			})
			assert.NoError(t, err)
		}()
	}
	started.Wait()
	close(release)
	done.Wait()

	require.Equal(t, int32(callers), ran.Load(), "every refresh still runs")
	assert.LessOrEqual(t, pool.maxOpen.Load(), int32(maxHeldGitHubRefreshLocks))
	assert.Zero(t, pool.open.Load(), "every lock transaction is rolled back")
}
