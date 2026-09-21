package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHealthz_H_ReadyzRepoHostOKBranch(t *testing.T) {
	h := NewReadyzHandler(&healthzCovChecker{}, "http://repo-host")
	h.SetHTTPCheck(func(url string) error {
		assert.Equal(t, "http://repo-host", url)
		return nil
	})
	rec := httptest.NewRecorder()

	h.Readyz(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	var body healthzResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "ready", body.Status)
	assert.Equal(t, "ok", body.Checks["repo_host"])
}
