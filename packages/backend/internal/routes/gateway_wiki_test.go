package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type gatewayWikiPublishFunc func(context.Context, string, string, services.GatewayWikiPublishInput) (services.GatewayWikiPublishResult, error)

func (f gatewayWikiPublishFunc) Publish(ctx context.Context, id, token string, input services.GatewayWikiPublishInput) (services.GatewayWikiPublishResult, error) {
	return f(ctx, id, token, input)
}

func TestGatewayWikiHandler_PassesGatewayAuthorityAndRejectsTrailingObjects(t *testing.T) {
	calls := 0
	handler := &RepoGatewayHandler{WikiPublisher: gatewayWikiPublishFunc(func(_ context.Context, id, token string, input services.GatewayWikiPublishInput) (services.GatewayWikiPublishResult, error) {
		calls++
		require.Equal(t, "gateway", id)
		require.Equal(t, "operator", token)
		require.Equal(t, "alice/demo", input.Repo)
		require.Equal(t, "root.md", input.Pages[0].Path)
		return services.GatewayWikiPublishResult{Pages: []services.GatewayWikiPublishedPage{{ID: "root", Slug: "source-commit-root"}}}, nil
	})}
	router := chi.NewRouter()
	router.Post("/api/gateways/{gatewayID}/wiki-pages", handler.PublishWiki)
	valid := `{"repo":"alice/demo","sourceHead":"commit","pages":[{"id":"root","path":"root.md","title":"Root","body":"text","sources":[]}]}`
	for _, trailing := range []string{"", " {}"} {
		req := httptest.NewRequest(http.MethodPost, "/api/gateways/gateway/wiki-pages", strings.NewReader(valid+trailing))
		req.Header.Set("Authorization", "Bearer operator")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, req)
		if trailing == "" {
			require.Equal(t, http.StatusOK, recorder.Code)
			require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
			require.Contains(t, recorder.Body.String(), "source-commit-root")
		} else {
			require.Equal(t, http.StatusBadRequest, recorder.Code)
		}
	}
	require.Equal(t, 1, calls)
}
