package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestJJVCS_Z_MissingRepoBranches(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("repohost should not be called")
	}))
	t.Cleanup(server.Close)

	handler := newJJVCSHandler(server)

	for _, tc := range []struct {
		name   string
		method func(http.ResponseWriter, *http.Request)
		body   string
		auth   bool
	}{
		{"create bookmark", handler.CreateBookmark, `{"name":"main","target_change_id":"chg"}`, true},
		{"delete bookmark", handler.DeleteBookmark, "", true},
		{"get change", handler.GetChange, "", false},
		{"get change diff", handler.GetChangeDiff, "", false},
		{"get change files", handler.GetChangeFiles, "", false},
		{"get change conflicts", handler.GetChangeConflicts, "", false},
		{"get file at change", handler.GetFileAtChange, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/repos//demo", strings.NewReader(tc.body))
			if tc.auth {
				req = withRepoAuth(req, 1, "alice")
			}
			rec := httptest.NewRecorder()

			tc.method(rec, req)

			require.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}
}
