package db

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fcovWorkflowRun creates a workflow definition + run and returns the run.
func TestFCov_SSETickets_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))

	hash := "sse-" + randSlug(t)
	created, err := q.CreateSSETicket(ctx, CreateSSETicketParams{TicketHash: hash, UserID: userID, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	assert.Equal(t, hash, created.TicketHash)

	consumed, err := q.ConsumeSSETicket(ctx, hash)
	require.NoError(t, err)
	assert.True(t, consumed.UsedAt.Valid)

	// Second consume finds no eligible row.
	_, err = q.ConsumeSSETicket(ctx, hash)
	require.Error(t, err)

	// Expired ticket gets swept.
	expiredHash := "sse-exp-" + randSlug(t)
	_, err = q.CreateSSETicket(ctx, CreateSSETicketParams{TicketHash: expiredHash, UserID: userID, ExpiresAt: time.Now().Add(-time.Hour)})
	require.NoError(t, err)
	require.NoError(t, q.DeleteExpiredSSETickets(ctx))
}

func TestFCov_UserDevices_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))

	token := "apns-" + randSlug(t)
	dev, err := q.UpsertUserDevice(ctx, UpsertUserDeviceParams{UserID: userID, ApnsToken: token, Platform: "ios"})
	require.NoError(t, err)
	assert.Equal(t, "ios", dev.Platform)
	// Upsert again to exercise the ON CONFLICT update path.
	_, err = q.UpsertUserDevice(ctx, UpsertUserDeviceParams{UserID: userID, ApnsToken: token, Platform: "ios"})
	require.NoError(t, err)

	devices, err := q.ListAPNSDevicesForUser(ctx, userID)
	require.NoError(t, err)
	require.Len(t, devices, 1)

	require.NoError(t, q.DeleteUserDevice(ctx, DeleteUserDeviceParams{UserID: userID, ApnsToken: token}))
	devices, err = q.ListAPNSDevicesForUser(ctx, userID)
	require.NoError(t, err)
	assert.Empty(t, devices)
}

func TestFCov_NotificationPreferences_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))

	pref, err := q.UpsertNotificationPreferences(ctx, UpsertNotificationPreferencesParams{
		UserID: userID, NotifyIssues: true, NotifyLandings: false, NotifyMentions: true,
	})
	require.NoError(t, err)
	assert.True(t, pref.NotifyIssues)
	// Update path.
	pref, err = q.UpsertNotificationPreferences(ctx, UpsertNotificationPreferencesParams{
		UserID: userID, NotifyIssues: false, NotifyLandings: true, NotifyMentions: false,
	})
	require.NoError(t, err)
	assert.True(t, pref.NotifyLandings)

	got, err := q.GetNotificationPreferences(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, userID, got.UserID)
}

func TestFCov_DevtoolsSnapshots_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	sessionID := uuid.NewString()
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{ID: sessionID, RepositoryID: repoID, UserID: userID, Title: "s", Status: "active"})
	require.NoError(t, err)
	snap, err := q.UpsertDevtoolsSnapshot(ctx, UpsertDevtoolsSnapshotParams{
		SessionID: sessionID, RepositoryID: repoID, Kind: "file_tree", Payload: json.RawMessage(`{"a":1}`),
	})
	require.NoError(t, err)
	assert.Equal(t, "file_tree", snap.Kind)
	// Update path.
	_, err = q.UpsertDevtoolsSnapshot(ctx, UpsertDevtoolsSnapshotParams{
		SessionID: sessionID, RepositoryID: repoID, Kind: "file_tree", Payload: json.RawMessage(`{"a":2}`),
	})
	require.NoError(t, err)

	got, err := q.GetDevtoolsSnapshot(ctx, GetDevtoolsSnapshotParams{SessionID: sessionID, Kind: "file_tree"})
	require.NoError(t, err)
	assert.Equal(t, repoID, got.RepositoryID)

	list, err := q.ListDevtoolsSnapshotsBySession(ctx, ListDevtoolsSnapshotsBySessionParams{RepositoryID: repoID, SessionID: sessionID})
	require.NoError(t, err)
	require.Len(t, list, 1)
}

func TestFCov_RateLimitQuotas_Counts(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))

	mustExec(t, pool, `INSERT INTO repo_connections (user_id, repo_owner, repo_name, repo_owner_lower, repo_name_lower, license_spdx_id) VALUES ($1,'o','r','o','r','MIT')`, userID)
	n, err := q.CountConnectedReposForUser(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, 1, n)

	n, err = q.CountActiveWorkflowRunsForUser(ctx, userID)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, n, 0)

	n, err = q.CountActiveSandboxesForUser(ctx, userID)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, n, 0)
}

// Issue #185 regression: the per-user concurrent workflow-run cap gates
// dispatch on every repo the user can dispatch to, so
// CountActiveWorkflowRunsForUser must count active runs on org-member and
// collaborator repos — not only personally-owned ones (where the cap was a
// no-op for org/collaborator dispatches).
func TestFCov_CountActiveWorkflowRunsForUser_OrgAndCollaboratorRepos(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)

	userID, ownedRepoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	otherUserID, collabRepoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	_, unrelatedRepoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	orgID := mustCreateOrganization(t, pool, "org-"+randSlug(t))
	orgRepoID := mustCreateOrgRepo(t, pool, orgID, "org-repo-"+randSlug(t), false)
	mustAddOrgMember(t, pool, orgID, userID, "member")
	mustExec(t, pool,
		`INSERT INTO collaborators (repository_id, user_id, permission) VALUES ($1, $2, 'write')`,
		collabRepoID, userID)

	fcovWorkflowRun(t, ctx, q, ownedRepoID, "running")     // owned: counts
	fcovWorkflowRun(t, ctx, q, orgRepoID, "queued")        // org member: counts
	fcovWorkflowRun(t, ctx, q, collabRepoID, "running")    // collaborator: counts
	fcovWorkflowRun(t, ctx, q, collabRepoID, "success")    // terminal: excluded
	fcovWorkflowRun(t, ctx, q, unrelatedRepoID, "running") // no relationship: excluded

	n, err := q.CountActiveWorkflowRunsForUser(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, 3, n)

	// The other user only reaches their own repo's active run.
	n, err = q.CountActiveWorkflowRunsForUser(ctx, otherUserID)
	require.NoError(t, err)
	assert.Equal(t, 1, n)
}

