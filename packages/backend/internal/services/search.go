package services

import (
	"context"
	"fmt"
	"html"
	"math"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	searchDefaultPage    = 1
	searchDefaultPerPage = 30
	searchMaxPerPage     = 100
	searchMaxQueryLen    = 500
)

type SearchQuerier interface {
	SearchRepositoriesFTS(ctx context.Context, arg db.SearchRepositoriesFTSParams) ([]db.SearchRepositoriesFTSRow, error)
	CountSearchRepositoriesFTS(ctx context.Context, arg db.CountSearchRepositoriesFTSParams) (int64, error)
	SearchIssuesFTS(ctx context.Context, arg db.SearchIssuesFTSParams) ([]db.SearchIssuesFTSRow, error)
	CountSearchIssuesFTS(ctx context.Context, arg db.CountSearchIssuesFTSParams) (int64, error)
	SearchCodeFTS(ctx context.Context, arg db.SearchCodeFTSParams) ([]db.SearchCodeFTSRow, error)
	CountSearchCodeFTS(ctx context.Context, arg db.CountSearchCodeFTSParams) (int64, error)
	SearchUsersFTS(ctx context.Context, arg db.SearchUsersFTSParams) ([]db.SearchUsersFTSRow, error)
	CountSearchUsersFTS(ctx context.Context, query string) (int64, error)
}

type SearchService struct {
	queries SearchQuerier
}

type SearchRepositoriesInput struct {
	Query   string `json:"query"`
	Page    int    `json:"page"`
	PerPage int    `json:"per_page"`
}

type SearchIssuesInput struct {
	Query     string `json:"query"`
	State     string `json:"state"`
	Label     string `json:"label"`
	Assignee  string `json:"assignee"`
	Milestone string `json:"milestone"`
	Page      int    `json:"page"`
	PerPage   int    `json:"per_page"`
}

type SearchUsersInput struct {
	Query   string `json:"query"`
	Page    int    `json:"page"`
	PerPage int    `json:"per_page"`
}

type SearchCodeInput struct {
	Query   string `json:"query"`
	Page    int    `json:"page"`
	PerPage int    `json:"per_page"`
}

type RepositorySearchResult struct {
	ID          int64    `json:"id"`
	Owner       string   `json:"owner"`
	Name        string   `json:"name"`
	FullName    string   `json:"full_name"`
	Description string   `json:"description"`
	IsPublic    bool     `json:"is_public"`
	Topics      []string `json:"topics"`
}

type RepositorySearchResultPage struct {
	Items      []RepositorySearchResult `json:"items"`
	TotalCount int64                    `json:"total_count"`
	Page       int                      `json:"page"`
	PerPage    int                      `json:"per_page"`
}

type IssueSearchResult struct {
	ID              int64  `json:"id"`
	RepositoryID    int64  `json:"repository_id"`
	RepositoryOwner string `json:"repository_owner"`
	RepositoryName  string `json:"repository_name"`
	Number          int64  `json:"number"`
	Title           string `json:"title"`
	State           string `json:"state"`
}

type IssueSearchResultPage struct {
	Items      []IssueSearchResult `json:"items"`
	TotalCount int64               `json:"total_count"`
	Page       int                 `json:"page"`
	PerPage    int                 `json:"per_page"`
}

type UserSearchResult struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url"`
}

type UserSearchResultPage struct {
	Items      []UserSearchResult `json:"items"`
	TotalCount int64              `json:"total_count"`
	Page       int                `json:"page"`
	PerPage    int                `json:"per_page"`
}

type CodeSearchResult struct {
	RepositoryID    int64  `json:"repository_id"`
	RepositoryOwner string `json:"repository_owner"`
	RepositoryName  string `json:"repository_name"`
	Path            string `json:"path"`
	Snippet         string `json:"snippet"`
}

type CodeSearchResultPage struct {
	Items      []CodeSearchResult `json:"items"`
	TotalCount int64              `json:"total_count"`
	Page       int                `json:"page"`
	PerPage    int                `json:"per_page"`
}

func NewSearchService(q SearchQuerier) *SearchService {
	return &SearchService{queries: q}
}

