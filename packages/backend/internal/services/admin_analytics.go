package services

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/singleflight"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// AdminAnalyticsQuerier contains only named, sqlc-validated analytics queries.
type AdminAnalyticsQuerier interface {
	AnalyticsActivation(ctx context.Context, includeSynthetic bool) (db.AnalyticsActivationRow, error)
	AnalyticsAgents(ctx context.Context, arg db.AnalyticsAgentsParams) (db.AnalyticsAgentsRow, error)
	AnalyticsAgentsByStatus(ctx context.Context, arg db.AnalyticsAgentsByStatusParams) ([]db.AnalyticsAgentsByStatusRow, error)
	AnalyticsGoldenSnapshots(ctx context.Context, arg db.AnalyticsGoldenSnapshotsParams) ([]db.AnalyticsGoldenSnapshotsRow, error)
	AnalyticsImportFailures(ctx context.Context, arg db.AnalyticsImportFailuresParams) ([]db.AnalyticsImportFailuresRow, error)
	AnalyticsImportsByStatus(ctx context.Context, arg db.AnalyticsImportsByStatusParams) ([]db.AnalyticsImportsByStatusRow, error)
	AnalyticsImportsFailedByStage(ctx context.Context, arg db.AnalyticsImportsFailedByStageParams) ([]db.AnalyticsImportsFailedByStageRow, error)
	AnalyticsLanding(ctx context.Context, arg db.AnalyticsLandingParams) (db.AnalyticsLandingRow, error)
	AnalyticsLandingByState(ctx context.Context, arg db.AnalyticsLandingByStateParams) ([]db.AnalyticsLandingByStateRow, error)
	AnalyticsLandingCycle(ctx context.Context, arg db.AnalyticsLandingCycleParams) (float64, error)
	AnalyticsRepos(ctx context.Context, arg db.AnalyticsReposParams) (db.AnalyticsReposRow, error)
	AnalyticsSignupsByDay(ctx context.Context, arg db.AnalyticsSignupsByDayParams) ([]db.AnalyticsSignupsByDayRow, error)
	AnalyticsStuckAgents(ctx context.Context, arg db.AnalyticsStuckAgentsParams) ([]db.AnalyticsStuckAgentsRow, error)
	AnalyticsTopRepos(ctx context.Context, arg db.AnalyticsTopReposParams) ([]db.AnalyticsTopReposRow, error)
	AnalyticsUsers(ctx context.Context, arg db.AnalyticsUsersParams) (db.AnalyticsUsersRow, error)
	AnalyticsWorkspaceBoot(ctx context.Context, arg db.AnalyticsWorkspaceBootParams) (db.AnalyticsWorkspaceBootRow, error)
	AnalyticsWorkspaceFailures(ctx context.Context, arg db.AnalyticsWorkspaceFailuresParams) ([]db.AnalyticsWorkspaceFailuresRow, error)
	AnalyticsWorkspacesActive(ctx context.Context, includeSynthetic bool) (int64, error)
	AnalyticsWorkspacesByDay(ctx context.Context, arg db.AnalyticsWorkspacesByDayParams) ([]db.AnalyticsWorkspacesByDayRow, error)
	AnalyticsWorkspacesByKindStatus(ctx context.Context, arg db.AnalyticsWorkspacesByKindStatusParams) ([]db.AnalyticsWorkspacesByKindStatusRow, error)
}

