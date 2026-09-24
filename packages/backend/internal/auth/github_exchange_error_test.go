package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// GitHub answers a failed code exchange with HTTP 200 and an OAuth error body.
// The caller must see GitHub's error code, not "empty access token".
func TestGitHubClient_ExchangeCode_SurfacesOAuthErrorOn200(t *testing.T) {
	t.Parallel()

	srv := githubCoverJSONServer(t, http.StatusOK, map[string]any{
		"error":             "bad_verification_code",
		"error_description": "The code passed is incorrect or expired.",
	})
	client := githubCoverClient(srv.URL)

	_, err := client.ExchangeCode(context.Background(), "used-code")
	require.Error(t, err)
	var oauthErr *GitHubOAuthError
	require.True(t, errors.As(err, &oauthErr), "want a typed GitHubOAuthError, got %v", err)
	assert.Equal(t, "bad_verification_code", oauthErr.Code)
	assert.Equal(t, http.StatusOK, oauthErr.Status)
	assert.Contains(t, err.Error(), "bad_verification_code")
	assert.NotContains(t, err.Error(), "empty access token")
}

// A 5xx HTML error page must report its status instead of a JSON decode error.
func TestGitHubClient_ExchangeCode_ReportsStatusForNonJSONError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html>unicorn</html>"))
	}))
	defer srv.Close()
	client := githubCoverClient(srv.URL)

	_, err := client.ExchangeCode(context.Background(), "code")
	require.Error(t, err)
	var oauthErr *GitHubOAuthError
	require.True(t, errors.As(err, &oauthErr), "want a typed GitHubOAuthError, got %v", err)
	assert.Equal(t, http.StatusBadGateway, oauthErr.Status)
	assert.Contains(t, err.Error(), "502")
}
