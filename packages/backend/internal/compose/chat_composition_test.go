package compose

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
)

type unusedChatHost struct{}

func (unusedChatHost) RunChatTurn(context.Context, ports.ChatTurnGrant) error { return nil }

func TestChatCompositionRequiresPrivateCallbackBoundary(t *testing.T) {
	_, err := newChatComposition(runOptions{Options: Options{ChatProducerBaseURL: "http://127.0.0.1:1000"}}, nil)
	require.ErrorContains(t, err, "requires a chat host")
	worker, err := newChatComposition(runOptions{Options: Options{
		Role: RoleHostedWorker, ChatHost: unusedChatHost{}, ChatProducerBaseURL: "https://api.example.test",
	}}, &pgxpool.Pool{})
	require.NoError(t, err)
	require.Nil(t, worker.listener)

	publicListener, err := net.Listen("tcp", "0.0.0.0:0")
	require.NoError(t, err)
	_, err = newChatComposition(runOptions{Options: Options{
		Role: RoleLocal, ChatHost: unusedChatHost{}, ChatCallbackListener: publicListener,
	}}, nil)
	require.ErrorContains(t, err, "must bind loopback")
}

func TestHostedAPICallbackUsesSharedListenerWhenPrivateListenerIsAbsent(t *testing.T) {
	runtime, err := newChatComposition(runOptions{Options: Options{
		Role: RoleHostedAPI, ChatHost: unusedChatHost{}, ChatProducerBaseURL: "https://api.example.test",
	}}, &pgxpool.Pool{})
	require.NoError(t, err)
	require.NotNil(t, runtime)
	require.Nil(t, runtime.listener)
	router := chi.NewRouter()
	mountChatProducerOnSharedListener(router, runtime)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, chat.CommitPath, strings.NewReader(`{}`)))
	require.Equal(t, http.StatusUnauthorized, response.Code)
}

func TestChatStreamingRoutesRequireAuthentication(t *testing.T) {
	router := chi.NewRouter()
	// The product's ordinary /api subtree is registered first. The chat route
	// must still win and must not inherit that subtree's JSON request timeout.
	router.Route("/api", func(api chi.Router) {
		api.Post("/agent/turn", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusTeapot)
		})
	})
	mountChatPublic(router, &chat.Runtime{Handler: &chat.Handler{}}, nil, &config.Config{})
	for _, path := range []string{chat.TurnPath, chat.CancelPath, chat.ReplayPath, chat.RetirePath} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, nil))
		require.Equal(t, http.StatusUnauthorized, response.Code, path)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, chat.CommitPath, nil))
	require.Equal(t, http.StatusNotFound, response.Code)
}

func TestChatErasureRouteSurvivesSignoutAndRejectsForeignOrigin(t *testing.T) {
	router := chi.NewRouter()
	mountChatPublic(router, &chat.Runtime{Handler: &chat.Handler{}}, nil, &config.Config{})
	// No AuthLoader identity or CSRF cookie is available after sign-out. A 503
	// from the handler proves the proof-only request passed the route stack.
	request := httptest.NewRequest(http.MethodPost, chat.ErasePath, strings.NewReader(`{"runId":"run","legId":"leg","retirementProof":"`+strings.Repeat("a", 64)+`"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	require.Equal(t, http.StatusServiceUnavailable, response.Code)
	foreign := request.Clone(request.Context())
	foreign.Header.Set("Origin", "https://foreign.invalid")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, foreign)
	require.Equal(t, http.StatusForbidden, response.Code)
}
