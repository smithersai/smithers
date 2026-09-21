package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLFS_Z_GetObjectsRequiresRepoParams(t *testing.T) {
	t.Parallel()

	h := LFSHandler{Service: &mockLFSRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice//lfs/objects", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice"})
	rec := httptest.NewRecorder()

	h.GetObjects(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}
