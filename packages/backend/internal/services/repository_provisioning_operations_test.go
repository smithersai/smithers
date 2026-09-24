package services

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type candidateFallbackStagedHost struct {
	*testGitHubImportRepoHost
	prepared []repohost.StagedProvision
	aborted  []repohost.StagedProvision
}

func (h *candidateFallbackStagedHost) PrepareStagedImport(
	_ context.Context,
	storageSetID, owner, repo, defaultBookmark string,
) (repohost.StagedProvision, error) {
	tokenDigit := "3"
	if len(h.prepared) > 0 {
		tokenDigit = "4"
	}
	staged := repohost.StagedProvision{
		StorageSetID: storageSetID, Token: strings.Repeat(tokenDigit, 64),
		OperationType: repositoryProvisionImport, Owner: owner, Repo: repo,
		DefaultBookmark: defaultBookmark,
	}
	h.prepared = append(h.prepared, staged)
	return staged, nil
}

func (*candidateFallbackStagedHost) ExecuteStagedProvision(context.Context, repohost.StagedProvision) error {
	return nil
}

func (*candidateFallbackStagedHost) StagedProvisionGitEndpoint(context.Context, repohost.StagedProvision) (string, string, error) {
	return "", "", nil
}

func (*candidateFallbackStagedHost) PublishStagedProvision(context.Context, repohost.StagedProvision) error {
	return nil
}

func (*candidateFallbackStagedHost) FinalizeStagedProvision(context.Context, repohost.StagedProvision) error {
	return nil
}

func (h *candidateFallbackStagedHost) AbortStagedProvision(_ context.Context, staged repohost.StagedProvision) error {
	h.aborted = append(h.aborted, staged)
	return nil
}

func createProvisioningTestUser(t *testing.T) (int64, string) {
	t.Helper()
	pool := getAgentTestPool(t)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	username := "provision-" + suffix
	email := username + "@example.com"
	var userID int64
	require.NoError(t, pool.QueryRow(context.Background(), `
		INSERT INTO users (username, lower_username, email, lower_email, display_name)
		VALUES ($1::varchar, LOWER($1::text), $2::varchar, LOWER($2::text), $1::text)
		RETURNING id
	`, username, email).Scan(&userID))
	return userID, username
}