type AnalyticsSummary struct {
	Range             string                           `json:"range"`
	GeneratedAt       time.Time                        `json:"generated_at"`
	SyntheticExcluded bool                             `json:"synthetic_excluded"`
	Users             AnalyticsUsers                   `json:"users"`
	Activation        AnalyticsActivation              `json:"activation"`
	Workspaces        AnalyticsWorkspaces              `json:"workspaces"`
	Agents            AnalyticsAgents                  `json:"agents"`
	Landing           AnalyticsLanding                 `json:"landing"`
	Imports           AnalyticsImports                 `json:"imports"`
	GoldenSnapshots   []db.AnalyticsGoldenSnapshotsRow `json:"golden_snapshots"`
	Repos             AnalyticsRepos                   `json:"repos"`
}
type AnalyticsUsers struct {
	db.AnalyticsUsersRow
	SignupsByDay []db.AnalyticsSignupsByDayRow `json:"signups_by_day"`
}
type AnalyticsActivation struct {
	Steps []AnalyticsActivationStep `json:"steps"`
}
type AnalyticsActivationStep struct {
	Key   string `json:"key"`
	Users int64  `json:"users"`
}
type AnalyticsWorkspaces struct {
	ByKindStatus []db.AnalyticsWorkspacesByKindStatusRow `json:"by_kind_status"`
	CreatedByDay []db.AnalyticsWorkspacesByDayRow        `json:"created_by_day"`
	FailureCodes []db.AnalyticsWorkspaceFailuresRow      `json:"failure_codes"`
	ActiveNow    int64                                   `json:"active_now"`
	db.AnalyticsWorkspaceBootRow
}
type AnalyticsAgents struct {
	db.AnalyticsAgentsRow
	ByStatus    []db.AnalyticsAgentsByStatusRow `json:"by_status"`
	StuckActive []AnalyticsStuckAgent           `json:"stuck_active"`
}
type AnalyticsStuckAgent struct {
	ID         string    `json:"id"`
	CreatedAt  time.Time `json:"created_at"`
	AgeSeconds int64     `json:"age_seconds"`
	User       string    `json:"user"`
	Repository string    `json:"repository"`
}
type AnalyticsLanding struct {
	ByState []db.AnalyticsLandingByStateRow `json:"by_state"`
	db.AnalyticsLandingRow
	CycleTimeP50Seconds float64 `json:"cycle_time_p50_seconds"`
}
type AnalyticsImports struct {
	ByStatus       []db.AnalyticsImportsByStatusRow      `json:"by_status"`
	FailureReasons []db.AnalyticsImportFailuresRow       `json:"failure_reasons"`
	FailedByStage  []db.AnalyticsImportsFailedByStageRow `json:"failed_by_stage"`
}
type AnalyticsRepos struct {
	db.AnalyticsReposRow
	Top []db.AnalyticsTopReposRow `json:"top"`
}

type analyticsCacheKey struct {
	rangeName        string
	includeSynthetic bool
}
type analyticsCacheEntry struct {
	data      []byte
	expiresAt time.Time
}

type AdminAnalyticsService struct {
	begin   func(context.Context) (pgx.Tx, error)
	queries AdminAnalyticsQuerier
	now     func() time.Time
	mu      sync.Mutex
	cache   map[analyticsCacheKey]analyticsCacheEntry
	flight  singleflight.Group
}

func NewAdminAnalyticsService(q AdminAnalyticsQuerier) *AdminAnalyticsService {
	return &AdminAnalyticsService{queries: q, now: time.Now, cache: make(map[analyticsCacheKey]analyticsCacheEntry)}
}

// NewAdminAnalyticsServiceWithPool uses a read-only repeatable-read snapshot so
// independently computed aggregates agree while writes continue. SET LOCAL
// bounds statements on the server as well as the service's overall deadline.
func NewAdminAnalyticsServiceWithPool(pool *pgxpool.Pool) *AdminAnalyticsService {
	s := NewAdminAnalyticsService(db.New(pool))
	s.begin = func(ctx context.Context) (pgx.Tx, error) {
		return pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	}
	return s
}

// AnalyticsRangeDays is shared by the HTTP boundary and service; callers outside
// HTTP receive the same allowlist validation. The handler defaults omission to 30d.
func AnalyticsRangeDays(rangeName string) (int, error) {
	switch rangeName {
	case "7d":
		return 7, nil
	case "30d":
		return 30, nil
	case "90d":
		return 90, nil
	default:
		return 0, pkgerrors.BadRequest("range must be 7d, 30d, or 90d")
	}
}

func (s *AdminAnalyticsService) cached(key analyticsCacheKey) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.cache[key]
	return entry.data, ok && s.now().Before(entry.expiresAt)
}

