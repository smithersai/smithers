package services

import (
	"context"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// AdminRepoQuerier is the database interface required by AdminRepoService.
type AdminRepoQuerier interface {
	ListAllRepos(ctx context.Context, arg db.ListAllReposParams) ([]db.Repository, error)
	CountAllRepos(ctx context.Context) (int64, error)
}

// AdminRepoService provides admin-level repository listing operations.
type AdminRepoService struct {
	queries AdminRepoQuerier
}

// NewAdminRepoService returns a new AdminRepoService.
func NewAdminRepoService(q AdminRepoQuerier) *AdminRepoService {
	return &AdminRepoService{queries: q}
}

// AdminRepoListInput holds the pagination parameters for listing all repos.
type AdminRepoListInput struct {
	Page    int
	PerPage int
}

// AdminRepoResponse is the API response shape for a repository in admin context.
type AdminRepoResponse struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	IsPublic    bool      `json:"is_public"`
	IsArchived  bool      `json:"is_archived"`
	NumStars    int64     `json:"num_stars"`
	NumIssues   int64     `json:"num_issues"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// ListAllRepos returns a paginated list of all repositories in the system.
func (s *AdminRepoService) ListAllRepos(ctx context.Context, input AdminRepoListInput) ([]AdminRepoResponse, int64, error) {
	page, perPage := normalizePagination(input.Page, input.PerPage)
	offset := ClampInt32((page - 1) * perPage)

	total, err := s.queries.CountAllRepos(ctx)
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count repos")
	}

	repos, err := s.queries.ListAllRepos(ctx, db.ListAllReposParams{
		PageOffset: offset,
		PageSize:   int32(perPage),
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list repos")
	}

	responses := make([]AdminRepoResponse, len(repos))
	for i, r := range repos {
		responses[i] = AdminRepoResponse{
			ID:          r.ID,
			Name:        r.Name,
			Description: r.Description,
			IsPublic:    r.IsPublic,
			IsArchived:  r.IsArchived,
			NumStars:    r.NumStars,
			NumIssues:   r.NumIssues,
			CreatedAt:   r.CreatedAt,
			UpdatedAt:   r.UpdatedAt,
		}
	}

	return responses, total, nil
}
