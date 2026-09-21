package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestLabels_Z_MissingRepoContextBranches(t *testing.T) {
	handler := LabelHandler{Service: &mockLabelRouteService{}}

	for _, tc := range []struct {
		name   string
		method func(http.ResponseWriter, *http.Request)
		body   string
		auth   bool
	}{
		{"post repo label", handler.PostRepoLabel, `{"name":"bug"}`, true},
		{"get repo labels", handler.GetRepoLabels, "", false},
		{"get repo label", handler.GetRepoLabel, "", false},
		{"patch repo label", handler.PatchRepoLabel, `{"name":"bug"}`, true},
		{"delete repo label", handler.DeleteRepoLabel, "", true},
		{"post issue labels", handler.PostIssueLabels, `{"labels":["bug"]}`, true},
		{"get issue labels", handler.GetIssueLabels, "", false},
		{"delete issue label", handler.DeleteIssueLabel, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/repos//demo/labels", strings.NewReader(tc.body))
			if tc.auth {
				req = withAuth(req, 1, "alice")
			}
			rec := httptest.NewRecorder()

			tc.method(rec, req)

			require.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}
}

func TestLabels_Z_MissingAuthAndInvalidParamBranches(t *testing.T) {
	handler := LabelHandler{Service: &mockLabelRouteService{}}

	for _, tc := range []struct {
		name   string
		method func(http.ResponseWriter, *http.Request)
		params map[string]string
		body   string
	}{
		{"patch repo label requires auth", handler.PatchRepoLabel, map[string]string{"owner": "alice", "repo": "demo", "id": "8"}, `{"name":"bug"}`},
		{"delete repo label requires auth", handler.DeleteRepoLabel, map[string]string{"owner": "alice", "repo": "demo", "id": "8"}, ""},
		{"post issue labels requires auth", handler.PostIssueLabels, map[string]string{"owner": "alice", "repo": "demo", "number": "3"}, `{"labels":["bug"]}`},
		{"delete issue label requires auth", handler.DeleteIssueLabel, map[string]string{"owner": "alice", "repo": "demo", "number": "3", "name": "bug"}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/repos/alice/demo/labels", strings.NewReader(tc.body))
			req = withRouteParams(req, tc.params)
			rec := httptest.NewRecorder()

			tc.method(rec, req)

			require.Equal(t, http.StatusUnauthorized, rec.Code)
		})
	}

	t.Run("get repo label rejects invalid id", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/repos/alice/demo/labels/nope", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "nope"})
		rec := httptest.NewRecorder()

		handler.GetRepoLabel(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("get issue labels rejects invalid number", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/repos/alice/demo/issues/nope/labels", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "nope"})
		rec := httptest.NewRecorder()

		handler.GetIssueLabels(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete issue label rejects invalid number", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/repos/alice/demo/issues/nope/labels/bug", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "nope", "name": "bug"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		handler.DeleteIssueLabel(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

func TestLabels_Z_ListServiceErrors(t *testing.T) {
	handler := LabelHandler{Service: &mockLabelRouteService{
		listLabelsFn: func(context.Context, *db.User, string, string, int, int) ([]db.Label, int64, error) {
			return nil, 0, pkgerrors.Forbidden("blocked")
		},
		listIssueLabelsFn: func(context.Context, *db.User, string, string, int64, int, int) ([]db.Label, int64, error) {
			return nil, 0, pkgerrors.NotFound("issue not found")
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/repos/alice/demo/labels", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()
	handler.GetRepoLabels(rec, req)
	require.Equal(t, http.StatusForbidden, rec.Code)

	req = httptest.NewRequest(http.MethodGet, "/repos/alice/demo/issues/3/labels", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "3"})
	rec = httptest.NewRecorder()
	handler.GetIssueLabels(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
