package services

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestApprovals_Cov_ConstructorsCreateAndListBranches(t *testing.T) {
	q := newFakeQuerier()
	session := sampleSession(t)
	q.sessions[session.ID] = session
	auditor := &recordingApprovalsCovAuditor{}
	push := &recordingApprovalPushNotifier{}
	svc := NewApprovalsServiceWithAudit(q, auditor, WithApprovalPushNotifier(push))

	resp, err := svc.Create(context.Background(), CreateApprovalInput{
		SessionID:   session.ID,
		Kind:        "tool",
		Title:       "Approve tool",
		Description: "desc",
		Payload:     nil,
		ExpiresAt:   time.Now().Add(time.Hour),
		ForwarderIP: "127.0.0.1",
	})
	require.NoError(t, err)
	assert.Equal(t, ApprovalStatePending, resp.State)
	assert.Equal(t, []byte(`{}`), resp.Payload)
	require.Len(t, auditor.events, 1)
	assert.Equal(t, AuditEventApprovalRequested, auditor.events[0].EventType)
	require.Len(t, push.calls, 1)
	assert.Equal(t, session.UserID, push.calls[0].userID)

	nilSvc := NewApprovalsServiceWithAudit(q, nil)
	require.NotNil(t, nilSvc)

	_, err = svc.Create(context.Background(), CreateApprovalInput{SessionID: session.ID, Kind: strings.Repeat("k", maxApprovalKindBytes+1), Title: "t"})
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, approvalsCovStatus(t, err))

	_, err = svc.Create(context.Background(), CreateApprovalInput{SessionID: session.ID, Kind: "k", Title: strings.Repeat("t", maxApprovalTitleBytes+1)})
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, approvalsCovStatus(t, err))

	_, err = svc.Create(context.Background(), CreateApprovalInput{SessionID: session.ID, Kind: "k", Title: "t", Description: strings.Repeat("d", maxApprovalDescriptionBytes+1)})
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, approvalsCovStatus(t, err))

	_, err = NewApprovalsService(nil).ListForRepo(context.Background(), 1, "", 1, 0)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, approvalsCovStatus(t, err))

	_, err = svc.ListForRepo(context.Background(), 0, "", 1, 0)
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, approvalsCovStatus(t, err))
}

func TestApprovals_Cov_DecideRaceExpiryAndGetBranches(t *testing.T) {
	ctx := context.Background()
	q := newFakeQuerier()
	pending := seededApproval(42, ApprovalStatePending)
	pending.ExpiresAt.Valid = true
	pending.ExpiresAt.Time = time.Now().Add(-time.Hour)
	q.approvals[pending.ID] = pending
	auditor := &recordingApprovalsCovAuditor{}
	svc := NewApprovalsServiceWithAudit(q, auditor)

	_, err := svc.Decide(ctx, DecideApprovalInput{
		ApprovalID:   pending.ID,
		RepositoryID: 42,
		UserID:       7,
		Decision:     ApprovalStateApproved,
		Now:          time.Now(),
	})
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, approvalsCovStatus(t, err))
	require.Len(t, auditor.events, 1)
	assert.Equal(t, AuditEventApprovalExpired, auditor.events[0].EventType)

	q = newFakeQuerier()
	race := seededApproval(42, ApprovalStatePending)
	q.approvals[race.ID] = race
	q.decideErr = pgx.ErrNoRows
	svc = NewApprovalsService(q)
	q.approvals[race.ID] = seededApproval(42, ApprovalStateApproved)
	resp, err := svc.Decide(ctx, DecideApprovalInput{
		ApprovalID:   race.ID,
		RepositoryID: 42,
		UserID:       7,
		Decision:     ApprovalStateApproved,
	})
	require.NoError(t, err)
	assert.Equal(t, ApprovalStateApproved, resp.State)

	q = newFakeQuerier()
	race = seededApproval(42, ApprovalStatePending)
	q.approvals[race.ID] = race
	q.decideErr = pgx.ErrNoRows
	svc = NewApprovalsService(q)
	q.approvals[race.ID] = seededApproval(42, ApprovalStateRejected)
	_, err = svc.Decide(ctx, DecideApprovalInput{
		ApprovalID:   race.ID,
		RepositoryID: 42,
		UserID:       7,
		Decision:     ApprovalStateApproved,
	})
	require.Error(t, err)
	assert.Equal(t, http.StatusConflict, approvalsCovStatus(t, err))

	_, err = svc.GetForRepo(ctx, "missing", 42)
	require.Error(t, err)
	assert.Equal(t, http.StatusNotFound, approvalsCovStatus(t, err))

	q.approvals["foreign"] = seededApproval(99, ApprovalStatePending)
	_, err = svc.GetForRepo(ctx, "foreign", 42)
	require.Error(t, err)
	assert.Equal(t, http.StatusNotFound, approvalsCovStatus(t, err))
}

type recordingApprovalsCovAuditor struct {
	events []AuditEvent
}

func (r *recordingApprovalsCovAuditor) Log(_ context.Context, event AuditEvent) {
	r.events = append(r.events, event)
}

func approvalsCovStatus(t *testing.T, err error) int {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	return apiErr.Status
}
