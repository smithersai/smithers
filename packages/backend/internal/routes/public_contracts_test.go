package routes

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
)

type catalogSource struct{ rows []db.PublicRepository }

func (s catalogSource) ListPublicRepositoryCatalog(context.Context) ([]db.PublicRepository, error) {
	return s.rows, nil
}

type recommendationFake struct{ got ports.RecommendationRequest }

func (f *recommendationFake) Recommend(_ context.Context, request ports.RecommendationRequest) (ports.RecommendationResult, error) {
	f.got = request
	return ports.RecommendationResult{Commands: []string{"review", "fabricated"}, Model: "fixture-jev"}, nil
}

type recommendationLogFake struct {
	id      string
	outcome string
}

func (f *recommendationLogFake) AppendRecommendation(_ context.Context, _ ports.RecommendationRequest, _ ports.RecommendationResult, digest string) (string, error) {
	f.id = "recommendation-1:" + digest
	return f.id, nil
}
func (f *recommendationLogFake) RecordRecommendationOutcome(_ context.Context, id, command string, _ time.Time) (int, error) {
	if id != f.id {
		return http.StatusNotFound, nil
	}
	f.outcome = command
	return http.StatusNoContent, nil
}

type modelStreamFake struct{ body []byte }

func (f modelStreamFake) RunModelStream(context.Context, ports.ModelStreamGrant) (io.ReadCloser, error) {
	return io.NopCloser(bytes.NewReader(f.body)), nil
}

type missingModelStream struct{}

func (missingModelStream) RunModelStream(context.Context, ports.ModelStreamGrant) (io.ReadCloser, error) {
	return nil, ports.ErrModelCredentialMissing
}

func TestPublicRepositoryCatalog_ReadsTheProductSource(t *testing.T) {
	handler := NewPublicRepositoryCatalog(catalogSource{rows: []db.PublicRepository{{Name: "owner/created", Title: "created", URL: "/owner/created", Summary: "from db"}}})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/public/repos", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"name":"owner/created"`)
	require.NotContains(t, rec.Body.String(), "smithersai/smithers")
}

func TestRecommendationHandler_CallsProviderAndPersistsReceipt(t *testing.T) {
	provider := &recommendationFake{}
	log := &recommendationLogFake{}
	handler := NewRecommendationHandler(provider, log)
	rec := httptest.NewRecorder()
	body := `{"repo":"owner/created","tail":[{"role":"user","text":"review this"}],"commands":[{"name":"review","summary":"Review"}]}`
	handler.Recommend(rec, httptest.NewRequest(http.MethodPost, "/api/recommend", bytes.NewBufferString(body)))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"commands":["review"]`)
	require.NotContains(t, rec.Body.String(), "fabricated")
	require.Equal(t, "owner/created", *provider.got.Repo)

	rec = httptest.NewRecorder()
	handler.Outcome(rec, httptest.NewRequest(http.MethodPost, "/api/recommend/outcome", bytes.NewBufferString(`{"id":"`+log.id+`","command":"review"}`)))
	require.Equal(t, http.StatusNoContent, rec.Code)
	require.Equal(t, "review", log.outcome)
}

func TestRecommendationHandler_RejectsUnknownModelBinding(t *testing.T) {
	provider := &recommendationFake{}
	handler := NewRecommendationHandler(provider, &recommendationLogFake{})
	rec := httptest.NewRecorder()
	handler.Recommend(rec, httptest.NewRequest(http.MethodPost, "/api/recommend", bytes.NewBufferString(`{"model":{"modelId":"other"},"tail":[],"commands":[]}`)))
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), `"code":"request_invalid"`)
}

func TestModelStreamHandler_ForwardsProviderFrames(t *testing.T) {
	user := &db.User{ID: 42}
	request := httptest.NewRequest(http.MethodPost, "/api/model/stream", bytes.NewBufferString(`{"messages":[{"role":"user","content":"hi"}]}`))
	request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, user))
	rec := httptest.NewRecorder()
	NewModelStreamHandler(modelStreamFake{body: []byte(`{"type":"delta","text":"ok"}`)}).ServeHTTP(rec, request)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"text":"ok"`)
}

func TestModelStreamHandler_ReportsMissingCredential(t *testing.T) {
	user := &db.User{ID: 42}
	request := httptest.NewRequest(http.MethodPost, "/api/model/stream", bytes.NewBufferString(`{"messages":[]}`))
	request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, user))
	rec := httptest.NewRecorder()
	NewModelStreamHandler(missingModelStream{}).ServeHTTP(rec, request)
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	require.Contains(t, rec.Body.String(), `"code":"credential_missing"`)
}
