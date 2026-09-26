package product

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// reviewDatabase creates an isolated database and applies the registered
// product migrations up to version (0 means every migration).
func reviewDatabase(t *testing.T, version int) *pgxpool.Pool {
	t.Helper()
	pool := newProductTestPool(t)
	ctx := context.Background()
	migrations, err := registeredMigrations()
	require.NoError(t, err)
	if version > 0 {
		migrations = migrations[:version]
	}
	require.NoError(t, applyOnce(ctx, pool, migrations))
	return pool
}

func reviewRepo(t *testing.T, p *pgxpool.Pool) int64 {
	t.Helper()
	_, err := p.Exec(t.Context(), `INSERT INTO users (id, username, lower_username) VALUES (1,'alice','alice'),(2,'bob','bob'),(3,'carol','carol')`)
	require.NoError(t, err)
	var repo int64
	err = p.QueryRow(t.Context(), `INSERT INTO repositories (user_id,name,lower_name) VALUES (1,'review','review') RETURNING id`).Scan(&repo)
	require.NoError(t, err)
	return repo
}

// The generated revocation queries must run against a fresh database and
// against one upgraded from the version that predates key_fingerprint.
func TestReviewRevocationsFreshAndV15Upgrade(t *testing.T) {
	for _, version := range []int{0, 15} {
		name := "fresh"
		if version == 15 {
			name = "upgrade15"
		}
		t.Run(name, func(t *testing.T) {
			p := reviewDatabase(t, version)
			ctx := t.Context()
			_, err := p.Exec(ctx, `INSERT INTO revocation_events(kind) VALUES ('token_revoked')`)
			require.NoError(t, err)
			require.NoError(t, Apply(ctx, p))
			q := db.New(p)
			rows, err := q.ListRevocationEventsAfter(ctx, db.ListRevocationEventsAfterParams{LimitCount: 100})
			require.NoError(t, err)
			require.Len(t, rows, 1)
			require.Empty(t, rows[0].KeyFingerprint)
			for _, kind := range []string{"token_revoked", "token_scopes_narrowed", "user_disabled", "user_enabled", "collaborator_removed", "workspace_share_removed", "agent_session_cancelled", "org_member_removed", "gateway_revoked", "ssh_key_revoked"} {
				row, err := q.InsertRevocationEvent(ctx, db.InsertRevocationEventParams{Kind: kind, KeyFingerprint: "SHA256:review", SandboxIds: []string{}})
				require.NoError(t, err)
				replay, err := q.ListRevocationEventsAfter(ctx, db.ListRevocationEventsAfterParams{AfterID: row.ID - 1, LimitCount: 1})
				require.NoError(t, err)
				require.Len(t, replay, 1)
				require.Equal(t, kind, replay[0].Kind)
				require.Equal(t, "SHA256:review", replay[0].KeyFingerprint)
			}
			_, err = p.Exec(ctx, `INSERT INTO revocation_events(kind) VALUES ('unknown')`)
			require.Error(t, err)
		})
	}
}

