package sandbox

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// UsageRecord represents a single metered compute usage interval.
type UsageRecord struct {
	WorkspaceID string        `json:"workspace_id"`
	VMID        string        `json:"vm_id"`
	UserID      int64         `json:"user_id"`
	OrgID       int64         `json:"org_id,omitempty"`
	StartedAt   time.Time     `json:"started_at"`
	StoppedAt   *time.Time    `json:"stopped_at,omitempty"`
	Duration    time.Duration `json:"duration"`
	VCPUs       int32         `json:"vcpus"`
	MemoryMB    int32         `json:"memory_mb"`
}

// ComputeMinutes returns the total billed compute-minutes, computed as
// wall-clock minutes multiplied by vCPU count.
func (u *UsageRecord) ComputeMinutes() float64 {
	mins := u.Duration.Minutes()
	return mins * float64(u.VCPUs)
}

// QuotaStatus reports the current usage against a user/org quota.
type QuotaStatus struct {
	UserID           int64   `json:"user_id"`
	OrgID            int64   `json:"org_id,omitempty"`
	UsedMinutes      float64 `json:"used_minutes"`
	QuotaMinutes     float64 `json:"quota_minutes"`
	RemainingMinutes float64 `json:"remaining_minutes"`
	Exceeded         bool    `json:"exceeded"`
}

// BillingReporter sends usage data to an external billing service.
// Implementations are responsible for batching and delivery.
type BillingReporter interface {
	ReportUsage(ctx context.Context, records []UsageRecord) error
}

// MeteringService tracks workspace compute minutes and reports usage to
// billing. It maintains an in-memory map of active timers keyed by VM ID
// and flushes completed intervals to the database and billing reporter.
type MeteringService struct {
	db      *pgxpool.Pool
	billing BillingReporter
	logger  *slog.Logger
	metrics *SandboxMetrics

	mu      sync.Mutex
	timers  map[string]*activeTimer // keyed by VM ID
	stopped chan struct{}
}

// activeTimer tracks a running compute interval.
type activeTimer struct {
	vmID        string
	workspaceID string
	userID      int64
	orgID       int64
	vcpus       int32
	memoryMB    int32
	startedAt   time.Time
}

// NewMeteringService creates a MeteringService.
func NewMeteringService(
	db *pgxpool.Pool,
	billing BillingReporter,
	logger *slog.Logger,
	metrics *SandboxMetrics,
) *MeteringService {
	return &MeteringService{
		db:      db,
		billing: billing,
		logger:  logger,
		metrics: metrics,
		timers:  make(map[string]*activeTimer),
		stopped: make(chan struct{}),
	}
}

// StartTimer begins tracking compute time for a VM. Called when a workspace
// VM is created or resumed.
func (m *MeteringService) StartTimer(vmID, workspaceID string, userID, orgID int64, vcpus, memoryMB int32) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.timers[vmID]; exists {
		// Timer already running, do not double-count.
		return
	}

	m.timers[vmID] = &activeTimer{
		vmID:        vmID,
		workspaceID: workspaceID,
		userID:      userID,
		orgID:       orgID,
		vcpus:       vcpus,
		memoryMB:    memoryMB,
		startedAt:   time.Now(),
	}

	m.logger.Debug("metering timer started",
		slog.String("vm_id", vmID),
		slog.String("workspace_id", workspaceID),
		slog.Int("vcpus", int(vcpus)),
	)
}