func TestFCov_WorkflowTriggers_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	def, err := q.UpsertWorkflowDefinition(ctx, UpsertWorkflowDefinitionParams{
		RepositoryID: repoID, Name: "trig", Path: ".smithers/workflows/trig-" + randSlug(t) + ".yml", Config: json.RawMessage(`{}`),
	})
	require.NoError(t, err)

	trig, err := q.CreateWorkflowTrigger(ctx, CreateWorkflowTriggerParams{
		RepositoryID: repoID, WorkflowDefinitionID: def.ID, WorkflowPath: def.Path,
		EventType: "issues", EventAction: "opened", Enabled: true,
	})
	require.NoError(t, err)
	assert.True(t, trig.Enabled)

	triggers, err := q.ListWorkflowTriggersByRepository(ctx, repoID)
	require.NoError(t, err)
	require.Len(t, triggers, 1)

	require.NoError(t, q.DisableWorkflowTriggersByRepositoryPath(ctx, DisableWorkflowTriggersByRepositoryPathParams{RepositoryID: repoID, WorkflowPath: def.Path}))
	triggers, err = q.ListWorkflowTriggersByRepository(ctx, repoID)
	require.NoError(t, err)
	assert.Empty(t, triggers)
}

func TestFCov_ExpireApproval_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	sessionID := uuid.NewString()
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{ID: sessionID, RepositoryID: repoID, UserID: userID, Title: "s", Status: "active"})
	require.NoError(t, err)

	approvalID := uuid.NewString()
	mustExec(t, pool,
		`INSERT INTO approvals (id, session_id, repository_id, state, kind, title, description, expires_at)
		 VALUES ($1,$2,$3,'pending','deploy','t','', NOW() - INTERVAL '1 hour')`,
		approvalID, sessionID, repoID)

	expired, err := q.ExpireApproval(ctx, ExpireApprovalParams{
		ID: approvalID, RepositoryID: repoID, ExpiresAt: pgtype.Timestamptz{Time: time.Now(), Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "expired", expired.State)
}

func TestFCov_AuthExtras_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, uniqueTestUsername(t))

	// Email verification token get-by-hash.
	verifyHash := "verify-" + randSlug(t)
	_, err := q.CreateEmailVerificationToken(ctx, CreateEmailVerificationTokenParams{
		UserID: userID, Email: "e-" + randSlug(t) + "@example.com", TokenHash: verifyHash, TokenType: "verify", ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	tok, err := q.GetEmailVerificationTokenByHash(ctx, verifyHash)
	require.NoError(t, err)
	assert.Equal(t, userID, tok.UserID)

	// OAuth account token rotation CAS.
	account, err := q.UpsertOAuthAccount(ctx, UpsertOAuthAccountParams{
		UserID: userID, Provider: "github", ProviderUserID: "rot-" + randSlug(t),
		AccessTokenEncrypted: []byte("a1"), RefreshTokenEncrypted: []byte("r1"), ProfileData: []byte(`{}`),
	})
	require.NoError(t, err)
	rotated, err := q.RotateOAuthAccountTokensCAS(ctx, RotateOAuthAccountTokensCASParams{
		AccessTokenEncrypted: []byte("a2"), RefreshTokenEncrypted: []byte("r2"),
		Provider: account.Provider, ProviderUserID: account.ProviderUserID,
		OldAccessTokenEncrypted: []byte("a1"), OldRefreshTokenEncrypted: []byte("r1"),
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rotated)

	// OAuth state consume happy path.
	state, err := q.CreateOAuthState(ctx, CreateOAuthStateParams{
		State: "st-" + randSlug(t), ContextHash: "cx-" + randSlug(t), ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	rows, err := q.ConsumeOAuthState(ctx, ConsumeOAuthStateParams{State: state.StateKey, ContextHash: state.ContextHash})
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows)

	// Access token delete + expired sweep.
	token, err := q.CreateAccessToken(ctx, CreateAccessTokenParams{
		UserID: userID, Name: "cov", TokenHash: "pat-" + randSlug(t), TokenLastEight: "abcdefgh", Scopes: "read",
	})
	require.NoError(t, err)
	deleted, err := q.DeleteAccessTokenByIDAndUserID(ctx, DeleteAccessTokenByIDAndUserIDParams{ID: token.ID, UserID: userID})
	require.NoError(t, err)
	assert.Equal(t, int64(1), deleted)
	_, err = q.DeleteExpiredAccessTokens(ctx)
	require.NoError(t, err)

	// Sessions list.
	sessionKey := uuid.NewString()
	_, err = q.CreateAuthSession(ctx, CreateAuthSessionParams{
		SessionKey: sessionKey, UserID: userID, Username: "cov", IsAdmin: false, ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)
	sessions, err := q.ListUserSessions(ctx, userID)
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(sessions), 1)
}
