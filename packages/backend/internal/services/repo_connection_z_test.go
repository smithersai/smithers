package services

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRepoConnection_Z_AuthNormalizeAndDBErrorBranches(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	svc := NewRepoConnectionService(&mockRepoConnectionDB{})

	_, err := svc.ConnectRepo(ctx, 0, "owner", "repo", "MIT")
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))
	_, err = svc.ConnectRepo(ctx, 1, "", "repo", "MIT")
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	scanFailSvc := NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(...any) error { return errors.New("scan failed") }}
		},
	})
	scanFailSvc.SetGitHubRepoAccessVerifier(&mockGitHubRepoAccessVerifier{})
	_, err = scanFailSvc.ConnectRepo(ctx, 1, "owner", "repo", "MIT")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	_, err = svc.DisconnectRepo(ctx, 0, "owner", "repo")
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))
	_, err = svc.DisconnectRepo(ctx, 1, "owner", "")
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	_, err = NewRepoConnectionService(&mockRepoConnectionDB{
		execFn: func(context.Context, string, ...any) (pgconn.CommandTag, error) {
			return pgconn.CommandTag{}, errors.New("delete failed")
		},
	}).DisconnectRepo(ctx, 1, "owner", "repo")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	_, err = svc.GetRepoConnectionStatus(ctx, 0, "owner", "repo")
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))
	_, err = svc.GetRepoConnectionStatus(ctx, 1, "", "repo")
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	_, err = NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(...any) error { return errors.New("load failed") }}
		},
	}).GetRepoConnectionStatus(ctx, 1, "owner", "repo")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	now := time.Now().UTC()
	status, err := NewRepoConnectionService(&mockRepoConnectionDB{
		queryRowFn: func(context.Context, string, ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error {
				*(dest[0].(*int64)) = 1
				*(dest[1].(*string)) = "Owner"
				*(dest[2].(*string)) = "Repo"
				*(dest[3].(*string)) = "Apache-2.0"
				*(dest[4].(*time.Time)) = now
				*(dest[5].(*time.Time)) = now
				return nil
			}}
		},
	}).GetRepoConnectionStatus(ctx, 1, "owner", "repo")
	require.NoError(t, err)
	assert.True(t, status.Connected)
	assert.Equal(t, "Apache-2.0", status.LicenseSPDX)
}
