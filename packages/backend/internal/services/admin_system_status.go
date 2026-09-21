package services

import (
	"context"
	"fmt"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// AdminSystemStatusPinger verifies database reachability.
//
// *pgxpool.Pool satisfies it directly.
type AdminSystemStatusPinger interface {
	Ping(ctx context.Context) error
}

// AdminSystemStatusCanaryLister lists the latest persisted result for every
// canary. canary_results holds one row per (suite, test_name), so the listing
// is already a latest-state snapshot.
//
// *db.Queries satisfies it directly.
type AdminSystemStatusCanaryLister interface {
	ListCanaryResults(ctx context.Context) ([]db.CanaryResult, error)
}

// AdminSystemStatusSandboxCounter counts live sandbox micro-VMs fleet-wide.
//
// *db.Queries satisfies it directly. CountActiveSandboxVMs counts every
// sandbox_instances row that still holds a compute reservation, so the total
// covers all six resource kinds sandboxProvisionContext attributes (workspace,
// repo_gateway, workflow_run, agent_session, anon-sandbox and
// golden_snapshot_bake) rather than one or two of them. Suspended and stopped
// guests have handed their compute back and are excluded.
type AdminSystemStatusSandboxCounter interface {
	CountActiveSandboxVMs(ctx context.Context) (int64, error)
}

// AdminSystemStatusLandingQueueCounter counts landing tasks waiting for a
// worker (pending or append_pending), including retries in backoff.
type AdminSystemStatusLandingQueueCounter interface {
	CountQueuedLandingTasks(ctx context.Context) (int64, error)
}

// AdminSystemStatusIncidentCounter tallies unresolved alert incidents by
// state in one uncapped server-side count, so an alert storm can never
// overflow a listing page and under-report the backlog.
//
// *db.Queries satisfies it directly.
type AdminSystemStatusIncidentCounter interface {
	GetAlertIncidentStateCounts(ctx context.Context) (db.GetAlertIncidentStateCountsRow, error)
}

// AdminSystemStatusSSECounter reports live server-sent-event connections.
//
// *sse.Broker satisfies it directly via its ActiveConnections accessor.
type AdminSystemStatusSSECounter interface {
	ActiveConnections() int
}

// AdminSystemStatusDatabase reports database reachability and probe latency.
type AdminSystemStatusDatabase struct {
	Status    string  `json:"status"`
	LatencyMS float64 `json:"latency_ms"`
	Error     string  `json:"error,omitempty"`
}

// AdminSystemStatusRunnerPool reports runner-pool occupancy.
type AdminSystemStatusRunnerPool struct {
	Available int `json:"available"`
	Claimed   int `json:"claimed"`
}

// AdminSystemStatusWorkflowTaskQueue reports the claimable workflow-task
// backlog.
type AdminSystemStatusWorkflowTaskQueue struct {
	Depth            int     `json:"depth"`
	OldestAgeSeconds float64 `json:"oldest_age_seconds"`
}

// AdminSystemStatusLandingQueue reports the landing queue backlog.
type AdminSystemStatusLandingQueue struct {
	Depth int `json:"depth"`
}

// AdminSystemStatusQueues groups every queue depth.
type AdminSystemStatusQueues struct {
	WorkflowTasks AdminSystemStatusWorkflowTaskQueue `json:"workflow_tasks"`
	Landing       AdminSystemStatusLandingQueue      `json:"landing"`
}

// AdminSystemStatusConnections reports live client connections.
type AdminSystemStatusConnections struct {
	SSE int `json:"sse"`
}

// AdminSystemStatusAgentSessions reports live agent sessions.
type AdminSystemStatusAgentSessions struct {
	Active           int     `json:"active"`
	OldestAgeSeconds float64 `json:"oldest_age_seconds"`
}

// AdminSystemStatusSandboxes reports live sandbox micro-VMs.
type AdminSystemStatusSandboxes struct {
	ActiveVMs int `json:"active_vms"`
}

// AdminSystemStatusCanaries reports canary result tallies.
type AdminSystemStatusCanaries struct {
	Passing int `json:"passing"`
	Failing int `json:"failing"`
	Stale   int `json:"stale"`
}

// AdminSystemStatusIncidents reports unresolved alert incidents.
type AdminSystemStatusIncidents struct {
	Acknowledged int `json:"acknowledged"`
	Snoozed      int `json:"snoozed"`
	Open         int `json:"open"`
	Remediating  int `json:"remediating"`
}

// AdminSystemStatus is the aggregated control-plane status snapshot returned by
// GET /api/admin/system/status.
type AdminSystemStatus struct {
	Status        string                         `json:"status"`
	GeneratedAt   time.Time                      `json:"generated_at"`
	Database      AdminSystemStatusDatabase      `json:"database"`
	RunnerPool    AdminSystemStatusRunnerPool    `json:"runner_pool"`
	Queues        AdminSystemStatusQueues        `json:"queues"`
	Connections   AdminSystemStatusConnections   `json:"connections"`
	AgentSessions AdminSystemStatusAgentSessions `json:"agent_sessions"`
	Sandboxes     AdminSystemStatusSandboxes     `json:"sandboxes"`
	Canaries      AdminSystemStatusCanaries      `json:"canaries"`
	Incidents     AdminSystemStatusIncidents     `json:"incidents"`
	// Errors names each sub-aggregate that could not be read, as
	// "<component>: <message>". A failed sub-aggregate reports zero values and
	// keeps the request available while degrading the overall status.
	Errors []string `json:"errors,omitempty"`
}

// AdminSystemStatusServiceConfig wires the aggregate's dependencies. Every
// dependency except DB is optional: a nil dependency reports zero values
// without recording an error, so the endpoint keeps working while a source is
// still being wired up.
type AdminSystemStatusServiceConfig struct {
	DB           AdminSystemStatusPinger
	Runtime      RuntimeMetricsStore
	Canaries     AdminSystemStatusCanaryLister
	Sandboxes    AdminSystemStatusSandboxCounter
	LandingQueue AdminSystemStatusLandingQueueCounter
	Incidents    AdminSystemStatusIncidentCounter
	SSE          AdminSystemStatusSSECounter

	// Clock supplies the current time. Nil means time.Now.
	Clock func() time.Time
	// CanaryStaleAfter overrides cadence-specific windows when positive.
	CanaryStaleAfter time.Duration
}

// AdminSystemStatusService aggregates control-plane status from the same
// sources that back the Prometheus runtime gauges.
type AdminSystemStatusService struct {
	cfg AdminSystemStatusServiceConfig
}

// NewAdminSystemStatusService creates the status aggregation service.
func NewAdminSystemStatusService(cfg AdminSystemStatusServiceConfig) *AdminSystemStatusService {
	return &AdminSystemStatusService{cfg: cfg}
}

func (s *AdminSystemStatusService) now() time.Time {
	if s != nil && s.cfg.Clock != nil {
		return s.cfg.Clock().UTC()
	}
	return time.Now().UTC()
}

// SystemStatus reads every status source and returns a snapshot. It never
// returns an error: a source that fails contributes zero values plus an entry
// in Errors, so a single broken aggregate cannot take the endpoint down.
func (s *AdminSystemStatusService) SystemStatus(ctx context.Context) AdminSystemStatus {
	if s == nil {
		return AdminSystemStatus{
			Status:      "degraded",
			GeneratedAt: time.Now().UTC(),
			Database:    AdminSystemStatusDatabase{Status: "error", Error: "status service unavailable"},
		}
	}

	status := AdminSystemStatus{
		Status:      "ok",
		GeneratedAt: s.now(),
	}

	var errs []string
	record := func(component string, err error) {
		errs = append(errs, fmt.Sprintf("%s: %s", component, err.Error()))
	}

	status.Database = s.database(ctx)
	if status.Database.Status != "ok" {
		status.Status = "degraded"
	}

	status.RunnerPool = s.runnerPool(ctx, record)
	status.Queues.WorkflowTasks = s.workflowTaskQueue(ctx, record)
	status.Queues.Landing = s.landingQueue(ctx, record)
	status.AgentSessions = s.agentSessions(ctx, record)
	status.Connections = s.connections()
	status.Sandboxes = s.sandboxes(ctx, record)
	status.Canaries = s.canaries(ctx, record)
	status.Incidents = s.incidents(ctx, record)

	if status.Canaries.Failing > 0 || status.Canaries.Stale > 0 || len(errs) > 0 {
		status.Status = "degraded"
	}

	status.Errors = errs
	return status
}

func (s *AdminSystemStatusService) database(ctx context.Context) AdminSystemStatusDatabase {
	if s.cfg.DB == nil {
		return AdminSystemStatusDatabase{Status: "error", Error: "database checker not configured"}
	}

	start := time.Now()
	err := s.cfg.DB.Ping(ctx)
	latencyMS := float64(time.Since(start).Microseconds()) / 1000

	if err != nil {
		return AdminSystemStatusDatabase{Status: "error", LatencyMS: latencyMS, Error: err.Error()}
	}
	return AdminSystemStatusDatabase{Status: "ok", LatencyMS: latencyMS}
}

func (s *AdminSystemStatusService) runnerPool(ctx context.Context, record func(string, error)) AdminSystemStatusRunnerPool {
	if s.cfg.Runtime == nil {
		return AdminSystemStatusRunnerPool{}
	}

	// Same statuses the smithers_runner_pool_* gauges are collected from.
	idle, err := s.cfg.Runtime.CountRunners(ctx, "idle")
	if err != nil {
		record("runner_pool", err)
		return AdminSystemStatusRunnerPool{}
	}
	busy, err := s.cfg.Runtime.CountRunners(ctx, "busy")
	if err != nil {
		record("runner_pool", err)
		return AdminSystemStatusRunnerPool{}
	}

	return AdminSystemStatusRunnerPool{Available: int(idle), Claimed: int(busy)}
}

func (s *AdminSystemStatusService) workflowTaskQueue(ctx context.Context, record func(string, error)) AdminSystemStatusWorkflowTaskQueue {
	if s.cfg.Runtime == nil {
		return AdminSystemStatusWorkflowTaskQueue{}
	}

	queue, err := s.cfg.Runtime.GetWorkflowTaskQueueMetrics(ctx)
	if err != nil {
		record("workflow_tasks", err)
		return AdminSystemStatusWorkflowTaskQueue{}
	}

	return AdminSystemStatusWorkflowTaskQueue{
		Depth:            int(queue.Depth),
		OldestAgeSeconds: queue.OldestAgeSeconds,
	}
}

func (s *AdminSystemStatusService) landingQueue(ctx context.Context, record func(string, error)) AdminSystemStatusLandingQueue {
	if s.cfg.LandingQueue == nil {
		return AdminSystemStatusLandingQueue{}
	}

	depth, err := s.cfg.LandingQueue.CountQueuedLandingTasks(ctx)
	if err != nil {
		record("landing", err)
		return AdminSystemStatusLandingQueue{}
	}

	return AdminSystemStatusLandingQueue{Depth: int(depth)}
}

func (s *AdminSystemStatusService) agentSessions(ctx context.Context, record func(string, error)) AdminSystemStatusAgentSessions {
	if s.cfg.Runtime == nil {
		return AdminSystemStatusAgentSessions{}
	}

	active, err := s.cfg.Runtime.CountActiveAgentSessions(ctx)
	if err != nil {
		record("agent_sessions", err)
		return AdminSystemStatusAgentSessions{}
	}
	oldest, err := s.cfg.Runtime.GetActiveAgentSessionOldestAgeSeconds(ctx)
	if err != nil {
		record("agent_sessions", err)
		return AdminSystemStatusAgentSessions{}
	}

	return AdminSystemStatusAgentSessions{Active: int(active), OldestAgeSeconds: oldest}
}

func (s *AdminSystemStatusService) connections() AdminSystemStatusConnections {
	if s.cfg.SSE == nil {
		return AdminSystemStatusConnections{}
	}
	return AdminSystemStatusConnections{SSE: s.cfg.SSE.ActiveConnections()}
}

func (s *AdminSystemStatusService) sandboxes(ctx context.Context, record func(string, error)) AdminSystemStatusSandboxes {
	if s.cfg.Sandboxes == nil {
		return AdminSystemStatusSandboxes{}
	}

	activeVMs, err := s.cfg.Sandboxes.CountActiveSandboxVMs(ctx)
	if err != nil {
		record("sandboxes", err)
		return AdminSystemStatusSandboxes{}
	}

	return AdminSystemStatusSandboxes{ActiveVMs: int(activeVMs)}
}

func (s *AdminSystemStatusService) canaries(ctx context.Context, record func(string, error)) AdminSystemStatusCanaries {
	if s.cfg.Canaries == nil {
		return AdminSystemStatusCanaries{}
	}

	results, err := s.cfg.Canaries.ListCanaryResults(ctx)
	if err != nil {
		record("canaries", err)
		return AdminSystemStatusCanaries{}
	}

	now := s.now()
	tally := AdminSystemStatusCanaries{}
	for _, result := range results {
		// The same classifier GET /api/admin/system/canaries uses, so the two
		// surfaces can never disagree. An unknown status (impossible under the
		// current CHECK constraint) counts as neither passing nor failing,
		// matching the "unknown" pill the listing shows for the same row.
		switch ClassifyCanaryStatus(result.Status) {
		case "passing":
			tally.Passing++
		case "failing":
			tally.Failing++
		}
		// Staleness is orthogonal to pass/fail: a passing canary that stopped
		// reporting is still counted as passing and as stale.
		window := s.cfg.CanaryStaleAfter
		if window <= 0 {
			window = CanaryFreshnessWindow(result.Suite, result.TestName)
		}
		if CanaryIsStale(result.ReportedAt, now, window) {
			tally.Stale++
		}
	}

	return tally
}

func (s *AdminSystemStatusService) incidents(ctx context.Context, record func(string, error)) AdminSystemStatusIncidents {
	if s.cfg.Incidents == nil {
		return AdminSystemStatusIncidents{}
	}

	row, err := s.cfg.Incidents.GetAlertIncidentStateCounts(ctx)
	if err != nil {
		record("incidents", err)
		return AdminSystemStatusIncidents{}
	}

	// The query buckets 'pr_opened' into remediating_count: the workflow
	// opened a fix PR and the incident has not resolved, so it is still an
	// in-flight remediation.
	return AdminSystemStatusIncidents{
		Open:         int(row.OpenCount),
		Acknowledged: int(row.AcknowledgedCount),
		Snoozed:      int(row.SnoozedCount),
		Remediating:  int(row.RemediatingCount),
	}
}