// Summary bounds the complete query batch (and thus each statement) to 20s.
// Six cache keys are possible. Singleflight coalesces concurrent misses, and
// JSON snapshots prevent a caller mutating slices retained by the cache.
func (s *AdminAnalyticsService) Summary(ctx context.Context, rangeName string, includeSynthetic bool) (AnalyticsSummary, error) {
	days, err := AnalyticsRangeDays(rangeName)
	if err != nil {
		return AnalyticsSummary{}, err
	}
	if err = ctx.Err(); err != nil {
		return AnalyticsSummary{}, err
	}
	key := analyticsCacheKey{rangeName, includeSynthetic}
	data, ok := s.cached(key)
	if !ok {
		flightKey := rangeName
		if includeSynthetic {
			flightKey += "/synthetic"
		}
		result := s.flight.DoChan(flightKey, func() (any, error) {
			if data, ok := s.cached(key); ok {
				return data, nil
			}
			queryCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
			defer cancel()
			summary, err := s.load(queryCtx, rangeName, days, includeSynthetic)
			if err != nil {
				return nil, pkgerrors.Internal("failed to load analytics summary")
			}
			data, err := json.Marshal(summary)
			if err != nil {
				return nil, pkgerrors.Internal("failed to encode analytics summary")
			}
			s.mu.Lock()
			s.cache[key] = analyticsCacheEntry{data: data, expiresAt: s.now().Add(60 * time.Second)}
			s.mu.Unlock()
			return data, nil
		})
		select {
		case <-ctx.Done():
			return AnalyticsSummary{}, ctx.Err()
		case r := <-result:
			if r.Err != nil {
				return AnalyticsSummary{}, r.Err
			}
			data = r.Val.([]byte)
		}
	}
	var summary AnalyticsSummary
	if err := json.Unmarshal(data, &summary); err != nil {
		return AnalyticsSummary{}, pkgerrors.Internal("failed to decode analytics summary")
	}
	return summary, nil
}

func analyticsNonNil[T any](rows []T) []T {
	if rows == nil {
		return []T{}
	}
	return rows
}

