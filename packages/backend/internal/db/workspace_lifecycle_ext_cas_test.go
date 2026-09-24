package db

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Real-Postgres tests for the hand-written workspace CAS statements. Service
// tests replace these with mocks, so only these tests execute the predicates.

func casTestWorkspace(t *testing.T, pool DBTX, status, vmID string) string {
	t.Helper()
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	var id string
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO workspaces (repository_id, user_id, status, vm_id, head_commit_id, ahead)
		VALUES ($1, $2, $3, $4, 'cmt-cas', 5) RETURNING id`,
		repoID, userID, status, vmID,
	).Scan(&id))
	return id
}

func TestWorkspaceCAS_ResumeWorkspaceToRunning(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	id := casTestWorkspace(t, pool, "suspended", "vm-r")
	mustExec(t, pool, `UPDATE workspaces SET suspended_at = NOW() WHERE id = $1`, id)

	resumed, err := q.ResumeWorkspaceToRunning(ctx, id)
	require.NoError(t, err)
	assert.Equal(t, "running", resumed.Status)
	assert.False(t, resumed.SuspendedAt.Valid)
	stored, err := q.GetWorkspace(ctx, id)
	require.NoError(t, err)
	assert.Equal(t, stored, resumed, "the CAS result is the whole row")

	_, err = q.ResumeWorkspaceToRunning(ctx, id)
	assert.True(t, errors.Is(err, pgx.ErrNoRows), "a running workspace does not resume again: %v", err)

	mustExec(t, pool, `UPDATE workspaces SET status = 'suspended', deleted_at = NOW() WHERE id = $1`, id)
	_, err = q.ResumeWorkspaceToRunning(ctx, id)
	assert.True(t, errors.Is(err, pgx.ErrNoRows), "a deleted workspace does not resume: %v", err)
}

// Exactly one of N concurrent resumes wins, so the active-VM gauge moves once.
func TestWorkspaceCAS_ResumeWorkspaceToRunningConcurrentOneWinner(t *testing.T) {
	ctx := context.Background()
	id := casTestWorkspace(t, sharedPool, "suspended", "vm-race")
	t.Cleanup(func() { _, _ = sharedPool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, id) })

	const racers = 8
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins, losses := 0, 0
	start := make(chan struct{})
	for range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := New(sharedPool).ResumeWorkspaceToRunning(ctx, id)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				wins++
			case errors.Is(err, pgx.ErrNoRows):
				losses++
			default:
				t.Errorf("unexpected resume error: %v", err)
			}
		}()
	}
	close(start)
	wg.Wait()
	assert.Equal(t, 1, wins)
	assert.Equal(t, racers-1, losses)
}

func TestWorkspaceCAS_SuspendRunningWorkspaceIfSessionless(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	id := casTestWorkspace(t, pool, "running", "vm-s")
	var repoID, userID int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT repository_id, user_id FROM workspaces WHERE id = $1`, id).Scan(&repoID, &userID))
	var sessionID string
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO workspace_sessions (workspace_id, repository_id, user_id, cols, rows, status)
		VALUES ($1, $2, $3, 80, 24, 'running') RETURNING id`, id, repoID, userID).Scan(&sessionID))

	_, err := q.SuspendRunningWorkspaceIfSessionless(ctx, id)
	assert.True(t, errors.Is(err, pgx.ErrNoRows), "an active session blocks suspend: %v", err)

	mustExec(t, pool, `UPDATE workspace_sessions SET status = 'stopped' WHERE id = $1`, sessionID)
	suspended, err := q.SuspendRunningWorkspaceIfSessionless(ctx, id)
	require.NoError(t, err)
	assert.Equal(t, "suspended", suspended.Status)
	assert.True(t, suspended.SuspendedAt.Valid)
	stored, err := q.GetWorkspace(ctx, id)
	require.NoError(t, err)
	assert.Equal(t, stored, suspended, "the CAS result is the whole row")
	assert.Equal(t, int32(5), suspended.Ahead)

	_, err = q.SuspendRunningWorkspaceIfSessionless(ctx, id)
	assert.True(t, errors.Is(err, pgx.ErrNoRows), "a suspended workspace does not suspend again: %v", err)
}

func TestWorkspaceCAS_StaleStartingWorkspaceReaper(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	stale := casTestWorkspace(t, pool, "starting", "vm-stale")
	fresh := casTestWorkspace(t, pool, "starting", "vm-fresh")
	noVM := casTestWorkspace(t, pool, "starting", "")
	mustExec(t, pool, `UPDATE workspaces SET updated_at = NOW() - INTERVAL '1 hour' WHERE id = ANY($1)`, []string{stale, noVM})

	listed, err := q.ListStaleStartingWorkspacesWithVM(ctx, int32((10 * time.Minute).Seconds()))
	require.NoError(t, err)
	ids := make([]string, 0, len(listed))
	for _, w := range listed {
		ids = append(ids, w.ID)
	}
	assert.Contains(t, ids, stale)
	assert.NotContains(t, ids, fresh, "a live provision inside the window is not stale")
	assert.NotContains(t, ids, noVM, "a VM-less row belongs to the pending reaper")
	for _, w := range listed {
		if w.ID == stale {
			assert.Equal(t, "cmt-cas", w.HeadCommitID)
		}
	}

	_, err = q.FailStaleStartingWorkspace(ctx, FailStaleStartingWorkspaceParams{ID: fresh, StaleAfterSecs: 600})
	assert.True(t, errors.Is(err, pgx.ErrNoRows), "a fresh starting row is left alone: %v", err)

	// A provision that finished between list and fail matches no rows.
	mustExec(t, pool, `UPDATE workspaces SET status = 'running' WHERE id = $1`, stale)
	_, err = q.FailStaleStartingWorkspace(ctx, FailStaleStartingWorkspaceParams{ID: stale, StaleAfterSecs: 600})
	assert.True(t, errors.Is(err, pgx.ErrNoRows), "a row that left starting is not failed: %v", err)

	mustExec(t, pool, `UPDATE workspaces SET status = 'starting', updated_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, stale)
	failed, err := q.FailStaleStartingWorkspace(ctx, FailStaleStartingWorkspaceParams{ID: stale, StaleAfterSecs: 600})
	require.NoError(t, err)
	assert.Equal(t, "failed", failed.Status)
	assert.Equal(t, int32(5), failed.Ahead)
}

