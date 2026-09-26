package services

import (
	"context"
	"fmt"
	"time"
)

// AdminSystemStatusPinger verifies database reachability.
//
// *pgxpool.Pool satisfies it directly.
type AdminSystemStatusPinger interface {
	Ping(ctx context.Context) error
}

// AdminSystemStatusSSECounter reports live server-sent-event connections.
//
// *sse.Broker satisfies it directly.
type AdminSystemStatusSSECounter interface {
	ActiveConnections() int
}

// AdminSystemStatusDatabase reports database reachability and probe latency.
type AdminSystemStatusDatabase struct {
	Status    string  `json:"status"`
	LatencyMS float64 `json:"latency_ms"`
	Error     string  `json:"error,omitempty"`
}

// AdminSystemStatusLandingQueue reports the landing queue backlog.
type AdminSystemStatusLandingQueue struct {
	Depth int `json:"depth"`
}

// AdminSystemStatusQueues groups every queue depth.
type AdminSystemStatusQueues struct {
	Landing AdminSystemStatusLandingQueue `json:"landing"`
}

// AdminSystemStatusConnections reports live client connections on this
// backend process.
type AdminSystemStatusConnections struct {
	SSE int `json:"sse"`
}

// AdminSystemStatusAgentSessions reports live agent sessions.
type AdminSystemStatusAgentSessions struct {
	Active           int     `json:"active"`
	OldestAgeSeconds float64 `json:"oldest_age_seconds"`
}

// AdminSystemStatus is the control-plane status snapshot returned by
// GET /api/admin/system/status. Every field is read from the same source as the
// matching runtime gauge.
type AdminSystemStatus struct {
	Status        string                         `json:"status"`
	GeneratedAt   time.Time                      `json:"generated_at"`
	Database      AdminSystemStatusDatabase      `json:"database"`
	Queues        AdminSystemStatusQueues        `json:"queues"`
	Connections   AdminSystemStatusConnections   `json:"connections"`
	AgentSessions AdminSystemStatusAgentSessions `json:"agent_sessions"`
	// Errors names each section that could not be read, as
	// "<section>: <message>". A failed section reports zero values and
	// degrades the overall status without failing the request.
	Errors []string `json:"errors,omitempty"`
}

// AdminSystemStatusServiceConfig wires the snapshot's sources. DB is required;
// a nil Runtime or SSE reports zero values for its sections.
type AdminSystemStatusServiceConfig struct {
	DB      AdminSystemStatusPinger
	Runtime RuntimeMetricsStore
	SSE     AdminSystemStatusSSECounter
	// Clock supplies the current time. Nil means time.Now.
	Clock func() time.Time
}

// AdminSystemStatusService builds the control-plane status snapshot.
type AdminSystemStatusService struct {
	cfg AdminSystemStatusServiceConfig
}

// NewAdminSystemStatusService creates the status service.
func NewAdminSystemStatusService(cfg AdminSystemStatusServiceConfig) *AdminSystemStatusService {
	return &AdminSystemStatusService{cfg: cfg}
}

// SystemStatus reads every source and returns a snapshot. It never returns an
// error: a failing source contributes zero values plus an entry in Errors.
func (s *AdminSystemStatusService) SystemStatus(ctx context.Context) AdminSystemStatus {
	now := time.Now
	if s.cfg.Clock != nil {
		now = s.cfg.Clock
	}
	status := AdminSystemStatus{Status: "ok", GeneratedAt: now().UTC()}
	record := func(section string, err error) {
		status.Errors = append(status.Errors, fmt.Sprintf("%s: %s", section, err))
	}

	status.Database = s.database(ctx)
	if runtime := s.cfg.Runtime; runtime != nil {
		if depth, err := runtime.GetLandingQueueDepth(ctx); err != nil {
			record("landing", err)
		} else {
			status.Queues.Landing.Depth = int(depth)
		}
		status.AgentSessions = agentSessionStatus(ctx, runtime, record)
	}
	if s.cfg.SSE != nil {
		status.Connections.SSE = s.cfg.SSE.ActiveConnections()
	}
	if status.Database.Status != "ok" || len(status.Errors) > 0 {
		status.Status = "degraded"
	}
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

func agentSessionStatus(ctx context.Context, runtime RuntimeMetricsStore, record func(string, error)) AdminSystemStatusAgentSessions {
	active, err := runtime.CountActiveAgentSessions(ctx)
	if err != nil {
		record("agent_sessions", err)
		return AdminSystemStatusAgentSessions{}
	}
	oldest, err := runtime.GetActiveAgentSessionOldestAgeSeconds(ctx)
	if err != nil {
		record("agent_sessions", err)
		return AdminSystemStatusAgentSessions{}
	}
	return AdminSystemStatusAgentSessions{Active: int(active), OldestAgeSeconds: oldest}
}
