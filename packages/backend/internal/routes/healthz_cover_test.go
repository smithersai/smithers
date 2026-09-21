package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type healthzCovChecker struct {
	err error
}

func (c *healthzCovChecker) Ping(ctx context.Context) error {
	return c.err
}

func TestHealthz_Cov_ReadyzUnconfiguredAndFailureBranches(t *testing.T) {
	t.Parallel()

	t.Run("typed nil db and nil repo check are unconfigured", func(t *testing.T) {
		var checker *healthzCovChecker
		h := &ReadyzHandler{DB: checker, RepoHost: "http://repo-host", httpCheck: nil}
		rec := httptest.NewRecorder()

		h.Readyz(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))

		require.Equal(t, http.StatusOK, rec.Code)
		var body healthzResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "ready", body.Status)
		assert.Equal(t, "unconfigured", body.Checks["database"])
		assert.Equal(t, "unconfigured", body.Checks["repo_host"])
	})

	t.Run("repo host check failure marks not ready", func(t *testing.T) {
		h := NewReadyzHandler(&healthzCovChecker{}, "http://repo-host")
		h.SetHTTPCheck(func(url string) error {
			assert.Equal(t, "http://repo-host", url)
			return errors.New("refused")
		})
		rec := httptest.NewRecorder()

		h.Readyz(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))

		require.Equal(t, http.StatusServiceUnavailable, rec.Code)
		var body healthzResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, "not_ready", body.Status)
		assert.Equal(t, "ok", body.Checks["database"])
		assert.Equal(t, "error", body.Checks["repo_host"])
	})
}
