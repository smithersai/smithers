package clusterservices

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterdb"
)

type fakeCanaryReports struct {
	upserts               []clusterdb.UpsertCanaryResultParams
	resolves              []clusterdb.ResolveCanaryAlertIncidentsParams
	upsertErr, resolveErr error
}

func (q *fakeCanaryReports) UpsertCanaryResult(_ context.Context, p clusterdb.UpsertCanaryResultParams) (clusterdb.CanaryResult, error) {
	q.upserts = append(q.upserts, p)
	return clusterdb.CanaryResult{}, q.upsertErr
}
func (q *fakeCanaryReports) ResolveCanaryAlertIncidents(_ context.Context, p clusterdb.ResolveCanaryAlertIncidentsParams) (int64, error) {
	q.resolves = append(q.resolves, p)
	return 1, q.resolveErr
}

func TestCanaryIncidentConditionMatchesReporters(t *testing.T) {
	for _, tc := range []struct{ suite, condition, path string }{
		{"workflow", "Backend canary probe failing", ".smithers/workflows/canary-runner.ts"},
		{"playwright", "Playwright canary test failing", "e2e/scripts/run-canary.ts"},
	} {
		t.Run(tc.suite, func(t *testing.T) {
			require.Equal(t, tc.condition, CanaryIncidentCondition(tc.suite))
			root := os.Getenv("SMITHERS_CLUSTER_SOURCE_ROOT")
			if root == "" {
				t.Skip("set SMITHERS_CLUSTER_SOURCE_ROOT to verify private deployment reporters")
			}
			source, err := os.ReadFile(filepath.Join(root, tc.path))
			require.NoError(t, err)
			require.Contains(t, string(source), `"`+tc.condition+`"`)
		})
	}
	require.Empty(t, CanaryIncidentCondition("unknown"))
}
func TestCanaryReportAutoResolve(t *testing.T) {
	for _, suite := range []string{"workflow", "playwright", "unknown"} {
		for _, failure := range []bool{false, true} {
			t.Run(suite+map[bool]string{true: " failure", false: " success"}[failure], func(t *testing.T) {
				q := &fakeCanaryReports{}
				results := []CanaryReportResult{{Test: "first", Status: "success"}, {Test: "second", Status: "SUCCESS"}}
				if failure {
					results[1].Status = "failure"
				}
				err := NewCanaryReportService(q).ReportResults(context.Background(), CanaryReportInput{Suite: " " + suite + " ", RunID: " run-1 ", Results: results}, time.Now())
				require.NoError(t, err)
				require.Len(t, q.upserts, 2)
				if failure || suite == "unknown" {
					require.Empty(t, q.resolves)
				} else {
					require.Len(t, q.resolves, 1)
					require.Equal(t, CanaryIncidentCondition(suite), q.resolves[0].ConditionName)
					require.Equal(t, "canary:run-1", q.resolves[0].ResolvedBy.String)
				}
			})
		}
	}
}
func TestCanaryReportValidationBeforeWrites(t *testing.T) {
	for _, bad := range []CanaryReportResult{{Status: "success"}, {Test: "bad", Status: "skipped"}, {Test: "bad", Status: "success", DurationSeconds: -1}, {Test: "bad", Status: "success", DurationSeconds: math.Inf(1)}} {
		q := &fakeCanaryReports{}
		err := NewCanaryReportService(q).ReportResults(context.Background(), CanaryReportInput{Suite: "workflow", Results: []CanaryReportResult{{Test: "good", Status: "success"}, bad}}, time.Now())
		require.Error(t, err)
		require.Empty(t, q.upserts)
		require.Empty(t, q.resolves)
	}
	for _, in := range []CanaryReportInput{{}, {Suite: "workflow"}} {
		q := &fakeCanaryReports{}
		require.Error(t, NewCanaryReportService(q).ReportResults(context.Background(), in, time.Now()))
		require.Empty(t, q.resolves)
	}
	for _, q := range []*fakeCanaryReports{{upsertErr: requireError()}, {resolveErr: requireError()}} {
		require.Error(t, NewCanaryReportService(q).ReportResults(context.Background(), CanaryReportInput{Suite: "workflow", Results: []CanaryReportResult{{Test: "good", Status: "success"}}}, time.Now()))
	}
}
