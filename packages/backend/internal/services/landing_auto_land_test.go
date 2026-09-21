package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type autoLandTestQuerier struct {
	*mockLandingQuerier
	setFn         func(context.Context, db.SetLandingRequestAutoLandParams) (db.LandingRequest, error)
	clearFn       func(context.Context, int64) (db.LandingRequest, error)
	claimFn       func(context.Context) (db.LandingRequest, error)
	enqueueAutoFn func(context.Context, db.EnqueueAutoLandRequestParams) (db.LandingRequest, error)
	getRepoByIDFn func(context.Context, int64) (db.Repository, error)
	getOrgByIDFn  func(context.Context, int64) (db.Organization, error)
}

func (q *autoLandTestQuerier) SetLandingRequestAutoLand(ctx context.Context, arg db.SetLandingRequestAutoLandParams) (db.LandingRequest, error) {
	return q.setFn(ctx, arg)
}

func (q *autoLandTestQuerier) ClearLandingRequestAutoLand(ctx context.Context, id int64) (db.LandingRequest, error) {
	return q.clearFn(ctx, id)
}

func (q *autoLandTestQuerier) ClaimAutoLandCandidate(ctx context.Context) (db.LandingRequest, error) {
	if q.claimFn == nil {
		return db.LandingRequest{}, pgx.ErrNoRows
	}
	return q.claimFn(ctx)
}

func (q *autoLandTestQuerier) EnqueueAutoLandRequest(ctx context.Context, arg db.EnqueueAutoLandRequestParams) (db.LandingRequest, error) {
	return q.enqueueAutoFn(ctx, arg)
}

func (q *autoLandTestQuerier) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	return q.getRepoByIDFn(ctx, id)
}

func (q *autoLandTestQuerier) GetOrgByID(ctx context.Context, id int64) (db.Organization, error) {
	if q.getOrgByIDFn == nil {
		return db.Organization{}, pgx.ErrNoRows
	}
	return q.getOrgByIDFn(ctx, id)
}

func TestLandingService_SetAndClearAutoLand(t *testing.T) {
	t.Parallel()
	actor := landingTestUser(10, "owner")
	repository := landingRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
		r.LandingQueueRequiredChecks = []string{"ci/test"}
	})
	now := time.Now().UTC().Truncate(time.Second)
	base := &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(_ context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(88, repository.ID, arg.Number, actor.ID, []string{"change-1"}), nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) { return *actor, nil },
	}
	q := &autoLandTestQuerier{mockLandingQuerier: base}
	q.setFn = func(_ context.Context, arg db.SetLandingRequestAutoLandParams) (db.LandingRequest, error) {
		assert.Equal(t, actor.ID, arg.SetBy.Int64)
		row := landingDBRequest(arg.ID, repository.ID, 7, actor.ID, nil)
		row.AutoLandEnabled = true
		row.AutoLandSetBy = arg.SetBy
		row.AutoLandSetAt = pgtype.Timestamptz{Time: now, Valid: true}
		return row, nil
	}
	clearCalls := 0
	q.clearFn = func(_ context.Context, id int64) (db.LandingRequest, error) {
		clearCalls++
		assert.Equal(t, int64(88), id)
		return landingDBRequest(id, repository.ID, 7, actor.ID, nil), nil
	}

	svc := NewLandingService(q, &mockLandingRepoHostClient{})
	response, err := svc.SetLandingRequestAutoLand(context.Background(), actor, "owner", "demo", 7, SetAutoLandInput{Enabled: true})
	require.NoError(t, err)
	assert.True(t, response.AutoLand.Enabled)
	require.NotNil(t, response.AutoLand.SetBy)
	assert.Equal(t, "owner", response.AutoLand.SetBy.Login)
	require.NotNil(t, response.AutoLand.SetAt)
	assert.Equal(t, now, *response.AutoLand.SetAt)
	assert.Equal(t, []LandingBlock{{Kind: "check", Name: "ci/test", Repo: "demo"}}, response.AutoLand.WaitingOn)

	require.NoError(t, svc.ClearLandingRequestAutoLand(context.Background(), actor, "owner", "demo", 7))
	require.NoError(t, svc.ClearLandingRequestAutoLand(context.Background(), actor, "owner", "demo", 7))
	assert.Equal(t, 2, clearCalls)
}