func (s *SearchService) SearchRepositories(ctx context.Context, viewer *db.User, input SearchRepositoriesInput) (RepositorySearchResultPage, error) {
	query := strings.TrimSpace(input.Query)
	if query == "" {
		return RepositorySearchResultPage{}, pkgerrors.New(pkgerrors.CodeUnprocessableEntity, "query required")
	}
	if len(query) > searchMaxQueryLen {
		return RepositorySearchResultPage{}, pkgerrors.New(pkgerrors.CodeBadRequest, "query too long")
	}

	page, perPage := normalizeSearchPagination(input.Page, input.PerPage)
	viewerID := searchViewerID(viewer)
	pageOffset := ClampInt32((page - 1) * perPage)

	total, err := s.queries.CountSearchRepositoriesFTS(ctx, db.CountSearchRepositoriesFTSParams{
		Query:    query,
		ViewerID: viewerID,
	})
	if err != nil {
		return RepositorySearchResultPage{}, pkgerrors.Internal("failed to count repositories").WithCause(err)
	}
	if total == 0 {
		return RepositorySearchResultPage{
			Items:      []RepositorySearchResult{},
			TotalCount: 0,
			Page:       page,
			PerPage:    perPage,
		}, nil
	}

	rows, err := s.queries.SearchRepositoriesFTS(ctx, db.SearchRepositoriesFTSParams{
		Query:      query,
		ViewerID:   viewerID,
		PageOffset: pageOffset,
		PageSize:   int32(perPage),
	})
	if err != nil {
		return RepositorySearchResultPage{}, pkgerrors.Internal("failed to search repositories").WithCause(err)
	}

	items := make([]RepositorySearchResult, 0, len(rows))
	for _, row := range rows {
		items = append(items, RepositorySearchResult{
			ID:          row.ID,
			Owner:       row.OwnerName,
			Name:        row.Name,
			FullName:    fmt.Sprintf("%s/%s", row.OwnerName, row.Name),
			Description: row.Description,
			IsPublic:    row.IsPublic,
			Topics:      row.Topics,
		})
	}

	return RepositorySearchResultPage{
		Items:      items,
		TotalCount: total,
		Page:       page,
		PerPage:    perPage,
	}, nil
}

func (s *SearchService) SearchIssues(ctx context.Context, viewer *db.User, input SearchIssuesInput) (IssueSearchResultPage, error) {
	query := strings.TrimSpace(input.Query)
	if query == "" {
		return IssueSearchResultPage{}, pkgerrors.New(pkgerrors.CodeUnprocessableEntity, "query required")
	}
	if len(query) > searchMaxQueryLen {
		return IssueSearchResultPage{}, pkgerrors.New(pkgerrors.CodeBadRequest, "query too long")
	}

	state := strings.ToLower(strings.TrimSpace(input.State))
	if state != "" && state != "open" && state != "closed" {
		return IssueSearchResultPage{}, pkgerrors.New(pkgerrors.CodeUnprocessableEntity, "invalid state filter")
	}
	label := strings.ToLower(strings.TrimSpace(input.Label))
	assignee := strings.ToLower(strings.TrimSpace(input.Assignee))
	milestone := strings.ToLower(strings.TrimSpace(input.Milestone))

	page, perPage := normalizeSearchPagination(input.Page, input.PerPage)
	viewerID := searchViewerID(viewer)
	pageOffset := ClampInt32((page - 1) * perPage)

	total, err := s.queries.CountSearchIssuesFTS(ctx, db.CountSearchIssuesFTSParams{
		Query:           query,
		StateFilter:     state,
		LabelFilter:     label,
		AssigneeFilter:  assignee,
		MilestoneFilter: milestone,
		ViewerID:        viewerID,
	})
	if err != nil {
		return IssueSearchResultPage{}, pkgerrors.Internal("failed to count issues").WithCause(err)
	}
	if total == 0 {
		return IssueSearchResultPage{
			Items:      []IssueSearchResult{},
			TotalCount: 0,
			Page:       page,
			PerPage:    perPage,
		}, nil
	}

	rows, err := s.queries.SearchIssuesFTS(ctx, db.SearchIssuesFTSParams{
		Query:           query,
		StateFilter:     state,
		LabelFilter:     label,
		AssigneeFilter:  assignee,
		MilestoneFilter: milestone,
		ViewerID:        viewerID,
		PageOffset:      pageOffset,
		PageSize:        int32(perPage),
	})
	if err != nil {
		return IssueSearchResultPage{}, pkgerrors.Internal("failed to search issues").WithCause(err)
	}

	items := make([]IssueSearchResult, 0, len(rows))
	for _, row := range rows {
		items = append(items, IssueSearchResult{
			ID:              row.ID,
			RepositoryID:    row.RepositoryID,
			RepositoryOwner: row.OwnerName,
			RepositoryName:  row.RepositoryName,
			Number:          row.Number,
			Title:           row.Title,
			State:           row.State,
		})
	}

	return IssueSearchResultPage{
		Items:      items,
		TotalCount: total,
		Page:       page,
		PerPage:    perPage,
	}, nil
}

