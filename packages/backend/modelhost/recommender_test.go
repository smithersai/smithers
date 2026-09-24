package modelhost

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/ports"
)

func TestJevRecommender_UsesGatewayDecisionAndFiltersAtRouteBoundary(t *testing.T) {
	var gotHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeader = r.Header.Get("ai-model-id")
		var body map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		require.NotNil(t, body["questions"])
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"answers":{"command1":{"type":"choice","choice":"review","probabilities":{"review":0.9,"help":0.1}}}}`))
	}))
	defer server.Close()
	recommender, err := NewJevRecommender("gateway-key", server.URL, server.Client())
	require.NoError(t, err)
	result, err := recommender.Recommend(context.Background(), ports.RecommendationRequest{
		Commands: []ports.RecommendationCommand{{Name: "review", Summary: "Review"}, {Name: "help", Summary: "Help"}},
	})
	require.NoError(t, err)
	require.Equal(t, JevDefaultModel, gotHeader)
	require.Equal(t, []string{"review", "help"}, result.Commands)
}
