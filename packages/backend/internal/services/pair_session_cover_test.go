package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/email"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type pairSessionCovTransport struct {
	err  error
	sent []email.Message
}

func (t *pairSessionCovTransport) Send(_ context.Context, msg email.Message) error {
	t.sent = append(t.sent, msg)
	return t.err
}

func pairSessionCovNewServiceNoTx(fx pairFixture, paid map[int64]bool, transport email.Transport) *PairSessionService {
	forker := &stubForker{pool: fx.pool, repoID: fx.repoID}
	return NewPairSessionService(fx.store, &stubBilling{paid: paid}, forker,
		PairSessionServiceConfig{EmailFrom: "pair@smithers.sh", Transport: transport, InviteBaseURL: "https://pair.example.test"})
}

func TestPairSession_Cov_RoleHelpersAndCreateGuards(t *testing.T) {
	assert.Equal(t, 0, pairRoleRank(""))
	assert.Equal(t, 1, pairRoleRank(PairRoleViewer))
	assert.Equal(t, 2, pairRoleRank(PairRoleEditor))
	assert.Equal(t, 3, pairRoleRank(PairRoleOwner))
	assert.Equal(t, "read", pairShareLevelForRole(PairRoleViewer))
	assert.Equal(t, "write", pairShareLevelForRole(PairRoleEditor))
	assert.Equal(t, "write", pairShareLevelForRole(PairRoleOwner))
	assert.False(t, pairSessionTerminal("active"))
	assert.True(t, pairSessionTerminal("ended"))
	assert.True(t, pairSessionTerminal("failed"))
	id, err := mintPairSessionID()
	require.NoError(t, err)
	assert.Len(t, id, 22)

	_, err = NewPairSessionService(nil, nil, nil, PairSessionServiceConfig{}).CreateSession(context.Background(), 1, 2, "workspace-id")
	assert.Equal(t, 500, httpStatus(err))

	forker := &stubForker{}
	svc := NewPairSessionService(nil, &stubBilling{paid: map[int64]bool{1: true}}, forker, PairSessionServiceConfig{})
	_, err = svc.CreateSession(context.Background(), 1, 2, " ")
	assert.Equal(t, 400, httpStatus(err))

	forker.verifyErr = pkgerrors.NotFound("source workspace not found")
	_, err = svc.CreateSession(context.Background(), 1, 2, "foreign-workspace")
	assert.Equal(t, 404, httpStatus(err))
	assert.Zero(t, forker.calls.Load())
}

