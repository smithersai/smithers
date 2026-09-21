package routes

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// adminCanaryQueryTimeout bounds the canary listing query.
const adminCanaryQueryTimeout = 5 * time.Second

// AdminCanaryLister lists the latest persisted result for every canary. The
// canary_results table holds one row per (suite, test_name), so the listing is
// already a latest-state snapshot.
type AdminCanaryLister interface {
	ListCanaryResults(ctx context.Context) ([]db.CanaryResult, error)
}

// AdminSystemCanariesHandler handles GET /api/admin/system/canaries.
type AdminSystemCanariesHandler struct {
	Store AdminCanaryLister
	// Clock supplies the current time for staleness checks. Nil means time.Now.
	Clock func() time.Time
}

type adminSystemCanary struct {
	Name      string   `json:"name"`
	Status    string   `json:"status"`
	LastRunAt string   `json:"last_run_at"`
	LatencyMS *float64 `json:"latency_ms"`
	Detail    string   `json:"detail,omitempty"`
	Stale     bool     `json:"stale"`
}

type adminSystemCanariesResponse struct {
	Canaries []adminSystemCanary `json:"canaries"`
}

func (h *AdminSystemCanariesHandler) now() time.Time {
	if h != nil && h.Clock != nil {
		return h.Clock().UTC()
	}
	return time.Now().UTC()
}

// SystemCanaries handles GET /api/admin/system/canaries. It returns every
// tracked canary sorted by name, with a staleness flag derived from the last
// reported time.
func (h *AdminSystemCanariesHandler) SystemCanaries(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Store == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("canary store unavailable"))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), adminCanaryQueryTimeout)
	defer cancel()

	rows, err := h.Store.ListCanaryResults(ctx)
	if err != nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("failed to list canary results"))
		return
	}

	now := h.now()
	canaries := make([]adminSystemCanary, 0, len(rows))
	for _, row := range rows {
		canaries = append(canaries, adminCanaryFromResult(row, now))
	}
	sort.Slice(canaries, func(i, j int) bool {
		return canaries[i].Name < canaries[j].Name
	})

	pkgerrors.WriteJSON(w, http.StatusOK, adminSystemCanariesResponse{Canaries: canaries})
}

// adminCanaryFromResult maps one persisted canary row onto the admin API shape.
func adminCanaryFromResult(row db.CanaryResult, now time.Time) adminSystemCanary {
	lastRunAt := row.ReportedAt.UTC()

	canary := adminSystemCanary{
		Name:      adminCanaryName(row),
		Status:    services.ClassifyCanaryStatus(row.Status),
		LastRunAt: lastRunAt.Format(time.RFC3339),
		Detail:    strings.TrimSpace(row.ErrorMessage),
		Stale:     services.CanaryIsStale(lastRunAt, now, services.CanaryFreshnessWindow(row.Suite, row.TestName)),
	}

	// duration_seconds defaults to 0 for canaries that report no timing, which
	// the contract represents as a null latency rather than a real 0ms run.
	if row.DurationSeconds > 0 {
		latencyMS := row.DurationSeconds * 1000
		canary.LatencyMS = &latencyMS
	}

	return canary
}

// adminCanaryName qualifies the test name with its suite so names stay unique
// across suites, matching the (suite, test_name) key of the underlying table.
func adminCanaryName(row db.CanaryResult) string {
	suite := strings.TrimSpace(row.Suite)
	testName := strings.TrimSpace(row.TestName)
	if suite == "" {
		return testName
	}
	return suite + "/" + testName
}
