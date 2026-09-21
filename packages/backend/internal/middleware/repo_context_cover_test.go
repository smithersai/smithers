package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestRepoContext_Cov_TeamPermissionLookupError(t *testing.T) {
	t.Parallel()

	orgRepo := db.Repository{
		ID:        12,
		Name:      "org-repo",
		LowerName: "org-repo",
		OrgID:     pgtype.Int8{Int64: 55, Valid: true},
	}
	handler := LoadRepoContext(&mockRepoContextQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return orgRepo, nil
		},
		isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
			return false, nil
		},
		getHighestTeamPermissionForRepoUserFn: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "", assert.AnError
		},
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := withRepoRouteParams(httptest.NewRequest(http.MethodGet, "/api/repos/acme/org-repo", nil), "acme", "org-repo")
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &db.User{ID: 10, Username: "carol"}))
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, "failed to resolve repository permission", repoCtxAPIErrorMessage(t, rec))
}
