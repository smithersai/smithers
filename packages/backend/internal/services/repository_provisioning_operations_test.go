package services

import (
	"context"
	"strings"
	"testing"
	"time"

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

func TestRepositoryProvisioningStaleClaimCanBeTakenOver(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	userID, owner := createProvisioningTestUser(t)
	store := newPostgresRepositoryProvisioningStore(pool)
	token := strings.Repeat("a", 64)
	operation, err := store.Reserve(ctx, newInitProvisioningOperation(
		userID,
		pgtype.Int8{Int64: userID, Valid: true}, pgtype.Int8{}, owner,
		repositoryProvisionParams{Name: "stale-claim", LowerName: "stale-claim", IsPublic: true, DefaultBookmark: "main"},
		repohost.StagedProvision{StorageSetID: "s1", Token: token, OperationType: repositoryProvisionInit, Owner: owner, Repo: "stale-claim", DefaultBookmark: "main"},
		repositoryProvisionInit,
	))
	require.NoError(t, err)

	oldClaim := strings.Repeat("b", 64)
	_, err = pool.Exec(ctx, `
		UPDATE repository_provisioning_operations
		SET claim_token = $1, claimed_at = NOW() - INTERVAL '1 hour'
		WHERE repository_id = $2
	`, oldClaim, operation.RepositoryID)
	require.NoError(t, err)
	newClaim := strings.Repeat("c", 64)
	require.NoError(t, store.AcquireProcessing(ctx, operation.RepositoryID, token, newClaim))
	assert.ErrorIs(t, store.AcquireProcessing(ctx, operation.RepositoryID, token, strings.Repeat("d", 64)), errRepositoryProvisionInProgress)

	var storedClaim string
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT claim_token FROM repository_provisioning_operations WHERE repository_id = $1
	`, operation.RepositoryID).Scan(&storedClaim))
	assert.Equal(t, newClaim, storedClaim)
}

func TestImportPublicationAtomicallyBindsJobAndAdoptsLostResponse(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	userID, owner := createProvisioningTestUser(t)
	store := newPostgresRepositoryProvisioningStore(pool)
	jobID := uuid.NewString()
	claimToken := strings.Repeat("e", 64)
	require.NoError(t, pool.QueryRow(ctx, `
		INSERT INTO import_jobs (
			id, user_id, github_owner, github_repo, repo_owner, repo_name,
			branch, target_bookmark, status, claim_token, claimed_at
		) VALUES ($1, $2, 'upstream', 'mirror', $3, 'mirror', 'work', 'work', 'cloning', $4, NOW())
		RETURNING id
	`, jobID, userID, owner, claimToken).Scan(&jobID))

	token := strings.Repeat("f", 64)
	wanted := newInitProvisioningOperation(
		userID,
		pgtype.Int8{Int64: userID, Valid: true}, pgtype.Int8{}, owner,
		repositoryProvisionParams{
			Name: "mirror", LowerName: "mirror", Description: "Imported from github.com/upstream/mirror",
			IsPublic: false, DefaultBookmark: "main",
		},
		repohost.StagedProvision{StorageSetID: "s1", Token: token, OperationType: repositoryProvisionImport, Owner: owner, Repo: "mirror", DefaultBookmark: "main"},
		repositoryProvisionImport,
	)
	wanted.ImportJobID = jobID
	wanted.ImportJobClaimToken = claimToken
	operation, err := store.Reserve(ctx, wanted)
	require.NoError(t, err)
	operation.ImportJobID = jobID
	operation.ImportJobClaimToken = claimToken

	require.NoError(t, store.AcquireProcessing(ctx, operation.RepositoryID, token, claimToken))
	require.NoError(t, store.MarkPublishReady(ctx, operation.RepositoryID, token, claimToken))
	operation.PublishReady = true
	repository, err := store.Publish(ctx, operation, claimToken)
	require.NoError(t, err)
	assert.Equal(t, operation.RepositoryID, repository.ID)

	// A caller can lose the commit response. Repeating publication with the
	// same stable ID/token adopts the exact row and re-applies the job binding.
	repository, err = store.Publish(ctx, operation, claimToken)
	require.NoError(t, err)
	assert.Equal(t, operation.RepositoryID, repository.ID)

	var (
		boundRepositoryID int64
		boundToken        string
		status            string
	)
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT repository_id, provisioning_token, status
		FROM import_jobs WHERE id = $1
	`, jobID).Scan(&boundRepositoryID, &boundToken, &status))
	assert.Equal(t, repository.ID, boundRepositoryID)
	assert.Equal(t, token, boundToken)
	assert.Equal(t, "cloning", status, "publication and post-publish workspace completion are separate durable steps")

	var operationUpdated time.Time
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT updated_at FROM repository_provisioning_operations WHERE repository_id = $1
	`, operation.RepositoryID).Scan(&operationUpdated))
	assert.False(t, operationUpdated.IsZero())
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
			user_id, name, lower_name, description, storage_set_id,
			is_public, default_bookmark
		) VALUES ($1, 'published-mirror', 'published-mirror', '', 's1', FALSE, 'main')
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
	store := newPostgresRepositoryProvisioningStore(pool)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM import_jobs WHERE user_id = $1`, userID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM repository_provisioning_operations WHERE user_id = $1`, userID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})

	_, err := store.Reserve(ctx, newInitProvisioningOperation(
		userID,
		pgtype.Int8{Int64: userID, Valid: true}, pgtype.Int8{}, owner,
		repositoryProvisionParams{
			Name: "demo", LowerName: "demo", Description: "unrelated pending create",
			IsPublic: false, DefaultBookmark: "main",
		},
		repohost.StagedProvision{
			StorageSetID: "s1", Token: strings.Repeat("1", 64),
			OperationType: repositoryProvisionInit, Owner: owner, Repo: "demo",
			DefaultBookmark: "main",
		},
		repositoryProvisionInit,
	))
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
		repoDB: db.New(pool), storageSetID: "s1", provisioning: store,
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

func TestRepositoryProvisioningFailedClaimRotatesBehindPendingWork(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	userID, owner := createProvisioningTestUser(t)
	store := newPostgresRepositoryProvisioningStore(pool)
	reserve := func(name, token string) repositoryProvisioningOperation {
		operation, err := store.Reserve(ctx, newInitProvisioningOperation(
			userID,
			pgtype.Int8{Int64: userID, Valid: true}, pgtype.Int8{}, owner,
			repositoryProvisionParams{Name: name, LowerName: name, IsPublic: true, DefaultBookmark: "main"},
			repohost.StagedProvision{StorageSetID: "s1", Token: token, OperationType: repositoryProvisionInit, Owner: owner, Repo: name, DefaultBookmark: "main"},
			repositoryProvisionInit,
		))
		require.NoError(t, err)
		return operation
	}
	poison := reserve("poison", strings.Repeat("5", 64))
	next := reserve("next", strings.Repeat("6", 64))
	_, err := pool.Exec(ctx, `
		UPDATE repository_provisioning_operations
		SET created_at = CASE repository_id WHEN $1 THEN NOW() - INTERVAL '2 hours' ELSE NOW() - INTERVAL '1 hour' END,
		    updated_at = CASE repository_id WHEN $1 THEN NOW() - INTERVAL '2 hours' ELSE NOW() - INTERVAL '1 hour' END
		WHERE repository_id IN ($1, $2)
	`, poison.RepositoryID, next.RepositoryID)
	require.NoError(t, err)

	firstClaim := strings.Repeat("7", 64)
	claimed, err := store.ClaimReady(ctx, firstClaim)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	assert.Equal(t, poison.RepositoryID, claimed[0].RepositoryID)
	store.ReleaseClaim(ctx, claimed[0], firstClaim, assert.AnError)

	secondClaim := strings.Repeat("8", 64)
	claimed, err = store.ClaimReady(ctx, secondClaim)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	assert.Equal(t, next.RepositoryID, claimed[0].RepositoryID)
}
