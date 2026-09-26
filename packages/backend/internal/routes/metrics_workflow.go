package routes

import "github.com/prometheus/client_golang/prometheus"

// WorkflowMetrics holds Prometheus metrics for workflow execution and agent
// session tracking.
type WorkflowMetrics struct {
	// RunsTotal counts completed workflow runs by status.
	RunsTotal *prometheus.CounterVec

	// DurationSeconds records workflow execution time.
	DurationSeconds *prometheus.HistogramVec

	// ActiveAgentSessions tracks the number of currently open AI agent sessions.
	ActiveAgentSessions prometheus.Gauge

	// AgentSessionsCompletedTotal counts completed agent sessions by status.
	AgentSessionsCompletedTotal *prometheus.CounterVec

	// AgentSessionTimeoutsTotal counts agent session timeouts.
	AgentSessionTimeoutsTotal prometheus.Counter

	// ActiveAgentSessionOldestAgeSeconds tracks the age of the oldest active agent session.
	ActiveAgentSessionOldestAgeSeconds prometheus.Gauge

	// RunnerCacheHitTotal counts runner cache lookups by result (hit/miss).
	RunnerCacheHitTotal *prometheus.CounterVec
}

// NewWorkflowMetrics creates a new WorkflowMetrics instance and registers all
// metrics with the provided Prometheus registerer. Pass nil to skip registration.
func NewWorkflowMetrics(reg prometheus.Registerer) *WorkflowMetrics {
	agentSessionsCompleted := prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "smithers_agent_sessions_completed_total",
			Help: "Total number of completed agent sessions, labeled by status.",
		},
		[]string{"status"},
	)

	runnerCacheHit := prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "smithers_runner_cache_hit_total",
			Help: "Total runner cache lookups, labeled by result (hit/miss).",
		},
		[]string{"result"},
	)

	m := &WorkflowMetrics{
		RunsTotal: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "smithers_workflow_runs_total",
				Help: "Total number of completed workflow runs, labeled by status.",
			},
			[]string{"status"},
		),
		DurationSeconds: prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "smithers_workflow_duration_seconds",
				Help:    "Execution duration of workflow runs in seconds.",
				Buckets: []float64{.5, 1, 5, 10, 30, 60, 120, 300, 600},
			},
			[]string{"status"},
		),
		ActiveAgentSessions: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "smithers_active_agent_sessions",
			Help: "Number of currently active AI agent sessions.",
		}),
		AgentSessionsCompletedTotal: agentSessionsCompleted,
		AgentSessionTimeoutsTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "smithers_agent_session_timeouts_total",
			Help: "Total number of agent session timeouts.",
		}),
		ActiveAgentSessionOldestAgeSeconds: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "smithers_active_agent_session_oldest_age_seconds",
			Help: "Age of the oldest active agent session in seconds.",
		}),
		RunnerCacheHitTotal: runnerCacheHit,
	}

	// Initialize expected label values so they appear in /metrics output at zero.
	agentSessionsCompleted.WithLabelValues("completed")
	agentSessionsCompleted.WithLabelValues("failed")
	agentSessionsCompleted.WithLabelValues("cancelled")
	agentSessionsCompleted.WithLabelValues("timed_out")
	runnerCacheHit.WithLabelValues("hit")
	runnerCacheHit.WithLabelValues("miss")

	if reg != nil {
		reg.MustRegister(
			m.RunsTotal,
			m.DurationSeconds,
			m.ActiveAgentSessions,
			m.AgentSessionsCompletedTotal,
			m.AgentSessionTimeoutsTotal,
			m.ActiveAgentSessionOldestAgeSeconds,
			m.RunnerCacheHitTotal,
		)
	}

	return m
}
