package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type UserDeviceRouteService interface {
	RegisterDevice(ctx context.Context, userID int64, req services.RegisterUserDeviceRequest) (services.UserDeviceResponse, error)
	DeleteDevice(ctx context.Context, userID int64, apnsToken string) error
}

type userDeviceRequest struct {
	APNSToken string `json:"apns_token"`
	Platform  string `json:"platform"`
}

func (h *UserHandler) PostUserDevice(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.DeviceService == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("device service unavailable"))
		return
	}

	var req userDeviceRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	device, svcErr := h.DeviceService.RegisterDevice(r.Context(), user.ID, services.RegisterUserDeviceRequest{
		APNSToken: req.APNSToken,
		Platform:  req.Platform,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusCreated, device)
}

func (h *UserHandler) DeleteUserDevice(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.DeviceService == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("device service unavailable"))
		return
	}

	var req userDeviceRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	if svcErr := h.DeviceService.DeleteDevice(r.Context(), user.ID, req.APNSToken); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
