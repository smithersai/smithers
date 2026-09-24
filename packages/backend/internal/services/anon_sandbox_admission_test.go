package services

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// recordingAnonTx is a pgx.Tx that records statement names in order and
// answers every COUNT with a fixed value.
type recordingAnonTx struct {
	pgx.Tx
	count      int64
	statements []string
	committed  bool
	rolledBack bool
}

func sqlcName(sql string) string {
	first, _, _ := strings.Cut(sql, "\n")
	first = strings.TrimPrefix(first, "-- name: ")
	name, _, _ := strings.Cut(first, " ")
	return name
}

func (tx *recordingAnonTx) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	tx.statements = append(tx.statements, sqlcName(sql))
	return pgconn.CommandTag{}, nil
}

func (tx *recordingAnonTx) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	tx.statements = append(tx.statements, sqlcName(sql))
	return countRow(tx.count)
}

func (tx *recordingAnonTx) Commit(context.Context) error   { tx.committed = true; return nil }
func (tx *recordingAnonTx) Rollback(context.Context) error { tx.rolledBack = true; return nil }

type countRow int64

func (r countRow) Scan(dest ...any) error {
	*(dest[0].(*int64)) = int64(r)
	return nil
}

type txAnonSandboxStore struct {
	*fakeAnonSandboxStore
	tx *recordingAnonTx
}

func (s *txAnonSandboxStore) BeginTx(context.Context) (pgx.Tx, error) { return s.tx, nil }
func (s *txAnonSandboxStore) WithTx(tx pgx.Tx) *db.Queries            { return db.New(tx) }

// The cap counts must run inside the admission lock's transaction, or
// concurrent creates all read a count below the cap and all insert.
func TestAnonSandboxCreate_CapCheckRunsUnderAdmissionLock(t *testing.T) {
	tx := &recordingAnonTx{count: 2} // global cap in testAnonConfig is 2
	store := &txAnonSandboxStore{fakeAnonSandboxStore: newFakeAnonSandboxStore(), tx: tx}
	s := NewAnonSandboxService(store, &fakeAnonVMClient{}, nil, testAnonBaseVMRequest, testAnonConfig())

	_, err := s.Create(context.Background(), "smithersai/smithers", "", "1.2.3.4")
	wantStatusErr(t, err, http.StatusTooManyRequests)
	assert.Equal(t, []string{"LockAnonSandboxAdmission", "CountActiveAnonSandboxes"}, tx.statements)
	assert.False(t, tx.committed)
	assert.True(t, tx.rolledBack)
	assert.Empty(t, store.rows, "a refused admission must not insert through the non-transactional store")
}

// Real-Postgres proof: many simultaneous creates never exceed the global cap.
func TestAnonSandboxCreate_ConcurrentCreatesHoldGlobalCap(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `DELETE FROM anon_sandboxes`)
	require.NoError(t, err)
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM anon_sandboxes`) })

	cfg := testAnonConfig()
	cfg.MaxConcurrent = 3
	cfg.MaxPerIP = 0
	// Drive admission directly: Create would also boot VMs, and the cap
	// decision is all this test checks.
	s := NewAnonSandboxService(db.New(pool), &fakeAnonVMClient{}, nil, testAnonBaseVMRequest, cfg)

	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = s.withAdmission(ctx, func(store anonSandboxAdmissionStore) error {
				_, admitErr := s.admit(ctx, store, db.CreateAnonSandboxParams{
					RepoFullName: "smithersai/smithers",
					Branch:       "main",
					TokenHash:    fmt.Sprintf("%064d", i),
					ClientIp:     "10.0.0.1",
					ExpiresAt:    s.now().UTC().Add(cfg.TTL),
				})
				return admitErr
			})
		}()
	}
	wg.Wait()

	var active int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM anon_sandboxes WHERE deleted_at IS NULL`).Scan(&active))
	assert.Equal(t, int64(3), active)
}
