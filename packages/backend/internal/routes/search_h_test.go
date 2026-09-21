package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestSearch_H_ServiceErrors(t *testing.T) {
	handler := &SearchHandler{Service: mockSearchRouteService{
		searchIssuesFn: func(context.Context, *db.User, services.SearchIssuesInput) (services.IssueSearchResultPage, error) {
			return services.IssueSearchResultPage{}, pkgerrors.Internal("issues unavailable")
		},
		searchUsersFn: func(context.Context, services.SearchUsersInput) (services.UserSearchResultPage, error) {
			return services.UserSearchResultPage{}, pkgerrors.Internal("users unavailable")
		},
		searchCodeFn: func(context.Context, *db.User, services.SearchCodeInput) (services.CodeSearchResultPage, error) {
			return services.CodeSearchResultPage{}, pkgerrors.Internal("code unavailable")
		},
	}}

	cases := []struct {
		name string
		call func(http.ResponseWriter, *http.Request)
		path string
	}{
		{"issues", handler.SearchIssues, "/search/issues?q=x"},
		{"users", handler.SearchUsers, "/search/users?q=x"},
		{"code", handler.SearchCode, "/search/code?q=x"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			tc.call(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
			require.Equal(t, http.StatusInternalServerError, rec.Code)
		})
	}
}

func TestSearch_H_IssueAndCodePaginationErrors(t *testing.T) {
	handler := &SearchHandler{Service: mockSearchRouteService{}}

	rec := httptest.NewRecorder()
	handler.SearchIssues(rec, httptest.NewRequest(http.MethodGet, "/search/issues?page=0", nil))
	require.Equal(t, http.StatusBadRequest, rec.Code)

	rec = httptest.NewRecorder()
	handler.SearchCode(rec, httptest.NewRequest(http.MethodGet, "/search/code?page=0", nil))
	require.Equal(t, http.StatusBadRequest, rec.Code)
}
