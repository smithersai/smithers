package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// TestLFSHandler_PostBatch_SerializesUploadActionHeader locks in the wire
// format of the upload action's required headers: the git-lfs spec field is
// "header", and a spec-following client sends its entries verbatim on the PUT.
// Dropping them would let the storage layer accept unsigned (overwritable)
// uploads, so this shape is load-bearing for the create-only guarantee.
func TestLFSHandler_PostBatch_SerializesUploadActionHeader(t *testing.T) {
	h := LFSHandler{Service: &mockLFSRouteService{batchFn: func(ctx context.Context, actor *db.User, owner, repo string, input services.LFSBatchInput) (services.LFSBatchResponse, error) {
		return services.LFSBatchResponse{
			Transfer: "basic",
			Objects: []services.LFSBatchObjectResponse{{
				Oid:  "a",
				Size: 1,
				Actions: map[string]services.LFSBatchActionLink{"upload": {
					Href:   "https://storage.example/upload",
					Header: map[string]string{"x-goog-if-generation-match": "0"},
				}},
			}},
		}, nil
	}}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/batch", strings.NewReader(`{"operation":"upload","objects":[{"oid":"a","size":1}]}`))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.PostBatch(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var raw struct {
		Objects []struct {
			Actions map[string]struct {
				Href   string            `json:"href"`
				Header map[string]string `json:"header"`
			} `json:"actions"`
		} `json:"objects"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &raw))
	require.Len(t, raw.Objects, 1)
	upload, ok := raw.Objects[0].Actions["upload"]
	require.True(t, ok)
	assert.Equal(t, "https://storage.example/upload", upload.Href)
	assert.Equal(t, map[string]string{"x-goog-if-generation-match": "0"}, upload.Header)
}
