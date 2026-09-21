package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestUserDevices_H_AuthServiceAndDecodeBranches(t *testing.T) {
	t.Run("post requires auth", func(t *testing.T) {
		rec := httptest.NewRecorder()

		(&UserHandler{DeviceService: &userDevicesCovService{}}).PostUserDevice(rec, httptest.NewRequest(http.MethodPost, "/api/user/devices", strings.NewReader(`{}`)))

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("post invalid json", func(t *testing.T) {
		req := withAuth(httptest.NewRequest(http.MethodPost, "/api/user/devices", strings.NewReader(`{`)), 7, "alice")
		rec := httptest.NewRecorder()

		(&UserHandler{DeviceService: &userDevicesCovService{}}).PostUserDevice(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("delete requires auth", func(t *testing.T) {
		rec := httptest.NewRecorder()

		(&UserHandler{DeviceService: &userDevicesCovService{}}).DeleteUserDevice(rec, httptest.NewRequest(http.MethodDelete, "/api/user/devices", strings.NewReader(`{}`)))

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("delete requires configured service", func(t *testing.T) {
		req := withAuth(httptest.NewRequest(http.MethodDelete, "/api/user/devices", strings.NewReader(`{}`)), 7, "alice")
		rec := httptest.NewRecorder()

		(&UserHandler{}).DeleteUserDevice(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("delete invalid json", func(t *testing.T) {
		req := withAuth(httptest.NewRequest(http.MethodDelete, "/api/user/devices", strings.NewReader(`{`)), 7, "alice")
		rec := httptest.NewRecorder()

		(&UserHandler{DeviceService: &userDevicesCovService{}}).DeleteUserDevice(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