func TestLandingService_AutoLandValidation(t *testing.T) {
	t.Parallel()
	actor := landingTestUser(10, "owner")
	repository := landingRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true} })
	q := &autoLandTestQuerier{mockLandingQuerier: &mockLandingQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		getLandingRequestWithChangeIDsByNumberFn: func(_ context.Context, arg db.GetLandingRequestWithChangeIDsByNumberParams) (db.GetLandingRequestWithChangeIDsByNumberRow, error) {
			return landingDBRequestWithChangeIDs(88, repository.ID, arg.Number, actor.ID, []string{"change-1"}), nil
		},
	}}
	svc := NewLandingService(q, &mockLandingRepoHostClient{})

	_, err := svc.SetLandingRequestAutoLand(context.Background(), nil, "owner", "demo", 7, SetAutoLandInput{Enabled: true})
	assert.Equal(t, 401, landingAPIStatus(t, err))
	_, err = svc.SetLandingRequestAutoLand(context.Background(), actor, "owner", "demo", 7, SetAutoLandInput{})
	assert.Equal(t, 422, landingAPIStatus(t, err))
}

func TestLandingService_ProcessNextAutoLand(t *testing.T) {
	t.Parallel()
	actor := landingTestUser(10, "owner")
	repository := landingRepo(func(r *db.Repository) { r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true} })
	candidate := landingDBRequest(88, repository.ID, 7, actor.ID, func(row *db.LandingRequest) {
		row.AutoLandEnabled = true
		row.AutoLandSetBy = pgtype.Int8{Int64: actor.ID, Valid: true}
		row.AutoLandSetAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	})
	enqueued := false
	base := &mockLandingQuerier{
		getUserByIDFn: func(context.Context, int64) (db.User, error) { return *actor, nil },
		listLandingRequestChangesFn: func(context.Context, db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{{LandingRequestID: candidate.ID, ChangeID: "change-1", PositionInStack: 1}}, nil
		},
	}
	q := &autoLandTestQuerier{mockLandingQuerier: base}
	q.claimFn = func(context.Context) (db.LandingRequest, error) { return candidate, nil }
	q.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) { return repository, nil }
	q.enqueueAutoFn = func(_ context.Context, arg db.EnqueueAutoLandRequestParams) (db.LandingRequest, error) {
		enqueued = true
		assert.Equal(t, candidate.ID, arg.ID)
		row := candidate
		row.State = landingStateQueued
		return row, nil
	}

	svc := NewLandingService(q, &mockLandingRepoHostClient{})
	require.NoError(t, svc.ProcessNextAutoLand(context.Background()))
	assert.True(t, enqueued)
	assert.True(t, base.createLandingTaskCalled)
}

func TestLandingService_ProcessNextAutoLandWaitsForGate(t *testing.T) {
	t.Parallel()
	actor := landingTestUser(10, "owner")
	repository := landingRepo(func(r *db.Repository) {
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
		r.LandingQueueRequiredChecks = []string{"ci/test"}
	})
	candidate := landingDBRequest(88, repository.ID, 7, actor.ID, func(row *db.LandingRequest) {
		row.AutoLandEnabled = true
		row.AutoLandSetBy = pgtype.Int8{Int64: actor.ID, Valid: true}
		row.AutoLandSetAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	})
	q := &autoLandTestQuerier{mockLandingQuerier: &mockLandingQuerier{
		getUserByIDFn: func(context.Context, int64) (db.User, error) { return *actor, nil },
		listLandingRequestChangesFn: func(context.Context, db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error) {
			return []db.LandingRequestChange{{LandingRequestID: candidate.ID, ChangeID: "change-1", PositionInStack: 1}}, nil
		},
	}}
	q.claimFn = func(context.Context) (db.LandingRequest, error) { return candidate, nil }
	q.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) { return repository, nil }
	q.enqueueAutoFn = func(context.Context, db.EnqueueAutoLandRequestParams) (db.LandingRequest, error) {
		t.Fatal("blocked auto-land must not enqueue")
		return db.LandingRequest{}, nil
	}

	svc := NewLandingService(q, &mockLandingRepoHostClient{})
	require.NoError(t, svc.ProcessNextAutoLand(context.Background()))
	assert.False(t, q.createLandingTaskCalled)
}
