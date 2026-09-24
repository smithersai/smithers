package services

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestGitProxyFailure_LogsRepoHostCauseAndReturnsSanitized500(t *testing.T) {
	t.Parallel()

	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	var ctx context.Context
	middleware.InjectLogger(logger)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		ctx = r.Context()
	})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))

	err := gitProxyFailure(ctx, "upload-pack", "alice", "demo", errors.New("repo-host: connection reset"))

	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr))
	assert.Equal(t, http.StatusInternalServerError, apiErr.Status)
	assert.Equal(t, "failed to proxy git upload-pack", apiErr.Message)
	assert.Contains(t, logs.String(), "repo-host: connection reset")
	assert.Contains(t, logs.String(), "operation=upload-pack")
	assert.Contains(t, logs.String(), "repo=demo")
}
