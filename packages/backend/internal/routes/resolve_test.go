package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestResolveHandler_EmptyName_ReturnsBadRequest(t *testing.T) {
	t.Parallel()

	h := &ResolveHandler{}
	req := httptest.NewRequest(http.MethodGet, "/api/resolve/", nil)
	req = withRouteParams(req, map[string]string{"name": ""})
	rec := httptest.NewRecorder()
	h.GetResolve(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestResolveHandler_WhitespaceOnlyName_ReturnsBadRequest(t *testing.T) {
	t.Parallel()

	h := &ResolveHandler{}
	req := httptest.NewRequest(http.MethodGet, "/api/resolve/%20%20", nil)
	req = withRouteParams(req, map[string]string{"name": "   "})
	rec := httptest.NewRecorder()
	h.GetResolve(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestResolveResponse_JSONMarshal(t *testing.T) {
	t.Parallel()

	resp := ResolveResponse{
		Type: "user",
		ID:   42,
		Name: "alice",
	}
	data, err := json.Marshal(resp)
	require.NoError(t, err)

	var unmarshaled ResolveResponse
	require.NoError(t, json.Unmarshal(data, &unmarshaled))
	assert.Equal(t, "user", unmarshaled.Type)
	assert.Equal(t, int64(42), unmarshaled.ID)
	assert.Equal(t, "alice", unmarshaled.Name)
}

func TestResolveResponse_OrgType_JSONMarshal(t *testing.T) {
	t.Parallel()

	resp := ResolveResponse{
		Type: "org",
		ID:   5,
		Name: "MyOrg",
	}
	data, err := json.Marshal(resp)
	require.NoError(t, err)

	var m map[string]any
	require.NoError(t, json.Unmarshal(data, &m))
	assert.Equal(t, "org", m["type"])
	assert.Equal(t, float64(5), m["id"])
	assert.Equal(t, "MyOrg", m["name"])
}
