package services

import (
	"bytes"
	"context"
	"io"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// The SSH gateway deliberately collapses "repository not found" and
// "permission denied" into one indistinguishable denial so an unauthorized
// caller cannot enumerate private repositories by probing owner/repo names
// (see internal/ssh writeGitPermissionDenied). The git smart-HTTP proxy must
// apply the same policy: a missing repository must produce the same response
// as an existing repository the caller may not see.

func TestGitHTTPProxyService_MissingRepoReadAnonymous_ChallengesLikePrivateRepo(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{}
	repoHost := &mockGitHTTPRepoHostClient{}
	authorizer := &mockGitHTTPAuthorizer{
		authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
			assert.Equal(t, int64(0), userID)
			assert.Equal(t, AccessModeRead, mode)
			return errors.NotFound("repository not found")
		},
	}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)

	_, err := svc.ProxyInfoRefs(context.Background(), "alice", "missing", "git-upload-pack", "", io.Discard)
	require.Error(t, err)
	// Same challenge an anonymous caller gets for an existing private repo —
	// never a 404 that confirms the name is simply unused.
	assert.Equal(t, 401, apiStatus(t, err))
	assert.Equal(t, 0, repoHost.infoRefsCalls)
}

func TestGitHTTPProxyService_MissingRepoReadAuthenticated_DeniedLikePrivateRepo(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{
				ID:          10,
				Username:    "alice",
				TokenID:     900,
				TokenScopes: "read:repository",
				IsActive:    true,
			}, nil
		},
	}
	repoHost := &mockGitHTTPRepoHostClient{}
	authorizer := &mockGitHTTPAuthorizer{
		authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
			assert.Equal(t, int64(10), userID)
			return errors.NotFound("repository not found")
		},
	}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)

	err := svc.ProxyUploadPack(
		context.Background(),
		"alice",
		"missing",
		"smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		bytes.NewBufferString("request"),
		io.Discard,
	)
	require.Error(t, err)
	// Same denial an authenticated non-member gets for an existing private
	// repo — the response must not confirm the repo simply does not exist.
	assert.Equal(t, 403, apiStatus(t, err))
	assert.Equal(t, 0, repoHost.uploadPackCalls)
}

func TestGitHTTPProxyService_MissingRepoWrite_DeniedLikePrivateRepo(t *testing.T) {
	t.Parallel()

	q := &mockGitHTTPProxyQuerier{
		getAuthInfoByTokenHashFn: func(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{
				ID:          10,
				Username:    "alice",
				TokenID:     900,
				TokenScopes: "write:repository",
				IsActive:    true,
			}, nil
		},
	}
	repoHost := &mockGitHTTPRepoHostClient{}
	authorizer := &mockGitHTTPAuthorizer{
		authorizeFn: func(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
			assert.Equal(t, int64(10), userID)
			assert.Equal(t, AccessModeWrite, mode)
			return errors.NotFound("repository not found")
		},
	}
	svc := NewGitHTTPProxyService(q, authorizer, repoHost)

	err := svc.ProxyReceivePack(
		context.Background(),
		"alice",
		"missing",
		"smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		bytes.NewBufferString("request"),
		io.Discard,
	)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))
	assert.Equal(t, 0, repoHost.receivePackCall)
}
