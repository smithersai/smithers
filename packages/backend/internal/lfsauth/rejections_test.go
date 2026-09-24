package lfsauth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestManagerVerifyReturnsTypedFailureClasses(t *testing.T) {
	m := testManager(t)
	token, _, err := m.Issue(Grant{RepositoryID: 42, Owner: "alice", Repository: "demo", Operation: OperationDownload, Principal: PrincipalUser}, time.Minute)
	require.NoError(t, err)

	_, err = m.Verify("not-a-token")
	assert.ErrorIs(t, err, ErrMalformed)

	other, err := NewManager("different-secret")
	require.NoError(t, err)
	other.now = m.now
	_, err = other.Verify(token)
	assert.ErrorIs(t, err, ErrSignature)

	expired := *m
	expired.now = func() time.Time { return time.Unix(1_700_000_061, 0).UTC() }
	_, err = expired.Verify(token)
	assert.ErrorIs(t, err, ErrExpired)

	early := *m
	early.now = func() time.Time { return time.Unix(1_700_000_000-120, 0).UTC() }
	_, err = early.Verify(token)
	assert.ErrorIs(t, err, ErrNotYetValid)
}

func TestHTTPMiddlewareCountsRejectionsByReason(t *testing.T) {
	m := testManager(t)
	handler := HTTPMiddleware(m)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	before := testutil.ToFloat64(Rejections.WithLabelValues(reasonMalformed))
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/objects/batch", nil)
	req.Header.Set("Authorization", AuthorizationScheme+" "+strings.Repeat("x", 40))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Equal(t, before+1, testutil.ToFloat64(Rejections.WithLabelValues(reasonMalformed)))

	verifyToken, _, err := m.IssueVerify(VerifyGrant{RepositoryID: 42, Owner: "alice", Repository: "demo", OID: strings.Repeat("a", 64), Size: 1, Principal: PrincipalUser}, time.Hour)
	require.NoError(t, err)
	before = testutil.ToFloat64(Rejections.WithLabelValues(reasonPurpose))
	req = httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/objects/batch", nil)
	req.Header.Set("Authorization", AuthorizationValue(verifyToken))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Equal(t, before+1, testutil.ToFloat64(Rejections.WithLabelValues(reasonPurpose)))
}