func (s *SearchService) SearchUsers(ctx context.Context, input SearchUsersInput) (UserSearchResultPage, error) {
	query := strings.TrimSpace(input.Query)
	if query == "" {
		return UserSearchResultPage{}, pkgerrors.New(pkgerrors.CodeUnprocessableEntity, "query required")
	}
	if len(query) > searchMaxQueryLen {
		return UserSearchResultPage{}, pkgerrors.New(pkgerrors.CodeBadRequest, "query too long")
	}

	page, perPage := normalizeSearchPagination(input.Page, input.PerPage)
	pageOffset := ClampInt32((page - 1) * perPage)

	total, err := s.queries.CountSearchUsersFTS(ctx, query)
	if err != nil {
		return UserSearchResultPage{}, pkgerrors.Internal("failed to count users").WithCause(err)
	}
	if total == 0 {
		return UserSearchResultPage{
			Items:      []UserSearchResult{},
			TotalCount: 0,
			Page:       page,
			PerPage:    perPage,
		}, nil
	}

	rows, err := s.queries.SearchUsersFTS(ctx, db.SearchUsersFTSParams{
		Query:      query,
		PageOffset: pageOffset,
		PageSize:   int32(perPage),
	})
	if err != nil {
		return UserSearchResultPage{}, pkgerrors.Internal("failed to search users").WithCause(err)
	}

	items := make([]UserSearchResult, 0, len(rows))
	for _, row := range rows {
		items = append(items, UserSearchResult{
			ID:          row.ID,
			Username:    row.Username,
			DisplayName: row.DisplayName,
			AvatarURL:   row.AvatarUrl,
		})
	}

	return UserSearchResultPage{
		Items:      items,
		TotalCount: total,
		Page:       page,
		PerPage:    perPage,
	}, nil
}

func (s *SearchService) SearchCode(ctx context.Context, viewer *db.User, input SearchCodeInput) (CodeSearchResultPage, error) {
	query := strings.TrimSpace(input.Query)
	if query == "" {
		return CodeSearchResultPage{}, pkgerrors.New(pkgerrors.CodeUnprocessableEntity, "query required")
	}
	if len(query) > searchMaxQueryLen {
		return CodeSearchResultPage{}, pkgerrors.New(pkgerrors.CodeBadRequest, "query too long")
	}

	page, perPage := normalizeSearchPagination(input.Page, input.PerPage)
	viewerID := searchViewerID(viewer)
	pageOffset := ClampInt32((page - 1) * perPage)

	total, err := s.queries.CountSearchCodeFTS(ctx, db.CountSearchCodeFTSParams{
		Query:    query,
		ViewerID: viewerID,
	})
	if err != nil {
		return CodeSearchResultPage{}, pkgerrors.Internal("failed to count code results").WithCause(err)
	}
	if total == 0 {
		return CodeSearchResultPage{
			Items:      []CodeSearchResult{},
			TotalCount: 0,
			Page:       page,
			PerPage:    perPage,
		}, nil
	}

	rows, err := s.queries.SearchCodeFTS(ctx, db.SearchCodeFTSParams{
		Query:      query,
		ViewerID:   viewerID,
		PageOffset: pageOffset,
		PageSize:   int32(perPage),
	})
	if err != nil {
		return CodeSearchResultPage{}, pkgerrors.Internal("failed to search code").WithCause(err)
	}

	items := make([]CodeSearchResult, 0, len(rows))
	for _, row := range rows {
		items = append(items, CodeSearchResult{
			RepositoryID:    row.RepositoryID,
			RepositoryOwner: row.OwnerName,
			RepositoryName:  row.RepositoryName,
			Path:            row.FilePath,
			Snippet:         html.EscapeString(string(row.Snippet)),
		})
	}

	return CodeSearchResultPage{
		Items:      items,
		TotalCount: total,
		Page:       page,
		PerPage:    perPage,
	}, nil
}

func normalizeSearchPagination(page int, perPage int) (int, int) {
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = searchDefaultPerPage
	}
	if perPage > searchMaxPerPage {
		perPage = searchMaxPerPage
	}
	// Cap page so the SQL offset (page-1)*perPage cannot overflow int32 at the
	// call sites — an overflow wraps to a negative OFFSET and 500s the query.
	if maxPage := math.MaxInt32/perPage + 1; page > maxPage {
		page = maxPage
	}
	return page, perPage
}

func searchViewerID(viewer *db.User) int64 {
	if viewer == nil {
		return 0
	}
	return viewer.ID
}
