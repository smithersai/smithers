package routes

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type resolveCovDBTX struct {
	user *db.User
	org  *db.Organization
}

func (d *resolveCovDBTX) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

func (d *resolveCovDBTX) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	return nil, assert.AnError
}

func (d *resolveCovDBTX) QueryRow(ctx context.Context, query string, args ...interface{}) pgx.Row {
	switch {
	case strings.Contains(query, "FROM users") && d.user != nil:
		u := *d.user
		return &resolveCovRow{values: []any{
			u.ID, u.Username, u.LowerUsername, u.Email, u.LowerEmail, u.DisplayName, u.Bio, u.SearchVector,
			u.AvatarUrl, u.WalletAddress, u.UserType, u.IsActive, u.IsAdmin, u.ProhibitLogin,
			u.EmailNotificationsEnabled, u.LastLoginAt, u.DeletedAt, u.CreatedAt, u.UpdatedAt, u.IsSynthetic,
		}}
	case strings.Contains(query, "FROM organizations") && d.org != nil:
		o := *d.org
		return &resolveCovRow{values: []any{o.ID, o.Name, o.LowerName, o.Description, o.Visibility, o.Website, o.Location, o.CreatedAt, o.UpdatedAt}}
	default:
		return &resolveCovRow{err: sql.ErrNoRows}
	}
}

type resolveCovRow struct {
	values []any
	err    error
}

func (r *resolveCovRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for i := range dest {
		reflect.ValueOf(dest[i]).Elem().Set(reflect.ValueOf(r.values[i]))
	}
	return nil
}

func TestResolve_Cov_GetResolveUserOrgAndNotFound(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 7, 0, 0, 0, 0, time.UTC)

	t.Run("resolves user before org", func(t *testing.T) {
		h := &ResolveHandler{Queries: db.New(&resolveCovDBTX{
			user: &db.User{
				ID: 1, Username: "Alice", LowerUsername: "alice", UserType: "human", IsActive: true,
				Email: pgtype.Text{}, LowerEmail: pgtype.Text{}, LastLoginAt: pgtype.Timestamptz{}, DeletedAt: pgtype.Timestamptz{},
				CreatedAt: now, UpdatedAt: now,
			},
			org: &db.Organization{ID: 2, Name: "AliceOrg", LowerName: "alice", Visibility: "public", CreatedAt: now, UpdatedAt: now},
		})}
		req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/resolve/ALICE", nil), map[string]string{"name": " ALICE "})
		rec := httptest.NewRecorder()

		h.GetResolve(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var body ResolveResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, ResolveResponse{Type: "user", ID: 1, Name: "Alice"}, body)
	})

	t.Run("falls back to org", func(t *testing.T) {
		h := &ResolveHandler{Queries: db.New(&resolveCovDBTX{
			org: &db.Organization{ID: 3, Name: "Acme", LowerName: "acme", Visibility: "public", CreatedAt: now, UpdatedAt: now},
		})}
		req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/resolve/acme", nil), map[string]string{"name": "acme"})
		rec := httptest.NewRecorder()

		h.GetResolve(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var body ResolveResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		assert.Equal(t, ResolveResponse{Type: "org", ID: 3, Name: "Acme"}, body)
	})

	t.Run("not found when neither exists", func(t *testing.T) {
		h := &ResolveHandler{Queries: db.New(&resolveCovDBTX{})}
		req := withRouteParams(httptest.NewRequest(http.MethodGet, "/api/resolve/missing", nil), map[string]string{"name": "missing"})
		rec := httptest.NewRecorder()

		h.GetResolve(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.Contains(t, rec.Body.String(), "user or organization not found")
	})
}
