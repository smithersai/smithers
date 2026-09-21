package routes

import (
	"context"
	"net/http"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// SystemHealthChecker can perform a basic DB connectivity check.
type SystemHealthChecker interface {
	// Ping verifies the database is reachable.
	Ping(ctx context.Context) error
}

// AdminSystemHealthHandler handles GET /api/admin/system/health.
type AdminSystemHealthHandler struct {
	DB SystemHealthChecker
}

type componentStatus struct {
	Status  string `json:"status"`
	Latency string `json:"latency,omitempty"`
	Error   string `json:"error,omitempty"`
}

type systemHealthResponse struct {
	Status   string                     `json:"status"`
	Database componentStatus            `json:"database"`
	Extra    map[string]componentStatus `json:"components,omitempty"`
}

// SystemHealth handles GET /api/admin/system/health.
// Returns 200 if all critical components are healthy, 503 if degraded.
func (h *AdminSystemHealthHandler) SystemHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	resp := systemHealthResponse{
		Status: "ok",
	}

	// Check database.
	start := time.Now()
	if err := h.DB.Ping(ctx); err != nil {
		resp.Status = "degraded"
		resp.Database = componentStatus{
			Status: "error",
			Error:  err.Error(),
		}
	} else {
		resp.Database = componentStatus{
			Status:  "ok",
			Latency: time.Since(start).String(),
		}
	}

	statusCode := http.StatusOK
	if resp.Status != "ok" {
		statusCode = http.StatusServiceUnavailable
	}

	pkgerrors.WriteJSON(w, statusCode, resp)
}
