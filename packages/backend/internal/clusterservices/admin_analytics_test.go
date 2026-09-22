package clusterservices

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
	"github.com/smithersai/smithers/packages/backend/internal/deploymentdb"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type fakeAnalyticsQuerier struct {
	call  func(context.Context, string, any) error
	users db.AnalyticsUsersRow
}

func (f *fakeAnalyticsQuerier) AnalyticsActivation(ctx context.Context, includeSynthetic bool) (db.AnalyticsActivationRow, error) {
	var zero db.AnalyticsActivationRow
	return zero, f.call(ctx, "AnalyticsActivation", includeSynthetic)
}
func (f *fakeAnalyticsQuerier) AnalyticsAgents(ctx context.Context, arg db.AnalyticsAgentsParams) (db.AnalyticsAgentsRow, error) {
	var zero db.AnalyticsAgentsRow
	return zero, f.call(ctx, "AnalyticsAgents", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsAgentsByStatus(ctx context.Context, arg db.AnalyticsAgentsByStatusParams) ([]db.AnalyticsAgentsByStatusRow, error) {
	var zero []db.AnalyticsAgentsByStatusRow
	return zero, f.call(ctx, "AnalyticsAgentsByStatus", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsGoldenSnapshots(ctx context.Context, arg clusterdb.AnalyticsGoldenSnapshotsParams) ([]clusterdb.AnalyticsGoldenSnapshotsRow, error) {
	var zero []clusterdb.AnalyticsGoldenSnapshotsRow
	return zero, f.call(ctx, "AnalyticsGoldenSnapshots", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsImportFailures(ctx context.Context, arg db.AnalyticsImportFailuresParams) ([]db.AnalyticsImportFailuresRow, error) {
	var zero []db.AnalyticsImportFailuresRow
	return zero, f.call(ctx, "AnalyticsImportFailures", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsImportsByStatus(ctx context.Context, arg db.AnalyticsImportsByStatusParams) ([]db.AnalyticsImportsByStatusRow, error) {
	var zero []db.AnalyticsImportsByStatusRow
	return zero, f.call(ctx, "AnalyticsImportsByStatus", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsImportsFailedByStage(ctx context.Context, arg db.AnalyticsImportsFailedByStageParams) ([]db.AnalyticsImportsFailedByStageRow, error) {
	var zero []db.AnalyticsImportsFailedByStageRow
	return zero, f.call(ctx, "AnalyticsImportsFailedByStage", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsLanding(ctx context.Context, arg db.AnalyticsLandingParams) (db.AnalyticsLandingRow, error) {
	var zero db.AnalyticsLandingRow
	return zero, f.call(ctx, "AnalyticsLanding", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsLandingByState(ctx context.Context, arg db.AnalyticsLandingByStateParams) ([]db.AnalyticsLandingByStateRow, error) {
	var zero []db.AnalyticsLandingByStateRow
	return zero, f.call(ctx, "AnalyticsLandingByState", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsLandingCycle(ctx context.Context, arg db.AnalyticsLandingCycleParams) (float64, error) {
	var zero float64
	return zero, f.call(ctx, "AnalyticsLandingCycle", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsRepos(ctx context.Context, arg db.AnalyticsReposParams) (db.AnalyticsReposRow, error) {
	var zero db.AnalyticsReposRow
	return zero, f.call(ctx, "AnalyticsRepos", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsSignupsByDay(ctx context.Context, arg db.AnalyticsSignupsByDayParams) ([]db.AnalyticsSignupsByDayRow, error) {
	var zero []db.AnalyticsSignupsByDayRow
	return zero, f.call(ctx, "AnalyticsSignupsByDay", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsStuckAgents(ctx context.Context, arg db.AnalyticsStuckAgentsParams) ([]db.AnalyticsStuckAgentsRow, error) {
	var zero []db.AnalyticsStuckAgentsRow
	return zero, f.call(ctx, "AnalyticsStuckAgents", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsTopRepos(ctx context.Context, arg db.AnalyticsTopReposParams) ([]db.AnalyticsTopReposRow, error) {
	var zero []db.AnalyticsTopReposRow
	return zero, f.call(ctx, "AnalyticsTopRepos", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsUsers(ctx context.Context, arg db.AnalyticsUsersParams) (db.AnalyticsUsersRow, error) {
	return f.users, f.call(ctx, "AnalyticsUsers", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsWorkspaceBoot(ctx context.Context, arg db.AnalyticsWorkspaceBootParams) (db.AnalyticsWorkspaceBootRow, error) {
	var zero db.AnalyticsWorkspaceBootRow
	return zero, f.call(ctx, "AnalyticsWorkspaceBoot", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsWorkspaceFailures(ctx context.Context, arg db.AnalyticsWorkspaceFailuresParams) ([]db.AnalyticsWorkspaceFailuresRow, error) {
	var zero []db.AnalyticsWorkspaceFailuresRow
	return zero, f.call(ctx, "AnalyticsWorkspaceFailures", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsWorkspacesActive(ctx context.Context, includeSynthetic bool) (int64, error) {
	var zero int64
	return zero, f.call(ctx, "AnalyticsWorkspacesActive", includeSynthetic)
}
func (f *fakeAnalyticsQuerier) AnalyticsWorkspacesByDay(ctx context.Context, arg db.AnalyticsWorkspacesByDayParams) ([]db.AnalyticsWorkspacesByDayRow, error) {
	var zero []db.AnalyticsWorkspacesByDayRow
	return zero, f.call(ctx, "AnalyticsWorkspacesByDay", arg)
}
func (f *fakeAnalyticsQuerier) AnalyticsWorkspacesByKindStatus(ctx context.Context, arg db.AnalyticsWorkspacesByKindStatusParams) ([]db.AnalyticsWorkspacesByKindStatusRow, error) {
	var zero []db.AnalyticsWorkspacesByKindStatusRow
	return zero, f.call(ctx, "AnalyticsWorkspacesByKindStatus", arg)
}
func TestAdminAnalyticsServiceCacheAndRanges(t *testing.T) {
	now := time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC)
	calls := 0
	wantDays := 7
	wantSynthetic := false
	fake := &fakeAnalyticsQuerier{users: db.AnalyticsUsersRow{Total: 3, Human: 2, Synthetic: 1}, call: func(ctx context.Context, name string, arg any) error {
		calls++
		deadline, ok := ctx.Deadline()
		require.True(t, ok)
		require.InDelta(t, 20, time.Until(deadline).Seconds(), 1)
		v := reflect.ValueOf(arg)
		if v.Kind() == reflect.Bool {
			require.Equal(t, wantSynthetic, v.Bool())
			return nil
		}
		if field := v.FieldByName("RangeStart"); field.IsValid() {
			require.Equal(t, time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1-wantDays), field.Interface())
		}
		if field := v.FieldByName("RangeEnd"); field.IsValid() {
			require.Equal(t, now, field.Interface())
		}
		if field := v.FieldByName("IncludeSynthetic"); field.IsValid() {
			require.Equal(t, wantSynthetic, field.Bool())
		}
		return nil
	}}
	svc := NewAdminAnalyticsService(fake)
	svc.now = func() time.Time { return now }
	first, err := svc.Summary(context.Background(), "7d", false)
	require.NoError(t, err)
	require.Equal(t, int64(3), first.Users.Total)
	require.Len(t, first.Activation.Steps, 6)
	require.Equal(t, "first_landing_merged", first.Activation.Steps[5].Key)
	batch := calls
	require.Equal(t, 20, batch)
	first.Activation.Steps[0].Key = "mutated"
	cached, err := svc.Summary(context.Background(), "7d", false)
	require.NoError(t, err)
	require.Equal(t, batch, calls)
	require.Equal(t, "signup", cached.Activation.Steps[0].Key)
	data, err := json.Marshal(cached)
	require.NoError(t, err)
	require.NotContains(t, string(data), "null")
	for _, bad := range []string{"", "1d", "7D", " 7d"} {
		_, err := svc.Summary(context.Background(), bad, false)
		require.Error(t, err)
	}
	require.Equal(t, batch, calls)
	wantSynthetic = true
	included, err := svc.Summary(context.Background(), "7d", true)
	require.NoError(t, err)
	require.False(t, included.SyntheticExcluded)
	require.Equal(t, 2*batch, calls)
	wantSynthetic = false
	for _, days := range []struct {
		name string
		n    int
	}{{"30d", 30}, {"90d", 90}} {
		wantDays = days.n
		_, err = svc.Summary(context.Background(), days.name, false)
		require.NoError(t, err)
	}
	require.Equal(t, 4*batch, calls)
	now = now.Add(60 * time.Second)
	wantDays = 7
	fresh, err := svc.Summary(context.Background(), "7d", false)
	require.NoError(t, err)
	require.Equal(t, 5*batch, calls)
	require.Equal(t, now, fresh.GeneratedAt)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = svc.Summary(ctx, "7d", false)
	require.ErrorIs(t, err, context.Canceled)
}
func TestAdminAnalyticsServiceQueryErrorsNotCached(t *testing.T) {
	names := []string{"AnalyticsActivation", "AnalyticsAgents", "AnalyticsAgentsByStatus", "AnalyticsGoldenSnapshots", "AnalyticsImportFailures", "AnalyticsImportsByStatus", "AnalyticsImportsFailedByStage", "AnalyticsLanding", "AnalyticsLandingByState", "AnalyticsLandingCycle", "AnalyticsRepos", "AnalyticsSignupsByDay", "AnalyticsStuckAgents", "AnalyticsTopRepos", "AnalyticsUsers", "AnalyticsWorkspaceBoot", "AnalyticsWorkspaceFailures", "AnalyticsWorkspacesActive", "AnalyticsWorkspacesByDay", "AnalyticsWorkspacesByKindStatus"}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			failing := true
			calls := 0
			fake := &fakeAnalyticsQuerier{call: func(ctx context.Context, n string, arg any) error {
				calls++
				if failing && n == name {
					return errors.New("database unavailable")
				}
				return nil
			}}
			svc := NewAdminAnalyticsService(fake)
			_, err := svc.Summary(context.Background(), "30d", false)
			require.Error(t, err)
			firstCalls := calls
			failing = false
			_, err = svc.Summary(context.Background(), "30d", false)
			require.NoError(t, err)
			require.Equal(t, firstCalls+len(names), calls)
		})
	}
}
func TestAdminAnalyticsServiceConcurrentMissAndWaiterCancellation(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	fake := &fakeAnalyticsQuerier{call: func(ctx context.Context, name string, arg any) error {
		if name == "AnalyticsActivation" {
			close(entered)
			<-release
		}
		return nil
	}}
	svc := NewAdminAnalyticsService(fake)
	go func() { _, err := svc.Summary(context.Background(), "7d", false); done <- err }()
	<-entered
	ctx, cancel := context.WithCancel(context.Background())
	waiter := make(chan error, 1)
	go func() { _, err := svc.Summary(ctx, "7d", false); waiter <- err }()
	cancel()
	require.ErrorIs(t, <-waiter, context.Canceled)
	close(release)
	require.NoError(t, <-done)
	_, err := svc.Summary(context.Background(), "7d", false)
	require.NoError(t, err)
}

func TestAdminAnalyticsPoolSnapshot(t *testing.T) {
	pool := setupTestPool(t)
	svc := NewAdminAnalyticsServiceWithPool(pool)
	for _, rangeName := range []string{"7d", "30d", "90d"} {
		for _, include := range []bool{false, true} {
			result, err := svc.Summary(context.Background(), rangeName, include)
			require.NoError(t, err)
			require.Equal(t, !include, result.SyntheticExcluded)
			days, _ := AnalyticsRangeDays(rangeName)
			require.Len(t, result.Users.SignupsByDay, days)
			require.Len(t, result.Workspaces.CreatedByDay, days)
		}
	}
	// A new transaction receives the server-side statement timeout only locally.
	tx, err := svc.begin(context.Background())
	require.NoError(t, err)
	defer tx.Rollback(context.Background())
	require.NoError(t, deploymentdb.New(tx).AnalyticsStatementTimeout(context.Background()))
	var timeout, readOnly, isolation string
	require.NoError(t, tx.QueryRow(context.Background(), "SELECT current_setting('statement_timeout'),current_setting('transaction_read_only'),current_setting('transaction_isolation')").Scan(&timeout, &readOnly, &isolation))
	require.Equal(t, "20s", timeout)
	require.Equal(t, "on", readOnly)
	require.Equal(t, "repeatable read", isolation)
}

// Done is consulted by Summary's select after the caller joins singleflight.
type analyticsObservedWaitContext struct {
	context.Context
	waiting chan struct{}
}

func (c analyticsObservedWaitContext) Done() <-chan struct{} {
	close(c.waiting)
	return c.Context.Done()
}

func TestAdminAnalyticsServiceInitiatorCancellationKeepsSharedQuery(t *testing.T) {
	entered := make(chan context.Context, 1)
	release := make(chan struct{})
	calls := 0
	fake := &fakeAnalyticsQuerier{users: db.AnalyticsUsersRow{Total: 42}, call: func(ctx context.Context, name string, arg any) error {
		calls++
		if name == "AnalyticsActivation" {
			entered <- ctx
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-release:
			}
		}
		return ctx.Err()
	}}
	svc := NewAdminAnalyticsService(fake)
	initiator, cancel := context.WithCancel(context.Background())
	defer cancel()
	first := make(chan error, 1)
	go func() { _, err := svc.Summary(initiator, "7d", false); first <- err }()
	queryCtx := <-entered
	waiterCtx, stopWaiter := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopWaiter()
	waiting := make(chan struct{})
	type response struct {
		summary AnalyticsSummary
		err     error
	}
	second := make(chan response, 1)
	go func() {
		summary, err := svc.Summary(analyticsObservedWaitContext{Context: waiterCtx, waiting: waiting}, "7d", false)
		second <- response{summary, err}
	}()
	<-waiting
	cancel()
	require.ErrorIs(t, <-first, context.Canceled)
	queryErr := queryCtx.Err()
	close(release)
	result := <-second
	require.NoError(t, queryErr, "initiator cancellation must not cancel the shared batch")
	require.NoError(t, result.err)
	require.Equal(t, int64(42), result.summary.Users.Total)
	cached, err := svc.Summary(context.Background(), "7d", false)
	require.NoError(t, err)
	require.Equal(t, result.summary, cached)
	require.Equal(t, 20, calls, "waiter and cached request reuse one query batch")
}
