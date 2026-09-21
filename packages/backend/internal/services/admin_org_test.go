package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// mockAdminOrgQuerier implements AdminOrgQuerier for unit tests.
type mockAdminOrgQuerier struct {
	listAllOrgsFn  func(ctx context.Context, arg db.ListAllOrgsParams) ([]db.Organization, error)
	countAllOrgsFn func(ctx context.Context) (int64, error)
}

func (m *mockAdminOrgQuerier) ListAllOrgs(ctx context.Context, arg db.ListAllOrgsParams) ([]db.Organization, error) {
	if m.listAllOrgsFn != nil {
		return m.listAllOrgsFn(ctx, arg)
	}
	return []db.Organization{}, nil
}

func (m *mockAdminOrgQuerier) CountAllOrgs(ctx context.Context) (int64, error) {
	if m.countAllOrgsFn != nil {
		return m.countAllOrgsFn(ctx)
	}
	return 0, nil
}

func makeDBOrg(id int64, name string) db.Organization {
	now := time.Now().UTC()
	return db.Organization{
		ID:          id,
		Name:        name,
		LowerName:   name,
		Description: "Org " + name,
		Visibility:  "public",
		Website:     "https://" + name + ".example.com",
		Location:    "San Francisco",
		CreatedAt:   now,
		UpdatedAt:   now,
	}
}

func TestAdminOrgService_ListAllOrgs(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	t.Run("returns paginated list of orgs", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminOrgQuerier{
			countAllOrgsFn: func(ctx context.Context) (int64, error) {
				return 2, nil
			},
			listAllOrgsFn: func(ctx context.Context, arg db.ListAllOrgsParams) ([]db.Organization, error) {
				assert.Equal(t, int32(30), arg.PageSize)
				assert.Equal(t, int32(0), arg.PageOffset)
				return []db.Organization{
					makeDBOrg(1, "alpha"),
					makeDBOrg(2, "beta"),
				}, nil
			},
		}

		svc := NewAdminOrgService(q)
		orgs, total, err := svc.ListAllOrgs(ctx, AdminOrgListInput{Page: 1, PerPage: 30})
		require.NoError(t, err)
		assert.Equal(t, int64(2), total)
		require.Len(t, orgs, 2)
		assert.Equal(t, int64(1), orgs[0].ID)
		assert.Equal(t, "alpha", orgs[0].Name)
		assert.Equal(t, "public", orgs[0].Visibility)
	})

	t.Run("returns empty list when no orgs exist", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminOrgQuerier{
			countAllOrgsFn: func(ctx context.Context) (int64, error) {
				return 0, nil
			},
			listAllOrgsFn: func(ctx context.Context, arg db.ListAllOrgsParams) ([]db.Organization, error) {
				return []db.Organization{}, nil
			},
		}

		svc := NewAdminOrgService(q)
		orgs, total, err := svc.ListAllOrgs(ctx, AdminOrgListInput{Page: 1, PerPage: 30})
		require.NoError(t, err)
		assert.Equal(t, int64(0), total)
		assert.Empty(t, orgs)
	})

	t.Run("normalizes zero page to page 1", func(t *testing.T) {
		t.Parallel()

		var capturedOffset int32
		q := &mockAdminOrgQuerier{
			countAllOrgsFn: func(ctx context.Context) (int64, error) { return 0, nil },
			listAllOrgsFn: func(ctx context.Context, arg db.ListAllOrgsParams) ([]db.Organization, error) {
				capturedOffset = arg.PageOffset
				return []db.Organization{}, nil
			},
		}

		svc := NewAdminOrgService(q)
		_, _, err := svc.ListAllOrgs(ctx, AdminOrgListInput{Page: 0, PerPage: 10})
		require.NoError(t, err)
		// Page 0 normalized to page 1 → offset = (1-1)*10 = 0
		assert.Equal(t, int32(0), capturedOffset)
	})

	t.Run("computes correct offset for page 2", func(t *testing.T) {
		t.Parallel()

		var capturedOffset int32
		q := &mockAdminOrgQuerier{
			countAllOrgsFn: func(ctx context.Context) (int64, error) { return 25, nil },
			listAllOrgsFn: func(ctx context.Context, arg db.ListAllOrgsParams) ([]db.Organization, error) {
				capturedOffset = arg.PageOffset
				return []db.Organization{}, nil
			},
		}

		svc := NewAdminOrgService(q)
		_, _, err := svc.ListAllOrgs(ctx, AdminOrgListInput{Page: 2, PerPage: 10})
		require.NoError(t, err)
		// Page 2 with perPage 10 → offset = (2-1)*10 = 10
		assert.Equal(t, int32(10), capturedOffset)
	})

	t.Run("returns internal error when CountAllOrgs fails", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminOrgQuerier{
			countAllOrgsFn: func(ctx context.Context) (int64, error) {
				return 0, errors.New("db connection lost")
			},
		}

		svc := NewAdminOrgService(q)
		_, _, err := svc.ListAllOrgs(ctx, AdminOrgListInput{Page: 1, PerPage: 30})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to count orgs")
	})

	t.Run("returns internal error when ListAllOrgs fails", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminOrgQuerier{
			countAllOrgsFn: func(ctx context.Context) (int64, error) {
				return 5, nil
			},
			listAllOrgsFn: func(ctx context.Context, arg db.ListAllOrgsParams) ([]db.Organization, error) {
				return nil, errors.New("query timeout")
			},
		}

		svc := NewAdminOrgService(q)
		_, _, err := svc.ListAllOrgs(ctx, AdminOrgListInput{Page: 1, PerPage: 30})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to list orgs")
	})

	t.Run("response maps all org fields", func(t *testing.T) {
		t.Parallel()

		org := makeDBOrg(42, "myorg")
		org.Description = "A great org"
		org.Visibility = "private"
		org.Website = "https://myorg.io"
		org.Location = "Remote"

		q := &mockAdminOrgQuerier{
			countAllOrgsFn: func(ctx context.Context) (int64, error) { return 1, nil },
			listAllOrgsFn: func(ctx context.Context, arg db.ListAllOrgsParams) ([]db.Organization, error) {
				return []db.Organization{org}, nil
			},
		}

		svc := NewAdminOrgService(q)
		orgs, total, err := svc.ListAllOrgs(ctx, AdminOrgListInput{Page: 1, PerPage: 30})
		require.NoError(t, err)
		assert.Equal(t, int64(1), total)
		require.Len(t, orgs, 1)
		r := orgs[0]
		assert.Equal(t, int64(42), r.ID)
		assert.Equal(t, "myorg", r.Name)
		assert.Equal(t, "A great org", r.Description)
		assert.Equal(t, "private", r.Visibility)
		assert.Equal(t, "https://myorg.io", r.Website)
		assert.Equal(t, "Remote", r.Location)
	})
}
