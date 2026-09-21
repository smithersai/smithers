package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestSecrets_Z_RepoSecretErrors(t *testing.T) {
	t.Parallel()

	t.Run("list requires repo params", func(t *testing.T) {
		t.Parallel()
		h := SecretHandler{Service: secretsCovService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice//secrets", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice"})
		rec := httptest.NewRecorder()

		h.ListSecrets(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("list propagates service error", func(t *testing.T) {
		t.Parallel()
		h := SecretHandler{Service: secretsCovService{
			listSecretsFn: func(context.Context, *db.User, string, string) ([]services.SecretResponse, error) {
				return nil, pkgerrors.Forbidden("permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/secrets", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()

		h.ListSecrets(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("set requires repo params", func(t *testing.T) {
		t.Parallel()
		h := SecretHandler{Service: secretsCovService{}}
		req := httptest.NewRequest(http.MethodPut, "/api/repos/alice//secrets", strings.NewReader(`{"name":"TOKEN","value":"secret"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.SetSecret(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete requires repo params", func(t *testing.T) {
		t.Parallel()
		h := SecretHandler{Service: secretsCovService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice//secrets/TOKEN", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "name": "TOKEN"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.DeleteSecret(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete requires name", func(t *testing.T) {
		t.Parallel()
		h := SecretHandler{Service: secretsCovService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/secrets/", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.DeleteSecret(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete propagates service error", func(t *testing.T) {
		t.Parallel()
		h := SecretHandler{Service: secretsCovService{
			deleteSecretFn: func(context.Context, *db.User, string, string, string) error {
				return pkgerrors.NotFound("secret not found")
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/secrets/TOKEN", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "name": "TOKEN"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.DeleteSecret(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})
}

func TestSecrets_Z_OrgSecretErrors(t *testing.T) {
	t.Parallel()

	t.Run("list requires org", func(t *testing.T) {
		t.Parallel()
		h := SecretHandler{Service: secretsCovService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/orgs//secrets", nil)
		rec := httptest.NewRecorder()

		h.ListOrgSecrets(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("set requires auth", func(t *testing.T) {
		t.Parallel()
		h := SecretHandler{Service: secretsCovService{}}
		req := httptest.NewRequest(http.MethodPut, "/api/orgs/acme/secrets", strings.NewReader(`{"name":"TOKEN","value":"secret"}`))
		req = withRouteParams(req, map[string]string{"org": "acme"})
		rec := httptest.NewRecorder()

		h.SetOrgSecret(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("set requires org", func(t *testing.T) {
		t.Parallel()
		h := SecretHandler{Service: secretsCovService{}}
		req := httptest.NewRequest(http.MethodPut, "/api/orgs//secrets", strings.NewReader(`{"name":"TOKEN","value":"secret"}`))
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.SetOrgSecret(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("set rejects invalid name", func(t *testing.T) {
		t.Parallel()
		h := SecretHandler{Service: secretsCovService{}}
		req := httptest.NewRequest(http.MethodPut, "/api/orgs/acme/secrets", strings.NewReader(`{"name":"bad name","value":"secret"}`))
		req = withRouteParams(req, map[string]string{"org": "acme"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.SetOrgSecret(rec, req)

		require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	})

	t.Run("set rejects invalid value", func(t *testing.T) {
		t.Parallel()
		h := SecretHandler{Service: secretsCovService{}}
		req := httptest.NewRequest(http.MethodPut, "/api/orgs/acme/secrets", strings.NewReader(`{"name":"TOKEN","value":""}`))
		req = withRouteParams(req, map[string]string{"org": "acme"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.SetOrgSecret(rec, req)

		require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	})

	t.Run("set propagates service error", func(t *testing.T) {
		t.Parallel()
		h := SecretHandler{Service: secretsCovService{
			setOrgSecretFn: func(context.Context, *db.User, string, string, string) (services.SecretResponse, error) {
				return services.SecretResponse{}, pkgerrors.Conflict("secret conflict")
			},
		}}
		req := httptest.NewRequest(http.MethodPut, "/api/orgs/acme/secrets", strings.NewReader(`{"name":"TOKEN","value":"secret"}`))
		req = withRouteParams(req, map[string]string{"org": "acme"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.SetOrgSecret(rec, req)

		require.Equal(t, http.StatusConflict, rec.Code)
	})

	t.Run("delete requires auth", func(t *testing.T) {
		t.Parallel()
		h := SecretHandler{Service: secretsCovService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/orgs/acme/secrets/TOKEN", nil)
		req = withRouteParams(req, map[string]string{"org": "acme", "name": "TOKEN"})
		rec := httptest.NewRecorder()

		h.DeleteOrgSecret(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("delete requires org", func(t *testing.T) {
		t.Parallel()
		h := SecretHandler{Service: secretsCovService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/orgs//secrets/TOKEN", nil)
		req = withRouteParams(req, map[string]string{"name": "TOKEN"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.DeleteOrgSecret(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete requires name", func(t *testing.T) {
		t.Parallel()
		h := SecretHandler{Service: secretsCovService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/orgs/acme/secrets/", nil)
		req = withRouteParams(req, map[string]string{"org": "acme"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.DeleteOrgSecret(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete propagates service error", func(t *testing.T) {
		t.Parallel()
		h := SecretHandler{Service: secretsCovService{
			deleteOrgSecretFn: func(context.Context, *db.User, string, string) error {
				return pkgerrors.Forbidden("permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/orgs/acme/secrets/TOKEN", nil)
		req = withRouteParams(req, map[string]string{"org": "acme", "name": "TOKEN"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.DeleteOrgSecret(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})
}