// StopTimer ends compute tracking for a VM. Called when a workspace VM is
// suspended or deleted. It records the usage and reports it to billing.
func (m *MeteringService) StopTimer(ctx context.Context, vmID string) (*UsageRecord, error) {
	m.mu.Lock()
	timer, exists := m.timers[vmID]
	if !exists {
		m.mu.Unlock()
		return nil, nil // no timer running, nothing to stop
	}
	delete(m.timers, vmID)
	m.mu.Unlock()

	now := time.Now()
	record := &UsageRecord{
		WorkspaceID: timer.workspaceID,
		VMID:        timer.vmID,
		UserID:      timer.userID,
		OrgID:       timer.orgID,
		StartedAt:   timer.startedAt,
		StoppedAt:   &now,
		Duration:    now.Sub(timer.startedAt),
		VCPUs:       timer.vcpus,
		MemoryMB:    timer.memoryMB,
	}

	m.logger.Info("metering timer stopped",
		slog.String("vm_id", vmID),
		slog.String("workspace_id", timer.workspaceID),
		slog.Float64("compute_minutes", record.ComputeMinutes()),
		slog.Duration("wall_duration", record.Duration),
	)

	// Persist to the database. On failure, restore the timer (unless a new
	// one was started meanwhile) so the interval is not silently lost — a
	// later StopTimer/FlushAll retry will record it.
	if err := m.recordUsage(ctx, record); err != nil {
		m.mu.Lock()
		if _, exists := m.timers[vmID]; !exists {
			m.timers[vmID] = timer
		}
		m.mu.Unlock()
		m.logger.Error("failed to record usage",
			slog.String("vm_id", vmID),
			slog.String("error", err.Error()),
		)
		return record, fmt.Errorf("record usage: %w", err)
	}

	// Report to billing (best-effort, do not fail the stop operation).
	if m.billing != nil {
		if err := m.billing.ReportUsage(ctx, []UsageRecord{*record}); err != nil {
			m.logger.Error("failed to report usage to billing",
				slog.String("vm_id", vmID),
				slog.String("error", err.Error()),
			)
			// Do not return error — the record is persisted in DB and can be
			// retried by a reconciliation job.
		}
	}

	return record, nil
}

// CheckQuota verifies that the user/org has sufficient compute quota remaining
// before creating a new VM. Returns a QuotaStatus and a non-nil error if the
// quota is exceeded.
func (m *MeteringService) CheckQuota(ctx context.Context, userID, orgID int64) (*QuotaStatus, error) {
	// Query total usage for the current billing period (calendar month).
	now := time.Now().UTC()
	periodStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)

	// When an org quota applies (orgID > 0), usage must be summed across the
	// whole org — otherwise each member could burn the full org quota.
	var usedMinutes float64
	var err error
	if orgID > 0 {
		err = m.db.QueryRow(ctx,
			`SELECT COALESCE(SUM(compute_minutes), 0)
			 FROM sandbox_usage
			 WHERE org_id = $1
			   AND started_at >= $2`,
			orgID, periodStart,
		).Scan(&usedMinutes)
		if err != nil {
			return nil, fmt.Errorf("query usage for org %d: %w", orgID, err)
		}
	} else {
		err = m.db.QueryRow(ctx,
			`SELECT COALESCE(SUM(compute_minutes), 0)
			 FROM sandbox_usage
			 WHERE user_id = $1
			   AND started_at >= $2`,
			userID, periodStart,
		).Scan(&usedMinutes)
		if err != nil {
			return nil, fmt.Errorf("query usage for user %d: %w", userID, err)
		}
	}

	// Add currently-running timers in the same scope.
	m.mu.Lock()
	for _, t := range m.timers {
		inScope := t.userID == userID
		if orgID > 0 {
			inScope = t.orgID == orgID
		}
		if inScope {
			elapsed := time.Since(t.startedAt).Minutes()
			usedMinutes += elapsed * float64(t.vcpus)
		}
	}
	m.mu.Unlock()

	// Query quota limit. Uses org quota if orgID > 0, otherwise user quota.
	var quotaMinutes float64
	if orgID > 0 {
		err = m.db.QueryRow(ctx,
			`SELECT COALESCE(compute_quota_minutes, 0) FROM organizations WHERE id = $1`,
			orgID,
		).Scan(&quotaMinutes)
	} else {
		err = m.db.QueryRow(ctx,
			`SELECT COALESCE(compute_quota_minutes, 0) FROM users WHERE id = $1`,
			userID,
		).Scan(&quotaMinutes)
	}
	if err != nil {
		return nil, fmt.Errorf("query quota: %w", err)
	}

	// Zero quota means unlimited.
	if quotaMinutes == 0 {
		return &QuotaStatus{
			UserID:           userID,
			OrgID:            orgID,
			UsedMinutes:      usedMinutes,
			QuotaMinutes:     0,
			RemainingMinutes: 0,
			Exceeded:         false,
		}, nil
	}

	remaining := quotaMinutes - usedMinutes
	exceeded := remaining <= 0

	status := &QuotaStatus{
		UserID:           userID,
		OrgID:            orgID,
		UsedMinutes:      usedMinutes,
		QuotaMinutes:     quotaMinutes,
		RemainingMinutes: remaining,
		Exceeded:         exceeded,
	}

	if exceeded {
		return status, fmt.Errorf("compute quota exceeded: used %.1f of %.1f minutes", usedMinutes, quotaMinutes)
	}

	return status, nil
}

