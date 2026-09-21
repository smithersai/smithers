package services

import (
	"context"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// AdminOrgQuerier is the database interface required by AdminOrgService.
type AdminOrgQuerier interface {
	ListAllOrgs(ctx context.Context, arg db.ListAllOrgsParams) ([]db.Organization, error)
	CountAllOrgs(ctx context.Context) (int64, error)
}

// AdminOrgService provides admin-level organization management operations.
type AdminOrgService struct {
	queries AdminOrgQuerier
}

// NewAdminOrgService returns a new AdminOrgService.
func NewAdminOrgService(q AdminOrgQuerier) *AdminOrgService {
	return &AdminOrgService{queries: q}
}

// AdminOrgListInput holds the pagination parameters for listing all orgs.
type AdminOrgListInput struct {
	Page    int
	PerPage int
}

// OrgResponse is the API response shape for an organization.
type OrgResponse struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Visibility  string `json:"visibility"`
	Website     string `json:"website"`
	Location    string `json:"location"`
}

// ListAllOrgs returns a paginated list of all organizations in the system.
func (s *AdminOrgService) ListAllOrgs(ctx context.Context, input AdminOrgListInput) ([]OrgResponse, int64, error) {
	page, perPage := normalizePagination(input.Page, input.PerPage)
	offset := ClampInt32((page - 1) * perPage)

	total, err := s.queries.CountAllOrgs(ctx)
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count orgs")
	}

	orgs, err := s.queries.ListAllOrgs(ctx, db.ListAllOrgsParams{
		PageOffset: offset,
		PageSize:   int32(perPage),
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list orgs")
	}

	responses := make([]OrgResponse, len(orgs))
	for i, o := range orgs {
		responses[i] = OrgResponse{
			ID:          o.ID,
			Name:        o.Name,
			Description: o.Description,
			Visibility:  o.Visibility,
			Website:     o.Website,
			Location:    o.Location,
		}
	}

	return responses, total, nil
}
