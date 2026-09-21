package clusterservices

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/services"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type fakeStatusPinger struct {
	err error
}

func (f *fakeStatusPinger) Ping(context.Context) error { return f.err }

type fakeStatusRuntimeStore struct {
	idle           int64
	busy           int64
	runnersErr     error
	activeSessions int64
	oldestSession  float64
	sessionsErr    error
	oldestErr      error
	queue          services.WorkflowTaskQueueMetrics
	queueErr       error
}

func (f *fakeStatusRuntimeStore) CountRunners(_ context.Context, statusFilter string) (int64, error) {
	if f.runnersErr != nil {
		return 0, f.runnersErr
	}
	switch statusFilter {
	case "idle":
		return f.idle, nil
	case "busy":
		return f.busy, nil
	default:
		return 0, nil
	}
}

func (f *fakeStatusRuntimeStore) CountActiveAgentSessions(context.Context) (int64, error) {
	return f.activeSessions, f.sessionsErr
}

func (f *fakeStatusRuntimeStore) GetActiveAgentSessionOldestAgeSeconds(context.Context) (float64, error) {
	return f.oldestSession, f.oldestErr
}

func (f *fakeStatusRuntimeStore) GetWorkflowTaskQueueMetrics(context.Context) (services.WorkflowTaskQueueMetrics, error) {
	return f.queue, f.queueErr
}

type fakeStatusCanaryLister struct {
	results []db.CanaryResult
	err     error
}

func (f *fakeStatusCanaryLister) ListCanaryResults(context.Context) ([]db.CanaryResult, error) {
	return f.results, f.err
}

type fakeStatusSandboxCounter struct {
	activeVMs int64
	err       error
}

func (f *fakeStatusSandboxCounter) CountActiveSandboxVMs(context.Context) (int64, error) {
	return f.activeVMs, f.err
}

type fakeStatusLandingQueueCounter struct {
	depth int64
	err   error
}

func (f *fakeStatusLandingQueueCounter) CountQueuedLandingTasks(context.Context) (int64, error) {
	return f.depth, f.err
}

type fakeStatusIncidentCounter struct {
	counts db.GetAlertIncidentStateCountsRow
	err    error
	calls  int
}

func (f *fakeStatusIncidentCounter) GetAlertIncidentStateCounts(context.Context) (db.GetAlertIncidentStateCountsRow, error) {
	f.calls++
	return f.counts, f.err
}

type fakeStatusSSECounter struct {
	count int
}

func (f *fakeStatusSSECounter) ActiveConnections() int { return f.count }

var statusTestNow = time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)

func statusTestClock() time.Time { return statusTestNow }

func healthyStatusConfig() AdminSystemStatusServiceConfig {
	return AdminSystemStatusServiceConfig{
		DB: &fakeStatusPinger{},
		Runtime: &fakeStatusRuntimeStore{
			idle:           4,
			busy:           2,
			activeSessions: 3,
			oldestSession:  120.5,
			queue:          services.WorkflowTaskQueueMetrics{Depth: 7, OldestAgeSeconds: 31.25},
		},
		Canaries: &fakeStatusCanaryLister{
			results: []db.CanaryResult{
				{Suite: "workflow", TestName: "auth", Status: "success", ReportedAt: statusTestNow.Add(-time.Minute)},
				{Suite: "workflow", TestName: "repo", Status: "success", ReportedAt: statusTestNow.Add(-2 * time.Minute)},
			},
		},
		Sandboxes:    &fakeStatusSandboxCounter{activeVMs: 7},
		LandingQueue: &fakeStatusLandingQueueCounter{depth: 9},
		// remediating_count folds 'pr_opened' in server-side, mirroring the
		// GetAlertIncidentStateCounts query.
		Incidents: &fakeStatusIncidentCounter{
			counts: db.GetAlertIncidentStateCountsRow{OpenCount: 1, RemediatingCount: 2, AcknowledgedCount: 3, SnoozedCount: 4},
		},
		SSE:   &fakeStatusSSECounter{count: 42},
		Clock: statusTestClock,
	}
}

