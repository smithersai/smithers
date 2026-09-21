package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type approvalsZQuerier struct {
	*fakeApprovalsQuerier
	getSessionErr error
	createErr     error
	getApprovalFn func(string) (db.Approval, error)
	listErr       error
	listArg       db.ListApprovalsByRepoParams
}

func (q *approvalsZQuerier) GetAgentSession(ctx context.Context, id string) (db.AgentSession, error) {
	if q.getSessionErr != nil {
		return db.AgentSession{}, q.getSessionErr
	}
	return q.fakeApprovalsQuerier.GetAgentSession(ctx, id)
}

func (q *approvalsZQuerier) CreateApproval(ctx context.Context, arg db.CreateApprovalParams) (db.Approval, error) {
	if q.createErr != nil {
		return db.Approval{}, q.createErr
	}
	return q.fakeApprovalsQuerier.CreateApproval(ctx, arg)
}

func (q *approvalsZQuerier) GetApproval(ctx context.Context, id string) (db.Approval, error) {
	if q.getApprovalFn != nil {
		return q.getApprovalFn(id)
	}
	return q.fakeApprovalsQuerier.GetApproval(ctx, id)
}

func (q *approvalsZQuerier) ListApprovalsByRepo(ctx context.Context, arg db.ListApprovalsByRepoParams) ([]db.Approval, error) {
	q.listArg = arg
	if q.listErr != nil {
		return nil, q.listErr
	}
	return q.fakeApprovalsQuerier.ListApprovalsByRepo(ctx, arg)
}

func TestApprovals_Z_CreateListAndGetErrorBranches(t *testing.T) {
	ctx := context.Background()
	session := sampleSession(t)

	svc := NewApprovalsService(newFakeQuerier())
	for _, input := range []CreateApprovalInput{
		{Kind: "tool", Title: "title"},
		{SessionID: session.ID, Title: "title"},
		{SessionID: session.ID, Kind: "tool"},
	} {
		_, err := svc.Create(ctx, input)
		require.Equal(t, 400, apiStatus(t, err))
	}

	_, err := NewApprovalsService(&approvalsZQuerier{
		fakeApprovalsQuerier: newFakeQuerier(),
		getSessionErr:        errors.New("session failed"),
	}).Create(ctx, CreateApprovalInput{SessionID: session.ID, Kind: "tool", Title: "title"})
	require.Equal(t, 500, apiStatus(t, err))

	q := &approvalsZQuerier{fakeApprovalsQuerier: newFakeQuerier(), createErr: errors.New("insert failed")}
	q.sessions[session.ID] = session
	_, err = NewApprovalsService(q).Create(ctx, CreateApprovalInput{SessionID: session.ID, Kind: "tool", Title: "title"})
	require.Equal(t, 500, apiStatus(t, err))

	q = &approvalsZQuerier{fakeApprovalsQuerier: newFakeQuerier()}
	q.approvals["a"] = seededApproval(42, ApprovalStatePending)
	rows, err := NewApprovalsService(q).ListForRepo(ctx, 42, "", -2, 0)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, int32(30), q.listArg.PageSize)
	assert.Equal(t, int32(0), q.listArg.PageOffset)

	q = &approvalsZQuerier{fakeApprovalsQuerier: newFakeQuerier(), listErr: errors.New("list failed")}
	_, err = NewApprovalsService(q).ListForRepo(ctx, 42, "", 1, 10)
	require.Equal(t, 500, apiStatus(t, err))

	_, err = NewApprovalsService(&approvalsZQuerier{
		fakeApprovalsQuerier: newFakeQuerier(),
		getApprovalFn:        func(string) (db.Approval, error) { return db.Approval{}, errors.New("select failed") },
	}).GetForRepo(ctx, "approval", 42)
	require.Equal(t, 500, apiStatus(t, err))
}

