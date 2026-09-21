package lfsauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func testManager(t *testing.T) *Manager {
	t.Helper()
	m, err := NewManager("shared-test-secret")
	require.NoError(t, err)
	m.now = func() time.Time { return time.Unix(1_700_000_000, 0).UTC() }
	return m
}

func TestManagerIssueVerifyRepositoryAndOperationScopedToken(t *testing.T) {
	m := testManager(t)
	token, issued, err := m.Issue(Grant{
		RepositoryID: 42,
		Owner:        "Alice",
		Repository:   "Demo",
		Operation:    OperationUpload,
		Principal:    PrincipalDeployKey,
	}, DefaultTokenTTL)
	require.NoError(t, err)
	require.NotEmpty(t, token)

	got, err := m.Verify(token)
	require.NoError(t, err)
	assert.Equal(t, issued, got)
	assert.Equal(t, int64(42), got.RepositoryID)
	assert.Equal(t, "alice", got.Owner)
	assert.Equal(t, "demo", got.Repository)
	assert.Equal(t, OperationUpload, got.Operation)
	assert.Equal(t, PrincipalDeployKey, got.Principal)
	assert.Equal(t, PurposeBridge, got.Purpose)
}

func TestManagerIssueRejectsTTLThatCannotProduceAUsableClaim(t *testing.T) {
	t.Parallel()
	m := testManager(t)
	grant := Grant{
		RepositoryID: 42,
		Owner:        "alice",
		Repository:   "demo",
		Operation:    OperationDownload,
		Principal:    PrincipalUser,
	}

	for _, ttl := range []time.Duration{time.Nanosecond, time.Second - time.Nanosecond, time.Second + time.Nanosecond} {
		_, _, err := m.Issue(grant, ttl)
		require.ErrorContains(t, err, "whole seconds between 1s")
	}

	token, claims, err := m.Issue(grant, time.Second)
	require.NoError(t, err)
	assert.Equal(t, int64(1), claims.ExpiresAt-claims.IssuedAt)
	require.NotEmpty(t, token)
}

func TestManagerIssueVerifyCapabilityOutlivesBridgeAndIsObjectBound(t *testing.T) {
	m := testManager(t)
	broad, _, err := m.Issue(Grant{
		RepositoryID: 42,
		Owner:        "alice",
		Repository:   "demo",
		Operation:    OperationUpload,
		Principal:    PrincipalDeployKey,
	}, time.Minute)
	require.NoError(t, err)
	oid := strings.Repeat("a", 64)
	verify, issued, err := m.IssueVerify(VerifyGrant{
		RepositoryID: 42,
		Owner:        "Alice",
		Repository:   "Demo",
		OID:          oid,
		Size:         123,
		Principal:    PrincipalDeployKey,
	}, 30*time.Minute)
	require.NoError(t, err)
	assert.Equal(t, PurposeVerify, issued.Purpose)
	assert.Equal(t, oid, issued.OID)
	assert.Equal(t, int64(123), issued.Size)

	m.now = func() time.Time { return time.Unix(1_700_000_061, 0).UTC() }
	_, err = m.Verify(broad)
	assert.ErrorContains(t, err, "expired")
	got, err := m.Verify(verify)
	require.NoError(t, err)
	assert.Equal(t, issued, got)

	_, _, err = m.IssueVerify(VerifyGrant{RepositoryID: 42, Owner: "alice", Repository: "demo", OID: "bad", Size: 1, Principal: PrincipalUser}, time.Hour)
	require.Error(t, err)
	_, _, err = m.IssueVerify(VerifyGrant{RepositoryID: 42, Owner: "alice", Repository: "demo", OID: oid, Size: -1, Principal: PrincipalUser}, time.Hour)
	require.Error(t, err)
}