// UpsertPendingWorkflowCache must return the row it wrote, both for a brand
// new key and for a reservation it took over, not the pre-statement snapshot.
func TestReviewWorkflowCacheReservationReturnsCommittedRow(t *testing.T) {
	for _, update := range []bool{false, true} {
		name := "insert"
		if update {
			name = "update"
		}
		t.Run(name, func(t *testing.T) {
			p := reviewDatabase(t, 0)
			repo := reviewRepo(t, p)
			ctx := t.Context()
			q := db.New(p)
			var def, run int64
			require.NoError(t, p.QueryRow(ctx, `INSERT INTO workflow_definitions(repository_id,name,path,config) VALUES ($1,'ci','ci.yml','{}') RETURNING id`, repo).Scan(&def))
			require.NoError(t, p.QueryRow(ctx, `INSERT INTO workflow_runs(repository_id,workflow_definition_id,status,trigger_event) VALUES ($1,$2,'running','push') RETURNING id`, repo, def).Scan(&run))
			if update {
				_, err := p.Exec(ctx, `INSERT INTO workflow_caches(repository_id,bookmark_name,cache_key,object_key,object_size_bytes,expires_at) VALUES ($1,'main','deps','objects/old',100,NOW()-INTERVAL '1 hour')`, repo)
				require.NoError(t, err)
			}
			arg := db.UpsertPendingWorkflowCacheParams{RepositoryID: repo, WorkflowRunID: pgtype.Int8{Int64: run, Valid: true}, BookmarkName: "main", CacheKey: "deps", CacheVersion: "static", ObjectKey: "objects/new", ObjectSizeBytes: 200, Compression: "tar+gzip", ExpiresAt: time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour)}
			row, err := q.UpsertPendingWorkflowCache(ctx, arg)
			require.NoError(t, err)
			committed, err := q.GetWorkflowCacheByID(ctx, row.ID)
			require.NoError(t, err)
			require.Equal(t, arg.ObjectKey, row.ObjectKey)
			require.Equal(t, arg.ObjectSizeBytes, row.ObjectSizeBytes)
			require.Equal(t, arg.WorkflowRunID, row.WorkflowRunID)
			require.True(t, arg.ExpiresAt.Equal(row.ExpiresAt))
			require.Equal(t, committed, row)
			// A live reservation owned by another run must still return its unchanged row.
			arg.WorkflowRunID = pgtype.Int8{}
			arg.ObjectKey = "objects/blocked"
			unchanged, err := q.UpsertPendingWorkflowCache(ctx, arg)
			require.NoError(t, err)
			require.Equal(t, row, unchanged)
		})
	}
}

// A join request against the live lock generation is accepted after every
// registered migration.
func TestReviewBranchJoinCreation(t *testing.T) {
	p := reviewDatabase(t, 0)
	repo := reviewRepo(t, p)
	q := db.New(p)
	ctx := t.Context()
	lock, err := q.AcquireBranchLockInsert(ctx, db.AcquireBranchLockInsertParams{RepositoryID: repo, Branch: "main", UserID: 1})
	require.NoError(t, err)
	request, err := q.CreateBranchLockJoinRequest(ctx, db.CreateBranchLockJoinRequestParams{RepositoryID: repo, Branch: "main", RequesterID: 2, LockGeneration: lock.Generation})
	require.NoError(t, err)
	require.Equal(t, lock.Generation, request.LockGeneration)
}

// A requester that observed a generation the branch no longer carries must
// not leave an orphan request nobody's inbox shows: the insert reports no row.
func TestReviewBranchJoinRequestBindsLiveGeneration(t *testing.T) {
	p := reviewDatabase(t, 0)
	repo := reviewRepo(t, p)
	q := db.New(p)
	ctx := t.Context()
	old, err := q.AcquireBranchLockInsert(ctx, db.AcquireBranchLockInsertParams{RepositoryID: repo, Branch: "main", UserID: 1})
	require.NoError(t, err)
	_, err = q.ReleaseBranchLock(ctx, db.ReleaseBranchLockParams{RepositoryID: repo, Branch: "main", UserID: 1})
	require.NoError(t, err)
	current, err := q.AcquireBranchLockInsert(ctx, db.AcquireBranchLockInsertParams{RepositoryID: repo, Branch: "main", UserID: 3})
	require.NoError(t, err)
	require.NotEqual(t, old.Generation, current.Generation)
	_, err = q.CreateBranchLockJoinRequest(ctx, db.CreateBranchLockJoinRequestParams{RepositoryID: repo, Branch: "main", RequesterID: 2, LockGeneration: old.Generation})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	inbox, err := q.ListPendingBranchLockJoinRequestsForHolder(ctx, 3)
	require.NoError(t, err)
	require.Empty(t, inbox)
	var count int
	require.NoError(t, p.QueryRow(ctx, `SELECT COUNT(*) FROM branch_lock_join_requests`).Scan(&count))
	require.Zero(t, count)
}