func TestPairSession_Cov_MembershipLinksInvitesPresenceAndEmail(t *testing.T) {
	ctx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "cov-member-owner")
	editor := mkPairUser(t, fx.pool, "cov-member-editor")
	viewer := mkPairUser(t, fx.pool, "cov-member-viewer")
	stranger := mkPairUser(t, fx.pool, "cov-member-stranger")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)

	sentTransport := &pairSessionCovTransport{}
	svc := newPairService(fx, map[int64]bool{owner: true, editor: true, viewer: true, stranger: true}, false, sentTransport)
	session, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
	require.NoError(t, err)

	members, err := svc.ListMembers(ctx, session.ID, owner)
	require.NoError(t, err)
	require.Len(t, members, 1)
	assert.Equal(t, PairRoleOwner, members[0].Role)
	profiles, err := svc.ListMemberProfiles(ctx, session.ID, owner)
	require.NoError(t, err)
	require.Len(t, profiles, 1)
	assert.Equal(t, owner, profiles[0].UserID)
	_, err = svc.ListMembers(ctx, session.ID, stranger)
	assert.Equal(t, 403, httpStatus(err))

	_, err = svc.SetAccessMode(ctx, session.ID, owner, "public")
	assert.Equal(t, 400, httpStatus(err))
	viewLink, err := svc.MintLink(ctx, session.ID, owner, PairRoleViewer)
	require.NoError(t, err)
	editLink, err := svc.MintLink(ctx, session.ID, owner, PairRoleEditor)
	require.NoError(t, err)
	links, err := svc.ListLinks(ctx, session.ID, owner)
	require.NoError(t, err)
	require.Len(t, links, 2)
	_, err = svc.SetAccessMode(ctx, session.ID, owner, PairAccessRestricted)
	require.NoError(t, err)
	_, err = svc.ResolveByLink(ctx, viewLink.Slug, viewer)
	assert.Equal(t, 404, httpStatus(err))
	err = svc.RevokeLink(ctx, session.ID, owner, editLink.ID)
	assert.Equal(t, 404, httpStatus(err))

	viewLink, err = svc.MintLink(ctx, session.ID, owner, PairRoleViewer)
	require.NoError(t, err)
	res, err := svc.ResolveByLink(ctx, viewLink.Slug, viewer)
	require.NoError(t, err)
	assert.Equal(t, PairRoleViewer, res.Role)
	assert.True(t, res.Materialized)
	editLink, err = svc.MintLink(ctx, session.ID, owner, PairRoleEditor)
	require.NoError(t, err)
	res, err = svc.ResolveByLink(ctx, editLink.Slug, viewer)
	require.NoError(t, err)
	assert.Equal(t, PairRoleEditor, res.Role, "an editor link elevates an existing viewer member")
	var shareLevel string
	require.NoError(t, fx.pool.QueryRow(ctx,
		`SELECT level FROM workspace_shares WHERE workspace_id=$1::uuid AND grantee_user_id=$2`,
		uuidToString(session.WorkspaceID), viewer).Scan(&shareLevel))
	assert.Equal(t, "write", shareLevel)

	_, err = svc.SetMemberRole(ctx, session.ID, owner, owner, PairRoleViewer)
	assert.Equal(t, 400, httpStatus(err))
	_, err = svc.SetMemberRole(ctx, session.ID, owner, editor, PairRoleOwner)
	assert.Equal(t, 400, httpStatus(err))
	_, err = svc.SetMemberRole(ctx, session.ID, owner, editor, PairRoleViewer)
	assert.Equal(t, 404, httpStatus(err))
	err = svc.RevokeMember(ctx, session.ID, owner, owner)
	assert.Equal(t, 404, httpStatus(err))

	_, err = svc.CreateInvite(ctx, session.ID, owner, "not-an-email", PairRoleViewer)
	assert.Equal(t, 400, httpStatus(err))
	_, err = svc.CreateInvite(ctx, session.ID, owner, "reader@example.com", PairRoleOwner)
	assert.Equal(t, 400, httpStatus(err))
	invite, err := svc.CreateInvite(ctx, session.ID, owner, "Reader@Example.COM", PairRoleViewer)
	require.NoError(t, err)
	assert.True(t, invite.Delivered)
	require.Len(t, sentTransport.sent, 1)
	assert.Equal(t, []string{"reader@example.com"}, sentTransport.sent[0].To)
	assert.Contains(t, sentTransport.sent[0].Text, "/s/"+session.ID+"?invite=")
	listedInvites, err := svc.ListInvites(ctx, session.ID, owner)
	require.NoError(t, err)
	assert.NotEmpty(t, listedInvites)
	require.NoError(t, svc.RevokeInvite(ctx, session.ID, owner, "reader@example.com"))
	err = svc.RevokeInvite(ctx, session.ID, owner, "reader@example.com")
	assert.Equal(t, 404, httpStatus(err))

	failingTransport := &pairSessionCovTransport{err: errors.New("smtp unavailable")}
	failSvc := newPairService(fx, map[int64]bool{owner: true}, false, failingTransport)
	failedInvite, err := failSvc.CreateInvite(ctx, session.ID, owner, "failed@example.com", PairRoleViewer)
	require.NoError(t, err)
	assert.False(t, failedInvite.Delivered)
	assert.Contains(t, failedInvite.DeliveryDetail, "failed")

	require.NoError(t, svc.Heartbeat(ctx, session.ID, viewer, nil))
	var presence json.RawMessage
	require.NoError(t, fx.pool.QueryRow(ctx,
		`SELECT presence FROM pair_session_members WHERE session_id=$1 AND user_id=$2`,
		session.ID, viewer).Scan(&presence))
	assert.JSONEq(t, `{}`, string(presence))
	require.NoError(t, svc.Heartbeat(ctx, session.ID, viewer, json.RawMessage(`{"cursor":7}`)))
	require.NoError(t, fx.pool.QueryRow(ctx,
		`SELECT presence FROM pair_session_members WHERE session_id=$1 AND user_id=$2`,
		session.ID, viewer).Scan(&presence))
	assert.JSONEq(t, `{"cursor":7}`, string(presence))
	assert.Equal(t, 403, httpStatus(svc.Heartbeat(ctx, session.ID, stranger, nil)))
}

