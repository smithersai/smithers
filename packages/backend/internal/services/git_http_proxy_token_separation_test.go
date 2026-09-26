package services

import (
	"bytes"
	"context"
	"io"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Only user access tokens authenticate Git smart HTTP. Deployment control
// credentials and the retired runner task-token envelope are not credential
// classes here: they are rejected before any repository access.
func TestGitHTTPProxyService_NonUserCredentialsNeverReachRepositories(t *testing.T) {
	t.Parallel()

	newService := func(repoHost *mockGitHTTPRepoHostClient) *GitHTTPProxyService {
		return NewGitHTTPProxyService(&mockGitHTTPProxyQuerier{
			getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
				return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
			},
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return db.Repository{ID: 42}, nil
			},
		}, &mockGitHTTPAuthorizer{}, repoHost)
	}

	for _, token := range []string{
		"repo-host-control-token",
		"smithers_task_v1.eyJ0YXNrX2lkIjoxfQ.c2lnbmF0dXJl",
	} {
		t.Run(token, func(t *testing.T) {
			t.Parallel()
			repoHost := &mockGitHTTPRepoHostClient{}
			svc := newService(repoHost)

			_, err := svc.ProxyInfoRefs(context.Background(), "alice", "private", "git-upload-pack", token, io.Discard)
			require.Error(t, err)
			assert.Equal(t, 401, apiStatus(t, err))

			err = svc.ProxyUploadPack(context.Background(), "alice", "private", token, bytes.NewBuffer(nil), io.Discard)
			require.Error(t, err)
			assert.Equal(t, 401, apiStatus(t, err))

			err = svc.ProxyReceivePack(context.Background(), "alice", "private", token, bytes.NewBuffer(nil), io.Discard)
			require.Error(t, err)
			assert.Equal(t, 401, apiStatus(t, err))

			assert.Zero(t, repoHost.infoRefsCalls)
			assert.Zero(t, repoHost.uploadPackCalls)
			assert.Zero(t, repoHost.receivePackCall)
		})
	}
}
