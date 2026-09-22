package services

import (
	"context"
	stdErrors "errors"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

var errRolloutPrepareReached = stdErrors.New("rollout test reached durable storage preparation")

type rolloutProvisioningHost struct {
	*mockRepoHostClient
	prepareInitCalls int
	prepareForkCalls int
}

func (h *rolloutProvisioningHost) PrepareStagedInit(
	context.Context, string, string, string, string, bool,
) (repohost.StagedProvision, error) {
	h.prepareInitCalls++
	return repohost.StagedProvision{}, errRolloutPrepareReached
}

func (h *rolloutProvisioningHost) PrepareStagedFork(
	context.Context, string, string, string, string, string,
) (repohost.StagedProvision, error) {
	h.prepareForkCalls++
	return repohost.StagedProvision{}, errRolloutPrepareReached
}

func (*rolloutProvisioningHost) ExecuteStagedProvision(context.Context, repohost.StagedProvision) error {
	return nil
}

func (*rolloutProvisioningHost) PublishStagedProvision(context.Context, repohost.StagedProvision) error {
	return nil
}

func (*rolloutProvisioningHost) FinalizeStagedProvision(context.Context, repohost.StagedProvision) error {
	return nil
}

func (*rolloutProvisioningHost) AbortStagedProvision(context.Context, repohost.StagedProvision) error {
	return nil
}

type rolloutRepoQuerier struct {
	*mockRepoQuerier
	canonicalUser db.User
	canonicalOrg  db.Organization
}

func (q *rolloutRepoQuerier) GetUserByID(context.Context, int64) (db.User, error) {
	return q.canonicalUser, nil
}

func (q *rolloutRepoQuerier) GetOrgByID(context.Context, int64) (db.Organization, error) {
	return q.canonicalOrg, nil
}

func requireRepositoryRolloutUnavailable(t *testing.T, err error) {
	t.Helper()
	apiErr := apiError(t, err)
	assert.Equal(t, http.StatusServiceUnavailable, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeRepositoryProvisioningRollout, apiErr.Code)
}

func TestRepoServiceDurableCreatesStayGatedUntilEnabled(t *testing.T) {
	pool := getAgentTestPool(t)
	actor := &db.User{ID: 7, Username: "bob", LowerUsername: "bob"}

	t.Run("user repository", func(t *testing.T) {
		createCalls := 0
		q := &rolloutRepoQuerier{mockRepoQuerier: &mockRepoQuerier{
			createRepoFn: func(context.Context, db.CreateRepoParams) (db.Repository, error) {
				createCalls++
				return db.Repository{}, nil
			},
		}}
		host := &rolloutProvisioningHost{mockRepoHostClient: &mockRepoHostClient{}}
		svc := NewRepoServiceWithPool(q, host, "s1", pool)

		_, err := svc.CreateRepo(context.Background(), actor, "demo", "", true, "main", false)
		requireRepositoryRolloutUnavailable(t, err)
		assert.Zero(t, host.prepareInitCalls)
		assert.Zero(t, createCalls)

		svc.EnableDurableProvisioning()
		_, err = svc.CreateRepo(context.Background(), actor, "demo", "", true, "main", false)
		assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
		assert.Equal(t, 1, host.prepareInitCalls, "enabled service must proceed into durable preparation")
		assert.Zero(t, createCalls)
	})

	t.Run("organization repository", func(t *testing.T) {
		createCalls := 0
		q := &rolloutRepoQuerier{mockRepoQuerier: &mockRepoQuerier{
			getOrgByLowerNameFn: func(context.Context, string) (db.Organization, error) {
				return db.Organization{ID: 9, Name: "acme", LowerName: "acme"}, nil
			},
			getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{OrganizationID: 9, UserID: actor.ID, Role: "owner"}, nil
			},
			createOrgRepoFn: func(context.Context, db.CreateOrgRepoParams) (db.Repository, error) {
				createCalls++
				return db.Repository{}, nil
			},
		}}
		host := &rolloutProvisioningHost{mockRepoHostClient: &mockRepoHostClient{}}
		svc := NewRepoServiceWithPool(q, host, "s1", pool)

		_, err := svc.CreateOrgRepo(context.Background(), actor, "acme", "demo", "", true, "main", false)
		requireRepositoryRolloutUnavailable(t, err)
		assert.Zero(t, host.prepareInitCalls)
		assert.Zero(t, createCalls)

		svc.EnableDurableProvisioning()
		_, err = svc.CreateOrgRepo(context.Background(), actor, "acme", "demo", "", true, "main", false)
		assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
		assert.Equal(t, 1, host.prepareInitCalls)
		assert.Zero(t, createCalls)
	})

	t.Run("fork", func(t *testing.T) {
		createCalls := 0
		source := db.Repository{
			ID: 41, UserID: pgtype.Int8{Int64: 22, Valid: true},
			IsPublic: true, DefaultBookmark: "main",
		}
		q := &rolloutRepoQuerier{
			mockRepoQuerier: &mockRepoQuerier{
				getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return source, nil
				},
				createForkRepoFn: func(context.Context, db.CreateForkRepoParams) (db.Repository, error) {
					createCalls++
					return db.Repository{}, nil
				},
			},
			canonicalUser: db.User{ID: 22, Username: "alice", LowerUsername: "alice"},
		}
		host := &rolloutProvisioningHost{mockRepoHostClient: &mockRepoHostClient{}}
		svc := NewRepoServiceWithPool(q, host, "s1", pool)

		_, err := svc.ForkRepo(context.Background(), actor, "alice", "source", "copy", "")
		requireRepositoryRolloutUnavailable(t, err)
		assert.Zero(t, host.prepareForkCalls)
		assert.Zero(t, createCalls)

		svc.EnableDurableProvisioning()
		_, err = svc.ForkRepo(context.Background(), actor, "alice", "source", "copy", "")
		assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
		assert.Equal(t, 1, host.prepareForkCalls)
		assert.Zero(t, createCalls)
	})
}