func TestManagerVerifyRejectsTamperExpiryAndWrongSecret(t *testing.T) {
	m := testManager(t)
	token, _, err := m.Issue(Grant{RepositoryID: 42, Owner: "alice", Repository: "demo", Operation: OperationDownload, Principal: PrincipalUser}, time.Minute)
	require.NoError(t, err)

	_, err = m.Verify(token + "x")
	require.Error(t, err)

	other, err := NewManager("different-secret")
	require.NoError(t, err)
	other.now = m.now
	_, err = other.Verify(token)
	require.Error(t, err)

	m.now = func() time.Time { return time.Unix(1_700_000_061, 0).UTC() }
	_, err = m.Verify(token)
	assert.ErrorContains(t, err, "expired")
}

func TestBridgeIssuesStandardEndpointAndRejectsUntrustedConfig(t *testing.T) {
	bridge, err := NewBridge(BridgeConfig{
		Secret:        "shared-test-secret",
		PublicBaseURL: "https://plue.test/root/",
		TokenTTL:      2 * time.Minute,
	})
	require.NoError(t, err)
	response, claims, err := bridge.Issue(Grant{RepositoryID: 42, Owner: "Alice", Repository: "Demo", Operation: OperationUpload, Principal: PrincipalDeployKey})
	require.NoError(t, err)
	assert.Equal(t, "https://plue.test/root/api/repos/alice/demo/lfs", response.Href)
	assert.Equal(t, int64(120), response.ExpiresIn)
	assert.Equal(t, OperationUpload, claims.Operation)
	require.Contains(t, response.Header, "Authorization")
	fields := strings.Fields(response.Header["Authorization"])
	require.Len(t, fields, 2)
	_, err = bridge.Manager().Verify(fields[1])
	require.NoError(t, err)

	for _, base := range []string{"", "ssh://plue.test", "https://user@plue.test", "https://plue.test?host=evil", "https://plue.test#evil"} {
		_, err := NewBridge(BridgeConfig{Secret: "secret", PublicBaseURL: base})
		require.Error(t, err, base)
	}
	_, err = NewBridge(BridgeConfig{PublicBaseURL: "https://plue.test"})
	require.Error(t, err)
}

func TestHTTPMiddlewareAcceptsOnlyValidDedicatedScheme(t *testing.T) {
	m := testManager(t)
	token, want, err := m.Issue(Grant{RepositoryID: 42, Owner: "alice", Repository: "demo", Operation: OperationUpload, Principal: PrincipalUser}, time.Minute)
	require.NoError(t, err)

	called := false
	handler := HTTPMiddleware(m)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		got, ok := ClaimsFromContext(r.Context())
		require.True(t, ok)
		assert.Equal(t, want, got)
		auth, ok := AuthorizationFromContext(r.Context())
		require.True(t, ok)
		assert.Equal(t, AuthorizationValue(token), auth)
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/verify", nil)
	req.Header.Set("Authorization", AuthorizationValue(token))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.True(t, called)

	called = false
	req = httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/verify", nil)
	req.Header.Set("Authorization", AuthorizationScheme+" "+strings.Repeat("x", 40))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.False(t, called)

	verifyToken, _, err := m.IssueVerify(VerifyGrant{
		RepositoryID: 42,
		Owner:        "alice",
		Repository:   "demo",
		OID:          strings.Repeat("a", 64),
		Size:         1,
		Principal:    PrincipalUser,
	}, time.Hour)
	require.NoError(t, err)
	called = false
	req = httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/objects/batch", nil)
	req.Header.Set("Authorization", AuthorizationValue(verifyToken))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.False(t, called, "object-bound verify credentials must not authorize Batch")
	assert.Equal(t, AuthorizationScheme, rec.Header().Get("WWW-Authenticate"))

	// A normal PAT scheme is intentionally left to the regular auth loader.
	passthrough := false
	HTTPMiddleware(nil)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { passthrough = true })).ServeHTTP(
		httptest.NewRecorder(),
		httptest.NewRequest(http.MethodGet, "/", nil).WithContext(context.Background()),
	)
	assert.True(t, passthrough)

	// A dedicated LFS credential must fail closed when a unit/dev router has
	// no configured manager; it must not panic or fall through as anonymous.
	called = false
	req = httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/verify", nil)
	req.Header.Set("Authorization", AuthorizationScheme+" invalid")
	rec = httptest.NewRecorder()
	HTTPMiddleware(nil)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true })).ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.False(t, called)
}