func TestAdminSystemStatusService_SystemStatus(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		config func() AdminSystemStatusServiceConfig
		verify func(t *testing.T, status AdminSystemStatus)
	}{
		{
			name:   "all healthy reports ok with every aggregate populated",
			config: healthyStatusConfig,
			verify: func(t *testing.T, status AdminSystemStatus) {
				assert.Equal(t, "ok", status.Status)
				assert.Equal(t, statusTestNow, status.GeneratedAt)
				assert.Equal(t, "ok", status.Database.Status)
				assert.Empty(t, status.Database.Error)
				assert.GreaterOrEqual(t, status.Database.LatencyMS, float64(0))
				assert.Equal(t, AdminSystemStatusRunnerPool{Available: 4, Claimed: 2}, status.RunnerPool)
				assert.Equal(t, 7, status.Queues.WorkflowTasks.Depth)
				assert.InDelta(t, 31.25, status.Queues.WorkflowTasks.OldestAgeSeconds, 0.0001)
				assert.Equal(t, 9, status.Queues.Landing.Depth)
				assert.Equal(t, 42, status.Connections.SSE)
				assert.Equal(t, 3, status.AgentSessions.Active)
				assert.InDelta(t, 120.5, status.AgentSessions.OldestAgeSeconds, 0.0001)
				assert.Equal(t, 7, status.Sandboxes.ActiveVMs)
				assert.Equal(t, AdminSystemStatusCanaries{Passing: 2}, status.Canaries)
				assert.Equal(t, AdminSystemStatusIncidents{Open: 1, Remediating: 2, Acknowledged: 3, Snoozed: 4}, status.Incidents)
				assert.Empty(t, status.Errors)
			},
		},
		{
			name: "database failure degrades status but keeps other aggregates",
			config: func() AdminSystemStatusServiceConfig {
				cfg := healthyStatusConfig()
				cfg.DB = &fakeStatusPinger{err: errors.New("connection refused")}
				return cfg
			},
			verify: func(t *testing.T, status AdminSystemStatus) {
				assert.Equal(t, "degraded", status.Status)
				assert.Equal(t, "error", status.Database.Status)
				assert.Contains(t, status.Database.Error, "connection refused")
				assert.Equal(t, AdminSystemStatusRunnerPool{Available: 4, Claimed: 2}, status.RunnerPool)
				assert.Equal(t, 42, status.Connections.SSE)
				assert.Empty(t, status.Errors)
			},
		},
		{
			name: "unconfigured database checker degrades status",
			config: func() AdminSystemStatusServiceConfig {
				cfg := healthyStatusConfig()
				cfg.DB = nil
				return cfg
			},
			verify: func(t *testing.T, status AdminSystemStatus) {
				assert.Equal(t, "degraded", status.Status)
				assert.Equal(t, "error", status.Database.Status)
				assert.Contains(t, status.Database.Error, "not configured")
			},
		},
		{
			name: "runner pool failure zeroes its aggregate and records an error",
			config: func() AdminSystemStatusServiceConfig {
				cfg := healthyStatusConfig()
				cfg.Runtime = &fakeStatusRuntimeStore{
					runnersErr:     errors.New("runner query failed"),
					activeSessions: 3,
					oldestSession:  120.5,
					queue:          services.WorkflowTaskQueueMetrics{Depth: 7, OldestAgeSeconds: 31.25},
				}
				return cfg
			},
			verify: func(t *testing.T, status AdminSystemStatus) {
				assert.Equal(t, "degraded", status.Status)
				assert.Equal(t, AdminSystemStatusRunnerPool{}, status.RunnerPool)
				assert.Equal(t, 7, status.Queues.WorkflowTasks.Depth)
				assert.Equal(t, 3, status.AgentSessions.Active)
				require.Len(t, status.Errors, 1)
				assert.Contains(t, status.Errors[0], "runner_pool: runner query failed")
			},
		},
		{
			name: "every failing aggregate is reported and none fails the snapshot",
			config: func() AdminSystemStatusServiceConfig {
				cfg := healthyStatusConfig()
				cfg.Runtime = &fakeStatusRuntimeStore{
					runnersErr:  errors.New("runner query failed"),
					queueErr:    errors.New("backlog query failed"),
					sessionsErr: errors.New("session query failed"),
				}
				cfg.LandingQueue = &fakeStatusLandingQueueCounter{err: errors.New("landing query failed")}
				cfg.Sandboxes = &fakeStatusSandboxCounter{err: errors.New("vm query failed")}
				cfg.Canaries = &fakeStatusCanaryLister{err: errors.New("canary query failed")}
				cfg.Incidents = &fakeStatusIncidentCounter{err: errors.New("incident query failed")}
				return cfg
			},
			verify: func(t *testing.T, status AdminSystemStatus) {
				assert.Equal(t, "degraded", status.Status)
				assert.Equal(t, AdminSystemStatusRunnerPool{}, status.RunnerPool)
				assert.Equal(t, AdminSystemStatusQueues{}, status.Queues)
				assert.Equal(t, AdminSystemStatusAgentSessions{}, status.AgentSessions)
				assert.Equal(t, AdminSystemStatusSandboxes{}, status.Sandboxes)
				assert.Equal(t, AdminSystemStatusCanaries{}, status.Canaries)
				assert.Equal(t, AdminSystemStatusIncidents{}, status.Incidents)
				assert.Equal(t, []string{
					"runner_pool: runner query failed",
					"workflow_tasks: backlog query failed",
					"landing: landing query failed",
					"agent_sessions: session query failed",
					"sandboxes: vm query failed",
					"canaries: canary query failed",
					"incidents: incident query failed",
				}, status.Errors)
			},
		},
		{
			name: "failing canaries degrade status",
			config: func() AdminSystemStatusServiceConfig {
				cfg := healthyStatusConfig()
				cfg.Canaries = &fakeStatusCanaryLister{
					results: []db.CanaryResult{
						{TestName: "auth", Status: "success", ReportedAt: statusTestNow.Add(-time.Minute)},
						{TestName: "repo", Status: "failure", ReportedAt: statusTestNow.Add(-2 * time.Minute)},
					},
				}
				return cfg
			},
			verify: func(t *testing.T, status AdminSystemStatus) {
				assert.Equal(t, "degraded", status.Status)
				assert.Equal(t, AdminSystemStatusCanaries{Passing: 1, Failing: 1}, status.Canaries)
				assert.Empty(t, status.Errors)
			},
		},
		{
			name: "stale canaries are counted separately from pass and fail",
			config: func() AdminSystemStatusServiceConfig {
				cfg := healthyStatusConfig()
				cfg.Canaries = &fakeStatusCanaryLister{
					results: []db.CanaryResult{
						{TestName: "fresh", Status: "success", ReportedAt: statusTestNow.Add(-14 * time.Minute)},
						{TestName: "stale-pass", Status: "success", ReportedAt: statusTestNow.Add(-16 * time.Minute)},
					},
				}
				return cfg
			},
			verify: func(t *testing.T, status AdminSystemStatus) {
				assert.Equal(t, "degraded", status.Status)
				assert.Equal(t, AdminSystemStatusCanaries{Passing: 2, Stale: 1}, status.Canaries)
			},
		},
		{
			name: "sandbox count is fleet-wide and independent of agent sessions",
			config: func() AdminSystemStatusServiceConfig {
				// A capacity incident with only workspace and repo-gateway VMs
				// live: no agent session and no anonymous sandbox is running,
				// yet 25 micro-VMs still hold reservations.
				cfg := healthyStatusConfig()
				cfg.Runtime = &fakeStatusRuntimeStore{idle: 4, busy: 2}
				cfg.Sandboxes = &fakeStatusSandboxCounter{activeVMs: 25}
				return cfg
			},
			verify: func(t *testing.T, status AdminSystemStatus) {
				assert.Equal(t, 0, status.AgentSessions.Active)
				assert.Equal(t, 25, status.Sandboxes.ActiveVMs)
				assert.Empty(t, status.Errors)
			},
		},
		{
			name: "unwired optional sources report zeros without errors",
			config: func() AdminSystemStatusServiceConfig {
				return AdminSystemStatusServiceConfig{DB: &fakeStatusPinger{}, Clock: statusTestClock}
			},
			verify: func(t *testing.T, status AdminSystemStatus) {
				assert.Equal(t, "ok", status.Status)
				assert.Equal(t, "ok", status.Database.Status)
				assert.Equal(t, AdminSystemStatusRunnerPool{}, status.RunnerPool)
				assert.Equal(t, AdminSystemStatusQueues{}, status.Queues)
				assert.Equal(t, AdminSystemStatusConnections{}, status.Connections)
				assert.Equal(t, AdminSystemStatusAgentSessions{}, status.AgentSessions)
				assert.Equal(t, AdminSystemStatusSandboxes{}, status.Sandboxes)
				assert.Equal(t, AdminSystemStatusCanaries{}, status.Canaries)
				assert.Equal(t, AdminSystemStatusIncidents{}, status.Incidents)
				assert.Empty(t, status.Errors)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			svc := NewAdminSystemStatusService(tt.config())
			tt.verify(t, svc.SystemStatus(context.Background()))
		})
	}
}