func TestGitHubImportStartStaysGatedUntilDurableWorkerEnabled(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	userID, owner := createProvisioningTestUser(t)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM import_jobs WHERE user_id = $1`, userID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})

	host := &candidateFallbackStagedHost{testGitHubImportRepoHost: &testGitHubImportRepoHost{}}
	svc := NewGitHubImportService(
		pool, &testGitHubImportRepoDB{}, testGitHubImportTokenDB{}, host,
		testGitHubImportDecrypter{}, "https://smithers.test",
	)
	input := ImportGitHubRepoInput{UserID: userID, Owner: "octo", Repo: "demo", Branch: "main"}

	_, err := svc.StartImport(ctx, input)
	requireRepositoryRolloutUnavailable(t, err)
	var jobCount int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM import_jobs WHERE user_id = $1`, userID).Scan(&jobCount))
	assert.Zero(t, jobCount, "compatibility gate must reject before persisting a job")

	svc.EnableDurableWorker()
	job, err := svc.StartImport(ctx, input)
	require.NoError(t, err)
	assert.Equal(t, "cloning", job.Status)
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM import_jobs WHERE user_id = $1`, userID).Scan(&jobCount))
	assert.Equal(t, int64(1), jobCount)
	assert.Equal(t, owner, job.RepoOwner)
}

func TestProvisioningEnforcementAtomicallyTerminalizesUnboundLegacyImports(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	userID, owner := createProvisioningTestUser(t)
	_, err := pool.Exec(ctx, `
		UPDATE repository_provisioning_control
		SET enforce_insert_fence = FALSE, updated_at = NOW()
		WHERE singleton
	`)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `
			UPDATE repository_provisioning_control
			SET enforce_insert_fence = FALSE, updated_at = NOW()
			WHERE singleton
		`)
		_, _ = pool.Exec(context.Background(), `DELETE FROM import_jobs WHERE user_id = $1`, userID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})

	unboundID := uuid.NewString()
	boundID := uuid.NewString()
	readyID := uuid.NewString()
	claimToken := strings.Repeat("8", 64)
	var provisioningRepositoryID int64
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT nextval(pg_get_serial_sequence('repositories', 'id'))`).Scan(&provisioningRepositoryID))
	_, err = pool.Exec(ctx, `
		INSERT INTO import_jobs (
			id, user_id, github_owner, github_repo, repo_owner, repo_name,
			branch, target_bookmark, status, stage, claim_token, claimed_at
		) VALUES ($1, $2, 'legacy', 'unbound', $3, 'unbound', 'main', 'main',
			'cloning', 'pushing_mirror', $4, NOW())
	`, unboundID, userID, owner, claimToken)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO import_jobs (
			id, user_id, github_owner, github_repo, repo_owner, repo_name,
			branch, target_bookmark, status, stage, provisioning_repository_id,
			provisioning_token, claim_token, claimed_at
		) VALUES ($1, $2, 'durable', 'bound', $3, 'bound', 'main', 'main',
			'cloning', 'pushing_mirror', $4, $5, $6, NOW())
	`, boundID, userID, owner, provisioningRepositoryID, strings.Repeat("9", 64), claimToken)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO import_jobs (
			id, user_id, github_owner, github_repo, repo_owner, repo_name,
			branch, target_bookmark, status
		) VALUES ($1, $2, 'legacy', 'ready', $3, 'ready', 'main', 'main', 'ready')
	`, readyID, userID, owner)
	require.NoError(t, err)

	enabled, err := ConfigureRepositoryProvisioningEnforcement(ctx, pool, false)
	require.NoError(t, err)
	assert.False(t, enabled, "false request must read, not override, the DB-authoritative switch")
	enabled, err = ConfigureRepositoryProvisioningEnforcement(ctx, pool, true)
	require.NoError(t, err)
	assert.True(t, enabled)

	var (
		status      string
		stage       string
		message     string
		storedClaim *string
	)
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT status, stage, error, claim_token FROM import_jobs WHERE id = $1
	`, unboundID).Scan(&status, &stage, &message, &storedClaim))
	assert.Equal(t, "failed", status)
	assert.Empty(t, stage)
	assert.Equal(t, legacyImportRolloutFailure, message)
	assert.Nil(t, storedClaim)
	assert.Contains(t, message, "operator review")
	assert.Contains(t, message, "retry")

	require.NoError(t, pool.QueryRow(ctx, `
		SELECT status, stage, claim_token FROM import_jobs WHERE id = $1
	`, boundID).Scan(&status, &stage, &storedClaim))
	assert.Equal(t, "cloning", status, "durably bound work must remain resumable")
	assert.Equal(t, "pushing_mirror", stage)
	require.NotNil(t, storedClaim)
	assert.Equal(t, claimToken, *storedClaim)

	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM import_jobs WHERE id = $1`, readyID).Scan(&status))
	assert.Equal(t, "ready", status)
	var databaseEnabled bool
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT enforce_insert_fence FROM repository_provisioning_control WHERE singleton
	`).Scan(&databaseEnabled))
	assert.True(t, databaseEnabled)

	// Once contracted, a normal durable StartImport briefly has no provisioning
	// binding until its worker reserves a candidate. Pod restarts must treat an
	// already-true switch as read-only and never mistake that fresh job for
	// pre-transition legacy work.
	freshDurableJobID := uuid.NewString()
	_, err = pool.Exec(ctx, `
		INSERT INTO import_jobs (
			id, user_id, github_owner, github_repo, repo_owner, repo_name,
			branch, target_bookmark, status
		) VALUES ($1, $2, 'durable', 'fresh-after-contract', $3,
			'fresh-after-contract', 'main', 'main', 'cloning')
	`, freshDurableJobID, userID, owner)
	require.NoError(t, err)
	enabled, err = ConfigureRepositoryProvisioningEnforcement(ctx, pool, true)
	require.NoError(t, err)
	assert.True(t, enabled)
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT status FROM import_jobs WHERE id = $1`, freshDurableJobID).Scan(&status))
	assert.Equal(t, "cloning", status, "an already-contracted startup must not terminalize fresh durable work")

	enabled, err = ConfigureRepositoryProvisioningEnforcement(ctx, pool, false)
	require.NoError(t, err)
	assert.True(t, enabled, "a false request must not weaken an already-contracted DB switch")
}
