package compose

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAppBootstrapReportsAssembledCapabilities(t *testing.T) {
	local := newAppBootstrap(bootstrapFeatures{role: RoleLocal, identity: true, workspaceRuntime: true})
	require.Equal(t, "local", local.Host)
	require.Equal(t, []string{"identity"}, local.Capabilities)
	require.Equal(t, "native-handoff", local.AuthFlow)
	require.Equal(t, "trusted-only", local.Sandbox.Mode)
	require.NotEmpty(t, local.Sandbox.Platform)

	hosted := newAppBootstrap(bootstrapFeatures{role: RoleHostedAPI, identity: true, redirectAuth: true,
		agent: true, billingCheckout: true, isolatedSandbox: true})
	require.Equal(t, "cloud", hosted.Host)
	require.Equal(t, []string{"identity", "agent", "billing.checkout"}, hosted.Capabilities)
	require.Equal(t, "redirect", hosted.AuthFlow)
	require.Equal(t, "enforced", hosted.Sandbox.Mode)

	unavailable := newAppBootstrap(bootstrapFeatures{})
	require.Nil(t, unavailable.Sandbox)
	require.Empty(t, unavailable.Capabilities)
	require.Equal(t, "none", unavailable.AuthFlow)
}

func TestAppBootstrapRoute(t *testing.T) {
	handler := withAppBootstrap(http.NotFoundHandler(), newAppBootstrap(bootstrapFeatures{identity: true}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil))
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	var body map[string]any
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Equal(t, float64(1), body["apiVersion"])
	require.Equal(t, "local", body["host"])
	require.NotEmpty(t, body["version"])
	require.NotEmpty(t, body["buildSha"])
	require.Equal(t, []any{"identity"}, body["capabilities"])

	for _, tc := range []struct {
		method string
		want   int
	}{
		{http.MethodHead, http.StatusOK},
		{http.MethodPost, http.StatusMethodNotAllowed},
	} {
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(tc.method, "/api/bootstrap", nil))
		require.Equal(t, tc.want, response.Code)
		if tc.method == http.MethodHead {
			require.Empty(t, response.Body.String())
		}
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/unknown", nil))
	require.Equal(t, http.StatusNotFound, response.Code)
}