func TestOAuth2AuthorizationCodeByHashReadsOnlyLiveCodes(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	user := mustCreateUser(t, pool, uniqueTestUsername(t))
	app, err := q.CreateOAuth2Application(ctx, CreateOAuth2ApplicationParams{ClientID: "cas-" + uniqueTestUsername(t), Name: "CAS test", OwnerID: user, Scopes: []string{"read:repository"}, RedirectUris: []string{"https://example.invalid/cb"}})
	require.NoError(t, err)
	create := func(hash string, expiresAt time.Time) {
		t.Helper()
		require.NoError(t, q.CreateOAuth2AuthorizationCode(ctx, CreateOAuth2AuthorizationCodeParams{
			CodeHash: hash, AppID: app.ID, UserID: user, Scopes: []string{"read:repository"},
			RedirectUri: "https://example.invalid/cb", CodeChallenge: "chal", CodeChallengeMethod: "S256", ExpiresAt: expiresAt,
		}))
	}
	create("live-"+app.ClientID, time.Now().Add(time.Minute))
	create("expired-"+app.ClientID, time.Now().Add(-time.Minute))

	got, err := q.GetOAuth2AuthorizationCodeByHash(ctx, "live-"+app.ClientID)
	require.NoError(t, err)
	assert.Equal(t, app.ID, got.AppID)
	assert.Equal(t, "chal", got.CodeChallenge)
	assert.False(t, got.UsedAt.Valid)

	// Reading does not consume: a second read still finds the code.
	_, err = q.GetOAuth2AuthorizationCodeByHash(ctx, "live-"+app.ClientID)
	require.NoError(t, err)

	_, err = q.GetOAuth2AuthorizationCodeByHash(ctx, "expired-"+app.ClientID)
	assert.True(t, errors.Is(err, pgx.ErrNoRows), "an expired code is not readable: %v", err)

	_, err = q.ConsumeOAuth2AuthorizationCode(ctx, "live-"+app.ClientID)
	require.NoError(t, err)
	_, err = q.GetOAuth2AuthorizationCodeByHash(ctx, "live-"+app.ClientID)
	assert.True(t, errors.Is(err, pgx.ErrNoRows), "a consumed code is not readable: %v", err)
}
