package services

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

const countActiveAgentSessionsSQL = `
SELECT COUNT(*)
FROM agent_sessions
WHERE status = 'active'
`

const oldestActiveAgentSessionAgeSQL = `
SELECT COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at)), 0)
FROM agent_sessions
WHERE status = 'active'
`

// RuntimeMetricsObserver receives live runtime state updates for gauges.
type RuntimeMetricsObserver interface {
	SetRunnerPoolAvailable(n float64)
	SetRunnerPoolClaimed(n float64)
	SetActiveAgentSessions(n float64)
	SetActiveAgentSessionOldestAgeSeconds(n float64)
	SetLandingQueueDepth(n int)
	SetWorkflowTaskQueueDepth(n float64)
	SetWorkflowTaskQueueOldestAgeSeconds(n float64)
}

// WorkflowRunMetricsObserver records terminal workflow outcomes.
type WorkflowRunMetricsObserver interface {
	ObserveWorkflowRunCompletion(status string, seconds float64)
}

// AgentSessionMetricsObserver records agent terminal session outcomes.
type AgentSessionMetricsObserver interface {
	ObserveAgentSessionCompletion(status string)
	ObserveAgentSessionTimeout()
}

// RuntimeMetricsStore reads the current state backing runtime gauges.
type RuntimeMetricsStore interface {
	CountRunners(ctx context.Context, statusFilter string) (int64, error)
	CountActiveAgentSessions(ctx context.Context) (int64, error)
	GetActiveAgentSessionOldestAgeSeconds(ctx context.Context) (float64, error)
	GetWorkflowTaskQueueMetrics(ctx context.Context) (WorkflowTaskQueueMetrics, error)
	GetLandingQueueDepth(ctx context.Context) (int64, error)
}

type WorkflowTaskQueueMetrics struct {
	Depth            int64
	OldestAgeSeconds float64
}

type runtimeMetricsQuerier interface {
	GetLandingQueueDepth(ctx context.Context) (int64, error)
	CountRunners(ctx context.Context, statusFilter string) (int64, error)
	GetClaimableWorkflowTaskBacklog(ctx context.Context) (db.GetClaimableWorkflowTaskBacklogRow, error)
}

type dbRuntimeMetricsStore struct {
	queries runtimeMetricsQuerier
	pool    *pgxpool.Pool
}

// NewRuntimeMetricsStore creates a runtime metrics store backed by PostgreSQL.
func NewRuntimeMetricsStore(queries runtimeMetricsQuerier, pool *pgxpool.Pool) RuntimeMetricsStore {
	return &dbRuntimeMetricsStore{
		queries: queries,
		pool:    pool,
	}
}

func (s *dbRuntimeMetricsStore) CountRunners(ctx context.Context, statusFilter string) (int64, error) {
	if s == nil || s.queries == nil {
		return 0, nil
	}
	return s.queries.CountRunners(ctx, statusFilter)
}

func (s *dbRuntimeMetricsStore) CountActiveAgentSessions(ctx context.Context) (int64, error) {
	if s == nil || s.pool == nil {
		return 0, nil
	}
	var count int64
	err := s.pool.QueryRow(ctx, countActiveAgentSessionsSQL).Scan(&count)
	return count, err
}

func (s *dbRuntimeMetricsStore) GetActiveAgentSessionOldestAgeSeconds(ctx context.Context) (float64, error) {
	if s == nil || s.pool == nil {
		return 0, nil
	}
	var seconds float64
	err := s.pool.QueryRow(ctx, oldestActiveAgentSessionAgeSQL).Scan(&seconds)
	return seconds, err
}

func (s *dbRuntimeMetricsStore) GetWorkflowTaskQueueMetrics(ctx context.Context) (WorkflowTaskQueueMetrics, error) {
	if s == nil || s.queries == nil {
		return WorkflowTaskQueueMetrics{}, nil
	}

	backlog, err := s.queries.GetClaimableWorkflowTaskBacklog(ctx)
	if err != nil {
		return WorkflowTaskQueueMetrics{}, err
	}

	return WorkflowTaskQueueMetrics{
		Depth:            backlog.Depth,
		OldestAgeSeconds: backlog.OldestAgeSeconds,
	}, nil
}

func (s *dbRuntimeMetricsStore) GetLandingQueueDepth(ctx context.Context) (int64, error) {
	if s == nil || s.queries == nil {
		return 0, nil
	}
	return s.queries.GetLandingQueueDepth(ctx)
}

// StartRuntimeMetricsCollector periodically refreshes runtime state gauges from
// the database so alerts and dashboards reflect live runner/session counts.
func StartRuntimeMetricsCollector(ctx context.Context, store RuntimeMetricsStore, observer RuntimeMetricsObserver, interval time.Duration) {
	if store == nil || observer == nil {
		return
	}

	startRuntimeMetricsCollector(ctx, store, observer, interval, 3*time.Second)
}

func startRuntimeMetricsCollector(ctx context.Context, store RuntimeMetricsStore, observer RuntimeMetricsObserver, interval, timeout time.Duration) {
	collect := func() {
		refreshCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		// Independent queries publish successful values immediately, even while
		// another query is waiting for its deadline. Wait before the next poll so
		// refreshes cannot accumulate during a database outage.
		var wg sync.WaitGroup
		run := func(name string, query func(context.Context) error) {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := query(refreshCtx); err != nil {
					slog.Warn("runtime metrics collection failed", "metric", name, "error", err)
				}
			}()
		}
		run("runner_available", func(ctx context.Context) error {
			n, err := store.CountRunners(ctx, "idle")
			if err == nil {
				observer.SetRunnerPoolAvailable(float64(n))
			}
			return err
		})
		run("runner_claimed", func(ctx context.Context) error {
			n, err := store.CountRunners(ctx, "busy")
			if err == nil {
				observer.SetRunnerPoolClaimed(float64(n))
			}
			return err
		})
		run("active_sessions", func(ctx context.Context) error {
			n, err := store.CountActiveAgentSessions(ctx)
			if err == nil {
				observer.SetActiveAgentSessions(float64(n))
			}
			return err
		})
		run("oldest_session", func(ctx context.Context) error {
			n, err := store.GetActiveAgentSessionOldestAgeSeconds(ctx)
			if err == nil {
				observer.SetActiveAgentSessionOldestAgeSeconds(n)
			}
			return err
		})
		run("workflow_queue", func(ctx context.Context) error {
			n, err := store.GetWorkflowTaskQueueMetrics(ctx)
			if err == nil {
				observer.SetWorkflowTaskQueueDepth(float64(n.Depth))
				observer.SetWorkflowTaskQueueOldestAgeSeconds(n.OldestAgeSeconds)
			}
			return err
		})
		run("landing_queue", func(ctx context.Context) error {
			n, err := store.GetLandingQueueDepth(ctx)
			if err == nil {
				observer.SetLandingQueueDepth(int(n))
			}
			return err
		})
		wg.Wait()
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			if ctx.Err() != nil {
				return
			}
			collect()
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

func ObserveWorkflowRunCompletion(observer WorkflowRunMetricsObserver, run db.WorkflowRun, status string) {
	if observer == nil || run.ID <= 0 || !IsTerminalWorkflowRunStatus(status) || IsTerminalWorkflowRunStatus(run.Status) {
		return
	}

	startedAt := run.CreatedAt
	if run.StartedAt.Valid {
		startedAt = run.StartedAt.Time
	}

	duration := time.Since(startedAt).Seconds()
	if duration < 0 {
		return
	}

	observer.ObserveWorkflowRunCompletion(status, duration)
}
