package compose

import (
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

func TestServerRouter_RetiredMemoryRoutesAreNotMounted(t *testing.T) {
	t.Parallel()

	router, ok := defaultRouter(nil).(chi.Routes)
	require.True(t, ok)
	var retired []string
	err := chi.Walk(router, func(method, path string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if strings.Contains(path, "/memory/") {
			retired = append(retired, method+" "+path)
		}
		return nil
	})
	require.NoError(t, err)
	require.Empty(t, retired, "the retired Hindsight broker must not expose routes")
}
