package compose

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestServerRouter_RepoGatewayRelayPreflightIncludesCORSHeaders(t *testing.T) {
	request := httptest.NewRequest(http.MethodOptions, "/api/gateways/gateway-1/v1/rpc/launchRun", nil)
	request.Header.Set("Origin", "https://plue.test")
	request.Header.Set("Access-Control-Request-Method", http.MethodPost)
	request.Header.Set("Access-Control-Request-Headers", "Authorization, Content-Type")
	recorder := httptest.NewRecorder()

	longTimeoutJSONCSRFCoverageRouter().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("preflight status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "https://plue.test" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, "https://plue.test")
	}
	if got := recorder.Header().Get("Access-Control-Allow-Methods"); got != http.MethodPost {
		t.Fatalf("Access-Control-Allow-Methods = %q, want %q", got, http.MethodPost)
	}
}
