package routes

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/stretchr/testify/require"
)

// Exercise the actual PAT cascade, durable revocation event, PostgreSQL bus,
// authentication middleware and open HTTP stream. An unrelated credential for
// the same user must remain connected and receive a real database notification.
func TestOAuth2Integration_PATDeletionClosesDerivedStream(t *testing.T) {
	e := newPATGrantEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	user := grantSecurityCreateUser(t, e.pool(), "stream-owner")
	pat, source := e.mintPAT(t, user.ID, "read:repository", time.Hour, false)
	unrelated, _ := e.mintPAT(t, user.ID, "read:repository", time.Hour, false)
	response, body, verifier := e.authorize(t, pat)
	require.Equal(t, http.StatusFound, response.StatusCode, body)
	location, err := url.Parse(response.Header.Get("Location"))
	require.NoError(t, err)
	response, body = e.do(t, http.MethodPost, "/api/oauth2/token", "", url.Values{
		"grant_type": {"authorization_code"}, "code": {location.Query().Get("code")}, "redirect_uri": {"http://127.0.0.1:1/callback"},
		"client_id": {services.FirstPartyClientID}, "code_verifier": {verifier},
	})
	require.Equal(t, http.StatusOK, response.StatusCode, body)
	var token services.OAuth2TokenResponse
	require.NoError(t, json.Unmarshal([]byte(body), &token))
	bus := revocation.NewBus(e.pool(), e.q)
	bus.PollInterval = 20 * time.Millisecond
	require.NoError(t, bus.Start(ctx))
	defer func() { cancel(); <-bus.Done() }()
	require.Eventually(t, bus.Positioned, 5*time.Second, 10*time.Millisecond)
	broker := sse.NewBroker(e.pool())
	require.NoError(t, broker.Start(ctx))
	defer broker.Stop()
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(e.q, config.AuthConfig{}))
	router.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository)).Get("/stream", func(w http.ResponseWriter, r *http.Request) {
		info := middleware.AuthInfoFromContext(r.Context())
		sse.ServeBrokerSSE(w, r, sse.BrokerStreamConfig{Broker: broker, Channel: "pat_stream_probe", UserID: info.User.ID, KeepAlive: time.Hour, Revocations: bus, Principal: revocation.Principal{UserID: info.User.ID, TokenHash: info.TokenHash}})
	})
	server := httptest.NewServer(router)
	defer server.Close()
	open := func(bearer string) (*http.Response, *bufio.Reader) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/stream", nil)
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+bearer)
		resp, err := server.Client().Do(req)
		require.NoError(t, err)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		reader := bufio.NewReader(resp.Body)
		line, err := reader.ReadString('\n')
		require.NoError(t, err)
		require.Equal(t, ": connected\n", line)
		return resp, reader
	}
	derived, derivedReader := open(token.AccessToken)
	defer derived.Body.Close()
	other, otherReader := open(unrelated)
	defer other.Body.Close()
	closed := make(chan string, 1)
	go func() { b, _ := io.ReadAll(derivedReader); closed <- string(b) }()
	require.NoError(t, e.q.DeleteAccessToken(ctx, db.DeleteAccessTokenParams{ID: source.ID, UserID: user.ID}))
	select {
	case received := <-closed:
		require.Contains(t, received, "event: revoked")
		require.Contains(t, received, "OAuth token revoked")
	case <-ctx.Done():
		t.Fatal("derived stream retained authority after source PAT deletion")
	}
	var count int
	require.NoError(t, e.pool().QueryRow(ctx, `SELECT count(*) FROM revocation_events WHERE kind='token_revoked' AND token_hash=$1`, sha256Hex(token.AccessToken)).Scan(&count))
	require.Equal(t, 1, count)
	_, err = e.pool().Exec(ctx, `SELECT pg_notify('pat_stream_probe', 'still-authorized')`)
	require.NoError(t, err)
	received := make(chan string, 1)
	go func() {
		var b strings.Builder
		for {
			line, err := otherReader.ReadString('\n')
			b.WriteString(line)
			if strings.Contains(line, "still-authorized") || err != nil {
				received <- b.String()
				return
			}
		}
	}()
	select {
	case text := <-received:
		require.Contains(t, text, "still-authorized")
		require.NotContains(t, text, "event: revoked")
	case <-ctx.Done():
		t.Fatal("unrelated token lost its live stream")
	}
}
