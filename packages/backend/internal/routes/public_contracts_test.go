package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPublicRepositoryCatalog_IsAClientContract(t *testing.T) {
	rec := httptest.NewRecorder()
	PublicRepositoryCatalog(rec, httptest.NewRequest(http.MethodGet, "/api/public/repos", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"name":"smithersai/smithers"`)
}

func TestRecommendContracts_AreMountedWithoutAProvider(t *testing.T) {
	rec := httptest.NewRecorder()
	Recommend(rec, httptest.NewRequest(http.MethodPost, "/api/recommend", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"commands":[]`)

	rec = httptest.NewRecorder()
	RecommendOutcome(rec, httptest.NewRequest(http.MethodPost, "/api/recommend/outcome", nil))
	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestModelStream_ReturnsAValidEmptySummary(t *testing.T) {
	rec := httptest.NewRecorder()
	ModelStream(rec, httptest.NewRequest(http.MethodPost, "/api/model/stream", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"type":"done"`)
}
