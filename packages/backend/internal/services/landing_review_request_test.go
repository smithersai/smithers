package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

func TestLandingService_CreateLandingReviewRequest_Human(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(5, "alice")
	reviewer := landingTestUser(6, "bob")
	repo := landingRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})
	landing := landingDBRequestWithChangeIDs(21, repo.ID, 7, actor.ID, []string{"change-1"})
	var storedArg db.CreateLandingReviewRequestParams
	var stored db.LandingReviewRequest
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landing, nil
		},
		getUserByLowerUsernameFn: func(_ context.Context, login string) (db.User, error) {
			assert.Equal(t, "bob", login)
			return *reviewer, nil
		},
		getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
			switch id {
			case actor.ID:
				return *actor, nil
			case reviewer.ID:
				return *reviewer, nil
			default:
				return db.User{}, pgx.ErrNoRows
			}
		},
		createLandingReviewRequestFn: func(_ context.Context, arg db.CreateLandingReviewRequestParams) (db.LandingReviewRequest, error) {
			storedArg = arg
			stored = db.LandingReviewRequest{
				ID:               44,
				LandingRequestID: arg.LandingRequestID,
				RequestedBy:      arg.RequestedBy,
				ReviewerID:       arg.ReviewerID,
				State:            "requested",
				CreatedAt:        time.Now().UTC(),
			}
			return stored, nil
		},
		listLandingReviewRequestsFn: func(_ context.Context, landingRequestID int64) ([]db.LandingReviewRequest, error) {
			assert.Equal(t, landing.ID, landingRequestID)
			return []db.LandingReviewRequest{stored}, nil
		},
		updateLandingRequestTurnFn: func(_ context.Context, arg db.UpdateLandingRequestTurnParams) (db.LandingRequest, error) {
			assert.Equal(t, landing.ID, arg.ID)
			assert.Equal(t, "reviewer", arg.TurnParty)
			assert.Equal(t, "request", arg.TurnReason)
			assert.Equal(t, "5", arg.TurnActorID)
			landing.TurnParty = arg.TurnParty
			landing.TurnActorID = arg.TurnActorID
			landing.TurnReason = arg.TurnReason
			landing.TurnSince = time.Now().UTC()
			return landingRecordFromRow(landing), nil
		},
	}

	var notificationArg db.CreateNotificationParams
	notifications := NewNotificationService(&mockNotificationQuerier{
		createFn: func(_ context.Context, arg db.CreateNotificationParams) (db.Notification, error) {
			notificationArg = arg
			return db.Notification{
				ID: 1, UserID: arg.UserID, SourceType: arg.SourceType, SourceID: arg.SourceID,
				Subject: arg.Subject, Body: arg.Body, Status: "unread", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
			}, nil
		},
	})
	dispatcher := &mockLandingDispatcher{}
	svc := NewLandingService(q, &mockLandingRepoHostClient{},
		WithLandingNotificationService(notifications),
		WithLandingWebhookDispatcher(dispatcher),
	)

	created, err := svc.CreateLandingReviewRequest(context.Background(), actor, "alice", "demo", 7, CreateLandingReviewRequestInput{Reviewer: " Bob "})
	require.NoError(t, err)

	assert.Equal(t, landing.ID, storedArg.LandingRequestID)
	assert.Equal(t, actor.ID, storedArg.RequestedBy)
	assert.Equal(t, reviewer.ID, storedArg.ReviewerID.Int64)
	assert.Empty(t, storedArg.AgentName)
	assert.Equal(t, int64(44), created.ID)
	assert.Equal(t, "alice", created.RequestedBy.Login)
	require.NotNil(t, created.Reviewer)
	assert.Equal(t, "bob", created.Reviewer.Login)
	assert.Equal(t, "requested", created.State)

	assert.Equal(t, reviewer.ID, notificationArg.UserID)
	assert.Equal(t, "landing", notificationArg.SourceType)
	assert.Equal(t, landing.ID, notificationArg.SourceID.Int64)
	assert.Contains(t, notificationArg.Subject, "@alice requested your review")

	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, webhooks.EventTypeLandingRequest, dispatcher.calls[0].eventType)
	payload, ok := dispatcher.calls[0].payload.(webhooks.LandingRequestEventPayload)
	require.True(t, ok)
	assert.Equal(t, "review_requested", payload.Action)

	got, err := svc.GetLandingRequest(context.Background(), actor, "alice", "demo", 7)
	require.NoError(t, err)
	require.Len(t, got.ReviewRequests, 1)
	assert.Equal(t, int64(44), got.ReviewRequests[0].ID)
	assert.Equal(t, "bob", got.ReviewRequests[0].Reviewer.Login)
}