func TestApprovals_Z_DecideErrorBranches(t *testing.T) {
	ctx := context.Background()
	svc := NewApprovalsService(newFakeQuerier())

	for _, input := range []DecideApprovalInput{
		{Decision: ApprovalStateApproved, RepositoryID: 42, UserID: 7},
		{ApprovalID: "a", Decision: "maybe", RepositoryID: 42, UserID: 7},
		{ApprovalID: "a", Decision: ApprovalStateApproved, RepositoryID: 42},
		{ApprovalID: "a", Decision: ApprovalStateApproved, UserID: 7},
	} {
		_, err := svc.Decide(ctx, input)
		require.Error(t, err)
	}

	_, err := NewApprovalsService(&approvalsZQuerier{
		fakeApprovalsQuerier: newFakeQuerier(),
		getApprovalFn:        func(string) (db.Approval, error) { return db.Approval{}, errors.New("load failed") },
	}).Decide(ctx, DecideApprovalInput{ApprovalID: "a", Decision: ApprovalStateApproved, RepositoryID: 42, UserID: 7})
	require.Equal(t, 500, apiStatus(t, err))

	expired := seededApproval(42, ApprovalStateExpired)
	q := &approvalsZQuerier{fakeApprovalsQuerier: newFakeQuerier()}
	q.approvals[expired.ID] = expired
	_, err = NewApprovalsService(q).Decide(ctx, DecideApprovalInput{ApprovalID: expired.ID, Decision: ApprovalStateApproved, RepositoryID: 42, UserID: 7})
	require.Equal(t, 400, apiStatus(t, err))

	past := seededApproval(42, ApprovalStatePending)
	past.ExpiresAt.Valid = true
	past.ExpiresAt.Time = time.Now().Add(-time.Hour)
	q = &approvalsZQuerier{fakeApprovalsQuerier: newFakeQuerier()}
	q.approvals[past.ID] = past
	q.expireErr = errors.New("expire failed")
	_, err = NewApprovalsService(q).Decide(ctx, DecideApprovalInput{ApprovalID: past.ID, Decision: ApprovalStateApproved, RepositoryID: 42, UserID: 7, Now: time.Now()})
	require.Equal(t, 500, apiStatus(t, err))

	race := seededApproval(42, ApprovalStatePending)
	calls := 0
	q = &approvalsZQuerier{
		fakeApprovalsQuerier: newFakeQuerier(),
		getApprovalFn: func(string) (db.Approval, error) {
			calls++
			if calls == 1 {
				return race, nil
			}
			return db.Approval{}, errors.New("reload failed")
		},
	}
	q.decideErr = pgx.ErrNoRows
	_, err = NewApprovalsService(q).Decide(ctx, DecideApprovalInput{ApprovalID: race.ID, Decision: ApprovalStateApproved, RepositoryID: 42, UserID: 7})
	require.Equal(t, 500, apiStatus(t, err))

	q = &approvalsZQuerier{fakeApprovalsQuerier: newFakeQuerier()}
	pending := seededApproval(42, ApprovalStatePending)
	q.approvals[pending.ID] = pending
	q.decideErr = errors.New("update failed")
	_, err = NewApprovalsService(q).Decide(ctx, DecideApprovalInput{ApprovalID: pending.ID, Decision: ApprovalStateApproved, RepositoryID: 42, UserID: 7})
	require.Equal(t, 500, apiStatus(t, err))

	q = &approvalsZQuerier{fakeApprovalsQuerier: newFakeQuerier()}
	pending = seededApproval(42, ApprovalStatePending)
	q.approvals[pending.ID] = pending
	auditor := &recordingApprovalsCovAuditor{}
	resp, err := NewApprovalsServiceWithAudit(q, auditor).Decide(ctx, DecideApprovalInput{
		ApprovalID:   pending.ID,
		Decision:     ApprovalStateRejected,
		RepositoryID: 42,
		UserID:       7,
		ActorName:    "alice",
	})
	require.NoError(t, err)
	assert.Equal(t, ApprovalStateRejected, resp.State)
	require.Len(t, auditor.events, 1)
	assert.Equal(t, AuditEventApprovalRejected, auditor.events[0].EventType)
}
