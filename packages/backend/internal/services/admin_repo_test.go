package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// mockAdminRepoQuerier implements AdminRepoQuerier for unit tests.
type mockAdminRepoQuerier struct {
	listAllReposFn  func(ctx context.Context, arg db.ListAllReposParams) ([]db.Repository, error)
	countAllReposFn func(ctx context.Context) (int64, error)
}

func (m *mockAdminRepoQuerier) ListAllRepos(ctx context.Context, arg db.ListAllReposParams) ([]db.Repository, error) {
	if m.listAllReposFn != nil {
		return m.listAllReposFn(ctx, arg)
	}
	return []db.Repository{}, nil
}

func (m *mockAdminRepoQuerier) CountAllRepos(ctx context.Context) (int64, error) {
	if m.countAllReposFn != nil {
		return m.countAllReposFn(ctx)
	}
	return 0, nil
}

func makeDBRepo(id int64, name string, isPublic bool) db.Repository {
	now := time.Now().UTC()
	return db.Repository{
		ID:          id,
		UserID:      pgtype.Int8{Int64: 1, Valid: true},
		Name:        name,
		LowerName:   name,
		Description: "Repo " + name,
		IsPublic:    isPublic,
		IsArchived:  false,
		NumStars:    0,
		NumIssues:   0,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
}

func TestAdminRepoService_ListAllRepos(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	t.Run("returns paginated list of repos", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminRepoQuerier{
			countAllReposFn: func(ctx context.Context) (int64, error) {
				return 2, nil
			},
			listAllReposFn: func(ctx context.Context, arg db.ListAllReposParams) ([]db.Repository, error) {
				assert.Equal(t, int32(30), arg.PageSize)
				assert.Equal(t, int32(0), arg.PageOffset)
				return []db.Repository{
					makeDBRepo(1, "repo-one", true),
					makeDBRepo(2, "repo-two", false),
				}, nil
			},
		}

		svc := NewAdminRepoService(q)
		repos, total, err := svc.ListAllRepos(ctx, AdminRepoListInput{Page: 1, PerPage: 30})
		require.NoError(t, err)
		assert.Equal(t, int64(2), total)
		require.Len(t, repos, 2)
		assert.Equal(t, int64(1), repos[0].ID)
		assert.Equal(t, "repo-one", repos[0].Name)
		assert.True(t, repos[0].IsPublic)
		assert.False(t, repos[1].IsPublic)
	})

	t.Run("returns empty list when no repos", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminRepoQuerier{
			countAllReposFn: func(ctx context.Context) (int64, error) { return 0, nil },
			listAllReposFn: func(ctx context.Context, arg db.ListAllReposParams) ([]db.Repository, error) {
				return []db.Repository{}, nil
			},
		}

		svc := NewAdminRepoService(q)
		repos, total, err := svc.ListAllRepos(ctx, AdminRepoListInput{Page: 1, PerPage: 30})
		require.NoError(t, err)
		assert.Equal(t, int64(0), total)
		assert.Empty(t, repos)
	})

	t.Run("computes correct offset for page 3 with per_page 5", func(t *testing.T) {
		t.Parallel()

		var capturedOffset int32
		q := &mockAdminRepoQuerier{
			countAllReposFn: func(ctx context.Context) (int64, error) { return 20, nil },
			listAllReposFn: func(ctx context.Context, arg db.ListAllReposParams) ([]db.Repository, error) {
				capturedOffset = arg.PageOffset
				return []db.Repository{}, nil
			},
		}

		svc := NewAdminRepoService(q)
		_, _, err := svc.ListAllRepos(ctx, AdminRepoListInput{Page: 3, PerPage: 5})
		require.NoError(t, err)
		// Page 3, per_page 5 → offset = (3-1)*5 = 10
		assert.Equal(t, int32(10), capturedOffset)
	})

	t.Run("returns internal error when CountAllRepos fails", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminRepoQuerier{
			countAllReposFn: func(ctx context.Context) (int64, error) {
				return 0, errors.New("db unavailable")
			},
		}

		svc := NewAdminRepoService(q)
		_, _, err := svc.ListAllRepos(ctx, AdminRepoListInput{Page: 1, PerPage: 30})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to count repos")
	})

	t.Run("returns internal error when ListAllRepos fails", func(t *testing.T) {
		t.Parallel()

		q := &mockAdminRepoQuerier{
			countAllReposFn: func(ctx context.Context) (int64, error) { return 3, nil },
			listAllReposFn: func(ctx context.Context, arg db.ListAllReposParams) ([]db.Repository, error) {
				return nil, errors.New("query failed")
			},
		}

		svc := NewAdminRepoService(q)
		_, _, err := svc.ListAllRepos(ctx, AdminRepoListInput{Page: 1, PerPage: 30})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to list repos")
	})

	t.Run("response maps all repo fields correctly", func(t *testing.T) {
		t.Parallel()

		now := time.Now().UTC()
		repo := db.Repository{
			ID:          99,
			Name:        "featured-repo",
			Description: "A featured repository",
			IsPublic:    true,
			IsArchived:  false,
			NumStars:    42,
			NumIssues:   7,
			CreatedAt:   now,
			UpdatedAt:   now,
		}

		q := &mockAdminRepoQuerier{
			countAllReposFn: func(ctx context.Context) (int64, error) { return 1, nil },
			listAllReposFn: func(ctx context.Context, arg db.ListAllReposParams) ([]db.Repository, error) {
				return []db.Repository{repo}, nil
			},
		}

		svc := NewAdminRepoService(q)
		repos, _, err := svc.ListAllRepos(ctx, AdminRepoListInput{Page: 1, PerPage: 30})
		require.NoError(t, err)
		require.Len(t, repos, 1)
		r := repos[0]
		assert.Equal(t, int64(99), r.ID)
		assert.Equal(t, "featured-repo", r.Name)
		assert.Equal(t, "A featured repository", r.Description)
		assert.True(t, r.IsPublic)
		assert.False(t, r.IsArchived)
		assert.Equal(t, int64(42), r.NumStars)
		assert.Equal(t, int64(7), r.NumIssues)
	})
}
