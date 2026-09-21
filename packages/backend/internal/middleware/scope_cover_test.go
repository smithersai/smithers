package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestScope_Cov_DirectScopeSetLegacyAndWriteImplications(t *testing.T) {
	t.Parallel()

	legacyAdmin := ScopeSet{ScopeAdmin: struct{}{}}
	assert.True(t, legacyAdmin.Has(ScopeReadAdmin))
	assert.True(t, legacyAdmin.Has(ScopeWriteAdmin))
	assert.False(t, legacyAdmin.Has(ScopeReadRepository))

	directWrite := ScopeSet{ScopeWriteRepository: struct{}{}}
	assert.True(t, directWrite.Has(ScopeReadRepository))
	assert.False(t, directWrite.Has(ScopeReadUser))
}

func TestScope_Cov_RequireFirstPartyAuthRejectsMissingAuth(t *testing.T) {
	t.Parallel()

	handler := RequireFirstPartyAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler should not be called without authenticated user")
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/user/keys", nil))

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Equal(t, "authentication required", apiErrorMessage(t, rec))
}

func TestScope_Cov_NormalizeReadAliases(t *testing.T) {
	t.Parallel()

	assert.Equal(t, ScopeReadWorkspace, NormalizeTokenScope("read:workspace"))
	assert.Equal(t, ScopeReadApproval, NormalizeTokenScope("read:approval"))
	assert.Equal(t, ScopeReadAgent, NormalizeTokenScope("read:agent"))
}