// recordUsage persists a usage record to the sandbox_usage table.
func (m *MeteringService) recordUsage(ctx context.Context, record *UsageRecord) error {
	_, err := m.db.Exec(ctx,
		`INSERT INTO sandbox_usage
		 (workspace_id, vm_id, user_id, org_id, started_at, stopped_at, duration_seconds, vcpus, memory_mb, compute_minutes)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		record.WorkspaceID,
		record.VMID,
		record.UserID,
		record.OrgID,
		record.StartedAt,
		record.StoppedAt,
		int64(record.Duration.Seconds()),
		record.VCPUs,
		record.MemoryMB,
		record.ComputeMinutes(),
	)
	return err
}

// FlushAll stops all active timers and records their usage. Called during
// graceful shutdown.
func (m *MeteringService) FlushAll(ctx context.Context) error {
	m.mu.Lock()
	vmIDs := make([]string, 0, len(m.timers))
	for vmID := range m.timers {
		vmIDs = append(vmIDs, vmID)
	}
	m.mu.Unlock()

	var firstErr error
	for _, vmID := range vmIDs {
		if _, err := m.StopTimer(ctx, vmID); err != nil && firstErr == nil {
			firstErr = err
		}
	}

	return firstErr
}

// ActiveTimerCount returns the number of VMs currently being metered.
func (m *MeteringService) ActiveTimerCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.timers)
}

// GetActiveUsage returns usage records for all currently-running timers
// (with Duration computed from start to now). Useful for dashboards.
func (m *MeteringService) GetActiveUsage() []UsageRecord {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	records := make([]UsageRecord, 0, len(m.timers))
	for _, t := range m.timers {
		records = append(records, UsageRecord{
			WorkspaceID: t.workspaceID,
			VMID:        t.vmID,
			UserID:      t.userID,
			OrgID:       t.orgID,
			StartedAt:   t.startedAt,
			Duration:    now.Sub(t.startedAt),
			VCPUs:       t.vcpus,
			MemoryMB:    t.memoryMB,
		})
	}

	return records
}

// RunPeriodicFlush starts a background goroutine that periodically flushes
// in-progress usage to the database for crash recovery. The goroutine stops
// when the context is cancelled.
func (m *MeteringService) RunPeriodicFlush(ctx context.Context, interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.flushInProgress(ctx)
			}
		}
	}()
}

// flushInProgress writes heartbeat records for active timers so that usage
// can be recovered if the process crashes before StopTimer is called.
func (m *MeteringService) flushInProgress(ctx context.Context) {
	m.mu.Lock()
	timers := make([]*activeTimer, 0, len(m.timers))
	for _, t := range m.timers {
		timers = append(timers, t)
	}
	m.mu.Unlock()

	now := time.Now()
	for _, t := range timers {
		duration := now.Sub(t.startedAt)
		computeMinutes := duration.Minutes() * float64(t.vcpus)

		_, err := m.db.Exec(ctx,
			`INSERT INTO sandbox_usage_heartbeat
			 (vm_id, workspace_id, user_id, org_id, started_at, last_seen_at, duration_seconds, vcpus, memory_mb, compute_minutes)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			 ON CONFLICT (vm_id) DO UPDATE SET
			     last_seen_at = EXCLUDED.last_seen_at,
			     duration_seconds = EXCLUDED.duration_seconds,
			     compute_minutes = EXCLUDED.compute_minutes`,
			t.vmID, t.workspaceID, t.userID, t.orgID,
			t.startedAt, now,
			int64(duration.Seconds()),
			t.vcpus, t.memoryMB,
			computeMinutes,
		)
		if err != nil {
			m.logger.Error("failed to flush usage heartbeat",
				slog.String("vm_id", t.vmID),
				slog.String("error", err.Error()),
			)
		}
	}
}
