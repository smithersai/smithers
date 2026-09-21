package services

import (
	"bytes"
	"context"
	"io"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

func TestGitHTTPProxyService_RunnerTaskReadIsRepositoryBoundAndReadOnly(t *testing.T) {
	t.Parallel()

	const (
		controlToken = "repo-host-control-token"
		signingKey   = "runner-control-secret"
	)
	claims := middleware.RunnerTaskTokenClaims{
		TaskID: 1, WorkflowRunID: 2, RepositoryID: 42, RunnerID: 3, Attempt: 1,
		ExpiresAtUnix: time.Now().Add(time.Hour).Unix(),
	}
	taskToken, err := middleware.MintRunnerTaskToken(signingKey, claims)
	require.NoError(t, err)

	newQuerier := func() *mockGitHTTPProxyQuerier {
		return &mockGitHTTPProxyQuerier{
			getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
				return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
			},
			getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				if arg.LowerName == "claimed" {
					return db.Repository{ID: claims.RepositoryID}, nil
				}
				return db.Repository{ID: 99}, nil
			},
			getWorkflowRunByRunIDFn: func(context.Context, int64) (db.WorkflowRun, error) {
				return db.WorkflowRun{ID: claims.WorkflowRunID, RepositoryID: claims.RepositoryID, Status: "running"}, nil
			},
			getWorkflowTaskForRunnerFn: func(context.Context, int64) (db.GetWorkflowTaskForRunnerRow, error) {
				return db.GetWorkflowTaskForRunnerRow{
					ID: claims.TaskID, WorkflowRunID: claims.WorkflowRunID, RepositoryID: claims.RepositoryID,
					RunnerID: pgtype.Int8{Int64: claims.RunnerID, Valid: true}, Status: "running", Attempt: claims.Attempt,
				}, nil
			},
		}
	}

	t.Run("repo-host control token is not a runner task token", func(t *testing.T) {
		t.Parallel()
		repoHost := &mockGitHTTPRepoHostClient{}
		svc := NewGitHTTPProxyService(
			newQuerier(),
			&mockGitHTTPAuthorizer{},
			repoHost,
			WithGitHTTPRunnerTaskTokenSecret(signingKey),
		)

		_, err := svc.ProxyInfoRefs(context.Background(), "alice", "private", "git-upload-pack", controlToken, io.Discard)
		require.Error(t, err)
		assert.Equal(t, 401, apiStatus(t, err))
		assert.Equal(t, 0, repoHost.infoRefsCalls)
	})

	t.Run("task token cannot clone a different repository", func(t *testing.T) {
		t.Parallel()
		repoHost := &mockGitHTTPRepoHostClient{}
		svc := NewGitHTTPProxyService(
			newQuerier(), &mockGitHTTPAuthorizer{}, repoHost,
			WithGitHTTPRunnerTaskTokenSecret(signingKey),
		)

		err := svc.ProxyUploadPack(context.Background(), "alice", "victim", taskToken, bytes.NewBuffer(nil), io.Discard)
		require.Error(t, err)
		assert.Equal(t, 401, apiStatus(t, err))
		assert.Equal(t, 0, repoHost.uploadPackCalls)
	})

	t.Run("task token can never authorize receive-pack", func(t *testing.T) {
		t.Parallel()
		repoHost := &mockGitHTTPRepoHostClient{}
		svc := NewGitHTTPProxyService(
			newQuerier(),
			&mockGitHTTPAuthorizer{},
			repoHost,
			WithGitHTTPRunnerTaskTokenSecret(signingKey),
		)

		err := svc.ProxyReceivePack(context.Background(), "alice", "claimed", taskToken, bytes.NewBuffer(nil), io.Discard)
		require.Error(t, err)
		assert.Equal(t, 401, apiStatus(t, err))
		assert.Equal(t, 0, repoHost.receivePackCall)
	})

	t.Run("task completion revokes clone access", func(t *testing.T) {
		t.Parallel()
		q := newQuerier()
		q.getWorkflowTaskForRunnerFn = func(context.Context, int64) (db.GetWorkflowTaskForRunnerRow, error) {
			return db.GetWorkflowTaskForRunnerRow{
				ID: claims.TaskID, WorkflowRunID: claims.WorkflowRunID, RepositoryID: claims.RepositoryID,
				RunnerID: pgtype.Int8{Int64: claims.RunnerID, Valid: true}, Status: "success", Attempt: claims.Attempt,
			}, nil
		}
		repoHost := &mockGitHTTPRepoHostClient{}
		svc := NewGitHTTPProxyService(q, &mockGitHTTPAuthorizer{}, repoHost, WithGitHTTPRunnerTaskTokenSecret(signingKey))

		_, err := svc.ProxyInfoRefs(context.Background(), "alice", "claimed", "git-upload-pack", taskToken, io.Discard)
		require.Error(t, err)
		assert.Equal(t, 401, apiStatus(t, err))
		assert.Equal(t, 0, repoHost.infoRefsCalls)
	})

	t.Run("task reassignment revokes clone access", func(t *testing.T) {
		t.Parallel()
		q := newQuerier()
		q.getWorkflowTaskForRunnerFn = func(context.Context, int64) (db.GetWorkflowTaskForRunnerRow, error) {
			return db.GetWorkflowTaskForRunnerRow{
				ID: claims.TaskID, WorkflowRunID: claims.WorkflowRunID, RepositoryID: claims.RepositoryID,
				RunnerID: pgtype.Int8{Int64: claims.RunnerID + 1, Valid: true}, Status: "running", Attempt: claims.Attempt,
			}, nil
		}
		repoHost := &mockGitHTTPRepoHostClient{}
		svc := NewGitHTTPProxyService(q, &mockGitHTTPAuthorizer{}, repoHost, WithGitHTTPRunnerTaskTokenSecret(signingKey))

		err := svc.ProxyUploadPack(context.Background(), "alice", "claimed", taskToken, bytes.NewBuffer(nil), io.Discard)
		require.Error(t, err)
		assert.Equal(t, 401, apiStatus(t, err))
		assert.Equal(t, 0, repoHost.uploadPackCalls)
	})

	t.Run("same-runner retry does not revive an earlier attempt token", func(t *testing.T) {
		t.Parallel()
		q := newQuerier()
		q.getWorkflowTaskForRunnerFn = func(context.Context, int64) (db.GetWorkflowTaskForRunnerRow, error) {
			return db.GetWorkflowTaskForRunnerRow{
				ID: claims.TaskID, WorkflowRunID: claims.WorkflowRunID, RepositoryID: claims.RepositoryID,
				RunnerID: pgtype.Int8{Int64: claims.RunnerID, Valid: true}, Status: "running", Attempt: claims.Attempt + 1,
			}, nil
		}
		repoHost := &mockGitHTTPRepoHostClient{}
		svc := NewGitHTTPProxyService(q, &mockGitHTTPAuthorizer{}, repoHost, WithGitHTTPRunnerTaskTokenSecret(signingKey))

		err := svc.ProxyUploadPack(context.Background(), "alice", "claimed", taskToken, bytes.NewBuffer(nil), io.Discard)
		require.Error(t, err)
		assert.Equal(t, 401, apiStatus(t, err))
		assert.Equal(t, 0, repoHost.uploadPackCalls)
	})
}
