package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNotificationTestRoutes_H_AuthAndDecodeBranches(t *testing.T) {
	t.Run("requires auth", func(t *testing.T) {
		rec := httptest.NewRecorder()

		CreateTestNotification(&notificationTestRoutesCovService{})(rec, httptest.NewRequest(http.MethodPost, "/test/notifications", strings.NewReader(`{}`)))

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("invalid json", func(t *testing.T) {
		req := withAuth(httptest.NewRequest(http.MethodPost, "/test/notifications", strings.NewReader(`{`)), 7, "alice")
		rec := httptest.NewRecorder()

		CreateTestNotification(&notificationTestRoutesCovService{})(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
