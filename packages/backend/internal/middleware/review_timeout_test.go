package middleware

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestReviewTimeoutPreservesFinalResponseAfterEarlyHints(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		handle http.HandlerFunc
	}{
		{"final", http.StatusCreated, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusEarlyHints)
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte("created"))
		}},
		{"timeout", http.StatusGatewayTimeout, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "timeout" {
				release := make(chan struct{})
				done := make(chan struct{})
				tc.handle = func(w http.ResponseWriter, _ *http.Request) {
					defer close(done)
					w.WriteHeader(http.StatusEarlyHints)
					<-release
				}
				t.Cleanup(func() { close(release); <-done })
			}
			server := httptest.NewServer(JSONTimeout(50 * time.Millisecond)(tc.handle))
			defer server.Close()
			response, err := server.Client().Get(server.URL + "/api/review")
			require.NoError(t, err)
			body, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			require.NoError(t, response.Body.Close())
			assert.Equal(t, tc.status, response.StatusCode)
			if tc.name == "final" {
				assert.Equal(t, "created", string(body))
			} else {
				assert.Contains(t, string(body), `"code":"gateway_timeout"`)
			}
		})
	}
}
