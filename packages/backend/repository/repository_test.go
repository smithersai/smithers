package repository

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSmartHTTPHandlerMapsGitProtocolWithoutCrossingRepositories(t *testing.T) {
	var path string
	handler := SmartHTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	}))
	for _, tc := range []struct {
		method, path, want string
	}{
		{"GET", "/git/alice/demo.git/info/refs", "/repos/alice/demo/git/info-refs"},
		{"POST", "/git/alice/demo.git/git-upload-pack", "/repos/alice/demo/git/upload-pack"},
		{"POST", "/git/alice/demo.git/git-receive-pack", "/repos/alice/demo/git/receive-pack"},
	} {
		path = ""
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(tc.method, tc.path, nil))
		if response.Code != http.StatusNoContent || path != tc.want {
			t.Fatalf("%s %s: status %d, path %q", tc.method, tc.path, response.Code, path)
		}
	}
	for _, invalid := range []string{
		"/git/alice/other.git/../../demo.git/info/refs",
		"/git/alice/demo.git/git-receive-pack/extra",
		"/git/alice/demo.git/git-upload-pack",
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", invalid, nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s: status %d", invalid, response.Code)
		}
	}
}