func TestLandingService_CreateLandingReviewRequest_AgentAndValidation(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(5, "alice")
	repo := landingRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true} })
	landing := landingDBRequestWithChangeIDs(21, repo.ID, 7, actor.ID, []string{"change-1"})
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) { return repo, nil },
		getLandingRequestWithChangeIDsByNumberFn: func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landing, nil
		},
		getUserByIDFn: func(_ context.Context, id int64) (db.User, error) { return *actor, nil },
		createLandingReviewRequestFn: func(_ context.Context, arg db.CreateLandingReviewRequestParams) (db.LandingReviewRequest, error) {
			return db.LandingReviewRequest{ID: 9, LandingRequestID: arg.LandingRequestID, RequestedBy: arg.RequestedBy, AgentName: pgtype.Text{String: arg.AgentName, Valid: true}, State: "requested", CreatedAt: time.Now().UTC()}, nil
		},
		updateLandingRequestTurnFn: func(_ context.Context, arg db.UpdateLandingRequestTurnParams) (db.LandingRequest, error) {
			return landingRecordFromRow(landing), nil
		},
	}
	svc := NewLandingService(q, &mockLandingRepoHostClient{})

	created, err := svc.CreateLandingReviewRequest(context.Background(), actor, "alice", "demo", 7, CreateLandingReviewRequestInput{Agent: "security-reviewer"})
	require.NoError(t, err)
	assert.Equal(t, "security-reviewer", created.Agent)
	assert.Nil(t, created.Reviewer)

	for _, input := range []CreateLandingReviewRequestInput{{}, {Reviewer: "bob", Agent: "agent"}} {
		_, err := svc.CreateLandingReviewRequest(context.Background(), actor, "alice", "demo", 7, input)
		assert.Equal(t, 422, landingAPIStatus(t, err))
	}

	q.createLandingReviewRequestFn = func(context.Context, db.CreateLandingReviewRequestParams) (db.LandingReviewRequest, error) {
		return db.LandingReviewRequest{}, &pgconn.PgError{Code: "23505", ConstraintName: "uq_landing_review_requests_requested_agent"}
	}
	_, err = svc.CreateLandingReviewRequest(context.Background(), actor, "alice", "demo", 7, CreateLandingReviewRequestInput{Agent: "security-reviewer"})
	assert.Equal(t, 409, landingAPIStatus(t, err))
}

func TestLandingService_DismissLandingReviewRequest(t *testing.T) {
	t.Parallel()

	actor := landingTestUser(5, "alice")
	repo := landingRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true} })
	landing := landingDBRequestWithChangeIDs(21, repo.ID, 7, actor.ID, []string{"change-1"})
	q := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) { return repo, nil },
		getLandingRequestWithChangeIDsByNumberFn: func(context.Context, db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landing, nil
		},
		dismissLandingReviewRequestFn: func(_ context.Context, arg db.DismissLandingReviewRequestParams) (db.LandingReviewRequest, error) {
			assert.Equal(t, int64(12), arg.ID)
			assert.Equal(t, landing.ID, arg.LandingRequestID)
			return db.LandingReviewRequest{ID: arg.ID, State: "dismissed"}, nil
		},
	}

	err := NewLandingService(q, &mockLandingRepoHostClient{}).DismissLandingReviewRequest(context.Background(), actor, "alice", "demo", 7, 12)
	require.NoError(t, err)

	q.dismissLandingReviewRequestFn = func(context.Context, db.DismissLandingReviewRequestParams) (db.LandingReviewRequest, error) {
		return db.LandingReviewRequest{}, pgx.ErrNoRows
	}
	err = NewLandingService(q, &mockLandingRepoHostClient{}).DismissLandingReviewRequest(context.Background(), actor, "alice", "demo", 7, 12)
	assert.Equal(t, 404, landingAPIStatus(t, err))
}
