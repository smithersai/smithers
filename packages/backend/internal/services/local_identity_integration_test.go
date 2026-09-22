package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

func TestLocalIdentityPostgresBootstrapRestartSessionPATAndSingleton(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `TRUNCATE self_host_owners, local_credentials, auth_sessions, access_tokens, users CASCADE`)
	require.NoError(t, err)

	cfg := defaultAuthConfig()
	cfg.Mode = config.AuthModeSelfHosted
	cfg.BootstrapToken = "database-bootstrap-secret"
	queries := db.New(pool)
	firstProcess := NewAuthService(queries, cfg, nil, nil)
	type bootstrapAttempt struct {
		result LocalLoginResult
		err    error
	}
	start := make(chan struct{})
	attempts := make(chan bootstrapAttempt, 2)
	for _, username := range []string{"owner-a", "owner-b"} {
		username := username
		go func() {
			<-start
			result, bootstrapErr := firstProcess.BootstrapLocalOwner(ctx, LocalBootstrapRequest{
				Username: username, Password: "database strong password", BootstrapToken: cfg.BootstrapToken,
			})
			attempts <- bootstrapAttempt{result: result, err: bootstrapErr}
		}()
	}
	close(start)
	first, second := <-attempts, <-attempts
	var bootstrap LocalLoginResult
	if first.err == nil {
		bootstrap = first.result
		require.Error(t, second.err)
	} else {
		require.NoError(t, second.err)
		bootstrap = second.result
	}

	// A second process with no in-memory bootstrap state authenticates against
	// the same persisted owner and credential.
	secondProcess := NewAuthService(queries, cfg, nil, nil)
	login, err := secondProcess.LoginLocalOwner(ctx, bootstrap.User.Username, "database strong password")
	require.NoError(t, err)
	assert.Equal(t, bootstrap.User.ID, login.User.ID)

	var sessionUserID int64
	sessionHandler := middleware.AuthLoader(queries, cfg)(middleware.RequireAuth(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		sessionUserID = middleware.UserFromContext(r.Context()).ID
	})))
	sessionRequest := httptest.NewRequest(http.MethodGet, "/api/user", nil)
	sessionRequest.AddCookie(&http.Cookie{Name: "smithers_session", Value: login.SessionKey})
	sessionHandler.ServeHTTP(httptest.NewRecorder(), sessionRequest)
	assert.Equal(t, bootstrap.User.ID, sessionUserID)

	token, tokenUser, err := secondProcess.CreateLocalOwnerToken(ctx, bootstrap.User.Username, "database strong password", "integration-cli", nil)
	require.NoError(t, err)
	assert.Equal(t, bootstrap.User.ID, tokenUser.ID)
	var tokenUserID int64
	tokenHandler := middleware.AuthLoader(queries, cfg)(middleware.RequireAuth(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		tokenUserID = middleware.UserFromContext(r.Context()).ID
	})))
	tokenRequest := httptest.NewRequest(http.MethodGet, "/api/user", nil)
	tokenRequest.Header.Set("Authorization", "Bearer "+token.Token)
	tokenHandler.ServeHTTP(httptest.NewRecorder(), tokenRequest)
	assert.Equal(t, bootstrap.User.ID, tokenUserID)

	_, err = secondProcess.BootstrapLocalOwner(ctx, LocalBootstrapRequest{
		Username: "other", Password: "another strong password", BootstrapToken: cfg.BootstrapToken,
	})
	require.Error(t, err)
	var owners int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM self_host_owners`).Scan(&owners))
	assert.Equal(t, 1, owners)
}