func TestAdminSystemStatusService_Defaults(t *testing.T) {
	t.Parallel()

	t.Run("uses cadence-specific windows by default", func(t *testing.T) {
		t.Parallel()

		incidents := &fakeStatusIncidentCounter{}
		svc := NewAdminSystemStatusService(AdminSystemStatusServiceConfig{
			DB:        &fakeStatusPinger{},
			Incidents: incidents,
		})

		require.Zero(t, svc.cfg.CanaryStaleAfter)

		svc.SystemStatus(context.Background())
		assert.Equal(t, 1, incidents.calls)
	})

	t.Run("honors overrides", func(t *testing.T) {
		t.Parallel()

		svc := NewAdminSystemStatusService(AdminSystemStatusServiceConfig{
			DB:               &fakeStatusPinger{},
			Incidents:        &fakeStatusIncidentCounter{},
			Canaries:         &fakeStatusCanaryLister{results: []db.CanaryResult{{TestName: "a", Status: "success", ReportedAt: statusTestNow.Add(-time.Minute)}}},
			Clock:            statusTestClock,
			CanaryStaleAfter: 30 * time.Second,
		})

		status := svc.SystemStatus(context.Background())
		assert.Equal(t, AdminSystemStatusCanaries{Passing: 1, Stale: 1}, status.Canaries)
	})

	t.Run("nil service returns a degraded snapshot", func(t *testing.T) {
		t.Parallel()

		var svc *AdminSystemStatusService
		status := svc.SystemStatus(context.Background())
		assert.Equal(t, "degraded", status.Status)
		assert.Equal(t, "error", status.Database.Status)
		assert.False(t, status.GeneratedAt.IsZero())
	})
}

func (f *fakeStatusRuntimeStore) GetLandingQueueDepth(context.Context) (int64, error) { return 7, nil }
