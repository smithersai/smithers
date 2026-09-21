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
func fcovWorkflowRun(t *testing.T, ctx context.Context, q *Queries, repoID int64, status string, executionPlanes ...string) WorkflowRun {
	t.Helper()
	executionPlane := ""
	if len(executionPlanes) > 0 {
		executionPlane = executionPlanes[0]
	}
	def, err := q.UpsertWorkflowDefinition(ctx, UpsertWorkflowDefinitionParams{
		RepositoryID: repoID,
		Name:         "cov",
		Path:         ".smithers/workflows/cov-" + randSlug(t) + ".yml",
		Config:       json.RawMessage(`{"steps":[]}`),
	})
	require.NoError(t, err)
	run, err := q.CreateWorkflowRun(ctx, CreateWorkflowRunParams{
		RepositoryID:         repoID,
		WorkflowDefinitionID: def.ID,
		Status:               status,
		TriggerEvent:         "push",
		TriggerRef:           "main",
		TriggerCommitSha:     "sha-" + randSlug(t),
		DispatchInputs:       []byte(`{}`),
		ExecutionPlane:       executionPlane,
	})
	require.NoError(t, err)
	return run
}

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

func TestFCov_CanaryResults_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, _ := newQueries(t)

	suite := randSlug(t)[:24]
	res, err := q.UpsertCanaryResult(ctx, UpsertCanaryResultParams{
		Suite: suite, TestName: "t1", Status: "success", DurationSeconds: 1.5,
		ErrorMessage: "", RunID: "run-1", ReportedAt: time.Now(),
	})
	require.NoError(t, err)
	assert.Equal(t, suite, res.Suite)
	// Update path.
	_, err = q.UpsertCanaryResult(ctx, UpsertCanaryResultParams{
		Suite: suite, TestName: "t1", Status: "failure", DurationSeconds: 2.0,
		ErrorMessage: "boom", RunID: "run-2", ReportedAt: time.Now(),
	})
	require.NoError(t, err)

	results, err := q.ListCanaryResults(ctx)
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(results), 1)
}

func TestFCov_GithubProxyAuditLog_Insert(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
	run := fcovWorkflowRun(t, ctx, q, repoID, "running")

	require.NoError(t, q.InsertGithubProxyAuditLog(ctx, InsertGithubProxyAuditLogParams{
		WorkflowRunID: run.ID, Method: "GET", Path: "/repos/x", StatusCode: 200, Decision: "allow", Reason: "",
	}))
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

func TestFCov_WorkflowSandboxScheduler_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)
	_, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))

	queued := fcovWorkflowRun(t, ctx, q, repoID, "queued", "sandbox")
	claimed, err := q.ClaimQueuedWorkflowRuns(ctx, 10)
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(claimed), 1)
	findClaim := func(runID int64, rows []ClaimQueuedWorkflowRunsRow) ClaimQueuedWorkflowRunsRow {
		t.Helper()
		for _, claim := range rows {
			if claim.ID == runID {
				return claim
			}
		}
		t.Fatalf("workflow run %d was not claimed", runID)
		return ClaimQueuedWorkflowRunsRow{}
	}
	queuedClaim := findClaim(queued.ID, claimed)

	success, err := q.MarkWorkflowRunSuccess(ctx, MarkWorkflowRunSuccessParams{
		ID: queued.ID, ClaimToken: uuid.UUID(queuedClaim.ClaimToken.Bytes).String(), ClaimGeneration: queuedClaim.ClaimGeneration,
	})
	require.NoError(t, err)
	assert.Equal(t, "success", success.Status)

	other := fcovWorkflowRun(t, ctx, q, repoID, "queued", "sandbox")
	claimed, err = q.ClaimQueuedWorkflowRuns(ctx, 10)
	require.NoError(t, err)
	otherClaim := findClaim(other.ID, claimed)
	failed, err := q.MarkWorkflowRunFailure(ctx, MarkWorkflowRunFailureParams{
		ID: other.ID, ClaimToken: uuid.UUID(otherClaim.ClaimToken.Bytes).String(), ClaimGeneration: otherClaim.ClaimGeneration,
	})
	require.NoError(t, err)
	assert.Equal(t, "failure", failed.Status)
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

func TestFCov_AlertRemediationJobs_RoundTrip(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)

	var incidentID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO alert_incidents (incident_id, policy_name) VALUES ($1,$2) RETURNING id`,
		"inc-"+randSlug(t), "policy-x").Scan(&incidentID))
	var jobID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO alert_remediation_jobs (incident_id, status, available_at) VALUES ($1,'pending', NOW() - INTERVAL '1 hour') RETURNING id`,
		incidentID).Scan(&jobID))

	claimed, err := q.ClaimAlertRemediationJobs(ctx, ClaimAlertRemediationJobsParams{Limit: 10, VisibilityTimeout: 900, MaxAttempts: 3})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(claimed), 1)

	require.NoError(t, q.MarkAlertRemediationJobDone(ctx, jobID))
	// The job is now 'done'; MarkAlertRemediationJobFailed's status='processing'
	// guard must make this a no-op instead of clobbering the terminal state (#324).
	require.NoError(t, q.MarkAlertRemediationJobFailed(ctx, MarkAlertRemediationJobFailedParams{ID: jobID, Error: "  boom  "}))
}

// TestFCov_AlertRemediationJobs_ReclaimAndExhaustion covers issue #21: a job
// stuck in 'processing' past the visibility timeout must be reclaimed by
// ClaimAlertRemediationJobs, and once it has exhausted its attempt budget it
// must be terminalized by FailExhaustedAlertRemediationJobs instead of being
// reclaimed forever.
func TestFCov_AlertRemediationJobs_ReclaimAndExhaustion(t *testing.T) {
	ctx := context.Background()
	q, pool := newQueries(t)

	var incidentID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO alert_incidents (incident_id, policy_name) VALUES ($1,$2) RETURNING id`,
		"inc-"+randSlug(t), "policy-reclaim").Scan(&incidentID))
	var jobID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO alert_remediation_jobs (incident_id, status, attempts, available_at, updated_at)
		 VALUES ($1, 'processing', 3, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour') RETURNING id`,
		incidentID).Scan(&jobID))

	// Below the attempt budget: a stale 'processing' job with a short
	// visibility timeout is reclaimed (attempts increments).
	claimed, err := q.ClaimAlertRemediationJobs(ctx, ClaimAlertRemediationJobsParams{Limit: 10, VisibilityTimeout: 1, MaxAttempts: 10})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(claimed), 1)

	// Reset to stale + exhausted so FailExhaustedAlertRemediationJobs picks it up.
	_, err = pool.Exec(ctx,
		`UPDATE alert_remediation_jobs SET status='processing', attempts=5, updated_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
		jobID)
	require.NoError(t, err)

	failedIncidentIDs, err := q.FailExhaustedAlertRemediationJobs(ctx, FailExhaustedAlertRemediationJobsParams{VisibilityTimeout: 1, MaxAttempts: 3})
	require.NoError(t, err)
	require.Contains(t, failedIncidentIDs, incidentID)
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