func TestPairSession_Cov_QueueTransitionsSweepsAndFallbackEnqueue(t *testing.T) {
	ctx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "cov-queue-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	svc := pairSessionCovNewServiceNoTx(fx, map[int64]bool{owner: true}, nil)
	session, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
	require.NoError(t, err)

	_, err = svc.Enqueue(ctx, session.ID, owner, "bad-source", "body")
	assert.Equal(t, 400, httpStatus(err))
	_, err = svc.Enqueue(ctx, session.ID, owner, pairPromptSourceSolo, " ")
	assert.Equal(t, 400, httpStatus(err))
	prompt, err := svc.Enqueue(ctx, session.ID, owner, pairPromptSourceSolo, "first")
	require.NoError(t, err)
	assert.Equal(t, int64(1), prompt.Seq)

	claimed, err := svc.Claim(ctx, session.ID, owner, prompt.ID, "exec-1", time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "claimed", claimed.Status)
	_, err = svc.Claim(ctx, session.ID, owner, prompt.ID, "exec-2", time.Minute)
	assert.Equal(t, 409, httpStatus(err))
	_, err = svc.Start(ctx, session.ID, owner, prompt.ID, "exec-1", " ")
	assert.Equal(t, 400, httpStatus(err))
	_, err = svc.Renew(ctx, session.ID, owner, prompt.ID, "other-exec", time.Minute)
	assert.Equal(t, 409, httpStatus(err))

	_, err = fx.pool.Exec(ctx, `UPDATE pair_prompt_queue SET claim_expires_at=NOW() - INTERVAL '2 minutes' WHERE id=$1`, prompt.ID)
	require.NoError(t, err)
	swept, err := svc.SweepStaleClaims(ctx)
	require.NoError(t, err)
	assert.Equal(t, 1, swept)
	fresh, err := fx.store.GetPairPrompt(ctx, prompt.ID)
	require.NoError(t, err)
	assert.Equal(t, "queued", fresh.Status)
	assert.False(t, fresh.ClaimExpiresAt.Valid)

	_, err = svc.Claim(ctx, session.ID, owner, prompt.ID, "exec-1", time.Minute)
	require.NoError(t, err)
	_, err = svc.Start(ctx, session.ID, owner, prompt.ID, "exec-1", "run-1")
	require.NoError(t, err)
	_, err = fx.pool.Exec(ctx, `UPDATE pair_prompt_queue SET claim_expires_at=NOW() - INTERVAL '5 minutes' WHERE id=$1`, prompt.ID)
	require.NoError(t, err)
	swept, err = svc.SweepStaleClaims(ctx)
	require.NoError(t, err)
	assert.Equal(t, 1, swept)
	fresh, err = fx.store.GetPairPrompt(ctx, prompt.ID)
	require.NoError(t, err)
	assert.Equal(t, "failed", fresh.Status)

	rows, err := svc.ListQueue(ctx, session.ID, owner)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "failed", rows[0].Status)
}

func TestPairSession_Cov_DraftFallbackSubmitAndTerminalSession(t *testing.T) {
	ctx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "cov-draft-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	svc := pairSessionCovNewServiceNoTx(fx, map[int64]bool{owner: true}, nil)
	session, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
	require.NoError(t, err)

	emptyDraft, err := svc.GetDraft(ctx, session.ID, owner)
	require.NoError(t, err)
	assert.Equal(t, session.ID, emptyDraft.SessionID)
	_, err = svc.SubmitDraft(ctx, session.ID, owner)
	assert.Equal(t, 400, httpStatus(err))
	_, err = svc.PutDraft(ctx, session.ID, owner, "   ", 1)
	require.NoError(t, err)
	_, err = svc.SubmitDraft(ctx, session.ID, owner)
	assert.Equal(t, 400, httpStatus(err))

	_, err = svc.PutDraft(ctx, session.ID, owner, "ship it", 2)
	require.NoError(t, err)
	prompt, err := svc.SubmitDraft(ctx, session.ID, owner)
	require.NoError(t, err)
	assert.Equal(t, pairPromptSourceTogether, prompt.Source)
	assert.Equal(t, "ship it", prompt.Body)
	draft, err := svc.GetDraft(ctx, session.ID, owner)
	require.NoError(t, err)
	assert.Empty(t, draft.Content)

	require.NoError(t, svc.EndSession(ctx, session.ID, owner))
	_, err = svc.ResolveSession(ctx, session.ID, owner)
	assert.Equal(t, 404, httpStatus(err))
	_, err = svc.ListQueue(ctx, session.ID, owner)
	assert.Equal(t, 404, httpStatus(err))
	err = svc.EndSession(ctx, session.ID, owner)
	assert.Equal(t, 404, httpStatus(err))
}

func TestPairSession_Cov_ProvisioningSweepAndStartSweeperCancel(t *testing.T) {
	ctx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "cov-sweep-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	svc := newPairService(fx, map[int64]bool{owner: true}, false, nil)

	_, err := fx.store.CreatePairSession(ctx, db.CreatePairSessionParams{
		ID:                "cov-stale-provisioning-session",
		OwnerUserID:       owner,
		SourceWorkspaceID: ws,
		AccessMode:        PairAccessRestricted,
	})
	require.NoError(t, err)
	_, err = fx.pool.Exec(ctx, `UPDATE pair_sessions SET created_at=NOW() - INTERVAL '30 minutes' WHERE id=$1`, "cov-stale-provisioning-session")
	require.NoError(t, err)
	count, err := svc.SweepStaleProvisioning(ctx, time.Now().UTC())
	require.NoError(t, err)
	assert.Equal(t, 1, count)
	_, err = svc.ResolveSession(ctx, "cov-stale-provisioning-session", owner)
	assert.Equal(t, 404, httpStatus(err))

	canceled, cancel := context.WithCancel(ctx)
	cancel()
	svc.StartStaleSweeper(canceled)
}
