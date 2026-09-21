package routes

import (
	"github.com/smithersai/smithers/packages/backend/internal/clusterservices"
	"context"
	"net/http"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// adminSystemStatusTimeout bounds the whole status aggregation.
const adminSystemStatusTimeout = 5 * time.Second

// AdminSystemStatusAggregator is the service interface required by
// AdminSystemStatusHandler. The aggregate never returns an error: component
// failures are reported inside the snapshot.
type AdminSystemStatusAggregator interface {
	SystemStatus(ctx context.Context) clusterservices.AdminSystemStatus
}

// AdminSystemStatusHandler handles GET /api/admin/system/status.
type AdminSystemStatusHandler struct {
	Service AdminSystemStatusAggregator
}

// SystemStatus handles GET /api/admin/system/status. It always responds 200
// once the handler runs; the "status" field carries the ok/degraded verdict so
// a degraded control plane still returns a readable snapshot.
func (h *AdminSystemStatusHandler) SystemStatus(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("system status service unavailable"))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), adminSystemStatusTimeout)
	defer cancel()

	pkgerrors.WriteJSON(w, http.StatusOK, h.Service.SystemStatus(ctx))
}
