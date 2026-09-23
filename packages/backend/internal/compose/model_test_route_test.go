package compose

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/stretchr/testify/require"
)

func TestComposedModelTestRouteRequiresAuthentication(t *testing.T) {
	router := chi.NewRouter()
	mountModelPublic(router, modelhost.OwnerModels{}, nil, &config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/model/test", strings.NewReader(`{"model":{}}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	require.Equal(t, http.StatusUnauthorized, response.Code)
	wrongMethod := httptest.NewRecorder()
	router.ServeHTTP(wrongMethod, httptest.NewRequest(http.MethodGet, "/api/model/test", nil))
	require.Equal(t, http.StatusMethodNotAllowed, wrongMethod.Code)
}