func (s *AdminAnalyticsService) load(ctx context.Context, rangeName string, days int, includeSynthetic bool) (AnalyticsSummary, error) {
	queries := s.queries
	var tx pgx.Tx
	if s.begin != nil {
		var err error
		tx, err = s.begin(ctx)
		if err != nil {
			return AnalyticsSummary{}, err
		}
		defer func() {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			_ = tx.Rollback(cleanup)
		}()
		snapshot := db.New(tx)
		if err := snapshot.AnalyticsStatementTimeout(ctx); err != nil {
			return AnalyticsSummary{}, err
		}
		queries = snapshot
	}

	end := s.now().UTC()
	// Exactly N UTC calendar dates, including the current partial day.
	start := time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1-days)
	out := AnalyticsSummary{Range: rangeName, GeneratedAt: end, SyntheticExcluded: !includeSynthetic}
	analyticsActivation, err := queries.AnalyticsActivation(ctx, includeSynthetic)
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Activation.Steps = []AnalyticsActivationStep{{"signup", analyticsActivation.Signup}, {"github_connected", analyticsActivation.GithubConnected}, {"first_repo", analyticsActivation.FirstRepo}, {"workspace_booted", analyticsActivation.WorkspaceBooted}, {"first_agent_run", analyticsActivation.FirstAgentRun}, {"first_landing_merged", analyticsActivation.FirstLandingMerged}}
	analyticsAgents, err := queries.AnalyticsAgents(ctx, db.AnalyticsAgentsParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Agents.AnalyticsAgentsRow = analyticsAgents
	analyticsAgentsByStatus, err := queries.AnalyticsAgentsByStatus(ctx, db.AnalyticsAgentsByStatusParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Agents.ByStatus = analyticsNonNil(analyticsAgentsByStatus)
	analyticsGoldenSnapshots, err := queries.AnalyticsGoldenSnapshots(ctx, db.AnalyticsGoldenSnapshotsParams{RangeStart: start, RangeEnd: end})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.GoldenSnapshots = analyticsNonNil(analyticsGoldenSnapshots)
	analyticsImportFailures, err := queries.AnalyticsImportFailures(ctx, db.AnalyticsImportFailuresParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Imports.FailureReasons = analyticsNonNil(analyticsImportFailures)
	analyticsImportsByStatus, err := queries.AnalyticsImportsByStatus(ctx, db.AnalyticsImportsByStatusParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Imports.ByStatus = analyticsNonNil(analyticsImportsByStatus)
	analyticsImportsFailedByStage, err := queries.AnalyticsImportsFailedByStage(ctx, db.AnalyticsImportsFailedByStageParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Imports.FailedByStage = analyticsNonNil(analyticsImportsFailedByStage)
	analyticsLanding, err := queries.AnalyticsLanding(ctx, db.AnalyticsLandingParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Landing.AnalyticsLandingRow = analyticsLanding
	analyticsLandingByState, err := queries.AnalyticsLandingByState(ctx, db.AnalyticsLandingByStateParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Landing.ByState = analyticsNonNil(analyticsLandingByState)
	analyticsLandingCycle, err := queries.AnalyticsLandingCycle(ctx, db.AnalyticsLandingCycleParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Landing.CycleTimeP50Seconds = analyticsLandingCycle
	analyticsRepos, err := queries.AnalyticsRepos(ctx, db.AnalyticsReposParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Repos.AnalyticsReposRow = analyticsRepos
	analyticsSignupsByDay, err := queries.AnalyticsSignupsByDay(ctx, db.AnalyticsSignupsByDayParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Users.SignupsByDay = analyticsNonNil(analyticsSignupsByDay)
	analyticsStuckAgents, err := queries.AnalyticsStuckAgents(ctx, db.AnalyticsStuckAgentsParams{RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Agents.StuckActive = make([]AnalyticsStuckAgent, 0, len(analyticsStuckAgents))
	for _, a := range analyticsStuckAgents {
		out.Agents.StuckActive = append(out.Agents.StuckActive, AnalyticsStuckAgent{ID: a.ID, CreatedAt: a.CreatedAt.UTC(), AgeSeconds: a.AgeSeconds, User: a.Username, Repository: a.Repository})
	}
	analyticsTopRepos, err := queries.AnalyticsTopRepos(ctx, db.AnalyticsTopReposParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Repos.Top = analyticsNonNil(analyticsTopRepos)
	analyticsUsers, err := queries.AnalyticsUsers(ctx, db.AnalyticsUsersParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Users.AnalyticsUsersRow = analyticsUsers
	analyticsWorkspaceBoot, err := queries.AnalyticsWorkspaceBoot(ctx, db.AnalyticsWorkspaceBootParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Workspaces.AnalyticsWorkspaceBootRow = analyticsWorkspaceBoot
	analyticsWorkspaceFailures, err := queries.AnalyticsWorkspaceFailures(ctx, db.AnalyticsWorkspaceFailuresParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Workspaces.FailureCodes = analyticsNonNil(analyticsWorkspaceFailures)
	analyticsWorkspacesActive, err := queries.AnalyticsWorkspacesActive(ctx, includeSynthetic)
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Workspaces.ActiveNow = analyticsWorkspacesActive
	analyticsWorkspacesByDay, err := queries.AnalyticsWorkspacesByDay(ctx, db.AnalyticsWorkspacesByDayParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Workspaces.CreatedByDay = analyticsNonNil(analyticsWorkspacesByDay)
	analyticsWorkspacesByKindStatus, err := queries.AnalyticsWorkspacesByKindStatus(ctx, db.AnalyticsWorkspacesByKindStatusParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
	if err != nil {
		return AnalyticsSummary{}, err
	}
	out.Workspaces.ByKindStatus = analyticsNonNil(analyticsWorkspacesByKindStatus)
	if tx != nil {
		if err := tx.Commit(ctx); err != nil {
			return AnalyticsSummary{}, err
		}
	}
	return out, nil
}
