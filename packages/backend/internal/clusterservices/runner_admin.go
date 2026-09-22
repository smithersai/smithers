package clusterservices

import (
	"context"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"

	"github.com/smithersai/smithers/packages/backend/internal/services"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// validRunnerStatuses are the allowed values for the status filter.
var validRunnerStatuses = map[string]bool{
	"":         true, // empty means all
	"idle":     true,
	"busy":     true,
	"offline":  true,
	"draining": true,
}

// RunnerAdminListInput carries pagination and filter parameters for listing runners.
type RunnerAdminListInput struct {
	Page         int
	PerPage      int
	StatusFilter string
}

// RunnerAdminQuerier is the database interface needed by RunnerAdminService.
type RunnerAdminQuerier interface {
	ListRunners(ctx context.Context, arg clusterdb.ListRunnersParams) ([]clusterdb.RunnerPool, error)
	CountRunners(ctx context.Context, statusFilter string) (int64, error)
}

// RunnerAdminService exposes admin-level runner observability operations.
type RunnerAdminService interface {
	ListRunners(ctx context.Context, input RunnerAdminListInput) ([]clusterdb.RunnerPool, int64, error)
}

type runnerAdminService struct {
	queries RunnerAdminQuerier
}

// NewRunnerAdminService creates a RunnerAdminService backed by the given querier.
func NewRunnerAdminService(queries RunnerAdminQuerier) RunnerAdminService {
	return &runnerAdminService{queries: queries}
}

// ListRunners returns a paginated list of runners and the total count.
func (s *runnerAdminService) ListRunners(ctx context.Context, input RunnerAdminListInput) ([]clusterdb.RunnerPool, int64, error) {
	if !validRunnerStatuses[input.StatusFilter] {
		return nil, 0, pkgerrors.BadRequest("invalid status filter: must be one of idle, busy, offline, draining, or empty for all")
	}

	page := input.Page
	if page < 1 {
		page = 1
	}
	perPage := input.PerPage
	if perPage < 1 {
		perPage = 30
	}

	offset := services.ClampInt32((page - 1) * perPage)

	total, err := s.queries.CountRunners(ctx, input.StatusFilter)
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count runners")
	}

	rows, err := s.queries.ListRunners(ctx, clusterdb.ListRunnersParams{
		StatusFilter: input.StatusFilter,
		PageOffset:   offset,
		PageSize:     int32(perPage),
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list runners")
	}

	return rows, total, nil
}
