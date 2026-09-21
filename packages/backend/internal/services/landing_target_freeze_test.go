package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A landing request's merge target must be frozen once it is enqueued. The
// required-approval gate is evaluated against target_bookmark at enqueue time, so
// allowing a writer to change target_bookmark/source_bookmark while queued would
// let them redirect an approved land onto a protected bookmark that never
// received the required approvals (TOCTOU authz bypass).
func TestLandingService_UpdateLandingRequest_FreezesTargetAfterEnqueue(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(1, "owner")
	repo := landingRepo(nil)
	repo.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}

	querierForState := func(state string) *mockLandingQuerier {
		return &mockLandingQuerier{
			getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repo, nil
			},
			getLandingRequestWithChangeIDsByNumberFn: func(ctx context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
				row := landingDBRequestWithChangeIDs(5, repo.ID, arg.Number, actor.ID, []string{"k1"})
				row.State = state
				return row, nil
			},
			updateLandingRequestFn: func(ctx context.Context, arg db.UpdateLandingRequestParams) (db.LandingRequest, error) {
				row := landingDBRequest(arg.ID, repo.ID, 7, actor.ID, nil)
				row.State = arg.State
				row.TargetBookmark = arg.TargetBookmark
				return row, nil
			},
			getUserByIDFn: func(ctx context.Context, id int64) (db.User, error) {
				return db.User{ID: id, Username: "alice", LowerUsername: "alice"}, nil
			},
		}
	}

	// Default fixture target is "main"; "release" is a real change that must be
	// rejected with 409 once the request has left the open/failed editable states.
	for _, state := range []string{"queued", "landing", "merged"} {
		t.Run("rejects target change while "+state, func(t *testing.T) {
			q := querierForState(state)
			svc := NewLandingService(q, &mockLandingRepoHostClient{})
			_, err := svc.UpdateLandingRequest(context.Background(), actor, "alice", "demo", 7, UpdateLandingRequestInput{
				TargetBookmark: landingStringPtr("release"),
			})
			assert.Equal(t, 409, landingAPIStatus(t, err))
		})
	}

	t.Run("allows a no-op target re-send while queued", func(t *testing.T) {
		q := querierForState("queued")
		svc := NewLandingService(q, &mockLandingRepoHostClient{})
		_, err := svc.UpdateLandingRequest(context.Background(), actor, "alice", "demo", 7, UpdateLandingRequestInput{
			TargetBookmark: landingStringPtr("main"),
		})
		assert.NoError(t, err)
	})
}
