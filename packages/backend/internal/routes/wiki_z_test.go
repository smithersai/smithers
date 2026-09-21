package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWiki_Z_MissingRepoBranches(t *testing.T) {
	handler := WikiHandler{Service: &mockWikiRouteService{}}

	for _, tc := range []struct {
		name   string
		method func(http.ResponseWriter, *http.Request)
		body   string
		auth   bool
	}{
		{"list", handler.ListWikiPages, "", false},
		{"get", handler.GetWikiPage, "", false},
		{"create", handler.CreateWikiPage, `{"title":"Home","body":"x"}`, true},
		{"patch", handler.PatchWikiPage, `{"title":"Home"}`, true},
		{"delete", handler.DeleteWikiPage, "", true},
		{"search", handler.SearchWikiPages, "", false},
		{"revisions", handler.ListWikiRevisions, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/repos//demo/wiki", strings.NewReader(tc.body))
			if tc.auth {
				req = withAuth(req, 1, "alice")
			}
			rec := httptest.NewRecorder()

			tc.method(rec, req)

			require.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}
}

func TestWiki_Z_AuthSlugAndPaginationBranches(t *testing.T) {
	handler := WikiHandler{Service: &mockWikiRouteService{}}

	req := httptest.NewRequest(http.MethodPatch, "/repos/alice/demo/wiki/home", strings.NewReader(`{"title":"Home"}`))
	req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "slug": "home"})
	rec := httptest.NewRecorder()
	handler.PatchWikiPage(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)

	req = httptest.NewRequest(http.MethodDelete, "/repos/alice/demo/wiki/", nil)
	req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 1, "alice")
	rec = httptest.NewRecorder()
	handler.DeleteWikiPage(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)

	req = httptest.NewRequest(http.MethodGet, "/repos/alice/demo/wiki/search?q=guide&page=0", nil)
	req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec = httptest.NewRecorder()
	handler.SearchWikiPages(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)

	req = httptest.NewRequest(http.MethodGet, "/repos/alice/demo/wiki//revisions", nil)
	req = withWikiRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec = httptest.NewRecorder()
	handler.ListWikiRevisions(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}