func TestImportProvenanceTrustsFailedJobOnlyWithDurablePublishedBinding(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	userID, owner := createProvisioningTestUser(t)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM import_jobs WHERE user_id = $1`, userID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM repositories WHERE user_id = $1`, userID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})

	var repositoryID int64
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO repositories (
			user_id, name, lower_name, description,
			is_public, default_bookmark
		) VALUES ($1, 'published-mirror', 'published-mirror', '', FALSE, 'main')
		RETURNING id
	`, userID).Scan(&repositoryID))
	svc := &GitHubImportService{db: pool}
	insertJob := func(status string, boundRepositoryID any, provisioningRepositoryID any, provisioningToken any) {
		t.Helper()
		_, err := pool.Exec(ctx, `
			INSERT INTO import_jobs (
				id, user_id, repository_id, github_owner, github_repo,
				repo_owner, repo_name, branch, target_bookmark, status,
				provisioning_repository_id, provisioning_token
			) VALUES ($1, $2, $3, 'Octo', 'Demo', $4, 'published-mirror',
				'main', 'main', $5, $6, $7)
		`, uuid.NewString(), userID, boundRepositoryID, owner, status,
			provisioningRepositoryID, provisioningToken)
		require.NoError(t, err)
	}
	clearJobs := func() {
		t.Helper()
		_, err := pool.Exec(ctx, `DELETE FROM import_jobs WHERE user_id = $1`, userID)
		require.NoError(t, err)
	}
	matches := func() bool {
		t.Helper()
		matched, err := svc.importJobProvenanceMatches(ctx, userID, "octo", "demo", repositoryID)
		require.NoError(t, err)
		return matched
	}

	insertJob("ready", repositoryID, nil, nil)
	assert.True(t, matches(), "ready import remains definitive provenance")
	clearJobs()

	insertJob("failed", repositoryID, repositoryID, strings.Repeat("a", 64))
	assert.True(t, matches(), "failed post-publication import retains exact durable provenance")
	clearJobs()

	insertJob("failed", repositoryID, nil, nil)
	assert.False(t, matches(), "legacy failed row without a provisioning binding is not trusted")
	clearJobs()

	insertJob("failed", nil, nil, nil)
	assert.False(t, matches(), "pre-publication failure is not trusted")
}

func TestDurableImportMismatchFallsBackAndAbortsUnboundStage(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	userID, owner := createProvisioningTestUser(t)
	store := &productImportProvisioningStore{pool: pool}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM import_jobs WHERE user_id = $1`, userID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})

	occupiedJobID := uuid.NewString()
	occupiedClaim := strings.Repeat("0", 64)
	_, err := pool.Exec(ctx, `INSERT INTO import_jobs(id,user_id,github_owner,github_repo,repo_owner,repo_name,branch,target_bookmark,status,claim_token,claimed_at) VALUES($1,$2,'occupied','demo',$3,'demo','main','main','cloning',$4,NOW())`, occupiedJobID, userID, owner, occupiedClaim)
	require.NoError(t, err)
	occupied := newInitProvisioningOperation(userID, pgtype.Int8{Int64: userID, Valid: true}, pgtype.Int8{}, owner,
		repositoryProvisionParams{Name: "demo", LowerName: "demo", Description: "unrelated pending import", DefaultBookmark: "main"},
		repohost.StagedProvision{StorageSetID: DefaultStorageSetID, Token: strings.Repeat("1", 64), OperationType: repositoryProvisionImport, Owner: owner, Repo: "demo", DefaultBookmark: "main"}, repositoryProvisionImport)
	occupied.ImportJobID, occupied.ImportJobClaimToken = occupiedJobID, occupiedClaim
	_, err = store.Reserve(ctx, occupied)
	require.NoError(t, err)

	jobID := uuid.NewString()
	claimToken := strings.Repeat("2", 64)
	_, err = pool.Exec(ctx, `
		INSERT INTO import_jobs (
			id, user_id, github_owner, github_repo, repo_owner, repo_name,
			branch, target_bookmark, status, claim_token, claimed_at
		) VALUES ($1, $2, 'octo', 'demo', $3, 'demo', 'main', 'main',
			'cloning', $4, NOW())
	`, jobID, userID, owner, claimToken)
	require.NoError(t, err)

	host := &candidateFallbackStagedHost{testGitHubImportRepoHost: &testGitHubImportRepoHost{}}
	svc := &GitHubImportService{
		repoDB: db.New(pool), storageSetID: DefaultStorageSetID, provisioning: store,
		stagedRepoHost: host,
	}
	job := claimedGitHubImportJob{
		ID: jobID, UserID: userID, GitHubOwner: "octo", GitHubRepo: "demo",
		RepoOwner: owner, RepoName: "demo", Branch: "main", TargetBookmark: "main",
		ClaimToken: claimToken,
	}
	reserved, reused, err := svc.reserveDurableImportRepository(ctx, &job, "main")
	require.NoError(t, err)
	require.Nil(t, reused)
	assert.Equal(t, "demo-octo", reserved.Name)
	require.Len(t, host.prepared, 2)
	require.Len(t, host.aborted, 1)
	assert.Equal(t, "demo", host.aborted[0].Repo,
		"the hidden stage prepared before the mismatched reservation must be removed")

	var boundRepositoryID int64
	var boundToken string
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT provisioning_repository_id, provisioning_token
		FROM import_jobs WHERE id = $1
	`, jobID).Scan(&boundRepositoryID, &boundToken))
	assert.Equal(t, reserved.RepositoryID, boundRepositoryID)
	assert.Equal(t, reserved.Token, boundToken)
}