// Approvals from an earlier acquisition never authorize the current one:
// rows migrated from before generations, a release/reacquire, and a stale
// takeover all leave the requester without membership.
func TestReviewBranchJoinGenerationFences(t *testing.T) {
	for _, mode := range []string{"historical", "reacquire", "takeover"} {
		t.Run(mode, func(t *testing.T) {
			version := 0
			if mode == "historical" {
				version = 9
			}
			p := reviewDatabase(t, version)
			repo := reviewRepo(t, p)
			ctx := t.Context()
			_, err := p.Exec(ctx, `INSERT INTO branch_locks(repository_id,branch,user_id) VALUES ($1,'main',1)`, repo)
			require.NoError(t, err)
			insert := `INSERT INTO branch_lock_join_requests(repository_id,branch,requester_id,status,lock_generation) SELECT repository_id,branch,2,$2,generation FROM branch_locks WHERE repository_id=$1 RETURNING id`
			if mode == "historical" {
				insert = `INSERT INTO branch_lock_join_requests(repository_id,branch,requester_id,status) VALUES ($1,'main',2,$2) RETURNING id`
			}
			var approved, pending int64
			require.NoError(t, p.QueryRow(ctx, insert, repo, "approved").Scan(&approved))
			require.NoError(t, p.QueryRow(ctx, insert, repo, "pending").Scan(&pending))
			require.NoError(t, Apply(ctx, p))
			q := db.New(p)
			old, err := q.GetBranchLock(ctx, db.GetBranchLockParams{RepositoryID: repo, Branch: "main"})
			require.NoError(t, err)
			if mode == "reacquire" {
				_, err = q.ReleaseBranchLock(ctx, db.ReleaseBranchLockParams{RepositoryID: repo, Branch: "main", UserID: 1})
				require.NoError(t, err)
				_, err = q.AcquireBranchLockInsert(ctx, db.AcquireBranchLockInsertParams{RepositoryID: repo, Branch: "main", UserID: 3})
				require.NoError(t, err)
			}
			if mode == "takeover" {
				_, err = p.Exec(ctx, `UPDATE branch_locks SET heartbeat_at=NOW()-INTERVAL '1 hour'`)
				require.NoError(t, err)
				next, err := q.TakeOverStaleBranchLock(ctx, db.TakeOverStaleBranchLockParams{RepositoryID: repo, Branch: "main", UserID: 3, HeartbeatAt: time.Now().Add(-5 * time.Minute)})
				require.NoError(t, err)
				require.NotEqual(t, old.Generation, next.Generation)
			}
			current, err := q.GetBranchLock(ctx, db.GetBranchLockParams{RepositoryID: repo, Branch: "main"})
			require.NoError(t, err)
			member, err := q.HasApprovedBranchLockJoin(ctx, db.HasApprovedBranchLockJoinParams{RepositoryID: repo, Branch: "main", RequesterID: 2, LockGeneration: current.Generation})
			require.NoError(t, err)
			require.False(t, member)
			_, err = q.GetBranchLockJoinRequestForRequester(ctx, db.GetBranchLockJoinRequestForRequesterParams{RepositoryID: repo, Branch: "main", RequesterID: 2, LockGeneration: current.Generation})
			require.ErrorIs(t, err, pgx.ErrNoRows)
			inbox, err := q.ListPendingBranchLockJoinRequests(ctx, db.ListPendingBranchLockJoinRequestsParams{RepositoryID: repo, Branch: "main", LockGeneration: current.Generation})
			require.NoError(t, err)
			require.Empty(t, inbox)
			holder := int64(3)
			if mode == "historical" {
				holder = 1
			}
			inbox, err = q.ListPendingBranchLockJoinRequestsForHolder(ctx, holder)
			require.NoError(t, err)
			require.Empty(t, inbox)
			heartbeats, err := q.HeartbeatBranchLock(ctx, db.HeartbeatBranchLockParams{RepositoryID: repo, Branch: "main", UserID: 2})
			require.NoError(t, err)
			require.Zero(t, heartbeats)
		})
	}
}
