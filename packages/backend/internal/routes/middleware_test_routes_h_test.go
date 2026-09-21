package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMiddlewareTestRoutes_H_PanicAndIgnoreContext(t *testing.T) {
	t.Run("panic route panics", func(t *testing.T) {
		defer func() {
			got := recover()
			require.NotNil(t, got)
			assert.Equal(t, "middleware panic test route", got)
		}()

		MiddlewarePanic(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/panic", nil))
	})

	t.Run("ignore context uses configured sleep", func(t *testing.T) {
		oldSleep := middlewareTimeoutIgnoreContextSleep
		t.Cleanup(func() { middlewareTimeoutIgnoreContextSleep = oldSleep })
		var got time.Duration
		middlewareTimeoutIgnoreContextSleep = func(d time.Duration) { got = d }
		rec := httptest.NewRecorder()

		MiddlewareTimeoutIgnoreContext(rec, httptest.NewRequest(http.MethodGet, "/timeout-ignore", nil))

		assert.Equal(t, 5*time.Second, got)
	})
}
