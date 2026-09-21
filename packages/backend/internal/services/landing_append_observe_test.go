package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

func TestLandingAppendObservationRequiresExactNativeReceipt(t *testing.T) {
	for _, tc := range []struct {
		name, task string
		receipt    bool
		hostErr    error
		want       string
		errorText  string
	}{
		{name: "pending", task: "append_pending", want: "pending"},
		{name: "running", task: "running", want: "running"},
		{name: "failed", task: "failed", want: "failed"},
		{name: "lost worker ACK", task: "running", receipt: true, want: "landed"},
		{name: "moved main after completion", task: "done", receipt: true, want: "landed"},
		{name: "SQL done is not proof", task: "done", errorText: "no matching native receipt"},
		{name: "old API404", task: "append_pending", hostErr: &repohost.StatusError{StatusCode: 404}, errorText: "could not be verified"},
		{name: "native auth refusal", task: "running", hostErr: &repohost.StatusError{StatusCode: 403}, errorText: "could not be verified"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := appendFixture()
			raw, err := json.Marshal(request)
			require.NoError(t, err)
			repository := landingRepo(nil)
			q := &mockLandingQuerier{
				getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return repository, nil
				},
				getLandingRequestWithChangeIDsByNumberFn: func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
					return landingDBRequestWithChangeIDs(88, repository.ID, 1, 1, []string{"native"}), nil
				},
				getLandingTaskByLandingRequestIDFn: func(context.Context, int64) (db.LandingTask, error) {
					return db.LandingTask{ID: 9, Status: tc.task, AppendRequest: raw}, nil
				},
			}
			rh := &mockLandingRepoHostClient{landChangesFn: func(_ context.Context, _, _ string, r repohost.LandRequest) (repohost.LandResult, error) {
				require.True(t, r.LookupOnly)
				r.LookupOnly = false
				require.Equal(t, request, r)
				if tc.hostErr != nil {
					return repohost.LandResult{}, tc.hostErr
				}
				if !tc.receipt {
					return repohost.LandResult{}, &repohost.StatusError{StatusCode: 404, Code: "landing_receipt_missing"}
				}
				return repohost.LandResult{LandedCount: 1, TargetBookmark: "main", TargetCommitID: strings.Repeat("e", 40)}, nil
			}}
			result, err := NewLandingService(q, rh).ObserveLandingAppend(context.Background(), landingTestUser(1, "alice"), "alice", "demo", 1)
			if tc.errorText != "" {
				require.ErrorContains(t, err, tc.errorText)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.want, result.Status)
			require.Equal(t, tc.receipt, result.Result != nil)
		})
	}
}
func TestLandingAppendObservationMissingTaskIsTyped(t *testing.T) {
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return landingRepo(nil), nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(88, 77, 1, 1, []string{"native"}), nil
		},
		getLandingTaskByLandingRequestIDFn: func(context.Context, int64) (db.LandingTask, error) { return db.LandingTask{}, pgx.ErrNoRows }}
	_, err := NewLandingService(q, &mockLandingRepoHostClient{}).ObserveLandingAppend(context.Background(), landingTestUser(1, "alice"), "alice", "demo", 1)
	require.ErrorContains(t, err, "not been queued")
}
