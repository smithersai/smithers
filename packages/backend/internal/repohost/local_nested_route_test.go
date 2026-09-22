package repohost

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestLocalClientRoutesStagedProvisionFromAPIRequest(t *testing.T) {
	repository := chi.NewRouter()
	repository.Post("/repos/provision-stages", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"token":"stage-token","phase":"ready"}`))
	})
	client := NewLocalClient(repository, "test-repo-token")
	api := chi.NewRouter()
	api.Route("/api", func(r chi.Router) {
		r.Route("/user", func(r chi.Router) {
			r.Post("/repos", func(w http.ResponseWriter, r *http.Request) {
				err := client.ExecuteStagedProvision(r.Context(), StagedProvision{
					StorageSetID: "local", Token: "stage-token", Owner: "alice", Repo: "demo",
					OperationType: "init",
				})
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				w.WriteHeader(http.StatusNoContent)
			})
		})
	})
	response := httptest.NewRecorder()
	api.ServeHTTP(response, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/user/repos", nil))
	if response.Code != http.StatusNoContent {
		t.Fatalf("staged provision through API route: status %d, body %s", response.Code, response.Body.String())
	}
}
