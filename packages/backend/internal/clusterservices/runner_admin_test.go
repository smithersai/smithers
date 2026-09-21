package clusterservices

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockRunnerAdminQuerier struct {
	listRunnersFn  func(ctx context.Context, arg db.ListRunnersParams) ([]db.RunnerPool, error)
	countRunnersFn func(ctx context.Context, statusFilter string) (int64, error)
}

func (m *mockRunnerAdminQuerier) ListRunners(ctx context.Context, arg db.ListRunnersParams) ([]db.RunnerPool, error) {
	if m.listRunnersFn != nil {
		return m.listRunnersFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockRunnerAdminQuerier) CountRunners(ctx context.Context, statusFilter string) (int64, error) {
	if m.countRunnersFn != nil {
		return m.countRunnersFn(ctx, statusFilter)
	}
	return 0, nil
}

func makeRunner(id int64, name, status string) db.RunnerPool {
	now := time.Now()
	ts := pgtype.Timestamptz{Time: now, Valid: true}
	return db.RunnerPool{
		ID:              id,
		Name:            name,
		Status:          status,
		LastHeartbeatAt: ts,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
}

func TestRunnerAdminService_ListRunners(t *testing.T) {
	t.Parallel()

	t.Run("returns runners with total count", func(t *testing.T) {
		t.Parallel()

		q := &mockRunnerAdminQuerier{
			listRunnersFn: func(ctx context.Context, arg db.ListRunnersParams) ([]db.RunnerPool, error) {
				assert.Equal(t, "", arg.StatusFilter)
				assert.Equal(t, int32(0), arg.PageOffset)
				assert.Equal(t, int32(30), arg.PageSize)
				return []db.RunnerPool{
					makeRunner(1, "runner-a", "idle"),
					makeRunner(2, "runner-b", "busy"),
				}, nil
			},
			countRunnersFn: func(ctx context.Context, statusFilter string) (int64, error) {
				assert.Equal(t, "", statusFilter)
				return 2, nil
			},
		}

		svc := NewRunnerAdminService(q)
		result, total, err := svc.ListRunners(context.Background(), RunnerAdminListInput{
			Page:    1,
			PerPage: 30,
		})

		require.NoError(t, err)
		assert.Equal(t, int64(2), total)
		require.Len(t, result, 2)
		assert.Equal(t, int64(1), result[0].ID)
		assert.Equal(t, "runner-a", result[0].Name)
		assert.Equal(t, "idle", result[0].Status)
	})

	t.Run("filters by status", func(t *testing.T) {
		t.Parallel()

		q := &mockRunnerAdminQuerier{
			listRunnersFn: func(ctx context.Context, arg db.ListRunnersParams) ([]db.RunnerPool, error) {
				assert.Equal(t, "idle", arg.StatusFilter)
				return []db.RunnerPool{makeRunner(1, "runner-a", "idle")}, nil
			},
			countRunnersFn: func(ctx context.Context, statusFilter string) (int64, error) {
				assert.Equal(t, "idle", statusFilter)
				return 1, nil
			},
		}

		svc := NewRunnerAdminService(q)
		result, total, err := svc.ListRunners(context.Background(), RunnerAdminListInput{
			Page:         1,
			PerPage:      30,
			StatusFilter: "idle",
		})

		require.NoError(t, err)
		assert.Equal(t, int64(1), total)
		require.Len(t, result, 1)
		assert.Equal(t, "idle", result[0].Status)
	})

	t.Run("rejects invalid status filter", func(t *testing.T) {
		t.Parallel()

		svc := NewRunnerAdminService(&mockRunnerAdminQuerier{})
		_, _, err := svc.ListRunners(context.Background(), RunnerAdminListInput{
			Page:         1,
			PerPage:      30,
			StatusFilter: "invalid-status",
		})

		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 400, apiErr.Status)
	})

	t.Run("uses correct pagination offset", func(t *testing.T) {
		t.Parallel()

		q := &mockRunnerAdminQuerier{
			listRunnersFn: func(ctx context.Context, arg db.ListRunnersParams) ([]db.RunnerPool, error) {
				assert.Equal(t, int32(10), arg.PageOffset) // page 2, perPage 10
				assert.Equal(t, int32(10), arg.PageSize)
				return []db.RunnerPool{}, nil
			},
			countRunnersFn: func(ctx context.Context, statusFilter string) (int64, error) {
				return 25, nil
			},
		}

		svc := NewRunnerAdminService(q)
		_, total, err := svc.ListRunners(context.Background(), RunnerAdminListInput{
			Page:    2,
			PerPage: 10,
		})

		require.NoError(t, err)
		assert.Equal(t, int64(25), total)
	})

	t.Run("returns empty slice when no runners", func(t *testing.T) {
		t.Parallel()

		q := &mockRunnerAdminQuerier{
			listRunnersFn: func(ctx context.Context, arg db.ListRunnersParams) ([]db.RunnerPool, error) {
				return []db.RunnerPool{}, nil
			},
			countRunnersFn: func(ctx context.Context, statusFilter string) (int64, error) {
				return 0, nil
			},
		}

		svc := NewRunnerAdminService(q)
		result, total, err := svc.ListRunners(context.Background(), RunnerAdminListInput{
			Page:    1,
			PerPage: 30,
		})

		require.NoError(t, err)
		assert.Equal(t, int64(0), total)
		assert.Empty(t, result)
	})
}
