package routes

import (
	"context"
	"net/http"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// adminSystemStatusTimeout bounds the whole status read.
const adminSystemStatusTimeout = 5 * time.Second

// AdminSystemStatusReader builds the control-plane status snapshot. Source
// failures are reported inside the snapshot, never as an error.
type AdminSystemStatusReader interface {
	SystemStatus(ctx context.Context) services.AdminSystemStatus
}

// AdminSystemStatusHandler handles GET /api/admin/system/status.
type AdminSystemStatusHandler struct {
	Service AdminSystemStatusReader
}

// SystemStatus always responds 200 once the handler runs; the "status" field
// carries the ok/degraded verdict so a degraded control plane still returns a
// readable snapshot.
func (h *AdminSystemStatusHandler) SystemStatus(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("system status service unavailable"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), adminSystemStatusTimeout)
	defer cancel()
	pkgerrors.WriteJSON(w, http.StatusOK, h.Service.SystemStatus(ctx))
}
