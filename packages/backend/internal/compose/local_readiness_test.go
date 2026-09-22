package compose

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type localReadinessDB struct{ err error }

func (db localReadinessDB) Ping(context.Context) error { return db.err }

func TestLocalReadinessChecksInProcessRepository(t *testing.T) {
	var status atomic.Int32
	status.Store(http.StatusOK)
	repository := repohost.NewLocalClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/health", r.URL.Path)
		w.WriteHeader(int(status.Load()))
	}), "secret")
	backend := withLocalReadiness(http.NotFoundHandler(), localReadinessDB{}, repository)
	check := func(path string, want int) {
		t.Helper()
		response := httptest.NewRecorder()
		backend.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, want, response.Code)
	}
	check("/readyz", http.StatusOK)
	check("/healthz", http.StatusOK)
	status.Store(http.StatusServiceUnavailable)
	check("/readyz", http.StatusServiceUnavailable)
	check("/healthz", http.StatusServiceUnavailable)
	check("/api/unknown", http.StatusNotFound)

	backend = withLocalReadiness(http.NotFoundHandler(), localReadinessDB{err: errors.New("offline")}, repository)
	check = func(path string, want int) {
		t.Helper()
		response := httptest.NewRecorder()
		backend.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, want, response.Code)
	}
	check("/readyz", http.StatusServiceUnavailable)
}
